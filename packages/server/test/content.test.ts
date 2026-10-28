import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openContentStore, type ContentStore } from '../src/content-store.ts';
import { all, openStore, type Store } from '../src/store/store.ts';
import { seedStore } from './seed-store.ts';

// Content capture on the server (§15, 2026-10-20): what the writer stores, and GET /api/history.
const TOKEN = 'test-token-0123456789';
const T = 1_792_500_000_000;
const base = { v: 1, host: 'mbp', user_id: 'x', session_id: 'sc-1', project: { cwd: '/r', name: 'agent-orb' } };
let n = 0;
const ev = (kind: string, data: object, extra: object = {}) =>
  ({ ...base, id: `00000000-0000-4000-a000-${String(++n).padStart(12, '0')}`, ts: T + n * 1000, kind, data, ...extra });
const usage = { input: 1, output: 2, cache_read: 3, cache_creation: 4 };
const events = [
  ev('session.start', { model: 'claude-opus-5-5', source: 'interactive', claude_version: 'v', plugin_version: '0.1.0', content: 'full' }),
  ev('prompt.submit', { length: 14, text: 'fix the writer' }, { prompt_id: 'p1' }),
  ev('turn.start', {}, { turn_id: 't1', prompt_id: 'p1' }),
  ev('turn.step', { model: 'claude-opus-5-5', usage, stop_reason: 'tool_use', tool_use_ids: [], thinking: 'Look at the writer first.' }, { turn_id: 't1' }),
  ev('tool.call', { tool_use_id: 'tc1', tool: 'Bash', input_size: 20, input: '{"command":"pnpm test"}' }, { turn_id: 't1' }),
  ev('tool.result', { tool_use_id: 'tc1', success: true, duration_ms: 900, output_size: 9, files_touched: [], output: '121 passed' }, { turn_id: 't1' }),
  ev('agent.spawn', { tool_use_id: 'ta', agent_type: 'Explore', description: 'Find', model: 'claude-haiku-5-5', prompt_length: 13, prompt: 'Find the docs' }, { agent_id: 'a1' }),
  ev('turn.start', {}, { agent_id: 'a1', turn_id: 't2' }),
  ev('tool.call', { tool_use_id: 'tc2', tool: 'Read', input_size: 20, input: '{"file_path":"/r/.env"}' }, { agent_id: 'a1', turn_id: 't2' }),
  ev('tool.result', { tool_use_id: 'tc2', success: true, duration_ms: 1, output_size: 30, files_touched: [], output_skipped: 'env-file' }, { agent_id: 'a1', turn_id: 't2' }),
  ev('turn.step', { model: 'claude-opus-5-5', usage, stop_reason: 'end_turn', tool_use_ids: [], answer: 'All green.' }, { turn_id: 't1' }),
];

let dir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
let text: ContentStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-content-'));
  store = openStore(join(dir, 'history.db'));
  text = openContentStore(':memory:');
  app = buildApp({ store, token: TOKEN, content: text });
  expect(seedStore(store, events, text)).toEqual({ accepted: events.length, duplicates: 0 });
});

afterAll(async () => {
  await app?.close();
  store?.close();
  text?.close();
  rmSync(dir, { recursive: true, force: true });
});

const rows = (sql: string) => all(store, sql).map((r) => ({ ...r }));
const history = async (q: Record<string, string>) => {
  const res = await app.inject({ method: 'GET', url: `/api/history?${new URLSearchParams(q)}` });
  return { status: res.statusCode, body: res.json() };
};

