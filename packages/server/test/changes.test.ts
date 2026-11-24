import { beforeEach, describe, expect, it } from 'vitest';
import type { Event } from '@agent-orb/shared';
import { buildApp } from '../src/app.ts';
import { openStore } from '../src/store/store.ts';

// v0.5 slice 4 (#108, Follow; the plan is #64): GET /api/changes?since=<ms>, what changed across the projects Home shows since a time, newest first, at most 50, worked out on read from times already stored.
// The tests send the plugin's events to /ingest and read the route. For each kind the same change is asked for twice: from just before its time (listed) and from its time (not: a mark is not a change).
const TOKEN = 'test-token-0123456789';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const SINCE = NOW - 2 * HOUR; // the owner's mark in most cases
const BEFORE = SINCE - 30 * MIN; // what happened before it
const AFTER = SINCE + 30 * MIN;
const SONNET = 'claude-sonnet-5-5';
const HEAD = 'a1b2c3d'.padEnd(40, '1');
const M = 'v2.3 Offline';

type Project = { cwd: string; name: string; git_remote?: string; git_branch?: string };
const MOBILE: Project = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
const FIELD: Project = { cwd: '/Users/a/field-notes', name: 'field-notes', git_remote: 'github.com/o/field-notes' };
const BILLING: Project = { cwd: '/Users/a/billing-db', name: 'billing-db', git_remote: 'github.com/o/billing-db' };
let n = 0;
const ev = (session: string, ts: number, kind: string, data: object, extra: object = {}, project: Project = MOBILE): Event =>
  ({ v: 1, id: `00000000-0000-4000-b108-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'local', session_id: session, project, kind, data, ...extra }) as Event;
const start = (session: string, branch: string | undefined, ts: number, project: Project = MOBILE) =>
  ev(session, ts, 'session.start', { model: SONNET, source: 'interactive', claude_version: '2.1.316', plugin_version: '0.4.6' }, {}, { ...project, ...(branch ? { git_branch: branch } : {}) });
/** A file written by the session's main agent at `ts`. */
const write = (session: string, ts: number, project: Project = MOBILE): Event[] => {
  const turn = { turn_id: `t-${session}-${ts}` };
  const id = `tu-${session}-${ts}`;
  return [
    ev(session, ts, 'tool.call', { tool_use_id: id, tool: 'Edit', input_size: 10 }, turn, project),
    ev(session, ts, 'tool.result', { tool_use_id: id, success: true, duration_ms: 5, output_size: 2, files_touched: [{ path: 'src/a.ts', mode: 'write' }] }, turn, project),
  ];
};
const link = (session: string, ts: number, number: number) => ev(session, ts, 'session.pr', { number });
const FIXED = { id: 'F1', severity: 'major', file: 'src/a.ts', fate: 'fixed' };
const OPEN = { id: 'F2', severity: 'minor', file: 'src/b.ts', fate: 'open' };
/** A findings report by a reviewer: an agent of a session of its own that wrote no file. */
const report = (ts: number, branch: string, list: object[] = [FIXED], by = 'rev') => ev(`s-${by}`, ts, 'findings.report', { branch, findings: list, dropped: 0 }, { agent_id: by, turn_id: `t-${by}-${ts}` });
const gate = (ts: number, result: 'pass' | 'fail' = 'pass', commit = 'a1b2c3d') => ev('s-gate', ts, 'gate.report', { result, commit }, { agent_id: `g-${ts}`, turn_id: `tg-${ts}` });
const pr = (number: number, over: object = {}) => ({ number, head: `fix/${number}`, head_oid: HEAD, merge_state: 'CLEAN', last_commit_at: BEFORE - DAY, checks: [], bots: [], ...over });
const read = (ts: number, prs: object[], issues?: object[], project: Project = MOBILE) => ev(`reader-${project.name}`, ts, 'project.open_prs', { prs, ...(issues ? { issues } : {}) }, {}, project);
const merged = (ts: number, prs: object[]) => ev('reader', ts, 'project.prs', { prs: prs.map((p) => ({ additions: 1, deletions: 1, ...p })) });
const issues = (...numbers: number[]) => numbers.map((number) => ({ number, milestone: M, title: `Issue ${number}` }));

let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  app = buildApp({ token: TOKEN, store: openStore(':memory:'), now: () => NOW });
});
const send = async (...events: unknown[]) => {
  const flat = events.flat(Infinity) as Event[];
  const r = await app.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events: flat } });
  expect(r.json()).toMatchObject({ accepted: flat.length, rejected: 0 });
};
type Change = { at: number; kind: string; project: string; issue: number; title?: string; pr?: number; open?: number; sha?: string; branch?: string };
const changes = async (since: number): Promise<Change[]> => {
  const r = await app.inject({ url: `/api/changes?since=${since}` });
  expect(r.statusCode).toBe(200);
  return r.json().changes;
};
/** The changes of one kind, as the owner sees them from `since`. */
const of = async (kind: string, since = SINCE) => (await changes(since)).filter((c) => c.kind === kind);
/** The change is listed from just before its time and not from its time itself: strictly after the mark. */
const edge = async (kind: string, at: number) => {
  expect((await of(kind, at - 1)).map((c) => c.at)).toContain(at);
  expect((await of(kind, at)).map((c) => c.at)).not.toContain(at);
};

describe('GET /api/changes: one case per kind', () => {
  it('a PR opened is listed from its created_at, with its issue, its title and its number', async () => {
    await send(read(NOW - MIN, [pr(416, { head: 'fix/409-retry', issue: 409, created_at: AFTER })], issues(409)));
    expect(await of('opened')).toEqual([{ at: AFTER, kind: 'opened', project: 'mobile-app', issue: 409, title: 'Issue 409', pr: 416 }]);
    await edge('opened', AFTER);
    expect(await of('opened', AFTER + 1)).toEqual([]);
  });

  it('a PR no read saw open (no created_at) is opened at the earliest time a session linked it', async () => {
    await send(start('s-a', undefined, BEFORE - HOUR), start('s-b', undefined, BEFORE - HOUR), link('s-b', AFTER + 5 * MIN, 416), link('s-a', AFTER, 416),
      read(NOW - MIN, [pr(416, { head: 'fix/409-retry', issue: 409 })], issues(409)));
    expect((await of('opened')).map((c) => [c.at, c.pr])).toEqual([[AFTER, 416]]);
    expect(await of('opened', AFTER)).toEqual([]);
  });

  it('a PR merged is listed from merged_at', async () => {
    await send(read(NOW - 10 * MIN, [], issues(403)), merged(NOW - 3 * MIN, [{ number: 405, merged_at: AFTER, head: 'fix/403-banner' }]));
    expect(await of('merged')).toEqual([{ at: AFTER, kind: 'merged', project: 'mobile-app', issue: 403, title: 'Issue 403', pr: 405 }]);
    await edge('merged', AFTER);
  });

  it('a reviewer\'s first round is a review with its open findings, and the next round of the same ref is a review again', async () => {
    await send(start('s-409', 'fix/409-retry', BEFORE - DAY), read(NOW - MIN, [], issues(409)),
      report(BEFORE, 'fix/409-retry', [OPEN]), report(AFTER, 'fix/409-retry', [OPEN, { ...OPEN, id: 'F3' }]), report(AFTER + 10 * MIN, 'fix/409-retry', [FIXED, { ...OPEN, id: 'F4' }])); // a re-review: it verifies F1 and finds F4, a new id
    expect((await changes(SINCE)).filter((c) => c.kind.startsWith('review'))).toEqual([
      { at: AFTER + 10 * MIN, kind: 'reviewed-again', project: 'mobile-app', issue: 409, title: 'Issue 409', open: 1 },
      { at: AFTER, kind: 'reviewed-again', project: 'mobile-app', issue: 409, title: 'Issue 409', open: 2 },
    ]);
    // from before the first round, the first is a review and not "again"
    expect((await changes(BEFORE - 1)).filter((c) => c.kind.startsWith('review')).map((c) => [c.at, c.kind, c.open])).toEqual([
      [AFTER + 10 * MIN, 'reviewed-again', 1], [AFTER, 'reviewed-again', 2], [BEFORE, 'reviewed', 1],
    ]);
    await edge('reviewed-again', AFTER);
  });

  it('a fixer\'s report is not a review', async () => {
    await send(start('s-409', 'fix/409-retry', BEFORE - DAY), read(NOW - MIN, [], issues(409)), report(BEFORE, 'fix/409-retry'),
      start('s-fix', undefined, BEFORE), write('s-fix', BEFORE + MIN), ev('s-fix', AFTER, 'findings.report', { branch: 'fix/409-retry', findings: [FIXED], dropped: 0 }, { agent_id: 'main', turn_id: 't-s-fix-' + (BEFORE + MIN) }));
    expect(await of('reviewed')).toEqual([]);
    expect(await of('reviewed-again')).toEqual([]);
  });

  it('the gate reached: a passing test run on the open PR\'s head after its last write and review, with the commit', async () => {
    await send(start('s-409', 'fix/409-retry', BEFORE - DAY), write('s-409', BEFORE), report(BEFORE + MIN, 'fix/409-retry', [OPEN]), gate(AFTER),
      read(NOW - MIN, [pr(416, { head: 'fix/409-retry', issue: 409 })], issues(409)));
    expect(await of('gate')).toEqual([{ at: AFTER, kind: 'gate', project: 'mobile-app', issue: 409, title: 'Issue 409', pr: 416, sha: 'a1b2c3d' }]);
    await edge('gate', AFTER);
  });

  it('a gate older than the last write, or than the review, or one that failed, or one on another commit is not reaching it', async () => {
    const base = [read(NOW - MIN, [pr(416, { head: 'fix/409-retry', issue: 409 })], issues(409))];
    await send(...base, start('s-409', 'fix/409-retry', BEFORE - DAY), gate(AFTER), write('s-409', AFTER + MIN)); // tested, then changed
    expect(await of('gate')).toEqual([]);
    await send(report(AFTER + 5 * MIN, 'fix/409-retry', [OPEN]), write('s-409', BEFORE)); // and reviewed after the test run
    expect(await of('gate')).toEqual([]);
    await send(gate(AFTER + 6 * MIN, 'fail'));
    expect(await of('gate')).toEqual([]);
    await send(gate(AFTER + 7 * MIN, 'pass', 'deadbee'));
    expect(await of('gate')).toEqual([]);
    await send(gate(AFTER + 8 * MIN, 'pass'));
    expect((await of('gate')).map((c) => c.at)).toEqual([AFTER + 8 * MIN]);
  });

  const READY = [start('s-412', 'fix/412-queue', BEFORE - DAY), write('s-412', BEFORE), report(BEFORE + MIN, 'fix/412-queue'), gate(AFTER)];
  it('ready is listed only when the issue is ready now, at the latest of its gate and its findings report', async () => {
    await send(...READY, read(NOW - MIN, [pr(418, { head: 'fix/412-queue', issue: 412 })], issues(412)));
    expect(await of('ready')).toEqual([{ at: AFTER, kind: 'ready', project: 'mobile-app', issue: 412, title: 'Issue 412', pr: 418 }]);
    await edge('ready', AFTER);
    await send(report(AFTER + 20 * MIN, 'fix/412-queue', [{ ...OPEN, fate: 'fixed' }])); // a report (naming a new id: a review) after the test run: ready from then, and the gate is no longer the last word
    expect((await of('ready')).map((c) => c.at)).toEqual([AFTER + 20 * MIN]);
    expect(await of('gate')).toEqual([]);
  });

  it('an issue that is not ready now is not listed as ready: a merge state that is not CLEAN, a finding open, a read too old to trust', async () => {
    await send(...READY, read(NOW - MIN, [pr(418, { head: 'fix/412-queue', issue: 412, merge_state: 'BLOCKED' })], issues(412)));
    expect(await of('ready')).toEqual([]);
    expect((await of('gate')).map((c) => c.issue)).toEqual([412]); // the gate still counts
    await send(read(NOW - 2 * MIN, [pr(418, { head: 'fix/412-queue', issue: 412 })], issues(412)), report(AFTER + MIN, 'fix/412-queue', [OPEN]));
    expect(await of('ready')).toEqual([]);
    await send(report(AFTER + 2 * MIN, 'fix/412-queue'), read(NOW - 11 * MIN, [pr(418, { head: 'fix/412-queue', issue: 412 })], issues(412)));
    expect(await of('ready')).toEqual([]); // ready when GitHub was last read, 11 minutes ago
  });

  it('one PR with a created_at and a session link is opened at its created_at, not at the link', async () => {
    await send(start('s-a', undefined, BEFORE - HOUR), link('s-a', AFTER + 10 * MIN, 416), read(NOW - MIN, [pr(416, { head: 'fix/409-retry', issue: 409, created_at: AFTER })], issues(409)));
    expect((await of('opened')).map((c) => c.at)).toEqual([AFTER]);
  });

  it('a PR the latest read still lists open is not merged, whatever merged_at a later read gave it', async () => {
    await send(read(NOW - MIN, [pr(405, { head: 'fix/403-banner', issue: 403 })], issues(403)), merged(NOW - 3 * MIN, [{ number: 405, merged_at: AFTER, head: 'fix/403-banner' }]));
    expect(await of('merged')).toEqual([]);
  });

  it('a PR ready by its CI checks, with no test run of the plugin\'s, is ready from its findings report, as the issue page says', async () => {
    const ci = { checks: [{ name: 'Unit tests', state: 'pass', ci: true }] };
    await send(start('s-412', 'fix/412-queue', BEFORE - DAY), write('s-412', BEFORE), report(AFTER, 'fix/412-queue'), read(NOW - MIN, [pr(418, { head: 'fix/412-queue', issue: 412, created_at: BEFORE, ...ci })], issues(412)));
    expect(await of('ready')).toEqual([{ at: AFTER, kind: 'ready', project: 'mobile-app', issue: 412, title: 'Issue 412', pr: 418 }]);
    expect(await of('gate')).toEqual([]);
  });

  it('a report that came before the test run lists the issue as ready alone, not also as at the gate', async () => {
    await send(...READY, read(NOW - MIN, [pr(418, { head: 'fix/412-queue', issue: 412 })], issues(412)));
    expect((await changes(SINCE)).map((c) => [c.at, c.kind])).toEqual([[AFTER, 'ready']]);
  });

  it('a review of the branch and a later one naming the PR are the same issue\'s first review and a review again', async () => {
    await send(start('s-409', 'fix/409-retry', BEFORE - DAY), read(NOW - MIN, [pr(416, { head: 'fix/409-retry', issue: 409 })], issues(409)),
      report(BEFORE, 'fix/409-retry', [OPEN]), ev('s-rev', AFTER, 'findings.report', { pr: 416, findings: [FIXED], dropped: 0 }, { agent_id: 'rev', turn_id: 't-rev-pr' }));
    expect((await changes(BEFORE - 1)).filter((c) => c.kind.startsWith('review')).map((c) => [c.at, c.kind])).toEqual([[AFTER, 'reviewed-again'], [BEFORE, 'reviewed']]);
  });

  it('#118: a fixer\'s round on the PR\'s branch (it marks findings fixed, wrote no file) is no review: one "reviewed", no "reviewed again"', async () => {
    await send(start('s-409', 'fix/409-retry', BEFORE - DAY), read(NOW - MIN, [pr(416, { head: 'fix/409-retry', issue: 409 })], issues(409)),
      report(BEFORE, 'fix/409-retry', [OPEN]), report(AFTER, 'fix/409-retry', [{ ...OPEN, fate: 'fixed' }], 'fx'));
    expect((await changes(BEFORE - 1)).filter((c) => c.kind.startsWith('review'))).toEqual([{ at: BEFORE, kind: 'reviewed', project: 'mobile-app', issue: 409, title: 'Issue 409', pr: 416, open: 1 }]);
  });

  it('a session that started after the mark on an issue is picked up, with its branch; one before the mark is not', async () => {
    await send(start('s-415', 'fix/415-sync', AFTER), start('s-409', 'fix/409-retry', BEFORE), read(NOW - MIN, [], issues(415, 409)));
    expect(await of('picked-up')).toEqual([{ at: AFTER, kind: 'picked-up', project: 'mobile-app', issue: 415, title: 'Issue 415', branch: 'fix/415-sync' }]);
    await edge('picked-up', AFTER);
  });

  it('a session on no issue is not picked up', async () => {
    await send(start('s-main', 'main', AFTER), start('s-none', undefined, AFTER + MIN), read(NOW - MIN, [], issues(415)));
    expect(await changes(SINCE)).toEqual([]);
  });
});

describe('GET /api/changes: the list', () => {
  it('holds at most 50 changes, the newest first', async () => {
    const sessions = Array.from({ length: 60 }, (_, i) => start(`s-${i}`, `fix/${100 + i}-x`, SINCE + (i + 1) * MIN));
    await send(sessions, read(NOW - MIN, [], issues(...Array.from({ length: 60 }, (_, i) => 100 + i))));
    const list = await changes(SINCE);
    expect(list.map((c) => c.issue)).toEqual(Array.from({ length: 50 }, (_, i) => 159 - i));
    expect(list.map((c) => c.at)).toEqual(Array.from({ length: 50 }, (_, i) => SINCE + (60 - i) * MIN));
    expect((await app.inject({ url: `/api/changes?since=${SINCE}` })).json().total).toBe(60); // the list is cut at 50, and says how many there were
  });

  it('mixes the kinds by time across the projects Home shows, and leaves out a project with no session in 30 days', async () => {
    await send(start('s-415', 'fix/415-sync', SINCE + 10 * MIN), read(NOW - MIN, [], issues(415)),
      start('s-86', 'feat/86-pdf', SINCE + 20 * MIN, FIELD), read(NOW - MIN, [], issues(86), FIELD),
      start('s-b', undefined, NOW - 31 * DAY, BILLING), read(NOW - 31 * DAY, [pr(9, { head: 'fix/7-old', issue: 7, created_at: SINCE + 30 * MIN })], issues(7), BILLING));
    const list = await changes(SINCE);
    expect(list.map((c) => [c.project, c.issue, c.kind])).toEqual([['field-notes', 86, 'picked-up'], ['mobile-app', 415, 'picked-up']]);
  });

  it('a project with no issue titles (Content off or excluded) is listed by number alone', async () => {
    await send(start('s-86', 'feat/86-pdf', AFTER, FIELD), read(NOW - MIN, [], [{ number: 86, milestone: M }], FIELD));
    const [c] = await changes(SINCE);
    expect(c).toEqual({ at: AFTER, kind: 'picked-up', project: 'field-notes', issue: 86, branch: 'feat/86-pdf' });
    expect('title' in c!).toBe(false);
  });

  it('asks for since, a whole number', async () => {
    for (const q of ['', '?since=', '?since=yesterday', '?since=-5', '?since=1.5']) expect((await app.inject({ url: `/api/changes${q}` })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/changes?since=0' })).json()).toEqual({ changes: [], total: 0 });
  });
});
