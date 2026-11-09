import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenReport } from '../src/Analysis.tsx';
import { History } from '../src/History.tsx';
import { OrgChart, RolePanel } from '../src/Pipeline.tsx';

// Three panels the screens open, rendered to markup (#16): the Pipeline's org chart and role panel, an open analysis report, an agent's history header and tabs. Invented project; no DOM library.
const NOW = 1_800_000_000_000;
const read = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const row = (o: object): any => ({ id: 'a1', type: 'reviewer', role: 'reviewer', role_source: 'declared', description: null, model: 'claude-sonnet-5-5', session: 'abcdef123', tokens: 2_500, started_at: NOW - 90_000, ended_at: NOW - 30_000, ...o });
const role = (o: object): any => ({ role: 'reviewer', info: 'Checks the change.', typeInfo: { reviewer: 'Reads a diff.' }, agents: 1, types: ['reviewer'], tokens: 2_500, cost: 0.42, costPartial: false, avgMs: 60_000, agentList: [row({})], ...o });
const CATALOG = [{ role: 'developer', info: 'Writes the change.' }, { role: 'reviewer', info: 'Checks the change.' }];

let error: ReturnType<typeof vi.spyOn>, warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  expect(error).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('the Pipeline org chart and role panel', () => {
  const data: any = {
    roles: [role({ role: 'orchestrator', types: ['main'], agents: 1, tokens: 90_000, cost: 5, avgMs: null, info: null }), role({}), role({ role: 'unassigned', types: ['helper'], agents: 3, costPartial: true, cost: 0.1, info: null })],
    edges: [{ from: 'orchestrator', to: 'reviewer', count: 2, tokens: 2_500 }, { from: 'orchestrator', to: 'unassigned', count: 1, tokens: 800 }],
    roleCatalog: CATALOG,
  };
  const chart = (picked?: string) => renderToStaticMarkup(createElement(OrgChart, { data, picked, onPick: () => {} }));

  it('draws a node per role with its agents, tokens, cost and average time', () => {
    const nodes = [...chart().matchAll(/<button type="button" class="node[^"]*".*?<\/button>/gs)].map((m) => read(m[0]));
    expect(nodes).toEqual([
      'O orchestrator main 1 agent · 90.0k tok $5.00',
      'R reviewer reviewer 1 agent · 2.5k tok $0.42 · avg 1m 0s',
      '? no role helper 3 agents · 2.5k tok ≥ $0.10 · avg 1m 0s',
    ]);
  });

  it('the unassigned role is dashed and called "no role"; the picked one is pressed', () => {
    const html = chart('reviewer');
    expect(html).toContain('class="node unassigned"');
    expect(html).toContain('class="edge dash"');
    expect(html.match(/<path class="edge"/g)).toHaveLength(1);
    expect([...html.matchAll(/aria-pressed="(true|false)"/g)].map((m) => m[1])).toEqual(['false', 'true', 'false']);
    expect([...html.matchAll(/<text class="elabel"[^>]*>(.*?)<\/text>/g)].map((m) => m[1])).toEqual(['2.5k', '800']);
  });

  it('the role panel says what the role is, lists its agents and offers the fix per agent type', () => {
    const html = renderToStaticMarkup(createElement(RolePanel, { role: role({}), catalog: CATALOG, project: 'garden-app', onFix: async () => {}, onClose: () => {} }));
    const text = read(html);
    expect(text).toContain('reviewer · reviewer 1 agent · 2.5k tok · $0.42');
    expect(text).toContain('Checks the change.');
    expect(text).toContain('reviewer · Sonnet 5.5 declared session abcdef · 2.5k tok · 1m 0s');
    expect(text).toContain('reviewer : Reads a diff.');
    expect(text).toContain('For every reviewer agent in garden-app, now and later');
    expect(html).toContain('<option value="reviewer" title="Checks the change." selected="">reviewer</option>');
    expect(text).not.toMatch(/Show \d+ more/);
  });

  it('a role with more than five agents shows the newest five and a button for the rest; an unassigned one is flagged to fix', () => {
    const many = Array.from({ length: 7 }, (_, i) => row({ id: `a${i}`, started_at: NOW - i * 1000, description: `job ${i}` }));
    const html = renderToStaticMarkup(createElement(RolePanel, { role: role({ role: 'unassigned', agentList: many, agents: 7, info: null }), catalog: CATALOG, project: 'garden-app', onFix: async () => {}, onClose: () => {} }));
    expect(html.match(/<li>/g)).toHaveLength(5);
    expect(html).toContain('“job 0”');
    expect(html).not.toContain('“job 6”');
    expect(read(html)).toContain('Show 2 more');
    expect(read(html)).toContain('No role yet: nothing declares or maps one for these agent types.');
    expect(html).toContain('class="fix warn"');
    expect(html).toContain('<option value="developer" title="Writes the change." selected="">developer</option>');
  });
});

describe('an open analysis report', () => {
  const report = {
    summary: 'The same lint step failed three times.',
    sections: [{ title: 'Repeated failure', body: 'Lint ran before the build.', evidence: ['session abc · 3×', 'session def · 1×'] }, { title: 'Slow review', body: 'Reviews took long.', evidence: [] }],
    changes: [{ title: 'Run the build first', why: 'The lint needs its output.', saving: '~12k tok' }],
  };

  it('shows the summary, each section with its evidence, and the changes to try', () => {
    const html = renderToStaticMarkup(createElement(OpenReport, { report }));
    const text = read(html);
    expect(text).toContain('The same lint step failed three times. Repeated failure Lint ran before the build. session abc · 3× session def · 1× Slow review Reviews took long. Changes to try Run the build first ~12k tok The lint needs its output.');
    expect([...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1])).toEqual(['Repeated failure', 'Slow review', 'Changes to try']);
    expect(html.match(/<div class="ev">/g)).toHaveLength(1); // a section with no evidence draws no box
  });

  it('a run that returned nothing says it was billed anyway', () => {
    const text = read(renderToStaticMarkup(createElement(OpenReport, { report: null })));
    expect(text).toBe('This run returned no report (Claude declined, or the answer could not be read). It was billed, so it counts against the cap.');
  });
});

