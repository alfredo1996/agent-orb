import { describe, expect, it } from 'vitest';
import { agentName, familyName, isPricier, needs, pricierSub, progress, rowCounts, rowState, sentence, shown, skillHow, tree } from '../src/live-cards.ts';

// The Live board (design/pages.html): what each row says, how far its tasks are, what needs the person, and how the rows nest.
const T = 1_000_000;
const agent = (o: object) => ({ id: 'a1', type: 'implementer', depth: 1, state: 'working', tokens: 0, cost: 0, startedAt: T, lastTs: T, tasks: [], calls: 0, failed: 0, ...o }) as any;
const tool = (name: string, since = T) => ({ name, id: 't', since, waiting: false });

describe('sentence', () => {
  it('a running tool says what it runs, with its main argument and how long', () => {
    expect(sentence(agent({ tool: tool('Bash'), now: { label: 'Bash', text: 'pnpm test --run' } }), [], T + 42_000))
      .toEqual({ verb: 'Running Bash', arg: 'pnpm test --run', since: T });
  });

  it('waiting for permission, stalled and error say so, with their tone', () => {
    expect(sentence(agent({ state: 'waiting', waitingFor: 'permission', tool: tool('Bash'), now: { label: 'Bash', text: 'git push' } }), [], T))
      .toEqual({ verb: 'Needs your OK to run Bash', arg: 'git push', since: T, tone: 'wait' });
    expect(sentence(agent({ state: 'stalled', tool: tool('WebFetch'), now: { label: 'Read', text: 'old.ts' } }), [], T))
      .toEqual({ verb: 'WebFetch, no answer', since: T, tone: 'bad' }); // the now line was another tool's: no argument
    expect(sentence(agent({ state: 'error' }), [], T)).toEqual({ verb: 'Stopped with an error', tone: 'bad' });
  });

  it('a delegating parent names the agents it waits on; done says how long it took and what it answered', () => {
    const kids = [agent({ id: 'k1', type: 'implementer' }), agent({ id: 'k2', type: 'Explore' }), agent({ id: 'k3', type: 'Plan', state: 'done' })];
    expect(sentence(agent({ id: 'main', type: 'main', tool: tool('Agent', T) }), kids, T))
      .toEqual({ verb: 'Waiting on the 2 agents it dispatched', extra: 'implementer, Explore', since: T });
    expect(sentence(agent({ state: 'done', startedAt: T, lastTs: T + 6 * 60_000, now: { label: 'answered', text: '240/240 passed' } }), [], T))
      .toEqual({ verb: 'Done in 6m', extra: '“240/240 passed”' });
  });

  it('a long argument is cut at 90 characters, so a raw JSON input never floods the card (a real session, 2026-10-21)', () => {
    const raw = `{"actions":[${'{"name":"computer","input":{"action":"wait"}},'.repeat(6)}]}`;
    const s = sentence(agent({ tool: tool('mcp__Claude_Browser__browser_batch'), now: { label: 'mcp__Claude_Browser__browser_batch', text: raw } }), [], T);
    expect(s.arg!.length).toBe(90);
    expect(s.arg!.endsWith('…')).toBe(true);
  });

  it('no tool is thinking; main between turns waits for the next prompt', () => {
    expect(sentence(agent({}), [], T)).toEqual({ verb: 'Thinking…' });
    expect(sentence(agent({ id: 'main', type: 'main', state: 'waiting', waitingFor: 'prompt', now: { label: 'answered', text: 'Merged.' } }), [], T))
      .toEqual({ verb: 'Waiting for your next prompt', extra: 'Answered: “Merged.”' });
  });
});

describe('progress', () => {
  it('counts completed tasks and lists what is left', () => {
    expect(progress([{ id: '1', subject: 'a', status: 'completed' }, { id: '2', subject: 'b', status: 'pending' }, { id: '3', subject: 'c', status: 'in_progress' }]))
      .toEqual({ done: 1, total: 3, left: ['b', 'c'] });
    expect(progress([])).toBeUndefined();
  });
});

describe('needs', () => {
  it('lists the agents waiting for permission and the stalled ones, oldest first, across sessions', () => {
    const sessions = [
      { id: 's1', agents: [agent({ id: 'main', type: 'main' }), agent({ id: 'a2', type: 'Explore', state: 'stalled', tool: tool('WebFetch', T - 16 * 60_000) })] },
      { id: 's2', agents: [agent({ id: 'a3', type: 'adversarial-reviewer', state: 'waiting', waitingFor: 'permission', tool: tool('Bash', T - 60_000), now: { label: 'Bash', text: 'git push' } })] },
    ] as any;
    expect(needs(sessions)).toEqual([
      { session: 's1', agent: 'a2', type: 'Explore', tone: 'bad', tool: 'WebFetch', since: T - 16 * 60_000 },
      { session: 's2', agent: 'a3', type: 'adversarial-reviewer', tone: 'wait', tool: 'Bash', arg: 'git push', since: T - 60_000 },
    ]);
  });
});

