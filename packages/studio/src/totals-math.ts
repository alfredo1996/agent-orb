import { duration, plural, readTokens, usd } from './format.ts';
import type { FigureData, Said } from './kit.tsx';
import { FAILED_USUAL } from './ledger-math.ts';
import { money } from './trends-math.ts';
import { hours } from './worth-math.ts';

// The Ledger's Totals view (#102, design/v0.3-readable.html), kept pure for tests: the sentence on top and the six figures under it, from GET /api/ledger. Where a figure has
// a previous period to be compared with, its line says whether it is usual; where the API returns none, it says nothing.

export type Range = 'today' | '7d' | '30d';
export type Sums = { tokens: number; cost: number | null; costPartial: boolean };
export type Totals = Sums & {
  cacheShare: number | null; sessions: number; agents: number; toolCalls: number; failedCalls: number; waits: number; waitMs: number; waitMsFull: number; waitsOverHour: number;
  previousTokens: number; previousCost: number | null; pricier: { agents: number; cost: number };
};
export type Eff = { tokens: number; cacheShare: number | null };

const PERIOD: Record<Range, { when: string; before: string }> = {
  today: { when: 'Today', before: 'the period before' },
  '7d': { when: 'In the last 7 days', before: 'the 7 days before' },
  '30d': { when: 'In the last 30 days', before: 'the 30 days before' },
};

// ponytail: fixed thresholds for "usual"; make them settings if they turn out wrong for someone.
const USUAL_BAND = 0.25; // a period within a quarter of the one before is "about usual"
const BIG_PROJECT = 100_000_000; // tokens: a project under it is a trial run, and its cache share says nothing about what is usual

const cost = (t: Sums) => (t.cost === null ? '—' : money(t.cost, t.costPartial));
const failedRate = (t: Totals) => (t.toolCalls ? t.failedCalls / t.toolCalls : null);
const share = (r: number) => `${Math.round(r * 100)}%`;
const tenth = (r: number) => `${(r * 100).toFixed(1)}%`;
const n = (x: number) => x.toLocaleString('en');
/** A whole percent of `prev`, signed: the period before as the base. None without a base to divide by. */
const move = (cur: number, prev: number) => (prev ? Math.round(((cur - prev) / prev) * 100) : null);

/** "About usual: 7% fewer than the 7 days before (4.9 B)." Above or below the band, it says so instead; nothing without a period before. */
function tokensVersus(cur: number, prev: number, before: string) {
  const p = move(cur, prev);
  if (p === null) return undefined;
  const how = p === 0 ? `the same as ${before}` : `${Math.abs(p)}% ${p < 0 ? 'fewer' : 'more'} than ${before}`;
  const usual = Math.abs(cur - prev) / prev <= USUAL_BAND ? 'About usual' : cur > prev ? 'Above usual' : 'Below usual';
  return `${usual}: ${how} (${readTokens(prev)}).`;
}

/** "13% less than the 7 days before ($3,000). Your plan is a flat fee, not this." No percentage unless both costs are whole: a floor, or nothing before, says only what the figure is. */
function costVersus(t: Totals, before: string) {
  const p = t.cost === null || t.costPartial || !t.previousCost ? null : move(t.cost, t.previousCost);
  if (p === null) return 'At list prices, not a bill.';
  return `${p === 0 ? `The same as ${before}` : `${Math.abs(p)}% ${p < 0 ? 'less' : 'more'} than ${before}`} (${money(t.previousCost!)}). Your plan is a flat fee, not this.`;
}

/** What the agents used, what it would cost, how much came from cache and how many calls failed, in a sentence. */
export function totalsReading(t: Totals, range: Range): Said {
  const { when, before } = PERIOD[range];
  const p = move(t.tokens, t.previousTokens);
  const rate = failedRate(t);
  return [
    `${when}, `, { b: plural(t.sessions, 'session') }, ' and ', { b: plural(t.agents, 'agent') }, ' used ', { b: `${readTokens(t.tokens, true)} tokens` },
    p === null ? '.' : p === 0 ? `, as many as in ${before}.` : `, ${Math.abs(p)}% ${p < 0 ? 'fewer' : 'more'} than in ${before}.`,
    ...(t.cost === null ? [] : [' That is ', { b: cost(t) }, ' at API prices.']),
    ...(t.cacheShare === null ? [] : [' ', { b: share(t.cacheShare) }, ' of what they read came from cache, which costs a tenth as much.']),
    ...(rate === null ? [] : [' ', { b: tenth(rate) }, ' of tool calls failed.']),
  ];
}

