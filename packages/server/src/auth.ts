import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** An onRequest hook that takes the plugin's token (`Authorization: Bearer <token>`) and nothing else: no token, no work. Used by POST /ingest and the plugin's poll of GET /api/stop. */
export function bearer(token: string) {
  const expected = Buffer.from(`Bearer ${token}`);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const got = Buffer.from(req.headers.authorization ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return reply.code(401).send({ error: 'unauthorized' });
  };
}
