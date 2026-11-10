import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, Event, IngestBatch, capText } from '../src/index.ts';

const base = {
  v: 1,
  ts: 1_792_400_000_000,
  host: 'alfredo-mbp',
  user_id: 'alfredo',
  session_id: 's-1',
  project: { cwd: '/Users/alfredo/agent-orb', name: 'agent-orb', git_branch: 'dev' },
};
let n = 0;
const ev = (kind: string, data: object, extra: object = {}) => ({
  ...base,
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  kind,
  data,
  ...extra,
});
const usage = { input: 10, output: 20, cache_read: 30, cache_creation: 40 };

const examples = [
  ev('session.start', { model: 'claude-opus-5-5', source: 'startup', claude_version: '2.1.299', plugin_version: '0.0.0' }),
  ev('session.end', { reason: 'exit' }),
  ev('session.compact', { tokens_before: 180_000, tokens_after: 40_000 }),
  ev('prompt.submit', { length: 42 }, { prompt_id: 'p-1' }),
  ev('turn.start', {}, { turn_id: 't-1' }),
  ev('turn.step', { model: 'claude-opus-5-5', usage, stop_reason: 'tool_use', tool_use_ids: ['toolu_1'] }, { turn_id: 't-1' }),
  ev('turn.complete', { duration_ms: 5000, usage_total: usage, reason: 'answer', answer_length: 300 }, { turn_id: 't-1' }),
  ev('agent.spawn', { tool_use_id: 'toolu_2', agent_type: 'Explore', description: 'Find docs', model: 'claude-haiku-5-5', prompt_length: 900 }, { agent_id: 'a-1' }),
  ev('agent.complete', { duration_ms: 60_000, usage_total: usage, report_length: 1200 }, { agent_id: 'a-1' }),
  ev('tool.call', { tool_use_id: 'toolu_1', tool: 'Read', input_size: 64 }, { turn_id: 't-1' }),
  ev('tool.result', { tool_use_id: 'toolu_1', success: true, duration_ms: 12, output_size: 2048, files_touched: [{ path: 'src/a.ts', mode: 'read' }] }),
  ev('skill.load', { skill: 'pr-body', plugin: 'house' }),
  ev('task.create', { task_id: '1', subject: 'Write the writer', status: 'pending' }),
  ev('task.complete', { task_id: '1', subject: 'Write the writer', status: 'completed' }),
  ev('stall.start', { tool_use_id: 'toolu_3', tool: 'WebFetch', since: 1_792_399_000_000 }, { agent_id: 'a-1' }),
  ev('stall.end', { tool_use_id: 'toolu_3', tool: 'WebFetch', since: 1_792_399_000_000 }, { agent_id: 'a-1' }),
  ev('tool.waiting', { tool_use_id: 'toolu_4', tool: 'Bash' }, { agent_id: 'a-1' }),
  ev('outbox.dropped', { count: 1234, since: 1_792_399_500_000 }),
  ev('project.changes', { commits: [{ sha: '0dd1cc0ffee0dd1cc0ffee0dd1cc0ffee0dd1cc0', ts: 1_792_300_000_000, subject: 'feat: the agents arrive', files: ['.claude/agents/implementer.md', 'CLAUDE.md'], blobs: ['1'.repeat(40), '2'.repeat(40)] }, { sha: 'c3f9a2e', ts: 1_792_200_000_000, files: [] }] }),
  ev('project.prs', { prs: [{ number: 141, title: 'feat(api): export photos as a zip', merged_at: 1_792_300_000_000, additions: 1288, deletions: 47, head: 'feat/zip-export' }, { number: 129, merged_at: 1_792_200_000_000, additions: 0, deletions: 0 }] }),
  ev('session.pr', { number: 141 }),
  // v0.4 slice 1 (#27, Factory)
  ev('findings.report', { branch: 'fix/409-token-retry', findings: [{ id: 'F12', severity: 'major', file: 'src/auth/refresh.ts', fate: 'open', title: 'Two refreshes race' }, { id: 'F09', severity: 'minor', file: 'b.ts', fate: 'dismissed', why: 'Used once' }], dropped: 0 }, { agent_id: 'a-1', turn_id: 't-1' }),
  ev('gate.report', { result: 'pass', commit: 'a1b2c3d' }, { agent_id: 'a-2', turn_id: 't-2' }),
  ev('project.open_prs', { prs: [{ number: 416, head: 'fix/409-token-retry', head_oid: 'e'.repeat(40), merge_state: 'UNSTABLE', last_commit_at: 1_792_400_000_000, checks: [{ name: 'Unit tests', state: 'pass' }], bots: [{ author: 'coderabbitai', at: 1_792_400_100_000 }] }] }),
  // v0.4 slice 3 (#29): the Mac's memory and its containers
  ev('machine.sample', { mem_free: 6_200_000_000, mem_total: 36_000_000_000, docker: 'ok', containers: [
    { name: 'mobile-app-db-1', created_at: 1_792_400_000_000, state: 'running', health: 'healthy', memory: 104_857_600, compose: 'mobile-app', working_dir: '/Users/a/mobile-app/deploy' },
    { name: 'quirky_curie', state: 'running', memory: 52_428_800, testcontainers: { session: '3f2a9b' } },
    { state: 'running', health: 'unhealthy', memory: 1_048_576, excluded: true },
  ] }),
  // v0.4 slice 5 (#31): the session ended its turn because the studio asked
  ev('session.stopped', { aborted: true }),
  ev('project.fingerprint', { files: [{ path: '.claude/agents/implementer.md', hash: '1'.repeat(40), scope: 'project' }, { path: '~/.claude/rules/git.md', hash: 'a'.repeat(64), scope: 'user' }] }),
  ev('skills.catalog', {
    skills: [{ name: 'alpha', source: 'projectSettings', tokens: 19, description: 'Runs beta', refs: { skills: ['beta'], agents: ['scout'] } }, { name: 'p:x', source: 'plugin', plugin: 'p', tokens: 40 }],
    agents: [{ name: 'scout', source: 'projectSettings', tokens: 15, refs: { skills: ['beta'], agents: [] }, preload: ['beta'] }],
  }),
];

