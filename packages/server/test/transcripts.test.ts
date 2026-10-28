import { describe, expect, it } from 'vitest';
import { Event } from '@agent-orb/shared';
import { openSession, projectPath, uuid5, type Meta } from '../src/transcripts.ts';
import { digest, readSession, sessionEvents } from './session-events.ts';

// The import's mapping (v0.2 slice 1, PROJECT.md §15 2026-10-24), on synthetic lines in the shapes Claude Code writes.
// Every piece of text below carries a *WORD marker: none of them may reach an event (privacy: lengths only).
const SID = 'sess-A';
const WORDS = ['PROMPTWORD', 'THINKWORD', 'ANSWERWORD', 'INPUTWORD', 'OUTPUTWORD', 'SUBPROMPTWORD', 'ATTACHWORD', 'SYSTEMWORD', 'META_WORD'];
const at = (hhmmss: string) => `2026-10-20T${hhmmss}.000Z`;
const ms = (hhmmss: string) => Date.parse(at(hhmmss));
const usage = (input_tokens: number, output_tokens: number, cache_read_input_tokens = 100, cache_creation_input_tokens = 50) =>
  ({ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, service_tier: 'standard' });

let uuid = 0;
const common = (time: string, extra: object = {}) => ({
  uuid: `line-${++uuid}`, parentUuid: null, sessionId: SID, timestamp: at(time), cwd: '/Users/a/mobile-app/.claude/worktrees/feat-x', gitBranch: 'dev',
  version: '2.1.304', isSidechain: false, ...extra,
});
const assistant = (time: string, msg: string, content: object[], u: object, o: { model?: string; stop?: string | null; extra?: object } = {}) =>
  ({ type: 'assistant', ...common(time, o.extra), message: { id: msg, model: o.model ?? 'claude-opus-5-5', role: 'assistant', stop_reason: o.stop ?? null, content, usage: u } });
const user = (time: string, content: unknown, extra: object = {}) => ({ type: 'user', ...common(time), message: { role: 'user', content }, ...extra });
const toolUse = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, content: unknown, is_error?: boolean) => ({ type: 'tool_result', tool_use_id: id, content, ...(is_error === undefined ? {} : { is_error }) });

const bashInput = { command: 'echo INPUTWORD' };
const mainLines = () => (uuid = 0, [
  assistant('06:59:00', 'msg_0', [{ type: 'text', text: 'ANSWERWORD before any prompt' }], usage(1, 5), { stop: 'end_turn' }), // before any prompt: turn p:0
  user('07:00:00', 'PROMPTWORD one', { promptId: 'p1' }),
  assistant('07:00:02', 'msg_1', [{ type: 'thinking', thinking: 'THINKWORD' }], usage(3, 10), { extra: { attributionSkill: 'code' } }),
  assistant('07:00:03', 'msg_1', [{ type: 'text', text: 'ANSWERWORD' }], usage(3, 12), { extra: { attributionSkill: 'code' } }),
  assistant('07:00:04', 'msg_1', [toolUse('toolu_1', 'Bash', bashInput)], usage(3, 40), { stop: 'tool_use', extra: { attributionSkill: 'code' } }),
  user('07:00:06', [toolResult('toolu_1', 'OUTPUTWORD twenty chars')]),
  assistant('07:00:08', 'msg_2', [{ type: 'text', text: 'ANSWERWORD done' }], usage(5, 60, 200, 0), { model: 'claude-sonnet-5-5', stop: 'end_turn', extra: { attributionSkill: 'code' } }),
  user('07:00:09', 'META_WORD caveat', { isMeta: true }),
  user('07:00:10', '<local-command-stdout>SYSTEMWORD</local-command-stdout>'),
  user('07:00:11', 'ATTACHWORD summary of the conversation so far', { isCompactSummary: true }),
  assistant('07:00:12', 'msg_syn', [{ type: 'text', text: 'ANSWERWORD' }], usage(0, 0), { model: '<synthetic>' }),
  { type: 'attachment', ...common('07:00:13'), attachment: { type: 'x', content: 'ATTACHWORD' } },
  { type: 'system', subtype: 'api_error', ...common('07:00:14'), content: 'SYSTEMWORD' },
  { type: 'queue-operation', timestamp: at('07:00:15'), content: 'SYSTEMWORD' },
  { type: 'last-prompt', lastPrompt: 'PROMPTWORD' },
  user('07:10:00', 'PROMPTWORD two, no promptId', { uuid: 'u-two' }),
  assistant('07:10:02', 'msg_3', [toolUse('toolu_2', 'Agent', { prompt: 'SUBPROMPTWORD', description: 'Find docs' })], usage(7, 80, 300, 10), { stop: 'tool_use', extra: { attributionSkill: 'review' } }),
  user('07:12:00', [toolResult('toolu_2', [{ type: 'text', text: 'OUTPUTWORD' }, { type: 'text', text: 'more' }, { type: 'image', source: 'x' }], true)]),
  user('07:12:05', [toolResult('toolu_gone', 'OUTPUTWORD orphan')]), // its call is not in this session
]);
const sub = (id: string, lines: object[]) => lines.map((l) => ({ ...l, agentId: id, isSidechain: true }));
const subLines = () => sub('a1', [
  user('07:10:03', 'SUBPROMPTWORD find the docs'),
  assistant('07:10:05', 'msg_s1', [toolUse('toolu_s1', 'Read', { file_path: '/x/PROMPTWORD' })], usage(2, 20, 0, 400), { model: 'claude-haiku-5-5', stop: 'tool_use' }),
  user('07:10:07', [toolResult('toolu_s1', 'OUTPUTWORD')]),
  assistant('07:11:50', 'msg_s2', [{ type: 'text', text: 'ANSWERWORD report' }], usage(4, 30, 500, 0), { model: 'claude-haiku-5-5', stop: 'end_turn' }),
]);
const workflowLines = () => sub('w1', [
  user('07:20:00', 'SUBPROMPTWORD review it'),
  assistant('07:20:02', 'msg_w1', [{ type: 'text', text: 'ANSWERWORD' }], usage(1, 2, 3, 4), { stop: 'end_turn', extra: { attributionSkill: 'code' } }),
]);
const meta: Record<string, Meta> = {
  a1: { agentType: 'Explore', description: 'Find docs', toolUseId: 'toolu_2' },
  w1: { agentType: 'workflow-subagent', description: 'Review the diff' },
};

