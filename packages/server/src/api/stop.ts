import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { get, run, type Store } from '../store/store.ts';

// v0.4 slice 5 (#31, Factory; PROJECT.md §15): Live's Stop on a stalled session. The server never reaches the machine, so it holds the request and the session's plugin comes for it.
//   POST /api/stop { session }   studio only: queue one stop for the session; { queued: false } when one is already waiting (a second click changes nothing)
//   GET  /api/stop?session=<id>  the plugin's poll: { stop: true } once for a waiting stop (it sets picked_at), then { stop: false }; the plugin's session.stopped event deletes the row
// A stop is live for 10 minutes from the request. Past that it is never handed out and a new request replaces it: a session resumed hours later must not be stopped by one nobody remembers.

const STOP_TTL_MS = 10 * 60_000;
const Body = z.object({ session: z.string().min(1) });

export function stop(app: FastifyInstance, { store, now = Date.now }: { store: Store; now?: () => number }) {
  app.post('/api/stop', async (req, reply) => {
    const b = Body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'give the session to stop', issues: b.error.issues });
    const { session } = b.data;
    if (!get(store, 'SELECT 1 AS x FROM sessions WHERE id = :session', { session })) return reply.code(404).send({ error: 'no such session' });
    const at = now();
    // A live stop is left as it is (the WHERE is false, nothing changes); a dead one is replaced.
    const { changes } = run(store, `INSERT INTO stops (session_id, requested_at) VALUES (:session, :at)
      ON CONFLICT (session_id) DO UPDATE SET requested_at = :at, picked_at = NULL WHERE stops.requested_at < :dead`, { session, at, dead: at - STOP_TTL_MS });
    return { session, queued: Number(changes) > 0 };
  });

  app.get('/api/stop', async (req, reply) => {
    const q = Body.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give the session', issues: q.error.issues });
    const { session } = q.data;
    // One statement takes it, so two polls never both get it. ponytail: a stop taken and then lost (the plugin dies before it answers) is not retried; ten minutes on the studio can ask again.
    const at = now();
    const { changes } = run(store, 'UPDATE stops SET picked_at = :at WHERE session_id = :session AND picked_at IS NULL AND requested_at >= :live', { session, at, live: at - STOP_TTL_MS });
    return { session, stop: Number(changes) > 0 };
  });
}