describe('tree', () => {
  const a = (id: string, parent?: string) => ({ id, ...(parent && { parent }) });
  it('puts each subagent right under its parent, in the order it came, and marks the ones with a sibling after them', () => {
    const rows = tree([a('main'), a('x', 'main'), a('y', 'main'), a('x1', 'x')]);
    expect(rows.map((r) => [r.agent.id, r.level, r.more])).toEqual([['main', 0, false], ['x', 1, true], ['x1', 2, false], ['y', 1, false]]);
  });

  it('an agent whose parent is not listed (hidden once done) is a root, and nobody is lost to a loop', () => {
    expect(tree([a('k', 'gone'), a('main')]).map((r) => [r.agent.id, r.level])).toEqual([['k', 0], ['main', 0]]);
    expect(tree([a('p', 'q'), a('q', 'p')]).map((r) => r.agent.id).sort()).toEqual(['p', 'q']);
  });
});

describe('shown', () => {
  const claim = { kind: 'test', phrase: 'All 48 tests pass', why: 'stale', ts: T };
  it('a done agent leaves the board 10 minutes after its last event, unless its last answer holds an unbacked claim, which stays as long as its session is on the board', () => {
    expect(shown(agent({ state: 'done' }), T + 9 * 60_000)).toBe(true);
    expect(shown(agent({ state: 'done' }), T + 11 * 60_000)).toBe(false);
    expect(shown(agent({ state: 'done', unbacked: [claim] }), T + 60 * 60_000)).toBe(true);
    expect(shown(agent({ state: 'working' }), T + 60 * 60_000)).toBe(true);
  });
});

describe('skillHow', () => {
  it('says whether you typed the skill or an agent ran it, with a count when it ran more than once', () => {
    expect(skillHow([{ who: 'you', count: 1 }])).toBe('you typed it');
    expect(skillHow([{ who: 'you', count: 1 }, { who: 'implementer', count: 2 }])).toBe('you typed it · implementer ran it 2×');
  });
});

// v0.2 slice 2, the model check (design/v0.2-measure.html, the Live board): the pricier agent's row, its reason, and its place in Needs you.
const pricier = (o: object = {}) => agent({ model: 'claude-opus-5-5', pricier: { allowed: 'sonnet', source: 'file' }, startedAt: T - 4 * 60_000, ...o });

describe('familyName', () => {
  it('names the family of a model id, not its version; nothing for a model it does not know', () => {
    expect(familyName('claude-opus-5-5')).toBe('Opus');
    expect(familyName('claude-sonnet-5-5[1m]')).toBe('Sonnet');
    expect(familyName('claude-haiku-5-5-20260901')).toBe('Haiku');
    expect(familyName('claude-fable-5')).toBe('Fable');
    expect(familyName('gpt-x')).toBeUndefined();
    expect(familyName(undefined)).toBeUndefined();
  });
});

describe('rowState', () => {
  it('a pricier model shows only where the agent would read as working: stalled, waiting, error and done come first', () => {
    expect(rowState(pricier())).toBe('model');
    expect(rowState(pricier({ state: 'stalled' }))).toBe('stalled');
    expect(rowState(pricier({ state: 'waiting', waitingFor: 'permission' }))).toBe('waiting');
    expect(rowState(pricier({ state: 'waiting' }))).toBe('waiting');
    expect(rowState(pricier({ state: 'error' }))).toBe('error');
    expect(rowState(pricier({ state: 'done' }))).toBe('done');
    expect(rowState(agent({}))).toBe('working');
  });
});

describe('isPricier and pricierSub', () => {
  it('the reason says whose limit it is: its file, or the ceiling for an agent with no file', () => {
    expect(pricierSub(pricier())).toBe('its file says Sonnet');
    expect(pricierSub(pricier({ pricier: { allowed: 'haiku', source: 'file' } }))).toBe('its file says Haiku');
    expect(pricierSub(pricier({ pricier: { allowed: 'sonnet', source: 'ceiling' } }))).toBe('no file, ceiling Sonnet');
  });

  it('a done agent, and one the plugin did not flag, say nothing and do not count', () => {
    expect(isPricier(pricier())).toBe(true);
    expect(isPricier(pricier({ state: 'stalled' }))).toBe(true); // still on the wrong model while it is stuck
    expect(isPricier(pricier({ state: 'done' }))).toBe(false);
    expect(isPricier(agent({}))).toBe(false);
    expect(pricierSub(pricier({ state: 'done' }))).toBeUndefined();
    expect(pricierSub(agent({}))).toBeUndefined();
  });
});

