import { createClaude } from './analysis-claude.ts';
import { openAnalysisStore } from './analysis-store.ts';
import { buildApp } from './app.ts';
import { openContentStore } from './content-store.ts';
import { historyPath, openStore } from './store/store.ts';

const env = process.env;
const need = (key: string): string => env[key] || (console.error(`${key} is required (see deploy/.env.example)`), process.exit(1));

const studioDir = env.STUDIO_DIR ?? new URL('../../studio/dist', import.meta.url).pathname;
const content = openContentStore(env.CONTENT_DB ?? 'content.db');
const store = openStore(historyPath(env)); // history.db, beside the text store
const reports = openAnalysisStore(env.CONTENT_DB ?? 'content.db'); // the same file: a report is text
// Slice 7: the owner's key, from deploy/.env; without it the Analysis page says so and nothing can be sent.
const claude = env.ANTHROPIC_API_KEY ? createClaude(env.ANTHROPIC_API_KEY, env.ANTHROPIC_WORKSPACE_ID || undefined) : null;
const app = buildApp({ store, token: need('ORB_TOKEN'), logger: true, studioDir, content, reports, claude, allowedHosts: env.ORB_ALLOWED_HOSTS?.split(',') });
await app.listen({ host: env.HOST ?? '127.0.0.1', port: Number(env.PORT ?? 4040) });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close(); // lets in-flight batches finish their transaction
    content.close();
    reports.close();
    store.close();
    process.exit(0);
  });
}