/** The six figures: tokens, cost, cache, failed calls, the wait for you, and the spend above the model set. */
export function totalsFigures(t: Totals, eff: Eff[], range: Range): FigureData[] {
  const rate = failedRate(t);
  const reads = eff.filter((e) => e.tokens >= BIG_PROJECT && e.cacheShare !== null).map((e) => Math.round(e.cacheShare! * 100));
  // the waits uncapped: hours, or as they run when under one, where "0 h" would say nothing
  const full = t.waitMsFull < 3_600_000 ? duration(t.waitMsFull) : hours(t.waitMsFull / 3_600_000);
  const over = t.waitsOverHour ? `${t.waitsOverHour} stayed open over an hour.` : 'None stayed open over an hour.';
  return [
    {
      label: 'Tokens used', value: readTokens(t.tokens), usual: tokensVersus(t.tokens, t.previousTokens, PERIOD[range].before),
      why: 'Every token the models read or wrote: your prompts, the files they opened, their answers, and the cached text they re-read on every turn. Most of it is cached text read again, so the number is large and cheap.',
    },
    {
      label: 'What it would cost at API prices', value: cost(t), usual: costVersus(t, PERIOD[range].before),
      why: "What these tokens would cost at the API's list prices (`pricing.json`). It is not what you pay. Cache writes are priced as 5-minute writes and Claude Code's 1-hour writes cost more, so this reads a little low.",
    },
    {
      label: 'Read from cache', value: t.cacheShare === null ? '—' : share(t.cacheShare),
      // one project has no range to be usual in
      usual: reads.length > 1 ? `Usual: every project reads ${Math.min(...reads)}% to ${Math.max(...reads)}% from cache.` : undefined,
      why: 'Of all the input the models read, the share that came from cache instead of being sent fresh. A cache read costs a tenth as much per token, so a high share keeps the cost down. A low one means the models re-read text at full price.',
    },
    {
      label: 'Tool calls that failed', value: rate === null ? '—' : tenth(rate),
      usual: rate === null ? undefined : `${n(t.failedCalls)} of ${n(t.toolCalls)} calls. ${rate >= FAILED_USUAL ? 'More than usual' : 'Usual'}: under ${FAILED_USUAL * 100}% is normal.`,
      why: 'A tool call that came back with an error: a command that exited non-zero, a file that was not there, a call that was refused. Some failure is normal (a failing test is a call that did its job). Analysis → Patterns shows which ones repeat.',
    },
    {
      label: 'Agents waiting for you', value: duration(t.waitMs),
      // 10 minutes is WINDOW_MS in packages/server/src/api/ledger.ts, the same cap Worth counts a wait with
      usual: t.waits ? `${plural(t.waits, 'permission prompt')}, each counted up to 10 minutes (${full} counted in full). ${over}` : 'No agent waited at a permission prompt.',
      why: `The time tool calls sat at a permission prompt, waiting for you. A dialog left open overnight would read as hours, so each wait counts at most 10 minutes, as Worth counts it.${t.waits ? ` Counted in full it would read ${full}.` : ''}`,
    },
    {
      label: 'Spent above the model set', value: usd(t.pricier.cost),
      usual: t.pricier.agents ? `${plural(t.pricier.agents, 'agent')} ran on a pricier model than it should.` : 'None: no agent ran on a pricier model than it should.',
      why: 'Spend by agents that ran on a pricier model than their agent file allows (or than your ceiling, Sonnet by default, for agents with no file). The main session is never counted. Live flags these agents while they run.',
    },
  ];
}