describe('Event schema', () => {
  it('caps a skill description at 300 characters, in a load and in the catalogue (Slice 5)', () => {
    const long = 'd'.repeat(2_000);
    const load = Event.parse(ev('skill.load', { skill: 'alpha', how: 'typed', description: long }));
    const catalog = Event.parse(ev('skills.catalog', { skills: [{ name: 'alpha', source: 'projectSettings', tokens: 1, description: long }], agents: [] }));
    expect(load.kind === 'skill.load' && load.data.description!.length).toBeLessThanOrEqual(300);
    expect(catalog.kind === 'skills.catalog' && catalog.data.skills[0]!.description!.length).toBeLessThanOrEqual(300);
  });

  it('project.changes: metadata of commits that touched the agents, skills or CLAUDE.md (Slice 1 of v0.2)', () => {
    const changes = (commits: unknown) => ev('project.changes', { commits });
    const commit = { sha: 'c3f9a2e', ts: 1_792_200_000_000, files: ['CLAUDE.md'] };
    expect(Event.safeParse(changes([commit])).success).toBe(true);
    expect(Event.safeParse(changes(Array(500).fill(commit))).success).toBe(true);
    expect(Event.safeParse(changes(Array(501).fill(commit))).success).toBe(false);
    for (const sha of ['abc123', 'C3F9A2E', 'c3f9a2g', 'a'.repeat(41), '']) expect(Event.safeParse(changes([{ ...commit, sha }])).success).toBe(false);
    for (const sha of ['a'.repeat(7), 'a'.repeat(40)]) expect(Event.safeParse(changes([{ ...commit, sha }])).success).toBe(true);
    expect(Event.safeParse(changes([{ ...commit, ts: 0 }])).success).toBe(false);
    expect(Event.safeParse(changes([{ ...commit, files: Array.from({ length: 51 }, (_, i) => `f${i}`) }])).success).toBe(false);
    expect(Event.safeParse(changes([{ ...commit, files: Array.from({ length: 50 }, (_, i) => `f${i}`) }])).success).toBe(true);
    expect(Event.safeParse(changes([{ sha: commit.sha, ts: commit.ts }])).success).toBe(false); // files is required
  });

  it('project.changes caps a subject at 200 characters and strips every key it does not name', () => {
    const e = Event.parse(ev('project.changes', { commits: [{ sha: 'c3f9a2e', ts: 1, subject: 's'.repeat(900), files: [], body: 'a commit message body' }] }));
    const c = e.kind === 'project.changes' ? e.data.commits[0]! : undefined;
    expect(c?.subject).toHaveLength(200);
    expect(c).not.toHaveProperty('body');
  });

  it('project.changes: a commit may carry the new blob of each file, parallel to files (v0.2 slice 3)', () => {
    const changes = (c: object) => ev('project.changes', { commits: [{ sha: 'c3f9a2e', ts: 1_792_200_000_000, ...c }] });
    const blob = (c: string) => c.repeat(40);
    expect(Event.safeParse(changes({ files: ['a.md', 'b.md'], blobs: [blob('1'), blob('2')] })).success).toBe(true);
    expect(Event.safeParse(changes({ files: ['a.md'] })).success).toBe(true); // an older plugin sends none
    expect(Event.safeParse(changes({ files: ['a.md'], blobs: ['0'.repeat(40)] })).success).toBe(true); // a deletion is the all-zero blob
    expect(Event.safeParse(changes({ files: ['a.md'], blobs: ['b'.repeat(64)] })).success).toBe(true); // a SHA-256 repository
    expect(Event.safeParse(changes({ files: ['a.md', 'b.md'], blobs: [blob('1')] })).success).toBe(false); // not parallel
    expect(Event.safeParse(changes({ files: ['a.md'], blobs: [blob('1'), blob('2')] })).success).toBe(false);
    for (const bad of ['', 'abc', 'G'.repeat(40), 'A'.repeat(40), 'a'.repeat(65)]) expect(Event.safeParse(changes({ files: ['a.md'], blobs: [bad] })).success).toBe(false);
  });

  it('project.fingerprint: at most 1000 files, each a path, a git blob id and a scope (v0.2 slice 3)', () => {
    const fp = (files: unknown) => ev('project.fingerprint', { files });
    const file = { path: 'CLAUDE.md', hash: 'a'.repeat(40), scope: 'project' };
    expect(Event.safeParse(fp([file])).success).toBe(true);
    expect(Event.safeParse(fp([])).success).toBe(true);
    expect(Event.safeParse(fp(Array(1000).fill(file))).success).toBe(true);
    expect(Event.safeParse(fp(Array(1001).fill(file))).success).toBe(false);
    expect(Event.safeParse(fp([{ ...file, scope: 'user', path: '~/.claude/CLAUDE.md' }])).success).toBe(true);
    for (const scope of ['team', '', undefined]) expect(Event.safeParse(fp([{ ...file, scope }])).success).toBe(false);
    for (const hash of ['', 'abc', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(65), 'deleted']) expect(Event.safeParse(fp([{ ...file, hash }])).success).toBe(false);
    expect(Event.safeParse(fp([{ ...file, path: '' }])).success).toBe(false);
    expect(Event.safeParse(fp([{ hash: file.hash, scope: 'project' }])).success).toBe(false); // path is required
  });

  it('project.fingerprint strips every key it does not name (a file\'s content never rides along)', () => {
    const e = Event.parse(ev('project.fingerprint', { files: [{ path: 'CLAUDE.md', hash: 'a'.repeat(40), scope: 'project', content: 'secret text' }], note: 'x' }));
    expect(JSON.stringify(e)).not.toMatch(/secret text|"note"/);
  });

  it('project.prs: the merged PRs of the past 90 days, at most 500, each a number, a merge time and its size in lines (v0.3 slice 2)', () => {
    const prs = (list: unknown) => ev('project.prs', { prs: list });
    const pr = { number: 141, title: 'feat: x', merged_at: 1_792_300_000_000, additions: 10, deletions: 2, head: 'feat/x' };
    expect(Event.safeParse(prs([pr])).success).toBe(true);
    expect(Event.safeParse(prs([])).success).toBe(true);
    expect(Event.safeParse(prs(Array(500).fill(pr))).success).toBe(true);
    expect(Event.safeParse(prs(Array(501).fill(pr))).success).toBe(false);
    const { title: _t, head: _h, ...bare } = pr;
    expect(Event.safeParse(prs([bare])).success).toBe(true); // an excluded project sends neither
    for (const number of [0, -1, 1.5, '141', undefined]) expect(Event.safeParse(prs([{ ...pr, number }])).success, String(number)).toBe(false);
    for (const merged_at of [0, -1, 1.5, '2026-10-25T10:00:00Z', undefined]) expect(Event.safeParse(prs([{ ...pr, merged_at }])).success, String(merged_at)).toBe(false);
    for (const k of ['additions', 'deletions'] as const) for (const v of [-1, 1.5, undefined]) expect(Event.safeParse(prs([{ ...pr, [k]: v }])).success, `${k} ${v}`).toBe(false);
    expect(Event.safeParse(prs([{ ...pr, head: '' }])).success).toBe(false);
  });

  it('project.prs: counted_lines and counted_files are optional counts (#103), so an older plugin\'s events stay valid, and a count is a whole number from 0 up', () => {
    const prs = (list: unknown) => ev('project.prs', { prs: list });
    const pr = { number: 141, merged_at: 1_792_300_000_000, additions: 10, deletions: 2 };
    expect(Event.safeParse(prs([pr])).success).toBe(true); // an older plugin sends neither
    expect(Event.safeParse(prs([{ ...pr, counted_lines: 0, counted_files: 0 }])).success).toBe(true);
    const e = Event.parse(prs([{ ...pr, counted_lines: 1288, counted_files: 14 }]));
    expect(e.kind === 'project.prs' && e.data.prs[0]).toMatchObject({ counted_lines: 1288, counted_files: 14 }); // and they are kept, not stripped
    for (const k of ['counted_lines', 'counted_files'] as const) for (const v of [-1, 1.5, '3', null]) expect(Event.safeParse(prs([{ ...pr, [k]: v }])).success, `${k} ${v}`).toBe(false);
    expect(Event.safeParse(prs([{ ...pr, counted_lines: 5 }])).success).toBe(true); // one without the other is a PR a sender half-knew: the server sizes only when it has both
  });

  it('project.prs caps a title and a head at 200 characters and strips every key it does not name (a PR body never rides along)', () => {
    const e = Event.parse(ev('project.prs', { prs: [{ number: 1, title: 't'.repeat(900), head: 'h'.repeat(900), merged_at: 1, additions: 0, deletions: 0, body: 'the description of the PR', author: 'someone' }] }));
    const p = e.kind === 'project.prs' ? e.data.prs[0]! : undefined;
    expect(p?.title).toHaveLength(200);
    expect(p?.head).toHaveLength(200);
    expect(JSON.stringify(e)).not.toMatch(/the description|someone/);
  });

  it('session.pr: a PR number and nothing else (v0.3 slice 2)', () => {
    expect(Event.safeParse(ev('session.pr', { number: 7 })).success).toBe(true);
    for (const number of [0, -3, 1.5, '7', undefined]) expect(Event.safeParse(ev('session.pr', { number })).success, String(number)).toBe(false);
    const e = Event.parse(ev('session.pr', { number: 7, url: 'https://github.com/o/r/pull/7', title: 'a title' }));
    expect(e.data).toEqual({ number: 7 }); // only the number leaves the machine
  });

  it('findings.report, gate.report, project.open_prs: a fate is one of three, a commit is hex, and a comment\'s text has no field to travel in (v0.4 slice 1)', () => {
    const f = (finding: object) => ev('findings.report', { branch: 'b', findings: [{ id: 'F1', severity: 'major', file: 'a.ts', fate: 'open', ...finding }], dropped: 0 });
    // the PR the fence named, with or without a branch; one of the two at least
    expect(Event.safeParse(ev('findings.report', { pr: 416, findings: [], dropped: 0 })).success).toBe(true);
    expect(Event.safeParse(ev('findings.report', { branch: 'b', pr: 416, findings: [], dropped: 0 })).success).toBe(true);
    for (const bad of [{}, { pr: 0 }, { pr: 4.5 }, { pr: '416' }]) expect(Event.safeParse(ev('findings.report', { ...bad, findings: [], dropped: 0 })).success, JSON.stringify(bad)).toBe(false);
    for (const bad of [{ fate: 'wontfix' }, { severity: 'Major' }, { id: 'F 1' }, { file: '' }]) expect(Event.safeParse(f(bad)).success, JSON.stringify(bad)).toBe(false);
    expect(Event.parse(f({ fate: 'dismissed', title: 't'.repeat(250), why: 'w'.repeat(400) })).data).toMatchObject({ findings: [{ title: 't'.repeat(200), why: 'w'.repeat(300) }] });
    for (const commit of ['a1b2c3', 'A1B2C3D', 'a1b2c3d '.trim() + 'g']) expect(Event.safeParse(ev('gate.report', { result: 'pass', commit })).success, commit).toBe(false);
    expect(Event.safeParse(ev('gate.report', { result: 'passed', commit: 'a1b2c3d' })).success).toBe(false);
    const read = Event.parse(ev('project.open_prs', { prs: [{ number: 1, head_oid: 'e'.repeat(40), merge_state: 'CLEAN', checks: [], bots: [{ author: 'coderabbitai', at: 1, body: 'the review text' }], title: 'a title', comments: ['x'] }] }));
    expect(JSON.stringify(read)).not.toMatch(/review text|a title|comments/);
  });

  it('project.open_prs issues: the numbers an issue mentions travel, at most 20, and its body has no field to travel in (v0.5 slice 1, #66)', () => {
    const read = (issue: object) => ev('project.open_prs', { prs: [], issues: [{ number: 409, ...issue }] });
    expect(Event.parse(read({ mentions: [12, 7] })).data).toEqual({ prs: [], issues: [{ number: 409, mentions: [12, 7] }] });
    expect(Event.parse(read({})).data).toEqual({ prs: [], issues: [{ number: 409 }] }); // an older plugin sends none
    expect(Event.safeParse(read({ mentions: Array.from({ length: 20 }, (_, i) => i + 1) })).success).toBe(true);
    for (const bad of [Array.from({ length: 21 }, (_, i) => i + 1), [0], [1.5], ['12'], 12]) expect(Event.safeParse(read({ mentions: bad })).success, JSON.stringify(bad)).toBe(false);
    expect(JSON.stringify(Event.parse(read({ mentions: [12], body: 'the private text, after #12' })))).not.toMatch(/private|body/);
  });

  it('machine.sample: bytes, three Docker states, and only the labels it names; a command, an environment or a mount has no field to travel in (v0.4 slice 3)', () => {
    const sample = (c: object, d: object = {}) => ev('machine.sample', { docker: 'ok', containers: [{ state: 'running', ...c }], ...d });
    // Docker absent or stopped lists nothing, and a Mac whose memory could not be read sends none
    expect(Event.safeParse(ev('machine.sample', { docker: 'absent', containers: [] })).success).toBe(true);
    expect(Event.safeParse(ev('machine.sample', { docker: 'stopped', containers: [], mem_free: 1, mem_total: 2 })).success).toBe(true);
    for (const bad of [{ docker: 'running' }, { docker: undefined }, { mem_free: -1 }, { mem_free: 1.5 }, { containers: undefined }]) {
      expect(Event.safeParse(ev('machine.sample', { docker: 'ok', containers: [], ...bad })).success, JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [{ state: 'Running' }, { state: '' }, { health: 'sick' }, { memory: -5 }, { name: '' }, { excluded: false }]) {
      expect(Event.safeParse(sample(bad)).success, JSON.stringify(bad)).toBe(false);
    }
    expect(Event.safeParse(ev('machine.sample', { docker: 'ok', containers: Array.from({ length: 201 }, () => ({ state: 'running' })) })).success).toBe(false);
    const kept = Event.parse(sample({ name: 'db', command: 'postgres -c secret', env: ['PASSWORD=hunter2'], mounts: ['/Users/a/.ssh'], labels: { owner: 'x' }, image: 'sha256:abc', testcontainers: { session: 's', labels: 'x' } }));
    expect(JSON.stringify(kept)).not.toMatch(/postgres|hunter2|\.ssh|owner|sha256/);
  });

  it('session.stopped says whether a turn was ended; background marks an agent that runs apart from the turn (v0.4 slice 5, #31)', () => {
    expect(Event.safeParse(ev('session.stopped', { aborted: false })).success).toBe(true);
    for (const bad of [{}, { aborted: 'yes' }, { aborted: undefined }]) expect(Event.safeParse(ev('session.stopped', bad)).success, JSON.stringify(bad)).toBe(false);
    const spawn = (extra: object) => ev('agent.spawn', { tool_use_id: 't', agent_type: 'Explore', model: 'm', prompt_length: 1, ...extra }, { agent_id: 'a' });
    const bg = Event.parse(spawn({ background: true }));
    expect(bg.kind === 'agent.spawn' && bg.data.background).toBe(true);
    expect(Event.safeParse(spawn({ background: false })).success).toBe(false); // sent when true, left out otherwise
    expect(Event.parse(spawn({}))).not.toHaveProperty('data.background');
  });

  it('project.checkout: the session\'s own working tree, optional, never empty (v0.2 slice 3)', () => {
    const at = (project: object) => ({ ...ev('session.end', { reason: 'exit' }), project: { cwd: '/Users/a/mobile-app', name: 'mobile-app', ...project } });
    const kept = Event.parse(at({ checkout: '/Users/a/mobile-app/.claude/worktrees/w' }));
    expect(kept.project.checkout).toBe('/Users/a/mobile-app/.claude/worktrees/w'); // not stripped like an unknown key
    expect(Event.parse(at({})).project).not.toHaveProperty('checkout');
    expect(Event.safeParse(at({ checkout: '' })).success).toBe(false);
  });

  it('has one example per kind', () => {
    expect(new Set(examples.map((e) => e.kind))).toEqual(new Set(EVENT_KINDS));
  });

  it.each(examples)('accepts $kind', (e) => {
    const r = Event.safeParse(e);
    expect(r.error).toBeUndefined();
    expect(r.data).toEqual(e);
  });

  it('rejects an event missing session_id', () => {
    const { session_id: _, ...e } = examples[1]!;
    expect(Event.safeParse(e).success).toBe(false);
  });

  it('rejects an event missing user_id', () => {
    const { user_id: _, ...e } = examples[1]!;
    expect(Event.safeParse(e).success).toBe(false);
  });

  it('rejects an unknown kind and a wrong data shape', () => {
    expect(Event.safeParse(ev('tool.explode', {})).success).toBe(false);
    expect(Event.safeParse(ev('prompt.submit', { length: 'long' })).success).toBe(false);
  });

  it('rejects an agent.spawn without the child agent_id', () => {
    const { agent_id: _, ...e } = examples[7] as typeof examples[7] & { agent_id: string };
    expect(Event.safeParse(e).success).toBe(false);
  });

  it('keeps content only in its named fields, and strips every other unknown key at every level', () => {
    const leaky = ev(
      'prompt.submit',
      { length: 12, text: 'fix the writer', secret: 'x' },
      { content: 'raw transcript', project: { ...base.project, readme: 'file body' }, prompt_id: 'p-2' },
    );
    const parsed = Event.parse(leaky);
    expect(parsed.data).toEqual({ length: 12, text: 'fix the writer' });
    expect(JSON.stringify(parsed)).not.toMatch(/raw transcript|file body|"secret"/);
    const result = Event.parse(ev('tool.result', { tool_use_id: 't', success: true, duration_ms: 1, output_size: 2, files_touched: [], output: 'ok', output_skipped: 'env-file', stdout: 'x' }));
    expect(result.data).toEqual({ tool_use_id: 't', success: true, duration_ms: 1, output_size: 2, files_touched: [], output: 'ok', output_skipped: 'env-file' });
  });

  it('content is optional everywhere: a metadata-only event stays valid', () => {
    for (const e of examples) expect(Event.safeParse(e).success).toBe(true);
  });

  it('caps a content field at 32 KB on the server too, keeping its start and end with a marker', () => {
    const long = 'A'.repeat(30_000) + 'B'.repeat(40_000) + 'C'.repeat(30_000);
    const e = Event.parse(ev('tool.result', { tool_use_id: 't', success: true, duration_ms: 1, output_size: long.length, files_touched: [], output: long }));
    const out = e.kind === 'tool.result' ? e.data.output! : '';
    expect(out.length).toBeLessThanOrEqual(32_768 + 64);
    expect(out.startsWith('A'.repeat(1000))).toBe(true);
    expect(out.endsWith('C'.repeat(1000))).toBe(true);
    expect(out).toMatch(/\[… [\d,]+ characters cut …\]/);
    expect(capText('short')).toBe('short');
  });

  it('session.start says whether content is on, off, or excluded for the project', () => {
    const start = (content: string) => ev('session.start', { model: 'm', source: 's', claude_version: 'v', plugin_version: 'p', content });
    expect(Event.safeParse(start('excluded')).success).toBe(true);
    expect(Event.safeParse(start('sometimes')).success).toBe(false);
  });

  it('caps the spawn description at 200 characters', () => {
    const e = ev('agent.spawn', { tool_use_id: 't', agent_type: 'Plan', description: 'x'.repeat(5000), model: 'm', prompt_length: 1 }, { agent_id: 'a' });
    const parsed = Event.parse(e);
    expect(parsed.kind === 'agent.spawn' && parsed.data.description?.length).toBe(200);
  });

  it('carries a declared role on agent.spawn, only from the §7 list', () => {
    const spawn = (declared_role: string) =>
      ev('agent.spawn', { tool_use_id: 't', agent_type: 'implementer', model: 'm', prompt_length: 1, declared_role }, { agent_id: 'a' });
    const ok = Event.parse(spawn('developer'));
    expect(ok.kind === 'agent.spawn' && ok.data.declared_role).toBe('developer');
    expect(Event.safeParse(spawn('boss')).success).toBe(false);
  });

  it('carries the model check on agent.spawn: the declared model as written, and what the agent is held to and why (v0.2 slice 2)', () => {
    const spawn = (extra: object) => ev('agent.spawn', { tool_use_id: 't', agent_type: 'implementer', model: 'claude-opus-5-5', prompt_length: 1, ...extra }, { agent_id: 'a' });
    const ok = Event.parse(spawn({ declared_model: 'claude-sonnet-5-5[1m]', model_check: { allowed: 'sonnet', source: 'file' } }));
    expect(ok.kind === 'agent.spawn' && ok.data).toMatchObject({ declared_model: 'claude-sonnet-5-5[1m]', model_check: { allowed: 'sonnet', source: 'file' } });
    for (const allowed of ['haiku', 'sonnet', 'opus', 'fable', 'mythos']) expect(Event.safeParse(spawn({ model_check: { allowed, source: 'ceiling' } })).success).toBe(true);
    expect(Event.safeParse(spawn({ model_check: { allowed: 'gpt', source: 'file' } })).success).toBe(false);
    expect(Event.safeParse(spawn({ model_check: { allowed: 'sonnet', source: 'guess' } })).success).toBe(false);
    expect(Event.safeParse(spawn({ model_check: { allowed: 'sonnet' } })).success).toBe(false);
    const stripped = Event.parse(spawn({ model_check: { allowed: 'sonnet', source: 'file', price: 3 } }));
    expect(stripped.kind === 'agent.spawn' && stripped.data.model_check).toEqual({ allowed: 'sonnet', source: 'file' });
  });

  it('accepts a null stop reason (the engine reports one when no request was made)', () => {
    const e = ev('turn.step', { model: 'm', usage, stop_reason: null, tool_use_ids: [] }, { turn_id: 't-1' });
    expect(Event.safeParse(e).success).toBe(true);
  });

  it('takes an optional context percent on turn.complete, 0 to 100', () => {
    const done = (context_percent: number) =>
      ev('turn.complete', { duration_ms: 1, usage_total: usage, reason: 'answer', answer_length: 0, context_percent }, { turn_id: 't-1' });
    expect(Event.safeParse(done(61)).success).toBe(true);
    expect(Event.safeParse(done(101)).success).toBe(false);
  });

  it('caps a batch at 500 events', () => {
    const one = examples[1]!;
    expect(IngestBatch.safeParse({ events: Array(500).fill(one) }).success).toBe(true);
    expect(IngestBatch.safeParse({ events: Array(501).fill(one) }).success).toBe(false);
  });
});
