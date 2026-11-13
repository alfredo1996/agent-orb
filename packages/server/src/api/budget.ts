import { branchIssue } from '@agent-orb/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, each, get, run, type Store } from '../store/store.ts';
import { zone } from './ledger.ts';
import { dayOf, monthBounds } from './local-time.ts';

// v0.4 slice 2 (#28, Factory; PROJECT.md §15, 2026-11-02): what an issue cost against its budget. Every figure is an estimate, and nothing is ever stopped.
//   GET /api/budget?project=<name>&tz=<IANA>  each issue's cost with its budget and mark, the milestones' defaults, and what this month spent on no issue
//   PUT /api/budget { project, milestone, usd } or { project, issue, usd }  studio only; usd above 0 and at most 1,000,000, or null to clear
// The budgets are kept per project name, like the goal: a repo seen from two machines is one budget.

const Query = z.object({ project: z.string().min(1), tz: zone.default('UTC') });
const usd = z.number().positive().max(1_000_000).nullable();
const Put = z.union([
  z.strictObject({ project: z.string().min(1), milestone: z.string().min(1).max(200), usd }),
  z.strictObject({ project: z.string().min(1), issue: z.number().int().positive().max(999_999_999), usd }),
]);

/** A PR the session linked: when it opened, and the issue it closes (none: it closes no issue). */
export type Link = { at: number; issue: number | null };

/**
 * The issue a PR is for: the one the open-PR read stored, else (#63) the number its head names, which only the merged list gives, so a PR merged before any read saw it open still has one. #69: not
 * when that issue was opened after the PR merged: the branch is of an older numbering (a renumbered repository) or named for something else (`fix/404-page`). An issue whose opening was never read
 * (closed before #69, or read only by an older plugin) is taken at the branch's word. The cost windows, the board's PR map and GET /api/links all reach a PR's issue through this one rule.
 */
export function prIssue(issue: number | null, head: string | null, mergedAt: number | null, open: Map<number, OpenIssue>): number | null {
  if (issue !== null) return issue;
  const n = branchIssue(head);
  const opened = n === null ? null : (open.get(n)?.openedAt ?? null);
  return opened !== null && mergedAt !== null && opened > mergedAt ? null : n;
}

/** The PRs a session linked, by opening time: the PR's own `created_at` where the read gave one, else when the session first linked it. The board (#32) and the Map (#66) reach issues through the same list. */
export const sessionLinks = (store: Store, id: string, open: Map<number, OpenIssue>): Link[] => all(store, `SELECT coalesce(r.created_at, sp.ts) AS at, r.issue AS issue, r.head AS head, r.merged_at AS mergedAt
  FROM session_prs sp JOIN pull_requests r ON r.id = sp.pr_id WHERE sp.session_id = :id AND coalesce(r.created_at, sp.ts) IS NOT NULL ORDER BY at`, { id }).map((r) => ({ at: r.at, issue: prIssue(r.issue, r.head, r.mergedAt, open) }));

/**
 * The issue a request belongs to in a session that is on no issue branch: the first PR the session opened at or after it (the PR's window runs from the session's previous PR up to
 * its opening), so a request in the very second of the opening is that PR's. `links` are by opening time. Past the last PR, or before a PR that closes no issue: none.
 * ponytail: a linear scan of the session's PRs (the busiest real session links 201, the average is 15); a binary search if a route over many such sessions ever shows.
 */
export function windowIssue(links: Link[], ts: number): number | null {
  for (const l of links) if (l.at >= ts) return l.issue;
  return null;
}

/**
 * An issue as the last reads left it. `goneAt` is null while the plugin's read lists it as open, else when it left the list (closed, or past gh's limit of 200): its milestone and title are kept (#32).
 * `mentions` (#66) is the issues its text names, as the writer stored them: a JSON array of numbers, or null. `openedAt` (#69) is when it was opened, null when no read gave it.
 */
export type OpenIssue = { milestone: string | null; title: string | null; goneAt: number | null; mentions: string | null; openedAt: number | null };

/**
 * The project's issues by number, as the plugin's reads of the open issues left them. Two project rows with the name (a repo seen from two machines, with no remote) may differ on one issue: the row
 * of the project read last wins, whole, so an issue's milestone and its title are one row's, not the larger of each. Projects are told apart by their name, as the goal and the budgets are, so two
 * repositories of one basename share their issues by number. The board (#32) reads its issues through the same list.
 */
