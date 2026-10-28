import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readTokens } from '../src/format.ts';
import { Figure } from '../src/kit.tsx';
import { TotalsBody, type Data } from '../src/Ledger.tsx';
import { totalsFigures, totalsReading, type Totals } from '../src/totals-math.ts';
import { ChangeList, NoHistory, TrendsBody, type Loaded } from '../src/Trends.tsx';
import { numbered, type Change, type TBucket } from '../src/trends-math.ts';
import { figs } from './figs.ts';

// Totals, Trends and Patterns say what their figures mean (#102, design/v0.3-readable.html): a reading on top, every figure in one shape, its explanation behind an ⓘ in
// place, and Compare opening under its change. The views are rendered to markup, which runs no effects: what is drawn from data is checked here (Patterns, in patterns.spec.ts).
const read = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const plain = (html: string) => read(html.replace(/<\/?b>/g, '')); // the bold parts of a sentence run into it
const reading = (html: string) => plain(/<section class="card said"[^>]*>.*?<\/section>/s.exec(html)![0]).trim();
const BY = ' Written from the figures below; it changes with them.';
const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();

// ── Totals ───────────────────────────────────────────────────────────────────

// The last 7 days, as the Ledger reads them: 8.1 B tokens against 10.5 B before, $2,615 against $3,000, 499 permission prompts of which 8 stayed open over an hour (5.5 h with each
// counted up to 10 minutes, 9.2 h counted in full).
const totals = (over: Partial<Totals> = {}): Totals => ({
  tokens: 8_100_000_000, cost: 2615.4, costPartial: false, cacheShare: 0.974, sessions: 12, agents: 247, toolCalls: 30_060, failedCalls: 930, waits: 499, waitMs: 19_800_000, waitMsFull: 33_000_000,
  waitsOverHour: 8, previousTokens: 10_500_000_000, previousCost: 3000, pricier: { agents: 0, cost: 0 }, ...over,
});
const sums = { cost: 1, costPartial: false };
const data = (t: Totals = totals(), efficiency: Data['efficiency'] = [
  { project: 'mobile-app', tokens: 5e9, requests: 9000, cacheShare: 0.94, filesChanged: 40, toolCalls: 20_000, failedCalls: 600, waitMs: 1 },
  { project: 'docs-site', tokens: 2e9, requests: 4000, cacheShare: 0.99, filesChanged: 10, toolCalls: 9000, failedCalls: 300, waitMs: 1 },
  { project: 'scratch', tokens: 5e6, requests: 40, cacheShare: 0.2, filesChanged: 0, toolCalls: 60, failedCalls: 30, waitMs: 1 }, // a trial run: not what is usual
]): Data => ({
  totals: t, series: [{ bucket: '2026-10-26', tokens: t.tokens, cost: 1, byModel: { 'claude-opus-5-5': t.tokens } }],
  byProject: [{ name: 'mobile-app', ...sums, tokens: t.tokens, sessions: 12, agents: 247 }], byModel: [{ model: 'claude-opus-5-5', ...sums, tokens: t.tokens, agents: 247 }],
  byRole: [{ role: 'orchestrator', ...sums, tokens: t.tokens, agents: 247, types: ['main'] }], efficiency,
});
const body = (d: Data, range: 'today' | '7d' | '30d' = '7d') =>
  renderToStaticMarkup(createElement(TotalsBody, { data: d, range, unit: 'day', onUnit: () => {}, span: { from: at(2026, 10, 20), to: at(2026, 10, 26, 16) } }));

describe('Totals: the reading', () => {
  it('opens the view, above the figures, written from them: tokens against the period before, cost, cache, failed calls', () => {
    const html = body(data());
    expect(html.indexOf('aria-label="Reading"')).toBeLessThan(html.indexOf('class="fig"'));
    expect(reading(html)).toBe(
      `In the last 7 days, 12 sessions and 247 agents used 8.1 billion tokens, 23% fewer than in the 7 days before. That is $2,615 at API prices. 97% of what they read came from cache, which costs a tenth as much. 3.1% of tool calls failed.${BY}`);
  });

  it('says the period it is, and what it can: nothing about the period before when there was none, nothing about cache or failed calls when there are none', () => {
    expect(reading(body(data(totals({ previousTokens: 0 })), 'today'))).toContain('Today, 12 sessions and 247 agents used 8.1 billion tokens. That is');
    expect(reading(body(data(totals({ cacheShare: null, toolCalls: 0, failedCalls: 0 })), '30d'))).toBe(
      `In the last 30 days, 12 sessions and 247 agents used 8.1 billion tokens, 23% fewer than in the 30 days before. That is $2,615 at API prices.${BY}`);
  });

  it('the bold parts are the figures', () => {
    const bold = [.../<section class="card said"[^>]*>.*?<\/section>/s.exec(body(data()))![0].matchAll(/<b>(.*?)<\/b>/g)].map((m) => m[1]);
    expect(bold).toEqual(['12 sessions', '247 agents', '8.1 billion tokens', '$2,615', '97%', '3.1%']);
  });
});

