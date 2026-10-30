import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { costAtMost, decide, digestText, MAX_OUTPUT, MODELS, monthStart, Report, SYSTEM, type DigestData, type ModelId } from '../analysis-core.ts';
import { ClaudeError, type Claude } from '../analysis-claude.ts';
import type { AnalysisStore } from '../analysis-store.ts';
import type { ContentStore } from '../content-store.ts';
import { costUsd } from '../cost.ts';
import { all, type Store } from '../store/store.ts';
import { loadSkills, SCOPE } from './skills.ts';

// Slice 7 (PROJECT.md §15, 2026-10-21): Claude reads a project's week and suggests changes, run by hand only.
//   GET  /api/analysis            key set?, models, cap, the month's spend, past reports
//   GET  /api/analysis/reads      what a run would read (no key needed, nothing sent)
//   POST /api/analysis/estimate   counts the input with the API's token counter (no generation): the cost at most
//   POST /api/analysis/run        the one paid request, for an estimate the person confirmed, within the cap
//   GET  /api/analysis/reports/:id, PUT /api/analysis/cap
// Nothing here runs on its own: no schedule, no retry, no run without a fresh estimate.

const ESTIMATE_TTL_MS = 15 * 60_000;
const Scope = z.object({
  project: z.string().min(1),
  session: z.string().min(1).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().positive().optional(),
}).refine((q) => q.session || (q.from !== undefined && q.to !== undefined && q.to > q.from), 'give a session, or from and to');
const ModelParam = z.enum(MODELS.map((m) => m.id) as [ModelId, ...ModelId[]]);
const TOKENS = 'x.input + x.output + x.cache_read + x.cache_creation';
// The sessions of the project (by name) in scope, and what hangs from them: agents, turns, then requests or calls.
const SESSIONS = `FROM sessions s WHERE ${SCOPE('s.started_at')}`;
const WALK = `FROM sessions s JOIN agents a ON a.session_id = s.id JOIN turns t ON t.agent_id = a.id`;

type Pending = { id: string; createdAt: number; scope: z.infer<typeof Scope>; model: ModelId; text: string; inputTokens: number; costMax: number };