export function openIssues(store: Store, project: string) {
  const issues = new Map<number, OpenIssue>();
  for (const r of each(store, `SELECT o.number AS number, o.milestone AS milestone, o.title AS title, o.gone_at AS goneAt, o.mentions AS mentions, o.created_at AS openedAt FROM open_issues o
    JOIN projects p ON p.id = o.project_id WHERE p.name = :project ORDER BY coalesce(p.prs_read_at, 0)`, { project })) {
    issues.set(r.number, { milestone: r.milestone, title: r.title, goneAt: r.goneAt, mentions: r.mentions, openedAt: r.openedAt });
  }
  return issues;
}

/** `at80` from 80% of the budget, `at100` once it is reached; none without a budget. By products, not 0.8 * budget: 0.8 * 3 is 2.4000000000000004. */
export const markOf = (spent: number, budget: number | null) => (budget === null ? null : spent >= budget ? 'at100' : spent * 5 >= budget * 4 ? 'at80' : null);

type Bucket = { whole: number; windows: number; partial: boolean };

/**
 * Who each dollar of a project was spent for (#28): a session on an issue branch counts whole for its issue; in any other session a request goes to the issue of the first PR the
 * session linked that opened at or after it (so a request in the very second of the opening is that PR's, and the PR's window runs from the session's previous PR up to its opening),
 * and the rest, a request before a PR that closes no issue, or a session that opened no PR, is on no issue. A PR's opening is its own `created_at` where the plugin read one, else when the
 * session first linked it. An issue's cost is all of it, since a milestone has no dates to cut it by; the spend on no issue is this month's, `start` to `now`.
 * A request on a model pricing.json lacks adds nothing and marks its bucket partial (a floor), as the goal's spend is.
 * A session's requests are streamed (`each`) and never held: reading them into objects grew a soak of this route to 364 MB (#90), and cutting the windows in a SQL subquery per request took
 * 2.8 s on a real project, against 0.2 s for this.
 * ponytail: the branch is the one the session started on, so a session that moved to an issue branch later is split by its PRs instead of counted whole; a fix made after a PR opens
 * lands on the session's next PR, or on no issue. That is the known weak spot of time windows (#28).
 */
export function issueCosts(store: Store, project: string, start: number, now: number, open: Map<number, OpenIssue>) {
  const sessions = all(store, `SELECT a.session_id AS id, s.branch AS branch, coalesce(sum(x.cost_usd), 0) AS usd, count(*) FILTER (WHERE x.cost_usd IS NULL) > 0 AS partial,
      coalesce(sum(x.cost_usd) FILTER (WHERE x.ts >= :start AND x.ts <= :now), 0) AS month,
      count(*) FILTER (WHERE x.cost_usd IS NULL AND x.ts >= :start AND x.ts <= :now) > 0 AS monthPartial,
      (SELECT count(*) FROM session_prs sp WHERE sp.session_id = a.session_id) AS links
    FROM api_requests x JOIN turns t ON t.id = x.turn_id JOIN agents a ON a.id = t.agent_id JOIN sessions s ON s.id = a.session_id JOIN projects pr ON pr.id = s.project_id
    WHERE pr.name = :project GROUP BY a.session_id`, { project, start, now });

  const issues = new Map<number, Bucket>();
  const none = { usd: 0, partial: false };
  const put = (issue: number, kind: 'whole' | 'windows', cost: number, partial: boolean) => {
    const b = issues.get(issue) ?? issues.set(issue, { whole: 0, windows: 0, partial: false }).get(issue)!;
    b[kind] += cost;
    b.partial ||= partial;
  };
  for (const s of sessions) {
    const own = branchIssue(s.branch);
    if (own !== null) {
      put(own, 'whole', s.usd, Boolean(s.partial));
    } else if (!s.links) { // no PR: all of it is on no issue, this month's from the sums above
      none.usd += s.month;
      none.partial ||= Boolean(s.monthPartial);
    } else {
      const links = sessionLinks(store, s.id, open);
      const by = new Map<number | null, { usd: number; partial: boolean; month: number; monthPartial: boolean }>();
      // nothing in this loop runs `each`'s own SQL again: its statement is busy until the loop ends
      for (const x of each(store, 'SELECT x.ts AS ts, x.cost_usd AS usd FROM api_requests x JOIN turns t ON t.id = x.turn_id JOIN agents a ON a.id = t.agent_id WHERE a.session_id = :id', { id: s.id })) {
        const issue = windowIssue(links, x.ts);
        const b = by.get(issue) ?? by.set(issue, { usd: 0, partial: false, month: 0, monthPartial: false }).get(issue)!;
        const inMonth = x.ts >= start && x.ts <= now;
        b.usd += x.usd ?? 0;
        if (x.usd === null) b.partial = true;
        if (inMonth) {
          b.month += x.usd ?? 0;
          if (x.usd === null) b.monthPartial = true;
        }
      }
      for (const [issue, b] of by) {
        if (issue !== null) put(issue, 'windows', b.usd, b.partial);
        else {
          none.usd += b.month;
          none.partial ||= b.monthPartial;
        }
      }
    }
  }
  return { issues, none };
}

