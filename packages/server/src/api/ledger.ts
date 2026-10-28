import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AnalysisStore } from '../analysis-store.ts';
import { all, type Row, type Store } from '../store/store.ts';
import { bucketSql, localDate } from './local-time.ts';

// GET /api/ledger (PROJECT.md §8.2): tokens first, then API-equivalent cost, over [from, to),
// per day/week/month in the viewer's time zone, by project, model and role, plus efficiency per project.
// The studio sends from/to as epoch ms, so "today" and "7 days" are the viewer's own.

/**
 * The longest a person is taken to have been at a screen: a gap between two prompts under it is the owner working (Worth's attention), and a wait at a permission dialog
 * counts at most this long (Totals, Worth), because a dialog left open longer means nobody was there (#76, #102).
 */
export const WINDOW_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;

export const zone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'unknown time zone');

const Query = z.object({
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().positive(),
  unit: z.enum(['day', 'week', 'month']).default('day'),
  tz: zone.default('UTC'),
  project: z.string().min(1).optional(),
}).refine((q) => q.to > q.from, 'to must be after from');

// A request or a call with the agent that made it, the session and the project: the walk the graph made, as joins on keys. A query takes only as much of it as
// it reads, and all of it when it is for one project.
const AGENT = 'JOIN turns t ON t.id = x.turn_id JOIN agents a ON a.id = t.agent_id';
const CHAIN = `${AGENT} JOIN sessions s ON s.id = a.session_id JOIN projects p ON p.id = s.project_id`;
const TOKENS = 'x.input + x.output + x.cache_read + x.cache_creation';
// A request on a model pricing.json lacks has no cost: the sum is a floor, and costPartial says so.
const SUMS = `sum(${TOKENS}) AS tokens, coalesce(sum(x.cost_usd), 0) AS cost, count(*) FILTER (WHERE x.cost_usd IS NULL) > 0 AS costPartial`;

