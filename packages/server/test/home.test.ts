import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { Event } from '@agent-orb/shared';
import { buildApp } from '../src/app.ts';

// v0.5 slice 3 (#107, Follow; the plan is #64): GET /api/home, each project with a session in the past 30 days: its milestone, the counts of merged, in flight and queued, the rows in flight,
// the issues each shares files with, this month's spend and goal. The tests send the plugin's events to /ingest and compare what Home says with what /api/board, /api/links and /api/goal say
// for the same project, so the three can never drift apart.
const TOKEN = 'test-token-0123456789';
const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const T0 = NOW - DAY; // the sessions ran yesterday
const SONNET = 'claude-sonnet-5-5'; // $10 per million output tokens: 100,000 output tokens are $1
const HEAD = 'a1b2c3d'.padEnd(40, '1');
const M = 'v2.3 Offline';

type Project = { cwd: string; name: string; git_remote?: string };
const MOBILE: Project = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
const FIELD: Project = { cwd: '/Users/a/field-notes', name: 'field-notes', git_remote: 'github.com/o/field-notes' };
const BILLING: Project = { cwd: '/Users/a/billing-db', name: 'billing-db', git_remote: 'github.com/o/billing-db' };
let n = 0;
const ev = (project: Project, session: string, ts: number, kind: string, data: object, extra: object = {}): Event =>
  ({ v: 1, id: `00000000-0000-4000-b107-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'local', session_id: session, project, kind, data, ...extra }) as Event;
const start = (project: Project, session: string, branch: string | undefined, ts = T0) =>
  ev({ ...project, ...(branch ? { git_branch: branch } : {}) } as Project, session, ts, 'session.start', { model: SONNET, source: 'interactive', claude_version: '2.1.316', plugin_version: '0.4.6' }, {});
/** A file written by the session's main agent at `ts`: the call and its result, which is what files_touched hangs on. */
const write = (project: Project, session: string, ts: number, path = 'src/a.ts'): Event[] => {
  const turn = { turn_id: `t-${session}-${ts}-${path}` };
  const id = `tu-${session}-${ts}-${path}`;
  return [
    ev(project, session, ts, 'tool.call', { tool_use_id: id, tool: 'Edit', input_size: 10 }, turn),
    ev(project, session, ts, 'tool.result', { tool_use_id: id, success: true, duration_ms: 5, output_size: 2, files_touched: [{ path, mode: 'write' }] }, turn),
  ];
};
const spend = (project: Project, session: string, ts: number, usd: number) =>
  ev(project, session, ts, 'turn.step', { model: SONNET, usage: { input: 0, output: Math.round(usd * 100_000), cache_read: 0, cache_creation: 0 }, stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: `t-spend-${session}-${ts}` });
const report = (project: Project, ts: number, branch: string, fate: 'open' | 'fixed') =>
  ev(project, 's-409', ts, 'findings.report', { branch, findings: [{ id: 'F1', severity: 'major', file: 'src/a.ts', fate }], dropped: 0 }, { agent_id: 'rev', turn_id: `t-rev-${ts}` });
const pr = (number: number, over: object = {}) => ({ number, head: `fix/${number}`, head_oid: HEAD, merge_state: 'CLEAN', last_commit_at: T0, checks: [], bots: [], ...over });
// the plugin reads GitHub from a session that is running in the repo: here the one on the project's first issue
const READER: Record<string, string> = { 'mobile-app': 's-415', 'field-notes': 's-86' };
const read = (project: Project, ts: number, prs: object[], issues?: object[]) => ev(project, READER[project.name]!, ts, 'project.open_prs', { prs, ...(issues ? { issues } : {}) }, {});
const merged = (project: Project, ts: number, prs: object[]) => ev(project, READER[project.name]!, ts, 'project.prs', { prs: prs.map((p) => ({ additions: 1, deletions: 1, ...p })) });
const issues = (...numbers: number[]) => numbers.map((number) => ({ number, milestone: M, title: `Issue ${number}` }));

let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  app = buildApp({ token: TOKEN, now: () => NOW });
});
const send = async (...events: unknown[]) => {
  const flat = events.flat(Infinity) as Event[];
  const r = await app.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events: flat } });
  expect(r.json()).toMatchObject({ accepted: flat.length, rejected: 0 });
};
type Share = { issue: number; together: boolean };
type HomeRow = { number: number; title?: string; stage: string; outside: boolean; shares: Share[]; openFindings?: true; budget?: { usd: number; budget: number; mark: string | null } };
type HomeProject = {
  name: string; last: number; milestone: string | null; counts: { merged: number; flight: number; queued: number; outside: number }; rows: HomeRow[]; readAt: number | null;
  notOnIssue: { count: number; sessions: { id: string; branch: string | null; at: number }[] }; month: string; goal: number | null; spent: number; costPartial: boolean;
};
type Home = { projects: HomeProject[]; quiet: { name: string; last: number }[] };
const home = async (tz = 'UTC'): Promise<Home> => (await app.inject({ url: `/api/home?tz=${tz}` })).json();
const homeOf = async (name: string) => (await home()).projects.find((p) => p.name === name)!;
const getJson = async (url: string) => (await app.inject({ url })).json();

/** mobile-app's milestone: #415 building, #409 fixing with a finding open and its PR, #412 ready for nothing yet (a session), #417 queued, #403 merged. */
const MILESTONE = () => [
  start(MOBILE, 's-415', 'fix/415-sync'), write(MOBILE, 's-415', T0 + MIN, 'src/net/client.ts'),
  start(MOBILE, 's-409', 'fix/409-retry'), write(MOBILE, 's-409', T0 + 2 * MIN, 'src/net/client.ts'), write(MOBILE, 's-409', T0 + 3 * MIN, 'src/auth/refresh.ts'), report(MOBILE, T0 + 4 * MIN, 'fix/409-retry', 'open'), write(MOBILE, 's-409', T0 + 5 * MIN, 'src/auth/refresh.ts'),
  start(MOBILE, 's-403', 'fix/403-banner'), write(MOBILE, 's-403', T0 + MIN, 'src/auth/refresh.ts'),
  read(MOBILE, NOW - 10 * MIN, [], issues(403)), // #403 was open, and closes when its PR merges
  merged(MOBILE, NOW - 3 * MIN, [{ number: 405, merged_at: T0 + 6 * MIN, head: 'fix/403-banner' }]),
  read(MOBILE, NOW - 2 * MIN, [pr(416, { head: 'fix/409-retry', issue: 409 })], [...issues(415, 409, 417), { number: 419, milestone: M, title: 'Retry queue metrics' }]),
];

describe('GET /api/home: the rows in flight', () => {
  it("each project's rows are the board's rows in flight for the same milestone, as the board gives them, plus what Home adds", async () => {
    await send(MILESTONE());
    const board = await getJson('/api/board?project=mobile-app');
    const p = await homeOf('mobile-app');
    expect(p.milestone).toBe(M);
    expect(board.issues.map((i: { number: number; stage: string }) => [i.number, i.stage])).toEqual([[415, 'building'], [409, 'fixing'], [403, 'merged'], [419, 'queued'], [417, 'queued']]);
    const inFlight = board.issues.filter((i: { stage: string }) => i.stage !== 'merged' && i.stage !== 'queued');
    expect(p.rows.map(({ shares: _s, openFindings: _o, budget: _b, ...r }) => r)).toEqual(inFlight);
    expect(p.counts).toEqual({ merged: 1, flight: 2, queued: 2, outside: 0 });
  });

  it('an open finding marks its row, and a row without one has no mark', async () => {
    await send(MILESTONE());
    const p = await homeOf('mobile-app');
    expect(p.rows.map((r) => [r.number, r.openFindings])).toEqual([[415, undefined], [409, true]]);
  });

  it('an issue in flight outside the milestone is a row too, and is counted apart from the milestone\'s own', async () => {
    await send(MILESTONE(), start(MOBILE, 's-398', 'fix/398-feed'), write(MOBILE, 's-398', NOW - 10 * MIN, 'src/feed/list.tsx'));
    const p = await homeOf('mobile-app');
    expect(p.rows.find((r) => r.number === 398)).toMatchObject({ outside: true, stage: 'building' });
    expect(p.counts).toEqual({ merged: 1, flight: 2, queued: 2, outside: 1 });
  });

  it('the GitHub read time is the one the board reads', async () => {
    await send(MILESTONE());
    expect((await homeOf('mobile-app')).readAt).toBe(NOW - 2 * MIN);
  });
});

describe('GET /api/home: which projects', () => {
  it('a project whose last session is 31 days old is in the quiet list only; one 29 days old has a card', async () => {
    await send(MILESTONE(), start(BILLING, 's-b', undefined, NOW - 31 * DAY), start(FIELD, 's-f', undefined, NOW - 29 * DAY));
    const h = await home();
    expect(h.projects.map((p) => p.name)).toEqual(['mobile-app', 'field-notes']);
    expect(h.quiet).toEqual([{ name: 'billing-db', last: NOW - 31 * DAY }]);
  });

  it('a project is as recent as its newest session, and the cards are most recent first', async () => {
    await send(start(FIELD, 's-f', undefined, NOW - 5 * DAY), start(MOBILE, 's-m', undefined, NOW - 2 * DAY), start(BILLING, 's-b', undefined, NOW - 9 * DAY));
    expect((await home()).projects.map((p) => [p.name, p.last])).toEqual([['mobile-app', NOW - 2 * DAY], ['field-notes', NOW - 5 * DAY], ['billing-db', NOW - 9 * DAY]]);
  });

  it('a project with no milestone has no milestone and lists its issues in flight', async () => {
    await send(start(FIELD, 's-86', 'fix/86-pdf'), write(FIELD, 's-86', T0 + MIN));
    const p = await homeOf('field-notes');
    expect(p.milestone).toBeNull();
    expect(p.rows).toEqual([expect.objectContaining({ number: 86, outside: true, stage: 'building', shares: [] })]);
    expect(p.counts).toEqual({ merged: 0, flight: 0, queued: 0, outside: 1 });
  });

  it("an excluded project's rows carry numbers and no title; a project that sends titles keeps them", async () => {
    await send(MILESTONE(), start(FIELD, 's-86', 'fix/86-pdf'), write(FIELD, 's-86', T0 + MIN), read(FIELD, NOW - MIN, [], [{ number: 86, milestone: 'v1.1 Export' }]));
    expect((await homeOf('field-notes')).rows).toEqual([expect.objectContaining({ number: 86, stage: 'building' })]);
    expect((await homeOf('field-notes')).rows[0]).not.toHaveProperty('title');
    expect((await homeOf('mobile-app')).rows.map((r) => r.title)).toEqual(['Issue 415', 'Issue 409']);
  });
});

describe('GET /api/home: sessions on no issue', () => {
  it('a session on no issue shows under its project with its branch, and a session on an issue does not', async () => {
    await send(MILESTONE(), start(MOBILE, 's-main', 'main', NOW - 3 * MIN));
    const p = await homeOf('mobile-app');
    expect(p.notOnIssue).toEqual({ count: 1, sessions: [{ id: 's-main', branch: 'main', at: NOW - 3 * MIN }] });
  });

  it('only the past 30 days count; the list is the newest few and the count is all of them', async () => {
    const many = Array.from({ length: 7 }, (_, i) => start(MOBILE, `s-x${i}`, 'main', NOW - (i + 1) * DAY));
    await send(MILESTONE(), many, start(MOBILE, 's-old', 'main', NOW - 40 * DAY));
    const { notOnIssue } = await homeOf('mobile-app');
    expect(notOnIssue.count).toBe(7);
    expect(notOnIssue.sessions.map((s) => s.id)).toEqual(['s-x0', 's-x1', 's-x2', 's-x3', 's-x4']);
  });
});

describe('GET /api/home: the issues a row shares files with', () => {
  it('a file two issues in flight wrote names the other on each row, together while both are in flight', async () => {
    await send(MILESTONE());
    const p = await homeOf('mobile-app');
    expect(p.rows.map((r) => [r.number, r.shares])).toEqual([[415, [{ issue: 409, together: true }]], [409, [{ issue: 403, together: false }, { issue: 415, together: true }]]]);
  });

  it('a lockfile both wrote names no issue', async () => {
    await send(
      start(MOBILE, 's-415', 'fix/415-sync'), write(MOBILE, 's-415', T0 + MIN, 'pnpm-lock.yaml'),
      start(MOBILE, 's-409', 'fix/409-retry'), write(MOBILE, 's-409', T0 + MIN, 'pnpm-lock.yaml'), read(MOBILE, NOW - MIN, [], issues(415, 409)),
    );
    expect((await homeOf('mobile-app')).rows.map((r) => [r.number, r.shares])).toEqual([[415, []], [409, []]]);
    expect(await getJson('/api/links?project=mobile-app')).toMatchObject({ links: [] });
  });
});

describe("GET /api/home: this month's spend", () => {
  it("equals /api/goal's for the same project and zone, with the goal", async () => {
    await send(MILESTONE(), spend(MOBILE, 's-415', NOW - 2 * DAY, 2.5), spend(MOBILE, 's-409', NOW - 3 * DAY, 1.25), spend(MOBILE, 's-409', NOW - 40 * DAY, 9));
    await app.inject({ method: 'PUT', url: '/api/goal', payload: { project: 'mobile-app', usd: 100 } });
    for (const tz of ['UTC', 'Pacific/Auckland']) {
      const goal = await getJson(`/api/goal?project=mobile-app&tz=${tz}`);
      const p = (await home(tz)).projects.find((x) => x.name === 'mobile-app')!;
      expect({ month: p.month, goal: p.goal, spent: p.spent, costPartial: p.costPartial }).toEqual({ month: goal.month, goal: goal.goal, spent: goal.spent, costPartial: goal.costPartial });
    }
    const p = await homeOf('mobile-app');
    expect(p).toMatchObject({ month: '2026-11', goal: 100, spent: 3.75 });
  });

  it('no goal set is a null goal', async () => {
    await send(MILESTONE());
    expect(await homeOf('mobile-app')).toMatchObject({ goal: null, spent: 0 });
  });
});

describe('GET /api/home: over budget', () => {
  const costPasses = () => {
    const seen: string[] = [];
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      seen.push(sql);
      return prepare.call(this, sql);
    };
    return { seen, stop: () => (DatabaseSync.prototype.prepare = prepare) };
  };
  let spy: ReturnType<typeof costPasses> | undefined;
  afterEach(() => spy?.stop());

  it('with no budget set anywhere the cost pass is not run and no row has a budget', async () => {
    await send(MILESTONE(), spend(MOBILE, 's-409', T0 + 5 * MIN, 4));
    spy = costPasses();
    const p = await homeOf('mobile-app');
    expect(spy.seen.filter((sql) => sql.includes('GROUP BY a.session_id'))).toEqual([]);
    for (const r of p.rows) expect(r).not.toHaveProperty('budget');
  });

  it("a budget set on an issue and reached marks its row at100, with the budget code's own figures; a row with none has no budget", async () => {
    await send(MILESTONE(), spend(MOBILE, 's-409', T0 + 5 * MIN, 4), spend(MOBILE, 's-415', T0 + 5 * MIN, 1));
    await app.inject({ method: 'PUT', url: '/api/budget', payload: { project: 'mobile-app', issue: 409, usd: 4 } });
    spy = costPasses();
    const p = await homeOf('mobile-app');
    expect(spy.seen.filter((sql) => sql.includes('GROUP BY a.session_id'))).toHaveLength(1);
    expect(p.rows.map((r) => [r.number, r.budget])).toEqual([[415, undefined], [409, expect.objectContaining({ usd: 4, budget: 4, mark: 'at100' })]]);
  });

  it("a milestone's default holds its rows to it: nearly spent is at80, under it no mark", async () => {
    await send(MILESTONE(), spend(MOBILE, 's-409', T0 + 5 * MIN, 4), spend(MOBILE, 's-415', T0 + 5 * MIN, 1));
    await app.inject({ method: 'PUT', url: '/api/budget', payload: { project: 'mobile-app', milestone: M, usd: 5 } });
    expect((await homeOf('mobile-app')).rows.map((r) => [r.number, r.budget?.mark])).toEqual([[415, null], [409, 'at80']]);
  });

  it("another project's budget does not start this project's pass", async () => {
    await send(MILESTONE(), start(FIELD, 's-86', 'fix/86-pdf'), write(FIELD, 's-86', T0 + MIN), read(FIELD, NOW - MIN, [], [{ number: 86, milestone: 'v1.1 Export' }]));
    await app.inject({ method: 'PUT', url: '/api/budget', payload: { project: 'mobile-app', issue: 409, usd: 4 } });
    spy = costPasses();
    await home();
    expect(spy.seen.filter((sql) => sql.includes('GROUP BY a.session_id'))).toHaveLength(1); // mobile-app's, not field-notes'
  });
});
