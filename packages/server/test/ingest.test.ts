import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { openContentStore, type ContentStore } from '../src/content-store.ts';
import { all, openStore, type Store } from '../src/store/store.ts';

// POST /ingest (#81, slice 1): validates, then writes the SQLite history store and the text store. What the writer stores, event kind by event kind,
// is store-writer.test.ts; this is the route: the token, the batch, the server's user, the text's own store, and the plugin's stretch.
// A temp file each, no container: /healthz asks the history store too.
const TOKEN = 'test-token-0123456789';
const events = readFileSync(new URL('./fixtures/session.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

let dir: string;
let store: Store;
let content: ContentStore;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-ingest-'));
  store = openStore(join(dir, 'history.db'));
  content = openContentStore(join(dir, 'content.db'));
  app = buildApp({ store, content, token: TOKEN });
});
afterEach(async () => {
  await app.close();
  store.close();
  content.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown, authorization: string | null = `Bearer ${TOKEN}`) =>
  app.inject({ method: 'POST', url: '/ingest', headers: authorization === null ? {} : { authorization }, payload: body as object });

const count = (table: string) => all(store, `SELECT count(*) AS n FROM ${table}`)[0]!.n;
const rows = (sql: string) => all(store, sql).map((r) => ({ ...r }));

describe('POST /ingest auth and validation', () => {
  it.each([
    ['no header', null],
    ['wrong token', 'Bearer nope'],
    ['wrong scheme', `Basic ${TOKEN}`],
    ['double space', `Bearer  ${TOKEN}`],
    ['trailing space', `Bearer ${TOKEN} `],
    ['token prefix', `Bearer ${TOKEN.slice(0, -1)}`],
  ])('401 on %s, nothing written', async (_name, authorization) => {
    const res = await post({ events }, authorization);
    expect(res.statusCode).toBe(401);
    expect(count('ingested')).toBe(0);
  });

  // #114: each event is checked on its own, so one bad event no longer costs the batch it came in.
  it('a batch with one invalid event: the valid one is written, the invalid one refused, 200', async () => {
    const { session_id: _, ...broken } = events[1];
    const res = await post({ events: [events[0], broken] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 1, duplicates: 0, rejected: 1 });
    expect(rows('SELECT id FROM ingested')).toEqual([{ id: events[0].id }]);
  });

  it('every event invalid: 200, all refused, nothing written', async () => {
    const res = await post({ events: [{ kind: 'session.start' }, { kind: 'no.such.kind', id: 'x' }, 42] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 0, duplicates: 0, rejected: 3 });
    expect(count('ingested')).toBe(0);
  });

  it.each([
    ['no events list', {}],
    ['events not a list', { events: 'x' }],
    ['more than 500 events', { events: Array.from({ length: 501 }, () => events[1]) }],
  ])('400 on %s, nothing written', async (_name, body) => {
    expect((await post(body)).statusCode).toBe(400);
    expect(count('ingested')).toBe(0);
  });

  it('GET /healthz is 200 while the history store answers a query, and 503 once it cannot', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    const gone = openStore(join(dir, 'gone.db')); // opened and asked once, then closed under the server
    const failing = buildApp({ store: gone, token: TOKEN });
    expect((await failing.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    gone.close();
    const down = await failing.inject({ method: 'GET', url: '/healthz' });
    expect([down.statusCode, down.json()]).toEqual([503, { status: 'history store unavailable' }]);
    await failing.close();
  });
});

describe('POST /ingest writes the history store', () => {
  it('a recorded events file → its rows, and the server, not the event, says whose', async () => {
    const res = await post({ events });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 29, duplicates: 0, rejected: 0 });
    expect([count('sessions'), count('agents'), count('prompts'), count('turns'), count('api_requests'), count('tool_calls'), count('files_touched'), count('ingested')]).toEqual([1, 2, 2, 2, 3, 5, 3, 29]);
    // The event said 'alfredo'.
    expect(rows('SELECT id, user_id, started_at, ended_at, model FROM sessions')).toEqual([
      { id: 'sess-1', user_id: 'local', started_at: 1_792_400_000_000, ended_at: 1_792_400_050_000, model: 'claude-opus-5-5' },
    ]);
  });

  it('the same batch twice → all duplicates, the store unchanged', async () => {
    expect((await post({ events })).json()).toEqual({ accepted: 29, duplicates: 0, rejected: 0 });
    const before = rows('SELECT * FROM tool_calls ORDER BY tool_use_id');
    expect((await post({ events })).json()).toEqual({ accepted: 0, duplicates: 29, rejected: 0 });
    expect(rows('SELECT * FROM tool_calls ORDER BY tool_use_id')).toEqual(before);
    expect(count('ingested')).toBe(29);
  });

  it('a repeated event inside one batch counts once', async () => {
    expect((await post({ events: [events[0], events[0], events[1]] })).json()).toEqual({ accepted: 2, duplicates: 1, rejected: 0 });
  });

  it('the plugin\'s events are the plugin\'s stretch: the first and last prompt, request or call it sent', async () => {
    await post({ events });
    // the first prompt at +1,000 ms and the last at +30,000 ms; the start, the compact and the end are no part of it
    expect(rows('SELECT plugin_first, plugin_last, recorded FROM sessions')).toEqual([{ plugin_first: 1_792_400_001_000, plugin_last: 1_792_400_030_000, recorded: 1 }]);
  });

  it('the text goes to the text store, and the history store keeps none of it', async () => {
    const [start] = events;
    const withText = [
      { ...start, id: '00000000-0000-4000-8000-0000000000f1', kind: 'prompt.submit', ts: start.ts + 1, prompt_id: 'p-text', data: { length: 17, text: 'a secret question' } },
      { ...start, id: '00000000-0000-4000-8000-0000000000f2', kind: 'tool.result', ts: start.ts + 2, turn_id: 't-text', data: { tool_use_id: 'tu-text', success: true, duration_ms: 1, output_size: 9, files_touched: [], output: 'the output' } },
    ];
    expect((await post({ events: withText })).json()).toEqual({ accepted: 2, duplicates: 0, rejected: 0 });
    expect([...content.get([{ node: 'prompt', id: 'p-text' }, { node: 'tool', id: 'tu-text' }]).values()]).toEqual([{ text: 'a secret question' }, { output: 'the output' }]);
    expect(JSON.stringify([rows('SELECT * FROM prompts'), rows('SELECT * FROM tool_calls')])).not.toMatch(/secret|the output/);
  });
});

