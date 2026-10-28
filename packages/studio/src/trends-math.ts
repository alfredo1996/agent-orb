import { plural, usd } from './format.ts';
import type { FigureData, Said } from './kit.tsx';
import { bucketLabel, dayKey, dayKeys, rangeOf, stackParts } from './ledger-math.ts';

// The Ledger's Trends view (v0.2 slice 1, design/v0.2-measure.html), kept pure for tests. Money is API-equivalent dollars. Dates are the
// viewer's local ones, as GET /api/trends buckets them (tz); a week starts on Monday, as the API's SQL buckets it.

export type TrendUnit = 'week' | 'day';
export type Split = 'who' | 'model';
export type TBucket = {
  bucket: string; main: number; typed: number; generic: number; opus: number; sonnet: number; haiku: number; other: number;
  tokens: number; cacheRead: number; inputSide: number; activeDays: number; prompts: number; costPartial: boolean;
};
export type Side = { days: number; cost: number; generic: number; typed: number; opus: number };
export type Commit = { sha: string; ts: number; subject: string | null; files: string[] };
/** A file a plugin fingerprint found changed at a session start that no commit explains: the project's own, or yours (`~/.claude/CLAUDE.md`, `~/.claude/rules/*`). */
export type Seen = { path: string; scope: 'project' | 'user'; ts: number; deleted: boolean };
/**
 * A day on which the project's agents, skills or CLAUDE.md changed (one per project and local day, as GET /api/trends groups them): by commits,
 * by what a fingerprint saw, or both. `files` is the API's union of the two.
 */
export type Change = { id: string; day: string; ts: number; commits: Commit[]; seen: Seen[]; files: string[]; before: Side | null; after: Side | null };
export type Numbered = Change & { n: number };

// ── Weeks and the span a view shows ──────────────────────────────────────────

const monday = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));

/** The Monday of the week `d` is in, as YYYY-MM-DD: the week's bucket. */
export const weekKey = (d: Date) => dayKey(monday(d));

/** Every Monday from the week of `from` to the week of `to`. Weeks are added as calendar days, so a clock change never moves one. */
export function weekKeys(from: number, to: number) {
  const keys: string[] = [];
  for (const d = monday(new Date(from)); d.getTime() <= to; d.setDate(d.getDate() + 7)) keys.push(dayKey(d));
  return keys;
}

/** Week: this week and the 11 before it. Day: the last 30, today the last. Both end now. */
export function spanOf(unit: TrendUnit, now: Date) {
  if (unit === 'day') return rangeOf('30d', now);
  const first = monday(now);
  first.setDate(first.getDate() - 11 * 7);
  return { from: first.getTime(), to: now.getTime() };
}

const zero = (bucket: string): TBucket => ({ bucket, main: 0, typed: 0, generic: 0, opus: 0, sonnet: 0, haiku: 0, other: 0, tokens: 0, cacheRead: 0, inputSide: 0, activeDays: 0, prompts: 0, costPartial: false });

/** The API returns only buckets with data; the chart needs every one of the span, a bucket with nothing as zeros. */
export function fillBuckets(buckets: TBucket[], unit: TrendUnit, from: number, to: number): TBucket[] {
  return (unit === 'week' ? weekKeys(from, to) : dayKeys(from, to)).map((k) => buckets.find((b) => b.bucket === k) ?? zero(k));
}

/** A bucket's name on the axis: `17 Aug` for a week (its Monday), `Mon 19` for a day. */
export const trendLabel = (key: string, unit: TrendUnit) => (unit === 'day' ? bucketLabel(key, 'day') : dayName(key));

/** `20 Oct`, from a `YYYY-MM-DD` the server named (read at noon, so no clock change can move it). */
export const dayName = (day: string) => shortDate(new Date(`${day}T12:00:00`).getTime());

/** `20 Oct`, in the viewer's zone. */
export function shortDate(ts: number) {
  const d = new Date(ts);
  return `${d.getDate()} ${d.toLocaleDateString('en', { month: 'short' })}`;
}

