import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, run, type Store } from '../store/store.ts';
import { zone } from './ledger.ts';
import { dayOf, monthBounds } from './local-time.ts';

// v0.2 slice 3 (PROJECT.md §15, 2026-10-24): the monthly goal, in API-equivalent dollars per project. Nothing is ever stopped.
//   GET /api/goal?project=<name>&tz=<IANA>  the goal (null when none), what the month has spent so far in that zone, and whether that is a floor
//   PUT /api/goal { project, usd }          studio only; usd above 0 and at most 1,000,000, or null to clear
// The goal is `goal_usd` on every project row with the name (a repo seen from two machines is two rows), like a role rule.

const Query = z.object({ project: z.string().min(1), tz: zone.default('UTC') });
const Put = z.object({ project: z.string().min(1), usd: z.number().positive().max(1_000_000).nullable() });

export function goal(app: FastifyInstance, { store, now = Date.now }: { store: Store; now?: () => number }) {
  app.get('/api/goal', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a project, and a time zone that exists', issues: q.error.issues });
    const { project, tz } = q.data;
    const at = now();
    // The month starts at midnight on its first day in the viewer's zone, and the spend runs to now.
    const month = dayOf(tz, at).slice(0, 7);
    const [start] = monthBounds(tz, Number(month.slice(0, 4)), Number(month.slice(5, 7)));
    // ponytail: a request on a model pricing.json lacks adds nothing, so spent is a floor; costPartial says so.
    const spent = all(store, `SELECT coalesce(sum(x.cost_usd), 0) AS spent, count(*) FILTER (WHERE x.cost_usd IS NULL) > 0 AS costPartial
      FROM api_requests x JOIN turns t ON t.id = x.turn_id JOIN agents a ON a.id = t.agent_id JOIN sessions s ON s.id = a.session_id JOIN projects p ON p.id = s.project_id
      WHERE p.name = :project AND x.ts >= :start AND x.ts <= :now`, { project, start, now: at })[0]!;
    const g = get(store, 'SELECT max(goal_usd) AS goal FROM projects WHERE name = :project', { project });
    return { project, month, goal: g?.goal ?? null, spent: spent.spent, costPartial: Boolean(spent.costPartial) };
  });

  app.put('/api/goal', async (req, reply) => {
    const b = Put.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'give a project, and usd: a number of dollars above 0 and at most 1,000,000, or null to clear it', issues: b.error.issues });
    const { changes } = run(store, 'UPDATE projects SET goal_usd = :usd WHERE name = :project', b.data);
    return Number(changes) ? { project: b.data.project, goal: b.data.usd } : reply.code(404).send({ error: 'no such project' });
  });
}