async function events(o: { host?: string; sessionId?: string; withSubs?: boolean } = {}) {
  const seen = new Set<string>();
  const main = await digest(mainLines(), 'main', seen);
  const subs = o.withSubs === false ? [] : [
    { digest: await digest(subLines(), 'sub', seen), meta: meta.a1!, fileAgentId: 'a1' },
    { digest: await digest(workflowLines(), 'sub', seen), meta: meta.w1!, fileAgentId: 'w1' },
  ];
  return await sessionEvents(o.sessionId ?? SID, main, subs, { host: o.host ?? 'mbp', project: { cwd: '/Users/a/mobile-app', name: 'mobile-app' } });
}
const of = (evs: Event[], kind: string) => evs.filter((e) => e.kind === kind);

describe('digest and events: one session', () => {
  it('every event passes the shared schema unchanged, in ts order, with the fields every event has', async () => {
    const evs = await events();
    for (const e of evs) {
      const parsed = Event.safeParse(e);
      expect(parsed.error).toBeUndefined();
      expect(parsed.data).toEqual(e);
      expect(e).toMatchObject({ v: 1, user_id: 'local', host: 'mbp', session_id: SID, project: { cwd: '/Users/a/mobile-app', name: 'mobile-app' } });
    }
    expect(evs.map((e) => e.ts)).toEqual([...evs.map((e) => e.ts)].sort((a, b) => a - b));
    expect(new Set(evs.map((e) => e.id)).size).toBe(evs.length);
  });

  it('session.start at the first line: the first model, the first version, source import, content off', async () => {
    const [start, ...more] = of(await events(), 'session.start');
    expect(more).toEqual([]);
    expect(start!.ts).toBe(ms('06:59:00'));
    expect(start!.data).toEqual({ model: 'claude-opus-5-5', source: 'import', claude_version: '2.1.304', plugin_version: 'import', content: 'off' });
  });

  it('a message spread over several lines counts once, with the last line\'s usage and stop reason', async () => {
    const steps = of(await events({ withSubs: false }), 'turn.step').map((e) => e.kind === 'turn.step' && [e.data.model, e.data.usage, e.data.stop_reason, e.data.tool_use_ids] as const);
    expect(steps).toEqual([
      ['claude-opus-5-5', { input: 1, output: 5, cache_read: 100, cache_creation: 50 }, 'end_turn', []],
      ['claude-opus-5-5', { input: 3, output: 40, cache_read: 100, cache_creation: 50 }, 'tool_use', ['toolu_1']],
      ['claude-sonnet-5-5', { input: 5, output: 60, cache_read: 200, cache_creation: 0 }, 'end_turn', []],
      ['claude-opus-5-5', { input: 7, output: 80, cache_read: 300, cache_creation: 10 }, 'tool_use', ['toolu_2']],
    ]); // msg_syn (<synthetic>) is not a request
  });

  it('a typed prompt is a string that is not meta, not a compact summary and not a local command; only its length goes', async () => {
    const prompts = of(await events(), 'prompt.submit');
    expect(prompts.map((e) => [e.prompt_id, e.ts, e.data])).toEqual([
      ['p1', ms('07:00:00'), { length: 'PROMPTWORD one'.length }],
      ['u-two', ms('07:10:00'), { length: 'PROMPTWORD two, no promptId'.length }], // no promptId: the line's uuid
    ]);
  });

  it('groups assistant lines into turns by the prompt before them, and p:0 before any', async () => {
    const evs = await events({ withSubs: false });
    const turnOf = (kind: string) => of(evs, kind).map((e) => e.turn_id);
    expect(turnOf('turn.step')).toEqual([`${SID}:p:0`, `${SID}:p:p1`, `${SID}:p:p1`, `${SID}:p:u-two`]);
    expect(of(evs, 'turn.start').map((e) => [e.turn_id, e.ts, e.prompt_id])).toEqual([
      [`${SID}:p:0`, ms('06:59:00'), undefined],
      [`${SID}:p:p1`, ms('07:00:00'), 'p1'],
      [`${SID}:p:u-two`, ms('07:10:00'), 'u-two'],
    ]);
    expect(of(evs, 'tool.call').map((e) => e.turn_id)).toEqual([`${SID}:p:p1`, `${SID}:p:u-two`]);
  });

  it('every turn, main and subagent, ends: from its start to its last step, call, result or skill load, with the sum of its steps', async () => {
    const done = of(await events(), 'turn.complete'); // in ts order, as the events are
    const total = (input: number, output: number, cache_read: number, cache_creation: number) => ({ input, output, cache_read, cache_creation });
    expect(done.map((e) => [e.turn_id, e.agent_id, e.ts, e.kind === 'turn.complete' && e.data])).toEqual([
      [`${SID}:p:0`, undefined, ms('06:59:00'), { duration_ms: 0, usage_total: total(1, 5, 100, 50), reason: 'answer', answer_length: 0 }],
      // p1: the prompt at 07:00:00, its last event the reply at 07:00:08 (msg_1 and msg_2: 3+5 in, 40+60 out; the result at 07:00:06 is earlier)
      [`${SID}:p:p1`, undefined, ms('07:00:08'), { duration_ms: 8000, usage_total: total(8, 100, 300, 50), reason: 'answer', answer_length: 0 }],
      [`${SID}:a1`, 'a1', ms('07:11:50'), { duration_ms: 107_000, usage_total: total(6, 50, 500, 400), reason: 'answer', answer_length: 0 }],
      // u-two: its last event is the Agent call's result at 07:12:00, two minutes after the step that made the call; the orphan result at 07:12:05 is nobody's
      [`${SID}:p:u-two`, undefined, ms('07:12:00'), { duration_ms: 120_000, usage_total: total(7, 80, 300, 10), reason: 'answer', answer_length: 0 }],
      [`${SID}:w1`, 'w1', ms('07:20:02'), { duration_ms: 2000, usage_total: total(1, 2, 3, 4), reason: 'answer', answer_length: 0 }],
    ]);
  });

  it('a turn with a prompt and nothing after it ends where it began; a subagent turn is the agent\'s own, never the main agent\'s', async () => {
    const main = await digest([user('07:00:00', 'PROMPTWORD', { promptId: 'lonely' })], 'main');
    const evs = await sessionEvents(SID, main, [], { host: 'mbp', project: { cwd: '/p', name: 'p' } });
    expect(of(evs, 'turn.complete').map((e) => [e.turn_id, e.kind === 'turn.complete' && e.data.duration_ms])).toEqual([[`${SID}:p:lonely`, 0]]);
    const sub = of(await events(), 'turn.complete').filter((e) => e.agent_id);
    expect(sub.map((e) => e.turn_id)).toEqual([`${SID}:a1`, `${SID}:w1`]); // an event without its agent_id would file the turn under main
  });

  it('pairs a tool call with its result: success, wait in ms, output size; an orphan result is left out', async () => {
    const evs = await events({ withSubs: false });
    expect(of(evs, 'tool.call').map((e) => e.kind === 'tool.call' && e.data)).toEqual([
      { tool_use_id: 'toolu_1', tool: 'Bash', input_size: JSON.stringify(bashInput).length, command_class: 'other' }, // every Bash call has a class, `other` too
      { tool_use_id: 'toolu_2', tool: 'Agent', input_size: JSON.stringify({ prompt: 'SUBPROMPTWORD', description: 'Find docs' }).length },
    ]);
    expect(of(evs, 'tool.result').map((e) => e.kind === 'tool.result' && e.data)).toEqual([
      { tool_use_id: 'toolu_1', success: true, duration_ms: 2000, output_size: 'OUTPUTWORD twenty chars'.length, files_touched: [] },
      { tool_use_id: 'toolu_2', success: false, duration_ms: 118_000, output_size: 'OUTPUTWORD'.length + 'more'.length, files_touched: [], error_class: 'other', error_shape: 'h:2cc51f12' },
    ]);
  });

  it('a duration never goes below zero', async () => {
    const main = await digest([
      assistant('07:00:10', 'msg_a', [toolUse('toolu_x', 'Bash', {})], usage(1, 1), { stop: 'tool_use' }),
      user('07:00:05', [toolResult('toolu_x', 'ok')]), // a clock that went back
    ], 'main');
    const evs = await sessionEvents(SID, main, [], { host: 'mbp', project: { cwd: '/p', name: 'p' } });
    expect(of(evs, 'tool.result').map((e) => e.kind === 'tool.result' && e.data.duration_ms)).toEqual([0]);
  });

  it('skill.load once per turn and skill, from attributionSkill', async () => {
    expect(of(await events({ withSubs: false }), 'skill.load').map((e) => [e.turn_id, e.ts, e.data])).toEqual([
      [`${SID}:p:p1`, ms('07:00:02'), { skill: 'code' }],
      [`${SID}:p:u-two`, ms('07:10:02'), { skill: 'review' }],
    ]);
  });

  it('subagents: agent.spawn at the first line, its own turn, agent.complete at the last, from the meta files', async () => {
    const evs = await events();
    const mine = (id: string) => evs.filter((e) => e.agent_id === id);
    expect(mine('a1').map((e) => e.kind)).toEqual(['agent.spawn', 'turn.start', 'turn.step', 'tool.call', 'tool.result', 'turn.step', 'turn.complete', 'agent.complete']);
    const [spawn, , , call, result, , , done] = mine('a1');
    expect(spawn).not.toHaveProperty('parent_agent_id');
    expect(spawn!.ts).toBe(ms('07:10:03'));
    expect(spawn!.kind === 'agent.spawn' && spawn!.data).toEqual({
      tool_use_id: 'toolu_2', agent_type: 'Explore', description: 'Find docs', model: 'claude-haiku-5-5', prompt_length: 'SUBPROMPTWORD find the docs'.length,
    });
    expect(mine('a1').every((e) => e.kind === 'agent.spawn' || e.kind === 'agent.complete' || e.turn_id === `${SID}:a1`)).toBe(true);
    expect(call!.kind === 'tool.call' && call!.data.tool).toBe('Read');
    expect(result!.kind === 'tool.result' && result!.data).toMatchObject({ success: true, duration_ms: 2000 });
    expect(done!.ts).toBe(ms('07:11:50'));
    expect(done!.kind === 'agent.complete' && done!.data).toEqual({
      duration_ms: ms('07:11:50') - ms('07:10:03'), usage_total: { input: 6, output: 50, cache_read: 500, cache_creation: 400 }, report_length: 0,
    });
  });

  it('a workflow agent has no toolUseId: the spawn is keyed import:<id>, and it has no parent_agent_id either', async () => {
    const spawn = of(await events(), 'agent.spawn').find((e) => e.agent_id === 'w1')!;
    expect(spawn).not.toHaveProperty('parent_agent_id');
    expect(spawn.kind === 'agent.spawn' && spawn.data).toEqual({
      tool_use_id: 'import:w1', agent_type: 'workflow-subagent', description: 'Review the diff', model: 'claude-opus-5-5', prompt_length: 'SUBPROMPTWORD review it'.length,
    });
    expect(of(await events(), 'skill.load').find((e) => e.agent_id === 'w1')).toMatchObject({ turn_id: `${SID}:w1`, data: { skill: 'code' } });
  });

  it('a subagent without a meta file is still an agent: unknown type, no description', async () => {
    const main = await digest(mainLines(), 'main');
    const lonely = { digest: await digest(subLines(), 'sub'), meta: {}, fileAgentId: 'a1' };
    const spawn = of(await sessionEvents(SID, main, [lonely], { host: 'mbp', project: { cwd: '/p', name: 'p' } }), 'agent.spawn')[0]!;
    expect(spawn.kind === 'agent.spawn' && spawn.data).toMatchObject({ tool_use_id: 'import:a1', agent_type: 'unknown' });
    expect(spawn.kind === 'agent.spawn' && spawn.data).not.toHaveProperty('description');
  });

  it('a message or a prompt already counted in another file of the run (a resumed session copies its history) counts once', async () => {
    const seen = new Set<string>();
    const here = { host: 'mbp', project: { cwd: '/p', name: 'p' } };
    const first = await readSession(SID, await digest(mainLines(), 'main', seen), [], here);
    const copy = await readSession('sess-B', await digest(mainLines(), 'main', seen), [], here);
    expect(of(first.events, 'turn.step')).toHaveLength(4);
    expect(of(first.events, 'prompt.submit')).toHaveLength(2);
    expect(first.duplicates).toBe(0);
    expect(of(copy.events, 'turn.step')).toEqual([]);
    expect(of(copy.events, 'prompt.submit')).toEqual([]);
    expect(copy.duplicates).toBeGreaterThan(0);
  });

  it('the session is filed under the first cwd of the main file, else of a subagent', async () => {
    const here = { host: 'mbp', project: { cwd: '/p', name: 'p' } };
    expect((await readSession(SID, await digest(mainLines(), 'main'), [], here)).cwd).toBe('/Users/a/mobile-app/.claude/worktrees/feat-x');
    const aside = { digest: await digest([user('07:00:00', 'hi', { cwd: '/elsewhere' })], 'sub'), meta: {}, fileAgentId: 'q' };
    expect((await readSession(SID, await digest([user('06:00:00', 'no cwd', { cwd: undefined })], 'main'), [aside], here)).cwd).toBe('/elsewhere');
  });

  it('a session that names no cwd writes nothing, and a file with no usable line makes no events', async () => {
    const here = { host: 'mbp', project: { cwd: '/p', name: 'p' } };
    const empty = await digest([{ type: 'queue-operation', timestamp: at('07:00:00') }, { type: 'summary' }], 'main');
    expect(await sessionEvents(SID, empty, [], here)).toEqual([]);
    const nowhere = await readSession(SID, await digest([user('07:00:00', 'hello', { cwd: undefined, promptId: 'p1' })], 'main'), [], here);
    expect(nowhere).toMatchObject({ events: [], cwd: undefined });
  });

  it('skips a line that is not JSON, or has no usable timestamp, and goes on', async () => {
    const here = { host: 'mbp', project: { cwd: '/p', name: 'p' } };
    const lines = ['{not json', JSON.stringify(user('07:00:00', 'hello')), JSON.stringify({ type: 'user', message: { content: 'x' }, timestamp: 'never' }), ''];
    const evs = await sessionEvents(SID, { kind: 'main', lines, seen: new Set() }, [], here);
    expect(of(evs, 'prompt.submit')).toHaveLength(1);
  });

  it('no text reaches an event: only lengths, names, ids, and the subagent\'s own short description', async () => {
    const json = JSON.stringify(await events());
    for (const word of WORDS) expect(json, word).not.toContain(word);
    expect(json).toContain('Find docs'); // the meta description is a task title, as the plugin sends it
  });
});

