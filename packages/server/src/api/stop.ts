import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearer } from '../auth.ts';
import { get, run, type Store } from '../store/store.ts';

// v0.4 slice 5 (#31, Factory; PROJECT.md §15): Live's Stop on a stalled session. The server never reaches the machine, so it holds the request and the session's plugin comes for it.
//   POST /api/stop { session, agent, since }   studio only: queue one stop for the session, tied to the stall it was clicked on (the stalled agent and the stall's `since`, as stall.start carried
//                                              them); { queued: false } when one is already waiting (a second click changes nothing)
//   GET  /api/stop?session=<id>                the plugin's poll, with its token: { stop: true, agent, since } once for a waiting stop (it sets picked_at), then { stop: false }; the
//                                              plugin's session.stopped event deletes the row
// A stop is live for 10 minutes from the request. Past that it is never handed out and the next request prunes it: a session resumed hours later must not be stopped by one nobody remembers.

const STOP_TTL_MS = 10 * 60_000;
const Session = z.object({ session: z.string().min(1) });
const Click = Session.extend({ agent: z.string().min(1), since: z.number().int() });

export function stop(app: FastifyInstance, { store, token, now = Date.now }: { store: Store; token: string; now?: () => number }) {
  app.post('/api/stop', async (req, reply) => {
    const b = Click.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'give the session, the stalled agent and when its stall began', issues: b.error.issues });
    const { session, agent, since } = b.data;
    if (!get(store, 'SELECT 1 AS x FROM sessions WHERE id = :session', { session })) return reply.code(404).send({ error: 'no such session' });
    const at = now();
    run(store, 'DELETE FROM stops WHERE requested_at < :dead', { dead: at - STOP_TTL_MS }); // lapsed ones, anyone's
    // A live stop is left as it is (nothing is inserted); the lapsed one of this session is gone, so a new request takes its place.
    const { changes } = run(store, `INSERT INTO stops (session_id, requested_at, agent, stall_since) VALUES (:session, :at, :agent, :since) ON CONFLICT (session_id) DO NOTHING`, { session, at, agent, since });
    return { session, queued: Number(changes) > 0 };
  });

  // The token: this GET changes state, so it is no link a page or another process can follow.
  app.get('/api/stop', { onRequest: bearer(token) }, async (req, reply) => {
    const q = Session.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give the session', issues: q.error.issues });
    const { session } = q.data;
    // One statement takes it, so two polls never both get it. ponytail: a stop taken and then lost (the plugin dies before it answers) is not retried; ten minutes on the studio can ask again.
    const at = now();
    const taken = get(store, 'UPDATE stops SET picked_at = :at WHERE session_id = :session AND picked_at IS NULL AND requested_at >= :live RETURNING agent, stall_since', { session, at, live: at - STOP_TTL_MS });
    return taken ? { session, stop: true, agent: taken.agent as string, since: taken.stall_since as number } : { session, stop: false };
  });
}
