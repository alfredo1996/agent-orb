import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContentStore } from '../content-store.ts';
import { all, each, type Store } from '../store/store.ts';
import { lastWrites, newest, reachOf, readyAt, refsOf, reviewedAtOf } from './board.ts';
import { projectsByRecent, RECENT_MS } from './home.ts';

// v0.5 slice 4 (#108, Follow; the plan is #64): what changed across the projects Home shows (a session in the past 30 days) since a time, worked out on read from times already stored. Nothing is kept for it.
//   GET /api/changes?since=<ms>  newest first, at most 50, and how many there were: { total, changes: [{ at, kind, project, issue, title?, pr?, who?, open?, sha?, branch? }] }
// kinds and their times: opened (the PR's created_at, else the first time a session linked it), merged (merged_at), reviewed and reviewed-again (a reviewer's finding_rounds row; again when it is not the ref's first),
// gate (a passing test run on the open PR's head, not older than the issue's last write or review), ready (ready now: the later of its gate and its findings report), picked-up (a session that started on an issue).
// `open`, `sha` and `branch` are what the studio's sub line says, from rows the query already has. A stall is not here: it is in /stream only, and the studio adds it.
// A title is the one the plugin sent with Content on, so a project without it is listed by number, as on the board. A change is after the mark: `at > since`.
// ponytail: an issue that became ready and stopped being ready before the owner looked is not listed (no readiness history is kept), and ready's time is the later of the gate and the report, not of the read that saw
// the other two conditions. Upgrade: record when ready() first holds for each head.
// ponytail: each ask redoes Home's pass over the sessions (reachOf) and reads every finding round and session-PR link of the projects; measured on a 160 MB history, 8 ms warm and 17 ms cold, so kept. The rounds cannot be
// bounded by `since` (whether one is a review again needs the earlier ones). Upgrade if it grows: share Home's reachOf pass with /api/home, or keep each issue's first review time.

const Query = z.object({ since: z.string().regex(/^\d{1,16}$/).transform(Number) });
const LIMIT = 50;
export type Change = { at: number; kind: string; project: string; issue: number; title?: string; pr?: number; who?: string; open?: number; sha?: string; branch?: string };

