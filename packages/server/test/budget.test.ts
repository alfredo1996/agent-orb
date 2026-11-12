import { beforeEach, describe, expect, it } from 'vitest';
import type { Event } from '@agent-orb/shared';
import { buildApp } from '../src/app.ts';

// v0.4 slice 2 (#28, Factory; PROJECT.md §15): what an issue cost, by time windows, against its budget. A session on an issue branch counts whole; in any other session the turns up
// to a PR's opening go to that PR's issue; the rest is "not on an issue". Every figure is an estimate and nothing is ever stopped. The tests send the plugin's events to /ingest and read
// GET /api/budget, so the writer, the assignment and the route are held together.
const TOKEN = 'test-token-0123456789';
const MIN = 60_000;
const T0 = Date.parse('2026-11-03T09:00:00Z');
const NOW0 = Date.parse('2026-11-05T12:00:00Z');
const SONNET = 'claude-sonnet-5-5'; // $10 per million output tokens: 100,000 output tokens are $1
const FABLE9 = 'claude-fable-9'; // not in pricing.json: its cost is null

type Project = { cwd: string; name: string; git_remote?: string; git_branch?: string };
const MOBILE: Project = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
const OTHER: Project = { cwd: '/Users/a/billing', name: 'billing', git_remote: 'github.com/o/billing' };
let n = 0;
const ev = (session: string, ts: number, kind: string, data: object, extra: object = {}, project: Project = MOBILE): Event =>
  ({ v: 1, id: `00000000-0000-4000-b290-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'local', session_id: session, project, kind, data, ...extra }) as Event;
const start = (session: string, branch: string | undefined, ts = T0, project: Project = MOBILE) =>
  ev(session, ts, 'session.start', { model: SONNET, source: 'startup', claude_version: '2.1.308', plugin_version: '0.4.0' }, {}, { ...project, ...(branch ? { git_branch: branch } : {}) });
/** A request that cost `usd` dollars (to a tenth of a cent) at `ts`. */
const spend = (session: string, ts: number, usd: number, model = SONNET, project: Project = MOBILE) =>
  ev(session, ts, 'turn.step', { model, usage: { input: 0, output: Math.round(usd * 100_000), cache_read: 0, cache_creation: 0 }, stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: `t-${n + 1}` }, project);
const link = (session: string, ts: number, number: number) => ev(session, ts, 'session.pr', { number });
const pr = (number: number, over: object = {}) => ({ number, head: `feat/${number}`, head_oid: 'a'.repeat(40), merge_state: 'CLEAN', checks: [], bots: [], ...over });
const read = (ts: number, prs: object[], issues?: object[], project: Project = MOBILE) => ev('reader', ts, 'project.open_prs', { prs, ...(issues ? { issues } : {}) }, {}, project);
/** The merged list the plugin reads: a PR's head and when it merged, never the issue it closes. It is the only read that stores a PR's head. */
const merged = (ts: number, prs: object[]) => ev('reader', ts, 'project.prs', { prs: prs.map((p) => ({ additions: 1, deletions: 1, ...p })) });

let app: ReturnType<typeof buildApp>;
let NOW = NOW0;
beforeEach(() => {
  NOW = NOW0;
  app = buildApp({ token: TOKEN, now: () => NOW });
});
const send = async (...events: Event[]) => {
  const r = await app.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events } });
  expect(r.json()).toMatchObject({ accepted: events.length, rejected: 0 });
};
type IssueCost = { number: number; milestone: string | null; usd: number; partial: boolean; whole: number; windows: number; budget: number | null; milestoneBudget: number | null; source: 'issue' | 'milestone' | null; mark: 'at80' | 'at100' | null };
const budget = async (project = 'mobile-app', tz = 'UTC') => (await app.inject({ url: `/api/budget?${new URLSearchParams({ project, tz })}` })).json();
const issue = async (number: number): Promise<IssueCost | undefined> => ((await budget()).issues as IssueCost[]).find((i) => i.number === number);
const put = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: 'PUT', url: '/api/budget', payload: body as object, headers });
  return { status: res.statusCode, body: res.json() };
};
const usd = (x: IssueCost | undefined) => x?.usd;
const close = (got: number | undefined, want: number) => expect(got).toBeCloseTo(want, 9);

// A month of work in one project: an issue branch with a PR of its own, a long session that opens two PRs and works on after them, a session with no PR, a PR that closes no issue, and
// another project's spend that must never show.
const scenario = (): Event[] => [
  start('s-whole', 'fix/90-retry'), spend('s-whole', T0 + MIN, 3), spend('s-whole', T0 + 40 * MIN, 4), link('s-whole', T0 + 15 * MIN, 416), // PR 416 is for #409: the branch's #90 wins, whole
  start('s-long', 'dev'), spend('s-long', T0 + MIN, 2), link('s-long', T0 + 10 * MIN, 416), spend('s-long', T0 + 10 * MIN, 1), spend('s-long', T0 + 12 * MIN, 3),
  link('s-long', T0 + 20 * MIN, 418), spend('s-long', T0 + 25 * MIN, 5),
  start('s-none', 'main'), spend('s-none', T0 + 2 * MIN, 4),
  start('s-bare', 'dev'), spend('s-bare', T0 + 28 * MIN, 6), link('s-bare', T0 + 30 * MIN, 420), // PR 420 closes no issue
  start('s-other', 'fix/90-retry', T0, OTHER), spend('s-other', T0 + MIN, 100, SONNET, OTHER),
  read(T0 + 31 * MIN, [pr(416, { created_at: T0 + 10 * MIN, issue: 409 }), pr(418, { created_at: T0 + 20 * MIN, issue: 412 }), pr(420, { created_at: T0 + 30 * MIN })]),
];
const TOTAL = 3 + 4 + 2 + 1 + 3 + 5 + 4 + 6;

describe('GET /api/budget: whose money it was', () => {
  it('a session on an issue branch counts whole for that issue, whatever PRs it linked', async () => {
    await send(...scenario());
    expect(await issue(90)).toMatchObject({ usd: 7, whole: 7, windows: 0, partial: false });
    expect(await issue(409)).not.toMatchObject({ whole: 7 }); // PR 416 was linked by s-whole, and none of s-whole's spend went to it
  });

  it('a session with two PRs splits at each PR\'s opening; what comes after the last one is not on an issue', async () => {
    await send(...scenario());
    expect(await issue(409)).toMatchObject({ usd: 3, whole: 0, windows: 3 }); // $2 before PR 416 opened, and $1 in the very second it opened
    expect(await issue(412)).toMatchObject({ usd: 3, windows: 3 }); // between PR 416's opening and PR 418's
    expect((await budget()).notOnIssue.usd).toBeCloseTo(5 + 4 + 6, 9); // s-long's last $5, s-none's $4, and s-bare's $6 before a PR that closes no issue
  });

  it('every dollar lands exactly once: the issues and "not on an issue" add up to the project\'s total, and another project\'s spend is in neither', async () => {
    await send(...scenario());
    const b = await budget();
    const issues = (b.issues as IssueCost[]).reduce((t, i) => t + i.usd, 0);
    close(issues + b.notOnIssue.usd, TOTAL);
    expect((b.issues as IssueCost[]).map((i) => [i.number, i.usd]).sort((a, c) => a[0]! - c[0]!)).toEqual([[90, 7], [409, 3], [412, 3]]);
    close((await budget('billing')).notOnIssue.usd, 0);
    expect((await budget('billing')).issues).toEqual([expect.objectContaining({ number: 90, usd: 100 })]); // its own #90, apart from mobile-app's
  });

  it('spend with no PR lands on "not on an issue"', async () => {
    await send(start('s-1', 'main'), spend('s-1', T0, 4));
    expect(await budget()).toMatchObject({ issues: [], notOnIssue: { usd: 4, partial: false } });
  });

  it('"not on an issue" is this month\'s; an issue\'s cost has no month to cut it by', async () => {
    await send(start('s-1', 'main', Date.parse('2026-10-20T10:00:00Z')), spend('s-1', Date.parse('2026-10-20T10:00:00Z'), 9), spend('s-1', T0, 4),
      start('s-2', 'fix/90-retry', Date.parse('2026-10-15T10:00:00Z')), spend('s-2', Date.parse('2026-10-15T10:00:00Z'), 1), spend('s-2', T0, 2));
    const b = await budget();
    expect([b.month, b.notOnIssue.usd]).toEqual(['2026-11', 4]);
    expect(usd(await issue(90))).toBe(3);
  });

  it('in a session with PRs too, "not on an issue" is this month\'s: last month\'s spend before a PR that closes no issue is in no month figure', async () => {
    const oct = Date.parse('2026-10-19T10:00:00Z');
    await send(start('s-1', 'dev', oct), spend('s-1', oct, 9), link('s-1', Date.parse('2026-10-20T10:00:00Z'), 420), spend('s-1', T0, 4),
      read(T0 + MIN, [pr(420, { created_at: Date.parse('2026-10-20T10:00:00Z') })]));
    expect((await budget()).notOnIssue.usd).toBe(4); // the $9 is before PR 420, which closes no issue: on no issue, and in October
  });

  it('the month is the viewer\'s: the second after midnight in Rome is November there and October in UTC', async () => {
    const at = Date.parse('2026-10-31T23:00:00Z'); // 00:00:00 on 1 November in Rome (UTC+1 once clocks went back)
    await send(start('s-1', 'main', at), spend('s-1', at, 4));
    expect([(await budget('mobile-app', 'Europe/Rome')).notOnIssue.usd, (await budget('mobile-app', 'UTC')).notOnIssue.usd]).toEqual([4, 0]);
  });

  it('the order the events arrive in changes nothing: the PR\'s opening may be read before or after the session links it', async () => {
    for (const e of scenario().reverse()) await send(e); // a batch is written in ts order, so one event a batch: the read first, the starts last
    expect([usd(await issue(409)), usd(await issue(412)), usd(await issue(90))]).toEqual([3, 3, 7]);
  });

  it('a PR the read gave no opening time is cut where the session first linked it', async () => {
    await send(start('s-1', 'dev'), spend('s-1', T0 + MIN, 2), link('s-1', T0 + 10 * MIN, 416), spend('s-1', T0 + 12 * MIN, 3), read(T0 + 15 * MIN, [pr(416, { issue: 409 })]));
    expect(usd(await issue(409))).toBe(2);
    expect((await budget()).notOnIssue.usd).toBe(3);
  });

  it('a request on a model pricing.json lacks adds nothing, and the figure says it is at least that', async () => {
    await send(start('s-1', 'fix/90-retry'), spend('s-1', T0, 2), spend('s-1', T0 + MIN, 5, FABLE9), start('s-2', 'main'), spend('s-2', T0, 5, FABLE9));
    expect(await issue(90)).toMatchObject({ usd: 2, partial: true });
    expect((await budget()).notOnIssue).toEqual({ usd: 0, partial: true });
  });

  it('a request with no price inside a PR\'s window makes that issue\'s figure a floor, and one on no issue makes that a floor too', async () => {
    await send(start('s-1', 'dev'), spend('s-1', T0 + MIN, 2), spend('s-1', T0 + 2 * MIN, 5, FABLE9), link('s-1', T0 + 10 * MIN, 416), spend('s-1', T0 + 12 * MIN, 5, FABLE9),
      read(T0 + 15 * MIN, [pr(416, { created_at: T0 + 10 * MIN, issue: 409 })]));
    expect(await issue(409)).toMatchObject({ usd: 2, partial: true, windows: 2 });
    expect((await budget()).notOnIssue).toEqual({ usd: 0, partial: true });
  });

  it('a project nobody has seen is an empty answer, not an error; a request without a project is refused', async () => {
    expect(await budget('nobody')).toMatchObject({ project: 'nobody', issues: [], milestones: [], notOnIssue: { usd: 0, partial: false } });
    expect((await app.inject({ url: '/api/budget' })).statusCode).toBe(400);
  });
});

describe('the budget: a default per milestone, an override per issue, no default shipped', () => {
  const issues = [{ number: 409, milestone: 'v0.4 Factory' }, { number: 412, milestone: 'v0.4 Factory' }, { number: 90 }];

  it('with no budget set there is none, and no mark however much is spent', async () => {
    await send(start('s-1', 'fix/90-retry'), spend('s-1', T0, 5_000), read(T0 + MIN, [], issues));
    expect(await issue(90)).toMatchObject({ usd: 5_000, budget: null, source: null, mark: null });
    expect((await budget()).milestones).toEqual([{ name: 'v0.4 Factory', budget: null }]);
  });

  it('a milestone\'s default is the budget of every issue in it; an issue in no milestone has none', async () => {
    await send(...scenario(), read(T0 + 40 * MIN, [], issues));
    expect(await put({ project: 'mobile-app', milestone: 'v0.4 Factory', usd: 150 })).toEqual({ status: 200, body: { project: 'mobile-app', milestone: 'v0.4 Factory', budget: 150 } });
    expect(await issue(409)).toMatchObject({ milestone: 'v0.4 Factory', budget: 150, source: 'milestone', mark: null });
    expect(await issue(90)).toMatchObject({ milestone: null, budget: null, milestoneBudget: null, source: null });
    expect((await budget()).milestones).toEqual([{ name: 'v0.4 Factory', budget: 150 }]);
  });

  it('an issue\'s own budget beats its milestone\'s, and clearing it gives the default back', async () => {
    await send(...scenario(), read(T0 + 40 * MIN, [], issues));
    await put({ project: 'mobile-app', milestone: 'v0.4 Factory', usd: 150 });
    expect((await put({ project: 'mobile-app', issue: 409, usd: 4 })).body).toEqual({ project: 'mobile-app', issue: 409, budget: 4 });
    expect(await issue(409)).toMatchObject({ budget: 4, source: 'issue', milestoneBudget: 150 }); // the default is still known, for the sheet to show beside the issue's own
    expect(await issue(412)).toMatchObject({ budget: 150, source: 'milestone', milestoneBudget: 150 });
    await put({ project: 'mobile-app', issue: 409, usd: null });
    expect(await issue(409)).toMatchObject({ budget: 150, source: 'milestone', milestoneBudget: 150 });
    await put({ project: 'mobile-app', milestone: 'v0.4 Factory', usd: null });
    expect(await issue(409)).toMatchObject({ budget: null, source: null, milestoneBudget: null, mark: null });
  });

  it('an issue with an override but no spend is listed, with its budget', async () => {
    await send(start('s-1', 'main'), spend('s-1', T0, 1));
    await put({ project: 'mobile-app', issue: 77, usd: 20 });
    expect(await issue(77)).toMatchObject({ usd: 0, budget: 20, source: 'issue', mark: null, partial: false });
  });

  it('warns at 80% and at 100%, and not a cent before; nothing is stopped', async () => {
    const issues = [7.9, 8, 9.99, 10, 12].map((_, i) => ({ number: 101 + i, milestone: 'm' }));
    await send(...[7.9, 8, 9.99, 10, 12].flatMap((d, i) => [start(`s-${i}`, `fix/${101 + i}-x`), spend(`s-${i}`, T0, d)]), read(T0 + MIN, [], issues));
    await put({ project: 'mobile-app', milestone: 'm', usd: 10 });
    expect(await Promise.all([101, 102, 103, 104, 105].map(async (k) => (await issue(k))!.mark))).toEqual([null, 'at80', 'at80', 'at100', 'at100']);
  });

  it('the milestones listed are those with an open issue and those with a default; a newer issue read replaces the open ones, and a read without one keeps them', async () => {
    await send(start('s-1', 'main'), spend('s-1', T0, 1), read(T0 + MIN, [], [{ number: 1, milestone: 'a' }, { number: 2, milestone: 'b' }]));
    await put({ project: 'mobile-app', milestone: 'old', usd: 5 });
    expect((await budget()).milestones).toEqual([{ name: 'a', budget: null }, { name: 'b', budget: null }, { name: 'old', budget: 5 }]);
    await send(read(T0 + 6 * MIN, [])); // no `issues`: says nothing about them
    expect((await budget()).milestones.map((m: { name: string }) => m.name)).toEqual(['a', 'b', 'old']);
    await send(read(T0 + 11 * MIN, [], [{ number: 2, milestone: 'b' }]));
    await send(read(T0 + 3 * MIN, [], [{ number: 3, milestone: 'late' }])); // an older read arriving late changes nothing
    expect((await budget()).milestones.map((m: { name: string }) => m.name)).toEqual(['b', 'old']);
  });

  it('#32: an issue that closes keeps its milestone, so what it cost is still held to the default; a closed issue with no spend is not listed, and its milestone is not offered', async () => {
    await send(start('s-1', 'fix/409-x'), spend('s-1', T0, 9), read(T0 + MIN, [], [{ number: 409, milestone: 'm' }, { number: 500, milestone: 'm' }, { number: 501, milestone: 'z' }]));
    await put({ project: 'mobile-app', milestone: 'm', usd: 10 });
    await send(read(T0 + 6 * MIN, [], [{ number: 1, milestone: 'n' }])); // 409, 500 and 501 closed
    expect(await issue(409)).toMatchObject({ milestone: 'm', budget: 10, source: 'milestone', mark: 'at80' });
    expect(await issue(500)).toBeUndefined();
    expect((await budget()).milestones).toEqual([{ name: 'm', budget: 10 }, { name: 'n', budget: null }]); // z has only a closed issue and no default
  });

  it('PUT refuses what is not a budget, a project it has not seen, and a write from another site', async () => {
    await send(start('s-1', 'main'), spend('s-1', T0, 1));
    for (const usd of [0, -5, 1_000_001, '12']) expect((await put({ project: 'mobile-app', issue: 409, usd })).status).toBe(400);
    expect((await put({ project: 'mobile-app', issue: 0, usd: 5 })).status).toBe(400);
    expect((await put({ project: 'mobile-app', issue: 1.5, usd: 5 })).status).toBe(400);
    expect((await put({ project: 'mobile-app', milestone: '', usd: 5 })).status).toBe(400);
    expect((await put({ project: 'mobile-app', usd: 5 })).status).toBe(400); // for what?
    expect((await put({ project: 'mobile-app', issue: 409, milestone: 'm', usd: 5 })).status).toBe(400); // for both?
    expect((await put({ project: 'nobody', issue: 409, usd: 5 })).status).toBe(404);
    expect((await put({ project: 'mobile-app', issue: 409, usd: 5 }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await issue(409))).toBeUndefined(); // none of that was saved
  });
});

describe('GET /api/budget: a PR merged before any read saw it open (#63)', () => {
  it('its head names the issue: the window up to its opening is that issue\'s, not "not on an issue"', async () => {
    await send(start('s-1', 'dev'), spend('s-1', T0 + MIN, 2), link('s-1', T0 + 10 * MIN, 48), spend('s-1', T0 + 12 * MIN, 3),
      merged(T0 + 15 * MIN, [{ number: 48, merged_at: T0 + 10 * MIN, head: 'fix/90-deploy-hardening' }]));
    expect(await issue(90)).toMatchObject({ usd: 2, whole: 0, windows: 2 });
    expect((await budget()).notOnIssue.usd).toBe(3); // after the PR: no issue
  });

  it('an issue the read stored wins over the number the head names: the head is read only when the row has none', async () => {
    await send(start('s-1', 'dev'), spend('s-1', T0 + MIN, 2), link('s-1', T0 + 10 * MIN, 48), read(T0 + 11 * MIN, [pr(48, { head: 'fix/90-deploy-hardening', issue: 409 })]),
      merged(T0 + 15 * MIN, [{ number: 48, merged_at: T0 + 12 * MIN, head: 'fix/90-deploy-hardening' }]));
    expect(((await budget()).issues as IssueCost[]).map((i) => [i.number, i.usd])).toEqual([[409, 2]]);
  });

  it('a PR with no issue whose head names none stays on no issue', async () => {
    await send(start('s-1', 'dev'), spend('s-1', T0 + MIN, 2), link('s-1', T0 + 10 * MIN, 57), merged(T0 + 15 * MIN, [{ number: 57, merged_at: T0 + 10 * MIN, head: 'chore/release-0.4.1' }]),
      spend('s-1', T0 + 20 * MIN, 3), link('s-1', T0 + 25 * MIN, 58)); // and a PR no read has given a head
    expect(await budget()).toMatchObject({ issues: [], notOnIssue: { usd: 5 } });
  });
});

describe('GET /api/factory: the issue each PR is for', () => {
  it('names the issue a PR closes, or null', async () => {
    await send(read(T0, [pr(416, { issue: 409 }), pr(420)]));
    const f = (await app.inject({ url: '/api/factory?project=mobile-app' })).json();
    expect(f.prs.map((p: { number: number; issue: number | null }) => [p.number, p.issue]).sort()).toEqual([[416, 409], [420, null]]);
  });
});
