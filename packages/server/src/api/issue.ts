import { UNCOUNTED } from '@agent-orb/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContentStore } from '../content-store.ts';
import { all, get, type Row, type Store } from '../store/store.ts';
import { budgetOf, openIssues, windowIssue } from './budget.ts';
import { reachOf, refsOf, stageOf, STAGES, verdict, type Stage, type StageFacts } from './board.ts';
import { openPrs } from './factory.ts';
import { zone } from './ledger.ts';
import { linksOf } from './links.ts';

// v0.5 slice 2 (#106, Follow; the plan is #64): the page of one issue, worked out on read from rows already stored.
//   GET /api/issue?project=<name>&issue=<N>[&tz=]  where it stands, its story (one line per agent run, oldest first, and a PR opening or merging), when each stage was first reached and came round again,
//                                                  its PR's checks and findings as /api/factory gives them, its cost as /api/budget gives it, its links and its sessions
// A stage is never stored: each moment of the story (a file written, a reviewer's round, a session or PR beginning, the gate, readiness, the merge) is put through the board's own rule, stageOf(), over
// what had happened by then, so the story's last stage and the board's stage cannot differ. A session reaches the issue by the board's rule (reachOf).

const Query = z.object({ project: z.string().min(1), issue: z.coerce.number().int().positive().max(999_999_999), tz: zone.default('UTC') });
const PATHS_SHOWN = 20;

type Round = { ref: string; at: number; agent: string; reviewer: boolean; open: number; dropped: number };
const newest = <T extends { number: number }>(list: T[] | undefined) => list?.reduce<T | undefined>((a, b) => (a && a.number > b.number ? a : b), undefined);

