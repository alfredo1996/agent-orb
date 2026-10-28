import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { costUsd } from '../src/cost.ts';
import { openStore, type Store } from '../src/store/store.ts';
import { seedStore } from './seed-store.ts';

// GET /api/ledger (PROJECT.md §8.2), against the recorded fixture plus a second session on another project, a day later.
const TOKEN = 'test-token-0123456789';
const fixture = readFileSync(new URL('./fixtures/session.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const T = 1_792_400_000_000; // 2026-10-19 08:53 UTC
const DAY = 86_400_000;
const g = { v: 1, host: 'mbp', user_id: 'x', session_id: 'sess-2', project: { cwd: '/g', name: 'mobile-app', git_remote: 'github.com/alfredo1996/mobile-app' } };
let n = 0;
const ev = (kind: string, data: object, extra: object = {}, ts = T + DAY + n * 1000) =>
  ({ ...g, id: `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`, ts, kind, data, ...extra });
const sonnet = { input: 100, output: 900, cache_read: 9000, cache_creation: 0 };
const second = [
  ev('session.start', { model: 'claude-sonnet-5-5', source: 'interactive', claude_version: '2.1.299', plugin_version: '0.1.0' }),
  ev('turn.start', {}, { turn_id: 'g-t1' }),
  ev('turn.step', { model: 'claude-sonnet-5-5', usage: sonnet, stop_reason: 'tool_use', tool_use_ids: [] }, { turn_id: 'g-t1' }),
  ev('tool.call', { tool_use_id: 'g-bash', tool: 'Bash', input_size: 20 }, { turn_id: 'g-t1' }),
  ev('tool.waiting', { tool_use_id: 'g-bash', tool: 'Bash' }),
  ev('tool.result', { tool_use_id: 'g-bash', success: true, duration_ms: 30_000, output_size: 10, files_touched: [] }, { turn_id: 'g-t1' }),
];

let dir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-ledger-'));
  store = openStore(join(dir, 'history.db'));
  app = buildApp({ store, token: TOKEN });
  expect(seedStore(store, [...fixture, ...second])).toEqual({ accepted: 35, duplicates: 0 });
});

