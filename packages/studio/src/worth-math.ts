import { plural, usd } from './format.ts';
import type { FigureData, Said } from './kit.tsx';
import { monthName, money, shortDate } from './trends-math.ts';

// The Ledger's Worth view (v0.3 slice 2, #42, design/v0.3-worth-truth.html; #103, design/v0.3-readable.html), kept pure for tests: the reading and the figures the card shows,
// a PR's row, the owner's numbers as typed, and the reducer behind the optimistic tap. The figures come from GET /api/worth (packages/server/src/api/worth.ts); the
// studio recomputes only what a tap or a saved setting changes, with the server's own formulas (the auto size among them), and the next load replaces it.

export const SIZE_NAMES = ['S', 'M', 'L', 'XL'] as const;
export type SizeName = (typeof SIZE_NAMES)[number];
export type Size = SizeName | 'skip';
export type Sizes = Record<SizeName, number>;
/** The score each of S, M and L is below; XL is from L's. */
export type Cuts = { S: number; M: number; L: number };
export const CUT_NAMES = ['S', 'M', 'L'] as const;
export type CutName = (typeof CUT_NAMES)[number];
export type Settings = { rate: number | null; plan: number | null; sizes: Sizes; cuts: Cuts };
/**
 * A merged PR as the server sends it. `size` is the one in force: the owner's when `yours`, else the score's (null when the plugin counted nothing yet). `countedLines` and
 * `countedFiles` are what the score is made of, after lockfiles, images, build output and generated files are set aside. Sessions, agents and cost are its share of
 * the sessions that opened it.
 */
export type Pr = {
  number: number; title: string | null; mergedAt: number; additions: number; deletions: number; countedLines: number | null; countedFiles: number | null;
  size: Size | null; yours: boolean; sessions: number; agents: number; cost: number;
};
export type WorthData = {
  settings: Settings; month: string;
  attentionHours: number; waitsHours: number; prompts: number; days: number; apiCost: number; costPartial: boolean;
  prs: Pr[]; releaseMerges: number; sized: number; total: number; byHandHours: number; netHours: number; value: number | null; return: number | null;
};

// ── Sizes ────────────────────────────────────────────────────────────────────

/** lines x (1 + log2 files); files below 1 count as 1, so no files scores the lines alone. The server's own formula (api/worth.ts). */
export const score = (lines: number, files: number) => lines * (1 + Math.log2(Math.max(files, 1)));

/** S below `cuts.S`, M below `cuts.M`, L below `cuts.L`, XL from there; none without both counts. */
export function autoSize(lines: number | null, files: number | null, cuts: Cuts): SizeName | null {
  if (lines === null || files === null) return null;
  const sc = score(lines, files);
  return sc < cuts.S ? 'S' : sc < cuts.M ? 'M' : sc < cuts.L ? 'L' : 'XL';
}

// ── Months ───────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** The month `now` is in, in the viewer's zone (the zone the request names): `YYYY-MM`. */
export const monthKey = (now: Date) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

/** The month `delta` months from `month`; none past the current one (a month that has not happened has nothing to show). */
export function stepMonth(month: string, delta: number, now: Date): string | undefined {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(y, m - 1 + delta, 1); // the 1st, so no month's length can carry it into the next
  const key = monthKey(d);
  return key > monthKey(now) ? undefined : key; // YYYY-MM sorts as time does
}

/** `October 2026`. */
export const monthLong = (month: string) => `${monthName(month)} ${month.slice(0, 4)}`;

/** `October so far` for the current month, else `September 2026`; the year is what tells October 2025 from this one. */
export const monthTitle = (month: string, now: Date) => (month === monthKey(now) ? `${monthName(month)} so far` : monthLong(month));

// ── Figures ──────────────────────────────────────────────────────────────────

/** `151 h`, `28.1 h`, `−12 h`: one decimal at most, the typographic minus, never `−0`. */
export function hours(h: number) {
  const r = Math.round(Math.abs(h) * 10) / 10;
  return `${h < 0 && r > 0 ? '−' : ''}${r.toLocaleString('en')} h`;
}

/** Dollars as Trends writes them (whole from $10), a loss with the minus; a loss under half a cent reads $0.00, not `−<$0.01`. */
export function dollars(n: number) {
  if (n >= 0) return money(n);
  return -n < 0.005 ? '$0.00' : `−${money(-n)}`;
}

/** How the month's PRs stand: sized by the score, by the owner, skipped by the owner, or not sized (nothing counted yet). */
function tally(d: WorthData) {
  const t = { auto: 0, yours: 0, skipped: 0, unsized: 0 };
  for (const p of d.prs) {
    if (p.size === null) t.unsized++;
    else if (p.size === 'skip') t.skipped++;
    else if (p.yours) t.yours++;
    else t.auto++;
  }
  return t;
}

