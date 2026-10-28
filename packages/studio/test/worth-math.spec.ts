import { describe, expect, it } from 'vitest';
import {
  autoSize, derive, dollars, firstRows, hours, monthKey, monthLong, monthTitle, parseCut, parseHours, parsePlan, parseRate, parseSizesForm, prRow, prsHint, score, stepMonth,
  worthFigures, worthReading, worthReducer, type Pr, type Settings, type Shown, type WorthData,
} from '../src/worth-math.ts';
import type { Said } from '../src/kit.tsx';

// Local dates, as in the other specs: the studio shows the viewer's zone. A test that depends on the zone names it.
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

const CUTS = { S: 300, M: 1500, L: 6000 };
// A PR the owner sized (a tap): its counts, if any, are not what its size comes from.
const pr = (number: number, size: Pr['size'], over: Partial<Pr> = {}): Pr =>
  ({ number, title: `PR ${number}`, mergedAt: at(2026, 10, 20, 12), additions: 10, deletions: 2, countedLines: null, countedFiles: null, size, yours: size !== null, sessions: 1, agents: 2, cost: 0.5, ...over });
// A PR sized by its score under the default cut points, as the server sends it.
const auto = (number: number, lines: number, files: number, over: Partial<Pr> = {}): Pr =>
  pr(number, autoSize(lines, files, CUTS), { countedLines: lines, countedFiles: files, yours: false, ...over });

// A month as GET /api/worth answers it, worked out by hand: sizes S 0.5, M 2, L 6, XL 16; #4 is automatic, 400 lines in 1 file, M (2 h); #3 is yours, L (6 h), though its 100 lines would be S;
// #2 is yours, Skip (0 h); #1 has nothing counted yet, so it is not sized. By hand 8 h; attention 3 h; net 5 h; at $90 that is $450; with a $200 plan, the return is $250.
const month = (over: Partial<WorthData> = {}): WorthData => ({
  settings: { rate: 90, plan: 200, sizes: { S: 0.5, M: 2, L: 6, XL: 16 }, cuts: CUTS },
  month: '2026-10', attentionHours: 3, waitsHours: 0.5, prompts: 40, days: 6, apiCost: 120, costPartial: false,
  prs: [auto(4, 400, 1), pr(3, 'L', { countedLines: 100, countedFiles: 1 }), pr(2, 'skip'), pr(1, null)],
  releaseMerges: 2, sized: 3, total: 4, byHandHours: 8, netHours: 5, value: 450, return: 250, ...over,
});
const withSettings = (over: Partial<Settings>): Settings => ({ ...month().settings, ...over });
const shown = (data: WorthData = month()): Shown => ({ project: 'mobile-app', data });
const sizeOf = (s: Shown | undefined, n: number) => s!.data.prs.find((p) => p.number === n)!.size;
const yoursOf = (s: Shown | undefined, n: number) => s!.data.prs.find((p) => p.number === n)!.yours;

describe('months', () => {
  it('the current month is the viewer\'s local one, not UTC\'s', () => {
    expect(monthKey(new Date(2026, 9, 31, 23, 59))).toBe('2026-10');
    expect(monthKey(new Date(2026, 10, 1, 0, 0))).toBe('2026-11');
    expect(monthKey(new Date(2026, 0, 1, 0, 30))).toBe('2026-01'); // zero-padded
    const instant = new Date('2026-10-31T12:00:00Z'); // 1 Nov 01:00 in Auckland, 31 Oct 05:00 in Los Angeles
    expect(inZone('Pacific/Auckland', () => monthKey(instant))).toBe('2026-11');
    expect(inZone('America/Los_Angeles', () => monthKey(instant))).toBe('2026-10');
  });

  it('steps back across a year, and forward up to the current month and not past it', () => {
    const now = new Date(2026, 9, 26);
    expect(stepMonth('2026-01', -1, now)).toBe('2025-12');
    expect(stepMonth('2026-10', -1, now)).toBe('2026-09');
    expect(stepMonth('2025-12', 1, now)).toBe('2026-01');
    expect(stepMonth('2026-09', 1, now)).toBe('2026-10');
    expect(stepMonth('2026-10', 1, now)).toBeUndefined(); // November has not happened
    expect(stepMonth('2026-10', -10, now)).toBe('2025-12'); // several at once, across the year
    expect(stepMonth('2026-12', -1, now)).toBeUndefined(); // a month already past now stays past it
  });

  it('names a month: "so far" only for the current one, the year for any other', () => {
    const now = new Date(2026, 9, 26);
    expect(monthTitle('2026-10', now)).toBe('October so far');
    expect(monthTitle('2026-09', now)).toBe('September 2026');
    expect(monthTitle('2025-10', now)).toBe('October 2025'); // the same month a year ago is not "so far"
    expect(monthLong('2026-10')).toBe('October 2026');
  });
});

