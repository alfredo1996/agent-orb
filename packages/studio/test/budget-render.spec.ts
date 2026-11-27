import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BudgetCard, BudgetLine, budgetInput, costFig, PrSheet, type BudgetData, type FactoryPr, type IssueCost } from '../src/Factory.tsx';

// Issue cost against budget on the Factory page (v0.4 slice 2, #28; design/v0.4-factory.html, the cost cell and the Budget board): each PR row says what its issue cost, labelled an
// estimate, against its budget; the card under it sets a default per milestone and says what was spent on no issue; a PR's sheet sets the issue's own budget. Warnings never stop anything.
// The studio has no DOM library, so the pieces are rendered to markup.
const plain = (html: string) => html.replace(/<\/?b>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const NOW = Date.parse('2026-11-05T10:00:00Z');

const cost = (over: Partial<IssueCost> = {}): IssueCost => ({ number: 409, milestone: 'v0.4 Factory', usd: 118, partial: false, whole: 0, windows: 118, budget: 150, milestoneBudget: 150, source: 'milestone', mark: null, ...over });

describe('the board\'s cost figure', () => {
  const fig = (c?: IssueCost) => renderToStaticMarkup(createElement('div', null, costFig(c)));

  it('spent against a budget: the figure, "of $budget" and a meter, labelled an estimate', () => {
    const h = fig(cost());
    expect(plain(h)).toBe('Cost, estimate $118.00 of $150.00');
    expect(h).toContain('class="bar"');
    expect(h).toContain('style="width:79%"');
    expect(h).toContain('aria-label="79% of the budget"');
  });

  it('from 80% the meter is amber, at the budget it is red, and past it the meter stops at full', () => {
    expect(fig(cost({ usd: 120, mark: 'at80' }))).toContain('class="bar warn"');
    expect(fig(cost({ usd: 150, mark: 'at100' }))).toContain('class="bar over"');
    const over = fig(cost({ usd: 180, mark: 'at100' }));
    expect(over).toContain('aria-label="120% of the budget"');
    expect(over).toContain('style="width:100%"');
  });

  it('the warning is the server\'s mark, not the rounded percent: 79.6% reads 80% and is not yet a warning', () => {
    const h = fig(cost({ usd: 119.4, mark: null }));
    expect(h).toContain('aria-label="80% of the budget"');
    expect(h).toContain('class="bar"');
  });

  it('with no budget set there is the cost alone: no meter, and no "No budget set"', () => {
    const h = fig(cost({ usd: 42, budget: null, source: null }));
    expect(plain(h)).toBe('Cost, estimate $42.00');
    expect(h).not.toContain('class="bar');
  });

  it('a request with no price makes the figure a floor', () => {
    expect(plain(fig(cost({ usd: 42, partial: true })))).toContain('≥ $42.00 of $150.00');
    expect(plain(fig(cost({ usd: 0, partial: true })))).toContain('≥ $0.00');
  });

  it('nothing spent is nothing at all, and so is an issue the cost read does not list', () => {
    expect(costFig(cost({ usd: 0 }))).toBeNull();
    expect(costFig(undefined)).toBeNull();
  });
});

const ALL_OK = { findings: { ok: true, note: 'none open' }, gate: { ok: true, note: 'passed' }, bots: { ok: true, note: 'none' }, clean: { ok: true, note: 'CLEAN' } };
const pr = (number: number, issue: number | null): FactoryPr => ({ number, head: `feat/${number}`, issue, headOid: 'a1b2c3d'.padEnd(40, '3'), ready: true, reason: null, dropped: 0, conditions: ALL_OK, findings: [] });
const data = (over: Partial<BudgetData> = {}): BudgetData => ({
  project: 'mobile-app', month: '2026-11', issues: [], notOnIssue: { usd: 15, partial: false }, milestones: [{ name: 'v0.4 Factory', budget: null }], ...over,
});
const card = (d: BudgetData) => renderToStaticMarkup(createElement(BudgetCard, { data: d, shown: d.milestones[0]?.name ?? null, onSave: async () => undefined }));

describe('the budget card', () => {
  it('the milestone shown has one line: its default, or None, and a button; the field is not drawn until the button opens it', () => {
    const h = card(data({ milestones: [{ name: 'v0.4 Factory', budget: 150 }] }));
    expect(plain(h)).toContain('Default for v0.4 Factory $150.00 Change');
    expect(h).toContain('<button type="button" class="btn sm" aria-expanded="false"');
    expect(h).not.toContain('<input');
    const none = plain(card(data()));
    expect(none).toContain('Default for v0.4 Factory None Set');
  });

  it('Change reveals today\'s field in place, holding the value, and saving goes through the card\'s save', () => {
    const h = renderToStaticMarkup(createElement(BudgetLine, { label: 'Default for v0.4 Factory', value: 150, defaultOpen: true, onSave: async () => undefined }));
    expect(h).toContain('aria-expanded="true"');
    expect(h).toContain('aria-label="Default for v0.4 Factory"');
    expect(h).toContain('value="150"');
    expect(h).toContain('>Save</button>');
  });

  it('under it, one note: who is over their budget, else that nothing warns, else nothing', () => {
    const over = plain(card(data({ milestones: [{ name: 'v0.4 Factory', budget: 80 }], issues: [cost({ number: 407, usd: 96, budget: 80, mark: 'at100' }), cost({ number: 412, usd: 38, budget: 80 })] })));
    expect(over).toContain('#407 is over it, at $96.00 of $80.00.');
    expect(over).not.toContain('#412 is over');
    expect(over).not.toContain('No budget is set');
    expect(plain(card(data()))).toContain('No budget is set, so rows show cost only and nothing warns.');
    const quiet = plain(card(data({ milestones: [{ name: 'v0.4 Factory', budget: 150 }], issues: [cost()] })));
    expect(quiet).not.toContain('No budget is set');
    expect(quiet).not.toContain('is over it');
  });

  it('the other milestones are folded with a line each; an issue\'s own budget is named there', () => {
    const h = card(data({ milestones: [{ name: 'v0.4 Factory', budget: 150 }, { name: 'v0.5 Follow', budget: 200 }, { name: 'v0.6 Explain', budget: null }], issues: [cost({ number: 409, budget: 4, source: 'issue' })] }));
    const [open, folded] = h.split('<details class="fx-more">') as [string, string];
    expect(open).not.toContain('v0.5 Follow');
    expect(folded).toContain('<summary>Other milestones · 2</summary>');
    expect(plain(folded)).toContain('Default for v0.5 Follow $200.00 Change Default for v0.6 Explain None Set');
    expect(plain(folded)).toContain('One issue has its own budget: #409, $4.00. Set it on the issue\'s page.');
  });

  it('with no milestone shown, every milestone goes under the fold', () => {
    const h = renderToStaticMarkup(createElement(BudgetCard, { data: data({ milestones: [{ name: 'v0.4 Factory', budget: 150 }, { name: 'v0.5 Follow', budget: null }] }), shown: null, onSave: async () => undefined }));
    const [open, folded] = h.split('<details class="fx-more">') as [string, string];
    expect(open).not.toContain('Default for');
    expect(plain(folded)).toContain('Other milestones · 2 Default for v0.4 Factory $150.00 Change Default for v0.5 Follow None Set');
  });

  it('with no milestone to set a default on, it says where a budget can still be set', () => {
    expect(plain(card(data({ milestones: [] })))).toContain('No open issue has a milestone, so there is no default to set. An issue\'s own budget is on its page.');
  });

  it('leaves what was spent on no issue to the board (#32), which shows it in its foot', () => {
    expect(plain(card(data()))).not.toContain('Not on an issue');
  });

  it('says it warns at 80% and 100%', () => {
    expect(plain(card(data()))).toContain('warns at 80% and 100%');
  });
});

const sheet = (p: FactoryPr, c?: IssueCost, budget = true) => renderToStaticMarkup(createElement(PrSheet, { pr: p, readAt: NOW, now: NOW, sheet: false, onClose: () => {}, ...(budget ? { cost: c, onSave: async () => undefined } : {}) }));

describe('the PR sheet\'s cost section', () => {
  it('splits what the issue cost into the sessions on its branch and the turns before a PR opened, and holds the issue\'s own budget', () => {
    const h = sheet(pr(416, 409), cost({ usd: 10, whole: 7, windows: 3, budget: 4, source: 'issue' }));
    const t = plain(h);
    expect(t).toContain("Cost, estimate On the issue's branch, whole $7.00 Turns before a PR opened, in a longer session $3.00");
    expect(h).toContain('aria-label="Budget for this issue"');
    expect(h).toContain('value="4"');
  });

  it('with only the milestone\'s default, the field is empty and the default is its placeholder and its note', () => {
    const h = sheet(pr(416, 409), cost());
    expect(h).toContain('aria-label="Budget for this issue"');
    expect(h).not.toMatch(/aria-label="Budget for this issue"[^>]*value="\d/);
    expect(h).toContain('placeholder="150"');
    expect(plain(h)).toContain('Milestone default: $150.00');
  });

  it('with the issue\'s own budget set, the milestone\'s default is still named: it is what removing the budget gives back', () => {
    const h = sheet(pr(416, 409), cost({ budget: 4, source: 'issue' }));
    expect(h).toContain('value="4"');
    expect(h).toContain('placeholder="150"');
    expect(plain(h)).toContain('Milestone default: $150.00');
  });

  it('with no budget anywhere: "None", and no milestone default to name', () => {
    const h = sheet(pr(416, 409), cost({ budget: null, source: null, milestone: null, milestoneBudget: null }));
    expect(h).toContain('placeholder="None"');
    expect(plain(h)).toContain('No milestone default');
  });

  it('a floor says so; an issue with nothing spent says that', () => {
    expect(plain(sheet(pr(416, 409), cost({ partial: true })))).toContain('a request on a model with no price adds nothing');
    expect(plain(sheet(pr(416, 409), cost({ usd: 0, whole: 0, windows: 0 })))).toContain('Nothing spent yet');
  });

  it('a PR with no issue has no budget to set, and says where its cost went', () => {
    const h = sheet(pr(420, null), undefined);
    expect(plain(h)).toContain('This PR closes no issue, so its cost is on "not on an issue".');
    expect(h).not.toContain('Budget for this issue');
  });

  it('with no cost read at all the sheet has no cost section: the existing sheet is as it was', () => {
    expect(plain(sheet(pr(416, 409), undefined, false))).not.toContain('Cost, estimate');
  });
});

describe('what is typed in a budget field', () => {
  it('a number of dollars above 0 is a budget; nothing is "remove it"', () => {
    expect(budgetInput('150')).toEqual({ usd: 150 });
    expect(budgetInput(' 12.5 ')).toEqual({ usd: 12.5 });
    expect(budgetInput('1000000')).toEqual({ usd: 1_000_000 });
    expect(budgetInput('')).toEqual({ usd: null });
    expect(budgetInput('   ')).toEqual({ usd: null });
  });

  it('anything else says what is wrong, as the server would refuse it', () => {
    for (const text of ['0', '-5', 'abc', '12 dollars', 'Infinity']) expect(budgetInput(text)).toEqual({ error: 'Give a number of dollars above 0, or leave it empty to remove the budget' });
    expect(budgetInput('1000001')).toEqual({ error: 'A budget is at most $1,000,000' });
  });
});
