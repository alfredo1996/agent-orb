import { ROLE_INFO, ROLES, types, type Role } from '@agent-orb/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, each, get, run, type Store } from '../store/store.ts';
import { Range, SCOPE, spend, TOKENS } from './skills.ts';

// Slice 3 (PROJECT.md §7, §8.3): the pipeline by role, fixing roles, one session's lanes, and the pickers' lists. Read from the history store (#81, slice 3).

const ROLE = z.enum(ROLES);
const WHOLE = 5_000; // calls: a session with more is answered without the ones too short to draw (/api/lanes)

const Fix = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('type'), project: z.string().min(1), agent_type: z.string().min(1), role: ROLE }),
  z.object({ scope: z.literal('agent'), agent_id: z.string().min(1), role: ROLE }),
]);

// The agents in scope (the session, or those that started in the period; skills.ts's SCOPE), each with its parent's role: one row per agent, the parent
// by key. `spend` is what each one's own requests came to.
const SCOPED = `scoped AS (
  SELECT a.id AS id, a.type AS type, coalesce(a.role, 'unassigned') AS role, a.role_source AS role_source, a.description AS description, a.model AS model,
         a.started_at AS started_at, a.ended_at AS ended_at, s.id AS session, pa.id AS parent,
         CASE WHEN pa.id IS NULL THEN NULL ELSE coalesce(pa.role, 'unassigned') END AS parentRole
  FROM sessions s JOIN agents a ON a.session_id = s.id LEFT JOIN agents pa ON pa.id = a.parent_id
  WHERE ${SCOPE('coalesce(a.started_at, s.started_at)')})`;
const WITH_SPEND = `${SCOPED}, ${spend('SELECT id FROM scoped')}`;

// An agent's depth in the delegation tree (the main agent is 0, what it spawned 1, and so on), by walking up agents.parent_id from each agent in scope: the
// ancestors need not be in scope themselves, so a period that holds only a deep agent still knows how deep it is.
// ponytail: stops at 32 levels, so a parent_id loop (a bad event naming an agent as its own parent) ends instead of recursing for ever.
const DEPTH = `up(id, at, depth) AS (
    SELECT id, parent, 0 FROM scoped
    UNION ALL SELECT up.id, a.parent_id, up.depth + 1 FROM up JOIN agents a ON a.id = up.at WHERE up.depth < 32),
  depth AS (SELECT id, max(depth) AS depth FROM up GROUP BY id)`;