describe('hours and dollars', () => {
  it('hours: whole when whole, one decimal otherwise, thousands grouped', () => {
    expect(hours(151)).toBe('151 h');
    expect(hours(28.1)).toBe('28.1 h');
    expect(hours(28.04)).toBe('28 h'); // rounds to the decimal shown, so it reads whole
    expect(hours(0.5)).toBe('0.5 h');
    expect(hours(1234.56)).toBe('1,234.6 h');
  });

  it('hours: a loss carries the typographic minus, and never reads "−0"', () => {
    expect(hours(-12)).toBe('−12 h');
    expect(hours(-0.5)).toBe('−0.5 h');
    expect(hours(-0.04)).toBe('0 h');
  });

  it('dollars: whole from $10, cents below; a loss carries the minus; a rounded-away loss reads $0.00', () => {
    expect(dollars(8100)).toBe('$8,100');
    expect(dollars(9.5)).toBe('$9.50');
    expect(dollars(0)).toBe('$0.00');
    expect(dollars(-123.4)).toBe('−$123');
    expect(dollars(-9.5)).toBe('−$9.50');
    expect(dollars(-1500)).toBe('−$1,500');
    expect(dollars(-0.001)).toBe('$0.00');
  });
});

describe('the automatic size', () => {
  it('the score is lines x (1 + log2 files); no files reads as one', () => {
    expect(score(100, 1)).toBe(100);
    expect(score(150, 2)).toBe(300);
    expect(score(100, 4)).toBe(300);
    expect(score(1500, 8)).toBe(6000);
    expect(score(500, 0)).toBe(500);
    expect(score(0, 0)).toBe(0);
  });

  it('S below 300, M below 1,500, L below 6,000, XL from there: 299 is S and 300 is M, as the server sizes them', () => {
    const size = (lines: number, files = 1) => autoSize(lines, files, CUTS);
    expect([299, 300, 1499, 1500, 5999, 6000].map((l) => size(l))).toEqual(['S', 'M', 'M', 'L', 'L', 'XL']);
    expect([[150, 2], [149, 2], [374, 8], [375, 8]].map(([l, f]) => size(l!, f))).toEqual(['M', 'S', 'M', 'L']);
    expect([size(0, 0), size(5000, 0)]).toEqual(['S', 'L']);
  });

  it('follows the cut points it is given', () => {
    expect(autoSize(1200, 1, { S: 100, M: 1000, L: 4000 })).toBe('L');
    expect(autoSize(1200, 1, { S: 100, M: 1300, L: 4000 })).toBe('M');
  });

  it('a PR without both counts has no size', () => {
    expect(autoSize(null, 3, CUTS)).toBeNull();
    expect(autoSize(300, null, CUTS)).toBeNull();
    expect(autoSize(null, null, CUTS)).toBeNull();
  });
});

