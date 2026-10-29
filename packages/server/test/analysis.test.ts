import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { costAtMost } from '../src/analysis-core.ts';
import { ClaudeError, type Claude, type RunResult } from '../src/analysis-claude.ts';
import { openAnalysisStore } from '../src/analysis-store.ts';
import { buildApp } from '../src/app.ts';
import { openContentStore } from '../src/content-store.ts';
import { costUsd } from '../src/cost.ts';
import { openStore, type Store } from '../src/store/store.ts';
import { seedStore } from './seed-store.ts';

// Slice 7 (§15 2026-10-21): estimate, confirm, one request, within the cap, from the studio only. Claude is a stand-in
// that records its calls: these tests never reach the API and never spend.
const TOKEN = 'test-token-0123456789';
const T = Date.now() - 60 * 60_000;
const shop = { cwd: '/w/shop', name: 'shop', git_remote: 'github.com/o/shop' };
let n = 0;
const ev = (kind: string, data: object, extra: object = {}, ts = T + n * 1000) =>
  ({ v: 1, host: 'mbp', user_id: 'x', session_id: 's1', project: shop, id: `00000000-0000-4000-9c00-${String(++n).padStart(12, '0')}`, ts, kind, data, ...extra });
const events = [
  ev('session.start', { model: 'claude-opus-5-5', source: 'interactive', claude_version: 'v', plugin_version: 'p', content: 'full' }, {}, T),
  ev('turn.start', {}, { turn_id: 't1' }, T + 1),
  ev('turn.step', { model: 'claude-opus-5-5', usage: { input: 1000, output: 500, cache_read: 0, cache_creation: 0 }, stop_reason: 'tool_use', tool_use_ids: [] }, { turn_id: 't1' }, T + 2),
  ev('tool.call', { tool_use_id: 'tu-1', tool: 'Bash', input_size: 9, input: '{"command":"pnpm test"}' }, { turn_id: 't1' }, T + 3),
  ev('tool.result', { tool_use_id: 'tu-1', success: false, error_type: 'exit 1', duration_ms: 900, output_size: 40, files_touched: [], output: 'ingest.test.ts: expected 34, got 35' }, { turn_id: 't1' }, T + 4),
];
const report = { summary: 'One failure.', sections: [{ title: 'Repeated failures', body: 'pnpm test failed once.', evidence: ['tu-1'] }], changes: [{ title: 'Fix the count', why: 'expected 34, got 35', saving: '≈ 1 retry' }] };

type Calls = { count: string[]; run: string[] };
function standIn(calls: Calls, result: Partial<RunResult> = {}): Claude {
  return {
    count: async (model, _s, user) => (calls.count.push(user), 50_000),
    run: async (model) => (calls.run.push(model), { text: JSON.stringify(report), model, stop: 'end_turn', usage: { input: 50_000, output: 3_000, cache_read: 0, cache_creation: 0 }, ...result }),
  };
}

