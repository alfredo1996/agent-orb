import type { Event } from '@agent-orb/shared';
import { describe, expect, it } from 'vitest';
import { applyEvents, newLive, visible } from '../src/live.ts';
import { openStore } from '../src/store/store.ts';
import { writeEvents } from '../src/store/writer.ts';

// The live state behind /stream and the Live view (§8.1), derived from events alone.
const T = 1_792_400_000_000;
let n = 0;
const base = { v: 1, host: 'mbp', user_id: 'local', session_id: 's-1', project: { cwd: '/r', name: 'agent-orb', git_branch: 'dev' } } as const;
const ev = (kind: string, data: object, extra: object = {}, ts = T + n * 1000): Event =>
  ({ ...base, id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, ts, kind, data, ...extra }) as Event;
const usage = { input: 1000, output: 2000, cache_read: 10_000, cache_creation: 4000 }; // 17,000 tok, $0.066 on Opus 5.5

const session = () => [
  ev('session.start', { model: 'claude-opus-5-5', source: 'interactive', claude_version: '2.1.299', plugin_version: '0.1.0' }),
  ev('turn.start', {}, { turn_id: 't-1' }),
  ev('turn.step', { model: 'claude-opus-5-5', usage, stop_reason: 'tool_use', tool_use_ids: [] }, { turn_id: 't-1' }),
  ev('agent.spawn', { tool_use_id: 'toolu_a', agent_type: 'Explore', description: 'Find docs', model: 'claude-haiku-5-5', prompt_length: 9 }, { agent_id: 'a1' }),
  ev('turn.start', {}, { agent_id: 'a1', turn_id: 't-2' }),
  ev('tool.call', { tool_use_id: 'toolu_w', tool: 'WebFetch', input_size: 30 }, { agent_id: 'a1', turn_id: 't-2' }),
];

const agents = (s: ReturnType<typeof newLive>) => (visible(s, T + 60_000)[0] as any).agents;