// v0.3 slice 1 (#43): the same classes as the plugin sends, worked out from the lines, and the files a Read, Edit or Write touched.
describe('classes and files_touched', () => {
  const WT = '/Users/a/mobile-app/.claude/worktrees/feat-x'; // the cwd `common` gives every line: the session's own working tree
  const NAMESPACE = '5e1c2a1e-7c0b-4f0e-9a52-0c6b8f3d7a41'; // transcripts.ts's, to name the id an event had before it carried a class
  const CALLS = [
    toolUse('t_test', 'Bash', { command: 'pnpm -C /Users/a/mobile-app test' }),
    toolUse('t_git', 'Bash', { command: 'git status' }),
    toolUse('t_gh', 'Bash', { command: 'gh pr view 7' }),
    toolUse('t_read', 'Read', { file_path: `${WT}/src/a.ts` }),
    toolUse('t_gone', 'Read', { file_path: `${WT}/src/gone.ts` }),
    toolUse('t_edit', 'Edit', { file_path: `${WT}/src/a.ts`, old_string: 'INPUTWORD', new_string: 'x' }),
    toolUse('t_miss', 'Edit', { file_path: `${WT}/src/a.ts`, old_string: 'gone', new_string: 'x' }),
    toolUse('t_write', 'Write', { file_path: `${WT}/docs/new.md`, content: 'x' }),
    toolUse('t_main', 'Read', { file_path: '/Users/a/mobile-app/src/b.ts' }), // the main tree's file, outside this session's working tree
    toolUse('t_denied', 'Bash', { command: 'git push' }),
  ];
  const lines = () => {
    uuid = 0;
    return [
      user('08:00:00', 'PROMPTWORD', { promptId: 'q1' }),
      assistant('08:00:01', 'msg_c1', CALLS, usage(1, 1), { stop: 'tool_use' }),
      user('08:00:09', [
        toolResult('t_test', 'Exit code 1\n FAIL  test/a.test.ts\nOUTPUTWORD', true),
        toolResult('t_git', 'On branch dev OUTPUTWORD'),
        toolResult('t_gh', [{ type: 'text', text: 'Exit code 127\n(eval):1: command not found: gh OUTPUTWORD' }], true),
        toolResult('t_read', 'OUTPUTWORD file'),
        toolResult('t_gone', 'File does not exist. OUTPUTWORD', true),
        toolResult('t_edit', 'ok'),
        toolResult('t_miss', '<tool_use_error>String to replace not found in file.\nString: INPUTWORD</tool_use_error>', true),
        toolResult('t_write', 'ok'),
        toolResult('t_main', 'ok'),
        toolResult('t_denied', 'The user doesn\'t want to proceed with this tool use. The tool use was rejected', true),
      ]),
    ];
  };
  const run = async (ls: object[] = lines()) => {
    const evs = await sessionEvents(SID, await digest(ls, 'main'), [], { host: 'mbp', project: { cwd: '/Users/a/mobile-app', name: 'mobile-app' } });
    return { evs, calls: of(evs, 'tool.call'), results: of(evs, 'tool.result') };
  };

  it('a Bash call carries its command class; no other call does', async () => {
    const { calls } = await run();
    expect(calls.map((e) => e.kind === 'tool.call' && [e.data.tool_use_id, e.data.command_class])).toEqual([
      ['t_test', 'test'], ['t_git', 'git'], ['t_gh', 'gh'], ['t_read', undefined], ['t_gone', undefined], ['t_edit', undefined], ['t_miss', undefined], ['t_write', undefined], ['t_main', undefined], ['t_denied', 'git'],
    ]);
    for (const e of calls) if (e.kind === 'tool.call' && e.data.tool !== 'Bash') expect(e.data).not.toHaveProperty('command_class');
  });

  it('a failed result carries its error class, a result that worked none; a failed call touched no file', async () => {
    const { results } = await run();
    expect(results.map((e) => e.kind === 'tool.result' && [e.data.tool_use_id, e.data.success, e.data.error_class, e.data.files_touched])).toEqual([
      ['t_test', false, 'exit_code', []], // a failing test run is an exit_code (its command class is test)
      ['t_git', true, undefined, []],
      ['t_gh', false, 'unknown_command', []], // the text of a list of blocks is read too
      ['t_read', true, undefined, [{ path: 'src/a.ts', mode: 'read' }]],
      ['t_gone', false, 'not_found', []],
      ['t_edit', true, undefined, [{ path: 'src/a.ts', mode: 'write' }]],
      ['t_miss', false, 'no_match', []],
      ['t_write', true, undefined, [{ path: 'docs/new.md', mode: 'write' }]],
      ['t_main', true, undefined, []], // outside the session's working tree
      ['t_denied', false, 'refused', []],
    ]);
    for (const e of results) if (e.kind === 'tool.result' && e.data.success) expect(e.data).not.toHaveProperty('error_class');
  });

  // v0.3 slice 3 (#45): the hashes were worked out apart, in python (shapes.py's cousin), from the tool, the command class and the first meaningful line.
  it('a failed result carries its shape: a named pattern or a hash of the tool, the command class and the first meaningful line; a result that worked none', async () => {
    const { results } = await run();
    expect(results.map((e) => e.kind === 'tool.result' && [e.data.tool_use_id, e.data.error_shape])).toEqual([
      ['t_test', 'h:dc10f167'], // Bash, test, "FAIL P"
      ['t_git', undefined],
      ['t_gh', 'h:faf233b3'], // Bash, gh: a list of text blocks is read too
      ['t_read', undefined],
      ['t_gone', 'h:cb190bbd'], // Read, no command class
      ['t_edit', undefined],
      ['t_miss', 'h:269aa74f'], // Edit: the tags are dropped
      ['t_write', undefined],
      ['t_main', undefined],
      ['t_denied', 'user_rejected'],
    ]);
    for (const e of results) if (e.kind === 'tool.result' && e.data.success) expect(e.data).not.toHaveProperty('error_shape');
  });

  it('a failure with no meaningful line has no shape, and keeps the id it had with its class alone', async () => {
    const { results } = await run([
      ...lines().slice(0, 2),
      user('08:00:09', [toolResult('t_test', 'Exit code 1\n', true), toolResult('t_gh', '<tool_use_error></tool_use_error>', true)]),
    ]);
    const bare = results.filter((e) => e.kind === 'tool.result' && e.data.success === false);
    expect(bare.map((e) => e.kind === 'tool.result' && [e.data.tool_use_id, e.data.error_class, e.data.error_shape])).toEqual([['t_test', 'exit_code', undefined], ['t_gh', 'other', undefined]]);
    for (const e of bare) expect(e.id).toBe(uuid5(NAMESPACE, `${SID}|tool.result|${e.kind === 'tool.result' && e.data.tool_use_id}|v2`));
  });

  it('paths are relative to the session\'s working tree: the worktree for a worktree session, the project outside one; a subagent has its own', async () => {
    const plain = lines().map((l) => JSON.parse(JSON.stringify(l).replaceAll(WT, '/Users/a/mobile-app'))); // the same session, not in a worktree
    const edit = (await run(plain)).results.find((e) => e.kind === 'tool.result' && e.data.tool_use_id === 't_edit');
    expect(edit!.kind === 'tool.result' && edit!.data.files_touched).toEqual([{ path: 'src/a.ts', mode: 'write' }]);
    const AGENT = '/Users/a/mobile-app/.claude/worktrees/agent-q';
    const main = await digest([user('08:00:00', 'PROMPTWORD', { promptId: 'q1' })], 'main');
    const subDigest = await digest(sub('q', [
      user('08:00:02', 'SUBPROMPTWORD task'),
      assistant('08:00:03', 'msg_q1', [toolUse('t_q', 'Read', { file_path: `${AGENT}/src/q.ts` }), toolUse('t_q2', 'Read', { file_path: `${WT}/src/a.ts` })], usage(1, 1), { stop: 'tool_use' }),
      user('08:00:04', [toolResult('t_q', 'ok'), toolResult('t_q2', 'ok')]),
    ]).map((l: any) => ({ ...l, cwd: AGENT })), 'sub');
    const evs = await sessionEvents(SID, main, [{ digest: subDigest, meta: {}, fileAgentId: 'q' }], { host: 'mbp', project: { cwd: '/Users/a/mobile-app', name: 'mobile-app' } });
    expect(of(evs, 'tool.result').map((e) => e.kind === 'tool.result' && e.data.files_touched)).toEqual([[{ path: 'src/q.ts', mode: 'read' }], []]);
  });

  it('every event passes the shared schema unchanged, and no text reaches one', async () => {
    const { evs } = await run();
    for (const e of evs) {
      const parsed = Event.safeParse(e);
      expect(parsed.error).toBeUndefined();
      expect(parsed.data).toEqual(e);
    }
    const json = JSON.stringify(evs);
    for (const word of ['PROMPTWORD', 'INPUTWORD', 'OUTPUTWORD', 'FAIL', 'pnpm -C', 'command not found']) expect(json, word).not.toContain(word);
  });

  it('an event that gained a class or a path has a new id, any other keeps the one it had: a history imported before this slice takes them on its next run', async () => {
    const legacy = (kind: string, id: string) => uuid5(NAMESPACE, `${SID}|${kind}|${id}`);
    const { calls, results } = await run();
    const idOf = (list: Event[], id: string) => list.find((e) => (e.kind === 'tool.call' || e.kind === 'tool.result') && e.data.tool_use_id === id)!.id;
    for (const id of ['t_test', 't_git', 't_gh', 't_denied']) expect(idOf(calls, id), `call ${id}`).not.toBe(legacy('tool.call', id)); // a Bash call now says more
    for (const id of ['t_read', 't_gone', 't_edit', 't_miss', 't_write', 't_main']) expect(idOf(calls, id), `call ${id}`).toBe(legacy('tool.call', id));
    for (const id of ['t_test', 't_gh', 't_gone', 't_miss', 't_denied', 't_read', 't_edit', 't_write']) expect(idOf(results, id), `result ${id}`).not.toBe(legacy('tool.result', id)); // a class or a path
    for (const id of ['t_git', 't_main']) expect(idOf(results, id), `result ${id}`).toBe(legacy('tool.result', id)); // a success that touched nothing: as before
  });

  it('a failed result that has a shape is keyed on it (|s:<shape>), so a changed shape is a new event; one that has a class or a path alone keeps the |v2 it had since slice 1', async () => {
    const { results } = await run();
    const one = (id: string) => results.find((e) => e.kind === 'tool.result' && e.data.tool_use_id === id)!;
    const idOf = (id: string) => one(id).id;
    for (const [id, shape] of [['t_test', 'h:dc10f167'], ['t_gh', 'h:faf233b3'], ['t_gone', 'h:cb190bbd'], ['t_miss', 'h:269aa74f'], ['t_denied', 'user_rejected']] as const) {
      expect(idOf(id), `result ${id}`).toBe(uuid5(NAMESPACE, `${SID}|tool.result|${id}|s:${shape}`));
    }
    for (const id of ['t_read', 't_edit', 't_write']) expect(idOf(id), `result ${id}`).toBe(uuid5(NAMESPACE, `${SID}|tool.result|${id}|v2`)); // a path
    for (const id of ['t_git', 't_main']) expect(idOf(id), `result ${id}`).toBe(uuid5(NAMESPACE, `${SID}|tool.result|${id}`));
  });
});

