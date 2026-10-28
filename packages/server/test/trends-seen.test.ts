import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Event, Usage } from '@agent-orb/shared';
import { buildApp } from '../src/app.ts';
import { costUsd } from '../src/cost.ts';
import { openStore, type Store } from '../src/store/store.ts';
import { writeEvents } from '../src/store/writer.ts';

// GET /api/trends, the changes a fingerprint found (v0.2 slice 3; PROJECT.md §15, 2026-10-24): each day's change gains `seen`, the files the
// plugin's fingerprints found changed, beside the commits. An entry git already explains (the same path at the same blob in any commit of the
// project) is dropped at read time, so the order things arrive in does not matter; a day with only `seen` entries is a change, with no commits.
const TOKEN = 'test-token-0123456789';
const iso = (s: string) => Date.parse(s);
let dir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
const write = (events: Event[]) => writeEvents(store, events, 'plugin');

const ORBIT = { cwd: '/Users/a/orbit', name: 'orbit', git_remote: 'github.com/o/orbit' };
let n = 0;
const ev = (project: typeof ORBIT, session: string, ts: number, kind: string, data: object, extra: object = {}): Event =>
  ({ v: 1, id: `00000000-0000-4000-b100-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'local', session_id: session, project, kind, data, ...extra }) as Event;
const h = (c: string) => c.repeat(40);
const ZERO = h('0');
const u = (input: number, output: number): Usage => ({ input, output, cache_read: 0, cache_creation: 0 });

const IMPL = '.claude/agents/implementer.md';
const CLAUDE = 'CLAUDE.md';
const RULES = '~/.claude/rules/git.md';
const OLD = '.claude/agents/old.md';
const SKILLX = '.claude/skills/x/SKILL.md';
const SKILL_CODE = '.claude/skills/code/SKILL.md';

// The plugin's view of the files at each session start; a path set to null is absent. Scope follows the path.
type Snap = Record<string, string | null>;
const BASE: Snap = { [IMPL]: h('1'), [CLAUDE]: h('2'), [RULES]: h('5'), [OLD]: h('9'), [SKILLX]: h('b') };
const fingerprint = (project: typeof ORBIT, at: string, over: Snap, session = `fp-${n}`) => {
  const snap = { ...BASE, ...over };
  const files = Object.entries(snap).filter(([, hash]) => hash).map(([path, hash]) => ({ path, hash, scope: path.startsWith('~/') ? 'user' : 'project' }));
  return ev(project, session, iso(at), 'project.fingerprint', { files });
};
const commit = (sha: string, at: string, files: string[], blobs: string[]) => ({ sha: sha.repeat(40), ts: iso(at), files, blobs });

const seeded: Event[] = [
  ev(ORBIT, 'o-1', iso('2026-10-12T07:00:00Z'), 'session.start', { model: 'claude-sonnet-5-5', source: 'startup', claude_version: '2.1.308', plugin_version: '0.2.0' }),
  // two days of work, for before and after
  ev(ORBIT, 'o-1', iso('2026-10-17T12:00:00Z'), 'turn.step', { model: 'claude-sonnet-5-5', usage: u(0, 100_000), stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: 't-1' }),
  ev(ORBIT, 'o-1', iso('2026-10-18T12:00:00Z'), 'turn.step', { model: 'claude-sonnet-5-5', usage: u(0, 50_000), stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: 't-2' }),
  // git: the commits of the project's agents, skills and CLAUDE.md, with the blob each made
  ev(ORBIT, 'o-1', iso('2026-10-24T00:00:00Z'), 'project.changes', { commits: [
    { ...commit('a', '2026-10-13T15:00:00Z', [IMPL, CLAUDE], [h('1'), h('2')]), subject: 'feat: the agents arrive' },
    { ...commit('b', '2026-10-14T08:00:00Z', [IMPL], [h('3')]), subject: 'feat: route by type' },
    { ...commit('c', '2026-10-15T07:30:00Z', [OLD], [ZERO]), subject: 'chore: drop old' },
    { ...commit('d', '2026-10-20T07:00:00Z', [SKILL_CODE], [h('c')]), subject: 'feat: the code skill' },
  ] }),
  // fingerprints, one per session start
  fingerprint(ORBIT, '2026-10-12T08:00:00Z', {}), // the baseline: no change
  fingerprint(ORBIT, '2026-10-14T07:00:00Z', { [IMPL]: h('3') }), // edited, committed an hour later as commit b: git explains it
  fingerprint(ORBIT, '2026-10-15T08:00:00Z', { [IMPL]: h('3'), [CLAUDE]: h('4'), [RULES]: h('6'), [OLD]: null }), // CLAUDE.md and the owner's rules (no commit); old.md deleted (commit c)
  fingerprint(ORBIT, '2026-10-17T08:00:00Z', { [IMPL]: h('3'), [CLAUDE]: h('a'), [RULES]: h('6'), [OLD]: null }), // CLAUDE.md again, on a day with no commit
  fingerprint(ORBIT, '2026-10-20T09:00:00Z', { [IMPL]: h('3'), [CLAUDE]: h('8'), [RULES]: h('6'), [OLD]: null }), // CLAUDE.md, the day of commit d
  fingerprint(ORBIT, '2026-10-21T08:00:00Z', { [IMPL]: h('3'), [CLAUDE]: h('8'), [RULES]: h('6'), [OLD]: null, [SKILLX]: null }), // a skill deleted, no commit
];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-trends-'));
  store = openStore(join(dir, 'history.db'));
  app = buildApp({ store, token: TOKEN });
  write(seeded);
});
afterAll(async () => {
  await app?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const FROM = iso('2026-10-11T22:00:00Z'); // Monday 12 Oct 00:00 in Rome
const TO = iso('2026-10-22T12:00:00Z');
const get = async (q: Record<string, string | number>) => {
  const res = await app.inject({ method: 'GET', url: `/api/trends?${new URLSearchParams(Object.entries({ unit: 'week', from: FROM, to: TO, tz: 'Europe/Rome', ...q }).map(([k, v]) => [k, String(v)]))}` });
  return { status: res.statusCode, body: res.json() };
};
const shape = (c: any) => [c.day, c.ts, c.commits.map((x: any) => x.sha[0]), c.seen.map((s: any) => [s.path, s.scope, s.ts, s.deleted]), c.files];

describe('GET /api/trends: what a fingerprint found', () => {
  it('each day: the commits, and the files a fingerprint found changed that git does not explain; a day with only the latter is a change too', async () => {
    const { status, body } = await get({ project: 'orbit' });
    expect(status).toBe(200);
    expect(body.changes.map(shape)).toEqual([
      ['2026-10-13', iso('2026-10-13T15:00:00Z'), ['a'], [], [IMPL, CLAUDE]],
      // the fingerprint of 14 Oct saw implementer.md at commit b's blob: git explains it, and dates it at the commit
      ['2026-10-14', iso('2026-10-14T08:00:00Z'), ['b'], [], [IMPL]],
      // 15 Oct: commit c (old.md deleted) and, found by the fingerprint, CLAUDE.md and the owner's rules; the fingerprint's own deletion of old.md is commit c's
      ['2026-10-15', iso('2026-10-15T07:30:00Z'), ['c'], [[CLAUDE, 'project', iso('2026-10-15T08:00:00Z'), false], [RULES, 'user', iso('2026-10-15T08:00:00Z'), false]], [OLD, CLAUDE, RULES]],
      // 17 Oct: no commit, only a fingerprint
      ['2026-10-17', iso('2026-10-17T08:00:00Z'), [], [[CLAUDE, 'project', iso('2026-10-17T08:00:00Z'), false]], [CLAUDE]],
      ['2026-10-20', iso('2026-10-20T07:00:00Z'), ['d'], [[CLAUDE, 'project', iso('2026-10-20T09:00:00Z'), false]], [SKILL_CODE, CLAUDE]],
      // 21 Oct: a skill went missing, and no commit says why
      ['2026-10-21', iso('2026-10-21T08:00:00Z'), [], [[SKILLX, 'project', iso('2026-10-21T08:00:00Z'), true]], [SKILLX]],
    ]);
    expect(body.changes.map((c: any) => c.id)).toEqual(['2013', '2014', '2015', '2017', '2020', '2021'].map((d) => `github.com/o/orbit:2026-10-${d.slice(2)}`));
  });

  it('a seen-only change is compared like any other: the 7 days before and the days after, per active day', async () => {
    const { body } = await get({ project: 'orbit' });
    const seenOnly = body.changes.find((c: any) => c.day === '2026-10-17');
    expect(seenOnly.before).toBeNull();
    expect(seenOnly.after.days).toBe(2); // 17 and 18 Oct
    expect(seenOnly.after.cost).toBeCloseTo(costUsd('claude-sonnet-5-5', u(0, 150_000))!, 9);
    expect(Object.keys(seenOnly.after).sort()).toEqual(['cost', 'days', 'generic', 'opus', 'typed']);
  });

  it('the day is the viewer\'s: a fingerprint at 23:30 UTC is the 19th in Rome and the 18th in UTC, and the entry keeps its own time', async () => {
    const ZONE = { cwd: '/Users/a/zone', name: 'zone', git_remote: 'github.com/o/zone' };
    write([fingerprint(ZONE, '2026-10-12T08:00:00Z', {}, 'z-1'), fingerprint(ZONE, '2026-10-18T23:30:00Z', { [CLAUDE]: h('e') }, 'z-2')]);
    for (const [tz, day] of [['Europe/Rome', '2026-10-19'], ['UTC', '2026-10-18']] as const) {
      const { body } = await get({ project: 'zone', tz });
      expect(body.changes.map(shape)).toEqual([[day, iso('2026-10-18T23:30:00Z'), [], [[CLAUDE, 'project', iso('2026-10-18T23:30:00Z'), false]], [CLAUDE]]]);
    }
  });

  it('only what falls in [from, to) is shown, for a seen entry as for a commit', async () => {
    const { body } = await get({ project: 'orbit', from: iso('2026-10-16T22:00:00Z'), to: iso('2026-10-20T12:00:00Z') });
    expect(body.changes.map(shape)).toEqual([
      ['2026-10-17', iso('2026-10-17T08:00:00Z'), [], [[CLAUDE, 'project', iso('2026-10-17T08:00:00Z'), false]], [CLAUDE]],
      ['2026-10-20', iso('2026-10-20T07:00:00Z'), ['d'], [[CLAUDE, 'project', iso('2026-10-20T09:00:00Z'), false]], [SKILL_CODE, CLAUDE]],
    ]);
  });
});

describe('GET /api/trends: git explains a fingerprint, whenever it arrives', () => {
  const LATE = { cwd: '/Users/a/late', name: 'late', git_remote: 'github.com/o/late' };
  const OTHER = { cwd: '/Users/a/other', name: 'other', git_remote: 'github.com/o/other' };
  const seenOf = async (project: string, q: Record<string, string | number> = {}) =>
    (await get({ project, ...q })).body.changes.flatMap((c: any) => c.seen.map((s: any) => [c.day, s.path, s.deleted]));
  const baseline = (p: typeof LATE, at: string, session: string) => fingerprint(p, at, { [IMPL]: h('1') }, session);

  it('a commit that arrives after the fingerprint takes the entry away, and puts its own change in its place', async () => {
    write([baseline(LATE, '2026-10-14T07:00:00Z', 'l-1'), fingerprint(LATE, '2026-10-16T07:00:00Z', { [IMPL]: h('d') }, 'l-2')]);
    expect(await seenOf('late')).toEqual([['2026-10-16', IMPL, false]]);
    write([ev(LATE, 'l-3', iso('2026-10-17T07:00:00Z'), 'project.changes', { commits: [commit('f', '2026-10-15T20:00:00Z', [IMPL], [h('d')])] })]);
    expect(await seenOf('late')).toEqual([]);
    const { body } = await get({ project: 'late' });
    expect(body.changes.map(shape)).toEqual([['2026-10-15', iso('2026-10-15T20:00:00Z'), ['f'], [], [IMPL]]]);
  });

  it('the commit may be outside the window: git explains a fingerprint anywhere in the project\'s changes', async () => {
    const P = { cwd: '/Users/a/window', name: 'window', git_remote: 'github.com/o/window' };
    write([
      ev(P, 'w-1', iso('2026-10-05T07:00:00Z'), 'project.changes', { commits: [commit('1', '2026-10-05T06:00:00Z', [IMPL], [h('d')])] }), // before `from`
      baseline(P, '2026-10-12T08:00:00Z', 'w-2'), fingerprint(P, '2026-10-16T08:00:00Z', { [IMPL]: h('d') }, 'w-3'),
    ]);
    expect(await seenOf('window')).toEqual([]);
  });

  it('only the same path at the same blob in the same project: another blob, another path, another project still show', async () => {
    write([
      baseline(OTHER, '2026-10-14T07:00:00Z', 'x-1'), fingerprint(OTHER, '2026-10-16T07:00:00Z', { [IMPL]: h('d') }, 'x-2'), // same path and blob as late's commit f
      fingerprint(OTHER, '2026-10-18T07:00:00Z', { [IMPL]: h('d'), [CLAUDE]: h('e') }, 'x-3'), // commit f touched the agent, not CLAUDE.md
    ]);
    expect(await seenOf('other')).toEqual([['2026-10-16', IMPL, false], ['2026-10-18', CLAUDE, false]]);
  });

  it('a deletion is explained by a commit that deleted the path (the all-zero blob), and only by that', async () => {
    const P = { cwd: '/Users/a/gone', name: 'gone', git_remote: 'github.com/o/gone' };
    write([
      baseline(P, '2026-10-12T08:00:00Z', 'g-1'), fingerprint(P, '2026-10-16T08:00:00Z', { [IMPL]: null }, 'g-2'),
    ]);
    expect(await seenOf('gone')).toEqual([['2026-10-16', IMPL, true]]);
    write([ev(P, 'g-3', iso('2026-10-17T08:00:00Z'), 'project.changes', { commits: [commit('9', '2026-10-15T20:00:00Z', [IMPL], [h('7')])] })]); // a commit that changed it, not deleted it
    expect(await seenOf('gone')).toEqual([['2026-10-16', IMPL, true]]);
    write([ev(P, 'g-4', iso('2026-10-17T09:00:00Z'), 'project.changes', { commits: [commit('8', '2026-10-15T21:00:00Z', [IMPL], [ZERO])] })]);
    expect(await seenOf('gone')).toEqual([]);
  });

  it('commits resent without blobs (an older plugin) explain nothing', async () => {
    const P = { cwd: '/Users/a/old', name: 'old', git_remote: 'github.com/o/old' };
    write([
      ev(P, 'q-1', iso('2026-10-14T07:00:00Z'), 'project.changes', { commits: [{ sha: 'a'.repeat(40), ts: iso('2026-10-15T20:00:00Z'), files: [IMPL] }] }),
      baseline(P, '2026-10-12T08:00:00Z', 'q-2'), fingerprint(P, '2026-10-16T08:00:00Z', { [IMPL]: h('d') }, 'q-3'),
    ]);
    expect(await seenOf('old')).toEqual([['2026-10-16', IMPL, false]]);
  });
});