export function changesOf(store: Store, content: ContentStore, since: number, now: number) {
  const out: Change[] = [];
  for (const { name, last } of projectsByRecent(store)) {
    if (last < now - RECENT_MS) continue;
    const reach = reachOf(store, content, name, undefined, now);
    const { open, reaches, prsOf, openOf } = reach;
    const add = (c: Omit<Change, 'project' | 'title'>) => {
      if (c.at > since) out.push({ ...c, project: name, ...(open.get(c.issue)?.title ? { title: open.get(c.issue)!.title! } : {}) } as Change);
    };
    const issuesWithWork = new Set([...prsOf.keys(), ...openOf.keys(), ...reaches.flatMap((r) => [...r.issues])]);

    // PRs: opened and merged. A PR the latest read lists open is not merged, whatever merge time its number carries (as the issue page reads it).
    const linked = new Map<number, number>(); // PR number → the first time a session linked it, for a PR no read saw open
    for (const r of all(store, `SELECT r.number AS number, min(sp.ts) AS ts FROM projects p JOIN pull_requests r ON r.id >= p.id || ':' AND r.id < p.id || ';' AND r.id = p.id || ':' || r.number
      JOIN session_prs sp ON sp.pr_id = r.id WHERE p.name = :project AND sp.ts IS NOT NULL GROUP BY r.number`, { project: name })) linked.set(r.number, r.ts);
    const prOfRef = new Map<string, number>(); // a branch → its PR
    for (const [issue, prs] of prsOf) {
      const stillOpen = new Set((openOf.get(issue) ?? []).map((p) => p.number));
      for (const p of prs) {
        if (p.head) prOfRef.set(p.head, p.number);
        const opened = p.createdAt ?? linked.get(p.number);
        if (opened != null) add({ at: opened, kind: 'opened', issue, pr: p.number });
        if (p.mergedAt != null && !stillOpen.has(p.number)) add({ at: p.mergedAt, kind: 'merged', issue, pr: p.number });
      }
    }
    for (const [, prs] of openOf) for (const p of prs) if (p.head) prOfRef.set(p.head, p.number);

    // Reviews: a reviewer's round on any ref the issue's reports go to.
    const issueOfRef = new Map<string, number>();
    for (const issue of issuesWithWork) {
      for (const ref of refsOf(issue, prsOf, openOf, reaches.filter((r) => r.issues.has(issue)))) if (!issueOfRef.has(ref)) issueOfRef.set(ref, issue);
    }
    const seen = new Set<number>(); // the issues whose first reviewer round has come by, whichever ref it named
    for (const r of all(store, `SELECT r.ref AS ref, r.ts AS ts, r.open AS open, substr(r.agent_id, instr(r.agent_id, ':') + 1) AS who FROM finding_rounds r JOIN projects p ON p.id = r.project_id
      WHERE p.name = :project AND r.reviewer = 1 ORDER BY r.ts, r.agent_id`, { project: name })) {
      const issue = issueOfRef.get(r.ref);
      if (issue === undefined) continue;
      const again = seen.has(issue);
      seen.add(issue);
      const pr = r.ref.startsWith('pr:') ? Number(r.ref.slice(3)) : prOfRef.get(r.ref);
      add({ at: r.ts, kind: again ? 'reviewed-again' : 'reviewed', issue, ...(pr !== undefined ? { pr } : {}), who: r.who, open: r.open });
    }

    // Ready: as the issue page has it, with or without a test run of the plugin's. When the report came before the test run, ready is the one change: the board shows Ready, not the gate.
    const readyNow = new Map<number, number>();
    for (const [issue, prs] of openOf) {
      const p = newest(prs);
      if (!p?.ready) continue;
      const at = readyAt(p, prsOf.get(issue)?.find((x) => x.number === p.number)?.createdAt ?? null);
      readyNow.set(issue, at);
      add({ at, kind: 'ready', issue, pr: p.number });
    }

    // The gate and readiness of the open PRs (known for the current head only).
    const withGate = [...openOf].flatMap(([issue, prs]) => (newest(prs)?.gate ? [[issue, newest(prs)!] as const] : []));
    const reachedGate = withGate.filter(([, p]) => p.gate!.result === 'pass' && p.gate!.ts > since);
    const written = reachedGate.length ? lastWrites(store, reaches, (i) => reachedGate.some(([x]) => x === i)) : new Map<number, number>();
    const reviewed = reachedGate.length ? reviewedAtOf(store, name) : new Map<string, number>();
    for (const [issue, p] of reachedGate) {
      const review = Math.max(0, ...refsOf(issue, prsOf, openOf, reaches.filter((r) => r.issues.has(issue))).map((r) => reviewed.get(r) ?? 0));
      if (p.gate!.ts >= Math.max(written.get(issue) ?? 0, review) && readyNow.get(issue) !== p.gate!.ts) add({ at: p.gate!.ts, kind: 'gate', issue, pr: p.number, sha: p.headOid.slice(0, 7) });
    }

    // Picked up: a session that started after the mark and reaches an issue; one on no issue is not a change.
    const byId = new Map(reaches.map((r) => [r.id, r]));
    for (const s of each(store, 'SELECT s.id AS id, s.started_at AS at, s.branch AS branch FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.name = :project AND s.started_at > :since', { project: name, since })) {
      for (const issue of byId.get(s.id)?.issues ?? []) add({ at: s.at, kind: 'picked-up', issue, ...(s.branch ? { branch: s.branch } : {}) });
    }
  }
  // `total` is how many there were: the list is cut at LIMIT, and the studio says so.
  return { changes: out.toSorted((a, b) => b.at - a.at || a.project.localeCompare(b.project) || a.issue - b.issue || a.kind.localeCompare(b.kind)).slice(0, LIMIT), total: out.length };
}

export function changes(app: FastifyInstance, { store, content, now = Date.now }: { store: Store; content: ContentStore; now?: () => number }) {
  app.get('/api/changes', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give since as a time in milliseconds', issues: q.error.issues });
    return changesOf(store, content, q.data.since, now());
  });
}