describe('Totals: the figures', () => {
  const shape = (html: string) => figs(html).map((f) => [f.label, f.value, f.usual]);

  it('six, each a label, a readable value and one line', () => {
    expect(shape(body(data()))).toEqual([
      ['Tokens used', '8.1 B', 'About usual: 23% fewer than the 7 days before (10.5 B).'],
      ['What it would cost at API prices', '$2,615', '13% less than the 7 days before ($3,000). Your plan is a flat fee, not this.'],
      ['Read from cache', '97%', 'Usual: every project reads 94% to 99% from cache.'],
      ['Tool calls that failed', '3.1%', '930 of 30,060 calls. Usual: under 4% is normal.'],
      ['Agents waiting for you', '5h 30m', '499 permission prompts, each counted up to 10 minutes (9.2 h counted in full). 8 stayed open over an hour.'],
      ['Spent above the model set', '$0.00', 'None: no agent ran on a pricier model than it should.'],
    ]);
  });

  it('each has its explanation behind an ⓘ that names it, closed until it is pressed', () => {
    const html = body(data());
    const all = figs(html);
    expect(all).toHaveLength(6);
    expect(all.every((f) => !f.open && f.why.length > 60)).toBe(true);
    expect(html).toContain('aria-label="What Agents waiting for you means"');
    expect(new Set(all.map((f) => f.id)).size).toBe(6); // each ⓘ has a paragraph of its own
  });

  it('the wait says what the cap is and why, and what it would read without it', () => {
    expect(figs(body(data())).find((f) => f.label === 'Agents waiting for you')!.why).toBe(
      'The time tool calls sat at a permission prompt, waiting for you. A dialog left open overnight would read as hours, so each wait counts at most 10 minutes, as Worth counts it. Counted in full it would read 9.2 h.');
  });

  it('no dialog over an hour says none; a short wait counted in full reads in minutes, not 0 h; no wait at all says so', () => {
    expect(figs(body(data(totals({ waitsOverHour: 0 }))))[4]!.usual).toBe('499 permission prompts, each counted up to 10 minutes (9.2 h counted in full). None stayed open over an hour.');
    expect(figs(body(data(totals({ waits: 1, waitMs: 90_000, waitMsFull: 90_000, waitsOverHour: 0 }))))[4]!.usual).toBe(
      '1 permission prompt, each counted up to 10 minutes (1m 30s counted in full). None stayed open over an hour.');
    expect(figs(body(data(totals({ waits: 0, waitMs: 0, waitMsFull: 0, waitsOverHour: 0 }))))[4]).toMatchObject({
      value: '0s', usual: 'No agent waited at a permission prompt.', why: expect.not.stringContaining('Counted in full'),
    });
  });

  it('cost says how it moved against the period before, with the period\'s own words, and that a plan is a flat fee', () => {
    const line = (over: Partial<Totals>, range: 'today' | '7d' | '30d' = '7d') => figs(body(data(totals(over)), range))[1]!.usual;
    expect(line({ previousCost: 2000 })).toBe('31% more than the 7 days before ($2,000). Your plan is a flat fee, not this.');
    expect(line({ previousCost: 2615.4 })).toBe('The same as the 7 days before ($2,615). Your plan is a flat fee, not this.');
    expect(line({ previousCost: 2615.4 * 2 }, '30d')).toBe('50% less than the 30 days before ($5,231). Your plan is a flat fee, not this.');
    expect(line({}, 'today')).toBe('13% less than the period before ($3,000). Your plan is a flat fee, not this.');
  });

  it('with no cost before it, or a cost that is only a floor, cost says only what it is: no percentage from half a figure', () => {
    for (const over of [{ previousCost: 0 }, { previousCost: null }, { costPartial: true }]) expect(figs(body(data(totals(over))))[1]!.usual).toBe('At list prices, not a bill.');
  });

  it('tokens say whether they are usual: within a quarter of the period before is about usual, past it above or below', () => {
    const line = (previousTokens: number) => figs(body(data(totals({ previousTokens }))))[0]!.usual;
    expect(line(10_800_000_000)).toBe('About usual: 25% fewer than the 7 days before (10.8 B).'); // exactly a quarter is still about usual
    expect(line(10_900_000_000)).toBe('Below usual: 26% fewer than the 7 days before (10.9 B).');
    expect(line(5_000_000_000)).toBe('Above usual: 62% more than the 7 days before (5.0 B).');
    expect(line(8_100_000_000)).toBe('About usual: the same as the 7 days before (8.1 B).');
  });

  it('with no period before, tokens say nothing about being usual: no empty line, no invented one', () => {
    const [tokens] = figs(body(data(totals({ previousTokens: 0 }))));
    expect(tokens).toMatchObject({ label: 'Tokens used', value: '8.1 B', usual: undefined });
    expect(body(data(totals({ previousTokens: 0 })))).not.toContain('usual:');
  });

  it('cache is usual against the projects that did real work, and says nothing when there is no range: one project, or the trial runs left out', () => {
    const only = (e: Data['efficiency']) => figs(body(data(totals(), e)))[2]!.usual;
    expect(only(data().efficiency.slice(0, 1))).toBeUndefined(); // one project has no range
    expect(only(data().efficiency.slice(1))).toBeUndefined(); // a trial run does not make one
    expect(only(data().efficiency.slice(0, 2))).toBe('Usual: every project reads 94% to 99% from cache.');
  });

  it('a failure rate from 4% on is more than usual; none of them failed or none called is still a figure', () => {
    expect(figs(body(data(totals({ failedCalls: 1203 }))))[3]!.usual).toBe('1,203 of 30,060 calls. More than usual: under 4% is normal.'); // 4.002%
    expect(figs(body(data(totals({ failedCalls: 1202 }))))[3]!.usual).toBe('1,202 of 30,060 calls. Usual: under 4% is normal.'); // 3.998%
    expect(figs(body(data(totals({ toolCalls: 0, failedCalls: 0 }))))[3]).toMatchObject({ value: '—', usual: undefined });
  });

  it('agents above the model set are counted', () => {
    expect(figs(body(data(totals({ pricier: { agents: 3, cost: 41.5 } }))))[5]).toMatchObject({ value: '$41.50', usual: '3 agents ran on a pricier model than it should.' });
  });

  it('a cost with unpriced requests is a floor', () => {
    expect(figs(body(data(totals({ costPartial: true }))))[1]!.value).toBe('≥ $2,615');
  });

  it('there are no tiles and no explainer at the bottom of the page: the ⓘ holds what it said', () => {
    const html = body(data());
    expect(html).not.toMatch(/class="(kpi|totals)/);
    expect(html).not.toContain('How these numbers are counted');
    expect(html).not.toContain('<details class="explain"');
  });

  it('the efficiency table uses the figures\' words', () => {
    const table = /<table class="eff">.*?<\/thead>/s.exec(body(data()))![0];
    expect(read(table)).toBe(' Project Tokens per file changed Calls that failed Read from cache Agents waiting for you Requests to the model ');
  });
});

describe('totals-math, apart from the page', () => {
  it('the reading and the figures are the same numbers', () => {
    const t = totals();
    expect(totalsReading(t, '7d').filter((p) => typeof p !== 'string')).toContainEqual({ b: '8.1 billion tokens' });
    expect(totalsFigures(t, [], '7d')[0]!.value).toBe('8.1 B');
  });

  it('a token count can be said in words for a sentence', () => {
    expect([readTokens(8_100_000_000, true), readTokens(4_900_000, true), readTokens(120_000_000, true), readTokens(312_400, true), readTokens(950, true)])
      .toEqual(['8.1 billion', '4.9 million', '120 million', '312 thousand', '950']);
  });
});

// ── The ⓘ ────────────────────────────────────────────────────────────────────

describe('an ⓘ opens its explanation in place', () => {
  const props = { label: 'Read from cache', value: '97%', usual: 'Usual: 94% to 99%.', why: 'Of all the input the models read, the share that came from cache. See `pricing.json`.' };

  it('closed: the paragraph is there, hidden, and the button says it is collapsed', () => {
    const html = renderToStaticMarkup(createElement(Figure, props));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<p class="why" id="[^"]*" hidden="">/);
    expect(figs(html)).toMatchObject([{ label: 'Read from cache', value: '97%', usual: 'Usual: 94% to 99%.', open: false }]);
  });

  it('open: the same paragraph, shown, inside the figure that owns it and right after its value and line, with `code` as code', () => {
    const html = renderToStaticMarkup(createElement(Figure, { ...props, open: true }));
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('hidden=""');
    expect(figs(html)).toMatchObject([{ open: true, why: 'Of all the input the models read, the share that came from cache. See pricing.json.' }]);
    expect(html).toContain('<code>pricing.json</code>');
    expect(html.match(/<div class="fig">/g)).toHaveLength(1); // the paragraph is not beside the figure, nor at the bottom of the page: it is in it
  });

  it('a figure with nothing to be usual against has no line, and a value that is bad is red', () => {
    const html = renderToStaticMarkup(createElement(Figure, { label: 'Unbacked claims', value: '3', why: 'x', bad: true }));
    expect(html).not.toContain('class="d"');
    expect(html).toContain('<span class="v neg">3</span>');
  });
});