const whole = (n: number) => n.toLocaleString('en');
/** "about 892", "about 7.4": whole from 10 hours, one decimal below. */
const about = (h: number) => whole(h >= 10 ? Math.round(h) : Math.round(h * 10) / 10);
/** Dollars to the ten (to the hundred from $10,000) for a sentence: a figure that is an estimate says so by not pretending to cents. */
const aboutUsd = (v: number) => `$${whole(Math.abs(v) >= 10_000 ? Math.round(Math.abs(v) / 100) * 100 : Math.round(Math.abs(v) / 10) * 10)}`;

/**
 * The reading on top, written from the figures (design/v0.3-readable.html, Worth): the PRs merged, what they would have taken by hand, what steering took, and what is left, with the
 * value when a rate is set and the plan when one is. `title` is the period as the card names it ("October so far").
 */
export function worthReading(d: WorthData, project: string, title: string): Said {
  const { rate, plan } = d.settings;
  const sized = d.prs.filter((p) => p.size !== null && p.size !== 'skip').length;
  const good = d.netHours >= 0;
  return [
    `${title}: the `, { b: plural(sized, 'PR') }, ` merged in ${project} would have taken you about `, { b: `${about(d.byHandHours)} hours` }, ' by hand. You spent about ',
    { b: `${about(d.attentionHours)} hours` }, ' steering the agents, so ',
    ...(good ? ['they saved you about ', { b: `${about(d.netHours)} hours` }] : ['steering them took about ', { b: `${about(-d.netHours)} hours` }, ' more than the work would have by hand']),
    ...(d.value === null ? ['.'] : good ? [', worth ', { b: aboutUsd(d.value) }, ` at your ${money(rate!)} an hour.`] : [`, a loss of `, { b: aboutUsd(d.value) }, ` at your ${money(rate!)} an hour.`]),
    ...(plan === null ? [] : [' The plan cost ', { b: money(plan) }, '.']),
  ];
}

/**
 * The card's six figures, as the mock draws them: a plain label, a value, one line, and what the ⓘ opens. A figure that reads below zero is `bad`, decided on what is
 * shown, so the colour and the minus cannot disagree. Before a rate is set Value and Return read "—"; before a plan is, Return does, and What you paid asks for it with
 * the API-equivalent still beside.
 */
export function worthFigures(d: WorthData): FigureData[] {
  const { rate, plan } = d.settings;
  const t = tally(d);
  const sized = t.auto + t.yours;
  const bad = (v: string) => v.startsWith('−');
  const value = d.value === null ? '—' : dollars(d.value);
  const ret = d.return === null ? '—' : dollars(d.return);
  const net = hours(d.netHours);
  return [
    {
      label: 'Time it would have taken you', value: hours(d.byHandHours),
      usual: `${plural(sized, 'PR')} sized: ${t.auto} automatic, ${t.yours} yours.${t.skipped ? ` ${t.skipped} skipped.` : ''}${t.unsized ? ` ${t.unsized} not sized yet.` : ''}`,
      why: "The sum of the hours behind each merged PR's size, release merges left out. The sizes are estimates: automatic ones from the PR's own diff, yours where you tapped another. Edit Sizes changes the hours and the cut points, and every figure here follows.",
    },
    {
      label: 'Time you spent steering', value: hours(d.attentionHours),
      usual: `${plural(d.prompts, 'prompt')} on ${plural(d.days, 'day')}, plus permission waits (up to 10 minutes each).`,
      why: 'From the gaps between your prompts: a gap under 10 minutes counts as working, plus 2 minutes per prompt, plus your permission waits. It is a floor: reading a diff afterwards leaves no trace.',
    },
    {
      label: 'Hours saved', value: net, usual: 'by hand minus steering.', bad: bad(net),
      why: 'The hours it would have taken by hand, less the hours you spent steering. Below zero, the agents cost you time.',
    },
    {
      label: 'Value of those hours', value, usual: rate === null ? 'set your rate.' : `at your ${money(rate)} an hour.`, bad: bad(value),
      why: 'Hours saved times your hourly rate. Your rate is yours to set; it stays on this machine.',
    },
    {
      label: 'What you paid', value: plan === null ? '—' : money(plan), usual: `${plan === null ? 'set your plan' : 'your plan'} · ${money(d.apiCost, d.costPartial)} at API prices.`,
      why: "Your plan's price for the month. The API-equivalent beside it is what the same tokens would have cost at list prices: a plan is cheaper when you use it heavily.",
    },
    {
      label: 'Return on your plan', value: ret, usual: rate === null ? 'set your rate.' : plan === null ? 'set your plan.' : 'value minus what you paid.', bad: bad(ret),
      why: 'The value of the hours saved, less what you paid for the plan. Below zero, the plan cost more than the time it saved.',
    },
  ];
}

