import { beforeEach, describe, expect, it } from 'vitest';
import type { Event } from '@agent-orb/shared';
import { buildApp } from '../src/app.ts';
import { STAGES, stageOf } from '../src/api/board.ts';
import { openStore } from '../src/store/store.ts';

// v0.5 slice 2 (#106, Follow; the plan is #64): the page of one issue. GET /api/issue answers where it stands and its story, one line per agent run, worked out on read from rows already stored (and
// from finding_rounds, which keeps every findings report, not the latest only). The tests send the plugin's events to /ingest and read the route, so the writer, the reach and the route are held together.
const TOKEN = 'test-token-0123456789';
const MIN = 60_000;
const T0 = Date.parse('2026-11-03T09:00:00Z');
const NOW = Date.parse('2026-11-05T12:00:00Z');
const SONNET = 'claude-sonnet-5-5'; // $10 per million output tokens: 100,000 output tokens are $1
const oid = (short: string) => short.padEnd(40, '1');
const HEAD = oid('a1b2c3d');
const M = 'v2.3 Offline';

type Project = { cwd: string; name: string; git_remote?: string; git_branch?: string };
const MOBILE: Project = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
let n = 0;
const ev = (session: string, ts: number, kind: string, data: object, extra: object = {}, project: Project = MOBILE): Event =>
  ({ v: 1, id: `00000000-0000-4000-b106-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'local', session_id: session, project, kind, data, ...extra }) as Event;
const start = (session: string, branch: string | undefined, ts = T0, source = 'interactive') =>
  ev(session, ts, 'session.start', { model: SONNET, source, claude_version: '2.1.316', plugin_version: '0.4.6' }, {}, { ...MOBILE, ...(branch ? { git_branch: branch } : {}) });
/** A subagent spawned by the session's main agent at `ts`. */
const spawn = (session: string, ts: number, agent: string, type = 'implementer') =>
  ev(session, ts, 'agent.spawn', { tool_use_id: `sp-${session}-${agent}`, agent_type: type, model: SONNET, prompt_length: 10 }, { agent_id: agent });
/** A tool call of `agent` (the main agent when none) at `ts`, and its result: a file written, or a test run (`cls: 'test'`) that passed or failed. */
const call = (session: string, ts: number, o: { agent?: string; write?: string; test?: 'pass' | 'fail' }): Event[] => {
  const turn = { turn_id: `t-${session}-${o.agent ?? 'main'}`, ...(o.agent ? { agent_id: o.agent } : {}) };
  const id = `tu-${session}-${o.agent ?? 'main'}-${ts}`;
  return [
    ev(session, ts, 'tool.call', { tool_use_id: id, tool: o.test ? 'Bash' : 'Edit', input_size: 10, ...(o.test ? { command_class: 'test' } : {}) }, turn),
    ev(session, ts, 'tool.result', { tool_use_id: id, success: o.test !== 'fail', duration_ms: 5, output_size: 2, files_touched: o.write ? [{ path: o.write, mode: 'write' }] : [] }, turn),
  ];
};
const spend = (session: string, ts: number, usd: number, agent?: string) =>
  ev(session, ts, 'turn.step', { model: SONNET, usage: { input: 0, output: Math.round(usd * 100_000), cache_read: 0, cache_creation: 0 }, stop_reason: 'end_turn', tool_use_ids: [] },
    { turn_id: `t-${session}-${agent ?? 'main'}`, ...(agent ? { agent_id: agent } : {}) });
const link = (session: string, ts: number, number: number) => ev(session, ts, 'session.pr', { number });
const FIXED = { id: 'F1', severity: 'major', file: 'src/a.ts', fate: 'fixed' };
const OPEN = { id: 'F2', severity: 'minor', file: 'src/b.ts', fate: 'open' };
/** A findings report by an agent of a session of its own (a reviewer's: it wrote no file there). */
const report = (ts: number, ref: { branch: string } | { pr: number }, list: object[] = [FIXED], by = 'rev') =>
  ev(`s-${by}`, ts, 'findings.report', { ...ref, findings: list, dropped: 0 }, { agent_id: by, turn_id: `t-${by}-${ts}` });
const gate = (ts: number, result: 'pass' | 'fail', commit = 'a1b2c3d') => ev('s-gate', ts, 'gate.report', { result, commit }, { agent_id: `g-${ts}`, turn_id: `tg-${ts}` });
const pr = (number: number, over: object = {}) => ({ number, head: `fix/${number}`, head_oid: HEAD, merge_state: 'CLEAN', last_commit_at: T0, checks: [], bots: [], ...over });
const read = (ts: number, prs: object[], issues?: object[]) => ev('reader', ts, 'project.open_prs', { prs, ...(issues ? { issues } : {}) });
const merged = (ts: number, prs: object[]) => ev('reader', ts, 'project.prs', { prs: prs.map((p) => ({ additions: 1, deletions: 1, ...p })) });
const issues = (...numbers: number[]) => numbers.map((number) => ({ number, milestone: M }));

let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  app = buildApp({ token: TOKEN, store: openStore(':memory:'), now: () => NOW });
});
const send = async (...events: unknown[]) => {
  const flat = events.flat(Infinity) as Event[];
  const r = await app.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events: flat } });
  expect(r.json()).toMatchObject({ accepted: flat.length, rejected: 0 });
};
type Line = {
  kind: 'run' | 'pr-open' | 'pr-merged' | 'round'; at: number; stage: string; session?: string; agent?: { id: string; type: string | null; role: string | null; model: string | null } | string; pr?: number;
  wrote?: { paths: string[]; count: number }; tests?: { runs: number; failed: number }; rounds?: { at: number; open: number; dropped: number; reviewer: boolean }[]; usd?: number; partial?: boolean;
  reviewer?: boolean; open?: number; dropped?: number;
};
type Issue = {
  project: string; content: string | null; readAt: number | null;
  issue: { number: number; title: string | null; milestone: string | null; stage: string; bad?: true; ready: boolean | null; reason: string | null; pr: { number: number; head: string | null; merged: boolean } | null; openedAt: number | null };
  story: Line[]; stages: { stage: string; at: number | null; again: number[] }[]; checks: { number: number; ready: boolean; findings: { id: string; fate: string }[]; conditions: object } | null;
  cost: { number: number; usd: number; budget: number | null } | null; links: { kind: string; a: number; b: number; stage: string | null }[]; mentions: { issue: number; direction: string }[];
  sessions: { id: string; branch: string | null; at: number; startedAt: number | null; windowOnly: boolean; imported: boolean }[];
};
const page = async (number: number, project = 'mobile-app'): Promise<Issue> => {
  const r = await app.inject({ url: `/api/issue?${new URLSearchParams({ project, issue: String(number), tz: 'UTC' })}` });
  expect(r.statusCode).toBe(200);
  return r.json();
};
const board = async () => (await app.inject({ url: `/api/board?${new URLSearchParams({ project: 'mobile-app' })}` })).json() as { issues: { number: number; stage: string }[] };

describe('stageOf: the one rule the board and the story both read', () => {
  it('each stage from the facts, the latest that holds', () => {
    expect(stageOf({ exists: false })).toBe('queued');
    expect(stageOf({ exists: true })).toBe('building');
    expect(stageOf({ exists: true, written: 5, review: 7 })).toBe('reviewing');
    expect(stageOf({ exists: true, written: 9, review: 7 })).toBe('fixing');
    expect(stageOf({ exists: true, written: 9, review: 7, gate: 8 })).toBe('fixing'); // the test run is older than the last write
    expect(stageOf({ exists: true, written: 5, review: 7, gate: 7 })).toBe('gate');
    expect(stageOf({ exists: true, written: 5, review: 7, gate: 7, ready: true })).toBe('ready');
    expect(stageOf({ exists: true, ready: true, merged: true })).toBe('merged');
  });
});

describe('GET /api/issue: the story', () => {
  // #409 on its own branch: the main agent writes a file and a lockfile and runs the tests twice; a reviewer (in a session of its own) reports at +15 min; a fixer subagent writes at +21; the PR opened at +10, merged at +30.
  const full = () => [
    start('s-409', 'fix/409-retry'), ...call('s-409', T0 + MIN, { write: 'src/a.ts' }), ...call('s-409', T0 + 2 * MIN, { write: 'pnpm-lock.yaml' }),
    ...call('s-409', T0 + 3 * MIN, { test: 'fail' }), ...call('s-409', T0 + 4 * MIN, { test: 'pass' }), spend('s-409', T0 + MIN, 1),
    spawn('s-409', T0 + 20 * MIN, 'fx'), ...call('s-409', T0 + 21 * MIN, { agent: 'fx', write: 'src/b.ts' }), spend('s-409', T0 + 21 * MIN, 0.5, 'fx'),
    report(T0 + 15 * MIN, { pr: 416 }, [FIXED, OPEN]),
    read(T0 + 10 * MIN, [pr(416, { head: 'fix/409-retry', issue: 409, created_at: T0 + 10 * MIN })], issues(409)),
    read(NOW - MIN, [], issues(409)), merged(NOW - 5 * MIN, [{ number: 416, merged_at: T0 + 30 * MIN, head: 'fix/409-retry' }]),
  ];

  it('one line per agent run, oldest first, with the paths it wrote less lockfiles, its test runs and their result, its cost, and the stage it reached; the PR opening and merge are lines', async () => {
    await send(full());
    const p = await page(409);
    expect(p.story.map((l) => [l.kind, l.at, l.stage])).toEqual([
      ['run', T0, 'building'], ['pr-open', T0 + 10 * MIN, 'building'], ['round', T0 + 15 * MIN, 'reviewing'], ['run', T0 + 20 * MIN, 'fixing'], ['pr-merged', T0 + 30 * MIN, 'merged'],
    ]);
    expect(p.story[0]).toMatchObject({ session: 's-409', agent: { id: 's-409:main', type: 'main' }, wrote: { paths: ['src/a.ts'], count: 1 }, tests: { runs: 2, failed: 1 }, usd: 1, partial: false, rounds: [] });
    expect(p.story[1]).toMatchObject({ pr: 416 });
    expect(p.story[2]).toMatchObject({ agent: 's-rev:rev', reviewer: true, open: 1, dropped: 0 }); // a round whose agent is among no run is a line of its own
    expect(p.story[3]).toMatchObject({ session: 's-409', agent: { id: 's-409:fx', type: 'implementer', model: SONNET }, wrote: { paths: ['src/b.ts'], count: 1 }, tests: { runs: 0, failed: 0 }, usd: 0.5 });
    expect(p.issue).toMatchObject({ number: 409, stage: 'merged', pr: { number: 416, merged: true } });
  });

  it('a stage is first reached when its event happened, and a stage left and entered again is a later round: review, write, review', async () => {
    await send(start('s-409', 'fix/409-retry'), ...call('s-409', T0 + 3 * MIN, { write: 'src/a.ts' }), report(T0 + 2 * MIN, { branch: 'fix/409-retry' }), report(T0 + 4 * MIN, { branch: 'fix/409-retry' }, [FIXED], 'rev2'), read(NOW - MIN, [], issues(409)));
    const p = await page(409);
    // the first review (+2) came before any write: Reviewing; the write at +3 is Fixing; the second review (+4): Reviewing again
    expect(Object.fromEntries(p.stages.map((s) => [s.stage, [s.at, s.again]]))).toEqual({
      queued: [null, []], building: [T0, []], reviewing: [T0 + 2 * MIN, [T0 + 4 * MIN]], fixing: [T0 + 3 * MIN, []], gate: [null, []], ready: [null, []], merged: [null, []],
    });
    expect(p.stages.map((s) => s.stage)).toEqual(['queued', 'building', 'reviewing', 'fixing', 'gate', 'ready', 'merged']);
    expect(p.issue.stage).toBe('reviewing');
  });

  it('Gate and Ready each show one time, when their last condition was met, and are never reached again', async () => {
    await send(start('s-412', 'fix/412-queue'), ...call('s-412', T0 + MIN, { write: 'src/a.ts' }), report(T0 + 2 * MIN, { branch: 'fix/412-queue' }), gate(T0 + 3 * MIN, 'pass'),
      read(NOW - MIN, [pr(418, { head: 'fix/412-queue', issue: 412 })], issues(412)));
    const p = await page(412);
    expect(p.issue).toMatchObject({ stage: 'ready', ready: true });
    expect(Object.fromEntries(p.stages.map((s) => [s.stage, [s.at, s.again]]))).toMatchObject({ reviewing: [T0 + 2 * MIN, []], gate: [T0 + 3 * MIN, []], ready: [T0 + 3 * MIN, []] });
  });

  it('Ready shows the time of the findings report when it came after the gate', async () => {
    await send(start('s-412', 'fix/412-queue'), ...call('s-412', T0 + MIN, { write: 'src/a.ts' }), gate(T0 + 3 * MIN, 'pass'), report(T0 + 5 * MIN, { branch: 'fix/412-queue' }),
      read(NOW - MIN, [pr(418, { head: 'fix/412-queue', issue: 412 })], issues(412)));
    const p = await page(412);
    expect(p.issue.stage).toBe('ready');
    expect(Object.fromEntries(p.stages.map((s) => [s.stage, [s.at, s.again]]))).toMatchObject({ gate: [T0 + 3 * MIN, []], reviewing: [T0 + 5 * MIN, []], ready: [T0 + 5 * MIN, []] });
  });

  it('a session that reaches the issue only through a PR\'s window adds the runs that wrote or spent inside it, and only the writes and cost inside it', async () => {
    // s-long is on no issue branch; it linked PR 416 (#409) at +10 and PR 418 (#412) at +20. Its main agent starts at T0 (#409's window); the subagent starts at +12 (#412's).
    await send(
      start('s-long', 'dev'), ...call('s-long', T0 + MIN, { write: 'src/a.ts' }), ...call('s-long', T0 + 15 * MIN, { write: 'src/b.ts' }), spend('s-long', T0 + 15 * MIN, 2), link('s-long', T0 + 10 * MIN, 416), link('s-long', T0 + 20 * MIN, 418),
      spawn('s-long', T0 + 12 * MIN, 'late'), ...call('s-long', T0 + 16 * MIN, { agent: 'late', write: 'src/c.ts' }),
      read(NOW - MIN, [pr(416, { head: 'feat/token', issue: 409, created_at: T0 + 10 * MIN }), pr(418, { head: 'feat/queue', issue: 412, created_at: T0 + 20 * MIN })], issues(409, 412)),
    );
    const a = await page(409);
    expect(a.story.filter((l) => l.kind === 'run').map((l) => [l.agent && (l.agent as { id: string }).id, l.wrote, l.usd])).toEqual([['s-long:main', { paths: ['src/a.ts'], count: 1 }, 0]]); // its write and its $2 at +15 are #412's
    expect(a.sessions).toMatchObject([{ id: 's-long', windowOnly: true, imported: false }]);
    const b = await page(412);
    // the main agent started before #412's window, but what it wrote and spent inside it is #412's: a run from its first request in the window
    expect(b.story.filter((l) => l.kind === 'run').map((l) => [(l.agent as { id: string }).id, l.at, l.wrote, l.usd])).toEqual([
      ['s-long:main', T0 + 15 * MIN, { paths: ['src/b.ts'], count: 1 }, 2], ['s-long:late', T0 + 16 * MIN, { paths: ['src/c.ts'], count: 1 }, 0],
    ]);
    expect(b.cost!.usd).toBe(2); // the story's cost is the page's cost
    expect(b.story.reduce((n, l) => n + (l.usd ?? 0), 0)).toBe(2);
  });

  it('a line\'s stage is the stage after the run\'s own last event: a fixer that writes after the PR opened is Fixing on its own line, and the PR line is Reviewing', async () => {
    await send(
      start('s-409', 'fix/409-retry'), ...call('s-409', T0 + MIN, { write: 'src/a.ts' }), report(T0 + 2 * MIN, { branch: 'fix/409-retry' }),
      spawn('s-409', T0 + 4 * MIN, 'fx'), ...call('s-409', T0 + 6 * MIN, { agent: 'fx', write: 'src/b.ts' }),
      read(NOW - MIN, [pr(416, { head: 'fix/409-retry', issue: 409, created_at: T0 + 5 * MIN })], issues(409)),
    );
    const p = await page(409);
    expect(p.story.map((l) => [l.kind, l.at, l.stage])).toEqual([['run', T0, 'building'], ['round', T0 + 2 * MIN, 'reviewing'], ['run', T0 + 4 * MIN, 'fixing'], ['pr-open', T0 + 5 * MIN, 'reviewing']]);
    expect(p.issue.stage).toBe('fixing');
  });

  it('a report by a run\'s own agent is a round on that run\'s line, not a line of its own, and not a review', async () => {
    await send(
      start('s-409', 'fix/409-retry'), ...call('s-409', T0 + MIN, { write: 'src/a.ts' }), spawn('s-409', T0 + 20 * MIN, 'fx'), ...call('s-409', T0 + 21 * MIN, { agent: 'fx', write: 'src/b.ts' }),
      ev('s-409', T0 + 22 * MIN, 'findings.report', { branch: 'fix/409-retry', findings: [OPEN], dropped: 0 }, { agent_id: 'fx', turn_id: 't-s-409-fx' }), read(NOW - MIN, [], issues(409)),
    );
    const p = await page(409);
    expect(p.story.map((l) => [l.kind, l.stage])).toEqual([['run', 'building'], ['run', 'building']]); // a fixer's report is no review
    expect(p.story[1]!.rounds).toEqual([{ at: T0 + 22 * MIN, reviewer: false, open: 1, dropped: 0 }]);
    expect(p.story[0]!.rounds).toEqual([]);
  });

  it('a run with a request the price list lacks is partial: its cost is a floor', async () => {
    await send(start('s-409', 'fix/409-retry'), ...call('s-409', T0 + MIN, { write: 'src/a.ts' }), spend('s-409', T0 + MIN, 1),
      ev('s-409', T0 + 2 * MIN, 'turn.step', { model: 'mystery-model-1', usage: { input: 1, output: 1, cache_read: 0, cache_creation: 0 }, stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: 't-s-409-main' }), read(NOW - MIN, [], issues(409)));
    const p = await page(409);
    expect(p.story[0]).toMatchObject({ usd: 1, partial: true });
    expect(p.cost).toMatchObject({ usd: 1, partial: true });
  });

  it('an open PR the read gave no opening time for, and no session: Building is reached when the issue first showed a sign, not left empty under a later Reviewing', async () => {
    await send(report(T0 + 2 * MIN, { pr: 418 }), gate(T0 + 3 * MIN, 'pass'), read(NOW - MIN, [pr(418, { head: 'fix/412-queue', issue: 412 })], issues(412)));
    const p = await page(412);
    expect(Object.fromEntries(p.stages.map((s) => [s.stage, [s.at, s.again]]))).toMatchObject({ building: [T0 + 2 * MIN, []], reviewing: [T0 + 2 * MIN, []], gate: [T0 + 3 * MIN, []] });
  });

  it('a session that did everything itself is one line; an imported session still gives its run, with no files and its cost', async () => {
    await send(start('s-imp', 'fix/409-retry', T0, 'import'), spend('s-imp', T0 + MIN, 2), read(NOW - MIN, [], issues(409)));
    const p = await page(409);
    expect(p.story).toMatchObject([{ kind: 'run', session: 's-imp', wrote: { paths: [], count: 0 }, tests: { runs: 0, failed: 0 }, usd: 2, stage: 'building' }]);
    expect(p.sessions).toMatchObject([{ id: 's-imp', branch: 'fix/409-retry', imported: true, windowOnly: false }]);
  });

  it('at most 20 paths a run, with the count of all', async () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);
    await send(start('s-409', 'fix/409-retry'), files.flatMap((f, i) => call('s-409', T0 + (i + 1) * 1000, { write: f })), read(NOW - MIN, [], issues(409)));
    const run = (await page(409)).story[0]!;
    expect(run.wrote!.count).toBe(25);
    expect(run.wrote!.paths).toEqual(files.slice(0, 20));
  });

  it('an issue with no session and no PR is Queued with no story; one the project does not know is 404; no issue is 400', async () => {
    await send(read(NOW - MIN, [], issues(417)));
    const p = await page(417);
    expect(p.story).toEqual([]);
    expect(p.issue).toMatchObject({ number: 417, stage: 'queued', pr: null, milestone: M });
    expect(p.stages.map((s) => [s.stage, s.at])).toEqual([['queued', null], ['building', null], ['reviewing', null], ['fixing', null], ['gate', null], ['ready', null], ['merged', null]]);
    expect((await app.inject({ url: '/api/issue?project=mobile-app&issue=999' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/issue?project=nobody&issue=417' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/issue?project=mobile-app' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/issue?project=mobile-app&issue=0' })).statusCode).toBe(400);
  });

  it('a project that sends no titles is numbers only: the title is null', async () => {
    await send(read(NOW - MIN, [], [{ number: 417, milestone: M }]));
    expect((await page(417)).issue.title).toBeNull();
    await send(read(NOW - 30_000, [], [{ number: 417, milestone: M, title: 'Retry the sync' }]));
    expect((await page(417)).issue.title).toBe('Retry the sync');
  });
});

describe('GET /api/issue: the rest of the page', () => {
  it('the open PR\'s checks and findings as /api/factory gives them, the cost as /api/budget gives it, and the links to the issue', async () => {
    await send(
      start('s-412', 'fix/412-queue'), ...call('s-412', T0 + MIN, { write: 'src/a.ts' }), spend('s-412', T0 + MIN, 3), report(T0 + 2 * MIN, { branch: 'fix/412-queue' }, [FIXED, OPEN]), gate(T0 + 3 * MIN, 'pass'),
      start('s-415', 'fix/415-sync'), ...call('s-415', T0 + MIN, { write: 'src/a.ts' }),
      read(NOW - MIN, [pr(418, { head: 'fix/412-queue', issue: 412 })], [{ number: 412, milestone: M, title: 'Queue', mentions: [415, 999] }, { number: 415, milestone: M }, { number: 777, milestone: 'other', mentions: [412] }]),
    );
    const p = await page(412);
    const factory = (await app.inject({ url: '/api/factory?project=mobile-app' })).json().prs[0];
    expect(p.checks).toEqual(factory); // the same object, field for field
    expect(p.checks).toMatchObject({ number: 418, ready: false, findings: [{ id: 'F2', fate: 'open' }, { id: 'F1', fate: 'fixed' }] });
    const budget = (await app.inject({ url: '/api/budget?project=mobile-app&tz=UTC' })).json().issues.find((i: { number: number }) => i.number === 412);
    expect(p.cost).toEqual(budget);
    expect(p.cost).toMatchObject({ number: 412, usd: 3, budget: null });
    // the file #412 and #415 both wrote is a link on the Map; #999 is on no map, and #777 (another milestone) names this one: both show here only
    expect(p.links).toMatchObject([{ kind: 'file', a: 412, b: 415, files: ['src/a.ts'], stage: 'building' }, { kind: 'mention', a: 412, b: 415, stage: 'building' }]);
    expect(p.mentions).toEqual([{ issue: 999, direction: 'out', title: null, stage: null, known: false }, { issue: 777, direction: 'in', title: null, stage: null, known: true }]);
    expect(p.sessions).toMatchObject([{ id: 's-412', branch: 'fix/412-queue', startedAt: T0, windowOnly: false }]);
    expect(p.readAt).toBe(NOW - MIN);
    // another issue's page shows none of these
    expect((await page(415)).checks).toBeNull();
  });

  it('a mention between this issue and one that is not on the map shows here whichever of the two has no milestone, once when each names the other', async () => {
    await send(read(NOW - MIN, [], [{ number: 409, milestone: M, title: 'Retry' }, { number: 412, milestone: M }, { number: 500, mentions: [409, 777] }, { number: 777, milestone: 'other', mentions: [500] }]));
    expect((await page(500)).mentions).toEqual([{ issue: 409, direction: 'out', title: 'Retry', stage: 'queued', known: true }, { issue: 777, direction: 'out', both: true, title: null, stage: null, known: true }]); // 500 is on no map, so its mention of 409 shows
    expect((await page(777)).mentions).toEqual([{ issue: 500, direction: 'out', both: true, title: null, stage: null, known: true }]);
    expect((await page(409)).mentions).toEqual([{ issue: 500, direction: 'in', title: null, stage: null, known: true }]);
  });

  it('a merged issue has no checks: the PR is merged', async () => {
    await send(start('s-403', 'fix/403-banner'), ...call('s-403', T0 + MIN, { write: 'src/a.ts' }), read(T0 + 5 * MIN, [pr(405, { head: 'fix/403-banner', issue: 403, created_at: T0 + 2 * MIN })], issues(403)),
      read(NOW - MIN, [], issues(403)), merged(NOW - 5 * MIN, [{ number: 405, merged_at: T0 + 9 * MIN, head: 'fix/403-banner' }]));
    const p = await page(403);
    expect(p.checks).toBeNull();
    expect(p.issue).toMatchObject({ stage: 'merged', ready: null, reason: null, pr: { number: 405, merged: true } });
    // the track keeps no time for Gate and Ready: past heads and past readiness aren't stored
    expect(p.stages.filter((s) => s.stage === 'gate' || s.stage === 'ready').map((s) => s.at)).toEqual([null, null]);
    expect(p.stages.find((s) => s.stage === 'merged')!.at).toBe(T0 + 9 * MIN);
  });

  it('for every issue of a fixture that covers all seven stages, the story\'s last stage and the issue\'s are the board\'s', async () => {
    const branch = (s: string, b: string, ...rest: unknown[]) => [start(s, b), ...call(s, T0 + MIN, { write: 'src/a.ts' }), ...rest];
    await send(
      branch('s-415', 'fix/415-sync'),
      branch('s-413', 'fix/413-token', report(T0 + 2 * MIN, { branch: 'fix/413-token' })),
      branch('s-409', 'fix/409-retry', report(T0 + 2 * MIN, { branch: 'fix/409-retry' }), ...call('s-409', T0 + 3 * MIN, { write: 'src/b.ts' })),
      branch('s-407', 'fix/407-photos', report(T0 + 2 * MIN, { branch: 'fix/407-photos' }), ...call('s-407', T0 + 3 * MIN, { write: 'src/b.ts' }), gate(T0 + 4 * MIN, 'pass', 'c0d1e2f')),
      branch('s-412', 'fix/412-queue', report(T0 + 2 * MIN, { branch: 'fix/412-queue' }), gate(T0 + 4 * MIN, 'pass')),
      branch('s-403', 'fix/403-banner'),
      read(T0, [pr(405, { head: 'fix/403-banner', issue: 403 })]),
      read(NOW - MIN, [pr(416, { head: 'fix/409-retry', issue: 409, head_oid: oid('e4f5a6b') }), pr(414, { head: 'fix/407-photos', issue: 407, head_oid: oid('c0d1e2f'), merge_state: 'UNSTABLE' }), pr(418, { head: 'fix/412-queue', issue: 412 })], issues(417, 415, 413, 409, 407, 412, 403)),
      merged(NOW - 30 * MIN, [{ number: 405, merged_at: T0 + 6 * MIN, head: 'fix/403-banner' }]),
    );
    const b = await board();
    expect(Object.fromEntries(b.issues.map((i) => [i.number, i.stage]))).toEqual({ 417: 'queued', 415: 'building', 413: 'reviewing', 409: 'fixing', 407: 'gate', 412: 'ready', 403: 'merged' });
    const last: Record<number, string | undefined> = {};
    for (const { number, stage } of b.issues) {
      const p = await page(number);
      expect(p.issue.stage).toBe(stage);
      // the stage reached last on the track (the latest time, the later stage on a tie) is the board's: the story's lines can end earlier, a gate and readiness have none
      const reached = p.stages.filter((s) => s.stage !== 'queued').flatMap((s) => [s.at, ...s.again].filter((t): t is number => t !== null).map((t) => [t, STAGES.indexOf(s.stage as never), s.stage] as const));
      expect(reached.toSorted((x, y) => x[0] - y[0] || x[1] - y[1]).at(-1)?.[2] ?? 'queued', `#${number}`).toBe(stage);
      last[number] = p.story.at(-1)?.stage;
    }
    // each last line's own stage, after its own last event
    expect(last).toEqual({ 417: undefined, 415: 'building', 413: 'reviewing', 409: 'reviewing', 407: 'reviewing', 412: 'reviewing', 403: 'merged' });
  });
});
