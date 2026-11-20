import { beforeEach, describe, expect, it } from 'vitest';
import type { Event } from '@agent-orb/shared';
import { buildApp } from '../src/app.ts';
import { all, openStore, type Store } from '../src/store/store.ts';

// v0.5 slice 1 (#66, Follow; the plan is #64): how a milestone's issues touch each other, for the Map on the Factory page. Two kinds of link, both worked out on read from rows already stored:
// two issues wrote the same file (a session on each, by the rule the board reaches an issue with), and one issue's text mentions the other (numbers the plugin found on the machine).
// The tests send the plugin's events to /ingest and read GET /api/links, so the writer, the reach and the route are held together; the issues are the ones GET /api/board shows.
const TOKEN = 'test-token-0123456789';
const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-03T09:00:00Z');
const NOW = Date.parse('2026-11-05T12:00:00Z');
const HEAD = 'a1b2c3d'.padEnd(40, '1');
const M = 'v2.3 Offline';

type Project = { cwd: string; name: string; git_remote?: string; git_branch?: string };
const MOBILE: Project = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
let n = 0;
const ev = (session: string, ts: number, kind: string, data: object, extra: object = {}, project: Project = MOBILE): Event =>
  ({ v: 1, id: `00000000-0000-4000-b660-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'local', session_id: session, project, kind, data, ...extra }) as Event;
const start = (session: string, branch: string | undefined, ts = T0) =>
  ev(session, ts, 'session.start', { model: 'claude-sonnet-5-5', source: 'interactive', claude_version: '2.1.316', plugin_version: '0.4.1' }, {}, { ...MOBILE, ...(branch ? { git_branch: branch } : {}) });
/** A file touched by the session at `ts`: the call and its result, which is what files_touched hangs on. `agent` makes it a subagent's. */
const touch = (mode: 'write' | 'read') => (session: string, ts: number, path: string, agent?: string): Event[] => {
  const turn = { turn_id: `t-${session}-${agent ?? 'main'}-${ts}`, ...(agent ? { agent_id: agent } : {}) };
  const id = `tu-${session}-${ts}-${path}`;
  return [
    ev(session, ts, 'tool.call', { tool_use_id: id, tool: mode === 'write' ? 'Edit' : 'Read', input_size: 10 }, turn),
    ev(session, ts, 'tool.result', { tool_use_id: id, success: true, duration_ms: 5, output_size: 2, files_touched: [{ path, mode }] }, turn),
  ];
};
const write = touch('write');
const look = touch('read');
const link = (session: string, ts: number, number: number) => ev(session, ts, 'session.pr', { number });
const pr = (number: number, over: object = {}) => ({ number, head: `fix/${number}`, head_oid: HEAD, merge_state: 'CLEAN', last_commit_at: T0, checks: [], bots: [], ...over });
const read = (ts: number, prs: object[], issues?: object[]) => ev('reader', ts, 'project.open_prs', { prs, ...(issues ? { issues } : {}) });
const merged = (ts: number, prs: object[]) => ev('reader', ts, 'project.prs', { prs: prs.map((p) => ({ additions: 1, deletions: 1, ...p })) });
const issues = (...numbers: number[]) => numbers.map((number) => ({ number, milestone: M }));

let app: ReturnType<typeof buildApp>;
let store: Store;
beforeEach(() => {
  store = openStore(':memory:');
  app = buildApp({ token: TOKEN, store, now: () => NOW });
});
const send = async (...events: unknown[]) => {
  const flat = events.flat(Infinity) as Event[];
  const r = await app.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events: flat } });
  expect(r.json()).toMatchObject({ accepted: flat.length, rejected: 0 });
};
type Link = { kind: 'file'; a: number; b: number; files: string[]; count: number; together: boolean } | { kind: 'mention'; a: number; b: number; both?: true };
type Links = { project: string; milestone: string | null; links: Link[]; common: string[] };
const links = async (q: Record<string, string> = {}): Promise<Links> => {
  const r = await app.inject({ url: `/api/links?${new URLSearchParams({ project: 'mobile-app', ...q })}` });
  expect(r.statusCode).toBe(200);
  return r.json();
};
const file = (a: number, b: number, files: string[], together = true, count = files.length): Link => ({ kind: 'file', a, b, files, count, together });
/** Two sessions, each on its issue's branch, with the files each wrote. */
const on = (issue: number, ...paths: string[]) => [start(`s-${issue}`, `fix/${issue}-x`), ...paths.map((p, i) => write(`s-${issue}`, T0 + (i + 1) * MIN, p))];

describe('GET /api/links: two issues wrote the same file', () => {
  it('a session on each wrote the same path: one link, with the path, between the two and no other', async () => {
    await send(on(409, 'src/net/client.ts', 'src/auth/refresh.ts'), on(412, 'src/net/client.ts', 'src/upload/queue.ts'), on(415, 'src/sync/dialog.ts'), read(NOW - MIN, [], issues(409, 412, 415, 417)));
    expect(await links()).toEqual({ project: 'mobile-app', milestone: M, links: [file(409, 412, ['src/net/client.ts'])], common: [] });
  });

  it('a read is not a write: an issue whose session only read the file is not linked by it', async () => {
    await send(on(409, 'src/net/client.ts'), start('s-415', 'fix/415-sync'), look('s-415', T0 + MIN, 'src/net/client.ts'), write('s-415', T0 + 2 * MIN, 'src/sync/dialog.ts'), read(NOW - MIN, [], issues(409, 415)));
    expect((await links()).links).toEqual([]);
  });

  it('a subagent\'s write counts as its session\'s', async () => {
    await send(on(409, 'src/net/client.ts'), start('s-412', 'fix/412-queue'), write('s-412', T0 + MIN, 'src/net/client.ts', 'agent-7'), read(NOW - MIN, [], issues(409, 412)));
    expect((await links()).links).toEqual([file(409, 412, ['src/net/client.ts'])]);
  });

  it('a lockfile, an image, build output and a generated file both wrote link nothing', async () => {
    const noise = ['pnpm-lock.yaml', 'apps/web/yarn.lock', 'assets/logo.png', 'dist/app.js', 'src/api.generated.ts', 'test/__snapshots__/a.test.ts.snap'];
    await send(on(409, ...noise), on(412, ...noise), read(NOW - MIN, [], issues(409, 412)));
    expect((await links()).links).toEqual([]);
    await send(write('s-409', T0 + 20 * MIN, 'src/a.ts'), write('s-412', T0 + 20 * MIN, 'src/a.ts')); // and a source file beside them is the whole link
    expect((await links()).links).toEqual([file(409, 412, ['src/a.ts'])]);
  });

  it('a session on no issue branch counts only its writes inside the PR\'s window: up to the opening of the PR that closes the issue', async () => {
    await send(
      start('s-x', 'main'), write('s-x', T0 + MIN, 'src/before.ts'), link('s-x', T0 + 5 * MIN, 416), write('s-x', T0 + 10 * MIN, 'src/after.ts'), // PR 416 opened at +5 and closes #409
      on(412, 'src/before.ts', 'src/after.ts'),
      read(NOW - MIN, [pr(416, { head: 'feat/retry', issue: 409, created_at: T0 + 5 * MIN })], issues(409, 412)),
    );
    expect((await links()).links).toEqual([file(409, 412, ['src/before.ts'])]);
  });

  it('a session that opened a PR for each of two issues gives each the writes of its own window', async () => {
    await send(
      start('s-x', 'main'), write('s-x', T0 + MIN, 'src/one.ts'), link('s-x', T0 + 5 * MIN, 416), write('s-x', T0 + 6 * MIN, 'src/two.ts'), link('s-x', T0 + 9 * MIN, 418),
      on(415, 'src/one.ts', 'src/two.ts'),
      read(NOW - MIN, [pr(416, { head: 'feat/retry', issue: 409, created_at: T0 + 5 * MIN }), pr(418, { head: 'feat/queue', issue: 412, created_at: T0 + 9 * MIN })], issues(409, 412, 415)),
    );
    expect((await links()).links).toEqual([file(409, 415, ['src/one.ts']), file(412, 415, ['src/two.ts'])]);
  });

  it('`together` is true while both are unmerged, and false once one merges', async () => {
    await send(on(409, 'src/net/client.ts'), on(412, 'src/net/client.ts'), read(NOW - 2 * MIN, [pr(418, { head: 'fix/412-x', issue: 412 })], issues(409, 412)));
    expect((await links()).links).toEqual([file(409, 412, ['src/net/client.ts'], true)]);
    await send(merged(NOW - MIN, [{ number: 418, merged_at: NOW - MIN, head: 'fix/412-x' }]), read(NOW - MIN / 2, [], issues(409))); // PR 418 merged, and #412 closed with it
    expect((await links()).links).toEqual([file(409, 412, ['src/net/client.ts'], false)]);
  });

  it('a link names up to 3 files and counts them all, the file fewest issues wrote first', async () => {
    const shared = ['PROJECT.md', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    // three more issues with files of their own: PROJECT.md, three of six, is then not most of the board's (#68), and still ties
    await send(on(409, ...shared), on(412, ...shared), on(415, 'PROJECT.md'), on(417, 'x.ts'), on(419, 'y.ts'), on(421, 'z.ts'), read(NOW - MIN, [], issues(409, 412, 415, 417, 419, 421)));
    expect((await links()).links).toEqual([
      file(409, 412, ['src/a.ts', 'src/b.ts', 'src/c.ts'], true, 5), // PROJECT.md is the fifth: three issues wrote it, so it says the least about these two
      file(409, 415, ['PROJECT.md']), file(412, 415, ['PROJECT.md']),
    ]);
  });

  it('only between issues the board shows: one outside the milestone links while a session reached it this week, and not after', async () => {
    await send(on(409, 'src/a.ts'), start('s-398', 'fix/398-feed', NOW - DAY), write('s-398', NOW - DAY, 'src/a.ts'),
      start('s-300', 'fix/300-old', NOW - 20 * DAY), write('s-300', NOW - 20 * DAY, 'src/a.ts'), // reached three weeks ago, and in no milestone: not on the board
      read(NOW - MIN, [], [...issues(409), { number: 398, milestone: 'v2.2.1' }, { number: 300 }]));
    expect((await links({ milestone: M })).links).toEqual([file(398, 409, ['src/a.ts'])]);
    expect((await links({ milestone: 'v2.2.1' })).links).toEqual([file(398, 409, ['src/a.ts'])]); // and on v2.2.1's board, where #409 is the one in flight outside it
  });
});

describe('GET /api/links: two issues whose open PRs change the same file (#68)', () => {
  const opens = (...prs: [number, number, string[] | undefined][]) => prs.map(([number, issue, files]) => pr(number, { issue, ...(files ? { files } : {}) }));

  it('two shown issues whose open PRs both list a path are a file link, in flight together, with no session write at all', async () => {
    await send(read(NOW - MIN, opens([416, 409, ['src/net/client.ts', 'src/auth/refresh.ts']], [418, 412, ['src/net/client.ts']]), issues(409, 412)));
    expect(await links()).toEqual({ project: 'mobile-app', milestone: M, links: [file(409, 412, ['src/net/client.ts'])], common: [] });
  });

  it('a pair found from a session\'s write and from its PR\'s files is one link, each path once', async () => {
    await send(on(409, 'src/a.ts'), on(412, 'src/a.ts'), read(NOW - MIN, opens([416, 409, ['src/a.ts', 'src/b.ts']], [418, 412, ['src/b.ts', 'src/a.ts']]), issues(409, 412)));
    expect((await links()).links).toEqual([file(409, 412, ['src/a.ts', 'src/b.ts'])]);
  });

  it('a path that three issues change, more than half of those with any file, ties none of them and comes back in `common`; two issues sharing a path are still tied by it', async () => {
    await send(read(NOW - MIN, opens([416, 409, ['PROJECT.md', 'src/a.ts']], [418, 412, ['PROJECT.md', 'src/a.ts']], [420, 415, ['PROJECT.md']]), issues(409, 412, 415)));
    expect(await links()).toEqual({ project: 'mobile-app', milestone: M, links: [file(409, 412, ['src/a.ts'])], common: ['PROJECT.md'] });
    // three of seven with files is not more than half: the path ties the three
    await send(read(NOW, opens([416, 409, ['PROJECT.md']], [418, 412, ['PROJECT.md']], [420, 415, ['PROJECT.md']], [421, 417, ['x.ts']], [422, 419, ['y.ts']], [423, 421, ['z.ts']], [424, 423, ['w.ts']]),
      issues(409, 412, 415, 417, 419, 421, 423)));
    const seven = await links();
    expect(seven.common).toEqual([]);
    expect(seven.links.map((l) => [l.a, l.b])).toEqual([[409, 412], [409, 415], [412, 415]]);
  });

  it('a read whose PRs carry no files (a plugin from before #68) leaves the column null, and the route answers from the sessions\' writes as before', async () => {
    await send(on(409, 'src/a.ts'), on(412, 'src/a.ts'), read(NOW - MIN, opens([416, 409, undefined], [418, 412, undefined]), issues(409, 412)));
    expect(all(store, 'SELECT number, files FROM open_prs ORDER BY number').map((r) => ({ ...r }))).toEqual([{ number: 416, files: null }, { number: 418, files: null }]);
    expect((await links()).links).toEqual([file(409, 412, ['src/a.ts'])]);
  });

  it('a lockfile or an image two PRs list ties nothing, as for a session\'s write; a PR whose issue the board does not show ties nothing', async () => {
    await send(read(NOW - MIN, opens([416, 409, ['pnpm-lock.yaml', 'docs/a.png']], [418, 412, ['pnpm-lock.yaml', 'docs/a.png', 'src/q.ts']], [430, 500, ['src/q.ts']]), issues(409, 412)));
    expect((await links()).links).toEqual([]);
  });
});

describe('GET /api/links: one issue mentions another', () => {
  it('a mention between two shown issues comes back in its direction; one to an issue not shown, or to itself, is left out', async () => {
    await send(read(NOW - MIN, [], [{ number: 417, milestone: M, mentions: [409, 500, 417] }, { number: 409, milestone: M, mentions: [300] }, { number: 412, milestone: M }, { number: 300, milestone: 'v9' }]));
    expect((await links()).links).toEqual([{ kind: 'mention', a: 417, b: 409 }]);
  });

  it('two issues that mention each other are one link, the lower number first, with `both` (#70: one line on the Map); one named back by none keeps its direction; a pair can be tied by a file too: file links first', async () => {
    await send(on(409, 'src/a.ts'), on(412, 'src/a.ts'), read(NOW - MIN, [], [{ number: 409, milestone: M, mentions: [412] }, { number: 412, milestone: M, mentions: [409] }, { number: 415, milestone: M, mentions: [409] }]));
    expect((await links()).links).toEqual([file(409, 412, ['src/a.ts']), { kind: 'mention', a: 409, b: 412, both: true }, { kind: 'mention', a: 415, b: 409 }]);
  });

  it('a mention stored twice (the ingest keeps the list as the plugin sent it) is one link, and a pair that names each other twice over is one `both` link', async () => {
    await send(read(NOW - MIN, [], [{ number: 409, milestone: M, mentions: [412, 412] }, { number: 412, milestone: M }, { number: 415, milestone: M, mentions: [409, 409] }, { number: 417, milestone: M, mentions: [415, 415] }, { number: 420, milestone: M, mentions: [421, 421] }, { number: 421, milestone: M, mentions: [420, 420] }]));
    expect((await links()).links).toEqual([{ kind: 'mention', a: 409, b: 412 }, { kind: 'mention', a: 415, b: 409 }, { kind: 'mention', a: 417, b: 415 }, { kind: 'mention', a: 420, b: 421, both: true }]);
  });

  it('an event with no mentions (a plugin from before #66) leaves the column null, and the route still answers', async () => {
    await send(on(409, 'src/a.ts'), on(412, 'src/a.ts'), read(NOW - MIN, [], issues(409, 412)));
    expect(all(store, 'SELECT number, mentions FROM open_issues ORDER BY number').map((r) => ({ ...r }))).toEqual([{ number: 409, mentions: null }, { number: 412, mentions: null }]);
    expect((await links()).links).toEqual([file(409, 412, ['src/a.ts'])]);
  });
});

describe('GET /api/links: the route', () => {
  it('asks for a project', async () => {
    expect((await app.inject({ url: '/api/links' })).statusCode).toBe(400);
  });

  it('a project nothing was read for answers no links and no milestone', async () => {
    expect(await links({ project: 'nowhere' })).toEqual({ project: 'nowhere', milestone: null, links: [], common: [] });
  });

  it('shows the links of the board\'s own issues: every issue a link names is a row of GET /api/board for the same milestone', async () => {
    await send(on(409, 'src/a.ts', 'src/b.ts'), on(412, 'src/a.ts'), on(415, 'src/b.ts'), read(NOW - MIN, [], [...issues(409, 412), { number: 415, milestone: 'v2.4' }, { number: 417, milestone: 'v2.4', mentions: [415, 409] }]));
    for (const milestone of [M, 'v2.4']) {
      const board = (await app.inject({ url: `/api/board?${new URLSearchParams({ project: 'mobile-app', milestone })}` })).json() as { issues: { number: number }[] };
      const shown = new Set(board.issues.map((i) => i.number));
      const got = await links({ milestone });
      expect(got.milestone).toBe(milestone);
      expect(got.links.length).toBeGreaterThan(0);
      expect(got.links.flatMap((l) => [l.a, l.b]).filter((i) => !shown.has(i))).toEqual([]);
    }
    // on v2.4's board #409 and #412 are in flight outside it, so #417's mention of #409 shows; on v2.3's, #417 (queued, in v2.4) is no row
    expect((await links({ milestone: 'v2.4' })).links).toContainEqual({ kind: 'mention', a: 417, b: 409 });
    expect((await links()).links.filter((l) => l.kind === 'mention')).toEqual([]);
  });
});
