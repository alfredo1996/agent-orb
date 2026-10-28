import { describe, expect, it } from 'vitest';
import {
  axisMoney, barSegments, changePos, changeTitle, commitLine, compare, compareSentence, dayInTitle, dayName, fillBuckets, firstFiles, gitFiles, goalBand, goalTitle, goalView,
  listed, listLine, markers, money, monthName, numbered, parseGoalInput, pctChange, pillWidth, seenLabels, seenOf, shortDate, signed, spanOf, totalOf,
  trendFigures, trendLabel, trendsReading, weekKey, weekKeys, type Change, type Commit, type Seen, type Side, type TBucket,
} from '../src/trends-math.ts';

// Local dates, as in ledger-math.spec: the studio buckets by the viewer's zone. A test that depends on the zone names it.
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
// The studio's tsconfig has no Node types; Node does re-read TZ when it is set at run time.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const inZone = <T,>(tz: string, fn: () => T): T => {
  const was = env.TZ;
  env.TZ = tz;
  try {
    return fn();
  } finally {
    if (was === undefined) delete env.TZ;
    else env.TZ = was;
  }
};
const bucket = (over: Partial<TBucket> = {}): TBucket => ({
  bucket: '2026-10-19', main: 0, typed: 0, generic: 0, opus: 0, sonnet: 0, haiku: 0, other: 0, tokens: 0, cacheRead: 0, inputSide: 0, activeDays: 0, prompts: 0, costPartial: false, ...over,
});

describe('the span a view shows', () => {
  it('weeks: 12 of them, from the Monday 11 weeks before this week, whatever day it is now', () => {
    const monday = at(2026, 8, 3); // 19 Oct minus 11 weeks
    for (const now of [new Date(2026, 9, 21, 15), new Date(2026, 9, 19, 0, 30), new Date(2026, 9, 25, 23)]) { // a Wednesday, the Monday itself, the Sunday
      const r = spanOf('week', now);
      expect(r).toEqual({ from: monday, to: now.getTime() });
      expect(weekKeys(r.from, r.to)).toHaveLength(12);
    }
  });

  it('days: 30, today the last', () => {
    const now = new Date(2026, 9, 21, 15, 30);
    const r = spanOf('day', now);
    expect(r).toEqual({ from: at(2026, 9, 22), to: now.getTime() });
  });
});

describe('weeks', () => {
  it('a week is named by its Monday, the Sunday included', () => {
    expect(weekKey(new Date(2026, 9, 19, 0, 0))).toBe('2026-10-19'); // the Monday, at midnight
    expect(weekKey(new Date(2026, 9, 25, 23, 59))).toBe('2026-10-19'); // the Sunday
    expect(weekKey(new Date(2026, 9, 26))).toBe('2026-10-26');
    expect(weekKey(new Date(2027, 0, 1, 12))).toBe('2026-12-28'); // across the new year
  });

  it('every Monday from the week of `from` to the week of `to`', () => {
    expect(weekKeys(at(2026, 10, 14), at(2026, 10, 27, 9))).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
  });

  it('a clock change inside the range does not shift a Monday', () => {
    // Europe/Rome puts its clocks back on 25 Oct, New York on 1 Nov: adding 7 x 24 h would land on a Sunday at 23:00.
    const range = (tz: string) => inZone(tz, () => weekKeys(at(2026, 10, 19), at(2026, 11, 9, 12)));
    expect(range('Europe/Rome')).toEqual(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
    expect(range('America/New_York')).toEqual(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
  });
});

describe('filling the buckets the API leaves out', () => {
  it('weeks with nothing become zero weeks, so the chart keeps its axis; the weeks with data stay as they are', () => {
    const real = bucket({ bucket: '2026-10-12', main: 5, activeDays: 3 });
    const r = spanOf('week', new Date(2026, 9, 21, 15));
    const filled = fillBuckets([real], 'week', r.from, r.to);
    expect(filled).toHaveLength(12);
    expect(filled[10]).toBe(real);
    expect(filled[0]).toEqual(bucket({ bucket: '2026-08-03' }));
    expect(filled.at(-1)!.bucket).toBe('2026-10-19'); // the current week is there, empty
    expect(filled.map((b) => b.bucket)).toEqual(weekKeys(r.from, r.to));
  });

  it('days the same', () => {
    const real = bucket({ bucket: '2026-10-20', main: 5 });
    const filled = fillBuckets([real], 'day', at(2026, 10, 19), at(2026, 10, 21, 9));
    expect(filled.map((b) => [b.bucket, b.main])).toEqual([['2026-10-19', 0], ['2026-10-20', 5], ['2026-10-21', 0]]);
  });
});

describe('what a bucket cost', () => {
  it('who spent: the main session, agents on their own model and generic agents add up; by model, the families do', () => {
    const b = bucket({ main: 100, typed: 40, generic: 60, opus: 150, sonnet: 30, haiku: 15, other: 5 });
    expect(totalOf(b)).toBe(200);
    expect(totalOf(b, 'who')).toBe(200);
    expect(totalOf(b, 'model')).toBe(200);
    expect(totalOf(bucket({ main: 1, typed: 2, generic: 4, opus: 8, sonnet: 16, haiku: 32, other: 64 }), 'who')).toBe(7);
    expect(totalOf(bucket({ main: 1, typed: 2, generic: 4, opus: 8, sonnet: 16, haiku: 32, other: 64 }), 'model')).toBe(120);
  });
});

describe('a change in percent', () => {
  it('rounds to a whole percent, and has none without a base to compare with', () => {
    expect(pctChange(73, 103)).toBe(-29);
    expect(pctChange(4, 70)).toBe(-94);
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(0, 10)).toBe(-100);
    expect(pctChange(5, 3)).toBe(67); // 66.7 rounds up, it is not cut
    expect(pctChange(2, 3)).toBe(-33);
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(null, 5)).toBeNull();
    expect(pctChange(5, null)).toBeNull();
  });

  it('is written with a sign, a real minus, and a bare 0% when nothing moved', () => {
    expect(signed(-29)).toBe('−29%');
    expect(signed(12)).toBe('+12%');
    expect(signed(0)).toBe('0%');
    expect(signed(pctChange(100.2, 100)!)).toBe('0%'); // rounds to 0, not to a signed zero
    expect(signed(pctChange(99.8, 100)!)).toBe('0%');
  });
});