export function issueOf(store: Store, content: ContentStore, project: string, number: number, tz: string, now: number) {
  const known = openIssues(store, project).get(number);
  const reach = reachOf(store, content, project, known?.milestone ?? undefined, now);
  const { open, reaches, mode, prsOf, openOf, mergedPr, shown } = reach;
  const sessions = reaches.filter((r) => r.issues.has(number)).toSorted((a, b) => b.at - a.at);
  const prs = prsOf.get(number) ?? [];
  if (!known && !prs.length && !openOf.has(number) && !sessions.length) return null;
  const openPr = newest(openOf.get(number));
  const merged = mergedPr(number);

  // The findings rounds filed where this issue's reports go (the board's refs), and the reviewers' times the board reads (a round before finding_rounds is only in finding_reports).
  const refs = [...new Set(refsOf(number, prsOf, openOf, sessions))];
  const rounds: Round[] = [];
  const reviews: number[] = [];
  for (const ref of refs) {
    for (const r of all(store, `SELECT r.ts AS at, r.agent_id AS agent, r.reviewer AS reviewer, r.open AS open, r.dropped AS dropped FROM finding_rounds r JOIN projects p ON p.id = r.project_id
      WHERE p.name = :project AND r.ref = :ref`, { project, ref })) rounds.push({ ref, at: r.at, agent: r.agent, reviewer: Boolean(r.reviewer), open: r.open, dropped: r.dropped });
    for (const r of all(store, `SELECT f.reviewed_at AS ts FROM finding_reports f JOIN projects p ON p.id = f.project_id WHERE p.name = :project AND f.ref = :ref AND f.reviewed_at IS NOT NULL`, { project, ref })) reviews.push(r.ts);
  }
  for (const r of rounds) if (r.reviewer) reviews.push(r.at);

  // What happened, as moments for the stage rule; and the runs of the sessions on the issue.
  const moments: { ts: number; order: number; apply: (f: StageFacts) => void }[] = [];
  const moment = (ts: number, order: number, apply: (f: StageFacts) => void) => moments.push({ ts, order, apply });
  for (const ts of reviews) moment(ts, 2, (f) => (f.review = Math.max(f.review ?? 0, ts)));
  type Run = { at: number; session: string; agent: { id: string; type: string | null; role: string | null; model: string | null }; paths: string[]; tests: { runs: number; failed: number }; usd: number; partial: boolean };
  const runs: Run[] = [];
  for (const r of sessions) {
    // A session on the issue's branch is on it whole; any other is on it where a PR window says so (the cost's rule, windowIssue).
    const inIssue = (ts: number) => r.own !== null || windowIssue(r.links, ts) === number;
    const s = get(store, 'SELECT started_at AS startedAt, source, recorded FROM sessions WHERE id = :id', { id: r.id });
    const writes = all(store, `SELECT a.id AS agent, c.ts AS ts, f.path AS path FROM agents a JOIN turns t ON t.agent_id = a.id JOIN tool_calls c ON c.turn_id = t.id
      JOIN files_touched f ON f.tool_use_id = c.tool_use_id AND f.mode = 'write' WHERE a.session_id = :id ORDER BY c.ts, f.path`, { id: r.id });
    const tests = all(store, `SELECT a.id AS agent, c.ts AS ts, c.success AS success FROM agents a JOIN turns t ON t.agent_id = a.id JOIN tool_calls c ON c.turn_id = t.id
      WHERE a.session_id = :id AND c.command_class = 'test'`, { id: r.id });
    const costs = all(store, `SELECT a.id AS agent, x.ts AS ts, x.cost_usd AS usd FROM agents a JOIN turns t ON t.agent_id = a.id JOIN api_requests x ON x.turn_id = t.id WHERE a.session_id = :id`, { id: r.id });
    for (const w of writes) if (inIssue(w.ts)) moment(w.ts, 1, (f) => (f.written = Math.max(f.written ?? 0, w.ts)));
    const own = [...writes, ...tests, ...costs].filter((x) => inIssue(x.ts));
    // The board's `exists`: a session reached the issue. For one reached through a window, from its first request inside it.
    moment(r.own !== null ? (s?.startedAt ?? r.at) : (own.length ? Math.min(...own.map((x) => x.ts)) : r.at), 0, (f) => (f.exists = true));
    for (const a of all(store, `SELECT a.id AS id, a.type AS type, a.role AS role, a.model AS model, a.started_at AS startedAt, (SELECT min(t.started_at) FROM turns t WHERE t.agent_id = a.id) AS firstTurn
      FROM agents a WHERE a.session_id = :id AND EXISTS (SELECT 1 FROM turns t WHERE t.agent_id = a.id)`, { id: r.id })) {
      const mine = (rows: Row[]) => rows.filter((x) => x.agent === a.id && inIssue(x.ts));
      const all3 = [...writes, ...tests, ...costs].filter((x) => x.agent === a.id);
      const at = a.startedAt ?? a.firstTurn ?? (all3.length ? Math.min(...all3.map((x) => x.ts)) : null);
      if (at === null || !inIssue(at)) continue;
      const w = mine(writes).filter((x) => !UNCOUNTED.test(x.path)).map((x) => x.path);
      const c = mine(costs);
      runs.push({
        at, session: r.id, agent: { id: a.id, type: a.type, role: a.role, model: a.model }, paths: [...new Set(w)],
        tests: { runs: mine(tests).length, failed: mine(tests).filter((x) => x.success === 0).length }, usd: c.reduce((n, x) => n + (x.usd ?? 0), 0), partial: c.some((x) => x.usd === null),
      });
    }
    // keep the session's own facts for the sessions list below
    Object.assign(r, { imported: s?.source === 'import' && !s.recorded });
  }

  // The PR's times, and the open PR's gate and readiness (known for its current head only).
  // ponytail: the gate and Ready are known only for the PR's current head: past heads and past readiness aren't stored, so each shows one time, when its last condition was met (the gate's run, the
  // latest findings report), and never comes round again. Upgrade: record each head a read sees, with the time.
  const created = openPr ? prs.find((p) => p.number === openPr.number)?.createdAt ?? null : null;
  if (openPr) moment(created ?? now, 0, (f) => (f.exists = true));
  if (openPr?.gate) {
    const g = openPr.gate.ts;
    moment(g, 3, (f) => (f.gate = g));
    if (openPr.ready) moment(Math.max(g, openPr.reportAt ?? 0), 4, (f) => (f.ready = true));
  } else if (openPr?.ready) moment(Math.max(openPr.reportAt ?? 0, created ?? 0), 4, (f) => (f.ready = true));
  if (merged?.mergedAt != null) { const at = merged.mergedAt; moment(at, 5, (f) => (f.merged = true)); }

  // The stage after each moment, in time order; one entry per moment, so a stage's time is its event's.
  const timeline: { ts: number; stage: Stage }[] = [];
  const facts: StageFacts = { exists: false };
  for (const m of moments.toSorted((a, b) => a.ts - b.ts || a.order - b.order)) {
    m.apply(facts);
    timeline.push({ ts: m.ts, stage: stageOf(facts) });
  }
  // A merge the board knows without a time (a merged PR with no merge time) still is the stage now.
  const stage = merged && merged.mergedAt == null ? ('merged' as const) : stageOf(facts);
  const stageAt = (t: number) => timeline.findLast((e) => e.ts <= t)?.stage ?? 'queued';

  // Each stage's first time and the later times it came round again: the changes of the timeline's stage.
  const seen = new Map<Stage, { at: number | null; again: number[] }>(STAGES.map((s) => [s, { at: null, again: [] }]));
  seen.get('queued')!.at = known?.openedAt ?? null;
  let prev: Stage = 'queued';
  for (const e of timeline) {
    if (e.stage === prev) continue;
    const t = seen.get(e.stage)!;
    if (t.at === null) t.at = e.ts;
    else t.again.push(e.ts);
    prev = e.stage;
  }

  // The lines, oldest first. A line's stage is the one the issue was in when the next line began (the last line: now).
  type Line = Record<string, unknown> & { at: number };
  const lines: Line[] = [];
  const runIds = new Set(runs.map((r) => r.agent.id));
  for (const r of runs) {
    lines.push({ kind: 'run', at: r.at, session: r.session, agent: r.agent, wrote: { paths: r.paths.slice(0, PATHS_SHOWN), count: r.paths.length }, tests: r.tests,
      rounds: rounds.filter((x) => x.agent === r.agent.id).map(({ ref, agent, ...x }) => x), usd: r.usd, partial: r.partial });
  }
  for (const x of rounds) if (!runIds.has(x.agent)) lines.push({ kind: 'round', at: x.at, agent: x.agent, reviewer: x.reviewer, open: x.open, dropped: x.dropped });
  for (const p of prs) {
    if (p.createdAt != null) lines.push({ kind: 'pr-open', at: p.createdAt, pr: p.number });
    if (p.mergedAt != null) lines.push({ kind: 'pr-merged', at: p.mergedAt, pr: p.number });
  }
  lines.sort((a, b) => a.at - b.at);
  const story = lines.map((l, i) => ({ ...l, stage: i === lines.length - 1 ? stage : stageAt(Math.max(l.at, lines[i + 1]!.at - 1)) }));

  // The PR's checks and findings are /api/factory's, the cost /api/budget's, the links /api/links'.
  const checks = openPr ? (({ projectId, gate, reportAt, ...p }) => p)(openPrs(store, content, now, project, null).prs.find((p) => p.number === openPr.number)!) : null;
  const cost = budgetOf(store, project, tz, now).issues.find((i) => i.number === number) ?? null;
  const links = linksOf(store, content, project, known?.milestone ?? undefined, now, reach).links.filter((l) => l.a === number || l.b === number)
    .map((l) => ({ ...l, title: open.get(l.a === number ? l.b : l.a)?.title ?? null })); // the other issue's title, when the plugin sent one
  // Mentions of issues that are not on the milestone's map show here only (#64): the ones this issue's text names, and the ones whose text names it.
  const names = (text: string | null) => JSON.parse(text ?? '[]') as number[];
  const mentions = [
    ...[...new Set(names(known?.mentions ?? null))].filter((m) => m !== number && !shown.has(m)).map((m) => ({ issue: m, direction: 'out' as const, title: open.get(m)?.title ?? null })),
    ...[...open].filter(([m, o]) => !shown.has(m) && m !== number && names(o.mentions).includes(number)).map(([m, o]) => ({ issue: m, direction: 'in' as const, title: o.title })),
  ];
  const readAt = openPrs(store, content, now, project, null, false).readAt;

  return {
    project, content: mode, readAt,
    issue: {
      number, title: known?.title ?? null, milestone: known?.milestone ?? null, stage, ...verdict(stage, openPr, merged), openedAt: known?.openedAt ?? null,
      pr: merged ? { number: merged.number, head: merged.head, merged: true } : openPr ? { number: openPr.number, head: openPr.head, merged: false } : null,
    },
    story, stages: STAGES.map((s) => ({ stage: s, ...seen.get(s)! })), checks, cost, links, mentions,
    sessions: sessions.map((s) => ({ id: s.id, branch: s.branch, at: s.at, windowOnly: s.own === null, imported: Boolean((s as { imported?: boolean }).imported) })),
  };
}

export function issue(app: FastifyInstance, { store, content, now = Date.now }: { store: Store; content: ContentStore; now?: () => number }) {
  app.get('/api/issue', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a project and an issue number', issues: q.error.issues });
    const page = issueOf(store, content, q.data.project, q.data.issue, q.data.tz, now());
    return page ?? reply.code(404).send({ error: 'the project has no such issue' });
  });
}
