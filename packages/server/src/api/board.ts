import { branchIssue } from '@agent-orb/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContentStore } from '../content-store.ts';
import { each, get, type Store } from '../store/store.ts';
import { openIssues, sessionLinks, windowIssue, type Link } from './budget.ts';
import { openPrs } from './factory.ts';

// v0.4 slice 6 (#32, Factory; PROJECT.md §15, 2026-11-03): each issue of a milestone, followed from queued to merged on one board.
//   GET /api/board?project=<name>[&milestone=<title>]  the chosen milestone's open issues (and its closed ones whose PR merged) and any issue in flight outside it, each with its stage, its readiness and its sessions
// The cost of each issue is not here: it is GET /api/budget's, which the page already reads and joins by issue number. Working it out here too doubled the pass over a project's requests and took the soak
// 70 MB over (the board's own work is a few milliseconds).
// A stage is read from what the agents did, never from an agent's name: a file written, a findings report by a reviewer, a test run on the PR's head, ready(), a merge. Nothing is stored for it; it is worked out here, on read.
// A session reaches an issue by slice 2's rule alone (budget.ts): its branch names the issue, and then it reaches that issue only; else a PR it linked names it, its writes counted in that PR's window.

const Query = z.object({ project: z.string().min(1), milestone: z.string().min(1).max(200).optional() });
const FLIGHT_MS = 7 * 86_400_000; // an issue outside the milestone shows while a session reached it this week and its PR is not merged
const SESSIONS_SHOWN = 12;

export const STAGES = ['queued', 'building', 'reviewing', 'fixing', 'gate', 'ready', 'merged'] as const;
export type Stage = (typeof STAGES)[number];

// A session's writes: the tool calls of its agents that touched a file in write mode. The main agent's and every subagent's, since an agent in a session on the issue wrote it.
const WRITES = `FROM agents a JOIN turns t ON t.agent_id = a.id JOIN tool_calls c ON c.turn_id = t.id
  WHERE a.session_id = :id AND EXISTS (SELECT 1 FROM files_touched f WHERE f.tool_use_id = c.tool_use_id AND f.mode = 'write')`;

/**
 * The PRs a project has a row for, which is not only those gh listed as merged: a PR's row is made by the open-PR read and by a session's link too, and then has no project_id, only the project's id
 * in front of its number. So they are found by the range of that key (`id >= 'p:' AND id < 'p;'`, a primary-key search), not by joining on `p.id || ':' || number`, which made SQLite scan every PR of every
 * project. The last term keeps another project whose id merely begins with this one's from reading this one's rows.
 */
export const PRS_OF = `SELECT r.number AS number, r.issue AS issue, r.head AS head, r.merged_at AS mergedAt FROM projects p
  JOIN pull_requests r ON r.id >= p.id || ':' AND r.id < p.id || ';' AND r.id = p.id || ':' || r.number WHERE p.name = :project`;

/** A session that reaches issues: `issues` are those it reaches (its branch's alone, else those of the PRs it linked), and `at` its own last event, which is how recently it reached each. */
type Reach = { id: string; branch: string | null; at: number; own: number | null; links: Link[]; issues: Set<number> };
type PrRow = { number: number; head: string | null; mergedAt: number | null };