describe('the six figures', () => {
  const read = (d: WorthData) => Object.fromEntries(worthFigures(d).map((f) => [f.label, f]));

  it('come in the mock\'s order, each with a plain label and the words behind its ⓘ', () => {
    const f = worthFigures(month());
    expect(f.map((x) => x.label)).toEqual(['Time it would have taken you', 'Time you spent steering', 'Hours saved', 'Value of those hours', 'What you paid', 'Return on your plan']);
    for (const x of f) expect(x.why.length, x.label).toBeGreaterThan(40);
  });

  it('with everything set: the values and the line under each', () => {
    const f = read(month({
      byHandHours: 151, attentionHours: 28.1, prompts: 473, days: 21, netHours: 122.9, value: 11061, return: 10861, apiCost: 2055,
      prs: [auto(5, 400, 1), auto(6, 2000, 1), pr(7, 'XL')], sized: 3, total: 3,
    }));
    expect(f['Time it would have taken you']).toMatchObject({ value: '151 h', usual: '3 PRs sized: 2 automatic, 1 yours.' });
    expect(f['Time you spent steering']).toMatchObject({ value: '28.1 h', usual: '473 prompts on 21 days, plus permission waits (up to 10 minutes each).' });
    expect(f['Hours saved']).toMatchObject({ value: '122.9 h', usual: 'by hand minus steering.' });
    expect(f['Value of those hours']).toMatchObject({ value: '$11,061', usual: 'at your $90 an hour.' });
    expect(f['What you paid']).toMatchObject({ value: '$200', usual: 'your plan · $2,055 at API prices.' });
    expect(f['Return on your plan']).toMatchObject({ value: '$10,861', usual: 'value minus what you paid.' });
    for (const x of Object.values(f)) expect(x.bad).toBeFalsy();
  });

  it('says how the PRs were sized: automatic and yours apart, skipped and not-yet-sized named only when there are some', () => {
    expect(read(month())['Time it would have taken you']!.usual).toBe('2 PRs sized: 1 automatic, 1 yours. 1 skipped. 1 not sized yet.');
    expect(read(month({ prs: [auto(1, 100, 1)] }))['Time it would have taken you']!.usual).toBe('1 PR sized: 1 automatic, 0 yours.');
    expect(read(month({ prs: [] }))['Time it would have taken you']!.usual).toBe('0 PRs sized: 0 automatic, 0 yours.');
  });

  it('counts in the singular where there is one', () => {
    expect(read(month({ prompts: 1, days: 1 }))['Time you spent steering']!.usual).toBe('1 prompt on 1 day, plus permission waits (up to 10 minutes each).');
  });

  it('before a rate is set, Value and Return read "—" and say to set it; what was paid still shows', () => {
    const f = read(month({ value: null, return: null, settings: withSettings({ rate: null }) }));
    expect(f['Value of those hours']).toMatchObject({ value: '—', usual: 'set your rate.' });
    expect(f['Return on your plan']).toMatchObject({ value: '—', usual: 'set your rate.' });
    expect(f['What you paid']!.value).toBe('$200');
  });

  it('before a plan is set, Return reads "—" and What you paid asks for it, with the API-equivalent still beside', () => {
    const f = read(month({ return: null, settings: withSettings({ plan: null }), apiCost: 2055 }));
    expect(f['Value of those hours']!.value).toBe('$450'); // the rate alone is enough for Value
    expect(f['Return on your plan']).toMatchObject({ value: '—', usual: 'set your plan.' });
    expect(f['What you paid']).toMatchObject({ value: '—', usual: 'set your plan · $2,055 at API prices.' });
  });

  it('a plan of $0 is a plan: Return is the value', () => {
    const f = read(month({ return: 450, settings: withSettings({ plan: 0 }) }));
    expect(f['What you paid']!.value).toBe('$0.00');
    expect(f['Return on your plan']).toMatchObject({ value: '$450', usual: 'value minus what you paid.' });
  });

  it('a negative return shows the minus and the bad colour; a positive one and zero do not', () => {
    const lost = read(month({ value: 500, return: -1500 }));
    expect(lost['Return on your plan']).toMatchObject({ value: '−$1,500', bad: true });
    expect(lost['Value of those hours']!.bad).toBeFalsy();
    expect(read(month())['Return on your plan']!.bad).toBeFalsy();
    expect(read(month({ value: 200, return: 0 }))['Return on your plan']).toMatchObject({ value: '$0.00', bad: false });
  });

  it('hours saved and value below zero are bad too, so a losing month cannot read as neutral; steering is a cost, not a loss', () => {
    const f = read(month({ byHandHours: 1, attentionHours: 5, netHours: -4, value: -360, return: -560 }));
    expect(f['Hours saved']).toMatchObject({ value: '−4 h', bad: true });
    expect(f['Value of those hours']).toMatchObject({ value: '−$360', bad: true });
    expect(f['Time you spent steering']!.bad).toBeFalsy();
  });

  it('a partial API-equivalent is a floor, as everywhere else', () => {
    expect(read(month({ apiCost: 2055, costPartial: true }))['What you paid']!.usual).toBe('your plan · ≥ $2,055 at API prices.');
  });
});