describe('the figures', () => {
  const prev = bucket({ main: 300, typed: 0, generic: 100, activeDays: 5, prompts: 400, cacheRead: 90, inputSide: 100 });
  const cur = bucket({ main: 200, typed: 50, generic: 250, activeDays: 5, prompts: 1000, cacheRead: 970, inputSide: 1000 });
  const shape = (f: ReturnType<typeof trendFigures>) => f.map((x) => [x.label, x.value, x.usual]);

  it('this week against last: what a working day costs, what one prompt costs, the generic agents and the cache, each with its line', () => {
    expect(shape(trendFigures([bucket(), prev, cur], 'week'))).toEqual([
      ['What a working day costs', '$100', "$500 so far over 5 working days, so it can still move. +25% on last week's $80."],
      ['What one prompt costs', '$0.50', "−50% on last week's $1.00."],
      ['Spent by generic agents', '50%', "of this week's cost; 25% last week."],
      ['Read from cache', '97.0%', '90.0% last week.'],
    ]);
  });

  it('each one carries its explanation for the ⓘ, and the day view\'s says day where the week\'s says week', () => {
    const week = trendFigures([prev, cur], 'week'), day = trendFigures([prev, cur], 'day');
    expect(week.every((f) => f.why.length > 40)).toBe(true);
    expect(week[0]!.why).toBe("The week's cost at API prices divided by the days you worked in it (a day with at least one prompt), so a quiet weekend does not read as a saving. Early in the week there is only one day to divide by.");
    expect(day[0]!.why).toBe("The day's cost at API prices divided by the days you worked in it (a day with at least one prompt), so a quiet weekend does not read as a saving.");
  });

  it('today against yesterday: the same, in the day view', () => {
    const [d, prompt, generic, cache] = trendFigures([prev, cur], 'day');
    expect(d!.usual).toBe("$500 so far over 5 working days, so it can still move. +25% on yesterday's $80.");
    expect(prompt!.usual).toBe("−50% on yesterday's $1.00.");
    expect(generic!.usual).toBe("of today's cost; 25% yesterday.");
    expect(cache!.usual).toBe('90.0% yesterday.');
  });

  it('a share is of the whole cost, agents on their own model included', () => {
    // generic 1 of 3 in total; leaving the typed agents out of the total would read 50%
    const [, , generic] = trendFigures([prev, bucket({ main: 1, typed: 1, generic: 1 })], 'week');
    expect(generic!.value).toBe('33%');
  });

  it('shows a dash where the divisor is 0, and says what last week was instead of a percent', () => {
    const quiet = trendFigures([bucket({ main: 100, activeDays: 2, prompts: 10, cacheRead: 5, inputSide: 10 }), bucket()], 'week');
    expect(quiet.map((f) => f.value)).toEqual(['—', '—', '—', '—']);
    expect(quiet[0]!.usual).toBe("$0.00 so far over 0 working days, so it can still move. Last week's $50.");
    expect(quiet[1]!.usual).toBe("Last week's $10.");
    expect(quiet[3]!.usual).toBe('50.0% last week.');
  });

  it('says "none" when last week had nothing to compare with', () => {
    const rows = trendFigures([bucket(), cur], 'week');
    expect(rows.map((f) => f.usual)).toEqual(["$500 so far over 5 working days, so it can still move. None last week.", 'None last week.', "of this week's cost; nothing last week.", 'Nothing last week.']);
  });

  it('a total with unpriced requests is a floor', () => {
    const [d] = trendFigures([prev, { ...cur, costPartial: true }], 'week');
    expect(d!.value).toBe('≥ $100');
    expect(d!.usual!.startsWith('≥ $500 so far over')).toBe(true);
  });
});

