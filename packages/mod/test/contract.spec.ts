import { describe, expect, it } from 'vitest';
import * as shared from '../../shared/src/index.ts';
import { COMMAND_CLASSES, ERROR_CLASSES, EVENT_KINDS, Event, MODEL_FAMILIES, NAMED_SHAPES, ROLES } from '../../shared/src/index.ts';
import { COMMANDS, ERRORS, OTHER_SHAPE, SAME_SHAPE, SHAPES } from '../../shared/test/class-tables.ts';
import * as mod from '../hooks/core.ts';
import { build, FAMILIES, MOD_COMMAND_CLASSES, MOD_ERROR_CLASSES, MOD_NAMED_SHAPES, MOD_ROLES, modelLabel, roleFromFrontmatter, type Ctx, type Ev, type Stall } from '../hooks/core.ts';

// Every event the mod builds must pass the server's schema unchanged: a 400 at /ingest drops a whole batch.
const ctx: Ctx = { host: 'mbp', session_id: '7c382b05-db56-4408-86a2-6fb99f53d4dc', project: { cwd: '/r', name: 'r', git_remote: 'github.com/o/r', git_branch: 'dev' } };
const api = { input_tokens: 2, output_tokens: 218, cache_read_input_tokens: 12_540, cache_creation_input_tokens: 22_227 };
const sub = { agentId: 'aa7c7bc35d0215c9c', turnId: 't-2' };
const stall: Stall = { key: 'toolu_1', agent: 'aa7c7bc35d0215c9c', tool_use_id: 'toolu_1', tool: 'WebFetch', since: 1_792_400_000_000 };

