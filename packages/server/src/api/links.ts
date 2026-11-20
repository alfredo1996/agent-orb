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
//   file     two issues change the same file: a session on each wrote it, by the rule the board's last write follows, or (#68) each one's open PR lists it. `together` while neither is
//            merged: the second to merge may conflict. A file most of the board's issues change (PROJECT.md here) ties none of them: it comes back in `common` instead.
//   mention  the text of issue `a` names issue `b` as `#N`: numbers the plugin found on the machine (open_issues.mentions); the text was never sent.
// Not a field of /api/board: the page asks for the board every 30 seconds and reading every written path is a heavier pass, so the Map asks for this only while it is open.

const Query = z.object({ project: z.string().min(1), milestone: z.string().min(1).max(200).optional() });
const FILES_SHOWN = 3;

// A session's written paths: the files its agents (the main one and every subagent) touched in write mode.
const WROTE = `FROM agents a JOIN turns t ON t.agent_id = a.id JOIN tool_calls c ON c.turn_id = t.id JOIN files_touched f ON f.tool_use_id = c.tool_use_id AND f.mode = 'write' WHERE a.session_id = :id`;
// #68: the paths each open PR changes, with the issue it closes as GET /api/board reads it (the open-PR read put it on the PR's pull_requests row). Most edits record no file (a subagent in its own
// worktree or clone, an edit through Bash), and the PR's own list has them all.
const PR_FILES = `SELECT pr.issue AS issue, o.files AS files FROM open_prs o JOIN projects p ON p.id = o.project_id LEFT JOIN pull_requests pr ON pr.id = o.project_id || ':' || o.number
  WHERE p.name = :project AND o.files IS NOT NULL`;

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
  // An issue whose newest PR merged is joined by its sessions' writes only: an older PR of it still open says nothing of what it changes now (README, the Map's links).
  for (const r of each(store, PR_FILES, { project })) if (r.issue === null || !mergedPr(r.issue)) for (const path of JSON.parse(r.files) as string[]) add(r.issue, path);

  // #68: a path that at least three shown issues change, and more than half of the issues the board shows (those with no file count: few have one), says nothing about a pair (PROJECT.md and README.md here, which every slice edits): it is
  // set aside before the pairs are made, and named once under the Map instead. A path only two issues share is not common (at least three), so it still ties them.
  const common = [...wrote].filter(([, issues]) => issues.size >= 3 && issues.size > shown.size / 2).map(([path]) => path).sort();
  for (const path of common) wrote.delete(path);

  // ponytail: a file k issues change makes k(k-1)/2 pairs; a board holds tens of issues, and a file most of them change is in `common` above, so k stays under half the board.
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

  // A mention shows when both issues do. One to an issue not on this board is the issue page's (#64). Two issues that name each other are one link, the lower number first, with `both`
  // (#70: one line on the Map, not two); one the other does not name back keeps its direction, `a` naming `b`.
  const named = (n: number) => [...new Set(JSON.parse(open.get(n)?.mentions ?? '[]') as number[])].filter((m) => m !== n && shown.has(m)); // the ingest keeps the list as sent: a number twice is one mention
  const mentions = [...shown.keys()].sort((x, y) => x - y).flatMap((a) => named(a).flatMap((b) => {
    if (!named(b).includes(a)) return [{ kind: 'mention' as const, a, b }];
    return a < b ? [{ kind: 'mention' as const, a, b, both: true as const }] : []; // the pair once, from its lower number
  }));

  return { project, milestone, links: [...files, ...mentions], common };
}

export function links(app: FastifyInstance, { store, content, now = Date.now }: { store: Store; content: ContentStore; now?: () => number }) {
  app.get('/api/links', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a project', issues: q.error.issues });
    return linksOf(store, content, q.data.project, q.data.milestone, now());
  });
}