export function ledger(app: FastifyInstance, { store, analysis }: { store: Store; analysis?: AnalysisStore }) {
  app.get('/api/ledger', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid query', issues: q.error.issues });
    const { from, to, unit, tz, project = null } = q.data;
    const window = `x.ts >= :from AND x.ts < :to${project ? ' AND p.name = :project' : ''}`;
    const params = project ? { from, to, project } : { from, to };
    const rows = (select: string, from_: string, joins: string, tail = '', p: Record<string, unknown> = params) =>
      all(store, `SELECT ${select} FROM ${from_} x ${project ? CHAIN : joins} WHERE ${window} ${tail}`, p);
    const requests = (select: string, joins: string, tail?: string, p?: Record<string, unknown>) => rows(select, 'api_requests', joins, tail, p);
    const calls = (select: string, tail?: string) => rows(select, 'tool_calls', CHAIN, tail);
    const bool = (r: Row): Row => ({ ...r, costPartial: Boolean(r.costPartial) });

    const totals = requests(`${SUMS}, sum(x.cache_read) AS reads, sum(x.input + x.cache_read + x.cache_creation) AS inputSide, count(DISTINCT a.session_id) AS sessions, count(DISTINCT a.id) AS agents`, AGENT)[0]!;
    const previous = requests(`sum(${TOKENS}) AS tokens, coalesce(sum(x.cost_usd), 0) AS cost, count(*) FILTER (WHERE x.cost_usd IS NULL) > 0 AS costPartial`, '', '', { ...params, from: from - (to - from), to: from })[0]!;
    // v0.2 slice 2: the agents the plugin flagged as on a pricier model, with requests in the window, and what those requests cost.
    // ponytail: a request on a model pricing.json lacks adds nothing, so the cost is a floor; the Totals' own cost says when it is partial.
    const pricier = requests('count(DISTINCT a.id) AS agents, coalesce(sum(x.cost_usd), 0) AS cost', AGENT, 'AND a.pricier = 1')[0]!;
    // one row per bucket and model: the rows are buckets x models, never requests
    type Bucket = { bucket: string; tokens: number; cost: number; byModel: Record<string, number> };
    const series = new Map<string, Bucket>();
    for (const r of requests(`${bucketSql(unit, localDate(tz, from, to, 'x.ts'))} AS bucket, x.model AS model, ${SUMS}`, '', 'GROUP BY 1, 2 ORDER BY 1')) {
      const b: Bucket = series.get(r.bucket) ?? { bucket: r.bucket, tokens: 0, cost: 0, byModel: {} };
      b.tokens += r.tokens;
      b.cost += r.cost;
      b.byModel[r.model] = r.tokens;
      series.set(r.bucket, b);
    }
    const byProject = requests(`p.name AS name, ${SUMS}, count(DISTINCT s.id) AS sessions, count(DISTINCT a.id) AS agents, count(*) AS requests,
      sum(x.cache_read) AS reads, sum(x.input + x.cache_read + x.cache_creation) AS inputSide`, CHAIN, 'GROUP BY p.name ORDER BY tokens DESC, name').map(bool);
    const byModel = requests(`x.model AS model, ${SUMS}, count(DISTINCT a.id) AS agents`, AGENT, 'GROUP BY x.model ORDER BY tokens DESC, model').map(bool);
    // by role and type, folded by role: an agent has one type, so the agents of two types add up
    type Role = { role: string; tokens: number; cost: number; costPartial: boolean; agents: number; types: string[] };
    const byRole = new Map<string, Role>();
    for (const r of requests(`coalesce(a.role, 'unassigned') AS role, a.type AS type, ${SUMS}, count(DISTINCT a.id) AS agents`, AGENT, 'GROUP BY 1, 2')) {
      const b: Role = byRole.get(r.role) ?? { role: r.role, tokens: 0, cost: 0, costPartial: false, agents: 0, types: [] };
      b.tokens += r.tokens;
      b.cost += r.cost;
      b.costPartial ||= Boolean(r.costPartial);
      b.agents += r.agents;
      if (r.type !== null) b.types.push(r.type);
      byRole.set(r.role, b);
    }
    // A wait is the run time of a tool held at the permission dialog, and counts at most WINDOW_MS (#102: one dialog left open overnight read as hours); waitMsFull is the
    // same waits uncapped, so the Totals can say what the cap took off, and a wait over an hour is counted whole, apart.
    const tools = calls(`p.name AS project, count(*) AS toolCalls, count(*) FILTER (WHERE x.success = 0) AS failedCalls, count(*) FILTER (WHERE x.waited = 1) AS waits,
      coalesce(sum(CASE WHEN x.waited = 1 THEN min(coalesce(x.duration_ms, 0), ${WINDOW_MS}) ELSE 0 END), 0) AS waitMs,
      coalesce(sum(CASE WHEN x.waited = 1 THEN coalesce(x.duration_ms, 0) ELSE 0 END), 0) AS waitMsFull,
      count(*) FILTER (WHERE x.waited = 1 AND x.duration_ms > ${HOUR_MS}) AS waitsOverHour`, 'GROUP BY p.name');
    // the Files a write touched, per project: a path counts once in the project it was written in
    const files = all(store, `SELECT p.name AS project, count(DISTINCT f.project_id || char(0) || f.path) AS filesChanged
      FROM tool_calls x ${CHAIN} JOIN files_touched f ON f.tool_use_id = x.tool_use_id AND f.mode = 'write' WHERE ${window} GROUP BY p.name`, params);

    const sumOf = (key: string) => tools.reduce((s, t) => s + (t[key] as number), 0);
    const share = (reads: number, inputSide: number) => (inputSide ? reads / inputSide : null);
    return {
      range: { from, to, unit, tz, project },
      // Slice 7: what analyses with Claude cost in the period, billed to the owner's API credits (§15, 2026-10-21).
      analysis: analysis?.spent(from, to, project ?? undefined) ?? { runs: 0, cost: 0 },
      totals: {
        tokens: totals.tokens ?? 0, cost: totals.cost, costPartial: Boolean(totals.costPartial),
        cacheShare: share(totals.reads ?? 0, totals.inputSide ?? 0), sessions: totals.sessions, agents: totals.agents,
        toolCalls: sumOf('toolCalls'), failedCalls: sumOf('failedCalls'), waits: sumOf('waits'), waitMs: sumOf('waitMs'), waitMsFull: sumOf('waitMsFull'), waitsOverHour: sumOf('waitsOverHour'),
        previousTokens: previous.tokens ?? 0,
        // priced as `cost` is, but null when part of it has no price: a floor is no base for a percentage
        previousCost: previous.costPartial ? null : previous.cost,
        pricier: { agents: pricier.agents, cost: pricier.cost },
      },
      series: [...series.values()],
      byProject: byProject.map(({ reads: _r, inputSide: _i, requests: _q, ...p }) => p),
      byModel: byModel.map((m) => ({ ...m, cost: m.costPartial ? null : m.cost })),
      byRole: [...byRole.values()].sort((a, b) => b.tokens - a.tokens || (a.role < b.role ? -1 : 1)).map((r) => ({ ...r, types: r.types.sort() })),
      efficiency: byProject.map((p) => {
        const t = tools.find((x) => x.project === p.name);
        return {
          project: p.name, tokens: p.tokens, requests: p.requests, cacheShare: share(p.reads, p.inputSide),
          filesChanged: files.find((f) => f.project === p.name)?.filesChanged ?? 0,
          toolCalls: t?.toolCalls ?? 0, failedCalls: t?.failedCalls ?? 0, waitMs: t?.waitMs ?? 0,
        };
      }),
    };
  });
}
