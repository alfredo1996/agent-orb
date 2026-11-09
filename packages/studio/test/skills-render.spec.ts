import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Panel, Skills, SkillsView, type Data } from '../src/Skills.tsx';

// The Pipeline's Skills scope, rendered to markup (#16): the graph, the phone list, the usage table, the idle list. Invented skills; no DOM library.
const NOW = new Date(2026, 10, 9, 12).getTime();
const read = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const node = (o: object): any => ({ kind: 'skill', clash: false, ran: true, runs: 0, spawns: 0, tokens: 0, cost: 0, costPartial: false, byYou: 0, byMain: 0, ...o });
const DATA: Data = {
  nodes: [
    node({ id: 'plan', name: 'plan', source: 'projectSettings', description: 'Plan a change', runs: 4, tokens: 120_000, cost: 1.25, listed: 80, byYou: 3, byMain: 1 }),
    node({ id: 'ship', name: 'ship', source: 'plugin', runs: 2, tokens: 30_000, cost: 0.4 }),
    node({ id: 'agent:builder', kind: 'agent', name: 'builder', ran: true, spawns: 2, tokens: 45_000, cost: 0.6 }),
    node({ id: 'agent:ghost', kind: 'agent', name: 'ghost', ran: false }),
  ],
  edges: [
    { from: 'plan', to: 'ship', did: 2, named: true, preload: false, tokens: 30_000 },
    { from: 'plan', to: 'agent:builder', did: 2, named: false, preload: false, tokens: 45_000 },
    { from: 'plan', to: 'agent:ghost', did: 0, named: true, preload: false, tokens: 0 },
  ],
  usage: [
    { id: 'plan', name: 'plan', source: 'projectSettings', runs: 4, how: { you: 3, model: 1, agent: 0, preload: 0 }, tokens: 120_000, cost: 1.25, costPartial: false, last: NOW - 2 * 3_600_000, loads: [NOW - 1000, NOW - 2000, NOW - 86_400_000 - 5000] },
    { id: 'ship', name: 'ship', source: 'plugin', runs: 2, how: { you: 0, model: 0, agent: 2, preload: 0 }, tokens: 30_000, cost: 0.4, costPartial: false, last: NOW - 3 * 86_400_000, loads: [NOW - 3 * 86_400_000] },
  ],
  idle: [{ name: 'tidy', source: 'userSettings', tokens: 60, clash: false }, { name: 'plan', source: 'plugin', tokens: 40, clash: true }],
};
const render = (data: Data) => renderToStaticMarkup(createElement(SkillsView, { data, now: NOW }));

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