// ── Money ────────────────────────────────────────────────────────────────────

/** Whole dollars from $10 up, cents below, so a quiet project still reads; unpriced requests make the figure a floor. */
export const money = (n: number, partial = false) => (n >= 10 ? `${partial ? '≥ ' : ''}$${Math.round(n).toLocaleString('en')}` : usd(n, partial));

/** An axis figure: `$200`, `$1.5k`, `$0.04`. */
export const axisMoney = (v: number) => (v >= 1000 ? `$${+(v / 1000).toFixed(1)}k` : `$${+v.toFixed(v >= 1 ? 1 : 2)}`);

// ── Who spent, which model: the two ways to stack a bar ──────────────────────

type PartKey = 'main' | 'typed' | 'generic' | 'opus' | 'sonnet' | 'haiku' | 'other';
export type Part = { key: PartKey; name: string; long: string; color: string };
/** Bottom to top; the legend, the tooltip and the table read in the same order. `long` is the legend's wording. */
export const PARTS: Record<Split, Part[]> = {
  who: [
    { key: 'main', name: 'Main session', long: 'Main session', color: 'var(--data)' },
    { key: 'typed', name: 'Agents on their own model', long: 'Agents on their own model', color: 'var(--ok-dot)' },
    { key: 'generic', name: 'Generic agents', long: 'Generic agents, no model of their own', color: 'var(--wait-dot)' },
  ],
  model: [
    { key: 'opus', name: 'Opus', long: 'Opus', color: 'var(--opus)' },
    { key: 'sonnet', name: 'Sonnet', long: 'Sonnet', color: 'var(--sonnet)' },
    { key: 'haiku', name: 'Haiku', long: 'Haiku', color: 'var(--haiku)' },
    { key: 'other', name: 'Other', long: 'Other', color: 'var(--faint)' },
  ],
};

/** What a bar adds up to in a split. The two agree on real data; a bar's label is the sum of what it shows. */
export const totalOf = (b: TBucket, split: Split = 'who') => PARTS[split].reduce((n, p) => n + b[p.key], 0);

/** One bar as stacked segments (see `stackParts`), each with its colour. */
export function barSegments(b: TBucket, split: Split, y: (v: number) => number) {
  const parts = PARTS[split];
  return stackParts(parts.map((p) => ({ key: p.key, value: b[p.key] })), y).map((s) => ({ ...s, color: parts.find((p) => p.key === s.key)!.color }));
}

// ── The figures and the reading: this bucket against the one before ─────────

/** `cur` against `prev`, a whole percent; none without a base to divide by. */
export const pctChange = (cur: number | null, prev: number | null) => (cur === null || prev === null || prev === 0 ? null : Math.round(((cur - prev) / prev) * 100));

/** `−29%`, `+12%`, and a bare `0%` when it rounds to nothing. */
export const signed = (p: number) => (p === 0 ? '0%' : `${p < 0 ? '−' : '+'}${Math.abs(p)}%`);

const ratio = (n: number, d: number) => (d ? n / d : null);
const whole = (r: number) => `${Math.round(r * 100)}%`;
const tenth = (r: number) => `${(r * 100).toFixed(1)}%`;
const dash = <T,>(v: T | null, show: (v: T) => string) => (v === null ? '—' : show(v));
const up = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "−29% on last week's $103"; when there is no percent, last week's own figure, or "none" if it had nothing. */
const against = (cur: number | null, prev: number | null, show: (n: number) => string, last: string) => {
  const p = pctChange(cur, prev);
  return p !== null ? `${signed(p)} on ${last}'s ${show(prev!)}` : prev === null ? `none ${last}` : `${last}'s ${show(prev)}`;
};

