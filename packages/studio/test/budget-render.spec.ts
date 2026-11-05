import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BudgetCard, budgetInput, CostCell, NeedsYou, PrSheet, type BudgetData, type FactoryPr, type IssueCost } from '../src/Factory.tsx';

// Issue cost against budget on the Factory page (v0.4 slice 2, #28; design/v0.4-factory.html, the cost cell and the Budget board): each PR row says what its issue cost, labelled an
// estimate, against its budget; the card under it sets a default per milestone and says what was spent on no issue; a PR's sheet sets the issue's own budget. Warnings never stop anything.
// The studio has no DOM library, so the pieces are rendered to markup.
const plain = (html: string) => html.replace(/<\/?b>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const NOW = Date.parse('2026-11-05T10:00:00Z');

const cost = (over: Partial<IssueCost> = {}): IssueCost => ({ number: 409, milestone: 'v0.4 Factory', usd: 118, partial: false, whole: 0, windows: 118, budget: 150, milestoneBudget: 150, source: 'milestone', mark: null, ...over });
const cell = (issue: number | null, c?: IssueCost) => renderToStaticMarkup(createElement(CostCell, { issue, cost: c }));

describe('the cost cell', () => {
  it('spent against a budget: the figure, a bar, and how far it is, labelled an estimate', () => {
    const h = cell(409, cost());
    expect(plain(h)).toBe('Cost, estimate $118.00 of $150.00 79% of the budget');
    expect(h).toContain('class="bar"');
    expect(h).toContain('style="width:79%"');
    expect(h).toContain('aria-label="79% of the budget"');
  });

  it('from 80% the bar is amber and says so in words; at the budget it is red and says nothing is stopped', () => {
    const near = cell(409, cost({ usd: 120, mark: 'at80' }));
    expect(near).toContain('class="bar warn"');
    expect(plain(near)).toBe('Cost, estimate $120.00 of $150.00 80% of the budget: nearly spent');
    const hit = cell(409, cost({ usd: 150, mark: 'at100' }));
    expect(hit).toContain('class="bar over"');
    expect(plain(hit)).toBe('Cost, estimate $150.00 of $150.00 100% of the budget: reached, nothing is stopped');
  });

  it('past the budget the figure says how far, and the bar stops at full', () => {
    const over = cell(409, cost({ usd: 180, mark: 'at100' }));
    expect(plain(over)).toContain('120% of the budget: reached');
    expect(over).toContain('style="width:100%"');
  });

  it('the warning is the server\'s mark, not the rounded percent: 79.6% reads 80% and is not yet a warning', () => {
    const h = cell(409, cost({ usd: 119.4, mark: null }));
    expect(plain(h)).toBe('Cost, estimate $119.40 of $150.00 80% of the budget');
    expect(h).toContain('class="bar"');
  });

  it('with no budget set there is the cost and "No budget set", no bar and no warning', () => {
    const h = cell(409, cost({ usd: 42, budget: null, source: null }));
    expect(plain(h)).toBe('Cost, estimate $42.00 No budget set');
    expect(h).not.toContain('class="bar');
  });

  it('a request with no price makes the figure a floor', () => {
    expect(plain(cell(409, cost({ usd: 42, partial: true })))).toContain('≥ $42.00 of $150.00');
  });

  it('nothing spent says so; a PR with no issue says that, since its cost is on no issue', () => {
    expect(plain(cell(409, cost({ usd: 0 })))).toBe('Cost, estimate Nothing spent');
    expect(plain(cell(409, undefined))).toBe('Cost, estimate Nothing spent'); // an issue the cost read does not list
    expect(plain(cell(null))).toBe('Cost, estimate No issue');
  });
});

const ALL_OK = { findings: { ok: true, note: 'none open' }, gate: { ok: true, note: 'passed' }, bots: { ok: true, note: 'none' }, clean: { ok: true, note: 'CLEAN' } };
const pr = (number: number, issue: number | null): FactoryPr => ({ number, head: `feat/${number}`, issue, headOid: 'a1b2c3d'.padEnd(40, '3'), ready: true, reason: null, dropped: 0, conditions: ALL_OK, findings: [] });
const needs = (prs: FactoryPr[], costs?: Map<number, IssueCost>) => renderToStaticMarkup(createElement(NeedsYou, { prs, costs, onOpen: () => {} }));
const rows = (html: string) => html.split('<div class="need">').slice(1).map(plain);

describe('Needs you, with the cost of each PR\'s issue', () => {
  it('each row carries its issue\'s cost cell; a PR with no issue says so', () => {
    const r = rows(needs([pr(416, 409), pr(420, null)], new Map([[409, cost()]])));
    expect(r[0]).toBe('Ready PR #416 feat/416 Ready for your ok Cost, estimate $118.00 of $150.00 79% of the budget a1b2c3d See checks');
    expect(r[1]).toBe('Ready PR #420 feat/420 Ready for your ok Cost, estimate No issue a1b2c3d See checks');
  });

  it('until the cost has been read the rows show no cost cell, rather than a "nothing spent" that is not known', () => {
    expect(needs([pr(416, 409)])).not.toContain('Cost, estimate');
  });
});

const data = (over: Partial<BudgetData> = {}): BudgetData => ({
  project: 'mobile-app', month: '2026-11', issues: [], notOnIssue: { usd: 15, partial: false }, milestones: [{ name: 'v0.4 Factory', budget: null }], ...over,
});
const card = (d: BudgetData) => renderToStaticMarkup(createElement(BudgetCard, { data: d, onSave: async () => undefined }));

describe('the budget card', () => {
  it('with a default set: its field holds it, and the issues with their own budget are named', () => {
    const h = card(data({ milestones: [{ name: 'v0.4 Factory', budget: 150 }], issues: [cost({ number: 409, budget: 4, source: 'issue' }), cost({ number: 412 })] }));
    expect(h).toContain('aria-label="Default for v0.4 Factory"');
    expect(h).toContain('value="150"');
    expect(plain(h)).toContain('One issue has its own budget: #409, $4.00. Set it on the PR\'s sheet.');
    expect(plain(h)).not.toContain('No budget is set');
  });

  it('with none set: the field is empty, and the card says nothing warns', () => {
    const h = card(data());
    expect(h).toContain('aria-label="Default for v0.4 Factory"');
    expect(h).toContain('placeholder="None"');
    expect(h).not.toMatch(/value="\d/);
    expect(plain(h)).toContain('No budget is set, so rows show cost only and nothing warns.');
  });

  it('with no milestone to set a default on, it says where a budget can still be set', () => {
    expect(plain(card(data({ milestones: [] })))).toContain('No open issue has a milestone, so there is no default to set. An issue\'s own budget is on its PR\'s sheet.');
  });

  it('says what was spent on no issue this month, and what that is', () => {
    expect(plain(card(data()))).toContain('Not on an issue: $15.00 this month');
    expect(plain(card(data()))).toContain('Sessions with no PR, and turns after a session\'s last PR. Cost is an estimate by time windows.');
    expect(plain(card(data({ notOnIssue: { usd: 15, partial: true } })))).toContain('Not on an issue: ≥ $15.00 this month');
  });

  it('says it warns at 80% and 100% and never stops anything', () => {
    expect(plain(card(data()))).toContain('warns at 80% and 100%, never stops anything');
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