/** The week's rows, from the history store and the text store, as the digest Claude reads. Every list is cut in SQL to what the digest shows. */
function gather(store: Store, content: ContentStore, q: z.infer<typeof Scope>): DigestData {
  const params = { project: q.project, session: q.session ?? null, from: q.from ?? 0, to: q.to ?? 0 };
  const rows = <T>(sql: string, p: Record<string, unknown> = params) => all(store, sql, p) as T[];
  const byModel = rows<{ model: string; tokens: number; cost: number; partial: number; steps: number }>(`SELECT x.model AS model, sum(${TOKENS}) AS tokens, coalesce(sum(x.cost_usd), 0) AS cost,
      count(*) FILTER (WHERE x.cost_usd IS NULL) > 0 AS partial, count(*) AS steps
    ${WALK} JOIN api_requests x ON x.turn_id = t.id WHERE ${SCOPE('s.started_at')} GROUP BY x.model ORDER BY tokens DESC, model`).map((m) => ({ ...m, cost: m.partial ? null : m.cost }));
  const { count, first, last } = rows<{ count: number; first: number | null; last: number | null }>(`SELECT count(*) AS count, min(s.started_at) AS first,
    max(coalesce(s.ended_at, s.started_at)) AS last ${SESSIONS}`)[0]!;
  const modes = new Set(rows<{ mode: string }>(`SELECT DISTINCT coalesce(s.content, 'off') AS mode ${SESSIONS}`).map((m) => m.mode));
  const topSessions = rows<DigestData['topSessions'][number]>(`SELECT s.id AS id, s.started_at AS started_at, coalesce(sum(${TOKENS}), 0) AS tokens, count(DISTINCT a.id) AS agents
    FROM sessions s LEFT JOIN agents a ON a.session_id = s.id LEFT JOIN turns t ON t.agent_id = a.id LEFT JOIN api_requests x ON x.turn_id = t.id
    WHERE ${SCOPE('s.started_at')} GROUP BY s.id ORDER BY tokens DESC, s.id LIMIT 10`);
  // By type: the requests and the calls of each agent, summed per agent, then per type; a cost with an unpriced request in it is none.
  const agents = rows<DigestData['agents'][number]>(`WITH ag AS (SELECT a.id AS id, coalesce(a.type, 'main') AS type FROM sessions s JOIN agents a ON a.session_id = s.id WHERE ${SCOPE('s.started_at')}),
      rq AS (SELECT t.agent_id AS agent, sum(${TOKENS}) AS tokens, sum(x.cost_usd) AS cost, count(*) FILTER (WHERE x.cost_usd IS NULL) AS unpriced
             FROM turns t JOIN api_requests x ON x.turn_id = t.id WHERE t.agent_id IN (SELECT id FROM ag) GROUP BY t.agent_id),
      cl AS (SELECT t.agent_id AS agent, count(*) AS calls, count(*) FILTER (WHERE x.success = 0) AS failed
             FROM turns t JOIN tool_calls x ON x.turn_id = t.id WHERE t.agent_id IN (SELECT id FROM ag) GROUP BY t.agent_id)
    SELECT ag.type AS type, count(*) AS count, coalesce(sum(rq.tokens), 0) AS tokens, CASE WHEN max(coalesce(rq.unpriced, 0) > 0) THEN NULL ELSE coalesce(sum(rq.cost), 0) END AS cost,
      coalesce(sum(cl.calls), 0) AS calls, coalesce(sum(cl.failed), 0) AS failed
    FROM ag LEFT JOIN rq ON rq.agent = ag.id LEFT JOIN cl ON cl.agent = ag.id GROUP BY ag.type ORDER BY tokens DESC, type`);
  const toolRows = rows<{ tool: string; calls: number; failed: number }>(`SELECT x.tool AS tool, count(*) AS calls, count(*) FILTER (WHERE x.success = 0) AS failed
    ${WALK} JOIN tool_calls x ON x.turn_id = t.id WHERE ${SCOPE('s.started_at')} GROUP BY x.tool ORDER BY calls DESC, tool`);
  // up to five distinct error types a tool failed with, by name (the graph named whichever it met first)
  const errors = new Map<string, string[]>();
  for (const e of rows<{ tool: string; error: string }>(`SELECT tool, error FROM (
      SELECT x.tool AS tool, x.error_type AS error, row_number() OVER (PARTITION BY x.tool ORDER BY x.error_type) AS rn
      ${WALK} JOIN tool_calls x ON x.turn_id = t.id WHERE ${SCOPE('s.started_at')} AND x.error_type IS NOT NULL GROUP BY x.tool, x.error_type) WHERE rn <= 5`)) {
    errors.set(e.tool, [...(errors.get(e.tool) ?? []), e.error]);
  }
  const tools = toolRows.map((t) => ({ ...t, errors: errors.get(t.tool) ?? [] }));
  const failures = rows<{ id: string; ts: number; agent: string; tool: string; error: string | null }>(`SELECT f.id AS id, f.ts AS ts, coalesce(a.type, 'main') AS agent, f.tool AS tool, f.error AS error
    FROM (SELECT x.tool_use_id AS id, x.ts AS ts, x.tool AS tool, x.error_type AS error, t.agent_id AS agent_id
          ${WALK} JOIN tool_calls x ON x.turn_id = t.id WHERE ${SCOPE('s.started_at')} AND x.success = 0 ORDER BY x.ts DESC, x.tool_use_id LIMIT 200) f
    JOIN agents a ON a.id = f.agent_id ORDER BY f.ts DESC, f.id`);
  const projects = rows<{ id: string }>('SELECT id FROM projects WHERE name = :project', { project: q.project });
  const skills = loadSkills(store, params);
  const text = content.get(failures.map((f) => ({ node: 'tool' as const, id: f.id })));
  const from = q.from ?? first ?? Infinity; // ponytail: a session scope with no such session has no dates, so the range is infinite, as it was, and digestText cannot print it
  const to = q.to ?? last ?? -Infinity;
  return {
    project: q.project, from, to, content: modes.size === 1 && modes.has('full') ? 'full' : modes.has('full') ? 'mixed' : 'off',
    sessions: { count, byModel: byModel.map(({ steps: _s, partial: _p, ...m }) => m) },
    topSessions,
    agents,
    skills: {
      ran: skills.usage.map((u) => ({ name: u.name, source: u.source, runs: u.runs, tokens: u.tokens, how: u.how })),
      idle: skills.idle.map((i) => ({ name: i.name, source: i.source, tokens: i.tokens })),
    },
    tools,
    failures: failures.map((f) => {
      const t = text.get(`tool:${f.id}`) ?? {};
      return { ts: f.ts, agent: f.agent, tool: f.tool, ...(f.error && { error: f.error }), ...(t.input && { input: t.input }), ...(t.output && { output: t.output }) };
    }),
    thinking: {
      steps: byModel.reduce((n, m) => n + m.steps, 0),
      withText: content.count('request', 'thinking', q.session ? { session: q.session } : { projects: projects.map((p) => p.id), from, to }),
    },
  };
}