/** The four figures of the view, for the last bucket against the one before it. A figure with a divisor of 0 reads "—". */
export function trendFigures(series: TBucket[], unit: TrendUnit): FigureData[] {
  const cur = series.at(-1) ?? zero(''), prev = series.at(-2) ?? zero('');
  const [now, last] = unit === 'week' ? ['this week', 'last week'] : ['today', 'yesterday'];
  const span = unit === 'week' ? 'week' : 'day';
  const perDay = (b: TBucket) => ratio(totalOf(b), b.activeDays);
  const perPrompt = (b: TBucket) => ratio(totalOf(b), b.prompts);
  const generic = (b: TBucket) => ratio(b.generic, totalOf(b));
  const cache = (b: TBucket) => ratio(b.cacheRead, b.inputSide);
  const dollars = (b: TBucket) => (n: number) => money(n, b.costPartial);
  const was = (r: number | null, show: (r: number) => string) => `${r === null ? 'nothing' : show(r)} ${last}`;
  return [
    {
      label: 'What a working day costs', value: dash(perDay(cur), dollars(cur)),
      usual: `${dollars(cur)(totalOf(cur))} so far over ${plural(cur.activeDays, 'working day')}, so it can still move. ${up(against(perDay(cur), perDay(prev), dollars(prev), last))}.`,
      why: `The ${span}'s cost at API prices divided by the days you worked in it (a day with at least one prompt), so a quiet weekend does not read as a saving.${unit === 'week' ? ' Early in the week there is only one day to divide by.' : ''}`,
    },
    {
      label: 'What one prompt costs', value: dash(perPrompt(cur), dollars(cur)), usual: `${up(against(perPrompt(cur), perPrompt(prev), dollars(prev), last))}.`,
      why: `The ${span}'s cost at API prices divided by the prompts you typed in it. A prompt that sends several agents to work costs more than one that gets a quick answer.`,
    },
    {
      label: 'Spent by generic agents', value: dash(generic(cur), whole), usual: `of ${now}'s cost; ${was(generic(prev), whole)}.`,
      why: "Generic agents are agents with no file or model of their own (general-purpose, workflow agents): they inherit the main session's model, usually the priciest. A high share means work that a cheaper, named agent could have done.",
    },
    {
      label: 'Read from cache', value: dash(cache(cur), tenth), usual: `${up(was(cache(prev), tenth))}.`,
      why: 'Of all the input the models read, the share that came from cache instead of being sent fresh. A cache read costs a tenth as much per token.',
    },
  ];
}

/** What a working day and a prompt cost now, against the bucket before, in a sentence. */
export function trendsReading(series: TBucket[], unit: TrendUnit): Said {
  const cur = series.at(-1) ?? zero(''), prev = series.at(-2) ?? zero('');
  const [now, last] = unit === 'week' ? ['This week', 'last week'] : ['Today', 'yesterday'];
  const perDay = ratio(totalOf(cur), cur.activeDays), perPrompt = ratio(totalOf(cur), cur.prompts);
  if (perDay === null) return [`${now} has no working day yet, so there is no cost a day to read.`];
  const pd = pctChange(perDay, ratio(totalOf(prev), prev.activeDays)), pp = perPrompt === null ? null : pctChange(perPrompt, ratio(totalOf(prev), prev.prompts));
  const lessMore = (p: number) => `${Math.abs(p)}% ${p < 0 ? 'less' : 'more'}`;
  return [
    `${now} a working day costs `, { b: money(perDay, cur.costPartial) }, pd === null ? '' : pd === 0 ? `, the same as ${last}` : `, ${lessMore(pd)} than ${last}`,
    ...(perPrompt === null ? [] : ['; a prompt costs ', { b: money(perPrompt, cur.costPartial) }, pp === null ? '' : pp === 0 ? ', the same' : `, ${lessMore(pp)}`]),
    '.',
  ];
}

// ── Changes ──────────────────────────────────────────────────────────────────

