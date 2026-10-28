import type { Event } from '@agent-orb/shared';
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { ClaimLive } from './claims.ts';
import { applyClaims, applyEvents, type LiveState, view, visible } from './live.ts';

// GET /stream (§4): server-sent events for the studio. One `snapshot` on connect, then one `session` per changed session.
// No login: the server listens on 127.0.0.1 only (§9).

const send = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

export function stream(app: FastifyInstance, live: LiveState) {
  const clients = new Set<ServerResponse>();

  app.get('/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    send(res, 'snapshot', { sessions: visible(live, Date.now()) });
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  app.addHook('onClose', async () => {
    for (const res of clients) res.end();
  });

  /** Called with each batch the writer took, and the unbacked claims its answers were found to make: updates the live state and tells every open stream. */
  return (events: Event[], claims: ClaimLive[] = []) => {
    for (const id of new Set([...applyEvents(live, events), ...applyClaims(live, claims)])) {
      const s = live.sessions.get(id);
      if (s) for (const res of clients) send(res, 'session', view(s));
    }
  };
}
