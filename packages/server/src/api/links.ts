import { UNCOUNTED } from '@agent-orb/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContentStore } from '../content-store.ts';
import { each, type Store } from '../store/store.ts';
import { reachOf } from './board.ts';
import { windowIssue } from './budget.ts';

// v0.5 slice 1 (#66, Follow; the plan is #64): how a milestone's issues touch each other, for the Map on the Factory page.
//   GET /api/links?project=<name>[&milestone=<title>]  the links between the issues GET /api/board shows for that milestone
// Two kinds, both worked out here, on read, from rows already stored (a stored copy would need redoing on every write):
//   file     two issues wrote the same file: a session on each did, by the rule the board's last write follows. `together` while neither is merged: the second to merge may conflict.
//   mention  the text of issue `a` names issue `b` as `#N`: numbers the plugin found on the machine (open_issues.mentions); the text was never sent.
// Not a field of /api/board: the page asks for the board every 30 seconds and reading every written path is a heavier pass, so the Map asks for this only while it is open.

const Query = z.object({ project: z.string().min(1), milestone: z.string().min(1).max(200).optional() });
const FILES_SHOWN = 3;

// A session's written paths: the files its agents (the main one and every subagent) touched in write mode.
const WROTE = `FROM agents a JOIN turns t ON t.agent_id = a.id JOIN tool_calls c ON c.turn_id = t.id JOIN files_touched f ON f.tool_use_id = c.tool_use_id AND f.mode = 'write' WHERE a.session_id = :id`;

export function linksOf(store: Store, content: ContentStore, project: string, chosenParam: string | undefined, now: number) {
  const { open, reaches, milestone, mergedPr, shown } = reachOf(store, content, project, chosenParam, now);

  // Each written path, with the shown issues that wrote it: all of a session's writes on the issue's branch, else those inside the window of a PR the session linked (the board's rule for
  // an issue's last write). Lockfiles, images, build output and generated files are left out, as a PR's size leaves them out: two issues that both rewrote the lockfile are not tied by it.
  // ponytail: a path is the session's own checkout's, so a subagent working in a worktree nested under it writes paths that match no other session's. Upgrade: cut the worktree's prefix in the plugin.
  const wrote = new Map<string, Set<number>>();
  const add = (issue: number | null, path: string) => {
    if (issue === null || !shown.has(issue) || UNCOUNTED.test(path)) return;
    (wrote.get(path) ?? wrote.set(path, new Set()).get(path)!).add(issue);
  };
  for (const r of reaches) {
    if (![...r.issues].some((i) => shown.has(i))) continue;
    if (r.own !== null) for (const w of each(store, `SELECT DISTINCT f.path AS path ${WROTE}`, { id: r.id })) add(r.own, w.path);
    else for (const w of each(store, `SELECT f.path AS path, c.ts AS ts ${WROTE}`, { id: r.id })) add(windowIssue(r.links, w.ts), w.path);
  }

  // ponytail: a file k issues wrote makes k(k-1)/2 pairs; a board holds tens of issues. Upgrade: leave out a file most of the board wrote.
  const pairs = new Map<string, { a: number; b: number; paths: { path: string; issues: number }[] }>();
  for (const [path, issues] of wrote) {
    const list = [...issues].sort((x, y) => x - y);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = `${list[i]}:${list[j]}`;
        (pairs.get(key) ?? pairs.set(key, { a: list[i]!, b: list[j]!, paths: [] }).get(key)!).paths.push({ path, issues: list.length });
      }
    }
  }
  const files = [...pairs.values()].map(({ a, b, paths }) => ({
    kind: 'file' as const, a, b,
    // the file the fewest issues wrote first: it says the most about these two (one every issue writes, a changelog, says the least)
    files: paths.sort((x, y) => x.issues - y.issues || (x.path < y.path ? -1 : 1)).slice(0, FILES_SHOWN).map((p) => p.path),
    count: paths.length, together: !mergedPr(a) && !mergedPr(b),
  })).sort((x, y) => Number(y.together) - Number(x.together) || y.count - x.count || x.a - y.a || x.b - y.b);

  // A mention shows when both issues do. One to an issue not on this board is the issue page's (#64).
  const mentions = [...shown.keys()].sort((x, y) => x - y).flatMap((a) =>
    (JSON.parse(open.get(a)?.mentions ?? '[]') as number[]).filter((b) => b !== a && shown.has(b)).map((b) => ({ kind: 'mention' as const, a, b })));

  return { project, milestone, links: [...files, ...mentions] };
}

export function links(app: FastifyInstance, { store, content, now = Date.now }: { store: Store; content: ContentStore; now?: () => number }) {
  app.get('/api/links', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a project', issues: q.error.issues });
    return linksOf(store, content, q.data.project, q.data.milestone, now());
  });
}
