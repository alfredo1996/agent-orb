import { z } from 'zod';
import { costUsd } from './cost.ts';

// Slice 7 (PROJECT.md §15, 2026-10-21): what an analysis costs at most, whether the month's cap allows it, and the
// digest of a project's week that Claude reads. Pure: the route (api/analysis.ts) gathers the rows and makes the calls.

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' }, // the owner's default (§15, 2026-10-21)
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
] as const;
export type ModelId = (typeof MODELS)[number]['id'];
export const MAX_OUTPUT = 16_000; // a report, not a book; non-streaming stays under the SDK's timeout at this size

/** The input as counted, and every output token allowed, at list prices: the most a run can cost. */
export function costAtMost(model: string, inputTokens: number, maxOutput: number): number {
  const c = costUsd(model, { input: inputTokens, output: maxOutput, cache_read: 0, cache_creation: 0 });
  if (c === null) throw new Error(`no price for ${model} in pricing.json`);
  return c;
}

const cents = (n: number) => Math.round(n * 100) / 100;
/** A run is allowed only if the month stays within the cap with all of its output used. */
export const decide = (spent: number, costMax: number, cap: number) => ({ allowed: cents(spent + costMax) <= cap, after: cents(spent + costMax) });

// ponytail: the month is the UTC month (the server's clock in the container); a local-time month needs the owner's zone.
export const monthStart = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

type How = { you: number; model: number; agent: number; preload: number };
export type DigestData = {
  project: string; from: number; to: number; content: 'off' | 'full' | 'mixed';
  sessions: { count: number; byModel: { model: string; tokens: number; cost: number | null }[] };
  topSessions: { id: string; started_at: number; tokens: number; agents: number }[];
  agents: { type: string; count: number; tokens: number; cost: number | null; calls: number; failed: number }[];
  skills: { ran: { name: string; source: string; runs: number; tokens: number; how: How }[]; idle: { name: string; source: string; tokens: number }[] };
  tools: { tool: string; calls: number; failed: number; errors: string[] }[];
  failures: { ts: number; agent: string; tool: string; error?: string; input?: string; output?: string }[];
  thinking: { steps: number; withText: number };
};

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const usd = (n: number | null) => (n === null ? 'unpriced' : `$${n.toFixed(2)}`);
const clip = (s: string | undefined, n: number) => (!s ? '' : s.length > n ? `${s.slice(0, n)}…` : s);
function list<T>(items: T[], max: number, line: (t: T) => string, what: string) {
  const shown = items.slice(0, max).map(line);
  return items.length > max ? [...shown, `(+${items.length - max} more ${what} not shown)`] : shown;
}

/**
 * The week as Claude reads it: plain text, every list cut to its largest entries with a count of the rest, every
 * captured text clipped, so a busy week stays a bounded input. The estimate counts exactly this text.
 */
export function digestText(d: DigestData): string {
  const lines = [
    `Project: ${d.project}. Period: ${day(d.from)} to ${day(d.to)}. ${d.sessions.count} sessions.`,
    `Content capture: ${d.content}; thinking: ${d.thinking.withText} of ${d.thinking.steps} steps carry text.`,
    '', '## Tokens and API-equivalent cost by model',
    ...list(d.sessions.byModel, 20, (m) => `- ${m.model}: ${k(m.tokens)} tokens, ${usd(m.cost)}`, 'models'),
    '', '## The largest sessions',
    ...list(d.topSessions, 10, (s) => `- ${s.id.slice(0, 8)} (${day(s.started_at)}): ${k(s.tokens)} tokens, ${s.agents} agents`, 'sessions'),
    '', '## Agents by type',
    ...list(d.agents, 30, (a) => `- ${a.type}: ${a.count} agents, ${k(a.tokens)} tokens, ${usd(a.cost)}, ${a.calls} tool calls, ${a.failed} failed`, 'agent types'),
    '', '## Skills that ran (tokens include what each started)',
    ...list(d.skills.ran, 40, (s) => `- /${s.name} (${s.source}): ${s.runs} runs, ${k(s.tokens)} tokens; started by you ${s.how.you}, the model ${s.how.model}, an agent ${s.how.agent}, preload ${s.how.preload}`, 'skills'),
    '', `## Skills listed in every session that never ran (${d.skills.idle.length}, ${k(d.skills.idle.reduce((n, s) => n + s.tokens, 0))} listing tokens per session)`,
    ...list(d.skills.idle, 60, (s) => `- ${s.name} (${s.source}): ${s.tokens} tokens`, 'skills'),
    '', '## Tools',
    ...list(d.tools, 40, (t) => `- ${t.tool}: ${t.calls} calls, ${t.failed} failed${t.errors.length ? ` (${t.errors.slice(0, 5).join('; ')})` : ''}`, 'tools'),
    '', '## Failed tool calls, newest first',
    ...list(d.failures, 40, (f) => `- ${day(f.ts)} ${f.agent} · ${f.tool}${f.error ? ` · ${f.error}` : ''}${f.input ? `\n  input: ${clip(f.input, 400)}` : ''}${f.output ? `\n  output: ${clip(f.output, 600)}` : ''}`, 'failures'),
  ];
  return lines.join('\n');
}

export const SYSTEM = [
  'You analyse telemetry that agent-orb recorded from Claude Code sessions for one project and one period.',
  'The reader is the developer who runs these agents and pays for the tokens. Help them spend fewer tokens for the same work, and see why things fail.',
  'Use only the data given. Every claim names its numbers; when the data cannot tell, say so instead of guessing.',
  'Sections: where the tokens went; skills that cost the most and skills that never run; repeated failures; anything else the data shows.',
  'Changes: concrete steps the developer can take, each with why (the evidence) and the saving it should bring, marked approximate.',
].join('\n');

/** What Claude returns, enforced by structured output and checked again on arrival. */
export const Report = z.object({
  summary: z.string(),
  sections: z.array(z.object({ title: z.string(), body: z.string(), evidence: z.array(z.string()) })),
  changes: z.array(z.object({ title: z.string(), why: z.string(), saving: z.string() })),
});
export type Report = z.infer<typeof Report>;
const str = { type: 'string' } as const;
export const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'sections', 'changes'],
  properties: {
    summary: str,
    sections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'body', 'evidence'],
      properties: { title: str, body: str, evidence: { type: 'array', items: str } } } },
    changes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'why', 'saving'],
      properties: { title: str, why: str, saving: str } } },
  },
};