let dir: string;
let store: Store;
let calls: Calls;
let app: ReturnType<typeof buildApp>;
const week = { project: 'shop', from: T - 86_400_000, to: Date.now() + 60_000 };
const send = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method, url, payload, headers });
  return { status: res.statusCode, body: res.json() };
};
const fresh = (claude: Claude | null) => {
  app = buildApp({ store, token: TOKEN, content: content!, reports: openAnalysisStore(':memory:'), claude });
};
let content: ReturnType<typeof openContentStore> | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-analysis-'));
  store = openStore(join(dir, 'history.db'));
  content = openContentStore(':memory:');
  expect(seedStore(store, events, content)).toEqual({ accepted: events.length, duplicates: 0 });
});
beforeEach(() => { calls = { count: [], run: [] }; });
afterAll(async () => { await app?.close(); store?.close(); content?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('analysis, with no API key', () => {
  it('says so, and an estimate sends nothing', async () => {
    fresh(null);
    expect((await send('GET', '/api/analysis')).body).toMatchObject({ keySet: false, defaultModel: 'claude-opus-5-5', cap: 20, spent: 0 });
    const r = await send('POST', '/api/analysis/estimate', { ...week, model: 'claude-opus-5-5' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/No API key.*Nothing was sent/);
  });
});

describe('analysis, a project of many sessions', () => {
  // The digest is a bounded input however big the project is: the store cuts each list to what the digest shows (ten sessions, five error kinds a tool,
  // the newest 200 failures), and the counts it reports are of everything.
  const many = { cwd: '/w/many', name: 'many', git_remote: 'github.com/o/many' };
  const rows = Array.from({ length: 12 }, (_, i) => {
    const session = `m${String(i).padStart(2, '0')}`;
    const o = { session_id: session, project: many };
    const turn = { ...o, turn_id: `t-${session}` };
    return [
      ev('session.start', { model: 'claude-opus-5-5', source: 'interactive', claude_version: 'v', plugin_version: 'p' }, o, T + i * 1000),
      ev('turn.start', {}, turn, T + i * 1000 + 1),
      ev('turn.step', { model: 'claude-opus-5-5', usage: { input: 1000 * (i + 1), output: 0, cache_read: 0, cache_creation: 0 }, stop_reason: 'end_turn', tool_use_ids: [] }, turn, T + i * 1000 + 2),
      ...(i < 7 ? [
        ev('tool.call', { tool_use_id: `tm-${i}`, tool: 'Bash', input_size: 1 }, turn, T + i * 1000 + 3),
        ev('tool.result', { tool_use_id: `tm-${i}`, success: false, error_type: `kind-${i}`, duration_ms: 1, output_size: 1, files_touched: [] }, turn, T + i * 1000 + 4),
      ] : []),
    ];
  }).flat();
  const scope = { project: 'many', from: T - 86_400_000, to: Date.now() + 60_000 };

  it('counts every session, call and token, and shows the digest ten sessions and five error kinds a tool, the biggest and the first by name', async () => {
    expect(seedStore(store, rows)).toEqual({ accepted: rows.length, duplicates: 0 });
    fresh(standIn(calls));
    const reads = await send('GET', `/api/analysis/reads?project=many&from=${scope.from}&to=${scope.to}`);
    expect(reads.body).toMatchObject({ sessions: 12, toolCalls: 7, failed: 7, tokens: 1000 * (12 * 13) / 2, skillsRan: 0 });
    await send('POST', '/api/analysis/estimate', { ...scope, model: 'claude-opus-5-5' });
    const digest = calls.count[0]!;
    const largest = digest.split('## The largest sessions\n')[1]!.split('\n\n')[0]!.split('\n');
    expect(largest).toHaveLength(10); // twelve sessions, ten shown
    expect(largest[0]).toMatch(/^- m11 .*: 12\.0k tokens, 1 agents$/); // the biggest first
    expect(largest.at(-1)).toMatch(/^- m02 /);
    expect(digest).toContain('- Bash: 7 calls, 7 failed (kind-0; kind-1; kind-2; kind-3; kind-4)'); // seven kinds, five shown
    expect(digest.split('## Failed tool calls, newest first\n')[1]!.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(7); // each of the seven, newest first
  });
});

describe('analysis, with a key (a stand-in Claude)', () => {
  it('shows what a run would read before anything is counted', async () => {
    fresh(standIn(calls));
    const r = await send('GET', `/api/analysis/reads?project=shop&from=${week.from}&to=${week.to}`);
    expect(r.body).toMatchObject({ sessions: 1, toolCalls: 1, failed: 1, tokens: 1500, content: 'full' });
    expect(calls).toEqual({ count: [], run: [] });
  });

  it('estimates with the counter, then one confirmation makes exactly one request; the same estimate never runs twice', async () => {
    fresh(standIn(calls));
    const e = await send('POST', '/api/analysis/estimate', { ...week, model: 'claude-opus-5-5' });
    expect(e.body).toMatchObject({ inputTokens: 50_000, maxOutput: 16_000, allowed: true, spent: 0, cap: 20 });
    expect(e.body.costMax).toBeCloseTo(costAtMost('claude-opus-5-5', 50_000, 16_000), 9);
    expect(e.body.others.map((o: any) => o.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(calls.count).toHaveLength(1);
    expect(calls.count[0]).toContain('ingest.test.ts: expected 34, got 35'); // the failure's captured output is in the digest
    expect(calls.run).toEqual([]); // an estimate generates nothing

    const r = await send('POST', '/api/analysis/run', { estimate: e.body.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ project: 'shop', model: 'claude-opus-5-5', input_tokens: 50_000, output_tokens: 3_000, report });
    expect(r.body.cost).toBeCloseTo(costUsd('claude-opus-5-5', { input: 50_000, output: 3_000, cache_read: 0, cache_creation: 0 })!, 9);
    expect(calls.run).toEqual(['claude-opus-5-5']);
    expect((await send('POST', '/api/analysis/run', { estimate: e.body.id })).status).toBe(404);
    expect(calls.run).toHaveLength(1);

    const home = (await send('GET', '/api/analysis')).body;
    expect(home.spent).toBeCloseTo(r.body.cost, 9);
    expect(home.reports.map((x: any) => x.id)).toEqual([r.body.id]);
    expect((await send('GET', `/api/analysis/reports/${r.body.id}`)).body.report).toEqual(report);
    const ledger = (await send('GET', `/api/ledger?from=${week.from}&to=${week.to}&project=shop`)).body;
    expect(ledger.analysis.runs).toBe(1);
    expect(ledger.analysis.cost).toBeCloseTo(r.body.cost, 9);
  });

  it('past the monthly cap the run is refused before anything is sent', async () => {
    fresh(standIn(calls));
    expect((await send('PUT', '/api/analysis/cap', { usd: 0.5 })).body).toEqual({ cap: 0.5 });
    const e = await send('POST', '/api/analysis/estimate', { ...week, model: 'claude-opus-5-5' });
    expect(e.body).toMatchObject({ allowed: false }); // at most $0.52 against a $0.50 cap
    const r = await send('POST', '/api/analysis/run', { estimate: e.body.id });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/past the \$0\.50 cap\. Nothing was sent/);
    expect(calls.run).toEqual([]);
  });

  it('another site\'s page can start nothing and change no cap', async () => {
    fresh(standIn(calls));
    const evil = { origin: 'https://evil.example' };
    expect((await send('POST', '/api/analysis/estimate', { ...week, model: 'claude-opus-5-5' }, evil)).status).toBe(403);
    expect((await send('PUT', '/api/analysis/cap', { usd: 999 }, evil)).status).toBe(403);
    expect(calls).toEqual({ count: [], run: [] });
  });

  it('another site\'s page cannot run an estimate the studio made: nothing is sent (#21)', async () => {
    fresh(standIn(calls));
    const e = await send('POST', '/api/analysis/estimate', { ...week, model: 'claude-opus-5-5' });
    expect(e.body).toMatchObject({ allowed: true });
    const r = await send('POST', '/api/analysis/run', { estimate: e.body.id }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(calls.run).toEqual([]);
  });

  it('an API refusal (a real one, 2026-10-21: a key with no workspace) is a clear message, and nothing is recorded or spent', async () => {
    const workspace = 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header.';
    fresh({ count: async () => { throw new ClaudeError(400, workspace); }, run: async () => { throw new ClaudeError(400, workspace); } });
    const e = await send('POST', '/api/analysis/estimate', { ...week, model: 'claude-opus-5-5' });
    expect(e.status).toBe(502);
    expect(e.body.error).toBe(`The Claude API refused: ${workspace} Nothing was generated or billed.`);
    fresh(standIn(calls));
    const ok = await send('POST', '/api/analysis/estimate', { ...week, model: 'claude-opus-5-5' });
    // the same app, now with a run that the API refuses
    const app2 = buildApp({ store, token: TOKEN, content: content!, reports: openAnalysisStore(':memory:'),
      claude: { count: async () => 50_000, run: async () => { throw new ClaudeError(400, workspace); } } });
    const e2 = (await app2.inject({ method: 'POST', url: '/api/analysis/estimate', payload: { ...week, model: 'claude-opus-5-5' } })).json();
    const r = await app2.inject({ method: 'POST', url: '/api/analysis/run', payload: { estimate: e2.id } });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/^The Claude API refused: .*Nothing was generated or billed\.$/);
    expect((await app2.inject({ method: 'GET', url: '/api/analysis' })).json()).toMatchObject({ spent: 0, reports: [] });
    await app2.close();
    expect(ok.status).toBe(200);
  });

  it('a refusal is billed, so it is recorded and counts against the cap', async () => {
    fresh(standIn(calls, { stop: 'refusal', text: '', usage: { input: 50_000, output: 0, cache_read: 0, cache_creation: 0 } }));
    const e = await send('POST', '/api/analysis/estimate', { ...week, model: 'claude-sonnet-5-5' });
    const r = await send('POST', '/api/analysis/run', { estimate: e.body.id });
    expect(r.status).toBe(502);
    expect((await send('GET', '/api/analysis')).body.spent).toBeCloseTo(50_000 * 2e-6, 9);
  });
});