describe('live state', () => {
  it('builds a session with its main agent and a nested subagent', () => {
    const s = newLive();
    expect(applyEvents(s, session())).toEqual(['s-1']);
    const [view] = visible(s, T + 60_000) as any[];
    expect(view).toMatchObject({ id: 's-1', project: 'agent-orb', branch: 'dev', host: 'mbp', tokens: 17_000 });
    expect(view.cost).toBeCloseTo(0.066, 12);
    expect(agents(s).map((a: any) => [a.id, a.parent, a.type, a.role, a.model, a.state])).toEqual([
      ['main', undefined, 'main', 'orchestrator', 'claude-opus-5-5', 'working'],
      ['a1', 'main', 'Explore', 'researcher', 'claude-haiku-5-5', 'working'],
    ]);
    expect(agents(s)[1]).toMatchObject({ description: 'Find docs', tool: { name: 'WebFetch', id: 'toolu_w', since: expect.any(Number) } });
  });

  it('a stall marks the agent stalled until stall.end', () => {
    const s = newLive();
    applyEvents(s, [...session(), ev('stall.start', { tool_use_id: 'toolu_w', tool: 'WebFetch', since: T }, { agent_id: 'a1' })]);
    expect(agents(s)[1].state).toBe('stalled');
    applyEvents(s, [ev('stall.end', { tool_use_id: 'toolu_w', tool: 'WebFetch', since: T }, { agent_id: 'a1' })]);
    expect(agents(s)[1].state).toBe('working');
  });

  // #109: a stall one process raised is never ended by the next process of the same session, so the agent's own progress ends it.
  const stall = (agent_id?: string) => ev('stall.start', { tool_use_id: 'toolu_w', tool: 'WebFetch', since: T }, agent_id ? { agent_id } : {});
  const state = (s: ReturnType<typeof newLive>, id: string) => agents(s).find((a: any) => a.id === id).state;

  it('main shows progress in a new process, and its stall ends', () => {
    const s = newLive();
    applyEvents(s, [...session(), stall()]);
    expect(state(s, 'main')).toBe('stalled');
    applyEvents(s, [
      ev('turn.start', {}, { turn_id: 't-3' }),
      ev('turn.complete', { duration_ms: 1000, usage_total: usage, reason: 'answer', answer_length: 10 }, { turn_id: 't-3' }),
    ]);
    expect(state(s, 'main')).toBe('waiting');
  });

  it('a stall with nothing after it stays', () => {
    const s = newLive();
    applyEvents(s, [...session(), stall()]);
    expect(state(s, 'main')).toBe('stalled');
  });

  it('a stall later than the last progress in the same batch stands, whatever the order they arrive in', () => {
    const s = newLive();
    const step = ev('turn.step', { model: 'claude-opus-5-5', usage, stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: 't-1' });
    applyEvents(s, [stall(), step]); // stall is later by ts, but arrives first
    expect(state(s, 'main')).toBe('stalled');
  });

  it('stall.end still clears a stall', () => {
    const s = newLive();
    applyEvents(s, [...session(), stall()]);
    applyEvents(s, [ev('stall.end', { tool_use_id: 'toolu_w', tool: 'WebFetch', since: T })]);
    expect(state(s, 'main')).not.toBe('stalled');
  });

  it("a subagent's stall ends with that subagent's progress, not main's", () => {
    const s = newLive();
    applyEvents(s, [...session(), stall('a1')]);
    applyEvents(s, [ev('turn.step', { model: 'claude-opus-5-5', usage, stop_reason: 'tool_use', tool_use_ids: [] }, { turn_id: 't-1' })]);
    expect(state(s, 'a1')).toBe('stalled');
    applyEvents(s, [ev('tool.result', { tool_use_id: 'toolu_w', tool: 'WebFetch', success: true }, { agent_id: 'a1', turn_id: 't-2' })]);
    expect(state(s, 'a1')).not.toBe('stalled');
  });

  it('a permission wait and a finished turn read as waiting, with the reason', () => {
    const s = newLive();
    applyEvents(s, [
      ...session(),
      ev('tool.waiting', { tool_use_id: 'toolu_w', tool: 'WebFetch' }, { agent_id: 'a1' }),
      ev('turn.complete', { duration_ms: 5000, usage_total: usage, reason: 'answer', answer_length: 10, context_percent: 61 }, { turn_id: 't-1' }),
    ]);
    expect(agents(s).map((a: any) => [a.id, a.state, a.waitingFor])).toEqual([['main', 'waiting', 'prompt'], ['a1', 'waiting', 'permission']]);
    expect((visible(s, T + 60_000)[0] as any).contextPercent).toBe(61);
  });

  it('a tool result clears the current tool; agent.complete marks done; an error turn marks error', () => {
    const s = newLive();
    applyEvents(s, [
      ...session(),
      ev('tool.result', { tool_use_id: 'toolu_w', success: true, duration_ms: 10, output_size: 5, files_touched: [] }, { agent_id: 'a1' }),
    ]);
    expect(agents(s)[1].tool).toBeUndefined();
    applyEvents(s, [ev('agent.complete', { duration_ms: 9000, usage_total: usage, report_length: 40 }, { agent_id: 'a1' })]);
    expect(agents(s)[1].state).toBe('done');
    applyEvents(s, [ev('turn.complete', { duration_ms: 1, usage_total: usage, reason: 'error', answer_length: 0 }, { turn_id: 't-1' })]);
    expect(agents(s)[0].state).toBe('error');
  });

  it('a subagent seen before its spawn event is placed under its parent once the spawn arrives', () => {
    const s = newLive();
    const [start, , , spawn, sub] = session();
    applyEvents(s, [start!, sub!]); // the engine starts the child's turn before agent.spawn resolves (docs/verified.md)
    expect(agents(s).find((a: any) => a.id === 'a1')).toMatchObject({ parent: 'main', type: 'agent' });
    applyEvents(s, [spawn!]);
    expect(agents(s).find((a: any) => a.id === 'a1')).toMatchObject({ parent: 'main', type: 'Explore' });
  });

  it('counts each event once, however often it arrives', () => {
    const s = newLive();
    const events = session();
    applyEvents(s, events);
    expect(applyEvents(s, events)).toEqual([]);
    expect((visible(s, T + 60_000)[0] as any).tokens).toBe(17_000);
  });

  it('an unknown model adds tokens but leaves cost unknown', () => {
    const s = newLive();
    applyEvents(s, [...session(), ev('turn.step', { model: 'claude-unknown-9', usage, stop_reason: null, tool_use_ids: [] }, { turn_id: 't-1' })]);
    const [view] = visible(s, T + 60_000) as any[];
    expect(view.tokens).toBe(34_000);
    expect(view.costPartial).toBe(true);
  });

  it('once the session ends, every agent reads as done, not waiting', () => {
    const s = newLive();
    applyEvents(s, [...session(), ev('session.end', { reason: 'exit' })]);
    expect(agents(s).map((a: any) => a.state)).toEqual(['done', 'done']);
  });

  it('shows running sessions and ones ended in the last 10 minutes, newest first', () => {
    const s = newLive();
    applyEvents(s, session());
    applyEvents(s, [{ ...ev('session.start', { model: 'm', source: 'headless', claude_version: 'v', plugin_version: 'p' }), session_id: 's-2' } as Event]);
    applyEvents(s, [{ ...ev('session.end', { reason: 'exit' }, {}, T), session_id: 's-1' } as Event]);
    expect((visible(s, T + 5 * 60_000) as any[]).map((x) => x.id)).toEqual(['s-2', 's-1']);
    expect((visible(s, T + 11 * 60_000) as any[]).map((x) => x.id)).toEqual(['s-2']);
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.ts';

describe('the studio at /', () => {
  it('serves the studio build when there is one, and the API either way', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orb-studio-'));
    writeFileSync(join(dir, 'index.html'), '<title>agent-orb · Live</title>');
    const withStudio = buildApp({ token: 't', studioDir: dir });
    const res = await withStudio.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('agent-orb · Live');
    expect((await withStudio.inject({ method: 'GET', url: '/../package.json' })).statusCode).toBe(404);
    const without = buildApp({ token: 't', studioDir: join(dir, 'missing') });
    expect((await without.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    expect((await without.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await withStudio.close();
    await without.close();
  });
});

describe('content in the live state (§15, 2026-10-20)', () => {
  const T2 = T + 10_000;
  const withContent = () => [
    { ...ev('session.start', { model: 'claude-opus-5-5', source: 'interactive', claude_version: 'v', plugin_version: 'p', content: 'full' }, {}, T2), session_id: 's-c' },
    { ...ev('prompt.submit', { length: 14, text: 'fix the writer' }, { prompt_id: 'p-1' }, T2 + 1), session_id: 's-c' },
  ] as Event[];
  const view0 = (s: ReturnType<typeof newLive>) => (visible(s, T2 + 60_000) as any[]).find((x) => x.id === 's-c');

  it('the session says content is on; main shows what it was asked', () => {
    const s = newLive();
    applyEvents(s, withContent());
    expect(view0(s).content).toBe('full');
    expect(view0(s).agents[0].now).toEqual({ label: 'asked', text: 'fix the writer' });
  });

  it('a tool call shows its main argument (command, path, URL, pattern), else its JSON', () => {
    const s = newLive();
    const call = (id: string, tool: string, input: string, ts: number) =>
      ({ ...ev('tool.call', { tool_use_id: id, tool, input_size: input.length, input }, {}, ts), session_id: 's-c' }) as Event;
    applyEvents(s, [...withContent(), call('t1', 'Bash', '{"command":"pnpm test","description":"run"}', T2 + 2)]);
    expect(view0(s).agents[0].now).toEqual({ label: 'Bash', text: 'pnpm test' });
    applyEvents(s, [call('t2', 'WebFetch', '{"url":"https://kenney.nl/assets","prompt":"list packs"}', T2 + 3)]);
    expect(view0(s).agents[0].now).toEqual({ label: 'WebFetch', text: 'https://kenney.nl/assets' });
    applyEvents(s, [call('t3', 'mcp__x__y', '{"a":1}', T2 + 4)]);
    expect(view0(s).agents[0].now).toEqual({ label: 'mcp__x__y', text: '{"a":1}' });
  });

  it('an answer replaces it, cut to one short line', () => {
    const s = newLive();
    const long = 'Done. '.repeat(100);
    applyEvents(s, [...withContent(), { ...ev('turn.step', { model: 'm', usage, stop_reason: 'end_turn', tool_use_ids: [], answer: long }, { turn_id: 't' }, T2 + 5), session_id: 's-c' } as Event]);
    const now = view0(s).agents[0].now;
    expect(now.label).toBe('answered');
    expect(now.text.length).toBeLessThanOrEqual(161);
    expect(now.text.endsWith('…')).toBe(true);
  });

  it('a new subagent shows its task until it does something else', () => {
    const s = newLive();
    applyEvents(s, [...withContent(), { ...ev('agent.spawn', { tool_use_id: 'ta', agent_type: 'Explore', model: 'm', prompt_length: 13, prompt: 'Find the docs' }, { agent_id: 'a9' }, T2 + 6), session_id: 's-c' } as Event]);
    expect(view0(s).agents.find((a: any) => a.id === 'a9').now).toEqual({ label: 'task', text: 'Find the docs' });
  });

  it('with content off there is no line', () => {
    const s = newLive();
    applyEvents(s, session());
    expect(agents(s)[0].now).toBeUndefined();
  });
});

describe('live state, Slice 6 (the cards)', () => {
  it('each agent knows the skill it runs this turn, what it was asked, its tasks and its calls and failures', () => {
    const s = newLive();
    applyEvents(s, [
      ...session(),
      ev('prompt.submit', { length: 30, text: 'Build Slice 5 through the agents' }, { prompt_id: 'p-1' }),
      ev('skill.load', { skill: 'code', how: 'typed', source: 'projectSettings' }, { turn_id: 't-1' }),
      ev('task.create', { task_id: '1', subject: 'Run the gate', status: 'pending' }, { turn_id: 't-1' }),
      ev('task.create', { task_id: '2', subject: 'Open the PR', status: 'pending' }, { turn_id: 't-1' }),
      ev('task.create', { task_id: '3', subject: 'Drop this one', status: 'pending' }, { turn_id: 't-1' }),
      ev('task.complete', { task_id: '1', subject: 'Run the gate', status: 'completed' }, { turn_id: 't-1' }),
      ev('task.complete', { task_id: '3', subject: 'Drop this one', status: 'deleted' }, { turn_id: 't-1' }),
      ev('skill.load', { skill: 'test', how: 'tool', source: 'projectSettings', tool_use_id: 'toolu_s' }, { agent_id: 'a1', turn_id: 't-2' }),
      ev('tool.result', { tool_use_id: 'toolu_w', success: false, error_type: 'timeout', duration_ms: 9, output_size: 0, files_touched: [] }, { agent_id: 'a1', turn_id: 't-2' }),
    ]);
    const [main, a1] = agents(s);
    expect(main).toMatchObject({ skills: ['code'], asked: 'Build Slice 5 through the agents', calls: 0, failed: 0,
      tasks: [{ id: '1', subject: 'Run the gate', status: 'completed' }, { id: '2', subject: 'Open the PR', status: 'pending' }] });
    expect(a1).toMatchObject({ skills: ['test'], calls: 1, failed: 1, tasks: [] });
  });

  it('a turn keeps its skills in the order they loaded, once each (a real run: alpha called beta)', () => {
    const s = newLive();
    applyEvents(s, [...session(), ev('skill.load', { skill: 'alpha', how: 'typed' }, { turn_id: 't-1' }), ev('skill.load', { skill: 'beta', how: 'tool' }, { turn_id: 't-1' }),
      ev('skill.load', { skill: 'beta', how: 'tool' }, { turn_id: 't-1' })]);
    expect(agents(s)[0].skills).toEqual(['alpha', 'beta']);
  });

  it('a new turn starts with no skill; the session counts which skills ran, how often and by whom', () => {
    const s = newLive();
    applyEvents(s, [
      ...session(),
      ev('skill.load', { skill: 'code', how: 'typed' }, { turn_id: 't-1' }),
      ev('skill.load', { skill: 'test', how: 'tool' }, { agent_id: 'a1', turn_id: 't-2' }),
      ev('skill.load', { skill: 'test', how: 'tool' }, { agent_id: 'a1', turn_id: 't-2' }),
      ev('turn.complete', { duration_ms: 5, usage_total: usage, reason: 'answer', answer_length: 3 }, { turn_id: 't-1' }),
      ev('turn.start', {}, { turn_id: 't-3' }),
    ]);
    expect(agents(s)[0].skills).toEqual([]);
    expect((visible(s, T + 60_000)[0] as any).skills).toEqual([
      { skill: 'test', count: 2, by: [{ who: 'Explore', count: 2 }] },
      { skill: 'code', count: 1, by: [{ who: 'you', count: 1 }] },
    ]);
  });

  it('text arriving means content is on, even when session.start came before a server restart', () => {
    const s = newLive();
    applyEvents(s, [ev('turn.step', { model: 'claude-opus-5-5', usage, stop_reason: 'end_turn', tool_use_ids: [], answer: 'Done.' }, { turn_id: 't-9' })]);
    expect((visible(s, T + 60_000)[0] as any).content).toBe('full');
  });

  // #101: the live state is empty after a restart, and the first event it sees is not the session's first.
  describe("a session's own start", () => {
    const DAY = 86_400_000;
    const started = () => ev('session.start', { model: 'm', source: 'interactive', claude_version: 'v', plugin_version: 'p' }, {}, T);
    const next = () => ev('turn.start', {}, { turn_id: 't-9' }, T + 6 * DAY);
    const startedAt = (s: ReturnType<typeof newLive>) => (visible(s, T + 6 * DAY + 60_000)[0] as any).startedAt;

    it('is the one the store holds, not the time of the first event seen since the restart', () => {
      const store = openStore(':memory:');
      writeEvents(store, [{ ...started(), user_id: 'local' } as Event], 'plugin');
      const s = newLive(store); // the restart
      applyEvents(s, [next()]);
      expect(startedAt(s)).toBe(T);
    });

    it('falls back to the first event seen when the store has no start for the session', () => {
      const store = openStore(':memory:');
      const s = newLive(store);
      applyEvents(s, [next()]);
      expect(startedAt(s)).toBe(T + 6 * DAY);
    });

    it('is the first event seen when there is no store to ask', () => {
      const s = newLive();
      applyEvents(s, [next()]);
      expect(startedAt(s)).toBe(T + 6 * DAY);
    });
  });
});

describe('live state, v0.2 slice 2 (the model check)', () => {
  const spawn = (agent: string, data: object = {}) =>
    ev('agent.spawn', { tool_use_id: `toolu_${agent}`, agent_type: 'implementer', description: 'Build it', model: 'claude-opus-5-5', prompt_length: 9, ...data }, { agent_id: agent });
  const base = () => session().slice(0, 3); // start, a main turn and its step: no subagent yet

  it('a spawn the plugin flagged marks its agent with what it is held to and whose limit that is', () => {
    const s = newLive();
    applyEvents(s, [...base(), spawn('p1', { declared_model: 'sonnet', model_check: { allowed: 'sonnet', source: 'file' } }), spawn('p2', { model_check: { allowed: 'sonnet', source: 'ceiling' } })]);
    expect(agents(s).map((a: any) => [a.id, a.pricier])).toEqual([
      ['main', undefined], ['p1', { allowed: 'sonnet', source: 'file' }], ['p2', { allowed: 'sonnet', source: 'ceiling' }],
    ]);
  });

  it('an agent within its limit, and the main session, carry no flag; the flag outlives the agent, which the studio reads together with done', () => {
    const s = newLive();
    applyEvents(s, [...base(), spawn('ok'), spawn('p1', { model_check: { allowed: 'sonnet', source: 'file' } }),
      ev('agent.complete', { duration_ms: 9, usage_total: usage, report_length: 1 }, { agent_id: 'p1' })]);
    expect(agents(s).map((a: any) => [a.id, a.pricier?.allowed, a.state])).toEqual([['main', undefined, 'working'], ['ok', undefined, 'waiting'], ['p1', 'sonnet', 'done']]);
  });
});