describe('the Skills scope', () => {
  it('draws a node per skill and agent, ran ones first, a never-spawned agent as a ghost', () => {
    const html = render(DATA);
    expect(html).toContain('aria-label="What calls what"');
    const nodes = [...html.matchAll(/<button type="button" class="sknode ([^"]*)"[^>]*>.*?<b>(.*?)<\/b>.*?<small>(.*?)<\/small>/g)].map((m) => [m[1], m[2], m[3]]);
    expect(nodes).toEqual([
      ['skill', '/plan', 'project skill · ran 4× · 120k'],
      ['agent', 'builder', 'spawned 2× · 45.0k'],
      ['skill', '/ship', 'plugin skill · ran 2× · 30.0k'],
      ['agent ghost', 'ghost', 'named, never spawned'],
    ]);
  });

  it('an edge that was called shows its count; one only named is dashed and has none', () => {
    const html = render(DATA);
    expect(html.match(/<path class="e"/g)).toHaveLength(2);
    expect(html.match(/<path class="e named"/g)).toHaveLength(1);
    expect([...html.matchAll(/<text class="el"[^>]*>(\d+×)<\/text>/g)].map((m) => m[1])).toEqual(['2×', '2×']);
  });

  it('the phone list says what each one called, and what it only named', () => {
    const list = render(DATA).match(/<div class="rolelist sklist".*?<\/div>/s)![0];
    expect([...list.matchAll(/<button .*?<\/button>/gs)].map((m) => read(m[0]))).toEqual([
      '/plan project skill · ran 4× · 120k ship 2× · builder 2× · named: ghost',
      '/ship plugin skill · ran 2× · 30.0k',
      'builder spawned 2× · 45.0k',
      'ghost named, never spawned',
    ]);
  });

  it('the graph names its columns by what they hold', () => {
    const cols = (html: string) => [...html.matchAll(/<span class="colt"[^>]*>(.*?)<\/span>/g)].map((m) => m[1]);
    expect(cols(render(DATA))).toEqual(['Run first', 'Skills and agents']);
    expect(cols(render({ ...DATA, edges: [DATA.edges[0]!] }))).toEqual(['Run first', 'Skills they call']);
    expect(cols(render({ ...DATA, edges: [DATA.edges[1]!] }))).toEqual(['Run first', 'Agents dispatched']);
  });

  it('a name two skills share is marked on the node, the phone list and the legend, and only then', () => {
    expect(render(DATA)).not.toContain('class="dup"');
    expect(render(DATA)).not.toContain('two skills share the name');
    const html = render({ ...DATA, nodes: DATA.nodes.map((n) => (n.id === 'plan' ? { ...n, clash: true } : n)) });
    expect(html.match(/<span class="dup" title="Another skill has this name">2×<\/span>/g)).toHaveLength(1); // the graph node
    expect(html.match(/<span class="dup">2×<\/span>/g)).toHaveLength(2); // the phone list and the legend
    expect(read(html)).toContain('2× two skills share the name');
  });

  it('opens by runs: the busiest first, even when it spent the least', () => {
    const busy = { id: 'tick', name: 'tick', source: 'userSettings', runs: 9, how: { you: 9, model: 0, agent: 0, preload: 0 }, tokens: 900, cost: 0.01, costPartial: false, last: NOW, loads: [NOW] };
    const html = render({ ...DATA, usage: [...DATA.usage, busy] });
    const names = [...html.match(/<tbody>.*<\/tbody>/s)![0].matchAll(/<span class="mono">\/(\w+)<\/span>/g)].map((m) => m[1]);
    expect(names).toEqual(['tick', 'plan', 'ship']);
    expect(html).toContain('aria-pressed="true">By runs');
    expect(html).toContain('aria-pressed="false">By tokens');
  });

  it('a cost that is only a floor reads with the ≥ sign, in the table and in the panel', () => {
    const partial = { ...DATA, usage: DATA.usage.map((u) => (u.id === 'ship' ? { ...u, costPartial: true } : u)) };
    expect(read(render(partial))).toContain('30.0k 15.0k ≥ $0.40');
    expect(render(DATA)).not.toContain('≥');
    const node = { ...DATA.nodes[0]!, costPartial: true };
    expect(read(renderToStaticMarkup(createElement(Panel, { node, data: DATA, onClose: () => {} })))).toContain('≥ $1.25 API-eq.');
  });

  it('the usage table has a row per skill with tokens, per-run tokens and API-equivalent cost', () => {
    const html = render(DATA);
    const rows = [...html.match(/<tbody>.*<\/tbody>/s)![0].matchAll(/<tr [^>]*>(.*?)<\/tr>/gs)].map((m) => read(m[1]!));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('/plan project');
    expect(rows[0]).toContain('you 3 · model 1');
    expect(rows[1]).toContain('agent 2');
    expect(rows[0]).toContain('120k 30.0k $1.25');
    expect(rows[1]).toContain('/ship plugin');
    expect(rows[1]).toContain('30.0k 15.0k $0.40');
    expect(rows[1]).toContain('72h ago');
  });

  it('the summary names the most and least used, and how much dearer a run is', () => {
    const text = read(render(DATA));
    expect(text).toContain('Most used: /plan , 4 runs, 120k tok (30.0k a run)');
    expect(text).toContain('Least used that ran: /ship , 2 runs, 30.0k tok (15.0k a run)');
    expect(text).toContain('/plan costs 2.0× as much per run as /ship');
  });

  it('the last-7-days sparkline counts loads per day', () => {
    const html = render(DATA);
    expect(html).toContain('aria-label="3 runs in the last 7 days"');
    // plan: 2 loads today, 1 yesterday, so two bars are lit and today's is twice as tall; ship: one bar.
    const bars = (row: string) => [...row.matchAll(/<rect [^>]*height="(\d+)" opacity="0.9"/g)].map((m) => m[1]);
    const [plan, ship] = [...html.match(/<tbody>.*<\/tbody>/s)![0].matchAll(/<tr .*?<\/tr>/gs)].map((m) => m[0]);
    expect(bars(plan!)).toEqual(['8', '16']);
    expect(bars(ship!)).toHaveLength(1);
  });

  it('lists the skills that never ran with the listing tokens, and flags a name two skills share', () => {
    const html = render(DATA);
    expect(read(html)).toContain('Listed but never ran 2 skills · 100 tokens of listing in every session');
    expect(read(html)).toContain('tidy user · 60 tok');
    expect(read(html)).toContain('plan plugin · 40 tok · another skill has this name');
  });

  it('one idle skill is counted in the singular', () => {
    expect(read(render({ ...DATA, idle: [DATA.idle[0]!] }))).toContain('Listed but never ran 1 skill · 60 tokens');
  });

  it('with nothing recorded, says so instead of an empty graph', () => {
    const html = render({ nodes: [], edges: [], usage: [], idle: [] });
    expect(read(html)).toBe('No skills recorded in this period. Sessions started with this version of the plugin list their skills and record each one they load.');
    expect(html).not.toContain('What calls what');
  });

  it('with only idle skills, no graph and no usage table', () => {
    const html = render({ ...DATA, nodes: [], edges: [], usage: [] });
    expect(html).not.toContain('What calls what');
    expect(html).not.toContain('Skill usage');
    expect(html).toContain('Listed but never ran');
  });

  it('before the fetch answers, the scope draws nothing', () => {
    expect(renderToStaticMarkup(createElement(Skills, { query: 'p=x', now: NOW }))).toBe('');
  });
});

