import { UNCOUNTED } from '@agent-orb/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContentStore } from '../content-store.ts';
import { all, get, type Row, type Store } from '../store/store.ts';
import { budgetOf, openIssues, windowIssue } from './budget.ts';
import { boardOf, newest, reachOf, refsOf, stageOf, STAGES, verdict, type Stage, type StageFacts } from './board.ts';
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

export function issueOf(store: Store, content: ContentStore, project: string, number: number, tz: string, now: number) {
  const open = openIssues(store, project);
  const known = open.get(number);
  const reach = reachOf(store, content, project, known?.milestone ?? undefined, now, { detail: true, open }); // the open PRs with their findings, read once: the page shows one's checks
  const { reaches, mode, prsOf, openOf, mergedPr, shown, readAt } = reach;
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
  type Own = { writes: Row[]; tests: Row[]; costs: Row[]; first: number; last: number }; // an agent's rows on the issue
  type Run = { at: number; last: number; session: string; agent: { id: string; type: string | null; role: string | null; model: string | null }; paths: string[]; tests: { runs: number; failed: number }; usd: number; partial: boolean };
  const runs: Run[] = [];
  const info = new Map<string, { imported: boolean; startedAt: number | null }>();
  for (const r of sessions) {
    // A session on the issue's branch is on it whole; any other is on it where a PR window says so (the cost's rule, windowIssue).
    const inIssue = (ts: number) => r.own !== null || windowIssue(r.links, ts) === number;
    const s = get(store, 'SELECT started_at AS startedAt, source, recorded FROM sessions WHERE id = :id', { id: r.id });
    info.set(r.id, { imported: s?.source === 'import' && !s.recorded, startedAt: s?.startedAt ?? null });
    // One pass over each query's rows, grouped by agent: a filter of every row for every agent took 10 s on the soak's 1,301 agents and 47,000 calls.
    const by = new Map<string, Own>();
    let first = Infinity; // the session's first request, file or test run on the issue
    const take = (rows: Row[], kind: 'writes' | 'tests' | 'costs') => {
      for (const x of rows) {
        if (!inIssue(x.ts)) continue;
        const o = by.get(x.agent) ?? by.set(x.agent, { writes: [], tests: [], costs: [], first: x.ts, last: x.ts }).get(x.agent)!;
        o[kind].push(x);
        if (x.ts < o.first) o.first = x.ts;
        if (x.ts > o.last) o.last = x.ts;
        if (x.ts < first) first = x.ts;
      }
    };
    const writes = all(store, `SELECT a.id AS agent, c.ts AS ts, f.path AS path FROM agents a JOIN turns t ON t.agent_id = a.id JOIN tool_calls c ON c.turn_id = t.id
      JOIN files_touched f ON f.tool_use_id = c.tool_use_id AND f.mode = 'write' WHERE a.session_id = :id ORDER BY c.ts, f.path`, { id: r.id });
    take(writes, 'writes');
    take(all(store, `SELECT a.id AS agent, c.ts AS ts, c.success AS success FROM agents a JOIN turns t ON t.agent_id = a.id JOIN tool_calls c ON c.turn_id = t.id
      WHERE a.session_id = :id AND c.command_class = 'test'`, { id: r.id }), 'tests');
    take(all(store, `SELECT a.id AS agent, x.ts AS ts, x.cost_usd AS usd FROM agents a JOIN turns t ON t.agent_id = a.id JOIN api_requests x ON x.turn_id = t.id WHERE a.session_id = :id`, { id: r.id }), 'costs');
    for (const o of by.values()) for (const w of o.writes) moment(w.ts, 1, (f) => (f.written = Math.max(f.written ?? 0, w.ts)));
    // The board's `exists`: a session reached the issue. For one reached through a window, from its first request inside it.
    const sessionAt = r.own !== null ? (s?.startedAt ?? (first === Infinity ? r.at : first)) : first === Infinity ? r.at : first;
    moment(sessionAt, 0, (f) => (f.exists = true));
    for (const a of all(store, `SELECT a.id AS id, a.type AS type, a.role AS role, a.model AS model, a.started_at AS startedAt, (SELECT min(t.started_at) FROM turns t WHERE t.agent_id = a.id) AS firstTurn
      FROM agents a WHERE a.session_id = :id AND EXISTS (SELECT 1 FROM turns t WHERE t.agent_id = a.id)`, { id: r.id })) {
      // An agent is on the issue when any of its rows is (a session on a branch: whenever it started); its run is from its first row on the issue, so the main agent of a session
      // that went on to a second PR is on that PR's issue too, from its first request in the window.
      const o = by.get(a.id);
      const at = r.own !== null ? (a.startedAt ?? a.firstTurn ?? o?.first ?? null) : (o?.first ?? null);
      if (at === null) continue;
      const w = (o?.writes ?? []).filter((x) => !UNCOUNTED.test(x.path)).map((x) => x.path);
      const c = o?.costs ?? [];
      runs.push({
        at, last: Math.max(at, o?.last ?? at), session: r.id, agent: { id: a.id, type: a.type, role: a.role, model: a.model }, paths: [...new Set(w)],
        tests: { runs: o?.tests.length ?? 0, failed: (o?.tests ?? []).filter((x) => x.success === 0).length }, usd: c.reduce((n, x) => n + (x.usd ?? 0), 0), partial: c.some((x) => x.usd === null),
      });
    }
  }

  // The PR's times, and the open PR's gate and readiness (known for its current head only).
  // ponytail: the gate and Ready are known only for the PR's current head: past heads and past readiness aren't stored, so each shows one time, when its last condition was met (the gate's run, the
  // latest findings report), and never comes round again. Upgrade: record each head a read sees, with the time.
  const created = openPr ? prs.find((p) => p.number === openPr.number)?.createdAt ?? null : null;
  if (openPr?.gate) {
    const g = openPr.gate.ts;
    moment(g, 3, (f) => (f.gate = g));
    if (openPr.ready) moment(Math.max(g, openPr.reportAt ?? 0), 4, (f) => (f.ready = true));
  } else if (openPr?.ready) moment(Math.max(openPr.reportAt ?? 0, created ?? 0), 4, (f) => (f.ready = true));
  if (merged?.mergedAt != null) { const at = merged.mergedAt; moment(at, 5, (f) => (f.merged = true)); }
  // An open PR exists from when it opened; one the read gave no time for, from the earliest moment of the issue (else Reviewing would be reached without Building), or now.
  if (openPr) moment(created ?? moments.reduce((t, m) => Math.min(t, m.ts), now), 0, (f) => (f.exists = true));

  // The stage after each moment, in time order; one entry per moment, so a stage's time is its event's.
  const timeline: { ts: number; stage: Stage }[] = [];
  const facts: StageFacts = { exists: false };
  for (const m of moments.toSorted((a, b) => a.ts - b.ts || a.order - b.order)) {
    m.apply(facts);
    timeline.push({ ts: m.ts, stage: stageOf(facts) });
  }
  const stage = stageOf(facts);
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

  // The lines, oldest first. A line's stage is the one the issue was in after the line's own last event (a run's last file, test or request; its rounds), so a run's effect is on its own line.
  // A gate or readiness has no line: the issue can be further on than the last line says, and the track above it says where.
  type Line = Record<string, unknown> & { at: number; last: number };
  const lines: Line[] = [];
  const runIds = new Set(runs.map((r) => r.agent.id));
  for (const r of runs) {
    const mine = rounds.filter((x) => x.agent === r.agent.id);
    lines.push({ kind: 'run', at: r.at, last: Math.max(r.last, ...mine.map((x) => x.at)), session: r.session, agent: r.agent, wrote: { paths: r.paths.slice(0, PATHS_SHOWN), count: r.paths.length }, tests: r.tests,
      rounds: mine.map(({ ref, agent, ...x }) => x), usd: r.usd, partial: r.partial });
  }
  for (const x of rounds) if (!runIds.has(x.agent)) lines.push({ kind: 'round', at: x.at, last: x.at, agent: x.agent, reviewer: x.reviewer, open: x.open, dropped: x.dropped });
  for (const p of prs) {
    if (p.createdAt != null) lines.push({ kind: 'pr-open', at: p.createdAt, last: p.createdAt, pr: p.number });
    if (p.mergedAt != null) lines.push({ kind: 'pr-merged', at: p.mergedAt, last: p.mergedAt, pr: p.number });
  }
  lines.sort((a, b) => a.at - b.at);
  const story = lines.map(({ last, ...l }) => ({ ...l, stage: stageAt(last) }));

  // The PR's checks and findings are /api/factory's, the cost /api/budget's, the links /api/links'.
  const checks = openPr ? (({ projectId, gate, reportAt, ...p }) => p)(openPr) : null;
  // ponytail: budgetOf is the whole project's pass over its requests (70 ms on the soak's 44,000, as /api/budget); one issue's row is read from it so the figures cannot differ. Upgrade: issueCosts for one issue's sessions.
  const cost = budgetOf(store, project, tz, now, open).issues.find((i) => i.number === number) ?? null;
  // The stage of each issue the board shows, for the rows that name another issue.
  const stages = new Map(boardOf(store, content, project, known?.milestone ?? undefined, now, reach).issues.map((i) => [i.number, i.stage]));
  const links = linksOf(store, content, project, known?.milestone ?? undefined, now, reach).links.filter((l) => l.a === number || l.b === number)
    .map((l) => ({ ...l, title: open.get(l.a === number ? l.b : l.a)?.title ?? null, stage: stages.get(l.a === number ? l.b : l.a) ?? null })); // the other issue's title, when the plugin sent one
  // Mentions between this issue and one that is not on the milestone's map show here only (#64); a pair that both show is a link above. The ones this issue's text names, the ones whose text names it,
  // and a pair that name each other once, with `both`, as the Map does.
  const names = (text: string | null) => JSON.parse(text ?? '[]') as number[];
  const out = new Set(names(known?.mentions ?? null).filter((m) => m !== number));
  const into = new Set([...open].filter(([m, o]) => m !== number && names(o.mentions).includes(number)).map(([m]) => m));
  const mentions = [...out, ...[...into].filter((m) => !out.has(m))].filter((m) => !(shown.has(m) && shown.has(number))).map((m) => ({
    issue: m, direction: out.has(m) ? ('out' as const) : ('in' as const), ...(out.has(m) && into.has(m) ? { both: true as const } : {}), title: open.get(m)?.title ?? null,
    stage: stages.get(m) ?? null, known: open.has(m), // an issue the plugin never read has no page to open
  }));

  return {
    project, content: mode, readAt,
    issue: {
      number, title: known?.title ?? null, milestone: known?.milestone ?? null, stage, ...verdict(stage, openPr, merged), openedAt: known?.openedAt ?? null,
      pr: merged ? { number: merged.number, head: merged.head, merged: true } : openPr ? { number: openPr.number, head: openPr.head, merged: false } : null,
    },
    story, stages: STAGES.map((s) => ({ stage: s, ...seen.get(s)! })), checks, cost, links, mentions,
    sessions: sessions.map((s) => ({ id: s.id, branch: s.branch, at: s.at, startedAt: info.get(s.id)?.startedAt ?? null, windowOnly: s.own === null, imported: info.get(s.id)?.imported ?? false })),
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