describe('the reading', () => {
  const text = (said: Said) => said.map((s) => (typeof s === 'string' ? s : s.b)).join('');
  const bold = (said: Said) => said.flatMap((s) => (typeof s === 'string' ? [] : [s.b]));
  const big = month({ byHandHours: 892.4, attentionHours: 50.2, netHours: 842.2, value: 84_220, return: 84_020, prs: Array.from({ length: 120 }, (_, i) => auto(i + 1, 400, 1)), sized: 120, total: 120 });

  it('says what the PRs would have taken by hand, what steering took, and what is left, worth what at the rate, and the plan', () => {
    expect(text(worthReading(big, 'mobile-app', 'October so far'))).toBe(
      'October so far: the 120 PRs merged in mobile-app would have taken you about 892 hours by hand. You spent about 50 hours steering the agents, so they saved you about 842 hours, worth $84,200 at your $90 an hour. The plan cost $200.');
    expect(bold(worthReading(big, 'mobile-app', 'October so far'))).toEqual(['120 PRs', '892 hours', '50 hours', '842 hours', '$84,200', '$200']);
  });

  it('small figures keep a decimal, large ones are whole; dollars round to the ten, to the hundred from $10,000', () => {
    const d = month({ byHandHours: 7.44, attentionHours: 2.04, netHours: 5.4, value: 486.4, prs: [auto(1, 400, 1)] });
    expect(text(worthReading(d, 'x', 'September 2026'))).toContain('about 7.4 hours by hand. You spent about 2 hours steering the agents, so they saved you about 5.4 hours, worth $490 at your $90 an hour.');
  });

  it('a losing month says so: steering took more than the work would have by hand, and the loss in dollars', () => {
    const d = month({ byHandHours: 2, attentionHours: 10, netHours: -8, value: -720, return: -920, prs: [auto(1, 400, 1)] });
    const t = text(worthReading(d, 'mobile-app', 'October so far'));
    expect(t).toContain('so steering them took about 8 hours more than the work would have by hand, a loss of $720 at your $90 an hour.');
    expect(t).not.toContain('saved');
  });

  it('without a rate there is no value to name, and without a plan no plan to name; the PRs it counts are those with hours (a skip and an unsized one are not)', () => {
    const t = text(worthReading(month({ value: null, return: null, settings: withSettings({ rate: null, plan: null }) }), 'mobile-app', 'October so far'));
    expect(t).toBe('October so far: the 2 PRs merged in mobile-app would have taken you about 8 hours by hand. You spent about 3 hours steering the agents, so they saved you about 5 hours.');
  });

  it('a single PR is "1 PR"', () => {
    expect(text(worthReading(month({ prs: [auto(1, 100, 1)] }), 'p', 'October so far'))).toContain('the 1 PR merged in p');
  });
});

describe('a merged PR row', () => {
  it('reads as the mock: number, title, then merged date, the lines and files counted, and its share of the session', () => {
    const r = prRow(auto(141, 288, 14, { title: 'feat(api): export photos as a zip', mergedAt: at(2026, 10, 25, 14), additions: 4000, deletions: 47, sessions: 2, agents: 7, cost: 1.314 }));
    expect(r).toMatchObject({ number: 141, id: '#141', title: 'feat(api): export photos as a zip', hidden: false, size: 'M', yours: false, chip: 'auto · M' });
    expect(r.meta).toBe('merged 25 Oct · 288 lines in 14 files · part of 2 sessions · 7 agents · $1.31');
    expect(r.why).toBe('score 1,385 = 288 lines × (1 + log₂ 14 files)');
  });

  it('the chip says whose size it is: auto, yours (a tap, a Skip), or not sized', () => {
    expect(prRow(auto(1, 100, 1)).chip).toBe('auto · S');
    expect(prRow(pr(1, 'M', { countedLines: 100, countedFiles: 1 })).chip).toBe('yours · M');
    expect(prRow(pr(1, 'skip')).chip).toBe('yours · skip');
    expect(prRow(pr(1, null)).chip).toBe('not sized');
  });

  it('a PR with nothing counted yet shows the lines the PR changed, and says why it has no size', () => {
    const r = prRow(pr(7, null, { additions: 1288, deletions: 47 }));
    expect(r.meta).toMatch(/^merged \d+ \w+ · \+1,288 −47 · /);
    expect(r.why).toMatch(/^no lines counted yet/);
  });

  it('singulars: one line in one file, one session, one agent; and a PR no session opened', () => {
    expect(prRow(auto(1, 1, 1, { sessions: 1, agents: 1, cost: 0 })).meta).toMatch(/ · 1 line in 1 file · part of 1 session · 1 agent · \$0\.00$/);
    expect(prRow(auto(1, 5, 2, { sessions: 0, agents: 0, cost: 0 })).meta).toMatch(/ · 5 lines in 2 files · no session linked$/);
    expect(prRow(auto(1, 5, 2, { sessions: 1, agents: 0, cost: 0.004 })).meta).toMatch(/ · part of 1 session · 0 agents · <\$0\.01$/);
  });

  it('a hidden title (an excluded project) says so, and is marked so the row can mute it', () => {
    expect(prRow(pr(7, null, { title: null }))).toMatchObject({ title: '(title hidden: an excluded project)', hidden: true, size: null });
  });

  it('dates the merge in the viewer\'s zone', () => {
    const merged = Date.parse('2026-10-25T20:00:00Z'); // 26 Oct 09:00 in Auckland, 25 Oct 13:00 in Los Angeles
    expect(inZone('Pacific/Auckland', () => prRow(pr(1, null, { mergedAt: merged })).meta)).toMatch(/^merged 26 Oct · /);
    expect(inZone('America/Los_Angeles', () => prRow(pr(1, null, { mergedAt: merged })).meta)).toMatch(/^merged 25 Oct · /);
  });
});

