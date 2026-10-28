import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Figure, Reading, Seg } from '../src/kit.tsx';
import { MonthCard, PrCard, SizesForm } from '../src/Worth.tsx';
import { autoSize, worthFigures, worthReading, worthReducer, type Cuts, type Pr, type Settings, type Shown, type WorthData } from '../src/worth-math.ts';
import { figs } from './figs.ts';

// The Worth board (#103, design/v0.3-readable.html): "auto · L" with the lines and files behind it, a tap making it "yours · M", Back to Auto, and Edit Sizes moving a cut point.
// The studio has no DOM library, so the card is rendered to markup, and a tap is made by calling the handler the card hands to the element a person would press.
const plain = (html: string) => html.replace(/<\/?b>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const CUTS: Cuts = { S: 300, M: 1500, L: 6000 };
const SETTINGS: Settings = { rate: 90, plan: 200, sizes: { S: 0.5, M: 2, L: 6, XL: 16 }, cuts: CUTS };
const merged = new Date(2026, 9, 20, 12).getTime();
const row = (number: number, lines: number | null, files: number | null, over: Partial<Pr> = {}): Pr => {
  const size = lines === null || files === null ? null : autoSize(lines, files, CUTS);
  return { number, title: `PR ${number}`, mergedAt: merged, additions: 9, deletions: 9, countedLines: lines, countedFiles: files, size, yours: false, sessions: 1, agents: 2, cost: 1.5, ...over };
};
const data = (prs: Pr[]): WorthData => ({
  settings: SETTINGS, month: '2026-10', attentionHours: 3, waitsHours: 0.5, prompts: 40, days: 6, apiCost: 120, costPartial: false, prs, sized: 0, total: prs.length,
  byHandHours: 0, netHours: 0, value: null, return: null, releaseMerges: 7,
});
// state as the reducer keeps it, derived so that sizes and hours are the ones the server would send
const shown = (prs: Pr[]): Shown => worthReducer({ project: 'mobile-app', data: data(prs) }, { type: 'settings', settings: SETTINGS })!;

const card = (s: Shown, over: Partial<Parameters<typeof PrCard>[0]> = {}) => ({ data: s.data, all: true, onShowAll: () => {}, onTap: () => {}, ...over });
const html = (s: Shown, over?: Partial<Parameters<typeof PrCard>[0]>) => renderToStaticMarkup(createElement(PrCard, card(s, over)));
const rowHtml = (h: string, n: number) => h.split('<li ').slice(1).map((r) => `<li ${r}`).find((r) => r.includes(`>#${n}<`))!;

// every element in what a component returned
type El = ReactElement<{ children?: unknown; [k: string]: unknown }>;
const find = (node: unknown, test: (el: El) => boolean, found: El[] = []): El[] => {
  if (Array.isArray(node)) node.forEach((n) => find(n, test, found));
  else if (node && typeof node === 'object' && 'props' in node) {
    const el = node as El;
    if (test(el)) found.push(el);
    find(el.props.children, test, found);
  }
  return found;
};

describe('a row says whose size it is', () => {
  const s = shown([row(1, 1288, 3), row(2, 120, 1), row(3, null, null), row(4, 100, 1, { size: 'XL', yours: true }), row(5, 0, 0, { size: 'skip', yours: true })]);
  const h = html(s);

  it('"auto · L" with the lines and files behind it, and the score on the chip', () => {
    const r = rowHtml(h, 1);
    expect(plain(r)).toContain('auto · L');
    expect(plain(r)).toContain('1,288 lines in 3 files');
    expect(r).toContain('title="score 3,329 = 1,288 lines × (1 + log₂ 3 files)"');
    expect(plain(rowHtml(h, 2))).toContain('auto · S');
  });

  it('an owner\'s size reads "yours", a Skip reads "yours · skip", and a PR with nothing counted yet reads "not sized"', () => {
    expect(plain(rowHtml(h, 4))).toContain('yours · XL');
    expect(plain(rowHtml(h, 5))).toContain('yours · skip');
    expect(plain(rowHtml(h, 3))).toContain('not sized');
    expect(rowHtml(h, 3)).toContain('no lines counted yet');
  });

  it('Back to Auto sits only on the rows that are yours, and the size in force is the pressed one', () => {
    expect([1, 2, 3, 4, 5].map((n) => rowHtml(h, n).includes('Back to Auto'))).toEqual([false, false, false, true, true]);
    const pressed = (n: number) => [...rowHtml(h, n).matchAll(/<button type="button" aria-pressed="true">(.*?)<\/button>/g)].map((m) => m[1]);
    expect([1, 2, 3, 4, 5].map(pressed)).toEqual([['L'], ['S'], [], ['XL'], ['Skip']]);
  });

  it('the card says release merges are left out, and that a row is its share of the session', () => {
    const t = plain(h);
    expect(t).toContain('5 PRs · 2 sized by you · 1 not sized yet · newest first · release merges left out');
    expect(t).toContain("Each PR's cost, agents and sessions are its share of the session that opened it: the slice between the previous PR link and its own.");
    expect(plain(rowHtml(h, 1))).toContain('part of 1 session · 2 agents · $1.50');
  });

  it('no merged PRs: no share note, and the card says where PRs come from', () => {
    const t = plain(html(shown([])));
    expect(t).toContain('No merged PRs in October.');
    expect(t).not.toContain('share of the session');
  });

  it('the explanation names the cut points in force, and moves with them', () => {
    expect(plain(h)).toContain('S is below 300, M below 1,500, L below 6,000, XL from there');
    const moved = worthReducer(s, { type: 'settings', settings: { ...SETTINGS, cuts: { S: 100, M: 1000, L: 4000 } } })!;
    expect(plain(html(moved))).toContain('S is below 100, M below 1,000, L below 4,000, XL from there');
  });
});

describe('a tap makes it yours, and Back to Auto takes it back', () => {
  it('the handlers the card hands out are the ones a person presses: a size, and Back to Auto', () => {
    const s = shown([row(1, 1288, 3), row(4, 100, 1, { size: 'XL', yours: true })]);
    const onTap = vi.fn();
    const tree = PrCard(card(s, { onTap }));
    const segs = find(tree, (el) => el.type === Seg);
    expect(segs).toHaveLength(2);
    (segs[0]!.props.onChange as (v: string) => void)('L'); // #1: a tap on L
    (segs[0]!.props.onChange as (v: string) => void)('M'); // a tap on the size it already has is still a tap
    (segs[1]!.props.onChange as (v: string) => void)('skip');
    const backs = find(tree, (el) => el.type === 'button' && el.props.className === 'back');
    expect(backs).toHaveLength(1); // only #4 is yours
    (backs[0]!.props.onClick as () => void)();
    expect(onTap.mock.calls).toEqual([[1, 'L'], [1, 'M'], [4, 'skip'], [4, null]]);
  });

  it('the row then reads "yours · M" with Back to Auto beside it, and "auto · L" again after Back to Auto, with the hours following', () => {
    const start = shown([row(1, 2000, 1), row(2, 100, 1)]); // #1 is auto L (6 h), #2 auto S (0.5 h)
    expect(start.data.byHandHours).toBe(6.5);
    const tapped = worthReducer(start, { type: 'size', project: 'mobile-app', month: '2026-10', number: 1, size: 'M' })!;
    const mine = rowHtml(html(tapped), 1);
    expect(plain(mine)).toContain('yours · M');
    expect(plain(mine)).toContain('Back to Auto');
    expect(mine).toContain('class="szchip mine"');
    expect(tapped.data.byHandHours).toBe(2.5);
    const back = worthReducer(tapped, { type: 'size', project: 'mobile-app', month: '2026-10', number: 1, size: null })!;
    expect(plain(rowHtml(html(back), 1))).toContain('auto · L');
    expect(rowHtml(html(back), 1)).not.toContain('Back to Auto');
    expect(back).toEqual(start);
  });
});

describe('Edit Sizes holds the hours and the three cut points', () => {
  const typed = { hours: { S: '0.5', M: '2', L: '6', XL: '16' }, cuts: { S: '300', M: '1,500', L: '6,000' } };
  const form = (over: Partial<Parameters<typeof SizesForm>[0]> = {}) =>
    renderToStaticMarkup(createElement(SizesForm, { typed, saveDisabled: false, onTyped: () => {}, onSave: () => {}, onCancel: () => {}, ...over }));

  it('the four hours and the three cut points, labelled as the mock does, and XL starting where L ends', () => {
    const h = form();
    expect([...h.matchAll(/<span>([^<]*)<\/span><input/g)].map((m) => m[1])).toEqual([
      'S, in hours', 'M, in hours', 'L, in hours', 'XL, in hours', 'S is below (score)', 'M is below (score)', 'L is below (score)', 'XL is from',
    ]);
    expect(h).toContain('aria-label="Hours behind each size"');
    expect(h).toContain('aria-label="Where each size starts"');
    const xl = /<span>XL is from<\/span><input([^>]*)\/>/.exec(h)![1]!;
    expect(xl).toContain('disabled=""');
    expect(xl).toContain('value="6,000"'); // L's own text: XL starts where L ends
    expect([...h.matchAll(/value="([^"]*)"/g)].map((m) => m[1])).toEqual(['0.5', '2', '6', '16', '300', '1,500', '6,000', '6,000']);
    expect(plain(h)).toContain('Save Sizes');
  });

  it('a field that cannot be read is marked, the reason is said, and Save Sizes waits', () => {
    const bad = { ...typed, cuts: { ...typed.cuts, M: '100' } }; // below S
    const h = form({ typed: { ...bad, hours: { ...typed.hours, L: 'x' } }, problem: 'L: Give hours above 0 and at most 1,000, like 0.5 or 16', saveDisabled: true });
    expect(h).toContain('role="alert"');
    expect(plain(h)).toContain('L: Give hours above 0');
    expect(h).toMatch(/value="x"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*value="x"/);
    expect(h).toMatch(/<button type="submit" class="btn primary" disabled="">Save Sizes/);
  });

  it('typing a cut point hands the new text up, keeping the rest; Cancel and Escape stop the edit', () => {
    const onTyped = vi.fn();
    const onCancel = vi.fn();
    const tree = SizesForm({ typed, saveDisabled: false, onTyped, onSave: () => {}, onCancel });
    const inputs = find(tree, (el) => el.type === 'input' && !el.props.disabled);
    expect(inputs).toHaveLength(7);
    (inputs[5]!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '1,000' } });
    expect(onTyped).toHaveBeenCalledWith({ hours: typed.hours, cuts: { S: '300', M: '1,000', L: '6,000' } });
    (find(tree, (el) => el.type === 'button' && el.props.type === 'button')[0]!.props.onClick as () => void)();
    (find(tree, (el) => el.type === 'form')[0]!.props.onKeyDown as (e: { key: string }) => void)({ key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('moving a cut point moves the automatic rows, and only those', () => {
    const s = shown([row(1, 1200, 1), row(2, 1200, 1, { size: 'S', yours: true })]); // M today
    expect(plain(rowHtml(html(s), 1))).toContain('auto · M');
    const moved = worthReducer(s, { type: 'settings', settings: { ...SETTINGS, cuts: { S: 300, M: 1000, L: 6000 } } })!;
    expect(plain(rowHtml(html(moved), 1))).toContain('auto · L');
    expect(plain(rowHtml(html(moved), 2))).toContain('yours · S');
    expect(moved.data.byHandHours).toBe(6.5);
  });
});

describe('the size rows under the figures', () => {
  // The mock's rows, "S · 12 PRs | 6 h | 0.5 h each": one per size, for the PRs that are that size (a skip and a PR not sized yet are none), their hours, and the hours each is worth.
  const rows = (s: Shown) => {
    const h = renderToStaticMarkup(createElement(MonthCard, { data: s.data, title: 'October so far' }));
    return { h, rows: [...h.matchAll(/<div><span>([^<]*)<\/span><b>([^<]*)<\/b><span class="bar" aria-hidden="true"><i style="width:([^"]*)"><\/i><\/span><span>([^<]*)<\/span><\/div>/g)].map((m) => ({ label: m[1]!, hours: m[2]!, width: m[3]!, each: m[4]! })) };
  };
  const many = (n: number, lines: number, from: number) => Array.from({ length: n }, (_, i) => row(from + i, lines, 1)); // `lines` in one file: 100 is S, 400 M, 2000 L, 7000 XL
  const prs = [...many(12, 100, 100), ...many(5, 400, 200), ...many(3, 2000, 300), ...many(2, 7000, 400), row(500, 0, 0, { size: 'skip', yours: true }), row(501, null, null), row(502, 100, 1, { size: 'XL', yours: true })];
  const s = shown(prs);

  it('four rows, in the mock\'s words: the size and its PRs, its hours, a bar, and the hours each', () => {
    expect(rows(s).rows.map(({ label, hours, each }) => [label, hours, each])).toEqual([
      ['S · 12 PRs', '6 h', '0.5 h each'], ['M · 5 PRs', '10 h', '2 h each'], ['L · 3 PRs', '18 h', '6 h each'], ['XL · 3 PRs', '48 h', '16 h each'], // #502 is yours and XL
    ]);
  });

  it('the counts and the hours add up to the month\'s figures: the PRs sized, and the hours by hand', () => {
    const r = rows(s).rows;
    const hoursOf = (x: string) => Number(x.replace(' h', '').replace(',', ''));
    expect(r.reduce((t, x) => t + Number(/· (\d+) PR/.exec(x.label)![1]), 0)).toBe(23); // 25 PRs, less the skip and the one nothing was counted for
    expect(r.reduce((t, x) => t + hoursOf(x.hours), 0)).toBe(s.data.byHandHours);
    expect(s.data.byHandHours).toBe(6 + 10 + 18 + 48);
    expect(worthFigures(s.data)[0]).toMatchObject({ value: '82 h', usual: '23 PRs sized: 22 automatic, 1 yours. 1 skipped. 1 not sized yet.' }); // the first figure says the same
  });

  it('a bar is the row\'s hours against the largest, and a month with nothing sized has empty bars, not NaN', () => {
    expect(rows(s).rows.map((x) => x.width)).toEqual(['12.5%', '20.8%', '37.5%', '100%']);
    const none = rows(shown([row(1, null, null)]));
    expect(none.rows.map((x) => [x.label, x.hours, x.width])).toEqual([['S · 0 PRs', '0 h', '0%'], ['M · 0 PRs', '0 h', '0%'], ['L · 0 PRs', '0 h', '0%'], ['XL · 0 PRs', '0 h', '0%']]);
  });

  it('one PR is "1 PR", and the hours each follow the sizes the owner set', () => {
    const one = worthReducer(shown([row(1, 100, 1)]), { type: 'settings', settings: { ...SETTINGS, sizes: { S: 1.5, M: 2, L: 6, XL: 16 } } })!;
    expect(rows(one).rows[0]).toMatchObject({ label: 'S · 1 PR', hours: '1.5 h', each: '1.5 h each' });
  });
});

describe('the release merges left out, counted', () => {
  it('the explanation says how many the month left out, and for which month', () => {
    expect(plain(html(shown([row(1, 100, 1)])))).toContain('Release merges ( chore(release)… , chore: merge … , Merge … ) are left out: 7 in October.');
    const september = { ...shown([row(1, 100, 1)]), data: { ...data([row(1, 100, 1)]), month: '2026-09', releaseMerges: 0 } };
    expect(plain(html(september))).toContain('are left out: 0 in September.');
  });
});

describe('the reading and the six figures', () => {
  const s = shown([row(1, 2000, 1), row(2, 100, 1), row(3, 400, 1, { size: 'XL', yours: true })]);
  const d = { ...s.data, attentionHours: 4 };
  const figures = renderToStaticMarkup(createElement('div', null, ...worthFigures(d).map((f) => createElement(Figure, { key: f.label, ...f }))));

  it('the reading is a card above the figures, written from them', () => {
    const r = renderToStaticMarkup(createElement(Reading, { said: worthReading(derived(d), 'mobile-app', 'October so far') }));
    expect(plain(r)).toBe('October so far: the 3 PRs merged in mobile-app would have taken you about 23 hours by hand. You spent about 4 hours steering the agents, so they saved you about 19 hours, worth $1,670 at your $90 an hour. The plan cost $200. Written from the figures below; it changes with them.');
  });

  it('six figures, in one shape, the first saying how the PRs were sized', () => {
    const f = figs(figures);
    expect(f.map((x) => x.label)).toEqual(['Time it would have taken you', 'Time you spent steering', 'Hours saved', 'Value of those hours', 'What you paid', 'Return on your plan']);
    expect(f[0]!.usual).toBe('3 PRs sized: 2 automatic, 1 yours.');
    expect(f.every((x) => x.why.length > 40 && !x.open)).toBe(true);
  });
});

// worthReading reads the totals derive() makes, so a test hands it the derived month as the card has it
function derived(d: WorthData): WorthData {
  return worthReducer({ project: 'mobile-app', data: d }, { type: 'settings', settings: d.settings })!.data;
}