export function boardOf(store: Store, content: ContentStore, project: string, chosenParam: string | undefined, now: number) {
  const week = now - FLIGHT_MS;

  // The issues as the plugin last read them: the open ones, and those that have left the list since, with the milestone and title they had.
  const open = openIssues(store, project);
  const isOpen = (issue: number) => open.get(issue)?.goneAt === null;
  const isGone = (issue: number) => open.get(issue)?.goneAt != null;

  // Who reached what. Streamed: a project's sessions are many, and only those that reach an issue the plugin has read, or any issue this week, are kept. A session is as recent as its own last event:
  // a PR it linked long after the PR opened counts from today. ponytail: so a long session that linked several PRs reaches all their issues until it goes quiet, as it reaches each by one time.
  const reaches: Reach[] = [];
  const touched = new Map<number, number>(); // an open issue → the last a session touched it
  let mode: string | null = null; // the Content mode of the project's newest session that recorded one: what the page says about titles
  let modeAt = -1;
  for (const s of each(store, `SELECT s.id AS id, s.branch AS branch, s.content AS content, coalesce(s.seen_at, s.ended_at, s.started_at, 0) AS at,
      (SELECT count(*) FROM session_prs sp WHERE sp.session_id = s.id) AS links
    FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.name = :project`, { project })) {
    if (s.content && s.at >= modeAt) (mode = s.content), (modeAt = s.at);
    const own = branchIssue(s.branch);
    const links = own === null && s.links ? sessionLinks(store, s.id) : [];
    const issues = new Set<number>();
    if (own !== null) issues.add(own);
    else for (const l of links) if (l.issue !== null) issues.add(l.issue);
    for (const issue of issues) if (isOpen(issue)) touched.set(issue, Math.max(touched.get(issue) ?? 0, s.at));
    if ([...issues].some((issue) => open.has(issue) || s.at >= week)) reaches.push({ id: s.id, branch: s.branch, at: s.at, own, links, issues });
  }

  // The milestones of the open issues, and the one to show: asked for, else the one with the most issues a session touched this week, then the most open, then the first by name.
  const counts = new Map<string, { open: number; touched: number }>();
  for (const [number, o] of open) {
    if (o.milestone === null || o.goneAt !== null) continue;
    const c = counts.get(o.milestone) ?? counts.set(o.milestone, { open: 0, touched: 0 }).get(o.milestone)!;
    c.open++;
    if ((touched.get(number) ?? 0) >= week) c.touched++;
  }
  const milestone = chosenParam ?? [...counts].toSorted(([an, a], [bn, b]) => b.touched - a.touched || b.open - a.open || (an < bn ? -1 : 1))[0]?.[0] ?? null;

  // The PRs the project has been seen to have for an issue: the number the open-PR read gave, else the number in a merged PR's branch (the plugin reads a branch first too, and a PR merged
  // before any read saw it open has no other). The open ones with their verdicts come from slice 1.
  const prsOf = new Map<number, PrRow[]>();
  for (const r of each(store, PRS_OF, { project })) {
    const issue = r.issue ?? branchIssue(r.head);
    if (issue !== null) prsOf.set(issue, [...(prsOf.get(issue) ?? []), { number: r.number, head: r.head, mergedAt: r.mergedAt }]);
  }
  const openOf = new Map<number, ReturnType<typeof openPrs>['prs']>();
  for (const p of openPrs(store, content, now, project, null, false).prs) if (p.issue !== null) openOf.set(p.issue, [...(openOf.get(p.issue) ?? []), p]);
  const newest = <T extends { number: number }>(list: T[] | undefined) => list?.reduce<T | undefined>((a, b) => (a && a.number > b.number ? a : b), undefined);
  /** The issue's merged PR, when it is the newest it has: a newer open PR means it is in flight again. */
  const mergedPr = (issue: number) => {
    const m = newest(prsOf.get(issue)?.filter((p) => p.mergedAt !== null));
    const o = newest(openOf.get(issue));
    return m && (!o || m.number > o.number) ? m : undefined;
  };

  // The issues to show: the chosen milestone's open ones, and its closed ones whose PR merged; and any other a session reached this week that is open or unknown to the plugin's reads and whose PR has
  // not merged. A closed issue whose PR did not merge (a duplicate, a decision not to) leaves the board.
  const shown = new Map<number, boolean>(); // → outside the milestone
  for (const [number, o] of open) if (milestone !== null && o.milestone === milestone && (o.goneAt === null || mergedPr(number))) shown.set(number, false);
  for (const r of reaches) if (r.at >= week) for (const issue of r.issues) if (!shown.has(issue) && !isGone(issue) && !mergedPr(issue)) shown.set(issue, true);

  // The last file written for each shown issue: all of a session's on the issue's branch, else those inside the window of a PR the session linked.
  const lastWrite = new Map<number, number>();
  const bump = (issue: number, ts: number) => lastWrite.set(issue, Math.max(lastWrite.get(issue) ?? 0, ts));
  for (const r of reaches) {
    if (![...r.issues].some((i) => shown.has(i))) continue;
    if (r.own !== null) {
      const last = get(store, `SELECT max(c.ts) AS last ${WRITES}`, { id: r.id })?.last;
      if (last != null) bump(r.own, last);
    } else {
      for (const w of each(store, `SELECT c.ts AS ts ${WRITES}`, { id: r.id })) {
        const issue = windowIssue(r.links, w.ts);
        if (issue !== null) bump(issue, w.ts);
      }
    }
  }
  // The last review each ref (a PR as `pr:416`, or a branch) has had: the reviewer's report, which the writer marks. A report by an agent that wrote code (a fixer saying what it did) is not a review.
  const reviewedAt = new Map<string, number>();
  for (const r of each(store, 'SELECT f.ref AS ref, f.reviewed_at AS ts FROM finding_reports f JOIN projects p ON p.id = f.project_id WHERE p.name = :project AND f.reviewed_at IS NOT NULL', { project })) {
    reviewedAt.set(r.ref, Math.max(reviewedAt.get(r.ref) ?? 0, r.ts));
  }

  const rows = [...shown].map(([number, outside]) => {
    const sessions = reaches.filter((r) => r.issues.has(number)).toSorted((a, b) => b.at - a.at);
    const pr = newest(openOf.get(number));
    const merged = mergedPr(number);
    // Where a findings report for this issue can have been filed: the PRs it has had by number (an open PR's row is among them), the branches of those, and the branches of the sessions on it.
    const refs = [...(prsOf.get(number) ?? []).flatMap((p) => [`pr:${p.number}`, ...(p.head ? [p.head] : [])]), ...(openOf.get(number) ?? []).flatMap((p) => (p.head ? [p.head] : [])),
      ...sessions.flatMap((s) => (s.own === number && s.branch ? [s.branch] : []))];
    const review = Math.max(0, ...refs.map((r) => reviewedAt.get(r) ?? 0)) || undefined;
    const written = lastWrite.get(number);

    // The latest stage that holds. Queued: no session reached it and it has no open PR. Fixing is a file written after the reviewer's last report (a fix needs a review before it); Gate a test run on
    // the PR's head newer than both the last file written and that report (an earlier run tested code that has since changed, or was run before the review); Ready is slice 1's ready(); Merged the PR's merge.
    let stage: Stage = 'queued';
    if (merged) stage = 'merged';
    else {
      if (sessions.length || pr) stage = 'building';
      if (review !== undefined) stage = written !== undefined && written > review ? 'fixing' : 'reviewing';
      if (pr?.gate && pr.gate.ts >= Math.max(written ?? 0, review ?? 0)) stage = 'gate';
      if (pr?.ready) stage = 'ready';
    }
    const known = open.get(number);
    return {
      number, ...(known?.title ? { title: known.title } : {}), ...(known ? { milestone: known.milestone } : {}), outside, stage,
      // a failed test run or check on the head, at the stage where it is the thing to look at: the track turns red
      ...(stage === 'gate' && pr?.conditions.gate.ok === false ? { bad: true as const } : {}),
      pr: merged ? { number: merged.number, head: merged.head, merged: true } : pr ? { number: pr.number, head: pr.head, merged: false } : null,
      ready: merged || !pr ? null : pr.ready, reason: merged || !pr ? null : pr.reason,
      sessions: sessions.slice(0, SESSIONS_SHOWN).map((s) => ({ id: s.id, at: s.at })), sessionCount: sessions.length,
      latest: sessions[0]?.at ?? 0,
    };
  });
  // The ones being worked first, the newest session on top; then the merged; then the queued (the mockup's order).
  const group = (r: (typeof rows)[number]) => (r.stage === 'merged' ? 1 : r.stage === 'queued' ? 2 : 0);
  rows.sort((a, b) => group(a) - group(b) || b.latest - a.latest || b.number - a.number);

  return {
    project, milestone, content: mode, milestones: [...counts].map(([name, c]) => ({ name, open: c.open })).toSorted((a, b) => (a.name < b.name ? -1 : 1)),
    issues: rows.map(({ latest, ...r }) => r),
  };
}

export function board(app: FastifyInstance, { store, content, now = Date.now }: { store: Store; content: ContentStore; now?: () => number }) {
  app.get('/api/board', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a project', issues: q.error.issues });
    return boardOf(store, content, q.data.project, q.data.milestone, now());
  });
}