const built: Ev[] = [
  build.sessionStart(ctx, 'claude-haiku-5-5', '2.1.299', false),
  build.sessionStart({ ...ctx, project: { ...ctx.project, checkout: '/r/.claude/worktrees/w' } }, 'claude-haiku-5-5', '2.1.308', false), // a worktree session (v0.2 slice 3)
  build.sessionEnd(ctx, 'other'),
  build.sessionCompact(ctx, 180_000, 40_000),
  build.prompt(ctx, 332, 'p-1'),
  build.turnStart(ctx, { turnId: 't-1' }, 'p-1'),
  build.turnStart(ctx, sub),
  build.turnStep(ctx, sub, 'claude-haiku-5-5', api, 'tool_use'),
  build.turnStep(ctx, { turnId: 't-1' }, 'claude-haiku-5-5', null, null),
  build.turnComplete(ctx, { turnId: 't-1' }, 15_989, api, 'answer', 164, 61.4),
  build.agentSpawn(ctx, { agentId: sub.agentId, toolUseId: 'toolu_a', type: 'Explore', description: 'Find ROLES', model: 'claude-haiku-5-5', promptLength: 261, declaredRole: 'researcher' }),
  build.agentSpawn(ctx, { agentId: 'a-3', toolUseId: 'toolu_c', type: 'implementer', description: 'Build it', model: 'claude-opus-5-5', promptLength: 8, declaredRole: 'developer', declaredModel: 'sonnet', modelCheck: { allowed: 'sonnet', source: 'file' } }),
  build.agentSpawn(ctx, { agentId: 'a-4', toolUseId: 'toolu_d', type: 'workflow-subagent', description: 'Review', model: 'claude-opus-5-5', promptLength: 8, modelCheck: { allowed: 'sonnet', source: 'ceiling' } }),
  build.agentComplete(ctx, sub.agentId, 5_962, { input: 4, output: 337, cache_read: 18_744, cache_creation: 20_152 }, 31),
  build.toolCall(ctx, sub, 'toolu_g', 'Grep', 40),
  build.toolResult(ctx, sub, { toolUseId: 'toolu_g', success: false, errorType: 'error', durationMs: 12, outputSize: 0, files: [] }),
  // v0.3 slice 1 (#43): a Bash call carries its command class, a failed result its error class
  build.toolCall(ctx, sub, 'toolu_t', 'Bash', 30, undefined, 'test'),
  build.toolResult(ctx, sub, { toolUseId: 'toolu_t', success: false, errorType: 'error', errorClass: 'exit_code', durationMs: 4_000, outputSize: 812, files: [] }),
  build.toolResult(ctx, sub, { toolUseId: 'toolu_sl', success: false, errorType: 'error', errorClass: 'refused', errorShape: 'sleep_blocked', durationMs: 1, outputSize: 90, files: [] }), // v0.3 slice 3 (#45): a named shape
  build.toolResult(ctx, sub, { toolUseId: 'toolu_h', success: false, errorType: 'error', errorClass: 'exit_code', errorShape: 'h:a0038b0f', durationMs: 1, outputSize: 90, files: [] }), // and a hash
  build.toolResult(ctx, {}, { toolUseId: 'toolu_r', success: true, durationMs: 3, outputSize: 533, files: [{ path: 'PROJECT.md', mode: 'read' }] }),
  build.toolWaiting(ctx, sub, 'toolu_b', 'Bash'),
  build.skillLoad(ctx, { turnId: 't-1' }, { skill: 'ponytail:ponytail-help', how: 'tool', plugin: 'ponytail', toolUseId: 'toolu_s', source: 'plugin', description: 'Help', refs: { skills: ['pr'], agents: [] } }),
  build.skillLoad(ctx, sub, { skill: 'beta', how: 'preload' }),
  build.skillsCatalog(ctx, [{ name: 'alpha', source: 'projectSettings', tokens: 19, description: 'Probe', refs: { skills: ['beta'], agents: ['scout'] } }, { name: 'ponytail:ponytail', source: 'plugin', plugin: 'ponytail', tokens: 209 }],
    [{ name: 'scout', source: 'projectSettings', tokens: 15, refs: { skills: [], agents: [] }, preload: ['beta'] }]),
  build.projectChanges(ctx, [{ sha: 'c3f9a2e0d2c49f7a8a3e1a6a1f2f1f5a4c9d3e2b', ts: 1_792_200_000_000, subject: 'feat: the agents arrive', files: ['.claude/agents/implementer.md', 'CLAUDE.md'], blobs: ['1'.repeat(40), '2'.repeat(40)] }, { sha: 'a'.repeat(40), ts: 1_792_100_000_000, files: [], blobs: [] }]),
  build.projectFingerprint(ctx, [{ path: '.claude/agents/implementer.md', hash: '1'.repeat(40), scope: 'project' }, { path: '~/.claude/rules/git.md', hash: '2'.repeat(40), scope: 'user' }]),
  // v0.3 slice 2 (#42, Worth): the merged PRs (an excluded project's carry no title or branch) and a session's PR link, which is its number alone
  build.projectPrs(ctx, [{ number: 73, title: 'feat: v0.3 slice 1', merged_at: 1_792_400_000_000, additions: 1030, deletions: 24, head: 'feat/43-classes', counted_lines: 812, counted_files: 9 }, { number: 72, merged_at: 1_792_300_000_000, additions: 0, deletions: 0 }]),
  build.sessionPr(ctx, 73),
  build.stall(ctx, 'start', stall),
  build.stall(ctx, 'end', { key: 'agent:main', agent: 'main', since: 1_792_400_000_000 }),
  build.dropped(ctx, 3, 1_792_400_000_000),
  build.task(ctx, sub, 'create', '1', 'Write the writer', 'pending'),
  build.task(ctx, {}, 'complete', '1', 'Write the writer', 'completed'),
  // with content on (§15, 2026-10-20)
  build.sessionStart(ctx, 'claude-haiku-5-5', '2.1.299', true, 'full'),
  build.prompt(ctx, 14, 'p-2', 'fix the writer'),
  build.turnStep(ctx, sub, 'claude-haiku-5-5', api, 'end_turn', { answer: 'Done.', thinking: 'Check the cap first.' }),
  build.agentSpawn(ctx, { agentId: 'a-2', toolUseId: 'toolu_b', type: 'Explore', description: 'd', model: 'm', promptLength: 13, prompt: 'Find the docs' }),
  build.toolCall(ctx, sub, 'toolu_c', 'Bash', 20, '{"command":"ls"}'),
  build.toolResult(ctx, sub, { toolUseId: 'toolu_c', success: true, durationMs: 3, outputSize: 2, files: [], output: 'ok' }),
  build.toolResult(ctx, sub, { toolUseId: 'toolu_e', success: true, durationMs: 1, outputSize: 9, files: [], outputSkipped: 'env-file' }),
];