describe('the list of rows', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => pr(n - i, null)); // newest first, as the server sends them

  it('shows the first 20 and counts the rest', () => {
    const r = firstRows(many(25), false);
    expect(r.rows.map((p) => p.number)).toEqual(many(25).slice(0, 20).map((p) => p.number));
    expect(r.rows).toHaveLength(20);
    expect(r.hidden).toBe(5);
  });

  it('20 is not too many, and 21 is', () => {
    expect(firstRows(many(20), false)).toMatchObject({ hidden: 0 });
    expect(firstRows(many(20), false).rows).toHaveLength(20);
    expect(firstRows(many(21), false)).toMatchObject({ hidden: 1 });
  });

  it('"Show All" shows every one and hides none', () => {
    const r = firstRows(many(25), true);
    expect(r.rows).toHaveLength(25);
    expect(r.hidden).toBe(0);
  });

  it('nothing in, nothing out', () => {
    expect(firstRows([], false)).toEqual({ rows: [], hidden: 0 });
  });
});

describe('the PR card\'s hint', () => {
  it('counts the PRs, says how many are yours (a Skip is yours), how many have no size yet, and that release merges are left out', () => {
    expect(prsHint(month())).toBe('4 PRs · 2 sized by you · 1 not sized yet · newest first · release merges left out');
    expect(prsHint(month({ prs: [auto(1, 100, 1), auto(2, 100, 1)], total: 2 }))).toBe('2 PRs · newest first · release merges left out');
    expect(prsHint(month({ prs: [pr(1, 'M')], total: 1 }))).toBe('1 PR · 1 sized by you · newest first · release merges left out');
  });

  it('says nothing when there are none', () => {
    expect(prsHint(month({ sized: 0, total: 0, prs: [] }))).toBe('');
  });
});

describe('deriving a month from its PRs and settings', () => {
  it('reproduces the server\'s own figures for the same month, so a recomputed card cannot drift from a loaded one', () => {
    expect(derive(month())).toEqual(month());
  });

  it('a skip is answered but adds no hours; an unsized PR is neither', () => {
    const d = derive(month({ prs: [pr(2, 'skip'), pr(1, null)], sized: 0, byHandHours: 99 }));
    expect(d.sized).toBe(1);
    expect(d.byHandHours).toBe(0);
  });

  it('a PR that is not yours follows the cut points, and one that is yours does not', () => {
    const d = derive(month({ settings: withSettings({ cuts: { S: 100, M: 300, L: 6000 } }) }));
    expect(d.prs.map((p) => p.size)).toEqual(['L', 'L', 'skip', null]); // #4: 400 lines is L now (6 h); #3 stays the owner's L
    expect(d).toMatchObject({ byHandHours: 12, sized: 3 });
  });

  it('value and return are null without a rate, and return without a plan; a plan of 0 keeps it', () => {
    expect(derive(month({ settings: withSettings({ rate: null }) }))).toMatchObject({ value: null, return: null });
    expect(derive(month({ settings: withSettings({ plan: null }) }))).toMatchObject({ value: 450, return: null });
    expect(derive(month({ settings: withSettings({ plan: 0 }) }))).toMatchObject({ value: 450, return: 450 });
  });

  it('a month whose attention beats the hours by hand is negative all the way down', () => {
    const d = derive(month({ attentionHours: 10 }));
    expect(d).toMatchObject({ netHours: -2, value: -180, return: -380 });
  });
});

