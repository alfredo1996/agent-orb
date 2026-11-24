import { branchIssue } from '@agent-orb/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContentStore } from '../content-store.ts';
import type { LiveState } from '../live.ts';
import { all, each, type Store } from '../store/store.ts';
import { boardOf, newest, reachOf } from './board.ts';
import { budgetOf } from './budget.ts';
import { goalOf } from './goal.ts';
import { zone } from './ledger.ts';
import { linksOf } from './links.ts';

// v0.5 slice 3 (#107, Follow; the plan is #64): Home, what is going on across projects, worked out on read from rows already stored.
//   GET /api/home?tz=<IANA>  each project with a session in the past 30 days: its milestone (as the board picks it), the counts of merged, in flight and queued, the rows in flight, the issues each shares
//                            files with, this month's spend and goal, how old the GitHub read is and the sessions on no issue; and the projects with no session in 30 days, by name and time
// The rows are the board's own (boardOf, called as it is, with the reach read once), kept only while they are in flight: queued and merged issues are counts, so a card stays short and the read is lighter
// than a board per project. The pairs of issues that wrote the same files are /api/links's (linksOf, with the same reach); the month's spend is /api/goal's (goalOf).
// ponytail: one pass per project, in turn. If the soak goes over its ceiling, read only the projects with a session in the past 7 days in full and the rest as counts; upgrade: a cache per project, cleared when it ingests.

const Query = z.object({ tz: zone.default('UTC') });
const RECENT_MS = 30 * 86_400_000;
const NOT_ON_ISSUE_SHOWN = 5; // the newest ended sessions on no issue a card names, and every running one besides; the count is all of them

export function homeOf(store: Store, content: ContentStore, live: LiveState, tz: string, now: number) {
  const names = all(store, `SELECT p.name AS name, max(coalesce(s.seen_at, s.ended_at, s.started_at, 0)) AS last FROM projects p JOIN sessions s ON s.project_id = p.id
    GROUP BY p.name ORDER BY last DESC, name`);
  const since = now - RECENT_MS;
  const projects = names.filter((p) => p.last >= since).map(({ name, last }) => {
    const reach = reachOf(store, content, name, undefined, now);
    const board = boardOf(store, content, name, undefined, now, reach);
    const flying = board.issues.filter((i) => i.stage !== 'merged' && i.stage !== 'queued');
    const inside = (stage: string) => board.issues.filter((i) => !i.outside && i.stage === stage).length;

    // The issues each row shares files with: the file links of the board's own pairs, which lose a lockfile and a path most of the board changes.
    const shares = new Map<number, { issue: number; together: boolean }[]>();
    if (flying.length) {
      for (const l of linksOf(store, content, name, undefined, now, reach).links) {
        if (l.kind !== 'file') continue;
        shares.set(l.a, [...(shares.get(l.a) ?? []), { issue: l.b, together: l.together }]);
        shares.set(l.b, [...(shares.get(l.b) ?? []), { issue: l.a, together: l.together }]);
      }
    }

    // ponytail: the cost pass is the heavy one (it prices every request of the project), so it runs only when a row in flight has a budget, its own or its milestone's; none, and no row can be over.
    const set = all(store, 'SELECT kind, key FROM budgets WHERE project = :project', { project: name });
    const held = (r: (typeof flying)[number]) => set.some((b) => (b.kind === 'issue' ? Number(b.key) === r.number : r.milestone != null && b.key === r.milestone));
    const costs = flying.some(held) ? new Map(budgetOf(store, name, tz, now, reach.open).issues.map((i) => [i.number, i])) : undefined;

    // The branch of the newest session on each row, which says what an issue with no PR is being built on.
    const branches = new Map<number, string>();
    for (const x of reach.reaches.toSorted((a, b) => a.at - b.at)) if (x.branch) for (const i of x.issues) branches.set(i, x.branch);

    const rows = flying.map((r) => {
      const c = costs?.get(r.number);
      return {
        ...r,
        ...(branches.has(r.number) ? { branch: branches.get(r.number) } : {}),
        shares: (shares.get(r.number) ?? []).toSorted((a, b) => a.issue - b.issue),
        ...(newest(reach.openOf.get(r.number))?.conditions.findings.ok === false ? { openFindings: true as const } : {}),
        ...(c && c.budget !== null ? { budget: { usd: c.usd, budget: c.budget, mark: c.mark, partial: c.partial } } : {}),
      };
    });

    // The sessions of the past 30 days on no issue: no branch that names one, and none the board reached an issue by. The newest few that ended are named, and every one still running, so none is lost to "N more".
    // Running is what Live holds with no end: a session that never sent its end (it crashed, or ran before a restart) is one of the ended, or it would be named for 30 days. ponytail: a session that linked a PR of an issue long closed is counted here too.
    const reached = new Set(reach.reaches.map((r) => r.id));
    const none: { id: string; branch: string | null; at: number }[] = [];
    let count = 0;
    let named = 0; // the ended ones named
    for (const s of each(store, `SELECT s.id AS id, s.branch AS branch, coalesce(s.seen_at, s.ended_at, s.started_at, 0) AS at FROM sessions s JOIN projects p ON p.id = s.project_id
      WHERE p.name = :project AND coalesce(s.seen_at, s.ended_at, s.started_at, 0) >= :since ORDER BY at DESC, s.id`, { project: name, since })) {
      if (reached.has(s.id) || branchIssue(s.branch) !== null) continue;
      count++;
      const running = live.sessions.get(s.id);
      if ((!running || running.endedAt) && named++ >= NOT_ON_ISSUE_SHOWN) continue;
      none.push({ id: s.id, branch: s.branch, at: s.at });
    }

    const { month, goal, spent, costPartial } = goalOf(store, name, tz, now);
    return {
      name, last, milestone: board.milestone, content: board.content,
      counts: { merged: inside('merged'), flight: flying.filter((r) => !r.outside).length, queued: inside('queued'), outside: flying.filter((r) => r.outside).length },
      rows, readAt: reach.readAt, notOnIssue: { count, sessions: none }, month, goal, spent, costPartial,
    };
  });
  return { projects, quiet: names.filter((p) => p.last < since) };
}

export function home(app: FastifyInstance, { store, content, live, now = Date.now }: { store: Store; content: ContentStore; live: LiveState; now?: () => number }) {
  app.get('/api/home', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a time zone that exists', issues: q.error.issues });
    return homeOf(store, content, live, q.data.tz, now());
  });
}