describe('the mod speaks the server schema', () => {
  it.each(built.map((e) => [e.kind, e] as const))('%s passes unchanged', (_kind, e) => {
    const parsed = Event.safeParse(e);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toEqual(e); // nothing stripped: the mod sends no field the schema does not know
  });

  it('builds every kind the schema has', () => {
    expect(EVENT_KINDS.filter((k) => !built.some((e) => e.kind === k))).toEqual([]);
  });

  it('the main agent has no agent_id', () => {
    expect(build.turnStart(ctx, { turnId: 't-1' })).not.toHaveProperty('agent_id');
    expect(build.stall(ctx, 'end', { key: 'agent:main', agent: 'main', since: 1 })).not.toHaveProperty('agent_id');
  });
});

describe('helpers', () => {
  it('reads orb-role from the frontmatter only, and only a §7 role', () => {
    expect(roleFromFrontmatter('---\nname: implementer\norb-role: developer\n---\nbody orb-role: tester')).toBe('developer');
    expect(roleFromFrontmatter('---\norb-role: boss\n---')).toBeUndefined();
    expect(roleFromFrontmatter('no frontmatter\norb-role: tester')).toBeUndefined();
  });

  it('labels models', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(modelLabel('gpt-x')).toBe('gpt-x');
  });
});

describe('roles (issue #8)', () => {
  it('the mod accepts exactly the server\'s roles, so an orb-role the server takes is never dropped here', () => {
    expect([...MOD_ROLES].sort()).toEqual([...ROLES].sort());
    expect(roleFromFrontmatter('---\norb-role: generalist\n---\n')).toBe('generalist');
  });
});

describe('model families (v0.2 slice 2)', () => {
  it('the mod ranks exactly the families the server accepts in model_check, so a flag the mod raises is never dropped', () => {
    expect([...FAMILIES]).toEqual([...MODEL_FAMILIES]);
  });

  it('a flagged spawn carries the declared model and the check; an unflagged one carries neither', () => {
    const flagged = build.agentSpawn(ctx, { agentId: 'a-3', toolUseId: 't', type: 'implementer', description: 'd', model: 'm', promptLength: 1, declaredModel: 'sonnet', modelCheck: { allowed: 'sonnet', source: 'file' } });
    expect(flagged.data).toMatchObject({ declared_model: 'sonnet', model_check: { allowed: 'sonnet', source: 'file' } });
    const plain = build.agentSpawn(ctx, { agentId: 'a-3', toolUseId: 't', type: 'implementer', description: 'd', model: 'm', promptLength: 1 });
    expect(plain.data).not.toHaveProperty('declared_model');
    expect(plain.data).not.toHaveProperty('model_check');
  });
});

