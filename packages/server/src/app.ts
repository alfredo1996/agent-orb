import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { analysis } from './api/analysis.ts';
import type { Claude } from './analysis-claude.ts';
import { openAnalysisStore, type AnalysisStore } from './analysis-store.ts';
import { goal } from './api/goal.ts';
import { history } from './api/history.ts';
import { openContentStore, type ContentStore } from './content-store.ts';
import { ledger } from './api/ledger.ts';
import { patterns } from './api/patterns.ts';
import { pipeline } from './api/pipeline.ts';
import { skills } from './api/skills.ts';
import { trends } from './api/trends.ts';
import { worth } from './api/worth.ts';
import { ingest } from './ingest.ts';
import { newLive } from './live.ts';
import { get, openStore, type Store } from './store/store.ts';
import { stream } from './stream.ts';

type Options = { store?: Store; token: string; logger?: FastifyServerOptions['logger']; studioDir?: string; content?: ContentStore; reports?: AnalysisStore; claude?: Claude | null; now?: () => number; allowedHosts?: string[] };

// Issue #62: DNS rebinding. A hostile page whose name was rebound to 127.0.0.1 sends that name as Host and as Origin,
// and foreign() reads the two as agreeing. So only this machine's own names are answered; ORB_ALLOWED_HOSTS adds more.
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const hostName = (host: string) => host.trim().toLowerCase().replace(/:\d*$/, ''); // any port is fine: compose maps it

// ponytail: an in-memory text store and history store when none is given (tests, a quick run); main.ts opens the files.
export function buildApp({ store = openStore(':memory:'), token, logger = false, studioDir, content = openContentStore(':memory:'), reports = openAnalysisStore(':memory:'), claude = null, now, allowedHosts = [] }: Options) {
  const app = Fastify({ logger, bodyLimit: 1_048_576 }); // §5: a batch is at most 1 MB

  const hosts = new Set([...LOOPBACK, ...allowedHosts.map(hostName)].filter(Boolean)); // an empty entry must not admit an empty Host
  // First, so every route and the static files sit behind it. Raw setHeader, not reply.header: /stream hijacks the reply and writes its own head.
  app.addHook('onRequest', async (req, reply) => {
    reply.raw.setHeader('content-security-policy', "frame-ancestors 'none'");
    reply.raw.setHeader('x-content-type-options', 'nosniff');
    if (!hosts.has(hostName(req.headers.host ?? ''))) return reply.code(403).send({ error: 'this server answers to 127.0.0.1, localhost and [::1] only; add a name to ORB_ALLOWED_HOSTS to serve it under another' });
  });

  // Healthy while the history store answers a query (one that reads a table, so a closed or unreadable file fails it).
  app.get('/healthz', async (_req, reply) => {
    try {
      get(store, 'SELECT 1 FROM projects LIMIT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'history store unavailable' });
    }
  });

  // The studio's build (packages/studio/dist) at /, when there is one.
  if (studioDir && existsSync(studioDir)) app.register(fastifyStatic, { root: studioDir });

  const broadcast = stream(app, newLive(store));
  ingest(app, { store, token, content, onWritten: broadcast });
  ledger(app, { store, analysis: reports });
  trends(app, { store });
  goal(app, { store, now }); // now: the clock the month is read by; a test moves it
  history(app, { store, content });
  skills(app, { store });
  analysis(app, { store, content, reports, claude }); // claude is null without ANTHROPIC_API_KEY: nothing can be sent
  worth(app, { store, reports }); // the owner's rate, plan and sizes live in the same file as the cap
  patterns(app, { store, content }); // v0.3 slice 3 (#45): the store's classes and shapes; only a repeat's sample reads the text store
  pipeline(app, { store }); // the Pipeline, its role fixes, and the lanes and lists its pickers ask for
  return app;
}