describe('needs, a pricier model', () => {
  const sessions = (agents: object[]) => [{ id: 's1', agents }] as any;

  it('lists a not-done pricier agent with what it runs on and whose limit it broke, since it started', () => {
    expect(needs(sessions([agent({ id: 'main', type: 'main' }), pricier({ id: 'a1' })]))).toEqual([
      { session: 's1', agent: 'a1', type: 'implementer', tone: 'model', since: T - 4 * 60_000,
        pricier: { subject: 'implementer', generic: false, tail: 'runs on Opus; its agent file says Sonnet' } },
    ]);
  });

  it('an agent with no file is held to the ceiling, and a workflow agent is "a workflow agent"', () => {
    const list = needs(sessions([
      pricier({ id: 'a1', type: 'workflow-subagent', pricier: { allowed: 'sonnet', source: 'ceiling' } }),
      pricier({ id: 'a2', type: 'general-purpose', pricier: { allowed: 'haiku', source: 'ceiling' } }),
    ]));
    expect(list.map((n) => n.pricier)).toEqual([
      { subject: 'workflow agent', generic: true, tail: 'runs on Opus; agents with no file are held to Sonnet' },
      { subject: 'general-purpose', generic: false, tail: 'runs on Opus; agents with no file are held to Haiku' },
    ]);
  });

  it('a done agent is not listed; neither is one already listed as stalled or waiting for permission, which keep their own line', () => {
    const list = needs(sessions([
      pricier({ id: 'a1', state: 'done' }),
      pricier({ id: 'a2', state: 'stalled', tool: tool('WebFetch', T - 16 * 60_000) }),
      pricier({ id: 'a3', state: 'waiting', waitingFor: 'permission', tool: tool('Bash', T - 60_000) }),
    ]));
    expect(list.map((n) => [n.agent, n.tone])).toEqual([['a2', 'bad'], ['a3', 'wait']]);
    expect(list.every((n) => !n.pricier)).toBe(true);
  });

  it('an agent between steps is not listed as waiting, so it is listed as pricier; an unknown model is said plainly', () => {
    const list = needs(sessions([pricier({ id: 'a1', state: 'waiting' }), pricier({ id: 'a2', model: undefined })]));
    expect(list.map((n) => [n.agent, n.tone])).toEqual([['a1', 'model'], ['a2', 'model']]);
    expect(list[1]!.pricier!.tail).toBe('runs on a pricier model; its agent file says Sonnet');
  });

  it('what blocks you comes first, then the pricier ones, the longest-running first, across sessions', () => {
    const list = needs([
      { id: 's1', agents: [pricier({ id: 'old', startedAt: T - 9 * 60_000 }), pricier({ id: 'new', startedAt: T - 60_000 })] },
      { id: 's2', agents: [agent({ id: 'blocked', type: 'Explore', state: 'waiting', waitingFor: 'permission', tool: tool('Bash', T - 1000) })] },
    ] as any);
    expect(list.map((n) => n.agent)).toEqual(['blocked', 'old', 'new']);
  });
});

describe('rowCounts, the header tally', () => {
  it('counts each agent once, by the state its row shows: the pricier ones are not also at work, nor stalled or waiting ones counted twice', () => {
    const counts = rowCounts([
      agent({ id: 'w1' }),                                                   // working
      pricier({ id: 'p1' }), pricier({ id: 'p2' }),                          // working on a pricier model: "pricier model" only
      agent({ id: 'q1', state: 'waiting', waitingFor: 'permission' }),       // waiting
      pricier({ id: 'q2', state: 'waiting', waitingFor: 'prompt' }),         // pricier but waiting: waiting
      agent({ id: 's1', state: 'stalled' }),                                 // stalled
      pricier({ id: 's2', state: 'stalled' }),                               // pricier but stalled: stalled
      agent({ id: 'd1', state: 'done' }),                                    // done
      pricier({ id: 'd2', state: 'done' }),                                  // pricier but done: done
      agent({ id: 'e1', state: 'error' }),                                   // its row says "error", a state the tally has no slot for
    ]);
    expect(counts).toEqual({ working: 1, model: 2, waiting: 2, stalled: 2, done: 2, claim: 0 });
  });

  it('is zero everywhere with no agents, and the six counts add up to the rows the tally can show', () => {
    expect(rowCounts([])).toEqual({ working: 0, model: 0, waiting: 0, stalled: 0, done: 0, claim: 0 });
    const all = [agent({ id: 'a' }), pricier({ id: 'b' }), agent({ id: 'c', state: 'done' })];
    expect(Object.values(rowCounts(all)).reduce((x, y) => x + y, 0)).toBe(all.length);
  });
});

describe('agentName, how Live names an agent', () => {
  it('a workflow agent is "workflow agent", as Needs you says it; every other type is as it is', () => {
    expect(agentName('workflow-subagent')).toBe('workflow agent');
    expect(agentName('implementer')).toBe('implementer');
    expect(agentName('general-purpose')).toBe('general-purpose');
    expect(agentName('main')).toBe('main');
  });

  it('the agents a parent waits on are named the same way', () => {
    const kids = [agent({ id: 'k1', type: 'workflow-subagent' }), agent({ id: 'k2', type: 'Explore' })];
    expect(sentence(agent({ id: 'main', type: 'main', tool: tool('Workflow', T) }), kids, T).extra).toBe('workflow agent, Explore');
  });
});
