import { beforeEach, describe, expect, it } from 'vitest';
import type { Event } from '@agent-orb/shared';
import { buildApp } from '../src/app.ts';

// v0.4 slice 6 (#32, Factory; PROJECT.md §15): each issue of a milestone, followed from queued to merged on one board. A stage is read from what the agents did (a file written, a findings
// report, a test run on the PR's head, ready(), a merge), never from an agent's name; a session reaches an issue by slice 2's rule (its branch names it, else a PR it linked does). The tests
// send the plugin's events to /ingest and read GET /api/board, so the writer, the reach and the route are held together.
const TOKEN = 'test-token-0123456789';
const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-03T09:00:00Z');
const NOW0 = Date.parse('2026-11-05T12:00:00Z');
const SONNET = 'claude-sonnet-5-5'; // $10 per million output tokens: 100,000 output tokens are $1
const oid = (short: string) => short.padEnd(40, '1'); // a head's commit: the gate matches it by its first characters
const HEAD = oid('a1b2c3d');

type Project = { cwd: string; name: string; git_remote?: string; git_branch?: string };
const MOBILE: Project = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
const OTHER: Project = { cwd: '/Users/a/billing', name: 'billing', git_remote: 'github.com/o/billing' };
let n = 0;
const ev = (session: string, ts: number, kind: string, data: object, extra: object = {}, project: Project = MOBILE): Event =>
  ({ v: 1, id: `00000000-0000-4000-b320-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'local', session_id: session, project, kind, data, ...extra }) as Event;
const start = (session: string, branch: string | undefined, ts = T0, source = 'interactive', project: Project = MOBILE) =>
  ev(session, ts, 'session.start', { model: SONNET, source, claude_version: '2.1.316', plugin_version: '0.4.0' }, {}, { ...project, ...(branch ? { git_branch: branch } : {}) });
/** A file written by the session's main agent at `ts`: the call and its result, which is what files_touched hangs on. */
const write = (session: string, ts: number, project: Project = MOBILE): Event[] => {
  const turn = { turn_id: `t-${session}-${ts}` };
  return [
    ev(session, ts, 'tool.call', { tool_use_id: `tu-${session}-${ts}`, tool: 'Edit', input_size: 10 }, turn, project),
    ev(session, ts, 'tool.result', { tool_use_id: `tu-${session}-${ts}`, success: true, duration_ms: 5, output_size: 2, files_touched: [{ path: 'src/a.ts', mode: 'write' }] }, turn, project),
  ];
};
/** A file only read: an agent that looked and wrote nothing. */
const look = (session: string, ts: number): Event[] => {
  const turn = { turn_id: `t-${session}-${ts}` };
  return [
    ev(session, ts, 'tool.call', { tool_use_id: `tu-${session}-${ts}`, tool: 'Read', input_size: 10 }, turn),
    ev(session, ts, 'tool.result', { tool_use_id: `tu-${session}-${ts}`, success: true, duration_ms: 5, output_size: 2, files_touched: [{ path: 'src/a.ts', mode: 'read' }] }, turn),
  ];
};
const spend = (session: string, ts: number, usd: number) =>
  ev(session, ts, 'turn.step', { model: SONNET, usage: { input: 0, output: Math.round(usd * 100_000), cache_read: 0, cache_creation: 0 }, stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: `t-spend-${session}-${ts}` });
const link = (session: string, ts: number, number: number) => ev(session, ts, 'session.pr', { number });
const FIXED = { id: 'F1', severity: 'major', file: 'src/a.ts', fate: 'fixed' };
const report = (ts: number, ref: { branch: string } | { pr: number }, list: object[] = [FIXED], by = 'rev') => ev(`s-${by}`, ts, 'findings.report', { ...ref, findings: list, dropped: 0 }, { agent_id: by, turn_id: `t-${by}-${ts}` });
const gate = (ts: number, result: 'pass' | 'fail', commit = 'a1b2c3d') => ev('s-gate', ts, 'gate.report', { result, commit }, { agent_id: `g-${ts}`, turn_id: `tg-${ts}` });
const pr = (number: number, over: object = {}) => ({ number, head: `fix/${number}`, head_oid: HEAD, merge_state: 'CLEAN', last_commit_at: T0, checks: [], bots: [], ...over });
const read = (ts: number, prs: object[], issues?: object[], project: Project = MOBILE) => ev('reader', ts, 'project.open_prs', { prs, ...(issues ? { issues } : {}) }, {}, project);
const merged = (ts: number, prs: object[]) => ev('reader', ts, 'project.prs', { prs: prs.map((p) => ({ additions: 1, deletions: 1, ...p })) });

let app: ReturnType<typeof buildApp>;
let NOW = NOW0;
beforeEach(() => {
  NOW = NOW0;
  app = buildApp({ token: TOKEN, now: () => NOW });
});
const send = async (...events: unknown[]) => {
  const flat = events.flat(Infinity) as Event[];
  const r = await app.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events: flat } });
  expect(r.json()).toMatchObject({ accepted: flat.length, rejected: 0 });
};
type Row = {
  number: number; title?: string; milestone: string | null; outside: boolean; stage: string; pr: { number: number; head: string | null; merged: boolean } | null; ready: boolean | null; reason: string | null;
  usd: number; partial: boolean; budget: number | null; mark: 'at80' | 'at100' | null; sessions: { id: string; at: number; background?: true }[]; sessionCount: number;
};
type Board = { project: string; milestone: string | null; month: string; milestones: { name: string; open: number }[]; issues: Row[]; notOnIssue: { usd: number; partial: boolean } };
const board = async (q: Record<string, string> = {}, project = 'mobile-app'): Promise<Board> => (await app.inject({ url: `/api/board?${new URLSearchParams({ project, tz: 'UTC', ...q })}` })).json();
const row = async (number: number, q: Record<string, string> = {}) => (await board(q)).issues.find((i) => i.number === number);
const stageOf = async (number: number) => (await row(number))?.stage;
const M = 'v2.3 Offline';
const issues = (...numbers: number[]) => numbers.map((number) => ({ number, milestone: M }));

describe('GET /api/board: the stage of each issue, from what the agents did', () => {
  it('an issue open on the milestone that no session reached is Queued, with no PR and no sessions', async () => {
    await send(read(NOW0 - MIN, [], issues(417)));
    expect(await row(417)).toMatchObject({ stage: 'queued', pr: null, ready: null, reason: null, sessions: [], sessionCount: 0, milestone: M, outside: false });
  });

  it('one issue at each stage: Queued, Building, Reviewing, Fixing, Gate, Ready, Merged', async () => {
    await send(
      start('s-415', 'fix/415-sync'), write('s-415', T0 + MIN), // Building: a file was written
      start('s-413', 'fix/413-token'), write('s-413', T0 + MIN), report(T0 + 2 * MIN, { branch: 'fix/413-token' }), // Reviewing: a report came after it
      start('s-409', 'fix/409-retry'), write('s-409', T0 + MIN), report(T0 + 2 * MIN, { branch: 'fix/409-retry' }), write('s-409', T0 + 3 * MIN), // Fixing: a file written after the report
      start('s-407', 'fix/407-photos'), write('s-407', T0 + MIN), report(T0 + 2 * MIN, { branch: 'fix/407-photos' }), write('s-407', T0 + 3 * MIN), gate(T0 + 4 * MIN, 'pass', 'c0d1e2f'), // Gate: a test run on the head after the fix
      start('s-412', 'fix/412-queue'), write('s-412', T0 + MIN), report(T0 + 2 * MIN, { branch: 'fix/412-queue' }), gate(T0 + 4 * MIN, 'pass'), // Ready: all four hold
      start('s-403', 'fix/403-banner'), write('s-403', T0 + MIN),
      read(T0, [pr(405, { head: 'fix/403-banner', issue: 403 })]), // PR 405 was open, and closes #403
      read(NOW0 - MIN, [pr(416, { head: 'fix/409-retry', issue: 409, head_oid: oid('e4f5a6b') }), pr(414, { head: 'fix/407-photos', issue: 407, head_oid: oid('c0d1e2f'), merge_state: 'UNSTABLE' }), pr(418, { head: 'fix/412-queue', issue: 412 })], issues(417, 415, 413, 409, 407, 412, 403)),
      merged(NOW0 - 30 * MIN, [{ number: 405, merged_at: T0 + 6 * MIN, head: 'fix/403-banner' }]),
    );
    const b = await board();
    expect(Object.fromEntries(b.issues.map((i) => [i.number, i.stage]))).toEqual({ 417: 'queued', 415: 'building', 413: 'reviewing', 409: 'fixing', 407: 'gate', 412: 'ready', 403: 'merged' });
    expect(b.issues.find((i) => i.number === 412)).toMatchObject({ ready: true, reason: null, pr: { number: 418, head: 'fix/412-queue', merged: false } });
    expect(b.issues.find((i) => i.number === 407)).toMatchObject({ ready: false, reason: 'UNSTABLE: a check is not passing', pr: { number: 414 } }); // slice 1's reason, as it is
    expect(b.issues.find((i) => i.number === 409)).toMatchObject({ ready: false, reason: 'No test run on e4f5a6b', pr: { number: 416 } });
    expect(b.issues.find((i) => i.number === 403)).toMatchObject({ ready: null, pr: { number: 405, merged: true } });
  });

  it('Fixing only after a reviewer: writes alone are Building however many, a report with no write after it is Reviewing, a write after the report is Fixing', async () => {
    await send(start('s-409', 'fix/409-retry'), write('s-409', T0 + MIN), write('s-409', T0 + 2 * MIN), write('s-409', T0 + 3 * MIN), read(NOW0 - MIN, [], issues(409)));
    expect(await stageOf(409)).toBe('building');
    await send(report(T0 + 4 * MIN, { branch: 'fix/409-retry' }));
    expect(await stageOf(409)).toBe('reviewing');
    await send(write('s-409', T0 + 5 * MIN));
    expect(await stageOf(409)).toBe('fixing');
    await send(report(T0 + 6 * MIN, { branch: 'fix/409-retry' })); // the fixer's own report, or a re-review: the latest report is after the last write again
    expect(await stageOf(409)).toBe('reviewing');
  });

  it('a read is not a write: an agent that only looked at files has not started Building, and one that looked after the report is not Fixing', async () => {
    await send(start('s-409', 'fix/409-retry'), look('s-409', T0 + MIN), read(NOW0 - MIN, [], issues(409)));
    expect(await row(409)).toMatchObject({ stage: 'queued', sessionCount: 1 }); // a session reached it but wrote nothing: nothing is built, and the session still shows
    await send(write('s-409', T0 + 2 * MIN), report(T0 + 3 * MIN, { branch: 'fix/409-retry' }), look('s-409', T0 + 4 * MIN));
    expect(await stageOf(409)).toBe('reviewing');
  });

  it('a findings report on another branch, or another PR, is not this issue\'s review', async () => {
    await send(start('s-409', 'fix/409-retry'), write('s-409', T0 + MIN), report(T0 + 2 * MIN, { branch: 'fix/other-work' }), report(T0 + 2 * MIN, { pr: 999 }), read(NOW0 - MIN, [pr(416, { head: 'fix/409-retry', issue: 409 })], issues(409)));
    expect(await stageOf(409)).toBe('building');
    await send(report(T0 + 3 * MIN, { pr: 416 })); // the PR's number, not its branch: the fence named it
    expect(await stageOf(409)).toBe('reviewing');
  });

  it('a report on the PR\'s head branch is the issue\'s review too, as slice 1 reads it for the PR', async () => {
    await send(start('s-x', 'main'), write('s-x', T0 + MIN), link('s-x', T0 + 5 * MIN, 416), report(T0 + 6 * MIN, { branch: 'fix/409-retry' }), read(NOW0 - MIN, [pr(416, { head: 'fix/409-retry', issue: 409, created_at: T0 + 5 * MIN })], issues(409)));
    expect(await stageOf(409)).toBe('reviewing');
  });

  it('Gate is a test run on the PR\'s head that came after the last write and the last report: an earlier run, a run on another commit, or a failed head does not make it', async () => {
    const fixing = [start('s-409', 'fix/409-retry'), write('s-409', T0 + MIN), report(T0 + 2 * MIN, { branch: 'fix/409-retry' }), write('s-409', T0 + 3 * MIN), read(NOW0 - MIN, [pr(416, { head: 'fix/409-retry', issue: 409, merge_state: 'UNSTABLE' })], issues(409))];
    await send(...fixing, gate(T0 + MIN, 'pass')); // the tests ran before the fix
    expect(await stageOf(409)).toBe('fixing');
    await send(gate(T0 + 4 * MIN, 'pass', 'deadbee')); // after it, but on another commit
    expect(await stageOf(409)).toBe('fixing');
    await send(gate(T0 + 5 * MIN, 'pass', 'a1b2c3d'));
    expect(await stageOf(409)).toBe('gate'); // the test run on this head, after the fix
    await send(write('s-409', T0 + 6 * MIN)); // and a file written after it takes the stage back
    expect(await stageOf(409)).toBe('fixing');
  });

  it('a failed test run on the head is still a test run: Gate, and readiness says why it is not ready', async () => {
    await send(start('s-409', 'fix/409-retry'), write('s-409', T0 + MIN), report(T0 + 2 * MIN, { branch: 'fix/409-retry' }), gate(T0 + 3 * MIN, 'fail'), read(NOW0 - MIN, [pr(416, { head: 'fix/409-retry', issue: 409 })], issues(409)));
    expect(await row(409)).toMatchObject({ stage: 'gate', ready: false, reason: 'Test run failed on a1b2c3d' });
  });

  it('Ready is ready(): the stage follows the four conditions, and a finding that opens again takes it back', async () => {
    await send(start('s-412', 'fix/412-queue'), write('s-412', T0 + MIN), report(T0 + 2 * MIN, { branch: 'fix/412-queue' }), gate(T0 + 3 * MIN, 'pass'), read(NOW0 - MIN, [pr(418, { head: 'fix/412-queue', issue: 412 })], issues(412)));
    expect(await row(412)).toMatchObject({ stage: 'ready', ready: true });
    await send(report(T0 + 4 * MIN, { branch: 'fix/412-queue' }, [{ ...FIXED, fate: 'open' }]));
    expect(await row(412)).toMatchObject({ stage: 'reviewing', ready: false, reason: '1 finding open: 1 major' });
  });

  it('data too old to trust is never Ready: the stage falls back to what the events say', async () => {
    await send(start('s-412', 'fix/412-queue'), write('s-412', T0 + MIN), report(T0 + 2 * MIN, { branch: 'fix/412-queue' }), gate(T0 + 3 * MIN, 'pass'), read(NOW0 - MIN, [pr(418, { head: 'fix/412-queue', issue: 412 })], issues(412)));
    NOW = NOW0 + 20 * MIN;
    expect(await row(412)).toMatchObject({ stage: 'gate', ready: false, reason: expect.stringContaining('Was ready when GitHub was last read') });
  });

  it('reached only through a PR\'s Closes #N: a session on no issue branch that linked the PR is on the issue, and only the writes before the PR opened are its', async () => {
    await send(
      start('s-long', 'dev'), write('s-long', T0 + MIN), link('s-long', T0 + 10 * MIN, 416), write('s-long', T0 + 12 * MIN), link('s-long', T0 + 20 * MIN, 418),
      read(NOW0 - MIN, [pr(416, { head: 'feat/token', issue: 409, created_at: T0 + 10 * MIN }), pr(418, { head: 'feat/queue', issue: 412, created_at: T0 + 20 * MIN })], issues(409, 412)),
    );
    expect(await row(409)).toMatchObject({ stage: 'building', sessionCount: 1, sessions: [{ id: 's-long' }] });
    expect(await row(412)).toMatchObject({ stage: 'building', sessionCount: 1 }); // the write at +12 is in PR 418's window
    // a review of #409 at +5 min, and the write at +12 is #412's: it is not a fix of #409
    await send(report(T0 + 5 * MIN, { pr: 416 }));
    expect(await stageOf(409)).toBe('reviewing');
  });

  it('slice 2\'s rule, whole: a session on an issue branch reaches that issue alone, whatever PR it linked', async () => {
    await send(start('s-whole', 'fix/90-retry'), write('s-whole', T0 + MIN), link('s-whole', T0 + 15 * MIN, 416), read(NOW0 - MIN, [pr(416, { issue: 409, created_at: T0 + 10 * MIN })], [...issues(409), { number: 90, milestone: M }]));
    expect(await row(409)).toMatchObject({ stage: 'queued', sessionCount: 0 });
    expect(await row(90)).toMatchObject({ stage: 'building', sessionCount: 1 });
  });

  it('a session of another project, on a branch with the same number, is not on this project\'s issue', async () => {
    await send(start('s-other', 'fix/417-x', T0, 'interactive', OTHER), write('s-other', T0 + MIN, OTHER), read(NOW0 - MIN, [], issues(417)));
    expect(await row(417)).toMatchObject({ stage: 'queued', sessionCount: 0 });
    expect(await board({}, 'billing')).toMatchObject({ project: 'billing', issues: [{ number: 417, outside: true, stage: 'building' }] }); // its own: in flight there, outside any milestone
  });
});

describe('GET /api/board: Merged, and what the store knows of it', () => {
  it('the store knows a merge from the merged list the plugin reads (project.prs): the issue is Merged, with no readiness to give', async () => {
    await send(start('s-403', 'fix/403-banner'), write('s-403', T0 + MIN), read(T0 + 5 * MIN, [pr(405, { head: 'fix/403-banner', issue: 403 })], issues(403)));
    expect(await row(403)).toMatchObject({ stage: 'building', pr: { number: 405, merged: false } });
    await send(read(T0 + 10 * MIN, [], issues(403)), merged(T0 + 11 * MIN, [{ number: 405, merged_at: T0 + 9 * MIN, head: 'fix/403-banner' }]));
    expect(await row(403)).toMatchObject({ stage: 'merged', ready: null, reason: null, pr: { number: 405, head: 'fix/403-banner', merged: true } });
  });

  it('a PR merged before any read saw it open has no issue on its row: its branch names the issue, as the plugin reads a branch first', async () => {
    await send(start('s-403', 'fix/403-banner'), write('s-403', T0 + MIN), read(NOW0 - MIN, [], issues(403)), merged(NOW0 - 5 * MIN, [{ number: 405, merged_at: T0 + 9 * MIN, head: 'fix/403-banner' }]));
    expect(await row(403)).toMatchObject({ stage: 'merged', pr: { number: 405, head: 'fix/403-banner', merged: true } });
    await send(merged(NOW0 - 4 * MIN, [{ number: 407, merged_at: T0 + 9 * MIN, head: 'chore/release-notes' }])); // a branch that names no issue maps to none
    expect((await board()).issues.map((i) => i.number)).toEqual([403]);
  });

  it('a PR that left the open list and is not known merged is not Merged, and has no Gate or Ready: it may have been closed', async () => {
    NOW = T0 + 5 * MIN;
    await send(start('s-409', 'fix/409-retry'), write('s-409', T0 + MIN), report(T0 + 2 * MIN, { branch: 'fix/409-retry' }), gate(T0 + 3 * MIN, 'pass'),
      read(T0 + 4 * MIN, [pr(416, { head: 'fix/409-retry', issue: 409 })], issues(409)));
    expect(await stageOf(409)).toBe('ready');
    NOW = T0 + 10 * MIN;
    await send(read(T0 + 9 * MIN, [], issues(409)));
    expect(await row(409)).toMatchObject({ stage: 'reviewing', pr: null, ready: null });
  });

  it('a newer open PR for the issue than the merged one means the issue is in flight again', async () => {
    await send(start('s-403', 'fix/403-banner'), write('s-403', T0 + MIN), read(T0 + 5 * MIN, [pr(405, { issue: 403 })], issues(403)),
      read(T0 + 10 * MIN, [pr(430, { head: 'fix/403-again', issue: 403 })], issues(403)), merged(T0 + 11 * MIN, [{ number: 405, merged_at: T0 + 9 * MIN }]));
    expect(await row(403)).toMatchObject({ stage: 'building', pr: { number: 430, merged: false } });
  });
});

describe('GET /api/board: which issues, and the milestone', () => {
  it('the chosen milestone\'s open issues, and an issue outside it only while a session reached it in the last 7 days and its PR is not merged', async () => {
    const in7 = NOW0 - 2 * DAY;
    const old = NOW0 - 8 * DAY;
    await send(
      start('s-398', 'fix/398-feed', in7), write('s-398', in7 + MIN), // open on v2.2.1, reached this week: in flight outside
      start('s-399', 'fix/399-lint', in7), write('s-399', in7 + MIN), // not open at all (closed), reached this week: in flight outside
      start('s-397', 'fix/397-old', old), write('s-397', old + MIN), // open on v2.2.1, reached 8 days ago: not shown
      start('s-396', 'fix/396-done', in7), write('s-396', in7 + MIN), // reached this week, but its PR is merged: left
      read(in7, [pr(420, { head: 'fix/396-done', issue: 396 })]),
      read(NOW0 - MIN, [], [...issues(417), { number: 398, milestone: 'v2.2.1' }, { number: 397, milestone: 'v2.2.1' }, { number: 395, milestone: 'v2.2.1' }]),
      merged(NOW0 - 5 * MIN, [{ number: 420, merged_at: in7 + 5 * MIN }]),
    );
    const b = await board({ milestone: M });
    expect(b.issues.map((i) => [i.number, i.outside, i.milestone, i.stage]).toSorted((a, c) => Number(a[0]) - Number(c[0]))).toEqual([
      [398, true, 'v2.2.1', 'building'], [399, true, null, 'building'], [417, false, M, 'queued'],
    ]);
  });

  it('an issue outside the milestone that merged leaves the board; one whose session was last seen 7 days ago and a bit leaves too', async () => {
    const at = NOW0 - 7 * DAY - MIN;
    await send(start('s-398', 'fix/398-feed', at), write('s-398', at + 1000), read(NOW0 - MIN, [], issues(417)));
    expect((await board({ milestone: M })).issues.map((i) => i.number)).toEqual([417]);
    await send(write('s-398', NOW0 - 3 * DAY)); // touched again, 3 days ago
    expect((await board({ milestone: M })).issues.map((i) => i.number).toSorted()).toEqual([398, 417]);
  });

  it('the picker lists the milestones of the open issues with their counts; the default is the one most open issues a session touched this week are in', async () => {
    await send(
      start('s-1', 'fix/1-a', NOW0 - DAY), write('s-1', NOW0 - DAY + MIN), start('s-2', 'fix/2-b', NOW0 - DAY), write('s-2', NOW0 - DAY + MIN), // two issues of 'b' touched
      start('s-3', 'fix/3-c', NOW0 - DAY), write('s-3', NOW0 - DAY + MIN), // one of 'c'
      read(NOW0 - MIN, [], [{ number: 1, milestone: 'b' }, { number: 2, milestone: 'b' }, { number: 4, milestone: 'b' }, { number: 3, milestone: 'c' }, { number: 5, milestone: 'c' }, { number: 6, milestone: 'c' }, { number: 7, milestone: 'c' }, { number: 8 }]),
    );
    const b = await board();
    expect(b.milestones).toEqual([{ name: 'b', open: 3 }, { name: 'c', open: 4 }]); // an issue with no milestone is in no picker
    expect(b.milestone).toBe('b'); // touched: b has 2 issues, c has 1, though c has more open
    expect((await board({ milestone: 'c' })).milestone).toBe('c');
    expect((await board({ milestone: 'c' })).issues.map((i) => i.number).toSorted()).toEqual([1, 2, 3, 5, 6, 7]); // c's four open issues, and #1 and #2 in flight outside it
  });

  it('with no session touching anything this week the default is the milestone with the most open issues, then the first by name', async () => {
    await send(read(NOW0 - MIN, [], [{ number: 1, milestone: 'b' }, { number: 2, milestone: 'c' }, { number: 3, milestone: 'c' }, { number: 4, milestone: 'a' }, { number: 5, milestone: 'a' }]));
    expect((await board()).milestone).toBe('a');
    await send(read(NOW0 - MIN + 1000, [], [{ number: 1, milestone: 'b' }, { number: 2, milestone: 'c' }, { number: 3, milestone: 'c' }]));
    expect((await board()).milestone).toBe('c');
  });

  it('a project with no milestone on any open issue has none chosen, and shows only what is in flight', async () => {
    await send(start('s-5', 'fix/5-x', NOW0 - DAY), write('s-5', NOW0 - DAY + MIN), read(NOW0 - MIN, [], [{ number: 5 }, { number: 6 }]));
    expect(await board()).toMatchObject({ milestone: null, milestones: [], issues: [{ number: 5, outside: true, milestone: null, stage: 'building' }] });
  });

  it('a project nobody has seen is an empty answer, not an error; a request without a project, or with a time zone that does not exist, is refused', async () => {
    expect(await board({}, 'nobody')).toMatchObject({ project: 'nobody', milestone: null, milestones: [], issues: [], notOnIssue: { usd: 0, partial: false } });
    expect((await app.inject({ url: '/api/board' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/board?project=mobile-app&tz=Mars/Base' })).statusCode).toBe(400);
  });
});

describe('GET /api/board: what a row carries', () => {
  it('titles are on the row when the read sent them (Content on full) and absent when it did not; the next read replaces them', async () => {
    await send(read(NOW0 - 2 * MIN, [], [{ number: 417, milestone: M, title: 'Clear the cache on sign-out' }, { number: 419, milestone: M }]));
    expect((await row(417))?.title).toBe('Clear the cache on sign-out');
    expect(await row(419)).not.toHaveProperty('title');
    await send(read(NOW0 - MIN, [], issues(417, 419))); // Content was turned off: this read has none
    expect(await row(417)).not.toHaveProperty('title');
  });

  it('cost is slice 2\'s: the issue\'s spend against its budget, with the mark, and "not on an issue" is the project\'s', async () => {
    await send(start('s-415', 'fix/415-sync'), spend('s-415', T0 + MIN, 6), write('s-415', T0 + 2 * MIN), start('s-none', 'main'), spend('s-none', NOW0 - DAY, 4), read(NOW0 - MIN, [], issues(415, 417)));
    await app.inject({ method: 'PUT', url: '/api/budget', payload: { project: 'mobile-app', milestone: M, usd: 7 } });
    const b = await board();
    expect(b.issues.find((i) => i.number === 415)).toMatchObject({ usd: 6, partial: false, budget: 7, mark: 'at80' });
    expect(b.issues.find((i) => i.number === 417)).toMatchObject({ usd: 0, budget: 7, mark: null });
    expect(b.notOnIssue).toEqual({ usd: 4, partial: false });
    const budget = (await app.inject({ url: '/api/budget?project=mobile-app&tz=UTC' })).json();
    expect(b.month).toBe(budget.month);
    expect(b.notOnIssue).toEqual(budget.notOnIssue);
  });

  it('the sessions are the ones that reached it, newest first, with background ones marked, and at most 12 listed of the count', async () => {
    const sessions = Array.from({ length: 14 }, (_, i) => [start(`s-${String(i).padStart(2, '0')}`, 'fix/415-sync', T0 + i * MIN, i === 3 ? 'headless' : 'interactive'), write(`s-${String(i).padStart(2, '0')}`, T0 + i * MIN + 1000)]);
    await send(...sessions, read(NOW0 - MIN, [], issues(415)));
    const r = (await row(415))!;
    expect(r.sessionCount).toBe(14);
    expect(r.sessions).toHaveLength(12);
    expect(r.sessions.map((s) => s.id).slice(0, 3)).toEqual(['s-13', 's-12', 's-11']);
    expect(r.sessions.find((s) => s.id === 's-03')).toMatchObject({ background: true }); // headless: the plugin was not interactive
    expect(r.sessions.find((s) => s.id === 's-04')).not.toHaveProperty('background');
  });

  it('active issues come first by their latest session, then the queued, then the merged', async () => {
    await send(start('s-1', 'fix/1-a', T0), write('s-1', T0 + MIN), start('s-2', 'fix/2-b', T0 + 5 * MIN), write('s-2', T0 + 6 * MIN), start('s-4', 'fix/4-d', T0), write('s-4', T0 + MIN),
      read(T0, [pr(40, { issue: 4 })]), read(NOW0 - MIN, [], [{ number: 1, milestone: 'm' }, { number: 2, milestone: 'm' }, { number: 3, milestone: 'm' }, { number: 4, milestone: 'm' }, { number: 5, milestone: 'm' }]),
      merged(NOW0 - 5 * MIN, [{ number: 40, merged_at: T0 + 2 * MIN }]));
    expect((await board({ milestone: 'm' })).issues.map((i) => i.number)).toEqual([2, 1, 5, 3, 4]);
  });
});