describe('the optimistic update and its rollback', () => {
  const sizeAction = (size: Pr['size'], number = 1, over: object = {}) => ({ type: 'size' as const, project: 'mobile-app', month: '2026-10', number, size, ...over });

  it('a tap makes the PR yours at once and moves every figure that hangs on it', () => {
    const s = worthReducer(shown(), sizeAction('XL'));
    expect(sizeOf(s, 1)).toBe('XL');
    expect(yoursOf(s, 1)).toBe(true);
    expect(s!.data).toMatchObject({ sized: 4, byHandHours: 24, netHours: 21, value: 1890, return: 1690, total: 4 });
  });

  it('a tap on the size an automatic PR already has makes it yours all the same: the label changes, the hours do not', () => {
    const s = worthReducer(shown(), sizeAction('M', 4)); // #4 is automatic M
    expect(yoursOf(s, 4)).toBe(true);
    expect(sizeOf(s, 4)).toBe('M');
    expect(s!.data.byHandHours).toBe(8);
  });

  it('changing a size swaps its hours and leaves the count alone', () => {
    const s = worthReducer(shown(), sizeAction('XL', 4)); // #4 was M (2 h)
    expect(s!.data).toMatchObject({ sized: 3, byHandHours: 22 });
  });

  it('Skip drops the hours and stays answered', () => {
    const skipped = worthReducer(shown(), sizeAction('skip', 3)); // #3 was L (6 h)
    expect(skipped!.data).toMatchObject({ sized: 3, byHandHours: 2 });
  });

  it('Back to Auto gives the PR the score\'s size again, and the hours with it; with nothing counted there is none', () => {
    const back = worthReducer(shown(), sizeAction(null, 3)); // #3 is yours L; its 100 lines are S
    expect(yoursOf(back, 3)).toBe(false);
    expect(sizeOf(back, 3)).toBe('S');
    expect(back!.data).toMatchObject({ sized: 3, byHandHours: 2.5 });
    const none = worthReducer(shown(), sizeAction(null, 2)); // #2 is yours, Skip, with nothing counted
    expect(sizeOf(none, 2)).toBeNull();
    expect(none!.data).toMatchObject({ sized: 2, byHandHours: 8 });
  });

  it('touches only the PR tapped', () => {
    const s = worthReducer(shown(), sizeAction('S', 1));
    expect(s!.data.prs.filter((p) => p.number !== 1)).toEqual(month().prs.filter((p) => p.number !== 1));
    expect(s!.data.prs.find((p) => p.number === 1)).toEqual({ ...pr(1, 'S') });
  });

  it('a failed save puts the old size back and every figure with it, for a PR that was yours and for one that was automatic', () => {
    const before = shown();
    const optimistic = worthReducer(before, sizeAction('XL', 4)); // #4 was automatic: the rollback is Back to Auto
    expect(optimistic).not.toEqual(before);
    expect(worthReducer(optimistic, sizeAction(null, 4))).toEqual(before);
    const changed = worthReducer(before, sizeAction(null, 3)); // #3 was yours L: the rollback is L again
    expect(worthReducer(changed, sizeAction('L', 3))).toEqual(before);
    const fresh = worthReducer(before, sizeAction('XL')); // #1 had no size at all
    expect(worthReducer(fresh, sizeAction(null))).toEqual(before);
  });

  it('a rollback does not undo a tap on another PR made meanwhile', () => {
    let s = worthReducer(shown(), sizeAction('XL', 1)); // in flight, will fail
    s = worthReducer(s, sizeAction('S', 2)); // another tap, saved
    s = worthReducer(s, sizeAction(null, 1)); // the first one's rollback
    expect(sizeOf(s, 1)).toBeNull();
    expect(sizeOf(s, 2)).toBe('S');
    expect(s!.data.byHandHours).toBe(8.5); // M 2 + L 6 + S 0.5
  });

  it('a save that lands after the owner moved to another project or month changes nothing', () => {
    const s = shown();
    expect(worthReducer(s, sizeAction('XL', 1, { project: 'solo' }))).toBe(s);
    expect(worthReducer(s, sizeAction('XL', 1, { month: '2026-09' }))).toBe(s);
  });

  it('a PR that is not on the card, or nothing loaded yet, changes nothing', () => {
    const s = shown();
    expect(worthReducer(s, sizeAction('XL', 999))).toBe(s);
    expect(worthReducer(undefined, sizeAction('XL'))).toBeUndefined();
  });

  it('does not touch the state it was given', () => {
    const frozen = shown(structuredClone(month()));
    const copy = structuredClone(frozen);
    worthReducer(frozen, sizeAction('XL', 4));
    expect(frozen).toEqual(copy);
  });

  it('new settings recompute the card without a reload: a rate, a cleared rate, new hours for a size', () => {
    const sizes = month().settings.sizes;
    const rated = worthReducer(shown(), { type: 'settings', settings: withSettings({ rate: 100 }) });
    expect(rated!.data).toMatchObject({ value: 500, return: 300 });
    const unrated = worthReducer(shown(), { type: 'settings', settings: withSettings({ rate: null }) });
    expect(unrated!.data).toMatchObject({ value: null, return: null, byHandHours: 8 });
    const longer = worthReducer(shown(), { type: 'settings', settings: withSettings({ sizes: { ...sizes, M: 4, L: 10 } }) });
    expect(longer!.data).toMatchObject({ byHandHours: 14, netHours: 11, value: 990, return: 790 });
    expect(longer!.data.settings.sizes).toEqual({ S: 0.5, M: 4, L: 10, XL: 16 });
    expect(worthReducer(undefined, { type: 'settings', settings: month().settings })).toBeUndefined();
  });

  it('moving a cut point moves the automatic sizes and leaves the owner\'s: #4 (400 lines) is M under 1,500 and L under 300', () => {
    const moved = worthReducer(shown(), { type: 'settings', settings: withSettings({ cuts: { S: 100, M: 300, L: 6000 } }) });
    expect(sizeOf(moved, 4)).toBe('L');
    expect(yoursOf(moved, 4)).toBe(false);
    expect(sizeOf(moved, 3)).toBe('L'); // the owner's, whatever the cut points say
    expect(moved!.data.byHandHours).toBe(12);
    const back = worthReducer(moved, { type: 'settings', settings: withSettings({}) });
    expect(back).toEqual(shown());
  });

  it('a load replaces what was shown, and names its project', () => {
    const s = worthReducer(shown(), { type: 'loaded', project: 'solo', data: month({ month: '2026-09', prs: [], sized: 0, total: 0 }) });
    expect(s!.project).toBe('solo');
    expect(s!.data.month).toBe('2026-09');
  });
});