afterAll(async () => {
  await app?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (q: Record<string, string | number>) => {
  const res = await app.inject({ method: 'GET', url: `/api/ledger?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}` });
  return { status: res.statusCode, body: res.json() };
};
const week = { from: T - 3 * DAY, to: T + 4 * DAY, unit: 'day', tz: 'Europe/Rome' };

describe('GET /api/ledger', () => {
  it('totals: tokens first, cost (partial when a model is unpriced), cache share, sessions, agents, tool calls, waits', async () => {
    const { status, body } = await get(week);
    expect(status).toBe(200);
    const fixtureCost = costUsd('claude-opus-5-5', { input: 1000, output: 2000, cache_read: 10_000, cache_creation: 4000 })! + 0.006;
    expect(body.totals).toMatchObject({ tokens: 118_002 + 10_000, sessions: 2, agents: 3, costPartial: true, toolCalls: 6, failedCalls: 1, waits: 1, waitMs: 30_000 });
    expect(body.totals.cost).toBeCloseTo(fixtureCost + costUsd('claude-sonnet-5-5', sonnet)!, 9);
    // cache share = cache_read / (input + cache_read + cache_creation), over every request
    const reads = 10_000 + 50_000 + 0 + 9000;
    const inputSide = 1000 + 10_000 + 4000 + 50_000 + 50_000 + 1 + 100 + 9000;
    expect(body.totals.cacheShare).toBeCloseTo(reads / inputSide, 9);
  });

  it('a series per day in the given time zone, split by model', async () => {
    const { body } = await get(week);
    expect(body.series).toEqual([
      { bucket: '2026-10-19', tokens: 118_002, cost: expect.any(Number), byModel: { 'claude-opus-5-5': 17_000, 'claude-haiku-5-5': 101_000, 'claude-unknown-9': 2 } },
      { bucket: '2026-10-20', tokens: 10_000, cost: expect.any(Number), byModel: { 'claude-sonnet-5-5': 10_000 } },
    ]);
    expect((await get({ ...week, unit: 'week' })).body.series.map((b: { bucket: string }) => b.bucket)).toEqual(['2026-10-19']); // ISO weeks start Monday
  });

  it('breakdowns by project, model and role, biggest first', async () => {
    const { body } = await get(week);
    expect(body.byProject.map((p: any) => [p.name, p.tokens, p.sessions, p.agents])).toEqual([['agent-orb', 118_002, 1, 2], ['mobile-app', 10_000, 1, 1]]);
    expect(body.byModel.map((m: any) => [m.model, m.tokens, m.agents])).toEqual([
      ['claude-haiku-5-5', 101_000, 1], ['claude-opus-5-5', 17_000, 1], ['claude-sonnet-5-5', 10_000, 1], ['claude-unknown-9', 2, 1],
    ]);
    expect(body.byModel.find((m: any) => m.model === 'claude-unknown-9').cost).toBeNull();
    expect(body.byRole.map((r: any) => [r.role, r.tokens, r.agents, r.types])).toEqual([
      ['researcher', 101_000, 1, ['Explore']], ['orchestrator', 27_002, 2, ['main']],
    ]);
  });

  it('efficiency per project: tokens per file changed, failed calls, cache share, waiting, requests', async () => {
    const { body } = await get(week);
    expect(body.efficiency.map((e: any) => [e.project, e.filesChanged, e.toolCalls, e.failedCalls, e.waitMs, e.requests])).toEqual([
      ['agent-orb', 2, 5, 1, 0, 3],
      ['mobile-app', 0, 1, 0, 30_000, 1],
    ]);
  });

  it('filters by project, and compares with the previous period of the same length', async () => {
    const { body } = await get({ ...week, project: 'mobile-app' });
    expect(body.totals.tokens).toBe(10_000);
    expect(body.byProject.map((p: any) => p.name)).toEqual(['mobile-app']);
    const later = await get({ from: T + 4 * DAY, to: T + 11 * DAY, unit: 'day', tz: 'Europe/Rome' });
    expect(later.body.totals.tokens).toBe(0);
    expect(later.body.totals.previousTokens).toBe(128_002);
  });

  it('400 on a bad range, unit or time zone', async () => {
    expect((await get({ ...week, to: week.from })).status).toBe(400);
    expect((await get({ ...week, unit: 'year' })).status).toBe(400);
    expect((await get({ ...week, tz: 'Mars/Olympus' })).status).toBe(400);
  });
});

// v0.2 slice 2: the agents the plugin flagged as on a pricier model, and what their requests cost, in the window. Its own days, ten days on:
// the earlier tests' windows never reach them.
describe('GET /api/ledger, totals.pricier (the model check)', () => {
  const D = T + 10 * DAY;
  const p = { session_id: 'sess-p' };
  const opus = { input: 1000, output: 2000, cache_read: 10_000, cache_creation: 4000 }; // 17,000 tokens, $0.066 on Opus 5.5
  const check = { model_check: { allowed: 'sonnet', source: 'file' } };
  const spawn = (agent: string, ts: number, data: object = {}) =>
    ev('agent.spawn', { tool_use_id: `toolu_${agent}`, agent_type: 'implementer', model: 'claude-opus-5-5', prompt_length: 1, ...data }, { ...p, agent_id: agent }, ts);
  const step = (agent: string | undefined, ts: number, usage = opus) =>
    ev('turn.step', { model: 'claude-opus-5-5', usage, stop_reason: 'end_turn', tool_use_ids: [] }, { ...p, turn_id: `${agent ?? 'main'}-t`, ...(agent && { agent_id: agent }) }, ts);
  const turn = (agent: string | undefined, ts: number) => ev('turn.start', {}, { ...p, turn_id: `${agent ?? 'main'}-t`, ...(agent && { agent_id: agent }) }, ts);
  const pricier = [
    ev('session.start', { model: 'claude-opus-5-5', source: 'interactive', claude_version: '2.1.308', plugin_version: '0.2.0' }, p, D),
    turn(undefined, D + 1), step(undefined, D + 2), // main: Opus, never flagged
    spawn('p1', D + 10, check), turn('p1', D + 11), step('p1', D + 12), step('p1', D + 13), // flagged, two requests: $0.132
    spawn('p2', D + 20, { model_check: { allowed: 'sonnet', source: 'ceiling' } }), turn('p2', D + 21), step('p2', D + 22, { input: 500, output: 0, cache_read: 0, cache_creation: 0 }), // flagged, $0.002
    spawn('ok', D + 30), turn('ok', D + 31), step('ok', D + 32), // within its limit
    spawn('p3', D + 40, check), turn('p3', D + 41), step('p3', D + 42 + 2 * DAY), // flagged, but its only request is after the window
  ];
  const day = { from: D - DAY, to: D + DAY, unit: 'day', tz: 'UTC' };

  beforeAll(() => {
    expect(seedStore(store, pricier)).toEqual({ accepted: pricier.length, duplicates: 0 });
  });

  it('counts the flagged agents that made requests in the window, and the cost of those requests', async () => {
    const { body } = await get(day);
    expect(body.totals.pricier.agents).toBe(2); // p1 and p2: not main, not ok, not p3 (no request in the window)
    expect(body.totals.pricier.cost).toBeCloseTo(0.134, 12); // 2 × 0.066 + 0.002
    expect(body.totals.cost).toBeCloseTo(0.066 * 4 + 0.002, 12); // main, p1 twice, ok, plus p2
  });

  it('the window decides: p3 counts in the days it made its request, and nothing counts in a window with no flagged request', async () => {
    const later = await get({ ...day, from: D + DAY, to: D + 4 * DAY });
    expect(later.body.totals.pricier.agents).toBe(1);
    expect(later.body.totals.pricier.cost).toBeCloseTo(0.066, 12);
    const none = await get(week);
    expect(none.body.totals.pricier).toEqual({ agents: 0, cost: 0 });
  });

  it('follows the project filter', async () => {
    expect((await get({ ...day, project: 'mobile-app' })).body.totals.pricier.agents).toBe(2);
    expect((await get({ ...day, project: 'agent-orb' })).body.totals.pricier).toEqual({ agents: 0, cost: 0 });
  });
});

// #102: a permission wait counts at most 10 minutes, as Worth counts it, and the Totals say how many dialogs stayed open over an hour. Its own days, twenty on.
describe('GET /api/ledger, a permission wait (the cap)', () => {
  const E = T + 20 * DAY;
  const s = { session_id: 'sess-w' };
  const MIN = 60_000;
  // One tool call per wait: the Bash call, the dialog it waited at, and its result with the time it ran. `ran` undefined: no result came (the dialog is still open).
  const call = (id: string, at: number, ran?: number, waited = true) => [
    ev('tool.call', { tool_use_id: id, tool: 'Bash', input_size: 10 }, { ...s, turn_id: 'w-t' }, E + at),
    ...(waited ? [ev('tool.waiting', { tool_use_id: id, tool: 'Bash' }, s, E + at + 1)] : []),
    ...(ran === undefined ? [] : [ev('tool.result', { tool_use_id: id, success: true, duration_ms: ran, output_size: 1, files_touched: [] }, { ...s, turn_id: 'w-t' }, E + at + 2)]),
  ];
  const events = [
    ev('session.start', { model: 'claude-sonnet-5-5', source: 'interactive', claude_version: '2.1.308', plugin_version: '0.2.0' }, s, E),
    ev('turn.start', {}, { ...s, turn_id: 'w-t' }, E + 1),
    ev('turn.step', { model: 'claude-sonnet-5-5', usage: sonnet, stop_reason: 'tool_use', tool_use_ids: [] }, { ...s, turn_id: 'w-t' }, E + 2), // a request, so the project has an efficiency row
    ...call('over', 10, 3 * 60 * MIN), // left open for 3 h: counts 10 minutes
    ...call('hour', 20, 60 * MIN), // exactly an hour is not over it
    ...call('short', 30, 4 * MIN), // counts as it ran
    ...call('edge', 40, 10 * MIN), // exactly the cap
    ...call('open', 50), // still waiting: no run time yet
    ...call('build', 60, 2 * 60 * MIN, false), // a long build nobody waited at: not a wait
  ];
  const day = { from: E - DAY, to: E + DAY, unit: 'day', tz: 'UTC' };

  beforeAll(() => {
    expect(seedStore(store, events)).toEqual({ accepted: events.length, duplicates: 0 });
  });

  it('each wait counts at most 10 minutes, and the Totals say how many were over an hour', async () => {
    const { totals } = (await get(day)).body;
    expect(totals).toMatchObject({ toolCalls: 6, waits: 5, waitMs: (10 + 10 + 4 + 10) * MIN, waitsOverHour: 1 });
  });

  it('and counts them in full beside, uncapped: the 3 h dialog is 3 h here and 10 minutes in the figure', async () => {
    const { totals } = (await get(day)).body;
    expect(totals).toMatchObject({ waitMs: (10 + 10 + 4 + 10) * MIN, waitMsFull: (180 + 60 + 4 + 10) * MIN }); // the one still open has no run time yet; the build was no wait
    expect((await get({ ...day, project: 'mobile-app' })).body.totals.waitMsFull).toBe(254 * MIN);
    expect((await get({ ...day, project: 'agent-orb' })).body.totals.waitMsFull).toBe(0);
  });

  it('the efficiency table counts them the same way, and the project filter keeps both', async () => {
    const { body } = await get({ ...day, project: 'mobile-app' });
    expect(body.efficiency.map((e: any) => [e.project, e.waitMs])).toEqual([['mobile-app', 34 * MIN]]);
    expect(body.totals).toMatchObject({ waitMs: 34 * MIN, waitsOverHour: 1 });
    expect((await get({ ...day, project: 'agent-orb' })).body.totals).toMatchObject({ waits: 0, waitMs: 0, waitsOverHour: 0 });
  });
});

// #102, the check: a forked session replays another's tool calls and requests (the same tool_use_ids, the same request ids), and a total counts each once. The
// SQLite store keys a call by its tool_use_id and a request by its id (#87), so the copy adds nothing. Its own days, thirty on.
describe('GET /api/ledger, a forked session\'s replayed calls and requests', () => {
  const F = T + 30 * DAY;
  const usage = (n: number) => ({ input: n, output: 0, cache_read: 0, cache_creation: 0 });
  const at = (session: string) => ({ session_id: session, turn_id: `${session}-t` });
  const start = (session: string, ts: number) => ev('session.start', { model: 'claude-sonnet-5-5', source: 'interactive', claude_version: '2.1.308', plugin_version: '0.2.0' }, { session_id: session }, ts);
  const step = (session: string, n: number, ts: number) => ev('turn.step', { model: 'claude-sonnet-5-5', usage: usage(n), stop_reason: 'tool_use', tool_use_ids: [] }, at(session), ts);
  // A call that waited at a dialog and failed: it shows in four of the Totals' figures.
  const call = (session: string, id: string, ts: number) => [
    ev('tool.call', { tool_use_id: id, tool: 'Bash', input_size: 10 }, at(session), ts),
    ev('tool.waiting', { tool_use_id: id, tool: 'Bash' }, { session_id: session }, ts + 1),
    ev('tool.result', { tool_use_id: id, success: false, error_type: 'error', duration_ms: 120_000, output_size: 1, files_touched: [] }, at(session), ts + 2),
  ];
  const original = [start('sess-orig', F), ev('turn.start', {}, at('sess-orig'), F + 1), step('sess-orig', 1000, F + 2), ...call('sess-orig', 'toolu_shared', F + 3)];
  // The fork's copy: the same request (the same event id, as the import derives it from the log) and the same call under new events, then its own work.
  const fork = [
    start('sess-fork', F + 100), ev('turn.start', {}, at('sess-fork'), F + 101),
    { ...step('sess-fork', 1000, F + 2), id: original[2]!.id },
    ...call('sess-fork', 'toolu_shared', F + 3),
    step('sess-fork', 20, F + 110), ...call('sess-fork', 'toolu_own', F + 111),
  ];
  const day = { from: F - DAY, to: F + DAY, unit: 'day', tz: 'UTC' };

  beforeAll(() => {
    seedStore(store, original);
    seedStore(store, fork);
  });

  it('Totals count each call and each request once, though two sessions show them', async () => {
    const { totals } = (await get(day)).body;
    expect(totals).toMatchObject({ sessions: 2, tokens: 1000 + 20, toolCalls: 2, failedCalls: 2, waits: 2, waitMs: 240_000 });
  });

  it('the call and the request stay with the session that wrote them first', async () => {
    const { body } = await get(day);
    expect(body.byProject.map((p: any) => [p.name, p.tokens, p.sessions])).toEqual([['mobile-app', 1020, 2]]);
    expect(body.series.map((b: any) => b.tokens)).toEqual([1020]);
  });
});

// #102: the cost is compared with the period before, priced the way the period's own is. Its own days, fifty on.
describe('GET /api/ledger, totals.previousCost (the period before)', () => {
  const C = T + 50 * DAY;
  const s = { session_id: 'sess-c' };
  const step = (model: string, usage: object, ts: number) => ev('turn.step', { model, usage, stop_reason: 'end_turn', tool_use_ids: [] }, { ...s, turn_id: 'c-t' }, ts);
  const a = { input: 1000, output: 2000, cache_read: 10_000, cache_creation: 4000 };
  const b = { input: 500, output: 100, cache_read: 0, cache_creation: 0 };
  const c = { input: 50, output: 50, cache_read: 0, cache_creation: 0 };
  const events = [
    ev('session.start', { model: 'claude-sonnet-5-5', source: 'interactive', claude_version: '2.1.308', plugin_version: '0.2.0' }, s, C - DAY),
    ev('turn.start', {}, { ...s, turn_id: 'c-t' }, C - DAY + 1),
    step('claude-opus-5-5', a, C - DAY / 2), step('claude-sonnet-5-5', b, C - DAY / 4), // the day before [C, C + DAY): two priced requests
    step('claude-sonnet-5-5', c, C + 10), // the day itself
    step('claude-unknown-9', c, C + DAY + 10), step('claude-sonnet-5-5', b, C + DAY + 20), // a day with one request nobody has a price for
  ];

  beforeAll(() => {
    expect(seedStore(store, events)).toEqual({ accepted: events.length, duplicates: 0 });
  });

  it('is what the same length of time before cost, priced as the cost is', async () => {
    const { totals } = (await get({ from: C, to: C + DAY, unit: 'day', tz: 'UTC' })).body;
    expect(totals.previousCost).toBeCloseTo(costUsd('claude-opus-5-5', a)! + costUsd('claude-sonnet-5-5', b)!, 12);
    expect(totals.cost).toBeCloseTo(costUsd('claude-sonnet-5-5', c)!, 12);
    expect(totals.previousTokens).toBe(17_000 + 600); // the tokens are the same window
  });

  it('follows the project filter', async () => {
    const day = { from: C, to: C + DAY, unit: 'day', tz: 'UTC' };
    expect((await get({ ...day, project: 'mobile-app' })).body.totals.previousCost).toBeGreaterThan(0);
    expect((await get({ ...day, project: 'agent-orb' })).body.totals.previousCost).toBe(0);
  });

  it('is 0 when nothing came before, and null when part of it has no price: a floor is no base for a percentage', async () => {
    expect((await get({ from: C - 2 * DAY, to: C - DAY, unit: 'day', tz: 'UTC' })).body.totals.previousCost).toBe(0);
    const partial = (await get({ from: C + 2 * DAY, to: C + 3 * DAY, unit: 'day', tz: 'UTC' })).body.totals;
    expect(partial.previousCost).toBeNull();
    expect(partial.previousTokens).toBe(100 + 600); // the tokens still count
  });
});
