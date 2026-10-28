import Anthropic from '@anthropic-ai/sdk';
import { MAX_OUTPUT, REPORT_SCHEMA } from './analysis-core.ts';

// Slice 7: the only place the server talks to Claude, behind two calls so tests use a stand-in and never spend.
// count() is the API's token counter (no generation); run() is one request, made only after the person confirmed.

export type RunResult = {
  text: string; model: string; stop: string | null;
  usage: { input: number; output: number; cache_read: number; cache_creation: number };
};
/** The API refused (4xx, 5xx): its status and its own message, so the page can say what to fix. Nothing was billed. */
export class ClaudeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Claude = {
  count(model: string, system: string, user: string): Promise<number>;
  run(model: string, system: string, user: string): Promise<RunResult>;
};

const format = { format: { type: 'json_schema' as const, schema: REPORT_SCHEMA } };
// Server-side refusal fallback where the model has one (the claude-api skill: Opus and Sonnet; Haiku 5.5 has none).
const FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

// A key that is not scoped to a workspace needs the workspace named on every request (the API's own answer, 2026-10-21).
export function createClaude(apiKey: string, workspaceId?: string): Claude {
  const client = new Anthropic({ apiKey, ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}) });
  const plain = (e: unknown) => {
    if (!(e instanceof Anthropic.APIError)) return e;
    const body = e.error as { error?: { message?: string } } | undefined;
    return new ClaudeError(e.status ?? 0, body?.error?.message ?? e.message);
  };
  return {
    async count(model, system, user) {
      const r = await client.messages.countTokens({ model, system, messages: [{ role: 'user', content: user }], output_config: format }).catch((e) => { throw plain(e); });
      return r.input_tokens;
    },
    async run(model, system, user) {
      const r = await client.beta.messages.create({
        model, max_tokens: MAX_OUTPUT, system, messages: [{ role: 'user', content: user }],
        thinking: { type: 'adaptive' }, output_config: format,
        ...(FALLBACK.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      }).catch((e) => { throw plain(e); });
      const text = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return {
        text, model: r.model, stop: r.stop_reason,
        usage: { input: r.usage.input_tokens, output: r.usage.output_tokens, cache_read: r.usage.cache_read_input_tokens ?? 0, cache_creation: r.usage.cache_creation_input_tokens ?? 0 },
      };
    },
  };
}