// ── Trends ───────────────────────────────────────────────────────────────────

const bucket = (k: string, o: Partial<TBucket>): TBucket => ({ bucket: k, main: 0, typed: 0, generic: 0, opus: 0, sonnet: 0, haiku: 0, other: 0, tokens: 0, cacheRead: 0, inputSide: 0, activeDays: 0, prompts: 0, costPartial: false, ...o });
const change = (day: string, ts: number, subject: string, o: Partial<Change> = {}): Change => ({
  id: `docs-site:${day}`, day, ts, commits: [{ sha: `${day.slice(-2)}c4d1e90123`, ts, subject, files: ['.claude/skills/code/SKILL.md'] }], seen: [], files: [], before: null, after: null, ...o,
});
const side = (days: number, cost: number, generic: number, typed: number, opus: number) => ({ days, cost, generic, typed, opus });
const CHANGES = [
  change('2026-09-29', at(2026, 9, 29, 10), 'Brief the reviewers on the diff', { before: side(7, 259, 0, 91, 0), after: side(3, 207, 0, 78, 0) }),
  change('2026-10-13', at(2026, 10, 13, 11), 'Run issues through agents', { before: side(5, 200, 100, 0, 0), after: side(5, 150, 20, 25, 0) }),
  change('2026-10-20', at(2026, 10, 20, 9), 'Route reviews to Opus'),
];
const loaded: Loaded = {
  project: 'docs-site', unit: 'week', from: at(2026, 8, 3), to: at(2026, 10, 21, 15), changes: CHANGES,
  buckets: [
    bucket('2026-10-12', { main: 300, generic: 100, activeDays: 5, prompts: 400, cacheRead: 90, inputSide: 100 }),
    bucket('2026-10-19', { main: 200, typed: 50, generic: 250, activeDays: 5, prompts: 1000, cacheRead: 970, inputSide: 1000 }),
  ],
};
const trends = (d: Loaded = loaded) => renderToStaticMarkup(createElement(TrendsBody, { data: d, project: 'docs-site', split: 'who', onSplit: () => {}, hidden: false }));
const list = (html: string) => /<ul class="mklist" aria-label="Changes">.*?<\/ul>(?=<div class="mkmore">|<details)/s.exec(html)![0]; // the list, past the lists inside its rows
/** The rows of the list, each from its button to the end of what is open under it. */
const rowsOf = (ul: string) => ul.replace(/^<ul[^>]*><li>/, '').replace(/<\/li><\/ul>$/, '').split('</li><li><button').map((r, i) => (i ? `<button${r}` : r));

