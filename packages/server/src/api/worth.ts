import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AnalysisStore, Cuts, Sizes } from '../analysis-store.ts';
import { all, run, type Store } from '../store/store.ts';
import { WINDOW_MS, zone } from './ledger.ts';
import { localDate, monthBounds } from './local-time.ts';

// Worth (v0.3 slice 2, #42; PROJECT.md §15, 2026-10-25): is it paying off? The owner's rate, plan price and PR sizes against what the logs measured.
//   GET /api/worth?project=<name>&month=YYYY-MM&tz=<IANA>  the month's attention, hours by hand, value and return (§6, "Worth")
//   PUT /api/worth/settings { rate?, plan?, sizes?, cuts? }  studio only
//   PUT /api/worth/size { project, number, size }          studio only
// The rate, the plan price, the sizes' hours and the cut points are the owner's, kept in the analysis store's file (never in the history, never sent anywhere);
// an owner's size is on the pull request, by project and number. Without one (#103) a PR is sized from the lines and files the plugin counted: see `autoSize`.

const SIZE_NAMES = ['S', 'M', 'L', 'XL'] as const;
const HOUR_MS = 3_600_000;
const PER_PROMPT_MS = 2 * 60_000; // and each prompt is worth this much on its own (writing it, reading the answer)

const Query = z.object({ project: z.string().min(1), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), tz: zone.default('UTC') });
const hours = z.number().positive().max(1000);
const cut = z.number().positive().max(10_000_000);
const Settings = z.object({
  rate: z.number().positive().max(100_000).nullable().optional(),
  plan: z.number().min(0).max(1_000_000).nullable().optional(),
  sizes: z.object({ S: hours, M: hours, L: hours, XL: hours }).partial().optional(),
  cuts: z.object({ S: cut, M: cut, L: cut }).partial().optional(),
});
const Size = z.object({ project: z.string().min(1), number: z.number().int().positive(), size: z.enum([...SIZE_NAMES, 'skip']).nullable() });

/**
 * The owner's attention in a month, a floor: the prompts of the project's sessions taken together as one person's, 2 minutes a prompt plus every gap between two
 * consecutive prompts under 10 minutes, which counts as working (exactly 10 does not, and a gap never reaches across the month's edge: the prompts are those in the month),
 * and the days they fall on, in the zone. Summed in SQL, over the prompts in order.
 * ponytail: a floor. Reading a diff afterwards leaves no trace, and a gap under 10 minutes spent away counts in full; the plugin could send idle
 * time if a better figure is ever wanted.
 */
const ATTENTION = (days: string) => `WITH mine AS (
    SELECT x.ts AS ts, lag(x.ts) OVER (ORDER BY x.ts) AS prev
    FROM prompts x JOIN sessions s ON s.id = x.session_id JOIN projects p ON p.id = s.project_id
    WHERE p.name = :project AND x.ts >= :start AND x.ts < :end)
  SELECT count(*) AS prompts, coalesce(sum(CASE WHEN ts - prev < ${WINDOW_MS} THEN ts - prev ELSE 0 END), 0) AS gapMs, count(DISTINCT ${days}) AS days FROM mine`;

/**
 * A PR's size from what the plugin counted (#103): score = counted lines x (1 + log2 counted files), S below `cuts.S`, M below `cuts.M`, L below `cuts.L`, XL from there.
 * A PR without both counts has none (it stays "not sized"). Files below 1 count as 1, so log2 is 0 and the score is the lines alone: a PR whose files were all set aside
 * (0 lines in 0 files) scores 0 and is S.
 */
function autoSize(lines: number | null, files: number | null, cuts: Cuts): keyof Sizes | null {
  if (lines === null || files === null) return null;
  const score = lines * (1 + Math.log2(Math.max(files, 1)));
  return score < cuts.S ? 'S' : score < cuts.M ? 'M' : score < cuts.L ? 'L' : 'XL';
}

// A PR is a release merge when its head is release/* (v0.3 slice 2) or its title opens `chore(release)`, `chore: merge ` or `Merge ` (#103); LIKE is case-blind, GLOB is not,
// so "Merge x" is a merge and a hand-written "merge conflicts, fixed" is not. A project that hides its titles (an excluded one) has none to read.
const NOT_RELEASE = `NOT coalesce(pr.head, '') GLOB 'release/*' AND NOT coalesce(pr.title, '') LIKE 'chore(release)%'
  AND NOT coalesce(pr.title, '') LIKE 'chore: merge %' AND NOT coalesce(pr.title, '') GLOB 'Merge *'`;

