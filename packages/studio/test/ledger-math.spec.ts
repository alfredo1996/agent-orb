import { describe, expect, it } from 'vitest';
import { bucketLabel, busiest, busiestOf, dayKeys, families, fillDays, moveBar, niceMax, placeTip, rangeOf, roundedTop, stackParts, stackSegments, tabStop } from '../src/ledger-math.ts';

// Local dates: the test runs in the machine's zone, like the studio in the viewer's.
const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();

describe('Ledger helpers', () => {
  it('range: today from local midnight; 7 and 30 days end now and start at a local midnight', () => {
    const now = new Date(2026, 9, 20, 15, 30);
    expect(rangeOf('today', now)).toEqual({ from: at(2026, 10, 20), to: now.getTime() });
    expect(rangeOf('7d', now)).toEqual({ from: at(2026, 10, 14), to: now.getTime() });
    expect(rangeOf('30d', now).from).toBe(at(2026, 9, 21));
  });

  it('days between two instants, as local YYYY-MM-DD keys', () => {
    expect(dayKeys(at(2026, 10, 18), at(2026, 10, 20, 9))).toEqual(['2026-10-18', '2026-10-19', '2026-10-20']);
    expect(dayKeys(at(2026, 10, 31), at(2026, 11, 2, 1))).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('fills the days with no requests, so the chart keeps its axis', () => {
    const filled = fillDays([{ bucket: '2026-10-19', tokens: 5, cost: 1, byModel: { m: 5 } }], at(2026, 10, 18), at(2026, 10, 20, 9));
    expect(filled.map((b) => [b.bucket, b.tokens])).toEqual([['2026-10-18', 0], ['2026-10-19', 5], ['2026-10-20', 0]]);
  });

  it('groups models by family for the stacked bars; anything else is "other"', () => {
    expect(families({ 'claude-opus-5-5': 3, 'claude-opus-4-1': 1, 'claude-sonnet-5-5[1m]': 2, 'claude-haiku-5-5': 4, 'claude-unknown-9': 9 }))
      .toEqual({ opus: 4, sonnet: 2, haiku: 4, other: 9 });
  });

  it('rounds the axis up to 1, 2 or 5 times a power of ten', () => {
    expect(niceMax(11_800_000)).toBe(20_000_000);
    expect(niceMax(4_100)).toBe(5_000);
    expect(niceMax(0)).toBe(1);
  });

  it('names a bucket by its first local day: weekday and number, week of, month and year', () => {
    expect(bucketLabel('2026-10-19', 'day')).toBe('Mon 19');
    expect(bucketLabel('2026-10-19', 'week')).toBe('wk Oct 19');
    expect(bucketLabel('2026-10-01', 'month')).toBe('Oct 2026');
  });

  it('the busiest bucket is the one with most tokens, the first on a tie, none when all are empty', () => {
    const b = (tokens: number) => ({ bucket: 'k', tokens, cost: 0, byModel: {} });
    expect(busiest([b(3), b(9), b(2)])).toBe(1);
    expect(busiest([b(5), b(9), b(9)])).toBe(1);
    expect(busiest([b(0), b(0)])).toBe(-1);
    expect(busiest([])).toBe(-1);
  });

  describe('a bar as stacked segments', () => {
    const y = (v: number) => 100 - v * 10; // 10 px per unit, the baseline at 100
    const f = (haiku: number, sonnet: number, opus: number, other = 0) => ({ haiku, sonnet, opus, other });

    it('stacks bottom to top, leaves out empty families, and marks the last as the top', () => {
      const s = stackSegments(f(2, 0, 3), y);
      expect(s.map((x) => x.fam)).toEqual(['haiku', 'opus']);
      expect(s.map((x) => x.top)).toEqual([false, true]);
    });

    it('cuts 2 px at the foot of every segment above the first, so the colours do not touch', () => {
      const [haiku, sonnet, opus] = stackSegments(f(2, 2, 2), y);
      expect([haiku!.y, haiku!.h]).toEqual([80, 20]); // the first sits on the baseline, whole
      expect([sonnet!.y, sonnet!.h]).toEqual([60, 18]);
      expect([opus!.y, opus!.h]).toEqual([40, 18]);
      expect(haiku!.y - (sonnet!.y + sonnet!.h)).toBe(2); // the gap between two segments
    });

    it('a small share keeps a pixel, and the bar has no gap with one family', () => {
      expect(stackSegments(f(10, 0.01, 0), y)[1]!.h).toBe(1);
      expect(stackSegments(f(0, 0, 4), y)).toEqual([{ fam: 'opus', y: 60, h: 40, top: true }]);
    });

    it('an empty bar has no segments', () => {
      expect(stackSegments(f(0, 0, 0), y)).toEqual([]);
    });

    it('any parts in any order: the order given is the stack, not the names', () => {
      const s = stackParts([{ key: 'b', value: 3 }, { key: 'a', value: 0 }, { key: 'c', value: 2 }], y);
      expect(s).toEqual([{ key: 'b', y: 70, h: 30, top: false }, { key: 'c', y: 50, h: 18, top: true }]);
      expect(stackParts([{ key: 'c', value: 2 }, { key: 'b', value: 3 }], y).map((x) => x.key)).toEqual(['c', 'b']);
    });
  });

  it('the busiest of plain numbers: the first on a tie, none when all are 0', () => {
    expect(busiestOf([3, 9, 2])).toBe(1);
    expect(busiestOf([9, 9])).toBe(0);
    expect(busiestOf([0, 0])).toBe(-1);
  });

  it('a bar\'s top edge is rounded at the two top corners only', () => {
    expect(roundedTop(10, 20, 30, 40, 4)).toBe('M10,60V24Q10,20 14,20H36Q40,20 40,24V60Z');
  });

  describe('the chart on the keyboard', () => {
    it('Left and Right step one bar and stop at the ends; Home and End jump to them', () => {
      expect(moveBar('ArrowRight', 3, 30)).toBe(4);
      expect(moveBar('ArrowLeft', 3, 30)).toBe(2);
      expect(moveBar('ArrowLeft', 0, 30)).toBe(0); // no wrapping: the first bar is a wall
      expect(moveBar('ArrowRight', 29, 30)).toBe(29);
      expect(moveBar('Home', 17, 30)).toBe(0);
      expect(moveBar('End', 17, 30)).toBe(29);
    });

    it('any other key is left alone', () => {
      expect(moveBar('Tab', 3, 30)).toBeNull();
      expect(moveBar('ArrowUp', 3, 30)).toBeNull();
      expect(moveBar('Escape', 3, 30)).toBeNull();
    });

    it('one bar is in the tab order: the last focused, else the busiest, else the first, and always one that exists', () => {
      expect(tabStop(7, 12, 30)).toBe(7);
      expect(tabStop(undefined, 12, 30)).toBe(12);
      expect(tabStop(undefined, -1, 30)).toBe(0);
      expect(tabStop(0, 12, 30)).toBe(0); // the first bar is a real choice, not "none"
      expect(tabStop(29, 5, 7)).toBe(6); // the range shrank under the remembered bar
    });
  });

  describe('where the tooltip goes', () => {
    const tip = { w: 200, h: 100 };

    it('above the bar and centred on it', () => {
      expect(placeTip({ x: 400, w: 30, top: 150 }, tip, 1000)).toEqual({ left: 315, top: 40 });
    });

    it('kept inside the box at either edge', () => {
      expect(placeTip({ x: 5, w: 30, top: 150 }, tip, 1000).left).toBe(0);
      expect(placeTip({ x: 970, w: 30, top: 150 }, tip, 1000).left).toBe(800);
    });

    it('a bar too tall for it gets the tip beside it at the top, on the side with room', () => {
      expect(placeTip({ x: 400, w: 30, top: 60 }, tip, 1000)).toEqual({ left: 440, top: 0 });
      expect(placeTip({ x: 900, w: 30, top: 60 }, tip, 1000)).toEqual({ left: 690, top: 0 });
      // the gap counts: 110 px above the bar is exactly tip plus gap, 109 is one short
      expect(placeTip({ x: 400, w: 30, top: 110 }, tip, 1000)).toEqual({ left: 315, top: 0 });
      expect(placeTip({ x: 400, w: 30, top: 109 }, tip, 1000).left).toBe(440);
    });
  });
});
