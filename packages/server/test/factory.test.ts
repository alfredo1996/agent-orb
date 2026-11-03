import { beforeEach, describe, expect, it } from 'vitest';
import type { Event } from '@agent-orb/shared';
import { buildApp } from '../src/app.ts';
import { ready, type PrState } from '../src/api/factory.ts';

// v0.4 slice 1 (#27, Factory; PROJECT.md §15, 2026-11-03): a PR is ready for the owner's ok when no finding is open, the gate passed on its head, no bot comment is newer
// than its last commit, and GitHub's mergeStateStatus is CLEAN. ready() holds the four; GET /api/factory reads them from what the plugin sent.
const TOKEN = 'test-token-0123456789';
const MIN = 60_000;
const T0 = Date.parse('2026-11-03T09:00:00Z');
const HEAD = 'e4f5a6b'.padEnd(40, '1');
const NEW_HEAD = '9c8d7e6'.padEnd(40, '2');

const pr = (over: Partial<PrState> = {}): PrState => ({
  headOid: HEAD, mergeState: 'CLEAN', lastCommitAt: T0, checks: [{ name: 'Unit tests', state: 'pass' }], bots: [{ author: 'coderabbitai', at: T0 - MIN }], ...over,
});
const none = { findings: [{ severity: 'major', fate: 'fixed' as const }, { severity: 'minor', fate: 'dismissed' as const }], dropped: 0 };

describe('ready(): all four conditions, and nothing less', () => {
  it('is true when all four hold, and says so in each condition', () => {
    expect(ready(pr(), none, undefined)).toEqual({
      ready: true, reason: null, conditions: {
        findings: { ok: true, note: '1 fixed, 1 dismissed, none open' },
        gate: { ok: true, note: '1 check passed' },
        bots: { ok: true, note: 'No bot comment since the last commit' },
        clean: { ok: true, note: 'CLEAN' },
      },
    });
  });

  it('1. an open finding: not ready, and the reason names how many and how bad', () => {
    const r = ready(pr(), { findings: [...none.findings, { severity: 'major', fate: 'open' }, { severity: 'minor', fate: 'open' }, { severity: 'minor', fate: 'open' }], dropped: 0 }, undefined);
    expect([r.ready, r.reason, r.conditions.findings]).toEqual([false, '3 findings open: 1 major, 2 minor', { ok: false, note: '3 findings open: 1 major, 2 minor' }]);
  });

  it('1. no findings block reached this PR\'s branch: unknown, so not ready; an empty block is a review that found nothing', () => {
    expect(ready(pr(), undefined, undefined).conditions.findings).toEqual({ ok: null, note: 'No findings reported yet' });
    expect(ready(pr(), undefined, undefined).ready).toBe(false);
    expect(ready(pr(), { findings: [], dropped: 0 }, undefined)).toMatchObject({ ready: true, conditions: { findings: { ok: true, note: 'Reported, none found' } } });
  });

  it('1. a last report with a line that did not parse is unknown: the line may have been an open finding', () => {
    expect(ready(pr(), { ...none, dropped: 2 }, undefined).conditions.findings).toEqual({ ok: null, note: '2 lines of the last report didn\'t parse' });
  });

  it('2. a failed check: not ready, whatever the orb-gate says', () => {
    const r = ready(pr({ checks: [{ name: 'Unit tests', state: 'pass' }, { name: 'Lint', state: 'fail' }, { name: 'E2E', state: 'fail' }] }), none, { result: 'pass' });
    expect([r.ready, r.conditions.gate]).toEqual([false, { ok: false, note: 'Lint and 1 more failed' }]);
  });

  it('2. a check still running is unknown', () => {
    expect(ready(pr({ checks: [{ name: 'E2E', state: 'pending' }] }), none, undefined).conditions.gate).toEqual({ ok: null, note: 'E2E is running' });
  });

  it('2. with no checks (no CI), the orb-gate on this head decides: pass, fail, or none yet', () => {
    expect(ready(pr({ checks: [] }), none, { result: 'pass' })).toMatchObject({ ready: true, conditions: { gate: { ok: true, note: 'orb-gate passed on e4f5a6b' } } });
    expect(ready(pr({ checks: [] }), none, { result: 'fail' }).conditions.gate).toEqual({ ok: false, note: 'orb-gate failed on e4f5a6b' });
    expect(ready(pr({ checks: [] }), none, undefined)).toMatchObject({ ready: false, conditions: { gate: { ok: null, note: 'No gate report on e4f5a6b' } } });
  });

  it('3. a bot comment newer than the last commit: not ready', () => {
    const r = ready(pr({ bots: [{ author: 'sonarqubecloud', at: T0 + 13 * MIN }, { author: 'coderabbitai', at: T0 + 6 * MIN }] }), none, undefined);
    expect([r.ready, r.conditions.bots]).toEqual([false, { ok: false, note: 'sonarqubecloud and 1 more commented after the last commit' }]);
  });

  it('3. a bot comment and no time for the last commit is unknown; no bot comment at all needs none', () => {
    expect(ready(pr({ lastCommitAt: undefined }), none, undefined).conditions.bots).toEqual({ ok: null, note: 'The last commit\'s time is unknown' });
    expect(ready(pr({ lastCommitAt: undefined, bots: [] }), none, undefined).conditions.bots).toEqual({ ok: true, note: 'No bot comment since the last commit' });
  });

  it('4. MERGEABLE with UNSTABLE is not ready: only mergeStateStatus CLEAN is', () => {
    const r = ready(pr({ mergeState: 'UNSTABLE' }), none, undefined);
    expect([r.ready, r.reason, r.conditions.clean]).toEqual([false, 'UNSTABLE: a check is not passing', { ok: false, note: 'UNSTABLE: a check is not passing' }]);
    for (const s of ['BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT', 'HAS_HOOKS']) expect(ready(pr({ mergeState: s }), none, undefined).conditions.clean.ok).toBe(false);
    expect(ready(pr({ mergeState: 'UNKNOWN' }), none, undefined).conditions.clean).toEqual({ ok: null, note: 'GitHub hasn\'t worked out the merge state yet' });
  });

  it('the reason is the first condition that does not hold, in order', () => {
    expect(ready(pr({ checks: [{ name: 'E2E', state: 'pending' }], mergeState: 'UNSTABLE' }), none, undefined).reason).toBe('E2E is running');
  });
});

