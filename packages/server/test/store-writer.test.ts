import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Event } from '@agent-orb/shared';
import { costUsd } from '../src/cost.ts';
import { all, openStore, run, type Store } from '../src/store/store.ts';
import { writeEvents } from '../src/store/writer.ts';

// The history writer (#81): every fact it stores, on a temp file with no container, read through SQL. Among them what the move to SQLite added: a forked
// session's copied call and the plugin's stretch.
let dir: string;
let db: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-store-'));
  db = openStore(join(dir, 'history.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const T = 1_792_400_000_000;
const REMOTE = 'github.com/alfredo1996/mobile-app';
let n = 0;
type Opts = { session?: string; cwd?: string; checkout?: string; remote?: string; host?: string; ts?: number; agent?: string; turn?: string; prompt?: string };
const ev = (kind: string, data: object, o: Opts = {}): Event =>
  ({
    v: 1, id: `00000000-0000-4000-a000-${String(++n).padStart(12, '0')}`, ts: o.ts ?? T + n * 1000, host: o.host ?? 'mbp', user_id: 'local',
    session_id: o.session ?? 's-1',
    project: { cwd: o.cwd ?? '/Users/a/mobile-app', name: 'mobile-app', ...(o.remote ? { git_remote: o.remote } : {}), ...(o.checkout ? { checkout: o.checkout } : {}) },
    ...(o.agent ? { agent_id: o.agent } : {}), ...(o.turn ? { turn_id: o.turn } : {}), ...(o.prompt ? { prompt_id: o.prompt } : {}),
    kind, data,
  }) as Event;
const start = (source: string, o: Opts = {}) => ev('session.start', { model: 'claude-opus-5-5', source, claude_version: '2.1.300', plugin_version: '0.1.0' }, o);
const q = (sql: string, params: Record<string, unknown> = {}) => all(db, sql, params).map((r) => ({ ...r }));
const plugin = (events: Event[]) => writeEvents(db, events, 'plugin');
const imported = (events: Event[]) => writeEvents(db, events, 'import');
const count = (table: string) => q(`SELECT count(*) AS n FROM ${table}`)[0]!.n;

// Every table as sorted text, to compare two stores or one store before and after.
const snapshot = () => {
  const tables = q(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).map((t) => t.name);
  return tables.flatMap((t) => q(`SELECT * FROM ${t}`).map((r) => `${t} ${JSON.stringify(Object.entries(r).sort())}`)).sort();
};

const fixture = readFileSync(new URL('./fixtures/session.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) as Event[];

describe('the recorded session (the fixture, 29 events)', () => {
  it('every event kind lands in its table, under the keys the graph MERGEd on', () => {
    expect(plugin(fixture)).toEqual({ accepted: 29, duplicates: 0 });
    expect(Object.fromEntries(['projects', 'sessions', 'agents', 'prompts', 'turns', 'api_requests', 'tool_calls', 'files_touched', 'skill_loads', 'tasks', 'agent_tasks', 'ingested'].map((t) => [t, count(t)])))
      .toEqual({ projects: 1, sessions: 1, agents: 2, prompts: 2, turns: 2, api_requests: 3, tool_calls: 5, files_touched: 3, skill_loads: 1, tasks: 1, agent_tasks: 1, ingested: 29 });

    expect(q('SELECT id, name, git_remote FROM projects')).toEqual([{ id: 'github.com/alfredo1996/agent-orb', name: 'agent-orb', git_remote: 'github.com/alfredo1996/agent-orb' }]);
    expect(q('SELECT * FROM project_cwds')).toEqual([{ project_id: 'github.com/alfredo1996/agent-orb', cwd: '/Users/alfredo/agent-orb' }]);
    expect(q('SELECT id, user_id, host, project_id, started_at, ended_at, model, claude_version, source, recorded, content, dropped_events FROM sessions')).toEqual([
      { id: 'sess-1', user_id: 'alfredo', host: 'alfredo-mbp', project_id: 'github.com/alfredo1996/agent-orb', started_at: 1_792_400_000_000, ended_at: 1_792_400_050_000, model: 'claude-opus-5-5', claude_version: '2.1.299', source: 'startup', recorded: 1, content: null, dropped_events: null },
    ]);

    expect(q('SELECT id, session_id, parent_id, type, role, role_source, model, description, started_at, ended_at, spawn_tool_use_id FROM agents ORDER BY id')).toEqual([
      { id: 'sess-1:agent-x', session_id: 'sess-1', parent_id: 'sess-1:main', type: 'Explore', role: 'researcher', role_source: 'map', model: 'claude-haiku-5-5', description: 'Find docs', started_at: 1_792_400_006_100, ended_at: 1_792_400_012_100, spawn_tool_use_id: 'toolu_agent1' },
      { id: 'sess-1:main', session_id: 'sess-1', parent_id: null, type: 'main', role: 'orchestrator', role_source: 'map', model: 'claude-opus-5-5', description: null, started_at: 1_792_400_000_000, ended_at: null, spawn_tool_use_id: null },
    ]);
    expect(q('SELECT id, session_id, agent_id, length FROM prompts ORDER BY ts')).toEqual([
      { id: 'prompt-1', session_id: 'sess-1', agent_id: 'sess-1:main', length: 120 }, { id: 'prompt-2', session_id: 'sess-1', agent_id: 'sess-1:main', length: 30 },
    ]);
    expect(q('SELECT id, agent_id, started_at, duration_ms FROM turns ORDER BY id')).toEqual([
      { id: 'turn-1', agent_id: 'sess-1:main', started_at: 1_792_400_001_100, duration_ms: 20000 },
      { id: 'turn-2', agent_id: 'sess-1:agent-x', started_at: 1_792_400_006_200, duration_ms: 5800 },
    ]);

    // Cost per request from pricing.json, null for the unknown model; tokens still counted.
    const requests = q('SELECT turn_id, model, input + output + cache_read + cache_creation AS tokens, cost_usd FROM api_requests ORDER BY ts');
    expect(requests.map(({ cost_usd: _, ...r }) => r)).toEqual([
      { turn_id: 'turn-1', model: 'claude-opus-5-5', tokens: 17000 }, { turn_id: 'turn-2', model: 'claude-haiku-5-5', tokens: 101000 }, { turn_id: 'turn-1', model: 'claude-unknown-9', tokens: 2 },
    ]);
    expect(requests[0]!.cost_usd).toBeCloseTo(0.066, 12);
    expect(requests[1]!.cost_usd).toBeCloseTo(0.006, 12);
    expect(requests[2]!.cost_usd).toBeNull();

    expect(q('SELECT tool_use_id, turn_id, tool, success, error_type, waited FROM tool_calls ORDER BY ts')).toEqual([
      { tool_use_id: 'toolu_read1', turn_id: 'turn-1', tool: 'Read', success: 1, error_type: null, waited: null },
      { tool_use_id: 'toolu_agent1', turn_id: 'turn-1', tool: 'Agent', success: 1, error_type: null, waited: null },
      { tool_use_id: 'toolu_grep1', turn_id: 'turn-2', tool: 'Grep', success: 0, error_type: 'no_match', waited: null },
      { tool_use_id: 'toolu_edit1', turn_id: 'turn-2', tool: 'Edit', success: 1, error_type: null, waited: null },
      { tool_use_id: 'toolu_skill1', turn_id: 'turn-1', tool: 'Skill', success: 1, error_type: null, waited: null },
    ]);
    expect(q('SELECT tool_use_id, mode, path, project_id FROM files_touched ORDER BY tool_use_id, path')).toEqual([
      { tool_use_id: 'toolu_edit1', mode: 'write', path: 'src/a.ts', project_id: 'github.com/alfredo1996/agent-orb' },
      { tool_use_id: 'toolu_edit1', mode: 'write', path: 'src/b.ts', project_id: 'github.com/alfredo1996/agent-orb' },
      { tool_use_id: 'toolu_read1', mode: 'read', path: 'src/a.ts', project_id: 'github.com/alfredo1996/agent-orb' },
    ]);
    expect(q('SELECT session_id, turn_id, tool_use_id, skill FROM skill_loads')).toEqual([{ session_id: 'sess-1', turn_id: 'turn-1', tool_use_id: 'toolu_skill1', skill: 'pr-body' }]);
    expect(q('SELECT t.id, t.subject, t.status, w.agent_id FROM tasks t JOIN agent_tasks w ON w.task_id = t.id')).toEqual([
      { id: 'sess-1:1', subject: 'Write the writer', status: 'completed', agent_id: 'sess-1:main' },
    ]);
  });

  it('the same batch twice → all duplicates, the store unchanged', () => {
    expect(plugin(fixture)).toEqual({ accepted: 29, duplicates: 0 });
    const before = snapshot();
    expect(plugin(fixture)).toEqual({ accepted: 0, duplicates: 29 });
    expect(snapshot()).toEqual(before);
  });

  it('a repeated event inside one batch counts once', () => {
    expect(plugin([fixture[0]!, fixture[0]!, fixture[1]!])).toEqual({ accepted: 2, duplicates: 1 });
  });

  it('any split into batches gives the same store as one batch', () => {
    plugin(fixture);
    const whole = snapshot();
    for (const cut of [1, 7, 15, 23]) {
      db.close();
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'orb-store-'));
      db = openStore(join(dir, 'history.db'));
      expect(plugin(fixture.slice(0, cut))).toEqual({ accepted: cut, duplicates: 0 });
      expect(plugin(fixture.slice(cut))).toEqual({ accepted: 29 - cut, duplicates: 0 });
      expect(snapshot()).toEqual(whole);
    }
  });

  it('a failed write rolls the whole batch back: nothing of it stays, and ids are not marked', () => {
    const broken = { ...fixture[5]!, data: { ...(fixture[5] as any).data, tool_use_id: undefined } } as Event; // tool.result with no id: the NOT NULL key refuses it
    expect(() => plugin([fixture[0]!, fixture[1]!, broken])).toThrow();
    expect(snapshot()).toEqual([]);
  });
});

describe('the keys', () => {
  it('tool calls are keyed by tool_use_id, requests and events by id', () => {
    const key = (t: string) => q(`SELECT name FROM pragma_table_info('${t}') WHERE pk > 0 ORDER BY pk`).map((c) => c.name);
    expect(key('tool_calls')).toEqual(['tool_use_id']);
    expect(key('api_requests')).toEqual(['id']);
    expect(key('ingested')).toEqual(['id']);
    expect(key('files_touched')).toEqual(['tool_use_id', 'path', 'mode']);
  });

  it('is WAL, with the page cache set to 8 MB and not left to grow with the file', () => {
    expect(q('PRAGMA journal_mode')[0]!.journal_mode).toBe('wal');
    expect(q('PRAGMA cache_size')[0]!.cache_size).toBe(-8192);
  });
});

describe('a session is on the first project its events name', () => {
  it('within one batch as across batches', () => {
    const OTHER = 'github.com/alfredo1996/agent-orb';
    plugin([start('startup', { session: 'm', remote: REMOTE }), ev('prompt.submit', { length: 1 }, { session: 'm', remote: OTHER, prompt: 'p-m' })]);
    plugin([ev('prompt.submit', { length: 1 }, { session: 'm', remote: OTHER, prompt: 'p-m2' })]);
    expect(q("SELECT project_id FROM sessions WHERE id = 'm'")[0]!.project_id).toBe(REMOTE);
  });
});

describe('Project.cwds', () => {
  it('keeps every distinct cwd seen, within one batch and across batches', () => {
    plugin([start('startup', { session: 'a', cwd: '/Users/a/mobile-app', remote: REMOTE }), start('startup', { session: 'b', cwd: '/Users/a/mobile-app-2', remote: REMOTE })]);
    plugin([start('startup', { session: 'c', cwd: '/Users/a/mobile-app', remote: REMOTE }), start('startup', { session: 'd', cwd: '/Users/b/mobile-app', remote: REMOTE })]);
    expect(q('SELECT cwd FROM project_cwds WHERE project_id = :id ORDER BY cwd', { id: REMOTE }).map((r) => r.cwd)).toEqual(['/Users/a/mobile-app', '/Users/a/mobile-app-2', '/Users/b/mobile-app']);
  });
});

describe('re-home: a project the import made before the plugin knew the remote', () => {
  const made = (id: string, ts: number) => [start('import', { session: id, ts }), ev('prompt.submit', { length: 3 }, { session: id, ts: ts + 1, prompt: `p-${id}` })];
  const projects = () => q('SELECT id FROM projects ORDER BY id').map((r) => r.id);

  it('moves its sessions to the project with the remote and deletes it', () => {
    imported([...made('old-1', T), ...made('old-2', T + 10_000)]);
    expect(projects()).toEqual(['mbp:/Users/a/mobile-app']);
    plugin([start('startup', { session: 'new-1', remote: REMOTE, ts: T + 100_000 })]);
    expect(q('SELECT id, name, git_remote FROM projects')).toEqual([{ id: REMOTE, name: 'mobile-app', git_remote: REMOTE }]);
    expect(q('SELECT id AS s, project_id AS p FROM sessions ORDER BY id')).toEqual([{ s: 'new-1', p: REMOTE }, { s: 'old-1', p: REMOTE }, { s: 'old-2', p: REMOTE }]);
    expect(q('SELECT cwd FROM project_cwds')).toEqual([{ cwd: '/Users/a/mobile-app' }]); // the stub's cwds went with it; the remote's has the event's
    expect(q('SELECT project_id FROM project_cwds')).toEqual([{ project_id: REMOTE }]);
    expect(count('prompts')).toBe(2); // the sessions' own data is untouched
  });

  it('only for the same host and the same cwd', () => {
    imported(made('other-host', T).map((e) => ({ ...e, host: 'nas' }) as Event));
    imported(made('other-cwd', T).map((e) => ({ ...e, project: { ...e.project, cwd: '/Users/a/elsewhere' } }) as Event));
    plugin([start('startup', { session: 'new-1', remote: REMOTE, ts: T + 100_000 })]);
    expect(projects()).toEqual([REMOTE, 'mbp:/Users/a/elsewhere', 'nas:/Users/a/mobile-app']);
  });

  it('is a no-op when no such project exists, and when the remote is already known', () => {
    plugin([start('startup', { session: 'a', remote: REMOTE })]);
    plugin([start('startup', { session: 'b', remote: REMOTE })]);
    expect(q('SELECT project_id AS id, count(*) AS n FROM sessions GROUP BY project_id')).toEqual([{ id: REMOTE, n: 2 }]);
  });

  it('keeps a role rule the owner set on the imported project (the remote\'s own wins when it has one for the type)', () => {
    imported(made('old-1', T));
    run(db, `INSERT INTO role_rules (project_id, agent_type, role) VALUES ('mbp:/Users/a/mobile-app', 'Explore', 'tester'), ('mbp:/Users/a/mobile-app', 'Plan', 'writer')`);
    run(db, `INSERT INTO role_rules (project_id, agent_type, role) VALUES (:p, 'Plan', 'ops')`, { p: REMOTE });
    plugin([start('startup', { session: 'new-1', remote: REMOTE, ts: T + 100_000 })]);
    expect(q('SELECT project_id, agent_type, role FROM role_rules ORDER BY agent_type')).toEqual([
      { project_id: REMOTE, agent_type: 'Explore', role: 'tester' }, { project_id: REMOTE, agent_type: 'Plan', role: 'ops' },
    ]);
  });

  it('the files its calls touched follow it, and its Changes and Fingerprints go with the stub', () => {
    const stub = (kind: string, data: object, o: Opts = {}) => ev(kind, data, { cwd: '/Users/a/mobile-app', ...o });
    imported([
      start('import', { ts: T }),
      stub('tool.call', { tool_use_id: 't-1', tool: 'Edit', input_size: 1 }, { turn: 'tn-1', ts: T + 1 }),
      stub('tool.result', { tool_use_id: 't-1', success: true, duration_ms: 1, output_size: 1, files_touched: [{ path: 'src/a.ts', mode: 'write' }] }, { turn: 'tn-1', ts: T + 2 }),
      stub('project.changes', { commits: [{ sha: 'a'.repeat(40), ts: T - 5000, files: ['CLAUDE.md'] }] }, { ts: T + 3 }),
      stub('project.fingerprint', { files: [{ path: 'CLAUDE.md', hash: '1'.repeat(40), scope: 'project' }] }, { ts: T + 4 }),
    ]);
    expect([count('changes'), count('fingerprints')]).toEqual([1, 1]); // the commit is a Change; the fingerprint is a baseline
    plugin([start('startup', { session: 'new-1', remote: REMOTE, ts: T + 100_000 })]);
    expect(q('SELECT project_id FROM files_touched')).toEqual([{ project_id: REMOTE }]);
    expect(count('changes')).toBe(0);
    expect(count('fingerprints')).toBe(0);
  });
});

describe('session flags: source and recorded', () => {
  const flags = () => q('SELECT id, source, recorded FROM sessions ORDER BY id');

  it('source is the first session.start source seen; recorded turns 1 once the plugin sends a start', () => {
    plugin([start('import', { session: 'imported', ts: T }), start('startup', { session: 'live', ts: T }), start('interactive', { session: 'resumed', ts: T })]);
    expect(flags()).toEqual([
      { id: 'imported', source: 'import', recorded: null },
      { id: 'live', source: 'startup', recorded: 1 },
      { id: 'resumed', source: 'interactive', recorded: 1 },
    ]);
    plugin([start('resume', { session: 'imported', ts: T + 5000 }), start('import', { session: 'live', ts: T + 5000 })]);
    expect(flags()).toEqual([
      { id: 'imported', source: 'import', recorded: 1 },
      { id: 'live', source: 'startup', recorded: 1 },
      { id: 'resumed', source: 'interactive', recorded: 1 },
    ]);
  });
});

describe('an import never overwrites what the plugin recorded on a Session', () => {
  const sess = (id: string) => q('SELECT model, claude_version AS version, content, started_at, source FROM sessions WHERE id = :id', { id })[0];
  const plug = (session: string, ts: number) =>
    ev('session.start', { model: 'claude-opus-5-5', source: 'startup', claude_version: '2.1.308', plugin_version: '0.1.0', content: 'full' }, { session, ts });
  const imp = (session: string, ts: number) =>
    ev('session.start', { model: 'claude-sonnet-5-5', source: 'import', claude_version: '2.1.100', plugin_version: 'import', content: 'off' }, { session, ts });

  it('model, version and content stay the plugin\'s; started_at may move earlier', () => {
    plugin([plug('s-1', T + 5000)]);
    imported([imp('s-1', T)]);
    expect(sess('s-1')).toEqual({ model: 'claude-opus-5-5', version: '2.1.308', content: 'full', started_at: T, source: 'startup' });
    imported([imp('s-1', T + 99_000)]); // never later
    expect(sess('s-1')!.started_at).toBe(T);
  });

  it('an import fills a field the session has none of, and nothing else', () => {
    plugin([plug('s-2', T + 5000)]);
    run(db, `UPDATE sessions SET model = NULL, claude_version = NULL, content = NULL WHERE id = 's-2'`);
    imported([imp('s-2', T)]);
    expect(sess('s-2')).toMatchObject({ model: 'claude-sonnet-5-5', version: '2.1.100', content: 'off' });
    const again = imp('s-2', T);
    imported([{ ...again, id: '00000000-0000-4000-a000-0000000000ff', data: { ...again.data, model: 'claude-haiku-5-5', content: 'excluded' } } as Event]);
    expect(sess('s-2')).toMatchObject({ model: 'claude-sonnet-5-5', content: 'off' }); // set once
  });

  it('the plugin still writes its own: a later plugin start replaces an import\'s fields, as it did', () => {
    imported([imp('s-3', T)]);
    expect(sess('s-3')).toMatchObject({ model: 'claude-sonnet-5-5', content: 'off', source: 'import' });
    plugin([plug('s-3', T + 5000)]);
    expect(sess('s-3')).toMatchObject({ model: 'claude-opus-5-5', version: '2.1.308', content: 'full', source: 'import' });
  });

  it('two starts of one session in one batch apply in order, as separate statements did', () => {
    plugin([plug('s-4', T + 9000), imp('s-4', T + 1000), plug('s-4', T + 3000)]);
    expect(sess('s-4')).toEqual({ model: 'claude-opus-5-5', version: '2.1.308', content: 'full', started_at: T + 1000, source: 'import' }); // the first start seen, by ts, was the import's
  });
});

describe('an agent\'s model (#86)', () => {
  const step = (model: string, o: Opts) => ev('turn.step', { model, usage: { input: 1, output: 1, cache_read: 0, cache_creation: 0 }, stop_reason: 'end_turn', tool_use_ids: [] }, { turn: 't-1', ...o });
  const modelOf = (session: string) => q('SELECT model FROM agents WHERE id = :id', { id: `${session}:main` })[0]?.model;

  it('the plugin\'s requests fill in the model of an agent nothing else named, the first by time', () => {
    plugin([step('claude-sonnet-5-5', { session: 's-p', ts: T + 2000 }), step('claude-haiku-5-5', { session: 's-p', ts: T + 1000 })]);
    expect(modelOf('s-p')).toBe('claude-haiku-5-5');
  });

  it('the import\'s do not: its session.start says it, and comes after the requests when the session is longer than a batch', () => {
    imported([step('claude-haiku-5-5', { session: 's-i', ts: T + 1000 })]); // an earlier batch of the session, written before its start
    expect(modelOf('s-i')).toBeNull();
    imported([start('import', { session: 's-i', ts: T })]);
    expect(modelOf('s-i')).toBe('claude-opus-5-5');
  });
});

describe('agents: declared role, project rule, manual fix, and the model check', () => {
  const spawn = (agent: string, agent_type: string, data: object = {}, o: Opts = {}) =>
    ev('agent.spawn', { tool_use_id: `toolu_${agent}`, agent_type, model: 'claude-opus-5-5', prompt_length: 10, ...data }, { agent, ...o });
  const role = (agent: string) => q('SELECT role, role_source AS src FROM agents WHERE id = :id', { id: `s-1:${agent}` })[0];

  it('a declared role beats the roles.json map; a project rule beats a declared role; a manual fix beats all three', () => {
    plugin([start('startup'), spawn('a1', 'general-purpose', { declared_role: 'reviewer' }), spawn('a2', 'general-purpose')]);
    expect(role('a1')).toEqual({ role: 'reviewer', src: 'declared' });
    expect(role('a2')).toEqual({ role: 'generalist', src: 'map' });
    run(db, `INSERT INTO role_rules (project_id, agent_type, role) VALUES ('mbp:/Users/a/mobile-app', 'general-purpose', 'writer')`);
    plugin([spawn('a3', 'general-purpose', { declared_role: 'reviewer' })]);
    expect(role('a3')).toEqual({ role: 'writer', src: 'rule' });
    run(db, `UPDATE agents SET role = 'tester', role_source = 'manual' WHERE id = 's-1:a1'`);
    plugin([spawn('a1', 'general-purpose', { declared_role: 'reviewer' })]);
    expect(role('a1')).toEqual({ role: 'tester', src: 'manual' });
  });

  it('a type with no role anywhere has none', () => {
    plugin([start('startup'), spawn('a4', 'custom-thing')]);
    expect(role('a4')).toEqual({ role: null, src: null });
  });

  const check = { declared_model: 'sonnet', model_check: { allowed: 'sonnet', source: 'file' } };
  const props = (agent: string) => q('SELECT declared_model AS declared, allowed_model AS allowed, check_source AS source, pricier FROM agents WHERE id = :id', { id: `s-1:${agent}` })[0];

  it('a flagged spawn marks its Agent pricier, with what its file said, what it is held to and whose limit it is', () => {
    plugin([start('startup'), spawn('p1', 'implementer', check), spawn('p2', 'implementer', { model_check: { allowed: 'sonnet', source: 'ceiling' } }), spawn('ok', 'implementer')]);
    expect(props('p1')).toEqual({ declared: 'sonnet', allowed: 'sonnet', source: 'file', pricier: 1 });
    expect(props('p2')).toEqual({ declared: null, allowed: 'sonnet', source: 'ceiling', pricier: 1 });
    expect(props('ok')).toEqual({ declared: null, allowed: null, source: null, pricier: null });
    expect(q(`SELECT model, type FROM agents WHERE id = 's-1:p1'`)).toEqual([{ model: 'claude-opus-5-5', type: 'implementer' }]);
  });

  it('a later spawn for the same agent (the import sends one) does not erase what the plugin recorded', () => {
    plugin([start('startup'), spawn('p3', 'implementer', check)]);
    imported([spawn('p3', 'implementer')]);
    expect(props('p3')).toEqual({ declared: 'sonnet', allowed: 'sonnet', source: 'file', pricier: 1 });
  });

  it('the spawn of an agent files the parent it names, and a spawn of a spawned agent nests', () => {
    plugin([start('startup'), spawn('a1', 'Explore'), ev('agent.spawn', { tool_use_id: 'toolu_b', agent_type: 'Plan', model: 'm', prompt_length: 1 }, { agent: 'b1' })]);
    plugin([{ ...spawn('c1', 'Plan'), parent_agent_id: 'a1' } as Event]);
    expect(q('SELECT id, parent_id FROM agents ORDER BY id')).toEqual([
      { id: 's-1:a1', parent_id: 's-1:main' }, { id: 's-1:b1', parent_id: 's-1:main' }, { id: 's-1:c1', parent_id: 's-1:a1' }, { id: 's-1:main', parent_id: null },
    ]);
  });
});

describe('outbox.dropped, tool.waiting, and the events that are only marked', () => {
  it('outbox.dropped adds up on the Session', () => {
    plugin([start('startup'), ev('outbox.dropped', { count: 5, since: T })]);
    const second = ev('outbox.dropped', { count: 7, since: T });
    plugin([second, second]);
    expect(q('SELECT dropped_events AS n FROM sessions')).toEqual([{ n: 12 }]);
  });

  it('tool.waiting marks a call that is not there yet, and the call and its result keep the mark', () => {
    plugin([ev('tool.waiting', { tool_use_id: 't-w', tool: 'Bash' })]);
    plugin([ev('tool.call', { tool_use_id: 't-w', tool: 'Bash', input_size: 3 }, { turn: 'tn' }), ev('tool.result', { tool_use_id: 't-w', success: true, duration_ms: 90_000, output_size: 1, files_touched: [] }, { turn: 'tn' })]);
    expect(q('SELECT tool_use_id, turn_id, waited, duration_ms FROM tool_calls')).toEqual([{ tool_use_id: 't-w', turn_id: 'tn', waited: 1, duration_ms: 90_000 }]);
  });

  it('session.compact and stall.* write no row of their own, only their id', () => {
    plugin([start('startup'), ev('session.compact', { tokens_before: 9, tokens_after: 3 }), ev('stall.start', { since: T }), ev('stall.end', { since: T })]);
    expect(count('ingested')).toBe(4);
    expect(snapshot().filter((r) => !/^(ingested|projects|project_cwds|sessions|agents) /.test(r))).toEqual([]);
  });
});

describe('tool classes (v0.3 slice 1, #43) and files', () => {
  const call = (id: string, data: object = {}, o: Opts = {}) => ev('tool.call', { tool_use_id: id, tool: 'Bash', input_size: 12, ...data }, { remote: REMOTE, turn: 'tn', ...o });
  const result = (id: string, data: object = {}, o: Opts = {}) => ev('tool.result', { tool_use_id: id, success: true, duration_ms: 5, output_size: 3, files_touched: [], ...data }, { remote: REMOTE, turn: 'tn', ...o });
  const stored = () => q('SELECT tool_use_id AS id, command_class, error_class, success FROM tool_calls ORDER BY tool_use_id');

  it('stores command_class on the call and error_class from its result', () => {
    plugin([call('t-test', { command_class: 'test' }), result('t-test', { success: false, error_type: 'error', error_class: 'exit_code' }), call('t-read', { tool: 'Read' }), result('t-read')]);
    expect(stored()).toEqual([
      { id: 't-read', command_class: null, error_class: null, success: 1 },
      { id: 't-test', command_class: 'test', error_class: 'exit_code', success: 0 },
    ]);
  });

  it('an event that says nothing about a class never erases the one stored, and one that says more adds it to the same call (an import run again)', () => {
    plugin([call('t-1'), result('t-1', { success: false, error_type: 'error' }), call('t-2', { tool: 'Read' }), result('t-2', { files_touched: [{ path: 'src/a.ts', mode: 'read' }] })]);
    expect(stored()).toEqual([
      { id: 't-1', command_class: null, error_class: null, success: 0 },
      { id: 't-2', command_class: null, error_class: null, success: 1 },
    ]);
    plugin([call('t-1', { command_class: 'gh' }), result('t-1', { success: false, error_type: 'error', error_class: 'refused' })]);
    expect(stored()[0]).toEqual({ id: 't-1', command_class: 'gh', error_class: 'refused', success: 0 });
    plugin([call('t-1'), result('t-1', { success: false, error_type: 'error' })]); // an older event, or a plugin that sends none
    expect(stored()[0]).toEqual({ id: 't-1', command_class: 'gh', error_class: 'refused', success: 0 });
    expect(count('tool_calls')).toBe(2);
  });

  it('stores error_shape from the result; none never erases it, one adds it, a later one replaces it (v0.3 slice 3, #45)', () => {
    const shape = () => q('SELECT tool_use_id AS id, error_shape AS shape FROM tool_calls ORDER BY tool_use_id');
    plugin([call('t-1'), result('t-1', { success: false, error_type: 'error', error_class: 'exit_code' }), call('t-2'), result('t-2')]);
    expect(shape()).toEqual([{ id: 't-1', shape: null }, { id: 't-2', shape: null }]);
    plugin([result('t-1', { success: false, error_type: 'error', error_class: 'exit_code', error_shape: 'h:a0038b0f' })]);
    expect(shape()).toEqual([{ id: 't-1', shape: 'h:a0038b0f' }, { id: 't-2', shape: null }]);
    plugin([result('t-1', { success: false, error_type: 'error', error_class: 'exit_code' })]);
    expect(shape()[0]).toEqual({ id: 't-1', shape: 'h:a0038b0f' });
    plugin([result('t-1', { success: false, error_type: 'error', error_class: 'refused', error_shape: 'hook_blocked' })]);
    expect(shape()[0]).toEqual({ id: 't-1', shape: 'hook_blocked' });
    expect(count('tool_calls')).toBe(2);
  });

  it('files_touched of a later event for the same call adds the row once', () => {
    plugin([call('t-2', { tool: 'Edit' }), result('t-2')]);
    const touched = { files_touched: [{ path: 'src/a.ts', mode: 'write' }, { path: 'docs/b.md', mode: 'write' }] };
    plugin([result('t-2', touched)]);
    plugin([result('t-2', touched, { session: 'again' })]);
    expect(q('SELECT mode, path, project_id FROM files_touched ORDER BY path')).toEqual([
      { mode: 'write', path: 'docs/b.md', project_id: REMOTE }, { mode: 'write', path: 'src/a.ts', project_id: REMOTE },
    ]);
  });

  it('a result that arrives before its call makes the row, and the call fills in the rest; with no turn it is no call yet', () => {
    plugin([result('t-late', { success: false, error_type: 'error' }, { turn: undefined })]);
    expect(q('SELECT tool_use_id, turn_id, tool, success FROM tool_calls')).toEqual([{ tool_use_id: 't-late', turn_id: null, tool: null, success: 0 }]);
    plugin([call('t-late', {}, { turn: 'tn-9' })]);
    expect(q('SELECT tool_use_id, turn_id, tool, success FROM tool_calls')).toEqual([{ tool_use_id: 't-late', turn_id: 'tn-9', tool: 'Bash', success: 0 }]);
  });
});

describe('a forked session\'s copied call is one call, in the session that wrote it first', () => {
  const call = (session: string, turn: string, ts: number) => ev('tool.call', { tool_use_id: 'toolu_x', tool: 'Edit', input_size: 4 }, { session, turn, ts });
  const result = (session: string, turn: string, ts: number) =>
    ev('tool.result', { tool_use_id: 'toolu_x', success: false, error_type: 'error', error_class: 'no_match', duration_ms: 3, output_size: 2, files_touched: [{ path: 'src/a.ts', mode: 'write' }] }, { session, turn, ts });
  const owners = () => q(`SELECT c.tool_use_id AS id, a.session_id AS session FROM tool_calls c JOIN turns t ON t.id = c.turn_id JOIN agents a ON a.id = t.agent_id`);

  it('across batches: the fork\'s copy and its result change neither the session nor the counts', () => {
    plugin([start('startup', { session: 'A', ts: T }), call('A', 'tA', T + 10), result('A', 'tA', T + 20)]);
    plugin([start('startup', { session: 'B', ts: T + 100 }), call('B', 'tB', T + 10), result('B', 'tB', T + 20)]);
    expect(q('SELECT tool_use_id, turn_id, success FROM tool_calls')).toEqual([{ tool_use_id: 'toolu_x', turn_id: 'tA', success: 0 }]);
    expect(owners()).toEqual([{ id: 'toolu_x', session: 'A' }]);
    expect(count('files_touched')).toBe(1);
    expect(q('SELECT id FROM turns ORDER BY id').map((r) => r.id)).toEqual(['tA', 'tB']); // the fork's turn is there, with no call
  });

  it('in one batch: the earlier event is the first writer, whatever the order they were listed in', () => {
    plugin([call('B', 'tB', T + 30), result('B', 'tB', T + 40), call('A', 'tA', T + 10), result('A', 'tA', T + 20)]);
    expect(q('SELECT turn_id FROM tool_calls')).toEqual([{ turn_id: 'tA' }]);
    expect(owners()).toEqual([{ id: 'toolu_x', session: 'A' }]);
  });

  it('through the import too: the same call under two sessions\' turns is one row', () => {
    imported([start('import', { session: 'A', ts: T }), call('A', 'tA', T + 10)]);
    imported([start('import', { session: 'B', ts: T + 1 }), call('B', 'tB', T + 10)]);
    expect(q('SELECT count(*) AS n FROM tool_calls WHERE turn_id IS NOT NULL')).toEqual([{ n: 1 }]);
  });
});

describe('the plugin\'s stretch', () => {
  const prompt = (ts: number, session = 's-1') => ev('prompt.submit', { length: 1 }, { session, ts, prompt: `p-${ts}` });
  const step = (ts: number, session = 's-1') => ev('turn.step', { model: 'm', usage: { input: 1, output: 1, cache_read: 0, cache_creation: 0 }, stop_reason: null, tool_use_ids: [] }, { session, ts, turn: `t-${ts}` });
  const tool = (ts: number, session = 's-1') => ev('tool.call', { tool_use_id: `u-${ts}`, tool: 'Read', input_size: 1 }, { session, ts, turn: `t-${ts}` });
  const stretch = (session = 's-1') => q('SELECT plugin_first AS first, plugin_last AS last FROM sessions WHERE id = :id', { id: session })[0];

  it('is the first and last ts of the prompts, requests and calls the plugin wrote, and widens across batches', () => {
    plugin([start('startup', { ts: T }), step(T + 7000), prompt(T + 5000), tool(T + 9000), ev('tool.result', { tool_use_id: 'u-1', success: true, duration_ms: 1, output_size: 1, files_touched: [] }, { ts: T + 99_000 }), ev('session.end', { reason: 'exit' }, { ts: T + 200_000 })]);
    expect(stretch()).toEqual({ first: T + 5000, last: T + 9000 }); // the start, a result and the end are no part of it
    plugin([prompt(T + 3000), tool(T + 20_000)]);
    expect(stretch()).toEqual({ first: T + 3000, last: T + 20_000 });
    plugin([prompt(T + 4000)]); // inside: unchanged
    expect(stretch()).toEqual({ first: T + 3000, last: T + 20_000 });
  });

  it('is its own per session', () => {
    plugin([prompt(T + 1000, 'a'), prompt(T + 2000, 'b'), tool(T + 3000, 'a')]);
    expect([stretch('a'), stretch('b')]).toEqual([{ first: T + 1000, last: T + 3000 }, { first: T + 2000, last: T + 2000 }]);
  });

  it('a session with nothing but its start has none: the logs fill all of it', () => {
    plugin([start('startup', { ts: T })]);
    expect(stretch()).toEqual({ first: null, last: null });
  });

  it('is never set by the import', () => {
    imported([start('import', { ts: T }), prompt(T + 1000), step(T + 2000), tool(T + 3000)]);
    expect(stretch()).toEqual({ first: null, last: null });
  });

  it('an imported session the plugin resumed later has a stretch from the resume on, not from the import\'s first event (#79)', () => {
    imported([start('import', { ts: T }), prompt(T + 1000), step(T + 2000), tool(T + 3000)]);
    const HOUR = 3_600_000;
    plugin([start('resume', { ts: T + HOUR }), prompt(T + HOUR + 5000), step(T + HOUR + 7000)]);
    expect(q('SELECT source, recorded, started_at FROM sessions')).toEqual([{ source: 'import', recorded: 1, started_at: T }]);
    expect(stretch()).toEqual({ first: T + HOUR + 5000, last: T + HOUR + 7000 });
  });

  it('an event the import already wrote is not the plugin\'s when it arrives again', () => {
    const early = prompt(T + 1000);
    imported([early]);
    expect(plugin([early, tool(T + 5000)])).toEqual({ accepted: 1, duplicates: 1 });
    expect(stretch()).toEqual({ first: T + 5000, last: T + 5000 });
  });
});

describe('project.changes', () => {
  const sha = (c: string) => c.repeat(40);
  const changes = (commits: object[], o: Opts = {}) => ev('project.changes', { commits }, { remote: REMOTE, ...o });
  const listed = () => q(`SELECT id, project_id AS project, sha, ts, subject, files, source FROM changes ORDER BY ts`).map((c) => ({ ...c, files: JSON.parse(c.files) }));

  it('makes one Change per commit under the project, keyed by project and sha, and a second batch adds nothing', () => {
    const commits = [
      { sha: sha('a'), ts: T - 5000, subject: 'feat: the agents arrive', files: ['.claude/agents/implementer.md', 'CLAUDE.md'] },
      { sha: 'c3f9a2e', ts: T - 9000, files: ['CLAUDE.md'] },
    ];
    expect(plugin([start('startup', { remote: REMOTE }), changes(commits)])).toEqual({ accepted: 2, duplicates: 0 });
    plugin([start('startup', { session: 's-2', remote: REMOTE }), changes(commits, { session: 's-2' })]);
    expect(listed()).toEqual([
      { id: `${REMOTE}:c3f9a2e`, project: REMOTE, sha: 'c3f9a2e', ts: T - 9000, subject: null, files: ['CLAUDE.md'], source: 'git' },
      { id: `${REMOTE}:${sha('a')}`, project: REMOTE, sha: sha('a'), ts: T - 5000, subject: 'feat: the agents arrive', files: ['.claude/agents/implementer.md', 'CLAUDE.md'], source: 'git' },
    ]);
  });

  it('a later batch without a subject (an excluded project) replaces it, and two projects never share a Change', () => {
    const commit = { sha: sha('b'), ts: T - 1000, subject: 'secret client work', files: ['CLAUDE.md'] };
    plugin([changes([commit])]);
    plugin([changes([{ ...commit, subject: undefined }], { session: 's-2' })]);
    expect(q('SELECT subject FROM changes')).toEqual([{ subject: null }]);
    plugin([changes([commit], { session: 's-3', remote: 'github.com/alfredo1996/other' })]);
    expect(count('changes')).toBe(2);
  });

  it('keeps each file\'s blob as hashes, parallel to files (v0.2 slice 3), and an older plugin\'s resend without them erases nothing', () => {
    const commit = { sha: sha('c'), ts: T - 3000, files: ['.claude/agents/a.md', 'CLAUDE.md'], blobs: ['1'.repeat(40), '0'.repeat(40)] };
    const hashes = () => q('SELECT files, hashes FROM changes').map((c) => ({ files: JSON.parse(c.files), hashes: JSON.parse(c.hashes) }));
    plugin([changes([commit])]);
    expect(hashes()).toEqual([{ files: commit.files, hashes: commit.blobs }]);
    plugin([changes([{ ...commit, blobs: undefined }], { session: 's-2' })]);
    expect(hashes()).toEqual([{ files: commit.files, hashes: commit.blobs }]);
    plugin([changes([{ ...commit, blobs: ['2'.repeat(40), '0'.repeat(40)] }], { session: 's-3' })]);
    expect(hashes()[0]!.hashes).toEqual(['2'.repeat(40), '0'.repeat(40)]); // the newest resend wins, as for the subject
  });
});

describe('project.fingerprint (v0.2 slice 3)', () => {
  const h = (c: string) => c.repeat(40);
  const fp = (files: [string, string, ('project' | 'user')?][], o: Opts = {}) =>
    ev('project.fingerprint', { files: files.map(([path, hash, scope]) => ({ path, hash, scope: scope ?? 'project' })) }, { remote: REMOTE, ...o });
  const AGENT = '.claude/agents/implementer.md';
  const RULES = '~/.claude/rules/git.md';
  const CWD = '/Users/a/mobile-app';
  const WT = '/Users/a/mobile-app-feature';
  const nodes = () => q('SELECT id, cwd, path, scope, hash, ts FROM fingerprints ORDER BY path, cwd');
  const changes = () =>
    q(`SELECT project_id AS project, id, ts, files, hashes, scope FROM changes WHERE source = 'fingerprint' ORDER BY ts, id`).map((c): Record<string, any> => ({ ...c, files: JSON.parse(c.files), hashes: JSON.parse(c.hashes) }));

  it('a path seen for the first time is a baseline: remembered, no change', () => {
    plugin([fp([[AGENT, h('1')], ['CLAUDE.md', h('2')], [RULES, h('3'), 'user']], { ts: T })]);
    expect(nodes()).toEqual([
      { id: `${REMOTE}|${CWD}|${AGENT}`, cwd: CWD, path: AGENT, scope: 'project', hash: h('1'), ts: T },
      { id: `${REMOTE}|${CWD}|CLAUDE.md`, cwd: CWD, path: 'CLAUDE.md', scope: 'project', hash: h('2'), ts: T },
      { id: `${REMOTE}|${RULES}`, cwd: null, path: RULES, scope: 'user', hash: h('3'), ts: T },
    ]);
    expect(changes()).toEqual([]);
  });

  it('a known path with another hash is updated and makes a Change, dated at the event, under the project', () => {
    plugin([fp([[AGENT, h('1')], [RULES, h('3'), 'user']], { ts: T })]);
    plugin([fp([[AGENT, h('2')], [RULES, h('3'), 'user']], { ts: T + 60_000, session: 's-2' })]);
    expect(changes()).toEqual([{ project: REMOTE, id: `${REMOTE}:fp:${AGENT}:${h('2')}`, ts: T + 60_000, files: [AGENT], hashes: [h('2')], scope: 'project' }]);
    expect(nodes().map((x) => [x.path, x.hash, x.ts])).toEqual([[AGENT, h('2'), T + 60_000], [RULES, h('3'), T]]);
  });

  it('a user file makes a Change too, scope user', () => {
    plugin([fp([[RULES, h('3'), 'user']], { ts: T })]);
    plugin([fp([[RULES, h('4'), 'user']], { ts: T + 1000, session: 's-2' })]);
    expect(changes()).toEqual([{ project: REMOTE, id: `${REMOTE}:fp:${RULES}:${h('4')}`, ts: T + 1000, files: [RULES], hashes: [h('4')], scope: 'user' }]);
  });

  it('the same files again, in a new event or a re-delivered one, change nothing: one Change, the node untouched', () => {
    const first = fp([[AGENT, h('1')]], { ts: T });
    const second = fp([[AGENT, h('2')]], { ts: T + 1000, session: 's-2' });
    plugin([first, second]);
    expect(plugin([second])).toEqual({ accepted: 0, duplicates: 1 });
    plugin([fp([[AGENT, h('2')]], { ts: T + 9000, session: 's-3' })]);
    expect(changes()).toHaveLength(1);
    expect(nodes()[0]).toMatchObject({ hash: h('2'), ts: T + 1000 });
  });

  it('a path missing from a later event is a deletion Change (hash "deleted") and is remembered as deleted: no second one, and its return is a change', () => {
    plugin([fp([[AGENT, h('1')], ['CLAUDE.md', h('2')]], { ts: T })]);
    plugin([fp([['CLAUDE.md', h('2')]], { ts: T + 1000, session: 's-2' })]);
    expect(changes()).toEqual([{ project: REMOTE, id: `${REMOTE}:fp:${AGENT}:deleted`, ts: T + 1000, files: [AGENT], hashes: ['deleted'], scope: 'project' }]);
    expect(nodes().find((x) => x.path === AGENT)).toMatchObject({ hash: 'deleted', ts: T + 1000 });
    plugin([fp([['CLAUDE.md', h('2')]], { ts: T + 2000, session: 's-3' })]);
    expect(changes()).toHaveLength(1);
    plugin([fp([[AGENT, h('5')], ['CLAUDE.md', h('2')]], { ts: T + 3000, session: 's-4' })]);
    expect(changes().map((c) => c.hashes)).toEqual([['deleted'], [h('5')]]);
    plugin([fp([['CLAUDE.md', h('2')]], { ts: T + 4000, session: 's-5' })]);
    plugin([fp([[AGENT, h('5')], ['CLAUDE.md', h('2')]], { ts: T + 5000, session: 's-6' })]);
    expect(changes().filter((c) => c.files[0] === AGENT).map((c) => c.hashes[0])).toEqual(['deleted', h('5')]);
  });

  it('a deletion is judged within its own project and scope, and only for a scope the event lists at all', () => {
    plugin([fp([[AGENT, h('1')], ['CLAUDE.md', h('2')], [RULES, h('3'), 'user'], ['~/.claude/CLAUDE.md', h('4'), 'user']], { ts: T })]);
    plugin([fp([['CLAUDE.md', h('2')]], { ts: T + 1000, session: 's-2' })]);
    expect(changes().map((c) => c.files)).toEqual([[AGENT]]);
    plugin([fp([['~/.claude/CLAUDE.md', h('4'), 'user']], { ts: T + 2000, session: 's-3' })]);
    expect(changes().map((c) => [c.files[0], c.scope])).toEqual([[AGENT, 'project'], [RULES, 'user']]);
    expect(nodes().find((x) => x.path === 'CLAUDE.md')).toMatchObject({ hash: h('2') });
  });

  it('another project\'s files are its own: the same path in two projects is two nodes, and one project\'s event deletes nothing of the other', () => {
    const OTHER = 'github.com/alfredo1996/other';
    plugin([fp([[AGENT, h('1')]], { ts: T }), fp([[AGENT, h('1')]], { ts: T, remote: OTHER, session: 'o-1' })]);
    plugin([fp([['CLAUDE.md', h('2')]], { ts: T + 1000, remote: OTHER, session: 'o-2' })]);
    expect(changes().map((c) => [c.project, c.files, c.hashes])).toEqual([[OTHER, [AGENT], ['deleted']]]);
    expect(nodes()).toHaveLength(3);
  });

  it('events in one batch are folded in time order, whatever order they arrive in: every step is a Change, the node ends on the last', () => {
    const e1 = fp([[AGENT, h('1')]], { ts: T });
    const e2 = fp([[AGENT, h('2')]], { ts: T + 1000, session: 's-2' });
    const e3 = fp([[AGENT, h('3')]], { ts: T + 2000, session: 's-3' });
    plugin([e3, e1, e2]);
    expect(changes().map((c) => [c.ts, c.hashes[0]])).toEqual([[T + 1000, h('2')], [T + 2000, h('3')]]);
    expect(nodes()).toEqual([{ id: `${REMOTE}|${CWD}|${AGENT}`, cwd: CWD, path: AGENT, scope: 'project', hash: h('3'), ts: T + 2000 }]);
  });

  it('a file that goes back to a version it had is a change; a version seen twice keeps its latest change (ids are by path and hash)', () => {
    const steps: [string, number][] = [['1', 0], ['2', 1], ['1', 2], ['2', 3]];
    for (const [i, [hash, at]] of steps.entries()) plugin([fp([[AGENT, h(hash)]], { ts: T + at * 1000, session: `s-${i}` })]);
    expect(changes().map((c) => [c.ts, c.hashes[0]])).toEqual([[T + 2000, h('1')], [T + 3000, h('2')]]);
  });

  describe('checkouts of one repo (the main one and git worktrees on other branches)', () => {
    const main = (files: Parameters<typeof fp>[0], at: number, session: string) => fp(files, { ts: T + at * 1000, session });
    const wt = (files: Parameters<typeof fp>[0], at: number, session: string) => fp(files, { ts: T + at * 1000, session, cwd: WT });
    const hashesOf = (path: string) => Object.fromEntries(nodes().filter((x) => x.path === path).map((x) => [x.cwd, x.hash]));

    it('sessions that alternate between a checkout with version A and one with version B make no change: each is its own baseline', () => {
      const events: Event[] = [];
      for (let i = 0; i < 4; i++) events.push(main([[AGENT, h('1')], [RULES, h('3'), 'user']], 2 * i, `m-${i}`), wt([[AGENT, h('2')], [RULES, h('3'), 'user']], 2 * i + 1, `w-${i}`));
      plugin(events.slice(0, 2));
      for (const e of events.slice(2)) plugin([e]);
      expect(changes()).toEqual([]);
      expect(hashesOf(AGENT)).toEqual({ [CWD]: h('1'), [WT]: h('2') });
    });

    it('an edit inside one checkout is one change, and the other checkout still has its own version', () => {
      plugin([main([[AGENT, h('1')]], 0, 'm-1'), wt([[AGENT, h('1')]], 1, 'w-1')]);
      plugin([main([[AGENT, h('2')]], 2, 'm-2')]);
      expect(changes()).toEqual([{ project: REMOTE, id: `${REMOTE}:fp:${AGENT}:${h('2')}`, ts: T + 2000, files: [AGENT], hashes: [h('2')], scope: 'project' }]);
      expect(hashesOf(AGENT)).toEqual({ [CWD]: h('2'), [WT]: h('1') });
    });

    it('the same edit then seen in the second checkout is still one change, now dated at the later sighting', () => {
      plugin([main([[AGENT, h('1')]], 0, 'm-1'), wt([[AGENT, h('1')]], 1, 'w-1')]);
      plugin([main([[AGENT, h('2')]], 2, 'm-2')]);
      plugin([wt([[AGENT, h('2')]], 5, 'w-2')]);
      expect(changes()).toEqual([{ project: REMOTE, id: `${REMOTE}:fp:${AGENT}:${h('2')}`, ts: T + 5000, files: [AGENT], hashes: [h('2')], scope: 'project' }]);
      expect(hashesOf(AGENT)).toEqual({ [CWD]: h('2'), [WT]: h('2') });
    });

    it('a deletion in one checkout does not mark the other\'s file deleted; a checkout\'s first event deletes nothing', () => {
      plugin([main([[AGENT, h('1')], ['CLAUDE.md', h('2')]], 0, 'm-1'), wt([[AGENT, h('1')], ['CLAUDE.md', h('2')]], 1, 'w-1')]);
      plugin([fp([['CLAUDE.md', h('2')]], { ts: T + 2000, session: 'x-1', cwd: '/Users/a/mobile-app-old-branch' })]);
      expect(changes()).toEqual([]);
      plugin([main([['CLAUDE.md', h('2')]], 3, 'm-2')]);
      expect(changes()).toEqual([{ project: REMOTE, id: `${REMOTE}:fp:${AGENT}:deleted`, ts: T + 3000, files: [AGENT], hashes: ['deleted'], scope: 'project' }]);
      expect(hashesOf(AGENT)).toEqual({ [CWD]: 'deleted', [WT]: h('1') });
      plugin([wt([[AGENT, h('1')], ['CLAUDE.md', h('2')]], 4, 'w-2')]);
      expect(changes()).toHaveLength(1);
    });

    // What the plugin sends from a worktree: `cwd` is the repository root, `checkout` is the worktree itself.
    const linked = (files: Parameters<typeof fp>[0], at: number, session: string, checkout = WT) => fp(files, { ts: T + at * 1000, session, cwd: CWD, checkout });

    it('worktree sessions report the repository root as cwd: the checkout, not the cwd, keeps the baseline', () => {
      const events: Event[] = [];
      for (let i = 0; i < 4; i++) events.push(main([[AGENT, h('1')], [RULES, h('3'), 'user']], 2 * i, `m-${i}`), linked([[AGENT, h('2')], [RULES, h('3'), 'user']], 2 * i + 1, `w-${i}`));
      plugin(events.slice(0, 2));
      for (const e of events.slice(2)) plugin([e]);
      expect(changes()).toEqual([]);
      expect(hashesOf(AGENT)).toEqual({ [CWD]: h('1'), [WT]: h('2') });
    });

    it('two worktrees of one repo are two checkouts, and an edit in one reaches only its own baseline', () => {
      const WT2 = '/Users/a/mobile-app-other';
      plugin([linked([[AGENT, h('1')]], 0, 'a-1'), linked([[AGENT, h('1')]], 1, 'b-1', WT2)]);
      plugin([linked([[AGENT, h('2')]], 2, 'a-2')]);
      expect(changes()).toEqual([{ project: REMOTE, id: `${REMOTE}:fp:${AGENT}:${h('2')}`, ts: T + 2000, files: [AGENT], hashes: [h('2')], scope: 'project' }]);
      expect(hashesOf(AGENT)).toEqual({ [WT]: h('2'), [WT2]: h('1') });
      plugin([linked([['CLAUDE.md', h('4')]], 3, 'b-2', WT2)]);
      expect(hashesOf(AGENT)).toEqual({ [WT]: h('2'), [WT2]: 'deleted' });
    });

    it('the owner\'s files are one per project, whichever checkout reports them: one node, one change', () => {
      plugin([main([[RULES, h('3'), 'user']], 0, 'm-1'), wt([[RULES, h('3'), 'user']], 1, 'w-1')]);
      expect(nodes()).toEqual([{ id: `${REMOTE}|${RULES}`, cwd: null, path: RULES, scope: 'user', hash: h('3'), ts: T }]);
      plugin([wt([[RULES, h('4'), 'user']], 2, 'w-2')]);
      plugin([main([[RULES, h('4'), 'user']], 3, 'm-2')]);
      expect(changes()).toEqual([{ project: REMOTE, id: `${REMOTE}:fp:${RULES}:${h('4')}`, ts: T + 2000, files: [RULES], hashes: [h('4')], scope: 'user' }]);
      plugin([wt([['~/.claude/CLAUDE.md', h('5'), 'user']], 4, 'w-3')]);
      expect(changes().map((c) => c.hashes[0])).toEqual([h('4'), 'deleted']);
    });
  });
});

describe('skills, tasks and pull requests', () => {
  it('skill.load keeps when, how and in which turn; one row per event, with the call it came from', () => {
    plugin([
      ev('skill.load', { skill: 'pr-body', tool_use_id: 'toolu_s', how: 'tool', source: 'user' }, { turn: 'tn-1', ts: T + 10 }),
      ev('skill.load', { skill: 'grill', how: 'typed', source: 'user' }, { turn: 'tn-1', ts: T + 20 }),
      ev('skill.load', { skill: 'bare' }, { ts: T + 30 }),
    ]);
    expect(q('SELECT skill, turn_id, tool_use_id, ts, how, source FROM skill_loads ORDER BY ts')).toEqual([
      { skill: 'pr-body', turn_id: 'tn-1', tool_use_id: 'toolu_s', ts: T + 10, how: 'tool', source: 'user' },
      { skill: 'grill', turn_id: 'tn-1', tool_use_id: null, ts: T + 20, how: 'typed', source: 'user' },
      { skill: 'bare', turn_id: null, tool_use_id: null, ts: T + 30, how: null, source: null },
    ]);
  });

  it('a skill catalog lists the skills and agents a session has, one SkillDef per project, kind, origin and name; a later field keeps what an earlier one said', () => {
    const catalog = (session: string, tokens: number) =>
      ev('skills.catalog', {
        skills: [{ name: 'pr-body', source: 'user', tokens, description: 'the PR body', refs: { skills: ['grill'], agents: ['implementer'] } }, { name: 'bare', source: 'user', tokens: 0 }],
        agents: [{ name: 'implementer', source: 'project', tokens: 300, preload: ['pr-body'] }],
      }, { session, remote: REMOTE });
    plugin([start('startup', { remote: REMOTE }), catalog('s-1', 120)]);
    plugin([start('startup', { session: 's-2', remote: REMOTE }), catalog('s-2', 150)]);
    expect(q('SELECT id, kind, source, tokens, description, calls_skills, calls_agents, preload FROM skill_defs ORDER BY id')).toEqual([
      { id: `${REMOTE}|agent|project|implementer`, kind: 'agent', source: 'project', tokens: 300, description: null, calls_skills: null, calls_agents: null, preload: '["pr-body"]' },
      { id: `${REMOTE}|skill|user|bare`, kind: 'skill', source: 'user', tokens: 0, description: null, calls_skills: null, calls_agents: null, preload: null },
      { id: `${REMOTE}|skill|user|pr-body`, kind: 'skill', source: 'user', tokens: 150, description: 'the PR body', calls_skills: '["grill"]', calls_agents: '["implementer"]', preload: null },
    ]);
    expect(q('SELECT session_id, count(*) AS n FROM session_skill_defs GROUP BY session_id ORDER BY session_id')).toEqual([{ session_id: 's-1', n: 3 }, { session_id: 's-2', n: 3 }]);
    // a plugin skill's references arrive with its first load; a load that says nothing of them erases nothing, and tokens stay
    plugin([ev('skill.load', { skill: 'pr-body', source: 'user', plugin: 'ponytail' }, { remote: REMOTE, turn: 'tn-1' })]);
    expect(q(`SELECT plugin, tokens, description, calls_skills FROM skill_defs WHERE name = 'pr-body'`)).toEqual([{ plugin: 'ponytail', tokens: 150, description: 'the PR body', calls_skills: '["grill"]' }]);
  });

  it('a skill def made by a load with no tokens has 0 of them, and the catalog fills it in', () => {
    plugin([start('startup', { remote: REMOTE }), ev('skill.load', { skill: 'new', source: 'plugin', plugin: 'p' }, { remote: REMOTE })]);
    expect(q(`SELECT tokens FROM skill_defs`)).toEqual([{ tokens: 0 }]);
    plugin([ev('skills.catalog', { skills: [{ name: 'new', source: 'plugin', tokens: 77 }], agents: [] }, { remote: REMOTE })]);
    expect(q(`SELECT tokens, plugin FROM skill_defs`)).toEqual([{ tokens: 77, plugin: 'p' }]);
  });

  it('tasks are scoped by session; every agent that touched one is linked, and the newest subject and status stand', () => {
    plugin([
      ev('task.create', { task_id: '1', subject: 'Write', status: 'pending' }, { ts: T + 1 }),
      ev('task.complete', { task_id: '1', subject: 'Write it', status: 'completed' }, { ts: T + 2, agent: 'a1' }),
      ev('task.create', { task_id: '1', subject: 'Elsewhere', status: 'pending' }, { session: 's-2', ts: T + 3 }),
    ]);
    expect(q('SELECT id, subject, status FROM tasks ORDER BY id')).toEqual([{ id: 's-1:1', subject: 'Write it', status: 'completed' }, { id: 's-2:1', subject: 'Elsewhere', status: 'pending' }]);
    expect(q('SELECT agent_id, task_id FROM agent_tasks ORDER BY agent_id, task_id')).toEqual([
      { agent_id: 's-1:a1', task_id: 's-1:1' }, { agent_id: 's-1:main', task_id: 's-1:1' }, { agent_id: 's-2:main', task_id: 's-2:1' },
    ]);
  });

  it('a PR is one per project and number: gh\'s list fills it and links the project, a session links itself, none erases the other, and the owner\'s size is untouched', () => {
    const list = (prs: object[], o: Opts = {}) => ev('project.prs', { prs }, { remote: REMOTE, ...o });
    plugin([start('startup', { remote: REMOTE }), ev('session.pr', { number: 7 }, { remote: REMOTE })]);
    expect(q('SELECT id, project_id, number, title, merged_at FROM pull_requests')).toEqual([{ id: `${REMOTE}:7`, project_id: null, number: 7, title: null, merged_at: null }]);
    plugin([list([{ number: 7, title: 'feat: seven', merged_at: T, additions: 5, deletions: 1, head: 'feat/7' }, { number: 8, merged_at: T + 1, additions: 2, deletions: 0 }], { ts: T + 5 })]);
    run(db, `UPDATE pull_requests SET size = 'M' WHERE number = 7`);
    plugin([list([{ number: 7, merged_at: T, additions: 5, deletions: 2 }], { session: 's-2', ts: T + 6 })]); // an excluded project's list: no title, no head
    expect(q('SELECT id, project_id, title, merged_at, additions, deletions, head, size FROM pull_requests ORDER BY number')).toEqual([
      { id: `${REMOTE}:7`, project_id: REMOTE, title: 'feat: seven', merged_at: T, additions: 5, deletions: 2, head: 'feat/7', size: 'M' },
      { id: `${REMOTE}:8`, project_id: REMOTE, title: null, merged_at: T + 1, additions: 2, deletions: 0, head: null, size: null },
    ]);
    expect(q('SELECT session_id, pr_id FROM session_prs')).toEqual([{ session_id: 's-1', pr_id: `${REMOTE}:7` }]);
    plugin([ev('session.pr', { number: 7 }, { remote: REMOTE, ts: T + 9 })]); // the plugin and the logs say it once
    expect(count('session_prs')).toBe(1);
  });

  // #103: the store keeps no raw events, only their ids, so a link stored before the link times existed can only get its time from the import reading the same event again.
  it('a session.pr event written again (same id) still sets its link\'s time when the stored one is null or later; nothing else of a duplicate is written', () => {
    const link = ev('session.pr', { number: 7 }, { remote: REMOTE, ts: T + 5000 });
    const times = () => q('SELECT ts FROM session_prs').map((r) => r.ts);
    plugin([start('startup', { remote: REMOTE }), link]);
    expect(times()).toEqual([T + 5000]);
    run(db, 'UPDATE session_prs SET ts = NULL'); // a link stored before the times existed
    expect(plugin([link])).toEqual({ accepted: 0, duplicates: 1 });
    expect(times()).toEqual([T + 5000]);
    plugin([{ ...link, ts: T + 9000 }]); // the same id, seen later: the link stays where it was
    expect(times()).toEqual([T + 5000]);
    plugin([{ ...link, ts: T + 2000 }]); // the same id, seen earlier: the link moves back
    expect(times()).toEqual([T + 2000]);

    // any other duplicate is skipped whole, whatever its data says
    const prompt = ev('prompt.submit', { length: 10 }, { prompt: 'pm-1', ts: T + 6000 });
    const list = ev('project.prs', { prs: [{ number: 7, title: 'seven', merged_at: T, additions: 5, deletions: 1 }] }, { remote: REMOTE, ts: T + 7000 });
    plugin([prompt, list]);
    const before = snapshot();
    const again = [{ ...prompt, data: { length: 99 } }, { ...list, data: { prs: [{ number: 7, title: 'other', merged_at: T, additions: 50, deletions: 10 }] } }] as Event[];
    expect(plugin(again)).toEqual({ accepted: 0, duplicates: 2 });
    expect(snapshot()).toEqual(before);
  });
});

describe('turns and requests', () => {
  it('turn.start and turn.complete each fill their half of one turn, in either order, and the later of two says nothing it does not know', () => {
    plugin([ev('turn.complete', { duration_ms: 500, usage_total: { input: 0, output: 0, cache_read: 0, cache_creation: 0 }, reason: 'answer', answer_length: 1 }, { turn: 'tn', ts: T + 500 })]);
    plugin([ev('turn.start', {}, { turn: 'tn', ts: T })]);
    expect(q('SELECT started_at, duration_ms FROM turns')).toEqual([{ started_at: T, duration_ms: 500 }]);
  });

  it('a request is keyed by its event id, costed from pricing.json, and the agent takes the first model it saw', () => {
    const usage = { input: 1000, output: 2000, cache_read: 10_000, cache_creation: 4000 };
    plugin([ev('turn.step', { model: 'claude-opus-5-5', usage, stop_reason: 'end_turn', tool_use_ids: [] }, { turn: 'tn' }), ev('turn.step', { model: 'claude-haiku-5-5', usage, stop_reason: 'end_turn', tool_use_ids: [] }, { turn: 'tn' })]);
    expect(q('SELECT cost_usd FROM api_requests ORDER BY ts')[0]!.cost_usd).toBeCloseTo(costUsd('claude-opus-5-5', usage)!, 12);
    expect(q(`SELECT model FROM agents WHERE id = 's-1:main'`)).toEqual([{ model: 'claude-opus-5-5' }]);
  });
});