export function budget(app: FastifyInstance, { store, now = Date.now }: { store: Store; now?: () => number }) {
  app.get('/api/budget', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a project, and a time zone that exists', issues: q.error.issues });
    const { project, tz } = q.data;
    const at = now();
    const month = dayOf(tz, at).slice(0, 7); // as the goal reads it: from midnight on the month's first day in the viewer's zone, to now
    const [start] = monthBounds(tz, Number(month.slice(0, 4)), Number(month.slice(5, 7)));
    const open = openIssues(store, project);
    const { issues, none } = issueCosts(store, project, start, at, open);

    // A closed issue keeps its milestone (#32), so what it cost is still held to the milestone's default; but only an open one is listed with no spend, and only an open one's milestone is offered.
    const milestoneOf = new Map<number, string>();
    const openNames = new Set<string>();
    for (const [number, o] of open) {
      if (o.milestone !== null) milestoneOf.set(number, o.milestone);
      if (o.goneAt !== null) continue;
      if (o.milestone !== null) openNames.add(o.milestone);
      if (!issues.has(number)) issues.set(number, { whole: 0, windows: 0, partial: false });
    }
    const defaults = new Map<string, number>();
    const overrides = new Map<number, number>();
    for (const r of all(store, 'SELECT kind, key, usd FROM budgets WHERE project = :project', { project })) {
      if (r.kind === 'milestone') defaults.set(r.key, r.usd);
      else {
        overrides.set(Number(r.key), r.usd);
        if (!issues.has(Number(r.key))) issues.set(Number(r.key), { whole: 0, windows: 0, partial: false });
      }
    }

    const rows = [...issues].toSorted(([a], [b]) => b - a).map(([number, b]) => {
      const milestone = milestoneOf.get(number) ?? null;
      const own = overrides.get(number);
      const dflt = milestone === null ? undefined : defaults.get(milestone);
      const budget = own ?? dflt ?? null;
      const spent = b.whole + b.windows;
      return { number, milestone, usd: spent, partial: b.partial, whole: b.whole, windows: b.windows, budget, milestoneBudget: dflt ?? null, source: own !== undefined ? 'issue' : dflt !== undefined ? 'milestone' : null, mark: markOf(spent, budget) };
    });
    const names = [...new Set([...openNames, ...defaults.keys()])].toSorted();
    return { project, month, issues: rows, notOnIssue: none, milestones: names.map((name) => ({ name, budget: defaults.get(name) ?? null })) };
  });

  app.put('/api/budget', async (req, reply) => {
    const b = Put.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'give a project, a milestone or an issue number, and usd: a number of dollars above 0 and at most 1,000,000, or null to clear it', issues: b.error.issues });
    const { project, usd } = b.data;
    if (!get(store, 'SELECT 1 AS x FROM projects WHERE name = :project', { project })) return reply.code(404).send({ error: 'no such project' });
    const [kind, key] = 'milestone' in b.data ? (['milestone', b.data.milestone] as const) : (['issue', String(b.data.issue)] as const);
    if (usd === null) run(store, 'DELETE FROM budgets WHERE project = :project AND kind = :kind AND key = :key', { project, kind, key });
    else run(store, 'INSERT INTO budgets (project, kind, key, usd) VALUES (:project, :kind, :key, :usd) ON CONFLICT (project, kind, key) DO UPDATE SET usd = excluded.usd', { project, kind, key, usd });
    return { project, [kind]: kind === 'issue' ? Number(key) : key, budget: usd };
  });
}