/** The bucket a change falls in, and how far along it (0 to under 1): the weekday and the time of day in a week, the time of day in a day. */
export function changePos(ts: number, unit: TrendUnit) {
  const d = new Date(ts);
  const time = (d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600) / 24;
  return unit === 'day' ? { bucket: dayKey(d), frac: time } : { bucket: weekKey(d), frac: (((d.getDay() + 6) % 7) + time) / 7 };
}

const subjectOf = (c: Commit) => c.subject || `Commit ${c.sha.slice(0, 7)}`;

const USER_CLAUDE_MD = '~/.claude/CLAUDE.md';
const USER_RULES = '~/.claude/rules/';
const isRule = (s: Seen) => s.scope === 'user' && s.path.startsWith(USER_RULES);
const isUserClaudeMd = (s: Seen) => s.scope === 'user' && s.path === USER_CLAUDE_MD;

/** What a fingerprint saw on a change's day, a file once however often it changed (the latest sighting), in the order first seen. */
export const seenOf = (c: Change) => [...new Map(c.seen.map((s) => [s.path, s])).values()];

/** What the card says of a seen file: `your rules`, `your CLAUDE.md`, and `deleted`; a project's own file has no word of ownership. */
export const seenLabels = (s: Seen) => [isUserClaudeMd(s) && 'your CLAUDE.md', isRule(s) && 'your rules', s.deleted && 'deleted'].filter((l) => l !== false);

/** The files git changed that day: the commits', each once. (The API's `files` adds what a fingerprint saw, which the card lists on its own.) */
export const gitFiles = (c: Change) => [...new Set(c.commits.flatMap((x) => x.files))];

/**
 * A change's title: its commit's subject, or when the day had several commits, the day and how many. A day only a fingerprint saw says whose files:
 * your rules, your CLAUDE.md (alone), else how many changed outside git.
 */
export function changeTitle(c: Change) {
  if (c.commits.length > 1) return `${dayName(c.day)} · ${plural(c.commits.length, 'commit')}`;
  if (c.commits.length === 1) return subjectOf(c.commits[0]!);
  const seen = seenOf(c);
  if (seen.length > 0 && seen.every(isRule)) return 'Your rules changed';
  if (seen.length === 1 && isUserClaudeMd(seen[0]!)) return 'Your CLAUDE.md changed';
  return `${plural(seen.length, 'file')} changed outside git`;
}

/** Whether `changeTitle` already names the day (several commits do); else the card shows it beside the title. */
export const dayInTitle = (c: Change) => c.commits.length > 1;

/** The title with the day in front, unless the title already has it. */
const dated = (c: Change) => (dayInTitle(c) ? changeTitle(c) : `${dayName(c.day)} · ${changeTitle(c)}`);

/** A change's row in the list: the day, its commits and the files a fingerprint saw, then the last commit's subject (a day with none: its title). */
export function listLine(c: Change) {
  const seen = seenOf(c).length;
  const what = [c.commits.length > 0 && plural(c.commits.length, 'commit'), seen > 0 && `${plural(seen, 'file')} seen at a session start`].filter((w) => w !== false);
  return { head: `${dayName(c.day)} · ${what.join(' · ')}`, sub: c.commits.length ? commitLine(c.commits.at(-1)!).subject! : changeTitle(c) };
}

/**
 * A commit as the card lists it: its short sha and subject (an excluded project sends none). A change's `alone` commit leaves a subject
 * out, since the card's title is that subject; with none, the line still says why.
 */
export const commitLine = (c: Commit, alone = false) => ({ sha: c.sha.slice(0, 7), subject: alone && c.subject ? undefined : c.subject || '(no subject: an excluded project)' });

/** The changes numbered 1 to n by date, oldest first. */
export const numbered = (changes: Change[]): Numbered[] => [...changes].sort((a, b) => a.ts - b.ts).map((c, i) => ({ ...c, n: i + 1 }));

export type Marker = { key: string; label: string; name: string; text: string; pos: { bucket: string; frac: number }; pick: string; ids: string[] };

