import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, type Row, type Store } from '../store/store.ts';
import { skillGraph, type AgentTypeRow, type Def, type Load, type TurnRow } from './skill-graph.ts';

// Slice 5 (PROJECT.md §8.3, §15 2026-10-21): GET /api/skills?project&(session | from,to). The Pipeline's Skills scope:
// what each skill can call and did call, the agent types they dispatch, and what each one used.

export const Range = z.object({
  project: z.string().min(1),
  session: z.string().min(1).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().positive().optional(),
}).refine((q) => q.session || (q.from !== undefined && q.to !== undefined && q.to > q.from), 'give a session, or from and to');

/** The sessions of the project (by name) in scope: started in [from, to), or the one session; `at` is the time the range is read by. All four parameters are used. */
export const SCOPE = (at: string) =>
  `s.project_id IN (SELECT id FROM projects WHERE name = :project) AND CASE WHEN :session IS NULL THEN ${at} >= :from AND ${at} < :to ELSE s.id = :session END`;
export const TOKENS = 'x.input + x.output + x.cache_read + x.cache_creation';

export type SkillQuery = { project: string; session: string | null; from: number; to: number };

// The turns in scope that loaded a skill, with the agent that ran them. `sub` is an agent a parent spawned.
const MINE = `mine AS (
  SELECT t.id AS turn, a.id AS agent, coalesce(a.type, 'main') AS type, a.parent_id IS NOT NULL AS sub, t.started_at AS started_at
  FROM sessions s JOIN agents a ON a.session_id = s.id JOIN turns t ON t.agent_id = a.id
  WHERE ${SCOPE('coalesce(t.started_at, s.started_at)')} AND EXISTS (SELECT 1 FROM skill_loads l WHERE l.turn_id = t.id))`;

// What an agent's requests came to, for the agents a query names: tokens, cost, and how many were unpriced (a cost with one is no cost).
export const spend = (agents: string) => `spend AS (
  SELECT t.agent_id AS agent, sum(${TOKENS}) AS tokens, sum(x.cost_usd) AS cost, count(*) FILTER (WHERE x.cost_usd IS NULL) AS unpriced
  FROM turns t JOIN api_requests x ON x.turn_id = t.id WHERE t.agent_id IN (${agents}) GROUP BY t.agent_id)`;
const listOf = (json: string | null): string[] | undefined => (json ? JSON.parse(json) : undefined);
const costOf = (r: Row): number | null => (r.unpriced ? null : r.cost ?? 0);

/** The Pipeline's Skills scope, and the skills part of an analysis's digest (api/analysis.ts). */
export function loadSkills(store: Store, params: SkillQuery) {
  const defs = all(store, `SELECT DISTINCT d.name, d.kind, d.source, d.plugin, d.tokens, d.description, d.calls_skills, d.calls_agents, d.preload
    FROM sessions s JOIN session_skill_defs l ON l.session_id = s.id JOIN skill_defs d ON d.id = l.def_id WHERE ${SCOPE('s.started_at')}`, params)
    .map((d): Def => ({
      name: d.name, kind: d.kind, source: d.source, plugin: d.plugin ?? undefined, tokens: d.tokens, description: d.description ?? undefined,
      calls_skills: listOf(d.calls_skills), calls_agents: listOf(d.calls_agents), preload: listOf(d.preload),
    }));

  // One row per turn, then what it loaded, what it spawned and what it requested, each by turn: loads and spawns are the events themselves; the requests,
  // which can be thousands in a long turn, come grouped by the load they follow. Each request belongs to the latest skill loaded before it in its turn
  // (skillGraph hands it to the latest chain-starting skill loaded before it, which is the same one: a chain starter is a load), so a group stands for its
  // requests exactly; priced and unpriced are apart, as the graph adds the cost of the first and marks the second partial. Requests before a load belong to none.
  // ponytail: the loads and spawns of a turn are read whole; a turn with thousands of them would want the same grouping.
  const turns = new Map<string, TurnRow>();
  for (const t of all(store, `WITH ${MINE} SELECT turn, agent, type, sub, started_at FROM mine ORDER BY started_at, turn`, params)) {
    turns.set(t.turn, { agent: t.agent, type: t.type, sub: Boolean(t.sub), started_at: t.started_at, loads: [], spawns: [], requests: [] });
  }
  for (const l of all(store, `WITH ${MINE} SELECT m.turn AS turn, l.ts AS ts, l.skill AS skill, l.how AS how, l.source AS source FROM mine m JOIN skill_loads l ON l.turn_id = m.turn`, params)) {
    turns.get(l.turn)!.loads.push({ ts: l.ts, skill: l.skill, how: l.how ?? undefined, source: l.source ?? undefined } as Load);
  }
  const children = 'SELECT c.id FROM mine m JOIN tool_calls k ON k.turn_id = m.turn JOIN agents c ON c.spawn_tool_use_id = k.tool_use_id';
  for (const s of all(store, `WITH ${MINE}, ${spend(children)}
    SELECT m.turn AS turn, coalesce(k.ts, c.started_at) AS ts, coalesce(c.type, 'agent') AS type, coalesce(sp.tokens, 0) AS tokens, sp.cost AS cost, sp.unpriced AS unpriced
    FROM mine m JOIN tool_calls k ON k.turn_id = m.turn JOIN agents c ON c.spawn_tool_use_id = k.tool_use_id LEFT JOIN spend sp ON sp.agent = c.id`, params)) {
    turns.get(s.turn)!.spawns.push({ ts: s.ts, type: s.type, tokens: s.tokens, cost: costOf(s) });
  }
  for (const r of all(store, `WITH ${MINE}
    SELECT m.turn AS turn, (SELECT max(l.ts) FROM skill_loads l WHERE l.turn_id = m.turn AND l.ts <= x.ts) AS ts, sum(${TOKENS}) AS tokens, sum(x.cost_usd) AS cost, x.cost_usd IS NULL AS unpriced
    FROM mine m JOIN api_requests x ON x.turn_id = m.turn GROUP BY 1, 2, 5 HAVING ts IS NOT NULL`, params)) {
    turns.get(r.turn)!.requests.push({ ts: r.ts, tokens: r.tokens, cost: r.unpriced ? null : r.cost });
  }

  // The agent types that were spawned, with their agents' requests: a type's own tokens, as a node shows them.
  const scoped = `SELECT a.id AS id, coalesce(a.type, 'agent') AS type FROM sessions s JOIN agents a ON a.session_id = s.id
    WHERE ${SCOPE('coalesce(a.started_at, s.started_at)')} AND a.parent_id IS NOT NULL`;
  const types = all(store, `WITH scoped AS (${scoped}), ${spend('SELECT id FROM scoped')}
    SELECT sc.type AS type, count(*) AS agents, coalesce(sum(sp.tokens), 0) AS tokens, max(coalesce(sp.unpriced, 0) > 0) AS unpriced, coalesce(sum(sp.cost), 0) AS cost
    FROM scoped sc LEFT JOIN spend sp ON sp.agent = sc.id GROUP BY sc.type`, params).map((r): AgentTypeRow => ({ type: r.type, agents: r.agents, tokens: r.tokens, cost: costOf(r) }));

  return skillGraph(defs, [...turns.values()], types);
}

export function skills(app: FastifyInstance, { store }: { store: Store }) {
  app.get('/api/skills', async (req, reply) => {
    const q = Range.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a project, and a session or from and to' });
    const { project, session = null, from = 0, to = 0 } = q.data;
    return { project, session, from: session ? null : from, to: session ? null : to, ...loadSkills(store, { project, session, from, to }) };
  });
}