describe('POST /ingest logs why it refused a batch (#111)', () => {
  // The plugin drops a refused batch, so the server's log is the only place its reason can be read. The log at info, the level main.ts runs it at.
  let lines: Record<string, any>[];
  let logged: ReturnType<typeof buildApp>;
  beforeEach(() => {
    lines = [];
    const stream = new Writable({ write: (chunk, _enc, done) => (lines.push(JSON.parse(String(chunk))), done()) });
    logged = buildApp({ store, content, token: TOKEN, logger: { level: 'info', stream } });
  });
  afterEach(() => logged.close());

  const send = (body: unknown) => logged.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: body as object });
  const refusals = () => lines.filter((l) => l.msg === 'refused an invalid batch' || l.msg === 'refused invalid events');

  it('an invalid event writes one warn line: the batch\'s size, how many were refused, and which field failed (#114)', async () => {
    const { session_id: _, ...broken } = events[1];
    expect((await send({ events: [events[0], broken] })).statusCode).toBe(200);
    expect(refusals().map(({ level, msg, events, rejected, kinds, issues }) => ({ level, msg, events, rejected, kinds, issues }))).toEqual([
      { level: 40, msg: 'refused invalid events', events: 2, rejected: 1, kinds: [events[1].kind], issues: [{ code: 'invalid_type', path: ['events', 1, 'session_id'], message: 'Invalid input: expected string, received undefined' }] },
    ]);
  });

  // A plugin newer than the server, the likeliest cause: the line says which kind, and the same failure in 200 events is one issue, not 20.
  it('names the kinds it refused, and logs a failure repeated across events once', async () => {
    const renamed = [0, 1, 2].map((i) => ({ ...events[0], id: `00000000-0000-4000-8000-00000000010${i}`, kind: 'session.rename', data: {} }));
    expect((await send({ events: renamed })).json()).toEqual({ accepted: 0, duplicates: 0, rejected: 3 });
    expect(refusals().map(({ rejected, kinds, issues }) => ({ rejected, kinds, issues: issues.map(({ code, path }: { code: string; path: unknown[] }) => ({ code, path })) }))).toEqual([
      { rejected: 3, kinds: ['session.rename'], issues: [{ code: 'invalid_union', path: ['events', 0, 'kind'] }] },
    ]);
  });

  it('a body that is not a list of events writes the batch\'s refusal line', async () => {
    expect((await send({ events: 'x' })).statusCode).toBe(400);
    expect(refusals().map(({ level, msg, issues }) => ({ level, msg, issues }))).toEqual([
      { level: 40, msg: 'refused an invalid batch', issues: [{ code: 'invalid_type', path: ['events'], message: 'Invalid input: expected array, received string' }] },
    ]);
  });

  it('carries none of the refused events\' text', async () => {
    const [start] = events;
    const broken = { ...start, id: '00000000-0000-4000-8000-0000000000f3', kind: 'prompt.submit', ts: start.ts + 1, prompt_id: 'p-secret', data: { length: 'x', text: 'a secret question' } };
    expect((await send({ events: [start, broken] })).statusCode).toBe(200);
    expect(refusals()).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain('a secret question');
  });

  it('a valid batch writes no such line', async () => {
    expect((await send({ events })).statusCode).toBe(200);
    expect(refusals()).toEqual([]);
  });
});