/**
 * Each link of a session to a PR owns a slice of the session: after the session's previous link (by time, then PR number) up to and including its own. The slices of a
 * session do not overlap, so the shares of its PRs add up to the session's cost and agents up to its last link; what came after the last link is no PR's. A request
 * is in the slice its ts falls in; an agent, where it started (the main agent, with the session, so in the first). A link with no time (made before #103) owns the whole
 * session, as every link did; a link to a PR the list never showed still bounds the slices (it is in `links`, not in the rows). Two PRs named at one instant: the lower
 * number takes the slice, the other's is empty.
 * ponytail: an agent counts once, in the slice it starts in, so a PR whose slice holds no new agent shows 0 agents though the main agent worked on it; and a PR named by
 * a session only to merge or review it still takes a slice. Count the agents with a request in the slice if that is ever wanted.
 */
const SHARES = `WITH links AS (
    SELECT o.session_id AS session, o.pr_id AS pr, o.ts AS ts, lag(o.ts) OVER (PARTITION BY o.session_id ORDER BY o.ts IS NULL, o.ts, o.pr_id) AS prev
    FROM session_prs o WHERE o.session_id IN (SELECT s.id FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.name = :project)),
  slices AS (SELECT session, pr, CASE WHEN ts IS NULL THEN -1 ELSE coalesce(prev, -1) END AS lo, coalesce(ts, 9223372036854775807) AS hi FROM links),
  shares AS (
    SELECT sl.pr AS pr, count(*) AS sessions,
      sum((SELECT count(*) FROM agents a WHERE a.session_id = sl.session AND coalesce(a.started_at, 0) > sl.lo AND coalesce(a.started_at, 0) <= sl.hi)) AS agents,
      sum((SELECT coalesce(sum(x.cost_usd), 0) FROM agents a JOIN turns t ON t.agent_id = a.id JOIN api_requests x ON x.turn_id = t.id
           WHERE a.session_id = sl.session AND x.ts > sl.lo AND x.ts <= sl.hi)) AS cost
    FROM slices sl GROUP BY sl.pr)`;

const OWNED = 'JOIN turns t ON t.id = x.turn_id JOIN agents a ON a.id = t.agent_id JOIN sessions s ON s.id = a.session_id JOIN projects p ON p.id = s.project_id';