describe('the reading', () => {
  const prev = bucket({ main: 300, typed: 0, generic: 100, activeDays: 5, prompts: 400 });
  const cur = bucket({ main: 200, typed: 50, generic: 250, activeDays: 5, prompts: 1000 });
  // the figures in bold, as the page draws them
  const said = (s: ReturnType<typeof trendsReading>) => s.map((p) => (typeof p === 'string' ? p : `**${p.b}**`)).join('');

  it('what a working day and a prompt cost now, each against the week before', () => {
    expect(said(trendsReading([prev, cur], 'week'))).toBe('This week a working day costs **$100**, 25% more than last week; a prompt costs **$0.50**, 50% less.');
  });

  it('today against yesterday in the day view', () => {
    expect(said(trendsReading([prev, cur], 'day'))).toBe('Today a working day costs **$100**, 25% more than yesterday; a prompt costs **$0.50**, 50% less.');
  });

  it('with no week before, it says what it costs and compares nothing; the same cost is the same', () => {
    expect(said(trendsReading([cur], 'week'))).toBe('This week a working day costs **$100**; a prompt costs **$0.50**.');
    expect(said(trendsReading([bucket({ main: 400, activeDays: 5, prompts: 400 }), bucket({ main: 400, activeDays: 5, prompts: 400 })], 'week'))).toBe(
      'This week a working day costs **$80**, the same as last week; a prompt costs **$1.00**, the same.');
  });

  it('a week with no working day yet has no cost a day to read', () => {
    expect(said(trendsReading([prev, bucket()], 'week'))).toBe('This week has no working day yet, so there is no cost a day to read.');
  });
});

describe('a change in a sentence (#102)', () => {
  const side = (days: number, cost: number, generic: number, typed: number, opus: number): Side => ({ days, cost, generic, typed, opus });
  const change = (before: Side | null, after: Side | null): Change => ({ id: 'p:2026-10-20', day: '2026-10-20', ts: 0, commits: [], seen: [], files: [], before, after });
  const said = (c: Change) => compareSentence(c).map((p) => (typeof p === 'string' ? p : `**${p.b}**`)).join('');

  it('the days after against the days before, with the figures in bold and the agents on their own model when they moved', () => {
    expect(said(change(side(7, 259, 0, 91, 0), side(3, 207, 0, 78, 0)))).toBe(
      'In the 3 days after this change a day cost **$69**, 86% more than the 7 days before (**$37**). Agents on their own model went from $13 to $26 a day.');
  });

  it('a fall reads less, and agents on their own model are left out when neither side spent on them', () => {
    expect(said(change(side(7, 259, 0, 0, 0), side(5, 50, 0, 0, 0)))).toBe('In the 5 days after this change a day cost **$10**, 73% less than the 7 days before (**$37**).');
  });

  it('one day is "the day", and no change at all is "the same as"', () => {
    expect(said(change(side(1, 100, 0, 0, 0), side(1, 100, 0, 0, 0)))).toBe('In the day after this change a day cost **$100**, the same as the day before (**$100**).');
  });

  it('with no days before, only what a day cost after; with none after, too recent; with neither, nothing to compare', () => {
    expect(said(change(null, side(3, 207, 0, 0, 0)))).toBe('In the 3 days after this change a day cost **$69**. There are no earlier days to compare it with.');
    expect(said(change(side(3, 30, 0, 0, 0), null))).toBe('This change is too recent to compare: no day has passed since it.');
    expect(said(change(null, null))).toBe('No day was recorded on either side of this change, so there is nothing to compare.');
    expect(said(change(side(0, 0, 0, 0, 0), side(0, 0, 0, 0, 0)))).toBe('No day was recorded on either side of this change, so there is nothing to compare.'); // a side of no days is no side
  });

  it('days before that cost nothing leave no percent to give', () => {
    expect(said(change(side(7, 0, 0, 0, 0), side(3, 207, 0, 0, 0)))).toBe('In the 3 days after this change a day cost **$69**; the 7 days before cost nothing.');
  });
});

describe('a bar as stacked segments', () => {
  const y = (v: number) => 300 - v; // a pixel a dollar, the baseline at 300
  const b = bucket({ main: 100, typed: 40, generic: 60, opus: 150, sonnet: 30, haiku: 15, other: 5 });

  it('by who spent: the main session at the foot, then agents on their own model, then generic agents', () => {
    expect(barSegments(b, 'who', y)).toEqual([
      { key: 'main', y: 200, h: 100, top: false, color: 'var(--data)' },
      { key: 'typed', y: 160, h: 38, top: false, color: 'var(--ok-dot)' },
      { key: 'generic', y: 100, h: 58, top: true, color: 'var(--wait-dot)' },
    ]);
  });

  it('by model: Opus at the foot, then Sonnet, Haiku and the rest', () => {
    expect(barSegments(b, 'model', y)).toEqual([
      { key: 'opus', y: 150, h: 150, top: false, color: 'var(--opus)' },
      { key: 'sonnet', y: 120, h: 28, top: false, color: 'var(--sonnet)' },
      { key: 'haiku', y: 105, h: 13, top: false, color: 'var(--haiku)' },
      { key: 'other', y: 100, h: 3, top: true, color: 'var(--faint)' },
    ]);
  });

  it('leaves out what is 0, and the last that is left is the top', () => {
    expect(barSegments(bucket({ main: 10, opus: 10 }), 'who', y)).toEqual([{ key: 'main', y: 290, h: 10, top: true, color: 'var(--data)' }]);
    expect(barSegments(bucket({ opus: 10, haiku: 5 }), 'model', y).map((s) => [s.key, s.top])).toEqual([['opus', false], ['haiku', true]]);
    expect(barSegments(bucket(), 'who', y)).toEqual([]);
  });
});