describe('Trends: the reading and the figures', () => {
  it('a reading on top, written from the figures, then four figures in the shape', () => {
    const html = trends();
    expect(html.indexOf('aria-label="Reading"')).toBeLessThan(html.indexOf('class="fig"'));
    expect(reading(html)).toBe(`This week a working day costs $100, 25% more than last week; a prompt costs $0.50, 50% less.${BY}`);
    expect(figs(html).map((f) => [f.label, f.value])).toEqual([['What a working day costs', '$100'], ['What one prompt costs', '$0.50'], ['Spent by generic agents', '50%'], ['Read from cache', '97.0%']]);
    expect(figs(html).every((f) => f.usual && f.why && !f.open)).toBe(true);
  });

  it('the old tiles are gone', () => {
    expect(trends()).not.toMatch(/class="(kpi|totals)/);
  });
});

describe('Trends: a project with no history', () => {
  it('shows an import command that names a Mac the way the plugin does (#107)', () => {
    const html = renderToStaticMarkup(createElement(NoHistory, { project: 'docs-site' }));
    expect(html).toContain('scutil --get LocalHostName');
    expect(html).toContain('hostname -s'); // the fallback, for a system without scutil
  });
});

describe('Trends: Compare opens under its change', () => {
  const changes = numbered(CHANGES);
  const render = (open?: string, all = false) =>
    renderToStaticMarkup(createElement(ChangeList, { changes, all, onAll: () => {}, open, onToggle: () => {} }));

  it('the table is inside the row of the change that is open, right under its button, and in no other', () => {
    const rows = rowsOf(list(render(changes[1]!.id))); // newest first: 3, 2, 1
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.includes('<table class="ba">'))).toEqual([false, true, false]);
    expect(rows[1]).toMatch(/^<button type="button" class="mkbtn" aria-expanded="true" aria-controls="chg-2">.*?<\/button><div class="cbody" id="chg-2">/s);
  });

  it('the table is not after the list: the list is the last place a Compare table can be', () => {
    const html = render(changes[0]!.id);
    expect(html.slice(html.indexOf('</ul>'))).not.toContain('<table');
    expect(html.indexOf('<table')).toBeLessThan(html.indexOf('</ul>'));
  });

  it('the action reads "Show before and after", and "Hide" on the open one; "Compare" is gone', () => {
    const rows = rowsOf(list(render(changes[2]!.id)));
    expect(rows.map((r) => /<span class="act">(.*?)<\/span>/.exec(r)![1])).toEqual(['Hide before and after', 'Show before and after', 'Show before and after']);
    expect(rows.map((r) => /aria-expanded="(\w+)"/.exec(r)![1])).toEqual(['true', 'false', 'false']);
    expect(render(changes[2]!.id)).not.toContain('Compare');
  });

  it('the row opens with the sentence, then the table, then what changed', () => {
    const row = rowsOf(list(render(changes[1]!.id)))[1]!;
    expect(plain(row.slice(row.indexOf('<div class="cbody"'), row.indexOf('<table')))).toBe(' In the 5 days after this change a day cost $30, 25% less than the 5 days before ($40). Agents on their own model went from $0.00 to $5.00 a day. ');
    expect(row.indexOf('<table')).toBeLessThan(row.indexOf('What changed'));
    expect(read(row)).toContain('What changed 13c4d1e Run issues through agents .claude/skills/code/SKILL.md');
    expect(read(row)).toContain('5 days before 5 days after');
  });

  it('with none open, no row is open and no table is drawn', () => {
    const html = render(undefined);
    expect(html).not.toContain('<table');
    expect(html).not.toContain('class="cbody"');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(3);
  });

  it('five at first, the rest behind Show All', () => {
    const many = numbered(Array.from({ length: 7 }, (_, i) => change(`2026-10-${String(10 + i)}`, at(2026, 10, 10 + i), `Change ${i}`)));
    const few = renderToStaticMarkup(createElement(ChangeList, { changes: many, all: false, onAll: () => {}, onToggle: () => {} }));
    expect(rowsOf(list(few))).toHaveLength(5);
    expect(few).toContain('Show All 7');
    const every = renderToStaticMarkup(createElement(ChangeList, { changes: many, all: true, onAll: () => {}, onToggle: () => {} }));
    expect(rowsOf(list(every))).toHaveLength(7);
    expect(every).not.toContain('Show All');
  });

  it('the view opens the latest change, so the first row shows its before and after without a click', () => {
    const rows = rowsOf(list(trends()));
    expect(rows.map((r) => r.includes('class="cbody"'))).toEqual([true, false, false]);
    expect(read(rows[0]!)).toContain('Route reviews to Opus'); // the newest, change 3, the one with the cbody
  });
});