describe('the picked skill panel', () => {
  const panel = (id: string) => read(renderToStaticMarkup(createElement(Panel, { node: DATA.nodes.find((n) => n.id === id)!, data: DATA, onClose: () => {} })));

  it('a skill: its runs, tokens, listing cost, what it called and who called it', () => {
    const text = panel('plan');
    expect(text).toContain('/plan project ran 4× · 120k tok with what it dispatched · $1.25 API-eq. · its listing costs 80 tok in every session');
    expect(text).toContain('“Plan a change”');
    expect(text).toContain('ship · 2× plugin skill');
    expect(text).toContain('builder · 2× agent');
    expect(text).toContain('ghost · 0× agent named in its text, not spawned in 4 runs');
    expect(text).toContain('you , typing /plan · 3×');
    expect(text).toContain('the main agent , on its own · 1×');
  });

  it('a skill nobody called says so', () => {
    const lone = node({ id: 'lone', name: 'lone', source: 'plugin', runs: 1 });
    const text = read(renderToStaticMarkup(createElement(Panel, { node: lone, data: { ...DATA, nodes: [...DATA.nodes, lone] }, onClose: () => {} })));
    expect(text).toContain('Nothing here called it.');
    expect(panel('plan')).not.toContain('Nothing here called it.');
  });

  it('an agent that nothing calls and that calls nothing says both', () => {
    const text = panel('agent:ghost');
    expect(text).toContain('ghost agent spawned 0×');
    expect(text).toContain('It called nothing, and its text names nothing.');
    expect(text).toContain('plan · 0×');
    expect(text).toContain('names it in its text, never called it');
  });
});