export function pipeline(app: FastifyInstance, { store }: { store: Store }) {
  app.get('/api/pipeline', async (req, reply) => {
    const q = Range.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a project, and a session or from and to' });
    const { project, session = null, from = 0, to = 0 } = q.data;
    const params = { project, session, from, to };

    // The roles, the edges between them and the agents are three views of the same scope: the first two are grouped in the query (a response is built from
    // aggregated rows), and the agents are the response's own rows, which the studio lists behind a role and fixes one at a time. They are the period's or the
    // session's agents, not the project's history.
    // avgMs: the mean of the agents that started and ended, rounded. A cost is the agents' priced requests, a floor, and costPartial says one was unpriced.
    const grouped = all(store, `WITH ${WITH_SPEND}
      SELECT sc.role AS role, count(*) AS agents, json_group_array(DISTINCT coalesce(sc.type, 'agent')) AS types,
             coalesce(sum(sp.tokens), 0) AS tokens, coalesce(sum(sp.cost), 0) AS cost, coalesce(max(sp.unpriced), 0) > 0 AS costPartial,
             round(avg(CASE WHEN sc.started_at IS NOT NULL AND sc.ended_at IS NOT NULL THEN sc.ended_at - sc.started_at END)) AS avgMs
      FROM scoped sc LEFT JOIN spend sp ON sp.agent = sc.id GROUP BY sc.role ORDER BY tokens DESC, role`, params);
    const edges = all(store, `WITH ${WITH_SPEND}
      SELECT sc.parentRole AS "from", sc.role AS "to", count(*) AS count, coalesce(sum(sp.tokens), 0) AS tokens
      FROM scoped sc LEFT JOIN spend sp ON sp.agent = sc.id WHERE sc.parentRole IS NOT NULL GROUP BY 1, 2 ORDER BY tokens DESC, "from", "to"`, params);
    const agents = new Map<string, object[]>();
    for (const a of each(store, `WITH RECURSIVE ${WITH_SPEND}, ${DEPTH}
      SELECT sc.id AS id, sc.type AS type, sc.role AS role, sc.role_source AS role_source, sc.description AS description, sc.model AS model,
             sc.started_at AS started_at, sc.ended_at AS ended_at, sc.session AS session, coalesce(sp.tokens, 0) AS tokens, sp.cost AS cost, sc.parent AS parent, d.depth AS depth
      FROM scoped sc JOIN depth d ON d.id = sc.id LEFT JOIN spend sp ON sp.agent = sc.id
      ORDER BY sc.started_at IS NULL, sc.started_at, sc.id`, params)) {
      const list = agents.get(a.role);
      if (list) list.push(a);
      else agents.set(a.role, [a]);
    }

    // Issue #8: an agent type's description, from its file (the session catalogue, Slice 5), else the built-in line.
    const fromFile = new Map<string, string>();
    for (const d of all(store, `SELECT DISTINCT d.name AS name, d.description AS description, d.source AS source
      FROM projects p JOIN sessions s ON s.project_id = p.id JOIN session_skill_defs l ON l.session_id = s.id JOIN skill_defs d ON d.id = l.def_id
      WHERE p.name = :project AND d.kind = 'agent' AND d.description IS NOT NULL
      ORDER BY CASE d.source WHEN 'projectSettings' THEN 0 WHEN 'userSettings' THEN 1 ELSE 2 END`, { project })) {
      if (!fromFile.has(d.name)) fromFile.set(d.name, d.description);
    }
    const builtIn = types as Record<string, string>;
    const typeLine = (type: string) => fromFile.get(type) ?? builtIn[type] ?? null;
    const roleLine = (role: string) => (ROLE_INFO as Record<string, string>)[role] ?? null;

    return {
      project, session, from: session ? null : from, to: session ? null : to,
      roles: grouped.map(({ types: json, ...r }) => {
        const typeNames = (JSON.parse(json) as string[]).sort();
        return {
          ...r, costPartial: Boolean(r.costPartial), avgMs: r.avgMs ?? null,
          info: roleLine(r.role), typeInfo: Object.fromEntries(typeNames.map((ty) => [ty, typeLine(ty)])), types: typeNames, agentList: agents.get(r.role) ?? [],
        };
      }),
      edges,
      roleCatalog: ROLES.map((r: Role) => ({ role: r, info: ROLE_INFO[r] })), // the picker's list: every role, with its line
    };
  });

  app.put('/api/roles', async (req, reply) => {
    const f = Fix.safeParse(req.body);
    if (!f.success) return reply.code(400).send({ error: 'scope "type" needs project, agent_type and role; scope "agent" needs agent_id and role', issues: f.error.issues });
    if (f.data.scope === 'agent') {
      const { changes } = run(store, "UPDATE agents SET role = :role, role_source = 'manual' WHERE id = :id", { id: f.data.agent_id, role: f.data.role });
      return Number(changes) ? { updated: Number(changes) } : reply.code(404).send({ error: 'no such agent' });
    }
    // A rule on every project row with that name (a repo seen from two machines is two rows), applied now to the agents of that type in their sessions, a manual fix
    // excepted, and on later spawns (the writer reads the rule). The rule and the agents change together: the import is a second process on this file.
    const { project, agent_type: type, role } = f.data;
    store.exec('BEGIN IMMEDIATE');
    try {
      const rules = Number(run(store, `INSERT INTO role_rules (project_id, agent_type, role) SELECT id, :type, :role FROM projects WHERE name = :project
        ON CONFLICT (project_id, agent_type) DO UPDATE SET role = excluded.role`, { project, type, role }).changes);
      const updated = rules ? Number(run(store, `UPDATE agents SET role = :role, role_source = 'rule'
        WHERE type = :type AND coalesce(role_source, '') <> 'manual' AND session_id IN (SELECT s.id FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.name = :project)`,
      { project, type, role }).changes) : 0;
      store.exec('COMMIT');
      return rules ? { updated } : reply.code(404).send({ error: 'no such project' });
    } catch (e) {
      store.exec('ROLLBACK');
      throw e;
    }
  });

  // The studio draws a call as a bar only when it is at least a thousandth of the time axis wide, and a narrower one cuts no turn either (Pipeline.tsx's Lanes:
  // minMs). The axis runs from the session's start to the latest end of anything in it, or to now while something is open. So a session of more than WHOLE calls
  // is answered without the closed calls shorter than a thousandth of the axis as it stands: the studio's own floor is never lower (an open call only moves the
  // axis out), so none of them was drawn. `until` says where the axis ends, so it does not shrink with the calls that are left out. A smaller session is
  // answered whole, with no `until`.
  // ponytail: the turns stay whole. A session has an order of magnitude fewer than calls (the biggest real session: 1,864 against 41,437); thin them the same way if one ever has as many.
  app.get('/api/lanes', async (req, reply) => {
    const q = z.object({ session: z.string().min(1) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'session is required' });
    const session = get(store, 'SELECT id, started_at, ended_at FROM sessions WHERE id = :session', q.data);
    if (!session) return reply.code(404).send({ error: 'no such session' });
    const size = get(store, `SELECT
        (SELECT count(*) FROM agents a JOIN turns t ON t.agent_id = a.id JOIN tool_calls c ON c.turn_id = t.id WHERE a.session_id = :session) AS calls,
        (SELECT max(c.ts + c.duration_ms) FROM agents a JOIN turns t ON t.agent_id = a.id JOIN tool_calls c ON c.turn_id = t.id WHERE a.session_id = :session) AS callEnd,
        (SELECT max(coalesce(t.started_at, 0) + t.duration_ms) FROM agents a JOIN turns t ON t.agent_id = a.id WHERE a.session_id = :session) AS turnEnd`, q.data)!;
    const thin = size.calls > WHOLE;
    const until = Math.max(session.started_at + 10_000, session.ended_at ?? 0, size.callEnd ?? 0, size.turnEnd ?? 0);
    const floor = thin ? (until - session.started_at) / 1000 : null;
    // One row per agent; its turns (with the model of the turn's first request) and its tool calls, each in time order, are built by the query. A row of tool_calls is
    // a call once it has a turn (a result or a wait alone made it before its call arrived). Read one row at a time, so no copy of the rows sits beside the answer.
    const lanes: object[] = [];
    for (const l of each(store, `SELECT a.id AS id, a.type AS type, a.role AS role, a.model AS model, a.started_at AS started_at, a.parent_id AS parent,
        (SELECT json_group_array(json_object('started_at', t.started_at, 'duration_ms', t.duration_ms,
           'model', (SELECT x.model FROM api_requests x WHERE x.turn_id = t.id ORDER BY x.ts LIMIT 1)) ORDER BY t.started_at, t.id)
         FROM turns t WHERE t.agent_id = a.id) AS turns,
        (SELECT json_group_array(json_object('ts', c.ts, 'duration_ms', c.duration_ms, 'tool', c.tool,
           'success', CASE WHEN c.success IS NULL THEN NULL WHEN c.success THEN json('true') ELSE json('false') END) ORDER BY c.ts)
         FROM turns t JOIN tool_calls c ON c.turn_id = t.id WHERE t.agent_id = a.id AND (c.duration_ms IS NULL OR c.duration_ms >= coalesce(:floor, c.duration_ms))) AS tools
      FROM agents a WHERE a.session_id = :session ORDER BY coalesce(a.started_at, 0), a.id`, { session: q.data.session, floor })) {
      lanes.push({ ...l, turns: JSON.parse(l.turns), tools: JSON.parse(l.tools) });
    }
    return { session, lanes, ...(thin && { until }) };
  });

  // The projects by name (a repo seen from two machines is one), most recent first.
  app.get('/api/projects', async () => all(store, `SELECT p.name AS name, count(*) AS sessions, max(coalesce(s.ended_at, s.started_at)) AS last
    FROM projects p JOIN sessions s ON s.project_id = p.id GROUP BY p.name ORDER BY last DESC, name`));

  app.get('/api/sessions', async (req, reply) => {
    const q = z.object({ project: z.string().min(1) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'project is required' });
    // The newest 50 first, and only then their tokens.
    return all(store, `WITH latest AS (SELECT id, started_at, ended_at FROM sessions WHERE project_id IN (SELECT id FROM projects WHERE name = :project)
        ORDER BY started_at DESC, id LIMIT 50)
      SELECT s.id AS id, s.started_at AS started_at, s.ended_at AS ended_at,
        (SELECT coalesce(sum(${TOKENS}), 0) FROM agents a JOIN turns t ON t.agent_id = a.id JOIN api_requests x ON x.turn_id = t.id WHERE a.session_id = s.id) AS tokens
      FROM latest s ORDER BY s.started_at DESC, s.id`, q.data);
  });
}