// #86: a session is read as a stream. What it holds does not grow with it, and what only the whole file knows comes when the file ends.
describe('a session as a stream', () => {
  const here = { host: 'mbp', project: { cwd: '/p', name: 'p' } };

  it('writes events while the file is still being read: after half of 20,000 rounds, about half of the events are out', async () => {
    const ROUNDS = 20_000;
    const events: Event[] = [];
    let out = 0;
    async function* file() {
      for (let r = 0; r < ROUNDS; r++) {
        if (r === ROUNDS / 2) out = events.length;
        const t = `tu_${r}`;
        yield JSON.stringify(assistant('07:00:01', `msg_${r}`, [toolUse(t, 'Bash', { command: 'ls' })], usage(1, 1), { stop: 'tool_use' }));
        yield JSON.stringify(user('07:00:02', [toolResult(t, 'ok')]));
      }
    }
    const session = openSession(SID, 'mbp', () => here.project, (e) => events.push(e), new Set());
    await session.read('main', file());
    session.end();
    expect(events.length).toBeGreaterThan(ROUNDS * 3);
    expect(out).toBeGreaterThan(ROUNDS * 1.4); // a step, a call and a result a round: half of them, less the few messages still in the window
    expect(out).toBeLessThan(events.length / 2);
  });

  it('a message whose lines are broken by other messages is still one step, up to the window; its calls are written with it', async () => {
    const lines = [
      assistant('07:00:01', 'msg_a', [toolUse('ta', 'Bash', { command: 'ls' })], usage(1, 1)),
      assistant('07:00:02', 'msg_b', [{ type: 'text', text: 'b' }], usage(2, 2), { stop: 'end_turn' }),
      assistant('07:00:03', 'msg_a', [{ type: 'text', text: 'a' }], usage(3, 30), { stop: 'tool_use' }), // msg_a again, after msg_b
      user('07:00:04', [toolResult('ta', 'ok')]),
    ];
    const steps = of(await sessionEvents(SID, await digest(lines, 'main'), [], here), 'turn.step');
    expect(steps.map((e) => e.kind === 'turn.step' && [e.data.usage.output, e.data.stop_reason, e.data.tool_use_ids])).toEqual([[2, 'end_turn', []], [30, 'tool_use', ['ta']]]); // by time: msg_a's step is at its last line
  });

  it('a result that comes before its call is still the call\'s result; one with no call at all is left out', async () => {
    const lines = [
      user('07:00:01', [toolResult('t_early', 'boom', true), toolResult('t_nobody', 'ok')]),
      assistant('07:00:02', 'msg_a', [toolUse('t_early', 'Bash', { command: 'pnpm test' })], usage(1, 1), { stop: 'tool_use' }),
    ];
    const evs = await sessionEvents(SID, await digest(lines, 'main'), [], here);
    expect(of(evs, 'tool.result').map((e) => e.kind === 'tool.result' && [e.data.tool_use_id, e.data.success, e.data.duration_ms])).toEqual([['t_early', false, 0]]);
  });

  it('the start of a session and the spawn of a subagent are at the earliest line of the file, which is not always its first', async () => {
    const lines = [user('07:00:10', 'late first line', { promptId: 'p1' }), assistant('07:00:04', 'msg_a', [{ type: 'text', text: 'x' }], usage(1, 1), { stop: 'end_turn' })];
    const aside = sub('q', [user('07:00:30', 'the task'), assistant('07:00:20', 'msg_q', [{ type: 'text', text: 'x' }], usage(1, 1), { stop: 'end_turn' })]);
    const evs = await sessionEvents(SID, await digest(lines, 'main'), [{ digest: await digest(aside, 'sub'), meta: {}, fileAgentId: 'q' }], here);
    expect(of(evs, 'session.start')[0]!.ts).toBe(ms('07:00:04'));
    expect(of(evs, 'agent.spawn')[0]!.ts).toBe(ms('07:00:20'));
    expect(of(evs, 'agent.complete')[0]!.ts).toBe(ms('07:00:30')); // the file's last line, which is its latest
  });

  it('a subagent\'s events carry its own turn and agent while it is read, before its spawn is written', async () => {
    const events: Event[] = [];
    const session = openSession(SID, 'mbp', () => here.project, (e) => events.push(e), new Set());
    await session.read('sub', sub('a1', subLines()).map((l) => JSON.stringify(l)), {}, 'a1');
    expect(events.map((e) => e.kind)).toEqual(['turn.step', 'tool.call', 'tool.result', 'turn.step', 'agent.spawn', 'turn.start', 'turn.complete', 'agent.complete']);
    expect(events.every((e) => e.agent_id === 'a1')).toBe(true);
  });
});

