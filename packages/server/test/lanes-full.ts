import { all, type Store } from '../src/store/store.ts';

// What the route answered before: every agent with every turn and every call, as JSON built by the query. The reference the thinned answer is measured against.
const FULL = `SELECT a.id AS id, a.type AS type, a.role AS role, a.model AS model, a.started_at AS started_at, a.parent_id AS parent,
    (SELECT json_group_array(json_object('started_at', t.started_at, 'duration_ms', t.duration_ms,
       'model', (SELECT x.model FROM api_requests x WHERE x.turn_id = t.id ORDER BY x.ts LIMIT 1)) ORDER BY t.started_at, t.id)
     FROM turns t WHERE t.agent_id = a.id) AS turns,
    (SELECT json_group_array(json_object('ts', c.ts, 'duration_ms', c.duration_ms, 'tool', c.tool,
       'success', CASE WHEN c.success IS NULL THEN NULL WHEN c.success THEN json('true') ELSE json('false') END) ORDER BY c.ts)
     FROM turns t JOIN tool_calls c ON c.turn_id = t.id WHERE t.agent_id = a.id) AS tools
  FROM agents a WHERE a.session_id = :session ORDER BY coalesce(a.started_at, 0), a.id`;

/** A session's lanes as the route answered them before #90: every agent with every turn and every call. */
export const fullLanes = (store: Store, session: string) => all(store, FULL, { session }).map((l) => ({ ...l, turns: JSON.parse(l.turns), tools: JSON.parse(l.tools) }));