describe('text goes to the text store; the history store keeps the metadata (§15, 2026-10-20)', () => {
  it('no table of the history store has a column for captured text', () => {
    // api_requests.input/.output are token counts, not text, and tool_calls has input_size/output_size: each table is checked for the text columns it must not have.
    const columns = (table: string) => all(store, `SELECT name FROM pragma_table_info('${table}')`).map((c) => c.name as string);
    expect(columns('prompts')).not.toContain('text');
    expect(columns('agents')).not.toContain('prompt');
    expect(columns('api_requests')).not.toEqual(expect.arrayContaining(['answer']));
    expect(columns('api_requests')).not.toContain('thinking');
    expect(columns('tool_calls')).not.toEqual(expect.arrayContaining(['input']));
    expect(columns('tool_calls')).not.toContain('output');
    expect(rows('SELECT count(*) AS n FROM api_requests')).toEqual([{ n: 2 }]); // the check has something to look at
  });

  it('the store keeps what traversals and the drawer need: the content mode and why an output is missing', () => {
    expect(rows('SELECT content AS c FROM sessions')).toEqual([{ c: 'full' }]);
    expect(rows(`SELECT output_skipped AS sk FROM tool_calls WHERE tool_use_id = 'tc2'`)).toEqual([{ sk: 'env-file' }]);
  });

  it('the text store holds every captured field, under the graph ids', async () => {
    const steps = events.filter((e) => e.kind === 'turn.step').map((e) => e.id);
    const got = text.get([
      { node: 'prompt', id: 'p1' }, { node: 'agent', id: 'sc-1:a1' }, { node: 'tool', id: 'tc1' }, { node: 'tool', id: 'tc2' },
      { node: 'request', id: steps[0]! }, { node: 'request', id: steps[1]! },
    ]);
    expect(Object.fromEntries(got)).toEqual({
      'prompt:p1': { text: 'fix the writer' },
      'agent:sc-1:a1': { prompt: 'Find the docs' },
      'tool:tc1': { input: '{"command":"pnpm test"}', output: '121 passed' },
      'tool:tc2': { input: '{"file_path":"/r/.env"}' },
      [`request:${steps[0]}`]: { thinking: 'Look at the writer first.' },
      [`request:${steps[1]}`]: { answer: 'All green.' },
    });
  });
});

describe('GET /api/history', () => {
  it("main's timeline, in order: what you asked, thinking, the tool with input and output, the answer", async () => {
    const { status, body } = await history({ session: 'sc-1', agent: 'main' });
    expect(status).toBe(200);
    expect(body.content).toBe('full');
    expect(body.agent).toMatchObject({ id: 'sc-1:main', type: 'main', model: 'claude-opus-5-5' });
    expect(body.items.map((i: any) => [i.kind, i.text ?? i.thinking ?? i.answer ?? i.tool])).toEqual([
      ['prompt', 'fix the writer'], ['step', 'Look at the writer first.'], ['tool', 'Bash'], ['step', 'All green.'],
    ]);
    expect(body.items[2]).toMatchObject({ input: '{"command":"pnpm test"}', output: '121 passed', success: true, duration_ms: 900 });
  });

  it("a subagent's timeline starts with its task; the .env read says why it has no output", async () => {
    const { body } = await history({ session: 'sc-1', agent: 'a1' });
    expect(body.items.map((i: any) => i.kind)).toEqual(['task', 'tool']);
    expect(body.items[0].text).toBe('Find the docs');
    expect(body.items[1]).toMatchObject({ tool: 'Read', output_skipped: 'env-file' });
    expect(body.items[1]).not.toHaveProperty('output');
  });

  it('an agent with more than 100 items: the newest 100 of all kinds, oldest first, and no more than that read out of the store', async () => {
    // 60 prompts and 70 tool calls, interleaved by time: the drawer shows the last 100 of the 130
    const big = { session_id: 'sc-big' };
    const t0 = T + 1_000_000;
    const many = [
      ev('session.start', { model: 'claude-opus-5-5', source: 'interactive', claude_version: 'v', plugin_version: '0.1.0' }, { ...big }),
      ...Array.from({ length: 60 }, (_, i) => ({ ...ev('prompt.submit', { length: 3 }, { ...big, prompt_id: `bp-${i}` }), ts: t0 + i * 2000 })),
      ...Array.from({ length: 70 }, (_, i) => ({ ...ev('tool.call', { tool_use_id: `bt-${i}`, tool: 'Bash', input_size: 1 }, { ...big, turn_id: 'bt' }), ts: t0 + 1000 + i * 1700 })),
    ];
    expect(seedStore(store, many)).toEqual({ accepted: many.length, duplicates: 0 });
    const { body } = await history({ session: 'sc-big', agent: 'main' });
    const all130 = [...many.slice(1)].sort((a, b) => a.ts - b.ts);
    expect(body.items).toHaveLength(100);
    expect(body.items.map((i: any) => i.ts)).toEqual(all130.slice(-100).map((e) => e.ts)); // the newest 100, in order
    expect(body.items.map((i: any) => i.kind)).toEqual(all130.slice(-100).map((e) => (e.kind === 'prompt.submit' ? 'prompt' : 'tool')));
  });

  it('404 for an unknown agent; 400 without session and agent', async () => {
    expect((await history({ session: 'sc-1', agent: 'nope' })).status).toBe(404);
    expect((await history({ session: 'sc-1' })).status).toBe(400);
  });
});
