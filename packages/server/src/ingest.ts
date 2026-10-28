import { timingSafeEqual } from 'node:crypto';
import { Event } from '@agent-orb/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkAnswers, type ClaimLive } from './claims.ts';
import { contentRows, type ContentStore } from './content-store.ts';
import type { Store } from './store/store.ts';
import { writeEvents } from './store/writer.ts';

// ponytail: v0.1 has one token, so one user (§9); per-machine tokens map to users when teams arrive.
const LOCAL_USER = 'local';

// §5: a batch is a list of at most 500; what each item must be is checked one by one (#114). The 1 MB cap is Fastify's body limit.
const Envelope = z.object({ events: z.array(z.unknown()).max(500) });
// What a refusal logs of a Zod issue: never its input, which can be captured text.
const brief = ({ code, path, message }: { code: string; path: PropertyKey[]; message: string }) => ({ code, path, message });

type Options = { store: Store; token: string; content: ContentStore; onWritten?: (events: Event[], claims: ClaimLive[]) => void };

export function ingest(app: FastifyInstance, { store, token, content, onWritten }: Options) {
  const expected = Buffer.from(`Bearer ${token}`);

  app.post('/ingest', {
    // onRequest runs before the body is parsed: no token, no work.
    onRequest: async (req, reply) => {
      const got = Buffer.from(req.headers.authorization ?? '');
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) return reply.code(401).send({ error: 'unauthorized' });
    },
  }, async (req, reply) => {
    const batch = Envelope.safeParse(req.body);
    if (!batch.success) {
      const issues = batch.error.issues.slice(0, 20);
      // #111: the plugin drops a refused batch, so this line is the only trace of why. The fields that failed, never the events' text.
      const sent = (req.body as { events?: unknown } | null)?.events;
      req.log.warn({ events: Array.isArray(sent) ? sent.length : undefined, issues: issues.map(brief) }, 'refused an invalid batch');
      return reply.code(400).send({ error: 'invalid batch', issues });
    }
    // #114: each event on its own, so a bad one (a plugin newer than this server, most likely) costs itself and not its batch.
    const valid: Event[] = [];
    const kinds = new Set<string>(); // an unknown kind's issue lists the 23 known ones, never the one sent
    const issues = new Map<string, ReturnType<typeof brief>>(); // the same failure in many events is logged once, at its first
    batch.data.events.forEach((item, i) => {
      const one = Event.safeParse(item);
      if (one.success) return void valid.push(one.data);
      const kind = (item as { kind?: unknown } | null)?.kind;
      if (typeof kind === 'string') kinds.add(kind.slice(0, 40)); // a kind is the plugin's own name for an event, not captured text
      for (const issue of one.error.issues) {
        const key = `${issue.code}\0${issue.path.join('.')}\0${issue.message}`;
        if (!issues.has(key)) issues.set(key, brief({ ...issue, path: ['events', i, ...issue.path] }));
      }
    });
    const rejected = batch.data.events.length - valid.length;
    if (rejected) req.log.warn({ events: batch.data.events.length, rejected, kinds: [...kinds].slice(0, 20), issues: [...issues.values()].slice(0, 20) }, 'refused invalid events');
    // The server, not the mod, says who sent it.
    const events = valid.map(({ team_id: _, ...e }) => ({ ...e, user_id: LOCAL_USER }));
    // Text first, then the history: both are idempotent on their ids, so a crash between leaves text with no row yet, which a retry fills.
    content.put(contentRows(events));
    const result = writeEvents(store, events, 'plugin');
    // v0.3 slice 4 (#44): an answer that ended in this batch is checked against its agent's calls, now that they are stored (a batch sent again gives the same rows).
    let claims: ClaimLive[] = [];
    try {
      claims = checkAnswers(store, content, events);
    } catch (err) {
      req.log.error(err, 'the claims check failed'); // it is a reading of what was stored: its failure must not make the plugin resend a batch that was written
    }
    onWritten?.(events, claims); // the live state skips ids it has seen, so a duplicate batch changes nothing
    return { ...result, rejected };
  });
}