describe('where a change sits in its bucket', () => {
  // 18 Oct 2026, 11:30 UTC: Monday 19 Oct 00:30 in Auckland (UTC+13), Sunday 18 Oct 04:30 in Los Angeles (UTC-7)
  const ts = Date.parse('2026-10-18T11:30:00Z');

  it('is the viewer\'s own day, so the same instant lands in another week elsewhere', () => {
    const auckland = inZone('Pacific/Auckland', () => changePos(ts, 'week'));
    expect(auckland.bucket).toBe('2026-10-19');
    expect(auckland.frac).toBeCloseTo((0 + 0.5 / 24) / 7, 6);
    const la = inZone('America/Los_Angeles', () => changePos(ts, 'week'));
    expect(la.bucket).toBe('2026-10-12');
    expect(la.frac).toBeCloseTo((6 + 4.5 / 24) / 7, 6);
  });

  it('in a week: the weekday and the time of day, Monday first', () => {
    const p = changePos(at(2026, 10, 16, 12), 'week'); // a Friday noon
    expect(p.bucket).toBe('2026-10-12');
    expect(p.frac).toBeCloseTo(4.5 / 7, 6);
    expect(changePos(at(2026, 10, 19, 0, 0), 'week')).toEqual({ bucket: '2026-10-19', frac: 0 }); // Monday midnight opens its week
    const sunday = changePos(at(2026, 10, 25, 23, 59), 'week');
    expect(sunday.bucket).toBe('2026-10-19');
    expect(sunday.frac).toBeLessThan(1); // the end of the week stays inside it
    expect(sunday.frac).toBeGreaterThan(0.99);
  });

  it('in a day: the time of day', () => {
    expect(changePos(at(2026, 10, 20, 6), 'day')).toEqual({ bucket: '2026-10-20', frac: 0.25 });
    expect(changePos(at(2026, 10, 20, 0), 'day')).toEqual({ bucket: '2026-10-20', frac: 0 });
    expect(changePos(at(2026, 10, 20, 18, 30), 'day').frac).toBeCloseTo(18.5 / 24, 6);
  });

  it('the new year: Friday 1 Jan 2027 is in the week of 28 Dec', () => {
    const p = changePos(at(2027, 1, 1, 12), 'week');
    expect(p.bucket).toBe('2026-12-28');
    expect(p.frac).toBeCloseTo(4.5 / 7, 6);
  });
});

describe('comparing the days before a change with the days after', () => {
  const side = (days: number, cost: number, generic: number, typed: number, opus: number): Side => ({ days, cost, generic, typed, opus });
  const commit = (over: Partial<Commit> = {}): Commit => ({ sha: '7c4d1e90123456789', ts: 0, subject: 'Run issues through agents', files: [], ...over });
  const change = (before: Side | null, after: Side | null): Change => ({ id: 'p:2026-10-20', day: '2026-10-20', ts: 0, commits: [commit()], seen: [], files: [], before, after });

  it('each row per active day, with the change in percent and a fall marked', () => {
    const t = compare(change(side(7, 721, 490, 0, 656), side(5, 365, 20, 25, 329)));
    expect(t.head).toEqual(['7 days before', '5 days after']);
    expect(t.rows).toEqual([
      { label: 'API-equivalent a day', before: '$103', after: '$73', delta: '−29%', down: true },
      { label: 'Generic agents a day', before: '$70', after: '$4.00', delta: '−94%', down: true },
      { label: 'Agents on their own model a day', before: '$0.00', after: '$5.00', delta: '', down: false }, // nothing before to divide by
      { label: 'Opus share of cost', before: '91%', after: '90%', delta: '', down: false }, // a share is already a percent
    ]);
  });

  it('divides by each side\'s own active days, not by the other\'s', () => {
    const t = compare(change(side(2, 200, 100, 0, 0), side(4, 200, 100, 0, 0)));
    expect(t.rows[0]).toMatchObject({ before: '$100', after: '$50', delta: '−50%' });
  });

  it('a rise is a plus and is not marked', () => {
    const t = compare(change(side(1, 100, 10, 0, 0), side(1, 150, 15, 0, 0)));
    expect(t.rows[0]).toMatchObject({ delta: '+50%', down: false });
  });

  it('a side with no days shows dashes and no change; its header says 0 days', () => {
    const t = compare(change(null, side(1, 40, 10, 5, 20)));
    expect(t.head).toEqual(['0 days before', '1 day after']);
    expect(t.rows.map((r) => [r.before, r.after, r.delta])).toEqual([['—', '$40', ''], ['—', '$10', ''], ['—', '$5.00', ''], ['—', '50%', '']]);
    const u = compare(change(side(3, 30, 0, 0, 0), null));
    expect(u.head).toEqual(['3 days before', '0 days after']);
    expect(u.rows.map((r) => [r.before, r.after, r.delta])).toEqual([['$10', '—', ''], ['$0.00', '—', ''], ['$0.00', '—', ''], ['0%', '—', '']]);
  });

  it('no cost on a side means no Opus share, not 0%', () => {
    expect(compare(change(side(2, 0, 0, 0, 0), side(2, 10, 0, 0, 5))).rows[3]).toMatchObject({ before: '—', after: '50%' });
  });

  it('a change is titled by its commit\'s subject, else its short sha; a day with several commits by the day and how many; dates are the viewer\'s', () => {
    expect(changeTitle(change(null, null))).toBe('Run issues through agents');
    expect(changeTitle({ ...change(null, null), commits: [commit({ subject: null })] })).toBe('Commit 7c4d1e9');
    expect(changeTitle({ ...change(null, null), commits: [commit(), commit({ sha: 'b'.repeat(40) })] })).toBe('20 Oct · 2 commits');
    expect(changeTitle({ ...change(null, null), day: '2026-08-05', commits: [commit(), commit(), commit()] })).toBe('5 Aug · 3 commits');
    expect(shortDate(at(2026, 10, 20, 20, 37))).toBe('20 Oct');
    expect(shortDate(at(2026, 8, 5, 0, 5))).toBe('5 Aug');
    expect(dayName('2026-10-20')).toBe('20 Oct'); // from the day the server named, not from a time that a zone could move
    expect(dayName('2026-01-01')).toBe('1 Jan');
  });

  it('a commit is its short sha and subject; none says why', () => {
    expect(commitLine(commit())).toEqual({ sha: '7c4d1e9', subject: 'Run issues through agents' });
    expect(commitLine(commit({ subject: null }))).toEqual({ sha: '7c4d1e9', subject: '(no subject: an excluded project)' });
  });

  it('a change\'s only commit is its short sha alone, as the title is that subject already; with no subject it still says why', () => {
    expect(commitLine(commit(), true)).toEqual({ sha: '7c4d1e9', subject: undefined });
    expect(commitLine(commit({ subject: null }), true)).toEqual({ sha: '7c4d1e9', subject: '(no subject: an excluded project)' });
  });
});