describe('Edit Sizes as typed', () => {
  const hoursText = { S: '0.5', M: '2', L: '6', XL: '16' };
  const cutsText = { S: '300', M: '1,500', L: '6,000' };

  it('a cut point: a score above 0 and at most 10,000,000, thousands commas allowed, never blank', () => {
    expect(parseCut('300')).toEqual({ value: 300 });
    expect(parseCut(' 1,500 ')).toEqual({ value: 1500 });
    expect(parseCut('10000000')).toEqual({ value: 10_000_000 });
    for (const text of ['', '0', '-5', '10000001', 'abc', '$300', '1,50', '1e3']) expect(parseCut(text), text).toHaveProperty('error');
  });

  it('reads both groups into the settings the server takes', () => {
    expect(parseSizesForm(hoursText, cutsText)).toEqual({ sizes: { S: 0.5, M: 2, L: 6, XL: 16 }, cuts: { S: 300, M: 1500, L: 6000 } });
  });

  it('names the first field that is wrong, hours before cut points', () => {
    expect(parseSizesForm({ ...hoursText, M: 'x' }, { ...cutsText, S: '' })).toEqual({ error: 'M: Give hours above 0 and at most 1,000, like 0.5 or 16' });
    expect(parseSizesForm(hoursText, { ...cutsText, L: '0' })).toEqual({ error: 'L is below: Give a score above 0 and at most 10,000,000, like 300 or 1,500' });
  });

  it('the cut points must go up: S below M and M below L, and equal is not up', () => {
    const up = { error: 'The cut points go up: S is below M, and M is below L.' };
    expect(parseSizesForm(hoursText, { S: '2,000', M: '1,500', L: '6,000' })).toEqual(up);
    expect(parseSizesForm(hoursText, { S: '300', M: '300', L: '6,000' })).toEqual(up);
    expect(parseSizesForm(hoursText, { S: '300', M: '6,000', L: '6,000' })).toEqual(up);
    expect(parseSizesForm(hoursText, { S: '299', M: '300', L: '301' })).toHaveProperty('cuts');
  });
});