describe('a refused event reaches no store and no stream (#114)', () => {
  // Refused for its data, not for a missing session, so any place it reached would take it.
  const refused = { ...events[0], id: '00000000-0000-4000-8000-0000000000f4', session_id: 'sess-refused', kind: 'prompt.submit', ts: events[0].ts + 1, prompt_id: 'p-refused', data: { length: 'x', text: 'a refused question' } };

  it('its text stays out of the text store, and its session out of the history', async () => {
    expect((await post({ events: [events[0], refused] })).json()).toEqual({ accepted: 1, duplicates: 0, rejected: 1 });
    expect([...content.get([{ node: 'prompt', id: 'p-refused' }]).values()]).toEqual([]);
    expect(rows('SELECT id FROM sessions')).toEqual([{ id: events[0].session_id }]);
  });

  it('its session never shows in the live stream', async () => {
    await post({ events: [events[0], refused] });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const reader = (await fetch(`${address}/stream`)).body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    while (!text.includes('\n\n')) text += (await reader.read()).value ?? '';
    await reader.cancel();
    const [head, data] = text.slice(0, text.indexOf('\n\n')).split('\n');
    expect(head).toBe('event: snapshot');
    expect(JSON.parse(data!.slice(6)).sessions.map((s: { id: string }) => s.id)).toEqual([events[0].session_id]);
  });
});

describe('GET /stream', () => {
  it('criterion A: an ingested spawn reaches an open stream within 2 s, nested under main', async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const res = await fetch(`${address}/stream`);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const next = async (event: string) => {
      for (;;) {
        const at = buffer.indexOf('\n\n');
        if (at >= 0) {
          const [head, data] = buffer.slice(0, at).split('\n');
          buffer = buffer.slice(at + 2);
          if (head === `event: ${event}`) return JSON.parse(data!.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream closed');
        buffer += value;
      }
    };
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    await next('snapshot');

    const t0 = performance.now();
    const spawn = events.find((e) => e.kind === 'agent.spawn');
    await post({ events: [events[0], spawn] });
    let session;
    do session = await next('session'); while (!session.agents.some((a: { id: string }) => a.id === spawn.agent_id));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(session.agents.map((a: { id: string; depth: number }) => [a.id, a.depth])).toEqual([['main', 0], ['agent-x', 1]]);
    await reader.cancel();
  });
});