/** A marker's pill on the chart, in px: a lone number is a 22 px circle, a range grows with its text (12 px, about 7.2 px a character, 7 px padding a side). */
export const pillWidth = (label: string) => Math.max(22, Math.round(label.length * 7.2 + 14));

/**
 * What the chart marks. A day: one marker per change, labelled with its number. A week: one per week that has changes, labelled with
 * their numbers (`6`, or `6–8`; they are consecutive), standing where the week's latest change is, and picking it. `ids` is every
 * change the marker stands for.
 */
export function markers(changes: Numbered[], unit: TrendUnit): Marker[] {
  if (unit === 'day') {
    return changes.map((c) => ({ key: c.id, label: String(c.n), name: `Change ${c.n}, ${dated(c)}`, text: dated(c), pos: changePos(c.ts, 'day'), pick: c.id, ids: [c.id] }));
  }
  const weeks = new Map<string, Numbered[]>();
  for (const c of changes) {
    const week = changePos(c.ts, 'week').bucket;
    weeks.set(week, [...(weeks.get(week) ?? []), c]);
  }
  return [...weeks].map(([week, cs]) => {
    const [first, latest] = [cs[0]!, cs.at(-1)!];
    const name = cs.length === 1 ? `Change ${first.n}, ${dayName(first.day)}` : `Changes ${first.n} to ${latest.n}, week of ${dayName(week)}`;
    // A week's marker stands for the whole week, at its centre: placed at a change's time, a Saturday's and the next Tuesday's overlapped.
    return { key: `week:${week}`, label: cs.length === 1 ? String(first.n) : `${first.n}–${latest.n}`, name, text: name, pos: { bucket: week, frac: 0.5 }, pick: latest.id, ids: cs.map((c) => c.id) };
  });
}

export const LISTED = 5;

/** The change list: newest first, the first 5 until all are asked for; `hidden` is how many are kept back. */
export function listed(changes: Numbered[], all: boolean) {
  const list = [...changes].reverse();
  return { shown: all ? list : list.slice(0, LISTED), hidden: all ? 0 : Math.max(0, list.length - LISTED) };
}

export const firstFiles = <T,>(files: T[], n = 8) => ({ shown: files.slice(0, n), more: Math.max(0, files.length - n) });

const ROWS: { label: string; of: (s: Side) => number | null; show: (n: number) => string; delta: boolean }[] = [
  { label: 'API-equivalent a day', of: (s) => ratio(s.cost, s.days), show: (n) => money(n), delta: true },
  { label: 'Generic agents a day', of: (s) => ratio(s.generic, s.days), show: (n) => money(n), delta: true },
  { label: 'Agents on their own model a day', of: (s) => ratio(s.typed, s.days), show: (n) => money(n), delta: true },
  { label: 'Opus share of cost', of: (s) => ratio(s.opus, s.cost), show: whole, delta: false }, // a share is already a percent: no percent of it
];

/** The before/after table of a change: each row per active day, with the change in percent (a fall marked). A side with no days is dashes. */
export function compare(c: Change) {
  return {
    head: [`${plural(c.before?.days ?? 0, 'day')} before`, `${plural(c.after?.days ?? 0, 'day')} after`] as [string, string],
    rows: ROWS.map((r) => {
      const a = c.before && r.of(c.before), b = c.after && r.of(c.after);
      const p = r.delta ? pctChange(b, a) : null;
      return { label: r.label, before: dash(a, r.show), after: dash(b, r.show), delta: p === null ? '' : signed(p), down: p !== null && p < 0 };
    }),
  };
}

/**
 * A change in a sentence, before its table: what a day cost after it against the days before. "In the 3 days after this change a day cost $68, 86% more than the 7 days
 * before ($37). Agents on their own model went from $13 to $26 a day." A side with nothing, or nothing to compare with, says so.
 */