// ── Rows ─────────────────────────────────────────────────────────────────────

const HIDDEN_TITLE = '(title hidden: an excluded project)';
const ROWS = 20;

/**
 * One merged PR: `#338`, its title (or why there is none), the muted line under it, the chip that says whose size it is ("auto · L", "yours · M", "yours · skip", "not sized")
 * and, for the chip's tooltip, the score behind it.
 */
export function prRow(p: Pr) {
  const counted = p.countedLines !== null && p.countedFiles !== null;
  const lines = counted ? `${whole(p.countedLines!)} ${p.countedLines === 1 ? 'line' : 'lines'} in ${plural(p.countedFiles!, 'file')}` : `+${p.additions.toLocaleString('en')} −${p.deletions.toLocaleString('en')}`;
  const share = p.sessions === 0 ? 'no session linked' : `part of ${plural(p.sessions, 'session')} · ${plural(p.agents, 'agent')} · ${usd(p.cost)}`;
  return {
    number: p.number, id: `#${p.number}`, hidden: !p.title, title: p.title || HIDDEN_TITLE, size: p.size, yours: p.yours,
    chip: p.size === null ? 'not sized' : `${p.yours ? 'yours' : 'auto'} · ${p.size}`,
    why: counted ? `score ${whole(Math.round(score(p.countedLines!, p.countedFiles!)))} = ${whole(p.countedLines!)} lines × (1 + log₂ ${p.countedFiles} files)` : 'no lines counted yet: the plugin sends them at the next session start',
    meta: `merged ${shortDate(p.mergedAt)} · ${lines} · ${share}`,
  };
}

/**
 * The rows under the figures (design/v0.3-readable.html, Worth): for each size, the PRs that are that size (a skip and a PR not sized yet are none), the hours they add up to
 * and the hours each is worth. `width` is the hours against the largest row, in tenths of a percent; the counts add up to the PRs sized and the hours to `byHandHours`.
 */
export function sizeRows(d: WorthData) {
  const rows = SIZE_NAMES.map((size) => {
    const count = d.prs.filter((p) => p.size === size).length;
    return { size, count, hours: count * d.settings.sizes[size], each: d.settings.sizes[size] };
  });
  const most = Math.max(...rows.map((r) => r.hours), 1);
  return rows.map((r) => ({ ...r, label: `${r.size} · ${plural(r.count, 'PR')}`, width: Math.round((r.hours / most) * 1000) / 10 }));
}

/** The first 20 rows until all are asked for (the server sends newest first); `hidden` is how many are kept back. */
export function firstRows(prs: Pr[], all: boolean) {
  const rows = all ? prs : prs.slice(0, ROWS);
  return { rows: rows.map(prRow), hidden: prs.length - rows.length };
}

/** The PR card's hint: how many, how many are yours, and that release merges are not among them. */
export function prsHint(d: WorthData) {
  if (d.total === 0) return '';
  const t = tally(d);
  const mine = t.yours + t.skipped;
  return `${plural(d.total, 'PR')} · ${mine ? `${mine} sized by you · ` : ''}${t.unsized ? `${t.unsized} not sized yet · ` : ''}newest first · release merges left out`;
}

// ── The month, recomputed ────────────────────────────────────────────────────

/**
 * What hangs on the PRs' sizes and the settings, worked out as the server does (api/worth.ts): a PR is the owner's size or the score's under the cut points (so moving a
 * cut point moves every PR that is not yours); a size adds its hours, a skip adds none and is still an answer; net is by hand minus attention; value needs a rate,
 * return a rate and a plan (a plan of 0 is one).
 */
export function derive(d: WorthData): WorthData {
  const { rate, plan, sizes, cuts } = d.settings;
  const prs = d.prs.map((p) => (p.yours ? p : { ...p, size: autoSize(p.countedLines, p.countedFiles, cuts) }));
  const byHandHours = prs.reduce((t, p) => t + (p.size && p.size !== 'skip' ? sizes[p.size] : 0), 0);
  const netHours = byHandHours - d.attentionHours;
  const value = rate === null ? null : netHours * rate;
  return { ...d, prs, sized: prs.filter((p) => p.size !== null).length, byHandHours, netHours, value, return: value === null || plan === null ? null : value - plan };
}

/** The data on screen, and the project it is for: the response does not name it. */
export type Shown = { project: string; data: WorthData };
export type Action =
  | { type: 'loaded'; project: string; data: WorthData }
  | { type: 'size'; project: string; month: string; number: number; size: Size | null }
  | { type: 'settings'; settings: Settings };