describe('error and command classes (v0.3 slice 1, #43)', () => {
  it('the mod names exactly the classes the server accepts, so a class it sends is never refused', () => {
    expect([...MOD_ERROR_CLASSES]).toEqual([...ERROR_CLASSES]);
    expect([...MOD_COMMAND_CLASSES]).toEqual([...COMMAND_CLASSES]);
  });

  it.each(COMMANDS.map(([cls, command]) => [cls, command.slice(0, 80), command] as const))('both copies read %s: %j', (cls, _label, command) => {
    expect(mod.commandClass(command)).toBe(cls);
    expect(shared.commandClass(command)).toBe(mod.commandClass(command));
  });

  it.each(ERRORS.map(([cls, tool, text, denied]) => [cls, tool, text.slice(0, 60), text, denied] as const))('both copies read %s: %s %j', (cls, tool, _label, text, denied) => {
    expect(mod.errorClass(tool, text, denied)).toBe(cls);
    expect(shared.errorClass(tool, text, denied)).toBe(mod.errorClass(tool, text, denied));
  });

  it('both copies name the same patterns, and read every row of the shape table as the table says', () => {
    expect([...MOD_NAMED_SHAPES]).toEqual([...NAMED_SHAPES]);
    for (const [expected, tool, text, command] of SHAPES) {
      expect(mod.errorShape(tool, text, command), `${tool} ${JSON.stringify(text.slice(0, 60))}`).toBe(expected);
      expect(shared.errorShape(tool, text, command)).toBe(mod.errorShape(tool, text, command));
    }
  });

  it('both copies make one shape of the pairs that differ in a path or a number, and two of the others', () => {
    for (const [a, b] of [...SAME_SHAPE, ...OTHER_SHAPE]) {
      for (const [, tool, text, command] of [a, b]) expect(mod.errorShape(tool, text, command)).toBe(shared.errorShape(tool, text, command));
    }
    for (const [a, b] of SAME_SHAPE) expect(mod.errorShape(a[1], a[2], a[3])).toBe(mod.errorShape(b[1], b[2], b[3]));
    for (const [a, b] of OTHER_SHAPE) expect(mod.errorShape(a[1], a[2], a[3])).not.toBe(mod.errorShape(b[1], b[2], b[3]));
  });

  it('both copies read the same first line', () => {
    for (const text of ['Exit code 1\n\n  <tool_use_error>  \nFAIL x\nmore', '<tool_use_error>String to replace not found</tool_use_error>', 'Exit code 1', 'Exit code 1 and more', `${'\n'.repeat(1000)}late`, '']) {
      expect(mod.firstLine(text)).toBe(shared.firstLine(text));
    }
  });

  it('both copies name the same files for a call', () => {
    const root = '/Users/a/mobile-app';
    for (const [tool, input] of [
      ['Read', { file_path: `${root}/src/a.ts` }], ['Edit', { file_path: `${root}/src/a.ts` }], ['Write', { file_path: `${root}/README.md` }],
      ['NotebookEdit', { notebook_path: `${root}/nb.ipynb` }], ['MultiEdit', { file_path: `${root}/b.ts` }], ['Read', { file_path: '/elsewhere/a.ts' }],
      ['Read', { file_path: `${root}-2/a.ts` }], ['Grep', { path: `${root}/src` }], ['Bash', { command: 'ls' }],
    ] as const) expect(mod.filesTouched(tool, input, root)).toEqual(shared.filesTouched(tool, input, root));
  });

  it('a Bash call and a failed result carry the class and nothing of the text', () => {
    const call = build.toolCall(ctx, {}, 'toolu_x', 'Bash', 30, undefined, mod.commandClass('pnpm -C /x test'));
    expect(call.data).toEqual({ tool_use_id: 'toolu_x', tool: 'Bash', input_size: 30, command_class: 'test' });
    const result = build.toolResult(ctx, {}, { toolUseId: 'toolu_x', success: false, errorType: 'error', errorClass: mod.errorClass('Bash', 'Exit code 1\nFAIL x'), durationMs: 1, outputSize: 20, files: [] });
    expect(result.data).toEqual({ tool_use_id: 'toolu_x', success: false, error_type: 'error', error_class: 'exit_code', duration_ms: 1, output_size: 20, files_touched: [] });
    const sleeping = build.toolResult(ctx, {}, { toolUseId: 'toolu_z', success: false, errorType: 'error', errorClass: 'refused', errorShape: mod.errorShape('Bash', 'Blocked: sleep 30 followed by: tail -f /private/tmp/SECRETWORD', 'other'), durationMs: 1, outputSize: 61, files: [] });
    expect(sleeping.data).toEqual({ tool_use_id: 'toolu_z', success: false, error_type: 'error', error_class: 'refused', error_shape: 'sleep_blocked', duration_ms: 1, output_size: 61, files_touched: [] });
    expect(JSON.stringify(sleeping)).not.toMatch(/SECRETWORD|tail/);
    const bare = build.toolResult(ctx, {}, { toolUseId: 'toolu_b', success: false, errorType: 'error', errorClass: 'exit_code', errorShape: mod.errorShape('Bash', 'Exit code 1', 'test'), durationMs: 1, outputSize: 11, files: [] });
    expect(bare.data).not.toHaveProperty('error_shape'); // a bare exit code has none
    expect(build.toolCall(ctx, {}, 'toolu_y', 'Read', 5).data).not.toHaveProperty('command_class');
    expect(build.toolResult(ctx, {}, { toolUseId: 'toolu_y', success: true, durationMs: 1, outputSize: 1, files: [] }).data).not.toHaveProperty('error_class');
    expect(build.toolResult(ctx, {}, { toolUseId: 'toolu_y', success: true, durationMs: 1, outputSize: 1, files: [] }).data).not.toHaveProperty('error_shape');
  });
});
