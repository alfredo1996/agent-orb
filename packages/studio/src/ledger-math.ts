// The Ledger's arithmetic, kept pure for tests. Dates are the viewer's local ones, as the API buckets them (tz).

export type Bucket = { bucket: string; tokens: number; cost: number | null; byModel: Record<string, number> };

export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const midnight = (d: Date, minusDays = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - minusDays).getTime();

/** today = since local midnight; 7d and 30d include today and end now. */
export const rangeOf = (range: 'today' | '7d' | '30d', now: Date) => ({
  from: midnight(now, range === 'today' ? 0 : range === '7d' ? 6 : 29),
  to: now.getTime(),
});

/** Every local day from `from` to `to`, as YYYY-MM-DD. */
export function dayKeys(from: number, to: number) {
  const keys: string[] = [];
  for (const d = new Date(midnight(new Date(from))); d.getTime() <= to; d.setDate(d.getDate() + 1)) keys.push(dayKey(d));
  return keys;
}

export const fillDays = (series: Bucket[], from: number, to: number): Bucket[] =>
  dayKeys(from, to).map((k) => series.find((b) => b.bucket === k) ?? { bucket: k, tokens: 0, cost: 0, byModel: {} });

export function families(byModel: Record<string, number>) {
  const out = { opus: 0, sonnet: 0, haiku: 0, other: 0 };
  for (const [model, n] of Object.entries(byModel)) {
    const f = /claude-(opus|sonnet|haiku)-/.exec(model)?.[1] as 'opus' | 'sonnet' | 'haiku' | undefined;
    out[f ?? 'other'] += n;
  }
  return out;
}

export function niceMax(n: number) {
  if (n <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= n)!;
}

/** The share of tool calls that fail in a project that is doing fine: under it is normal (some failure is a call doing its job), from it the Ledger and Patterns say so. */
export const FAILED_USUAL = 0.04;

export type Unit = 'day' | 'week' | 'month';

/** A bucket's name on the axis, in the aria-labels and in the table: `Mon 20`, `wk Oct 19`, `Oct 2026`. The bucket key is its first local day. */
export function bucketLabel(key: string, unit: Unit) {
  const d = new Date(`${key}T12:00:00`);
  const on = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en', o);
  return unit === 'month' ? on({ month: 'short', year: 'numeric' })
    : unit === 'week' ? `wk ${on({ day: 'numeric', month: 'short' })}`
    : `${on({ weekday: 'short' })} ${d.getDate()}`;
}

/** The bucket that carries its total above its bar: the one with the most (the first on a tie), -1 when every bucket is empty. */
export function busiestOf(values: number[]) {
  let at = -1, max = 0;
  values.forEach((v, i) => { if (v > max) { max = v; at = i; } });
  return at;
}
export const busiest = (series: Bucket[]) => busiestOf(series.map((b) => b.tokens));

/** The bar a key moves to from bar `at` of `n`: Left and Right step and stop at the ends, Home and End jump; null for any other key. */
export function moveBar(keyName: string, at: number, n: number) {
  const to = keyName === 'ArrowLeft' ? at - 1 : keyName === 'ArrowRight' ? at + 1 : keyName === 'Home' ? 0 : keyName === 'End' ? n - 1 : null;
  return to === null ? null : Math.max(0, Math.min(n - 1, to));
}

/** The one bar in the tab order: the last one focused, else the busiest (`busy`, -1 when none), else the first; always one of the `n`. */
export const tabStop = (last: number | undefined, busy: number, n: number) => Math.max(0, Math.min(last ?? busy, n - 1));

export type Family = 'haiku' | 'sonnet' | 'opus' | 'other';
/** Bottom to top. */
export const STACK: Family[] = ['haiku', 'sonnet', 'opus', 'other'];

/**
 * One bar as stacked segments, bottom to top, in the order given, from the scale `y` (a value to its pixel row). Parts with nothing
 * are left out. Every segment above the first loses `gap` px at its foot, so a surface-coloured line separates the colours; the last
 * is the bar's top, which the caller rounds. A segment keeps at least 1 px, so a small share still shows.
 */
export function stackParts<K extends string>(parts: { key: K; value: number }[], y: (v: number) => number, gap = 2) {
  const live = parts.filter((p) => p.value > 0);
  let acc = 0;
  return live.map((p, i) => {
    const top = y(acc + p.value);
    const h = Math.max(1, y(acc) - top - (i ? gap : 0));
    acc += p.value;
    return { key: p.key, y: top, h, top: i === live.length - 1 };
  });
}

/** The Ledger's bar: the model families, haiku at the foot. */
export const stackSegments = (f: Record<Family, number>, y: (v: number) => number, gap = 2) =>
  stackParts(STACK.map((k) => ({ key: k, value: f[k] })), y, gap).map(({ key, ...s }) => ({ fam: key, ...s }));

/** A bar's top edge, rounded; the other edges stay square, so the colours meet in straight lines. */
export const roundedTop = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;

/**
 * Where the tooltip goes, in the chart's own pixels: above its bar and centred on it, kept inside the box. A bar too tall for that
 * (the tip would leave the top) gets it at the top of the box beside the bar, on the side that has room.
 */
export function placeTip(bar: { x: number; w: number; top: number }, tip: { w: number; h: number }, boxW: number, gap = 10) {
  const left = Math.max(0, Math.min(bar.x + bar.w / 2 - tip.w / 2, boxW - tip.w));
  if (bar.top - gap - tip.h >= 0) return { left, top: bar.top - gap - tip.h };
  const right = bar.x + bar.w + gap;
  return { left: right + tip.w <= boxW ? right : Math.max(0, bar.x - gap - tip.w), top: 0 };
}