export function worth(app: FastifyInstance, { store, reports }: { store: Store; reports: AnalysisStore }) {
  app.get('/api/worth', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a project, a month as YYYY-MM, and a time zone that exists', issues: q.error.issues });
    const { project, month, tz } = q.data;
    // The month runs from midnight on its first day to midnight on the next, in the viewer's zone.
    const [start, end] = monthBounds(tz, Number(month.slice(0, 4)), Number(month.slice(5, 7)));
    const params = { project, start, end };
    // By project name, every project row with it (a repo seen from two machines is two rows), as the goal reads it.
    const [attention] = all(store, ATTENTION(localDate(tz, start, end, 'ts')), params);
    // A tool held at the permission dialog: its run time is the ceiling of the wait (the Ledger's "waiting on you"). Each wait counts at most
    // WINDOW_MS, as a gap between prompts does: a dialog left open longer means nobody was there (#76; a real project's October had 70 h in 14 waits).
    const [waits] = all(store, `SELECT coalesce(sum(CASE WHEN x.duration_ms > :cap THEN :cap ELSE x.duration_ms END), 0) AS ms
      FROM tool_calls x ${OWNED} WHERE p.name = :project AND x.waited = 1 AND x.ts >= :start AND x.ts < :end`, { ...params, cap: WINDOW_MS });
    // ponytail: a request on a model pricing.json lacks adds nothing, so the cost is a floor; costPartial says so.
    const [spent] = all(store, `SELECT coalesce(sum(x.cost_usd), 0) AS cost, count(*) FILTER (WHERE x.cost_usd IS NULL) > 0 AS partial
      FROM api_requests x ${OWNED} WHERE p.name = :project AND x.ts >= :start AND x.ts < :end`, params);
    // The PRs merged in the month, with the sessions that opened each, their agents and what their requests cost: each PR's share of a session (SHARES), not the session whole.
    // ponytail: a release PR (head release/*, or a title that opens chore(release), chore: merge or Merge) bundles work its feature PRs already counted, so sizing it would count
    // that work twice: it is left out of the rows, total, sized and hours (it stays in the store). A PR with no head known stays in. Make the prefixes a setting if a repo
    // ever releases from another branch name; and two repos with one folder name and one PR number would be one row, since the project is read by name.
    const prs = all(store, `${SHARES}
      SELECT pr.number AS number, pr.title AS title, pr.merged_at AS mergedAt, pr.additions AS additions, pr.deletions AS deletions,
        pr.counted_lines AS countedLines, pr.counted_files AS countedFiles, pr.size AS size,
        coalesce(h.sessions, 0) AS sessions, coalesce(h.agents, 0) AS agents, coalesce(h.cost, 0) AS cost
      FROM pull_requests pr LEFT JOIN shares h ON h.pr = pr.id
      WHERE pr.project_id IN (SELECT id FROM projects WHERE name = :project) AND pr.merged_at >= :start AND pr.merged_at < :end AND ${NOT_RELEASE}
      ORDER BY pr.merged_at DESC, pr.number DESC`, params);
    // How many it left out, for the studio to say (#103): the same rule, read the other way round.
    const [released] = all(store, `SELECT count(*) AS n FROM pull_requests pr
      WHERE pr.project_id IN (SELECT id FROM projects WHERE name = :project) AND pr.merged_at >= :start AND pr.merged_at < :end AND NOT (${NOT_RELEASE})`, params);

    const waitMs = waits!.ms;
    const settings = reports.worth();
    // A size is the owner's answer, else the score's: S, M, L or XL adds its hours, skip adds none and is still an answer. `yours` says which it is.
    const rows = prs.map((p) => {
      const yours = p.size != null;
      return { ...p, title: p.title ?? null, size: (yours ? p.size : autoSize(p.countedLines, p.countedFiles, settings.cuts)) as string | null, yours };
    });
    const byHandHours = rows.reduce((t, p) => t + (p.size && p.size !== 'skip' ? settings.sizes[p.size as keyof Sizes] ?? 0 : 0), 0);
    const attentionHours = (attention!.prompts * PER_PROMPT_MS + attention!.gapMs + waitMs) / HOUR_MS;
    const netHours = byHandHours - attentionHours;
    const value = settings.rate === null ? null : netHours * settings.rate;
    return {
      settings, month,
      attentionHours, waitsHours: waitMs / HOUR_MS, prompts: attention!.prompts, days: attention!.days,
      apiCost: spent!.cost, costPartial: Boolean(spent!.partial),
      prs: rows, releaseMerges: released!.n,
      sized: rows.filter((p) => p.size != null).length, total: rows.length, byHandHours,
      netHours, value, return: value === null || settings.plan === null ? null : value - settings.plan,
    };
  });

  app.put('/api/worth/settings', async (req, reply) => {
    const b = Settings.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'rate: dollars an hour above 0; plan: dollars a month, 0 or more; sizes: hours above 0 for S, M, L or XL; cuts: the score each of S, M and L is below, going up; null clears a rate or a plan', issues: b.error.issues });
    // The cut points must go up, judged on the result (moving M alone below S is as wrong as sending both): a refused body changes nothing.
    const cuts = { ...reports.worth().cuts, ...b.data.cuts };
    if (!(cuts.S < cuts.M && cuts.M < cuts.L)) return reply.code(400).send({ error: 'cut points go up: S is below M, and M is below L', cuts });
    return reports.setWorth(b.data);
  });

  app.put('/api/worth/size', async (req, reply) => {
    const b = Size.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'give a project, a PR number, and size: S, M, L, XL, skip, or null to take it back', issues: b.error.issues });
    // On the project's merged PR (a PR only a session mentioned is not one): every project row with the name, like a goal.
    const { changes } = run(store, 'UPDATE pull_requests SET size = :size WHERE number = :number AND project_id IN (SELECT id FROM projects WHERE name = :project)', b.data);
    return Number(changes) ? b.data : reply.code(404).send({ error: 'no such merged PR' });
  });
}
