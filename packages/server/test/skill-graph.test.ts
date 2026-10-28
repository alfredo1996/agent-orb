import { describe, expect, it } from 'vitest';
import { skillGraph, type Def, type TurnRow } from '../src/api/skill-graph.ts';

// Slice 5 (§8.3, §15 2026-10-21): what each skill can call, what it did call, and what each one used. Pure: no store.
const def = (name: string, o: Partial<Def> = {}): Def => ({ name, kind: 'skill', source: 'projectSettings', tokens: 20, ...o });
const turn = (o: Partial<TurnRow>): TurnRow => ({ agent: 'main', type: 'main', sub: false, started_at: 100, loads: [], spawns: [], requests: [], ...o });
const req = (ts: number, tokens: number, cost: number | null = tokens / 1000) => ({ ts, tokens, cost });
const edge = (g: ReturnType<typeof skillGraph>, from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);

describe('skillGraph', () => {
  it('a typed skill owns the turn after it: its requests and the agents it dispatched', () => {
    const g = skillGraph([def('code')], [turn({
      loads: [{ ts: 99, skill: 'code', how: 'typed', source: 'projectSettings' }],
      spawns: [{ ts: 120, type: 'implementer', tokens: 5000, cost: 5 }, { ts: 130, type: 'test-runner', tokens: 1000, cost: 1 }],
      requests: [req(110, 300), req(140, 200)],
    })], []);
    expect(g.usage).toEqual([{ id: 'skill:projectSettings:code', name: 'code', source: 'projectSettings', runs: 1, how: { you: 1, model: 0, agent: 0, preload: 0 },
      tokens: 6500, cost: 6.5, costPartial: false, last: 99, loads: [99] }]);
    expect(edge(g, 'skill:projectSettings:code', 'agent:implementer')).toMatchObject({ did: 1, named: false, tokens: 5000 });
    expect(edge(g, 'skill:projectSettings:code', 'agent:test-runner')).toMatchObject({ did: 1, tokens: 1000 });
    expect(g.nodes.find((n) => n.id === 'skill:projectSettings:code')).toMatchObject({ byYou: 1, byMain: 0 });
  });

  it('two loads in one turn: the later one is called by the earlier, whose tokens include it (a skill pays for what it starts)', () => {
    const g = skillGraph([def('pr'), def('pr-body', { source: 'userSettings' })], [turn({
      loads: [{ ts: 99, skill: 'pr', how: 'typed', source: 'projectSettings' }, { ts: 150, skill: 'pr-body', how: 'tool', source: 'userSettings' }],
      requests: [req(110, 100), req(160, 40)],
    })], []);
    expect(edge(g, 'skill:projectSettings:pr', 'skill:userSettings:pr-body')).toMatchObject({ did: 1 });
    expect(g.usage.map((u) => [u.name, u.runs, u.tokens, u.how])).toEqual([
      ['pr', 1, 140, { you: 1, model: 0, agent: 0, preload: 0 }], ['pr-body', 1, 0, { you: 0, model: 1, agent: 0, preload: 0 }],
    ]);
  });

  it('a spawn goes to the skill whose text names the agent, even after a skill it called in between (a real run, 2026-10-21)', () => {
    const g = skillGraph([def('alpha', { calls_skills: ['beta'], calls_agents: ['scout'] }), def('beta')], [turn({
      loads: [{ ts: 99, skill: 'alpha', how: 'typed', source: 'projectSettings' }, { ts: 120, skill: 'beta', how: 'tool', source: 'projectSettings' }],
      spawns: [{ ts: 130, type: 'scout', tokens: 900, cost: 0.9 }],
      requests: [req(110, 100), req(125, 50), req(140, 30)],
    })], []);
    expect(edge(g, 'skill:projectSettings:alpha', 'agent:scout')).toMatchObject({ did: 1, named: true, tokens: 900 });
    expect(edge(g, 'skill:projectSettings:beta', 'agent:scout')).toBeUndefined();
    expect(g.usage.find((u) => u.name === 'alpha')).toMatchObject({ tokens: 1080 });
    expect(g.usage.find((u) => u.name === 'beta')).toMatchObject({ runs: 1, tokens: 0 });
  });

  it('a subagent\'s first skill is called by its agent type; a preload is marked as one', () => {
    const g = skillGraph([def('test'), def('beta')], [
      turn({ agent: 'a1', type: 'adversarial-reviewer', sub: true, loads: [{ ts: 200, skill: 'test', how: 'tool', source: 'projectSettings' }] }),
      turn({ agent: 'a2', type: 'scout', sub: true, loads: [{ ts: 300, skill: 'beta', how: 'preload', source: 'projectSettings' }] }),
    ], [{ type: 'adversarial-reviewer', agents: 1, tokens: 900, cost: 0.9 }, { type: 'scout', agents: 1, tokens: 50, cost: null }]);
    expect(edge(g, 'agent:adversarial-reviewer', 'skill:projectSettings:test')).toMatchObject({ did: 1, preload: false });
    expect(edge(g, 'agent:scout', 'skill:projectSettings:beta')).toMatchObject({ did: 1, preload: true });
    expect(g.usage.map((u) => [u.name, u.how])).toEqual([['test', { you: 0, model: 0, agent: 1, preload: 0 }], ['beta', { you: 0, model: 0, agent: 0, preload: 1 }]]);
    expect(g.nodes.find((n) => n.id === 'agent:scout')).toMatchObject({ kind: 'agent', spawns: 1, tokens: 50, costPartial: true });
  });

  it('the main loop calling a skill on its own counts as the model, with no edge', () => {
    const g = skillGraph([def('issue')], [turn({ loads: [{ ts: 120, skill: 'issue', how: 'tool', source: 'projectSettings' }] })], []);
    expect(g.edges).toEqual([]);
    expect(g.nodes.find((n) => n.name === 'issue')).toMatchObject({ byYou: 0, byMain: 1 });
  });

  it('named edges come from the text; one that was also taken is both, one never taken stays named only', () => {
    const g = skillGraph([def('pr', { calls_agents: ['implementer', 'test-runner'] }), def('pr-body', { source: 'userSettings', calls_skills: ['pr'] })], [
      turn({ loads: [{ ts: 99, skill: 'pr', how: 'typed', source: 'projectSettings' }], spawns: [{ ts: 120, type: 'test-runner', tokens: 10, cost: 0 }] }),
      turn({ started_at: 500, loads: [{ ts: 499, skill: 'pr-body', how: 'typed', source: 'userSettings' }] }),
    ], []);
    expect(edge(g, 'skill:projectSettings:pr', 'agent:test-runner')).toMatchObject({ did: 1, named: true });
    expect(edge(g, 'skill:projectSettings:pr', 'agent:implementer')).toMatchObject({ did: 0, named: true });
    expect(edge(g, 'skill:userSettings:pr-body', 'skill:projectSettings:pr')).toMatchObject({ did: 0, named: true });
    expect(g.nodes.find((n) => n.id === 'agent:implementer')).toMatchObject({ ran: false });
  });

  it('skills that never ran are listed with their listing tokens; two skills with one name are flagged', () => {
    const g = skillGraph([def('issue'), def('issue', { source: 'userSettings', tokens: 44 }), def('commit', { tokens: 28 }), def('scout', { kind: 'agent', tokens: 15 })],
      [turn({ loads: [{ ts: 99, skill: 'issue', how: 'typed' }] })], []); // an older load carries no source: the project's wins
    expect(g.usage.map((u) => u.id)).toEqual(['skill:projectSettings:issue']);
    expect(g.idle).toEqual([{ name: 'issue', source: 'userSettings', tokens: 44, clash: true }, { name: 'commit', source: 'projectSettings', tokens: 28, clash: false }]);
    expect(g.nodes.find((n) => n.id === 'skill:projectSettings:issue')).toMatchObject({ clash: true });
  });

  it('a skill missing from the catalogue (a session before Slice 5) still shows, by its name', () => {
    const g = skillGraph([], [turn({ loads: [{ ts: 99, skill: 'pr-body' }] })], []);
    expect(g.usage).toMatchObject([{ id: 'skill:unknown:pr-body', name: 'pr-body', runs: 1 }]);
  });
});