describe('numbering and marking the changes', () => {
  const day = (y: number, m: number, d: number, h: number, id: string, commits = 1): Change => ({
    id, day: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, ts: at(y, m, d, h), commits: Array.from({ length: commits }, (_, i) => ({ sha: `${id}${i}`.padEnd(7, '0'), ts: at(y, m, d, h + i), subject: `s-${id}${i}`, files: [] })), seen: [], files: [], before: null, after: null,
  });
  // Week of 12 Oct: three changes (Mon, Wed, Fri); week of 19 Oct: one (Tue). Given out of order.
  const given = [day(2026, 10, 16, 18, 'c'), day(2026, 10, 12, 9, 'a', 2), day(2026, 10, 20, 10, 'd'), day(2026, 10, 14, 12, 'b')];

  it('the changes are numbered 1 to n by date, oldest first, whatever order they come in', () => {
    expect(numbered(given).map((c) => [c.n, c.id])).toEqual([[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);
    expect(numbered([])).toEqual([]);
  });

  it('a day shows one marker per change, labelled with its number, at its own time of day', () => {
    const ms = markers(numbered(given), 'day');
    expect(ms.map((m) => [m.label, m.pick, m.ids, m.pos.bucket])).toEqual([
      ['1', 'a', ['a'], '2026-10-12'], ['2', 'b', ['b'], '2026-10-14'], ['3', 'c', ['c'], '2026-10-16'], ['4', 'd', ['d'], '2026-10-20'],
    ]);
    expect(ms[0]!.pos.frac).toBeCloseTo(9 / 24, 6);
    expect(ms.map((m) => m.name)).toEqual(['Change 1, 12 Oct · 2 commits', 'Change 2, 14 Oct · s-b0', 'Change 3, 16 Oct · s-c0', 'Change 4, 20 Oct · s-d0']);
    expect(ms.map((m) => m.text)).toEqual(['12 Oct · 2 commits', '14 Oct · s-b0', '16 Oct · s-c0', '20 Oct · s-d0']);
    expect(new Set(ms.map((m) => m.key)).size).toBe(4);
  });

  it('a week shows one marker per week that has changes, labelled with their numbers, named for them, and picking it picks the week\'s latest change', () => {
    const ms = markers(numbered(given), 'week');
    expect(ms.map((m) => [m.label, m.name, m.pick, m.ids, m.pos.bucket])).toEqual([
      ['1–3', 'Changes 1 to 3, week of 12 Oct', 'c', ['a', 'b', 'c'], '2026-10-12'],
      ['4', 'Change 4, 20 Oct', 'd', ['d'], '2026-10-19'],
    ]);
    expect(ms[0]!.text).toBe('Changes 1 to 3, week of 12 Oct');
    // it stands for the whole week, at its centre: placed at the latest change, a Saturday's and the next Tuesday's overlapped
    expect(ms.map((m) => m.pos)).toEqual([{ bucket: '2026-10-12', frac: 0.5 }, { bucket: '2026-10-19', frac: 0.5 }]);
    expect(new Set(ms.map((m) => m.key)).size).toBe(2);
  });

  it('a week marker carries the numbers of its changes, not how many: later weeks do not start again at 1', () => {
    // w1 x2 | a3 b4 | d5: counting would label the middle week "2", which reads as change 2
    const later = numbered([day(2026, 10, 6, 9, 'w'), day(2026, 10, 8, 9, 'x'), day(2026, 10, 12, 9, 'a'), day(2026, 10, 14, 12, 'b'), day(2026, 10, 20, 10, 'd')]);
    expect(markers(later, 'week').map((m) => [m.label, m.name, m.pick])).toEqual([
      ['1–2', 'Changes 1 to 2, week of 5 Oct', 'x'],
      ['3–4', 'Changes 3 to 4, week of 12 Oct', 'b'],
      ['5', 'Change 5, 20 Oct', 'd'],
    ]);
  });

  it('a pill is 22 px for a lone number and wider for a range, by what its text needs', () => {
    expect(pillWidth('6')).toBe(22);
    expect(pillWidth('12')).toBeGreaterThan(22);
    expect(pillWidth('6–8')).toBeGreaterThan(pillWidth('12'));
    expect(pillWidth('10–12')).toBeGreaterThan(pillWidth('6–8'));
  });

  it('a week with no change has no marker, and a lone change is labelled with its number', () => {
    expect(markers(numbered([day(2026, 10, 20, 10, 'd')]), 'week').map((m) => [m.label, m.name])).toEqual([['1', 'Change 1, 20 Oct']]);
    expect(markers([], 'week')).toEqual([]);
    expect(markers([], 'day')).toEqual([]);
  });

  it('the list is newest first, the first 5, and says how many it keeps back; all of them on request', () => {
    const many = numbered(Array.from({ length: 13 }, (_, i) => day(2026, 9, 1 + i, 9, `c${i + 1}`)));
    const some = listed(many, false);
    expect(some.shown.map((c) => c.n)).toEqual([13, 12, 11, 10, 9]);
    expect(some.hidden).toBe(8);
    const every = listed(many, true);
    expect(every.shown.map((c) => c.n)).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(every.hidden).toBe(0);
    expect(listed(many.slice(0, 5), false)).toMatchObject({ hidden: 0 });
    expect(listed(many.slice(0, 6), false)).toMatchObject({ hidden: 1 });
    expect(listed([], false)).toEqual({ shown: [], hidden: 0 });
  });
});

describe('the files of a change', () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

  it('the first 8, then a count of the rest', () => {
    expect(firstFiles(files(3))).toEqual({ shown: ['f0', 'f1', 'f2'], more: 0 });
    expect(firstFiles(files(8))).toEqual({ shown: files(8), more: 0 });
    expect(firstFiles(files(9))).toEqual({ shown: files(8), more: 1 });
    expect(firstFiles(files(50)).more).toBe(42);
  });
});

describe('writing dollars and the axis', () => {
  it('whole dollars from $10, cents below, a floor with a sign', () => {
    expect(money(445.4)).toBe('$445');
    expect(money(1234.5)).toBe('$1,235');
    expect(money(10)).toBe('$10');
    expect(money(9.99)).toBe('$9.99');
    expect(money(0)).toBe('$0.00');
    expect(money(0.004)).toBe('<$0.01');
    expect(money(445, true)).toBe('≥ $445');
    expect(money(4, true)).toBe('≥ $4.00');
  });

  it('the axis: round figures, thousands as k', () => {
    expect(axisMoney(0)).toBe('$0');
    expect(axisMoney(200)).toBe('$200');
    expect(axisMoney(1000)).toBe('$1k');
    expect(axisMoney(1500)).toBe('$1.5k');
    expect(axisMoney(1.2)).toBe('$1.2');
    expect(axisMoney(0.04)).toBe('$0.04');
  });

  it('a bucket is named by its first day: 17 Aug for a week, Mon 19 for a day', () => {
    expect(trendLabel('2026-08-17', 'week')).toBe('17 Aug');
    expect(trendLabel('2026-10-05', 'week')).toBe('5 Oct');
    expect(trendLabel('2026-10-19', 'day')).toBe('Mon 19');
  });
});

// ── v0.2 slice 3: changes found by a fingerprint, and the monthly goal ───────

describe('changes found by a fingerprint', () => {
  const rule = (name: string, over: Partial<Seen> = {}): Seen => ({ path: `~/.claude/rules/${name}.md`, scope: 'user', ts: 0, deleted: false, ...over });
  const userMd: Seen = { path: '~/.claude/CLAUDE.md', scope: 'user', ts: 0, deleted: false };
  const file = (path: string, over: Partial<Seen> = {}): Seen => ({ path, scope: 'project', ts: 0, deleted: false, ...over });
  const commit = (over: Partial<Commit> = {}): Commit => ({ sha: '7c4d1e90123456789', ts: 0, subject: 'Run issues through agents', files: ['.claude/skills/code/SKILL.md'], ...over });
  const only = (seen: Seen[], over: Partial<Change> = {}): Change => ({ id: 'p:2026-10-20', day: '2026-10-20', ts: at(2026, 10, 20, 20, 35), commits: [], seen, files: seen.map((s) => s.path), before: null, after: null, ...over });

  it('a day only a fingerprint saw: your rules when every entry is one of them', () => {
    expect(changeTitle(only([rule('workflows')]))).toBe('Your rules changed');
    expect(changeTitle(only([rule('workflows'), rule('git')]))).toBe('Your rules changed'); // two files, still the rules
  });

  it('your CLAUDE.md alone is named; with anything else it is counted', () => {
    expect(changeTitle(only([userMd]))).toBe('Your CLAUDE.md changed');
    expect(changeTitle(only([userMd, rule('git')]))).toBe('2 files changed outside git');
    expect(changeTitle(only([rule('git'), file('.claude/agents/implementer.md')]))).toBe('2 files changed outside git'); // not all rules
  });

  it('a project file is counted, never called yours: a project CLAUDE.md is not your CLAUDE.md', () => {
    expect(changeTitle(only([file('CLAUDE.md')]))).toBe('1 file changed outside git');
    expect(changeTitle(only([]))).toBe('0 files changed outside git'); // a change with nothing in it is not "your rules"
    expect(changeTitle(only([file('.claude/skills/a/SKILL.md'), file('.claude/skills/b/SKILL.md'), file('CLAUDE.md')]))).toBe('3 files changed outside git');
  });

  it('a path that changed twice in a day is one file', () => {
    const twice = [rule('git', { ts: 1 }), rule('git', { ts: 2, deleted: true })];
    expect(seenOf(only(twice))).toEqual([twice[1]]); // the latest sighting wins
    expect(changeTitle(only(twice))).toBe('Your rules changed');
    expect(changeTitle(only([userMd, userMd]))).toBe('Your CLAUDE.md changed');
    expect(changeTitle(only([file('a.md'), file('a.md'), file('b.md')]))).toBe('2 files changed outside git');
    expect(seenOf(only([file('a.md'), file('b.md'), file('a.md', { ts: 9 })])).map((s) => s.path)).toEqual(['a.md', 'b.md']); // in the order first seen
  });

  it('a day git explains keeps its commit title, whatever else a fingerprint saw', () => {
    const mixed = only([rule('git')], { commits: [commit()] });
    expect(changeTitle(mixed)).toBe('Run issues through agents');
    expect(changeTitle({ ...mixed, commits: [commit(), commit({ sha: 'b'.repeat(40) })] })).toBe('20 Oct · 2 commits');
  });

  it('the day is in the title for several commits only; the card adds it as a hint otherwise', () => {
    expect(dayInTitle(only([userMd]))).toBe(false);
    expect(dayInTitle(only([], { commits: [commit()] }))).toBe(false);
    expect(dayInTitle(only([], { commits: [commit(), commit()] }))).toBe(true);
  });

  it('what a seen file is called: yours by its scope, deleted when it was; a project file has no such word', () => {
    expect(seenLabels(rule('git'))).toEqual(['your rules']);
    expect(seenLabels(userMd)).toEqual(['your CLAUDE.md']);
    expect(seenLabels(rule('git', { deleted: true }))).toEqual(['your rules', 'deleted']);
    expect(seenLabels(file('.claude/agents/implementer.md'))).toEqual([]);
    expect(seenLabels(file('.claude/agents/implementer.md', { deleted: true }))).toEqual(['deleted']);
    expect(seenLabels(file('CLAUDE.md'))).toEqual([]); // the project's CLAUDE.md is the project's, not yours
  });

  it('the list: the commits, then what a fingerprint saw; a day only it saw says just that', () => {
    expect(listLine(only([], { commits: [commit(), commit({ subject: 'Last one' })] }))).toEqual({ head: '20 Oct · 2 commits', sub: 'Last one' }); // as before
    expect(listLine(only([rule('git'), file('a.md')], { commits: [commit(), commit({ subject: 'Last one' })] }))).toEqual({ head: '20 Oct · 2 commits · 2 files seen at a session start', sub: 'Last one' });
    expect(listLine(only([rule('git')], { commits: [commit()] })).head).toBe('20 Oct · 1 commit · 1 file seen at a session start');
    expect(listLine(only([rule('git'), rule('workflows')]))).toEqual({ head: '20 Oct · 2 files seen at a session start', sub: 'Your rules changed' });
    expect(listLine(only([rule('git', { ts: 1 }), rule('git', { ts: 2 })])).head).toBe('20 Oct · 1 file seen at a session start'); // the same path twice is one file
  });

  it('the files of git are the commits\' own, not what a fingerprint saw, so nothing is listed twice', () => {
    const c = only([rule('git'), file('.claude/agents/new.md')], {
      commits: [commit({ files: ['a.md', 'b.md'] }), commit({ files: ['b.md', 'c.md'] })],
      files: ['a.md', 'b.md', 'c.md', '~/.claude/rules/git.md', '.claude/agents/new.md'], // the API's union
    });
    expect(gitFiles(c)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(gitFiles(only([rule('git')]))).toEqual([]);
  });

  it('a day only a fingerprint saw is a change like any other: numbered, marked at its time, named with its title', () => {
    const git = (id: string, d: number): Change => only([], { id, day: `2026-10-${d}`, ts: at(2026, 10, d, 10), commits: [commit()] });
    const seen = only([rule('workflows')], { id: 'seen', day: '2026-10-20', ts: at(2026, 10, 20, 20, 35) });
    const ns = numbered([seen, git('a', 14), git('b', 22)]);
    expect(ns.map((c) => [c.n, c.id])).toEqual([[1, 'a'], [2, 'seen'], [3, 'b']]);
    const day = markers(ns, 'day')[1]!;
    expect(day).toMatchObject({ label: '2', pick: 'seen', ids: ['seen'], name: 'Change 2, 20 Oct · Your rules changed', text: '20 Oct · Your rules changed' });
    expect(day.pos.bucket).toBe('2026-10-20');
    expect(day.pos.frac).toBeCloseTo((20 + 35 / 60) / 24, 6);
    expect(markers(ns, 'week').map((m) => [m.label, m.pick])).toEqual([['1', 'a'], ['2–3', 'b']]);
  });
});

describe('the monthly goal', () => {
  const g = (spent: number, goal: number, over: { month?: string; costPartial?: boolean } = {}) => ({ month: '2026-10', goal, spent, costPartial: false, ...over });

  it('the bar is the data colour under 80%, amber from 80%, red only past 100%', () => {
    expect(goalBand(0, 2500)).toBe('data');
    expect(goalBand(1999, 2500)).toBe('data');
    expect(goalBand(2000, 2500)).toBe('warn'); // exactly 80%
    expect(goalBand(2500, 2500)).toBe('warn'); // exactly the goal is not past it
    expect(goalBand(2500.01, 2500)).toBe('over');
  });

  it('decides on the exact figures, as the status line does: 80% of $3 is $2.40 even though 0.8 x 3 is 2.4000000000000004', () => {
    expect(goalBand(2.4, 3)).toBe('warn');
    expect(goalBand(2.39, 3)).toBe('data');
    // 79.6% reads 80% and is not yet amber; $2,500.40 reads $2,500 and is already red
    expect(goalView(g(796, 1000), new Date(2026, 9, 24))).toMatchObject({ pct: 80, band: 'data' });
    expect(goalView(g(2500.4, 2500), new Date(2026, 9, 24))).toMatchObject({ spent: '$2,500', band: 'over' });
  });

  it('the approved mock: $2,029 of $2,500 on the 24th is 81%, 7 days left, $2,621 by 31 Oct at this pace', () => {
    const v = goalView(g(2029, 2500), new Date(2026, 9, 24, 15, 30));
    expect(v).toMatchObject({ spent: '$2,029', of: 'of $2,500 · 81%', pct: 81, band: 'warn', left: '7 days left', pace: '$2,621', by: '31 Oct' });
    expect(v.fill).toBeCloseTo(81.16, 2);
    expect(v.label).toBe('81% of the goal; the status line warns from 80%');
  });

  it('the month\'s first day: one day elapsed, so the pace is that day times the month; 30 days left', () => {
    expect(goalView(g(40, 2500), new Date(2026, 9, 1, 9))).toMatchObject({ left: '30 days left', pace: '$1,240', band: 'data', pct: 2 });
    expect(goalView(g(0, 2500), new Date(2026, 9, 1, 0, 5))).toMatchObject({ spent: '$0.00', pace: '$0.00', pct: 0 }); // nothing spent, nothing divided by zero
  });

  it('the month\'s last day: none left, and the pace is what it has spent', () => {
    expect(goalView(g(2400, 2500), new Date(2026, 9, 31, 23, 59))).toMatchObject({ left: '0 days left', pace: '$2,400', by: '31 Oct' });
    expect(goalView(g(2400, 2500), new Date(2026, 9, 30, 12))).toMatchObject({ left: '1 day left' }); // singular
  });

  it('the days of the month are the month\'s own: February in a leap year and not, 30-day months', () => {
    expect(goalView(g(100, 500, { month: '2028-02' }), new Date(2028, 1, 10))).toMatchObject({ left: '19 days left', by: '29 Feb', pace: '$290' }); // 100 / 10 x 29
    expect(goalView(g(100, 500, { month: '2027-02' }), new Date(2027, 1, 10))).toMatchObject({ left: '18 days left', by: '28 Feb', pace: '$280' });
    expect(goalView(g(100, 500, { month: '2026-11' }), new Date(2026, 10, 10))).toMatchObject({ left: '20 days left', by: '30 Nov' });
    expect(goalView(g(100, 500, { month: '2026-12' }), new Date(2026, 11, 10))).toMatchObject({ left: '21 days left', by: '31 Dec' });
  });

  it('past the goal: the figures say so, and the fill stops at the end of the bar', () => {
    const v = goalView(g(2540, 2500), new Date(2026, 9, 24));
    expect(v).toMatchObject({ spent: '$2,540', of: 'of $2,500 · 102%', band: 'over' });
    expect(v.fill).toBe(100);
    expect(v.label).toBe('102% of the goal, past it; the status line warns from 80%');
  });

  it('unpriced requests make the spend, and so the pace, a floor; the goal is never one', () => {
    expect(goalView(g(2029, 2500, { costPartial: true }), new Date(2026, 9, 24))).toMatchObject({ spent: '≥ $2,029', of: 'of $2,500 · 81%', pace: '≥ $2,621' });
  });

  it('small goals keep their cents', () => {
    expect(goalView(g(4.5, 5), new Date(2026, 9, 24))).toMatchObject({ spent: '$4.50', of: 'of $5.00 · 90%', band: 'warn' });
  });

  it('a card read after the month ended takes it as over, not as a new day 1 of it', () => {
    expect(goalView(g(2400, 2500), new Date(2026, 10, 1, 0, 0, 30))).toMatchObject({ left: '0 days left', pace: '$2,400' }); // until its next refresh names November
    expect(goalView(g(2400, 2500), new Date(2027, 9, 5))).toMatchObject({ left: '0 days left' }); // the same month a year on is not this one
  });

  it('the title names the month; no goal says for which month', () => {
    expect(monthName('2026-10')).toBe('October');
    expect(monthName('2027-01')).toBe('January');
    expect(goalTitle('2026-10', true)).toBe('October goal');
    expect(goalTitle('2026-10', false)).toBe('No goal for October');
    expect(goalTitle('2026-12', false)).toBe('No goal for December');
  });

  it('an amount is a number of dollars above 0 and at most 1,000,000, as the server wants it', () => {
    expect(parseGoalInput('2500')).toEqual({ usd: 2500 });
    expect(parseGoalInput(' 2500 ')).toEqual({ usd: 2500 });
    expect(parseGoalInput('0.5')).toEqual({ usd: 0.5 });
    expect(parseGoalInput('1000000')).toEqual({ usd: 1_000_000 });
    for (const bad of ['', '   ', '0', '-5', 'abc', '12abc', '2,500', 'Infinity', '1e999', 'NaN']) expect(parseGoalInput(bad), JSON.stringify(bad)).toHaveProperty('error');
    expect(parseGoalInput('1000000.01')).toHaveProperty('error');
    expect(parseGoalInput('0')).not.toEqual(parseGoalInput('1000001')); // each says what is wrong
  });
});
