import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Analysis } from '../src/Analysis.tsx';
import { PageHeader, ProjectContext, type Projects } from '../src/kit.tsx';
import { Chart, Ledger } from '../src/Ledger.tsx';
import { Pipeline } from '../src/Pipeline.tsx';
import { choiceQuery, choose, FIRST, readChoice, shown, type Choice } from '../src/project-choice.ts';

// One header on every page with views (#101, design/v0.3-readable.html, the Header board). The views are rendered to markup, which runs no effects: the header is drawn
// before anything loads, which is what has to hold still.
const PROJECTS = ['mobile-app', 'docs-site', 'field-notes'];
const page = (el: ReturnType<typeof createElement>, choice: Choice = FIRST) => {
  const value: Projects = { projects: PROJECTS, choice, pick: () => {} };
  return renderToStaticMarkup(createElement(ProjectContext.Provider, { value }, el));
};
const mainsOf = (html: string) => html.split('<main ').slice(1).map((m) => `<main ${m}`);
/** The header's slots in the order they sit in the markup. */
const slots = (html: string) => {
  const head = html.slice(html.indexOf('class="pagehead"'), html.indexOf('class="ph-period"') + 20);
  return [...head.matchAll(/<h1>|class="sub[ "]|class="ph-(views|project|period)"/g)].map((m) => (m[0] === '<h1>' ? 'title' : m[0].startsWith('class="sub') ? 'sub' : m[1]));
};
const options = (main: string, label: string) => {
  const select = new RegExp(`<select aria-label="${label}"[^>]*>(.*?)</select>`, 's').exec(main)?.[1] ?? '';
  return [...select.matchAll(/<option value="([^"]*)"( selected="")?>/g)].map((m) => [m[1], !!m[2]]);
};

describe('the header is one shape on every view', () => {
  const ledger = mainsOf(page(createElement(Ledger)));
  const reports = mainsOf(page(createElement(Analysis, { initial: 'reports' })));
  const pipeline = mainsOf(page(createElement(Pipeline, { now: 0 })));

  it('Totals, Trends, Worth, Patterns, Reports and the Pipeline render the same slots in the same order: title, sub, views, project, period', () => {
    const all = [...ledger, ...reports, ...pipeline];
    expect(all).toHaveLength(6);
    for (const main of all) expect(slots(main)).toEqual(['title', 'sub', 'views', 'project', 'period']);
  });

  it('the switch names its page, and sits in the same slot as the pickers do: the page title comes from the page, the views from the switch', () => {
    expect(ledger.map((m) => /<h1>(.*?)<\/h1>/.exec(m)![1])).toEqual(['Ledger', 'Ledger', 'Ledger']);
    expect(reports.map((m) => /<h1>(.*?)<\/h1>/.exec(m)![1])).toEqual(['Analysis', 'Analysis']);
    expect(pipeline.map((m) => /<h1>(.*?)<\/h1>/.exec(m)![1])).toEqual(['Pipeline']);
    for (const [main, view] of [[ledger[0], 'Ledger view'], [reports[0], 'Analysis view'], [pipeline[0], 'Pipeline view']] as const) expect(main).toContain(`aria-label="${view}"`);
  });

  it('every sub-line says what its view answers, in one line, and none carries a project or a period (those are the pickers)', () => {
    const subs = [...ledger, ...reports, ...pipeline].map((m) => /<div class="sub line" title="[^"]*">(.*?)<\/div>/.exec(m)![1]);
    expect(subs).toEqual([
      'What your agents used, and what it would cost', 'What a day costs, and what each change did to it', 'What the agents saved you, and what you paid',
      'What keeps failing, and the rule to stop it', 'Claude reads a week and suggests what to change', 'Who delegates to whom, and what each role costs',
    ]);
  });

  it('the period slot holds a picker (or Worth\'s month, stepped) with the same label on every view', () => {
    for (const main of [...ledger, ...reports, ...pipeline]) expect(main).toMatch(/aria-label="Period"/);
    expect(options(ledger[0]!, 'Period').map((o) => o[0])).toEqual(['today', '7d', '30d']);
    expect(options(ledger[1]!, 'Period').map((o) => o[0])).toEqual(['week', 'day']);
    expect(options(reports[0]!, 'Period')).toEqual([['all', true]]); // Patterns: the whole history, nothing to choose
    expect(options(reports[1]!, 'Period').map((o) => o[0])).toEqual(['7d', '30d', 'session']);
    expect(options(pipeline[0]!, 'Period').map((o) => o[0])).toEqual(['week', 'day', 'session']);
  });

  it('Totals\' Day, Week and Month are in the chart\'s own card, not in the header', () => {
    expect(ledger[0]).not.toMatch(/>Day<|>Week<|>Month</);
    const series = [{ bucket: '2026-10-26', tokens: 4.9e6, cost: 1.34, byModel: { 'claude-opus-5-5': 4.9e6 } }];
    const chart = renderToStaticMarkup(createElement(Chart, { series, unit: 'week', onUnit: () => {}, total: { tokens: 4.9e6, cost: 1.34, costPartial: false } }));
    expect(chart).toMatch(/<div class="chead"><h2>Tokens per week, by model.*<\/h2><span class="seg" role="group" aria-label="Group by"><button type="button" aria-pressed="false">Day<\/button><button type="button" aria-pressed="true">Week<\/button><button type="button" aria-pressed="false">Month<\/button>/);
  });

  it('Reports\' project and period are in the header; the New analysis card keeps the model', () => {
    const [patterns, analysis] = reports;
    const card = /<section class="card" aria-label="New analysis">.*?<\/section>/s.exec(analysis!)![0];
    expect(card).toContain('<label>Model');
    expect(card).not.toMatch(/<label>Project|<label>Period|aria-label="Project"|aria-label="Period"/);
    expect(slots(analysis!)).toEqual(slots(patterns!));
  });

  it('a page with no views has the title and its line and no second row; one with views always has all three slots, even with nothing in them', () => {
    expect(renderToStaticMarkup(createElement(PageHeader, { title: 'Live', sub: 'x' }))).not.toContain('ph-2');
    expect(slots(renderToStaticMarkup(createElement(PageHeader, { title: 'Ledger', sub: 'x', views: createElement('i') })))).toEqual(['title', 'sub', 'views', 'project', 'period']);
  });
});