export function analysis(app: FastifyInstance, { store: history, content, reports: store, claude }: { store: Store; content: ContentStore; reports: AnalysisStore; claude: Claude | null }) {
  const pending = new Map<string, Pending>();
  const month = () => store.spent(monthStart(Date.now())).cost;
  const noKey = { error: 'No API key: add ANTHROPIC_API_KEY to deploy/.env and restart the server. Nothing was sent.' };
  // An API refusal (a bad key, a missing workspace, a bad request) is said plainly; such a request generates and bills nothing.
  const refused = (e: unknown) => {
    if (!(e instanceof ClaudeError)) throw e;
    const m = e.message.trim();
    return { error: `The Claude API refused: ${/[.!?]$/.test(m) ? m : `${m}.`} Nothing was generated or billed.` };
  };

  app.get('/api/analysis', async () => ({
    keySet: claude !== null, defaultModel: MODELS[0].id, maxOutput: MAX_OUTPUT,
    models: MODELS.map((m) => ({ ...m, costPer1k: { input: costAtMost(m.id, 1000, 0), output: costAtMost(m.id, 0, 1000) } })),
    cap: store.cap(), spent: month(), reports: store.list(20),
  }));

  app.get('/api/analysis/reads', async (req, reply) => {
    const q = Scope.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a project, and a session or from and to' });
    const d = gather(history, content, q.data);
    return {
      sessions: d.sessions.count, agents: d.agents.reduce((n, a) => n + a.count, 0), skillsRan: d.skills.ran.length, skillsIdle: d.skills.idle.length,
      toolCalls: d.tools.reduce((n, t) => n + t.calls, 0), failed: d.tools.reduce((n, t) => n + t.failed, 0),
      tokens: d.sessions.byModel.reduce((n, m) => n + m.tokens, 0), thinking: d.thinking, content: d.content,
    };
  });

  app.post('/api/analysis/estimate', async (req, reply) => {
    const body = Scope.and(z.object({ model: ModelParam })).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'give a project, a model, and a session or from and to' });
    if (!claude) return reply.code(409).send(noKey);
    const { model, ...scope } = body.data;
    const text = digestText(gather(history, content, scope));
    let inputTokens: number;
    try { inputTokens = await claude.count(model, SYSTEM, text); } catch (e) { return reply.code(502).send(refused(e)); }
    const costMax = costAtMost(model, inputTokens, MAX_OUTPUT);
    const now = Date.now();
    for (const [k, p] of pending) if (now - p.createdAt > ESTIMATE_TTL_MS) pending.delete(k);
    const id = randomUUID();
    pending.set(id, { id, createdAt: now, scope, model, text, inputTokens, costMax });
    const spent = month();
    return {
      id, model, inputTokens, maxOutput: MAX_OUTPUT, costMax, spent, cap: store.cap(), ...decide(spent, costMax, store.cap()),
      // The counter is per model; for the others the same count is an approximation (a tokenizer may differ).
      others: MODELS.filter((m) => m.id !== model).map((m) => ({ model: m.id, costAbout: costAtMost(m.id, inputTokens, MAX_OUTPUT) })),
    };
  });

  app.post('/api/analysis/run', async (req, reply) => {
    const body = z.object({ estimate: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'give the estimate to run' });
    if (!claude) return reply.code(409).send(noKey);
    const p = pending.get(body.data.estimate);
    if (!p || Date.now() - p.createdAt > ESTIMATE_TTL_MS) return reply.code(404).send({ error: 'That estimate is gone or older than 15 minutes: estimate again. Nothing was sent.' });
    const verdict = decide(month(), p.costMax, store.cap());
    if (!verdict.allowed) return reply.code(409).send({ error: `This run could take the month to $${verdict.after.toFixed(2)}, past the $${store.cap().toFixed(2)} cap. Nothing was sent.` });
    pending.delete(p.id); // one confirmation, one request
    let r: Awaited<ReturnType<Claude['run']>>;
    try { r = await claude.run(p.model, SYSTEM, p.text); } catch (e) { return reply.code(502).send(refused(e)); }
    const cost = costUsd(r.model, r.usage) ?? costAtMost(p.model, r.usage.input, r.usage.output);
    const row = { id: randomUUID(), project: p.scope.project, from_ts: p.scope.from ?? null, to_ts: p.scope.to ?? null, session: p.scope.session ?? null,
      model: r.model, input_tokens: r.usage.input, output_tokens: r.usage.output, cost, created_at: Date.now() };
    if (r.stop === 'refusal') {
      store.add({ ...row, report: JSON.stringify({ refused: true }) }); // it was billed: it counts against the cap
      return reply.code(502).send({ error: 'Claude declined this analysis.', cost });
    }
    const report = Report.safeParse((() => { try { return JSON.parse(r.text); } catch { return null; } })());
    store.add({ ...row, report: report.success ? JSON.stringify(report.data) : JSON.stringify({ unparsed: r.text }) });
    return { ...row, report: report.success ? report.data : null, stop: r.stop };
  });

  app.get('/api/analysis/reports/:id', async (req, reply) => {
    const r = store.get((req.params as { id: string }).id);
    return r ? { ...r, report: JSON.parse(r.report) } : reply.code(404).send({ error: 'no such report' });
  });

  app.put('/api/analysis/cap', async (req, reply) => {
    const b = z.object({ usd: z.number().positive().max(1000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'the cap is a number of dollars, above 0 and at most 1000' });
    store.setCap(b.data.usd);
    return { cap: store.cap() };
  });
}