// ── through the plugin's events, the writer and the route ──
type Project = { cwd: string; name: string; git_remote?: string };
const MOBILE: Project = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
let n = 0;
const ev = (ts: number, kind: string, data: object, extra: object = {}, project = MOBILE): Event =>
  ({ v: 1, id: `00000000-0000-4000-b270-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'local', session_id: 's-1', project, kind, data, ...extra }) as Event;
const findings = (ts: number, list: object[], branch = 'fix/409-token-retry', dropped = 0) => ev(ts, 'findings.report', { branch, findings: list, dropped }, { agent_id: `a-${ts}`, turn_id: `t-${ts}` });
const gate = (ts: number, result: 'pass' | 'fail', commit: string) => ev(ts, 'gate.report', { result, commit }, { agent_id: `g-${ts}`, turn_id: `tg-${ts}` });
const read = (ts: number, prs: object[]) => ev(ts, 'project.open_prs', { prs });
const open416 = (over: object = {}) => ({ number: 416, head: 'fix/409-token-retry', head_oid: HEAD, merge_state: 'CLEAN', last_commit_at: T0, checks: [], bots: [], ...over });

let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  app = buildApp({ token: TOKEN });
});
const send = async (...events: Event[]) => {
  const r = await app.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events } });
  expect(r.json()).toMatchObject({ accepted: events.length, rejected: 0 });
};
const factory = async (project = 'mobile-app') => (await app.inject({ url: `/api/factory?project=${project}` })).json();
const the416 = async () => (await factory()).prs.find((p: { number: number }) => p.number === 416);

describe('GET /api/factory', () => {
  it('a finding\'s latest fate wins across rounds, and one with no later fate stays open', async () => {
    await send(read(T0 + MIN, [open416()]), gate(T0 + MIN, 'pass', 'e4f5a6b'));
    await send(findings(T0 + 2 * MIN, [
      { id: 'F12', severity: 'major', file: 'src/auth/refresh.ts', fate: 'open', title: 'Two refreshes race' },
      { id: 'F14', severity: 'minor', file: 'src/auth/refresh.spec.ts', fate: 'open' },
      { id: 'F09', severity: 'minor', file: 'src/net/client.ts', fate: 'open' },
    ]));
    await send(findings(T0 + 5 * MIN, [ // the fixer's round: F12 fixed, F09 dismissed with its reason, F14 not named
      { id: 'F12', severity: 'major', file: 'src/auth/refresh.ts', fate: 'fixed' },
      { id: 'F09', severity: 'minor', file: 'src/net/client.ts', fate: 'dismissed', title: 'Timeout is not a constant', why: 'Used once, so no config' },
    ]));
    const p = await the416();
    expect(p.findings).toEqual([
      { id: 'F14', severity: 'minor', file: 'src/auth/refresh.spec.ts', fate: 'open' },
      { id: 'F09', severity: 'minor', file: 'src/net/client.ts', fate: 'dismissed', title: 'Timeout is not a constant', why: 'Used once, so no config' },
      { id: 'F12', severity: 'major', file: 'src/auth/refresh.ts', fate: 'fixed', title: 'Two refreshes race' },
    ]);
    expect([p.ready, p.reason]).toEqual([false, '1 finding open: 1 minor']);
  });

  it('an older report arriving late does not undo a newer fate', async () => {
    await send(read(T0 + MIN, [open416()]), findings(T0 + 5 * MIN, [{ id: 'F12', severity: 'major', file: 'a.ts', fate: 'fixed' }]));
    await send(findings(T0 + 2 * MIN, [{ id: 'F12', severity: 'major', file: 'a.ts', fate: 'open' }]));
    expect((await the416()).findings.map((f: { fate: string }) => f.fate)).toEqual(['fixed']);
  });

  it('after a force-push, ready is false until the gate names the new head', async () => {
    await send(read(T0 + MIN, [open416()]), findings(T0 + MIN, []), gate(T0 + 2 * MIN, 'pass', 'e4f5a6b'));
    expect((await the416()).ready).toBe(true);
    await send(read(T0 + 6 * MIN, [open416({ head_oid: NEW_HEAD, last_commit_at: T0 + 5 * MIN })]));
    expect(await the416()).toMatchObject({ ready: false, headOid: NEW_HEAD, reason: 'No gate report on 9c8d7e6' });
    await send(gate(T0 + 7 * MIN, 'pass', NEW_HEAD));
    expect((await the416()).ready).toBe(true);
  });

  it('a gate on another project\'s commit, or another branch\'s findings, count for nothing here', async () => {
    const OTHER: Project = { cwd: '/Users/a/billing', name: 'billing', git_remote: 'github.com/o/billing' };
    await send(read(T0 + MIN, [open416()]), ev(T0 + 2 * MIN, 'gate.report', { result: 'pass', commit: 'e4f5a6b' }, { agent_id: 'g', turn_id: 'tg' }, OTHER),
      findings(T0 + 2 * MIN, [], 'feat/other-branch'));
    expect((await the416()).conditions).toMatchObject({ findings: { ok: null }, gate: { ok: null } });
  });

  it('each read replaces the last: a PR merged since leaves the page; an older read arriving late changes nothing; the age is the last read\'s', async () => {
    await send(read(T0 + MIN, [open416(), { ...open416(), number: 405, head: 'feat/403-banner' }]));
    await send(read(T0 + 6 * MIN, [open416()]));
    await send(read(T0 + 3 * MIN, [{ ...open416(), number: 401 }]));
    const f = await factory();
    expect([f.readAt, f.prs.map((p: { number: number }) => p.number)]).toEqual([T0 + 6 * MIN, [416]]);
    await send(read(T0 + 11 * MIN, []));
    expect(await factory()).toEqual({ project: 'mobile-app', readAt: T0 + 11 * MIN, prs: [] });
  });

  it('not ready before ready, then the newest PR first', async () => {
    await send(read(T0 + MIN, [open416(), { ...open416(), number: 420, head: 'chore/router', merge_state: 'BEHIND' }, { ...open416(), number: 418, head: 'feat/412-queue' }]),
      findings(T0 + MIN, []), findings(T0 + MIN, [], 'feat/412-queue'), findings(T0 + MIN, [], 'chore/router'), gate(T0 + MIN, 'pass', HEAD));
    expect((await factory()).prs.map((p: { number: number; ready: boolean }) => [p.number, p.ready])).toEqual([[420, false], [418, true], [416, true]]);
  });

  it('with Content off a finding carries only its id, severity, file and fate; a project with no read yet says so', async () => {
    await send(read(T0 + MIN, [open416()]), findings(T0 + MIN, [{ id: 'F09', severity: 'minor', file: 'b.ts', fate: 'dismissed' }]));
    expect((await the416()).findings).toEqual([{ id: 'F09', severity: 'minor', file: 'b.ts', fate: 'dismissed' }]);
    expect(await factory('nobody')).toEqual({ project: 'nobody', readAt: null, prs: [] });
    expect((await app.inject({ url: '/api/factory' })).statusCode).toBe(400);
  });
});
