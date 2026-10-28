import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { bucketSql, dayOf, localDate, monthBounds, offsetAt } from '../src/api/local-time.ts';

// The viewer's calendar, which SQLite does not know: the zone's offsets are read from Intl (the tz database the runtime ships) and handed to SQL as a CASE over the
// instants the offset changes, so a request is bucketed by its local day in the query, not by a pass over its rows.
const iso = (s: string) => Date.parse(s);
const HOUR = 3_600_000;
const sql = new DatabaseSync(':memory:');
const one = (expr: string, ts: number) => (sql.prepare(`SELECT ${expr} AS v FROM (SELECT ${ts} AS ts)`).get() as { v: string }).v;

describe('offsetAt', () => {
  it('is the zone\'s offset from UTC at an instant, with its daylight saving', () => {
    expect(offsetAt('UTC', iso('2026-10-10T00:00:00Z'))).toBe(0);
    expect(offsetAt('Europe/Rome', iso('2026-10-10T00:00:00Z'))).toBe(2 * HOUR);
    expect(offsetAt('Europe/Rome', iso('2026-11-10T00:00:00Z'))).toBe(HOUR);
    expect(offsetAt('Asia/Kolkata', iso('2026-10-10T00:00:00Z'))).toBe(5.5 * HOUR);
    expect(offsetAt('America/New_York', iso('2026-07-01T00:00:00Z'))).toBe(-4 * HOUR);
  });

  it('changes at the instant of the transition: Rome leaves summer time at 01:00:00Z on 25 October 2026', () => {
    expect(offsetAt('Europe/Rome', iso('2026-10-25T00:59:59Z'))).toBe(2 * HOUR);
    expect(offsetAt('Europe/Rome', iso('2026-10-25T01:00:00Z'))).toBe(HOUR);
  });
});

describe('monthBounds: local midnight on the first, to local midnight on the next first', () => {
  it('Rome\'s October is 22:00Z on the 30th of September to 23:00Z on the 31st, because the clocks went back on the 25th', () => {
    expect(monthBounds('Europe/Rome', 2026, 10)).toEqual([iso('2026-09-30T22:00:00Z'), iso('2026-10-31T23:00:00Z')]);
  });
  it('UTC, a zone behind it, a half-hour zone, and December into January', () => {
    expect(monthBounds('UTC', 2026, 2)).toEqual([iso('2026-02-01T00:00:00Z'), iso('2026-03-01T00:00:00Z')]);
    expect(monthBounds('America/New_York', 2026, 11)).toEqual([iso('2026-11-01T04:00:00Z'), iso('2026-12-01T05:00:00Z')]); // the clocks went back on 1 Nov, after midnight
    expect(monthBounds('Asia/Kolkata', 2026, 10)).toEqual([iso('2026-09-30T18:30:00Z'), iso('2026-10-31T18:30:00Z')]);
    expect(monthBounds('Europe/Rome', 2026, 12)).toEqual([iso('2026-11-30T23:00:00Z'), iso('2026-12-31T23:00:00Z')]);
  });
});

describe('dayOf', () => {
  it('is the local date of an instant', () => {
    expect(dayOf('Europe/Rome', iso('2026-10-18T23:30:00Z'))).toBe('2026-10-19');
    expect(dayOf('UTC', iso('2026-10-18T23:30:00Z'))).toBe('2026-10-18');
    expect(dayOf('America/New_York', iso('2026-10-19T03:59:59Z'))).toBe('2026-10-18');
  });
});

describe('localDate and bucketSql: the same answer in SQL as dayOf gives, over a transition too', () => {
  const zones = ['UTC', 'Europe/Rome', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland', 'Australia/Lord_Howe'];
  const from = iso('2026-10-20T00:00:00Z');
  const to = iso('2026-11-05T00:00:00Z'); // Rome falls back on 25 Oct, New York on 1 Nov, Auckland and Lord Howe spring forward in September/October
  it.each(zones)('%s: every quarter hour of a fortnight lands on its local day', (tz) => {
    const expr = localDate(tz, from, to, 'ts');
    const rows = sql.prepare(`WITH RECURSIVE t(ts) AS (SELECT ${from} UNION ALL SELECT ts + 900000 FROM t WHERE ts < ${to - 900_000}) SELECT ts, ${expr} AS day FROM t`).all() as { ts: number; day: string }[];
    expect(rows).toHaveLength((to - from) / 900_000);
    expect(rows.filter((r) => r.day !== dayOf(tz, r.ts))).toEqual([]);
  });

  it('a window from 0 to the end of time is not walked day by day: it answers at once, with the offsets of the years that can hold data', () => {
    const t0 = performance.now();
    const expr = localDate('Europe/Rome', 0, Number.MAX_SAFE_INTEGER, 'ts');
    expect(performance.now() - t0).toBeLessThan(200);
    expect(one(expr, iso('2026-10-18T23:30:00Z'))).toBe('2026-10-19');
    expect(one(expr, iso('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
  });

  it('a window with no transition is a single offset, and a request before or after the window still gets the nearest', () => {
    expect(localDate('Europe/Rome', iso('2026-10-01T00:00:00Z'), iso('2026-10-02T00:00:00Z'), 'ts')).not.toContain('CASE');
    expect(one(localDate('Europe/Rome', iso('2026-10-26T00:00:00Z'), iso('2026-10-27T00:00:00Z'), 'ts'), iso('2026-10-18T23:30:00Z'))).toBe('2026-10-19'); // +1 h applied to an earlier +2 h day: 00:30, still the 19th
  });

  it('weeks start on Monday and months on the first, in the zone', () => {
    const w = (tz: string, at: string) => one(bucketSql('week', localDate(tz, iso('2026-10-01T00:00:00Z'), iso('2026-11-01T00:00:00Z'), 'ts')), iso(at));
    expect(w('Europe/Rome', '2026-10-18T23:30:00Z')).toBe('2026-10-19'); // Sunday in UTC, Monday 01:30 in Rome
    expect(w('UTC', '2026-10-18T23:30:00Z')).toBe('2026-10-12');
    expect(w('UTC', '2026-10-19T00:00:00Z')).toBe('2026-10-19'); // a Monday is its own week's start
    expect(w('UTC', '2026-10-25T23:59:59Z')).toBe('2026-10-19'); // and a Sunday belongs to the week before it
    const m = (tz: string, at: string) => one(bucketSql('month', localDate(tz, iso('2026-09-01T00:00:00Z'), iso('2026-12-01T00:00:00Z'), 'ts')), iso(at));
    expect(m('Europe/Rome', '2026-09-30T22:00:00Z')).toBe('2026-10-01');
    expect(m('UTC', '2026-09-30T22:00:00Z')).toBe('2026-09-01');
    expect(one(bucketSql('day', localDate('UTC', 0, 1, 'ts')), iso('2026-10-19T08:00:00Z'))).toBe('2026-10-19');
  });
});