describe('one project picker per page, the choice carried across views', () => {
  const ledger = (choice: Choice) => mainsOf(page(createElement(Ledger), choice));
  const reports = (choice: Choice) => mainsOf(page(createElement(Analysis, { initial: 'reports' }), choice));

  it('a view needing one project never offers "All projects"; Totals does', () => {
    const [totals, trends, worth] = ledger(FIRST);
    expect(options(totals!, 'Project')).toEqual([['', true], ['mobile-app', false], ['docs-site', false], ['field-notes', false]]);
    for (const main of [trends!, worth!, ...reports(FIRST), ...mainsOf(page(createElement(Pipeline, { now: 0 })))]) {
      expect(main).not.toContain('All projects');
      expect(options(main, 'Project').map((o) => o[0])).toEqual(PROJECTS);
    }
  });

  it('with "All projects" chosen, a view needing one shows the first project, and Totals still shows All', () => {
    const [totals, trends] = ledger(FIRST);
    expect(options(trends!, 'Project')[0]).toEqual(['mobile-app', true]);
    expect(options(totals!, 'Project')[0]).toEqual(['', true]);
  });

  it('a project picked once is the one every view shows: Totals, Trends, Worth, Patterns and Reports read the same pick', () => {
    const picked: Choice = { all: false, single: 'docs-site' };
    for (const main of [...ledger(picked), ...reports(picked)]) {
      expect(options(main, 'Project').find((o) => o[1])?.[0]).toBe('docs-site');
    }
  });

  it('Totals -> Trends -> Totals brings "All projects" back; a project picked on the way is kept instead', () => {
    let c = FIRST;
    expect(shown(c, false, PROJECTS)).toBe(''); // Totals
    expect(shown(c, true, PROJECTS)).toBe('mobile-app'); // Trends: no All, the first project
    expect(shown(c, false, PROJECTS)).toBe(''); // Totals again
    c = choose(c, 'field-notes'); // a pick on Trends
    expect(shown(c, true, PROJECTS)).toBe('field-notes');
    expect(shown(c, false, PROJECTS)).toBe('field-notes'); // it is the choice now, on Totals too
    c = choose(c, ''); // All, on Totals
    expect(shown(c, false, PROJECTS)).toBe('');
    expect(shown(c, true, PROJECTS)).toBe('field-notes'); // and the last single project is still there for Trends
  });

  it('a project the list does not hold gives way to the first one, once the list has loaded', () => {
    expect(shown({ all: false, single: 'gone' }, true, PROJECTS)).toBe('mobile-app');
    expect(shown({ all: false, single: 'gone' }, true, undefined)).toBe('gone'); // not loaded yet: the URL's project is trusted
    expect(shown(FIRST, true, [])).toBe(''); // no project at all
  });
});

describe('the choice in the URL hash', () => {
  it('survives a reload: what choiceQuery writes, readChoice reads back', () => {
    for (const c of [FIRST, { all: false, single: 'docs-site' }, { all: true, single: 'docs-site' }, { all: false, single: 'a b&c=d?e' }]) {
      expect(readChoice(`#/ledger${choiceQuery(c)}`)).toEqual(c);
    }
  });

  it('the first choice leaves the route plain; a hash with no query, or none at all, is that first choice', () => {
    expect(choiceQuery(FIRST)).toBe('');
    expect(readChoice('#/ledger')).toEqual(FIRST);
    expect(readChoice('')).toEqual(FIRST);
    expect(choiceQuery({ all: false, single: 'docs-site' })).toBe('?project=docs-site');
    expect(choiceQuery({ all: true, single: 'docs-site' })).toBe('?project=docs-site&all=1');
  });
});