describe("an agent's history header and tabs", () => {
  const live: any = { type: 'reviewer', role: 'reviewer', model: 'claude-sonnet-5-5', tokens: 12_000, cost: 0.75, state: 'working', startedAt: NOW - 125_000, lastTs: NOW, calls: 1, failed: 0, tasks: [] };
  const render = (o: object) => renderToStaticMarkup(createElement(History, { picked: { session: 'abcdef123', agent: 'a1' }, project: 'garden-app', now: NOW, onClose: () => {}, ...o }));

  it('a live agent: its name, state, role, model, project and figures', () => {
    const html = render({ live });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('<h3 id="d-name">reviewer</h3>');
    expect(html).toContain('<span class="state working">working</span>');
    expect(read(html.match(/<div class="dfacts">.*?<\/div>/s)![0])).toMatch(/^reviewer Sonnet 5\.5 garden-app started \d\d:\d\d:\d\d 2m 5s 1 tool call 0 failed 12\.0k tok \$0\.75$/);
  });

  it('the state shows the label the screen gave it, and one tool call is singular', () => {
    const html = render({ live: { ...live, calls: 4, failed: 1 }, label: 'waiting for you' });
    expect(html).toContain('<span class="state working">waiting for you</span>');
    expect(read(html)).toContain('4 tool calls 1 failed');
  });

  it('with no live row it falls back to the session id, and the tabs count nothing yet', () => {
    const html = render({});
    expect(html).toContain('<h3 id="d-name">a1</h3>');
    expect(read(html)).toContain('session abcdef');
    expect([...html.matchAll(/role="tab" aria-selected="(true|false)"[^>]*>(.*?)<\/button>/g)].map((m) => [m[1], read(m[2]!)])).toEqual([['true', 'What it did 0'], ['false', 'Failed 0']]);
  });

  it('an agent with tasks gets a third tab counting the done ones', () => {
    const tasks = [{ id: '1', subject: 'Read the diff', status: 'completed' }, { id: '2', subject: 'Write findings', status: 'in_progress' }];
    const html = render({ live: { ...live, tasks } });
    expect([...html.matchAll(/role="tab" aria-selected="(true|false)"[^>]*>(.*?)<\/button>/g)].map((m) => [m[1], read(m[2]!)])).toEqual([['true', 'What it did 0'], ['false', 'Failed 0'], ['false', 'Tasks 1/2']]);
  });
});