export function compareSentence(c: Change): Said {
  const a = c.after?.days ? c.after : null, b = c.before?.days ? c.before : null;
  if (!a && !b) return ['No day was recorded on either side of this change, so there is nothing to compare.'];
  if (!a) return ['This change is too recent to compare: no day has passed since it.'];
  const days = (n: number) => (n === 1 ? 'the day' : `the ${n} days`);
  const perA = a.cost / a.days;
  const head = `In ${days(a.days)} after this change a day cost `;
  if (!b) return [head, { b: money(perA) }, '. There are no earlier days to compare it with.'];
  const perB = b.cost / b.days, p = pctChange(perA, perB), typedA = a.typed / a.days, typedB = b.typed / b.days;
  const how = p === null ? `; ${days(b.days)} before cost nothing` : `, ${p === 0 ? 'the same as' : `${Math.abs(p)}% ${p < 0 ? 'less' : 'more'} than`} ${days(b.days)} before (`;
  return [
    head, { b: money(perA) }, how, ...(p === null ? [] : [{ b: money(perB) }, ')']), '.',
    ...(typedA > 0.005 || typedB > 0.005 ? [` Agents on their own model went from ${money(typedB)} to ${money(typedA)} a day.`] : []),
  ];
}

// ── The monthly goal (v0.2 slice 3, GET and PUT /api/goal) ───────────────────

/** GET /api/goal: the month (YYYY-MM, in the viewer's zone), its goal (null when none), what it has spent up to now, and whether that is a floor. */
export type Goal = { project: string; month: string; goal: number | null; spent: number; costPartial: boolean };

/** `October`, from `2026-10`. */
export const monthName = (month: string) => new Date(`${month}-15T12:00:00`).toLocaleDateString('en', { month: 'long' });

export const goalTitle = (month: string, has: boolean) => (has ? `${monthName(month)} goal` : `No goal for ${monthName(month)}`);

export type GoalBand = 'data' | 'warn' | 'over';

/**
 * The bar's colour: the data colour under 80% of the goal, amber from it, red past it. Decided on the exact figures, as the plugin's status line
 * does, not on the rounded percent: 79.6% reads 80% and stays quiet. No `0.8 * goal`: 0.8 * 3 is 2.4000000000000004.
 */
export const goalBand = (spent: number, goal: number): GoalBand => (spent > goal ? 'over' : spent * 5 >= goal * 4 ? 'warn' : 'data');

/**
 * The goal card's figures at `now` (the viewer's clock, the month's own zone). The pace is the spend so far over the days elapsed, today counted
 * whole, times the month's days. ponytail: so a day's first hours read it low, and the first day's few hours scale by the month's 31; a card read
 * after its month ended takes the month as over until its next refresh.
 */
export function goalView(g: { month: string; goal: number; spent: number; costPartial: boolean }, now: Date) {
  const [y, m] = g.month.split('-').map(Number) as [number, number];
  const days = new Date(y, m, 0).getDate();
  const through = now.getFullYear() === y && now.getMonth() + 1 === m ? now.getDate() : days;
  const pct = Math.round((100 * g.spent) / g.goal), band = goalBand(g.spent, g.goal);
  return {
    pct, band, fill: Math.min(100, (100 * g.spent) / g.goal),
    spent: money(g.spent, g.costPartial), of: `of ${money(g.goal)} · ${pct}%`,
    label: `${pct}% of the goal${band === 'over' ? ', past it' : ''}; the status line warns from 80%`,
    left: `${plural(days - through, 'day')} left`,
    pace: money((g.spent / through) * days, g.costPartial), by: shortDate(new Date(y, m - 1, days).getTime()),
  };
}

/** What the input holds, as the server wants it (above 0, at most 1,000,000), or what is wrong with it. */
export function parseGoalInput(text: string): { usd: number } | { error: string } {
  const usd = Number(text); // blank is 0, which is refused below
  if (!Number.isFinite(usd) || usd <= 0) return { error: 'Give a number of dollars above 0' };
  return usd > 1_000_000 ? { error: 'A goal is at most $1,000,000' } : { usd };
}