describe('deterministic ids', () => {
  it('the same files give the same event ids, so a second run is all duplicates', async () => {
    const [a, b] = [await events(), await events()];
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });

  it('another session gives other ids, another host the same (the id is the session\'s)', async () => {
    const [a, other, host] = [await events(), await events({ sessionId: 'sess-B' }), await events({ host: 'nas' })];
    expect(new Set(a.map((e) => e.id)).size).toBe(a.length);
    expect(a.some((e) => other.some((o) => o.id === e.id))).toBe(false);
    expect(host.map((e) => e.id)).toEqual(a.map((e) => e.id));
  });

  it('uuid5 is RFC 4122 version 5: the known vector, the version nibble, the variant bits', () => {
    const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(uuid5(DNS, 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(uuid5(DNS, 'x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('projectPath', () => {
  it('strips a /.claude/worktrees/<name> suffix and anything after it', () => {
    expect(projectPath('/Users/a/mobile-app/.claude/worktrees/feat-x')).toBe('/Users/a/mobile-app');
    expect(projectPath('/Users/a/mobile-app/.claude/worktrees/feat-x/packages/server')).toBe('/Users/a/mobile-app');
    expect(projectPath('/Users/a/mobile-app')).toBe('/Users/a/mobile-app');
    expect(projectPath('/Users/a/mobile-app/.claude/agents')).toBe('/Users/a/mobile-app/.claude/agents');
    expect(projectPath('/Users/a/.claude/worktrees-old/x')).toBe('/Users/a/.claude/worktrees-old/x');
  });
});

// v0.3 slice 2 (#42, Worth): Claude Code writes a `pr-link` line when a session opens a PR (its number, repository and URL), and again as the session
// goes on. The import turns each PR of the project's repository into one session.pr: the number, nothing of the URL.
describe('pr-link lines', () => {
  const REMOTE = 'github.com/alfredo1996/agent-orb';
  type Where = { cwd: string; name: string; git_remote?: string };
  const ORB: Where = { cwd: '/Users/a/orb', name: 'orb', git_remote: REMOTE };
  const link = (n: unknown, repo: unknown, time: string, extra: object = {}) =>
    ({ type: 'pr-link', sessionId: SID, prNumber: n, prUrl: `https://github.com/${String(repo)}/pull/${String(n)}`, prRepository: repo, timestamp: at(time), ...extra });
  const base = () => (uuid = 0, [
    user('07:00:00', 'PROMPTWORD one', { promptId: 'p1' }),
    assistant('07:00:02', 'msg_1', [{ type: 'text', text: 'ANSWERWORD' }], usage(1, 2), { stop: 'end_turn' }),
  ]);
  const sub1 = () => sub('a1', [
    user('07:00:03', 'SUBPROMPTWORD'),
    assistant('07:00:05', 'msg_s1', [{ type: 'text', text: 'ANSWERWORD' }], usage(1, 2), { stop: 'end_turn', model: 'claude-haiku-5-5' }),
  ]);
  const run = async (lines: object[], project: Where = ORB, sessionId = SID) => {
    const main = await digest([...base(), ...lines], 'main');
    return await sessionEvents(sessionId, main, [], { host: 'mbp', project });
  };
  const links = (evs: Event[]) => of(evs, 'session.pr').map((e) => (e.kind === 'session.pr' ? e.data.number : -1));

  it('one session.pr per PR of the project\'s repository, however many lines say so, at the first line\'s time, passing the shared schema', async () => {
    const evs = await run([
      link(46, 'alfredo1996/agent-orb', '07:05:00'), link(46, 'alfredo1996/agent-orb', '07:05:30'), link(46, 'alfredo1996/agent-orb', '07:06:00'), // the same PR, three lines
      link(47, 'alfredo1996/agent-orb', '07:20:00'),
    ]);
    const prs = of(evs, 'session.pr');
    expect(prs.map((e) => e.kind === 'session.pr' && [e.data, e.ts])).toEqual([[{ number: 46 }, ms('07:05:00')], [{ number: 47 }, ms('07:20:00')]]);
    for (const e of prs) {
      const parsed = Event.safeParse(e);
      expect(parsed.error).toBeUndefined();
      expect(parsed.data).toEqual(e);
      expect(e).toMatchObject({ session_id: SID, project: ORB, host: 'mbp', user_id: 'local' });
      expect(e).not.toHaveProperty('agent_id');
      expect(e).not.toHaveProperty('turn_id');
    }
    expect(evs.map((e) => e.ts)).toEqual([...evs.map((e) => e.ts)].sort((a, b) => a - b));
  });

  it('only the number: no URL, no repository, no word of the line reaches an event', async () => {
    const evs = await run([link(46, 'alfredo1996/agent-orb', '07:05:00', { prTitle: 'TITLEWORD', extra: 'EXTRAWORD' })]);
    expect(links(evs)).toEqual([46]);
    expect(JSON.stringify(evs)).not.toMatch(/github\.com\/alfredo1996\/agent-orb\/pull|TITLEWORD|EXTRAWORD/);
  });

  it('the ids are fixed by the session and the number: a second run is all duplicates, another session has others, and the first line\'s time does not move them', async () => {
    const a = await run([link(46, 'alfredo1996/agent-orb', '07:05:00'), link(47, 'alfredo1996/agent-orb', '07:20:00')]);
    const b = await run([link(47, 'alfredo1996/agent-orb', '09:20:00'), link(46, 'alfredo1996/agent-orb', '09:05:00')]); // later lines, the other order in the file
    expect(of(b, 'session.pr').map((e) => e.kind === 'session.pr' && e.data.number)).toEqual([46, 47]);
    expect(of(a, 'session.pr').map((e) => e.id)).toEqual(of(b, 'session.pr').map((e) => e.id)); // 46's and 47's, by number, not by time or position
    const other = await run([link(46, 'alfredo1996/agent-orb', '07:05:00', { sessionId: 'sess-B' })], ORB, 'sess-B');
    expect(of(other, 'session.pr')[0]!.id).not.toBe(of(a, 'session.pr')[0]!.id);
    expect(new Set(a.map((e) => e.id)).size).toBe(a.length);
  });

  it('another repository\'s PR is not this project\'s, whatever its number; the owner and repository match without regard to case', async () => {
    const evs = await run([
      link(5, 'someone/else', '07:01:00'), link(6, 'alfredo1996/mobile-app', '07:02:00'), link(7, 'alfredo1996/agent-orb-fork', '07:03:00'), link(8, 'xalfredo1996/agent-orb', '07:04:00'),
      link(9, 'Alfredo1996/Agent-Orb', '07:05:00', { prUrl: 'https://github.com/Alfredo1996/Agent-Orb/pull/9' }),
    ]);
    expect(links(evs)).toEqual([9]);
  });

  it('the host counts: a Git host that is not the remote\'s is not this project, and one that is, is, whatever its name', async () => {
    const onCorp = (n: number) => link(n, 'o/r', '07:05:00', { prUrl: `https://git.corp.example/o/r/pull/${n}` });
    expect(links(await run([onCorp(3), link(4, 'o/r', '07:06:00')], { cwd: '/x', name: 'r', git_remote: 'github.com/o/r' }))).toEqual([4]);
    expect(links(await run([onCorp(3), link(4, 'o/r', '07:06:00')], { cwd: '/x', name: 'r', git_remote: 'git.corp.example/o/r' }))).toEqual([3]);
    // a line with no usable URL is taken for github.com
    expect(links(await run([link(5, 'o/r', '07:05:00', { prUrl: undefined }), link(6, 'o/r', '07:06:00', { prUrl: 'not a url' })], { cwd: '/x', name: 'r', git_remote: 'github.com/o/r' }))).toEqual([5, 6]);
  });

  it('a project with no remote (the import knows none) links nothing: it cannot tell whose PR it is', async () => {
    expect(links(await run([link(46, 'alfredo1996/agent-orb', '07:05:00')], { cwd: '/Users/a/orb', name: 'orb' }))).toEqual([]);
  });

  it('a line of another session (a resumed file copies the history it resumed) is that session\'s, not this one\'s', async () => {
    const evs = await run([link(46, 'alfredo1996/agent-orb', '07:05:00', { sessionId: 'sess-OLD' }), link(47, 'alfredo1996/agent-orb', '07:06:00')]);
    expect(links(evs)).toEqual([47]);
    expect(of(evs, 'session.pr')[0]!.session_id).toBe(SID);
  });

  it('a line that is not one is skipped, and the rest still count: no number, a number that is not a positive integer, no repository, no session, no usable time', async () => {
    const evs = await run([
      link(undefined, 'alfredo1996/agent-orb', '07:01:00'), link(0, 'alfredo1996/agent-orb', '07:01:00'), link(-3, 'alfredo1996/agent-orb', '07:01:00'), link(1.5, 'alfredo1996/agent-orb', '07:01:00'),
      link('46', 'alfredo1996/agent-orb', '07:01:00'), link(2, undefined, '07:01:00'), link(3, '', '07:01:00'), link(4, 'alfredo1996/agent-orb', '07:01:00', { sessionId: undefined }),
      link(5, 'alfredo1996/agent-orb', '07:01:00', { timestamp: 'yesterday' }), link(6, 'alfredo1996/agent-orb', '07:01:00', { timestamp: undefined }), link(7, 'alfredo1996/agent-orb', '07:01:00', { timestamp: 20261020 }),
      link(8, 'alfredo1996/agent-orb', '07:07:00'),
    ]);
    expect(links(evs)).toEqual([8]);
  });

  it('a pr-link line is no activity: a file with nothing else makes no events, and it does not stretch the session\'s first or last time', async () => {
    const main = await digest([link(46, 'alfredo1996/agent-orb', '07:05:00')], 'main');
    expect(await sessionEvents(SID, main, [], { host: 'mbp', project: ORB })).toEqual([]);
    const evs = await run([link(46, 'alfredo1996/agent-orb', '23:59:00')]);
    expect(of(evs, 'session.start')[0]!.ts).toBe(ms('07:00:00'));
    expect(of(evs, 'turn.complete').map((e) => e.ts)).toEqual([ms('07:00:02')]); // the turn ends at its last step, not at the link
  });

  it('the lines are read from the main file only: a subagent\'s file gives none', async () => {
    const seen = new Set<string>();
    const main = await digest(base(), 'main', seen);
    const sub = await digest([...sub1(), link(46, 'alfredo1996/agent-orb', '07:05:00')], 'sub', seen);
    const evs = await sessionEvents(SID, main, [{ digest: sub, meta: { agentType: 'Explore' }, fileAgentId: 'a1' }], { host: 'mbp', project: ORB });
    expect(links(evs)).toEqual([]);
  });
});