describe('reading the owner\'s numbers', () => {
  it('a rate: dollars, with or without the sign and thousands commas; blank clears it', () => {
    expect(parseRate('90')).toEqual({ value: 90 });
    expect(parseRate('$90')).toEqual({ value: 90 });
    expect(parseRate(' $ 1,200.50 ')).toEqual({ value: 1200.5 });
    expect(parseRate('.5')).toEqual({ value: 0.5 });
    expect(parseRate('')).toEqual({ value: null });
    expect(parseRate('   ')).toEqual({ value: null });
  });

  it('a rate: above 0 and at most 100,000, as the server holds it', () => {
    expect(parseRate('100000')).toEqual({ value: 100_000 });
    expect(parseRate('100000.01')).toHaveProperty('error');
    expect(parseRate('0')).toHaveProperty('error');
    expect(parseRate('-5')).toHaveProperty('error');
  });

  it('a decimal comma is refused, never read as thousands: "90,50" is not $9,050', () => {
    expect(parseRate('90,50')).toHaveProperty('error');
    expect(parseRate('1,20')).toHaveProperty('error');
    expect(parseRate('1,200')).toEqual({ value: 1200 });
    expect(parsePlan('0,5')).toHaveProperty('error');
  });

  it('text that is not an amount is refused, not coerced', () => {
    for (const text of ['abc', '1e3', '9 0', '90$', '0x10', 'Infinity', '--5', '90.', '.']) expect(parseRate(text)).toHaveProperty('error');
  });

  it('a plan: 0 to 1,000,000 a month; 0 is a plan, blank clears it', () => {
    expect(parsePlan('0')).toEqual({ value: 0 });
    expect(parsePlan('200')).toEqual({ value: 200 });
    expect(parsePlan('1000000')).toEqual({ value: 1_000_000 });
    expect(parsePlan('1000001')).toHaveProperty('error');
    expect(parsePlan('')).toEqual({ value: null });
  });

  it('hours of a size: above 0 and at most 1,000, and never blank (a size cannot be cleared)', () => {
    expect(parseHours('0.5')).toEqual({ value: 0.5 });
    expect(parseHours('16')).toEqual({ value: 16 });
    expect(parseHours('1000')).toEqual({ value: 1000 });
    expect(parseHours('1000.5')).toHaveProperty('error');
    expect(parseHours('0')).toHaveProperty('error');
    expect(parseHours('')).toHaveProperty('error');
    expect(parseHours('2 h')).toHaveProperty('error');
    expect(parseHours('$2')).toHaveProperty('error');
    expect(parseHours('0,5')).toHaveProperty('error');
  });

  it('every refusal says what is wanted', () => {
    expect(parseRate('abc')).toEqual({ error: 'Give an amount in dollars, like 90 or 1,200.50 (cents follow a point)' });
    expect(parseRate('0')).toEqual({ error: 'An hourly rate is above $0 and at most $100,000' });
    expect(parsePlan('-1')).toEqual({ error: 'Give an amount in dollars, like 90 or 1,200.50 (cents follow a point)' });
    expect(parsePlan('2000000')).toEqual({ error: 'A plan costs $0 to $1,000,000 a month' });
    expect(parseHours('')).toEqual({ error: 'Give hours above 0 and at most 1,000, like 0.5 or 16' });
    expect(parseHours('abc')).toEqual({ error: 'Give hours above 0 and at most 1,000, like 0.5 or 16' });
  });
});