/**
 * A tap makes the PR the owner's at once; `size: null` is Back to Auto. A refused save is the same action with what the PR had (its size when it was yours, null when it was
 * automatic), so the rollback is exact and leaves other taps alone. An action for another project or month than the one shown (a save that lands after the owner moved on),
 * or for a PR that is not on the card, returns the state itself.
 */
export function worthReducer(state: Shown | undefined, a: Action): Shown | undefined {
  if (a.type === 'loaded') return { project: a.project, data: a.data };
  if (!state) return state;
  if (a.type === 'settings') return { ...state, data: derive({ ...state.data, settings: a.settings }) };
  if (a.project !== state.project || a.month !== state.data.month || !state.data.prs.some((p) => p.number === a.number)) return state;
  return { ...state, data: derive({ ...state.data, prs: state.data.prs.map((p) => (p.number === a.number ? { ...p, size: a.size, yours: a.size !== null } : p)) }) };
}

// ── The owner's numbers, as typed ────────────────────────────────────────────

export type Field = { value: number | null } | { error: string };

// Thousands need their groups of three, so "90,50" (a decimal comma) is refused and never read as $9,050.
const AMOUNT = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$|^\.\d+$/;
const BAD_AMOUNT = 'Give an amount in dollars, like 90 or 1,200.50 (cents follow a point)';

/** A number from text: an optional `$`, thousands commas, a decimal point. `''` is a blank; `undefined` is text that is not an amount. */
function amount(text: string): number | '' | undefined {
  const t = text.trim().replace(/^\$\s*/, '');
  if (t === '') return '';
  return AMOUNT.test(t) ? Number(t.replaceAll(',', '')) : undefined;
}

/** An hourly rate: above $0, at most $100,000 (the server's bounds); blank clears it. */
export function parseRate(text: string): Field {
  const n = amount(text);
  if (n === '') return { value: null };
  if (n === undefined) return { error: BAD_AMOUNT };
  return n > 0 && n <= 100_000 ? { value: n } : { error: 'An hourly rate is above $0 and at most $100,000' };
}

/** What the plan costs a month: $0 to $1,000,000; blank clears it. */
export function parsePlan(text: string): Field {
  const n = amount(text);
  if (n === '') return { value: null };
  if (n === undefined) return { error: BAD_AMOUNT };
  return n <= 1_000_000 ? { value: n } : { error: 'A plan costs $0 to $1,000,000 a month' };
}

/** The hours behind a size: above 0, at most 1,000. A size cannot be cleared, so blank is an error. */
export function parseHours(text: string): Field {
  const n = text.includes('$') ? undefined : amount(text); // hours are not dollars
  return typeof n === 'number' && n > 0 && n <= 1000 ? { value: n } : { error: 'Give hours above 0 and at most 1,000, like 0.5 or 16' };
}

const BAD_CUT = 'Give a score above 0 and at most 10,000,000, like 300 or 1,500';
export const CUTS_UP = 'The cut points go up: S is below M, and M is below L.';

/** The score a size starts below: above 0 and at most 10,000,000 (the server's bounds); a cut point cannot be cleared, so blank is an error. Thousands commas are fine. */
export function parseCut(text: string): Field {
  const n = text.includes('$') ? undefined : amount(text);
  return typeof n === 'number' && n > 0 && n <= 10_000_000 ? { value: n } : { error: BAD_CUT };
}

/** A cut point as Edit Sizes shows it: thousands grouped, as the mock writes 1,500. */
export const cutText = (n: number) => whole(n);

/** Edit Sizes as typed: the hours of the four sizes and the three cut points. The first field that is wrong is named, and the cut points must go up. */
export function parseSizesForm(hoursText: Record<SizeName, string>, cutsText: Record<CutName, string>): { sizes: Sizes; cuts: Cuts } | { error: string } {
  const h = SIZE_NAMES.map((k) => [k, parseHours(hoursText[k])] as const);
  const c = CUT_NAMES.map((k) => [k, parseCut(cutsText[k])] as const);
  for (const [k, f] of h) if ('error' in f) return { error: `${k}: ${f.error}` };
  for (const [k, f] of c) if ('error' in f) return { error: `${k} is below: ${f.error}` };
  const sizes = Object.fromEntries(h.map(([k, f]) => [k, (f as { value: number }).value])) as Sizes;
  const cuts = Object.fromEntries(c.map(([k, f]) => [k, (f as { value: number }).value])) as Cuts;
  return cuts.S < cuts.M && cuts.M < cuts.L ? { sizes, cuts } : { error: CUTS_UP };
}
