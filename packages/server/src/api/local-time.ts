// The viewer's calendar, for a store that has none: SQLite knows UTC only. The zone's
// offsets come from Intl, which carries the runtime's tz database, and go into the query as a CASE over the few instants they change inside the window, so a
// request is bucketed by its local day in SQL: the query groups, no row comes back to be dated.

const DAY = 86_400_000;
const FLOOR = Date.UTC(2025, 0, 1); // Claude Code's logs begin in 2025, so a window from 0 is not walked day by day from 1970,
const AHEAD = 2 * 365 * DAY; // and none runs past the near future, so a window to the end of time is not walked to it

const formats = new Map<string, Intl.DateTimeFormat>();
const wall = (tz: string) => {
  let f = formats.get(tz);
  if (!f) formats.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })));
  return f;
};

/** The zone's offset from UTC at an instant, in ms. */
export function offsetAt(tz: string, t: number): number {
  const p = Object.fromEntries(wall(tz).formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(t / 1000) * 1000;
}

/** The instants in (from, to) where the zone's offset changes, each with the offset from then on. */
function transitions(tz: string, from: number, to: number): [at: number, offset: number][] {
  const out: [number, number][] = [];
  let t = Math.max(from, FLOOR);
  let off = offsetAt(tz, t);
  const end = Math.min(to, Date.now() + AHEAD);
  while (t < end) {
    const next = Math.min(t + DAY, end);
    const o = offsetAt(tz, next);
    if (o !== off) {
      let lo = t;
      let hi = next;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetAt(tz, mid) === off) lo = mid;
        else hi = mid;
      }
      out.push([hi, o]);
      off = o;
    }
    t = next;
  }
  return out;
}

/**
 * SQL for the local date, 'YYYY-MM-DD', of the epoch-ms column `col`, for rows in [from, to): the offset in force at `from`, then each change. A row outside the window
 * gets the nearest offset, so it is dated by that day's clock and not the one it kept.
 * ponytail: a day with two changes in it (no zone has one now) takes the first, and the walk is by whole days, so a window of years is a few hundred zone lookups.
 */
export function localDate(tz: string, from: number, to: number, col: string): string {
  const cuts = transitions(tz, from, to);
  const first = offsetAt(tz, Math.max(from, FLOOR));
  const offset = cuts.length
    ? `CASE ${cuts.map(([at], i) => `WHEN ${col} < ${at} THEN ${i === 0 ? first : cuts[i - 1]![1]}`).join(' ')} ELSE ${cuts.at(-1)![1]} END`
    : String(first);
  return `date((${col} + ${offset}) / 1000, 'unixepoch')`;
}

/** SQL for the start of the local day, week (Monday) or month that a local date (`localDate`'s SQL) falls in, as 'YYYY-MM-DD'. */
export const bucketSql = (unit: 'day' | 'week' | 'month', day: string): string =>
  unit === 'day' ? day : unit === 'week' ? `date(${day}, 'weekday 0', '-6 days')` : `date(${day}, 'start of month')`;

const dates = new Map<string, Intl.DateTimeFormat>();
/** The local date of an instant, 'YYYY-MM-DD'. */
export function dayOf(tz: string, t: number): string {
  let f = dates.get(tz);
  if (!f) dates.set(tz, (f = new Intl.DateTimeFormat('en-CA', { timeZone: tz })));
  return f.format(t);
}

/** The instant of local midnight at the start of a date. ponytail: a midnight that does not exist (a clock that skips it) lands an hour off; no zone the owner uses does. */
const midnight = (tz: string, y: number, m: number, d: number) => {
  const w = Date.UTC(y, m - 1, d);
  return w - offsetAt(tz, w - offsetAt(tz, w));
};

/** [start, end) of a month, 1 to 12, in the zone: local midnight on its first day to local midnight on the next month's. */
export const monthBounds = (tz: string, year: number, month: number): [number, number] =>
  [midnight(tz, year, month, 1), month === 12 ? midnight(tz, year + 1, 1, 1) : midnight(tz, year, month + 1, 1)];
