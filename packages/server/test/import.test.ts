import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Event } from '@agent-orb/shared';
import { costUsd } from '../src/cost.ts';
import { importDir, lineReader, report } from '../src/import.ts';
import { all, openStore, run, type Store } from '../src/store/store.ts';
import { writeEvents } from '../src/store/writer.ts';
import { uuid5 } from '../src/transcripts.ts';
import { digest, sessionEvents } from './session-events.ts';

// `import <dir>` into the SQLite history store (v0.2 slice 1, on SQLite since #81 slice 1): a synthetic copy of ~/.claude/projects, built from the line
// shapes Claude Code writes. A temp file each, no container.
let db: Store;
let root: string; // the logs
let data: string; // the store's folder
const fromPlugin = (events: Event[]) => writeEvents(db, events, 'plugin'); // what POST /ingest writes
const fromImport = (events: Event[]) => writeEvents(db, events, 'import');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orb-import-'));
  data = mkdtempSync(join(tmpdir(), 'orb-import-data-'));
  db = openStore(join(data, 'history.db'));
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
});

const at = (hhmmss: string) => `2026-10-20T${hhmmss}.000Z`;
const T = Date.parse(at('06:00:00'));
const file = (rel: string, body: string | object[]) => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === 'string' ? body : body.map((l) => JSON.stringify(l)).join('\n') + '\n');
};

let n = 0;
const base = (sid: string, cwd: string, time: string, extra: object = {}) => ({ uuid: `u-${++n}`, sessionId: sid, timestamp: at(time), cwd, version: '2.1.304', isSidechain: false, ...extra });
const prompt = (sid: string, cwd: string, time: string, promptId: string) => ({ type: 'user', ...base(sid, cwd, time, { promptId }), message: { role: 'user', content: 'a prompt the import must not keep' } });
const reply = (sid: string, cwd: string, time: string, id: string, model: string, usage: [number, number, number, number], content: object[] = [{ type: 'text', text: 'an answer the import must not keep' }], extra: object = {}) =>
  ({ type: 'assistant', ...base(sid, cwd, time, extra), message: { id, model, role: 'assistant', stop_reason: 'end_turn', content, usage: { input_tokens: usage[0], output_tokens: usage[1], cache_read_input_tokens: usage[2], cache_creation_input_tokens: usage[3] } } });
const small = (sid: string, cwd: string) => [prompt(sid, cwd, '07:00:00', `p-${sid}`), reply(sid, cwd, '07:00:02', `msg_${sid}`, 'claude-opus-5-5', [10, 20, 300, 40])];

const WORKTREE = '/Users/a/mobile-app/.claude/worktrees/feat-x';
// s-1: a main file in a worktree, a plain subagent with its meta file, a workflow agent, and files the import must ignore.
function writeMobile() {
  const dir = '-Users-a-mobile-app';
  file(`${dir}/s-1.jsonl`, [
    prompt('s-1', WORKTREE, '07:00:00', 'p1'),
    reply('s-1', WORKTREE, '07:00:02', 'msg_1', 'claude-opus-5-5', [10, 20, 300, 40], [{ type: 'tool_use', id: 'toolu_a1', name: 'Agent', input: { prompt: 'x' } }]),
    { type: 'user', ...base('s-1', WORKTREE, '07:02:00'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: 'report' }] } },
    reply('s-1', WORKTREE, '07:02:05', 'msg_2', 'claude-sonnet-5-5', [5, 60, 200, 0]),
  ]);
  const sub = (id: string, model: string) => [
    { type: 'user', ...base('s-1', WORKTREE, '07:00:05', { agentId: id, isSidechain: true }), message: { role: 'user', content: 'the task' } },
    reply('s-1', WORKTREE, '07:01:00', `msg_${id}`, model, [1, 2, 3, 4], undefined, { agentId: id, isSidechain: true }),
  ];
  file(`${dir}/s-1/subagents/agent-a1.jsonl`, sub('a1', 'claude-haiku-5-5'));
  file(`${dir}/s-1/subagents/agent-a1.meta.json`, JSON.stringify({ agentType: 'Explore', description: 'Find docs', toolUseId: 'toolu_a1', spawnDepth: 1 }));
  file(`${dir}/s-1/subagents/workflows/run1/agent-w1.jsonl`, sub('w1', 'claude-opus-5-5'));
  file(`${dir}/s-1/subagents/workflows/run1/agent-w1.meta.json`, JSON.stringify({ agentType: 'workflow-subagent', description: 'Review', workflowPhase: 'review', spawnDepth: 2 }));
  // ignored: a workflow's json, tool results, a note, an agent file in the wrong place, a script
  file(`${dir}/s-1/subagents/workflows/run1.json`, '{"not":"a transcript"}');
  file(`${dir}/s-1/tool-results/agent-q.jsonl`, sub('q', 'claude-opus-5-5'));
  file(`${dir}/s-1/subagents/other/deeper/agent-z.jsonl`, sub('z', 'claude-opus-5-5'));
  file(`${dir}/notes.md`, '# a note');
  file(`${dir}/scripts/run.jsonl`, sub('s', 'claude-opus-5-5'));
}

// What the plugin recorded earlier: mobile-app (cwds known) and orb (another folder), both with a remote; two projects named twin.
const plugin = (sid: string, project: { cwd: string; name: string; git_remote: string }, source = 'startup'): Event =>
  ({ v: 1, id: `00000000-0000-4000-a000-${String(++n).padStart(12, '0')}`, ts: T + n, host: 'mbp', user_id: 'local', session_id: sid, project, kind: 'session.start',
    data: { model: 'claude-opus-5-5', source, claude_version: '2.1.304', plugin_version: '0.1.0' } }) as Event;
const MOBILE = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
const ORB = { cwd: '/Users/a/orb', name: 'orb', git_remote: 'github.com/o/orb' };
const seed = () => fromPlugin([
  plugin('live-1', MOBILE), plugin('live-2', ORB),
  plugin('t-1', { cwd: '/Users/a/twin', name: 'twin', git_remote: 'github.com/o/twin' }), plugin('t-2', { cwd: '/Users/b/twin', name: 'twin', git_remote: 'github.com/p/twin' }),
]);
const rows = (sql: string, params: Record<string, unknown> = {}) => all(db, sql, params).map((r) => ({ ...r }));
const count = (table: string) => rows(`SELECT count(*) AS n FROM ${table}`)[0]!.n;
const projectOf = (sid: string) => rows('SELECT project_id AS id FROM sessions WHERE id = :sid', { sid }).map((r) => r.id);
// Every table but the ids as sorted text, to compare the store before and after a run, and to search it for text that must not be there.
const dump = () => rows(`SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'ingested' ORDER BY name`)
  .flatMap((t) => rows(`SELECT * FROM ${t.name}`).map((r) => `${t.name} ${JSON.stringify(Object.entries(r).sort())}`)).sort();

describe('import <dir>', () => {
  it('imports sessions, subagents and workflow agents, and ignores every other file', async () => {
    writeMobile();
    const s = await importDir(db, root, { host: 'mbp' });
    expect(s.empty).toBe(0);
    expect(rows(`SELECT t.id AS turn, r.model FROM turns t JOIN api_requests r ON r.turn_id = t.id WHERE t.agent_id = 's-1:main' ORDER BY r.ts`)).toEqual([
      { turn: 's-1:p:p1', model: 'claude-opus-5-5' }, { turn: 's-1:p:p1', model: 'claude-sonnet-5-5' },
    ]);
    expect(rows(`SELECT id, type, model FROM agents WHERE session_id = 's-1' ORDER BY id`)).toEqual([
      { id: 's-1:a1', type: 'Explore', model: 'claude-haiku-5-5' },
      { id: 's-1:main', type: 'main', model: 'claude-opus-5-5' },
      { id: 's-1:w1', type: 'workflow-subagent', model: 'claude-opus-5-5' },
    ]);
    expect(rows(`SELECT a.id AS agent, c.tool, c.success AS ok FROM agents a JOIN tool_calls c ON c.tool_use_id = a.spawn_tool_use_id WHERE a.spawn_tool_use_id = 'toolu_a1'`)).toEqual([{ agent: 's-1:a1', tool: 'Agent', ok: 1 }]);
    expect(rows(`SELECT source, recorded, claude_version AS v, content FROM sessions WHERE id = 's-1'`)).toEqual([
      { source: 'import', recorded: null, v: '2.1.304', content: 'off' },
    ]);
    expect(rows(`SELECT id, length FROM prompts WHERE session_id = 's-1'`)).toEqual([{ id: 'p1', length: 'a prompt the import must not keep'.length }]);
    // every turn ends: the Pipeline's session lanes draw a turn with no duration up to now (07:00:00 to the reply at 07:02:05; the agents' 07:00:05 to 07:01:00)
    expect(rows('SELECT id, duration_ms AS ms FROM turns ORDER BY id')).toEqual([
      { id: 's-1:a1', ms: 55_000 }, { id: 's-1:p:p1', ms: 125_000 }, { id: 's-1:w1', ms: 55_000 },
    ]);
    // the cost is the API-equivalent of the four requests, and the report says so
    const cost = costUsd('claude-opus-5-5', { input: 10, output: 20, cache_read: 300, cache_creation: 40 })! + costUsd('claude-sonnet-5-5', { input: 5, output: 60, cache_read: 200, cache_creation: 0 })!
      + costUsd('claude-haiku-5-5', { input: 1, output: 2, cache_read: 3, cache_creation: 4 })! + costUsd('claude-opus-5-5', { input: 1, output: 2, cache_read: 3, cache_creation: 4 })!;
    expect(s.projects.get('mobile-app')).toMatchObject({ imported: 1, filled: 0, requests: 4, partial: false });
    expect(s.projects.get('mobile-app')!.cost).toBeCloseTo(cost, 12);
    expect(rows('SELECT sum(cost_usd) AS c FROM api_requests')[0]!.c).toBeCloseTo(cost, 12);
    // none of the ignored files made a row
    expect(rows(`SELECT count(*) AS n FROM agents WHERE id IN ('s-1:q', 's-1:z', 's-1:s')`)).toEqual([{ n: 0 }]);
  });

  it('a second run accepts nothing: every event is a duplicate, and the store does not change', async () => {
    writeMobile();
    file('-Users-a-orb/s-3.jsonl', small('s-3', '/Users/a/orb'));
    const first = await importDir(db, root, { host: 'mbp' });
    expect(first.accepted).toBe(23); // s-1: 8 + a1: 5 + w1: 5 + s-3: 5 (each turn ends with a turn.complete)
    const before = dump();
    const second = await importDir(db, root, { host: 'mbp' });
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(first.accepted);
    expect(dump()).toEqual(before);
    expect(count('api_requests')).toBe(5);
  });

  // One day of one session as the logs hold it: a prompt and its one reply two seconds later, six times. The plugin was on for the middle two.
  const DAY: [string, [number, number, number, number]][] = [
    ['07:00', [10, 20, 300, 40]], ['07:30', [11, 21, 301, 41]], ['08:00', [12, 22, 302, 42]], ['08:30', [13, 23, 303, 43]], ['09:30', [14, 24, 304, 44]], ['10:30', [15, 25, 305, 45]],
  ];
  const MIDDLE = ['08:00', '08:30'];
  const exchange = (sid: string, hhmm: string, usage: [number, number, number, number]) =>
    [prompt(sid, '/Users/a/mobile-app', `${hhmm}:00`, `p-${hhmm}`), reply(sid, '/Users/a/mobile-app', `${hhmm}:02`, `msg_${sid}_${hhmm}`, 'claude-opus-5-5', usage)];
  const logs = (sid: string, only = DAY.map(([t]) => t)) => file(`-Users-a-mobile-app/${sid}.jsonl`, DAY.filter(([t]) => only.includes(t)).flatMap(([t, u]) => exchange(sid, t, u)));
  // What the plugin recorded of those exchanges: its own random ids, its own turn ids, its own session.start (a newer Claude Code, content on).
  const usageOf = (hhmm: string) => {
    const [input, output, cache_read, cache_creation] = DAY.find(([t]) => t === hhmm)![1];
    return { input, output, cache_read, cache_creation };
  };
  const plant = (sid: string, hhmms: string[], source = 'startup') => {
    const mk = (kind: string, ts: number, data: object, extra: object = {}) =>
      ({ v: 1, id: `00000000-0000-4000-c000-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'local', session_id: sid, project: MOBILE, kind, data, ...extra }) as Event;
    const when = (hhmm: string, sec: number) => Date.parse(at(`${hhmm}:0${sec}`));
    fromPlugin([
      mk('session.start', when(hhmms[0]!, 0) - 2000, { model: 'claude-opus-5-5', source, claude_version: '2.1.308', plugin_version: '0.1.0', content: 'full' }),
      ...hhmms.flatMap((t, i) => {
        const turn = `plug-turn-${sid}-${i}`;
        return [
          mk('prompt.submit', when(t, 0), { length: 5 }, { prompt_id: `plug-prompt-${sid}-${i}` }),
          mk('turn.start', when(t, 0), {}, { turn_id: turn }),
          mk('turn.step', when(t, 2), { model: 'claude-opus-5-5', usage: usageOf(t), stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: turn }),
        ];
      }),
    ]);
  };
  const requests = (sid: string) => rows(
    `SELECT r.ts, r.input, r.output, r.cache_read, r.cache_creation FROM api_requests r JOIN turns t ON t.id = r.turn_id JOIN agents a ON a.id = t.agent_id WHERE a.session_id = :sid ORDER BY r.ts`, { sid });
  const everyRequest = DAY.map(([t, u]) => ({ ts: Date.parse(at(`${t}:02`)), input: u[0], output: u[1], cache_read: u[2], cache_creation: u[3] }));

  // The plugin's record wins while it ran (its span, a minute wider each side); the logs fill in before and after.
  describe.each([
    ['a session the plugin recorded', false],
    ['an old plugin session: neither source nor recorded on it', true],
  ])('%s, for the middle of the session', (_name, old) => {
    it('every request counts once: the logs add what is outside the plugin\'s stretch, and a second run accepts nothing', async () => {
      plant('live-1', MIDDLE);
      if (old) run(db, `UPDATE sessions SET source = NULL, recorded = NULL WHERE id = 'live-1'`); // the stretch is the plugin's events', not these flags
      logs('live-1');
      const first = await importDir(db, root, { host: 'mbp' });
      expect(requests('live-1')).toEqual(everyRequest); // six requests, none twice: 4 from the logs, the plugin's 2 kept
      expect(rows(`SELECT count(*) AS n FROM prompts WHERE session_id = 'live-1'`)).toEqual([{ n: 6 }]);
      expect(rows(`SELECT count(*) AS n, sum(r.input + r.output + r.cache_read + r.cache_creation) AS tokens FROM api_requests r JOIN turns t ON t.id = r.turn_id JOIN agents a ON a.id = t.agent_id WHERE a.session_id = 'live-1'`))
        .toEqual([{ n: 6, tokens: DAY.reduce((t, [, u]) => t + u[0] + u[1] + u[2] + u[3], 0) }]);
      // the import sent the 4 exchanges outside the stretch (07:00, 07:30, 09:30, 10:30), and counts them under the session's project, as filled in
      expect(first.projects.get('mobile-app')).toMatchObject({ imported: 0, filled: 1, requests: 4, partial: false });
      expect(report(first).join('\n')).toMatch(/mobile-app +0 imported +1 filled +4 requests/);
      expect(report(first).join('\n')).toMatch(/1 sessions filled in around the plugin's own record/);
      // the plugin's session.start stands: version, model and content; the session starts where the logs do
      expect(rows(`SELECT model, claude_version AS v, content, started_at, source, recorded FROM sessions WHERE id = 'live-1'`)).toEqual([
        { model: 'claude-opus-5-5', v: '2.1.308', content: 'full', started_at: Date.parse(at('07:00:00')), source: old ? null : 'startup', recorded: old ? null : 1 },
      ]);
      const before = dump();
      const second = await importDir(db, root, { host: 'mbp' });
      expect(second.accepted).toBe(0);
      expect(dump()).toEqual(before);
      expect(requests('live-1')).toEqual(everyRequest);
      // the stretch is the plugin's alone (#79), so the logs outside it are sent again, as duplicates: the first run's own events are no part of the plugin's record
      expect(second.projects.get('mobile-app')).toMatchObject({ filled: 1, requests: 4 });
    });
  });

  it('a plugin session that recorded all of it (an old one, 1,653 requests in the owner\'s graph): the logs add nothing but its start', async () => {
    plant('live-1', DAY.map(([t]) => t));
    run(db, `UPDATE sessions SET source = NULL, recorded = NULL WHERE id = 'live-1'`);
    logs('live-1');
    const s = await importDir(db, root, { host: 'mbp' });
    expect(requests('live-1')).toEqual(everyRequest); // 6, not 12
    expect(s.accepted).toBe(1); // its session.start
    expect(s.projects.get('mobile-app')).toMatchObject({ imported: 0, filled: 1, requests: 0 });
    expect((await importDir(db, root, { host: 'mbp' })).accepted).toBe(0);
    expect(requests('live-1')).toEqual(everyRequest);
  });

  it('events past the stretch by less than a minute are the plugin\'s: a log line and the plugin\'s event for one request are not at the same millisecond', async () => {
    plant('live-1', ['08:00']); // its prompt 08:00:00, its request 08:00:02: the stretch is 07:59:00 to 08:01:02
    file('-Users-a-mobile-app/live-1.jsonl', [
      prompt('live-1', '/Users/a/mobile-app', '07:59:30', 'p-early'), reply('live-1', '/Users/a/mobile-app', '07:59:31', 'msg_early', 'claude-opus-5-5', [1, 1, 1, 1]), // 30 s before: the plugin's
      ...exchange('live-1', '08:00', DAY[2]![1]),
      reply('live-1', '/Users/a/mobile-app', '08:01:30', 'msg_late', 'claude-opus-5-5', [2, 2, 2, 2]), // 88 s after the request: outside, the logs'
    ]);
    const s = await importDir(db, root, { host: 'mbp' });
    expect(s.projects.get('mobile-app')).toMatchObject({ requests: 1 });
    expect((requests('live-1')).map((r) => r.ts)).toEqual([Date.parse(at('08:00:02')), Date.parse(at('08:01:30'))]);
  });

  it('a plugin session with nothing but its start has no stretch: the logs fill all of it', async () => {
    await seed(); // live-2 is a bare session.start of the ORB project
    file('-Users-a-orb/live-2.jsonl', small('live-2', '/Users/a/orb'));
    const s = await importDir(db, root, { host: 'mbp' });
    expect(s.projects.get('orb')).toMatchObject({ imported: 0, filled: 1, requests: 1 });
    expect(requests('live-2')).toHaveLength(1);
    expect((await importDir(db, root, { host: 'mbp' })).accepted).toBe(0);
  });

  it('a session the import made, then the plugin saw (a resume), then the import again: the plugin\'s request is not counted twice', async () => {
    file('-Users-a-mobile-app/live-1.jsonl', exchange('live-1', '07:00', DAY[0]![1]));
    await importDir(db, root, { host: 'mbp' });
    expect(rows(`SELECT source, recorded FROM sessions WHERE id = 'live-1'`)).toEqual([{ source: 'import', recorded: null }]);
    plant('live-1', ['07:30'], 'resume'); // the plugin saw the session go on; its record has the 07:30 exchange
    expect(rows(`SELECT source, recorded FROM sessions WHERE id = 'live-1'`)).toEqual([{ source: 'import', recorded: 1 }]);
    logs('live-1', ['07:00', '07:30']); // and the logs hold it too
    const s = await importDir(db, root, { host: 'mbp' });
    expect((requests('live-1')).map((r) => r.ts)).toEqual([Date.parse(at('07:00:02')), Date.parse(at('07:30:02'))]); // not three
    expect(s.accepted).toBe(0);
  });

  // #79: the stretch is what the plugin wrote, so the part of an imported session before the plugin's first event stays the import's, and a re-import updates it.
  it('a session the plugin resumed an hour after its last line takes a new shape on its early calls on the next import, and keeps the plugin\'s own record', async () => {
    const SID = 's-79';
    const gh = (text: string, later?: string) => [
      prompt(SID, '/Users/a/mobile-app', '07:00:00', 'p1'),
      reply(SID, '/Users/a/mobile-app', '07:00:02', 'msg_1', 'claude-opus-5-5', [1, 1, 1, 1], [{ type: 'tool_use', id: 't_gh', name: 'Bash', input: { command: 'gh issue edit 12 --add-label bug' } }]),
      { type: 'user', ...base(SID, '/Users/a/mobile-app', '07:00:09'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't_gh', content: text, is_error: true }] } },
      // what the logs say of the hour after the plugin's start: the plugin recorded these itself
      ...(later ? [
        reply(SID, '/Users/a/mobile-app', '08:30:10', 'msg_2', 'claude-opus-5-5', [1, 1, 1, 1], [{ type: 'tool_use', id: 't_plug', name: 'Bash', input: { command: 'sleep 30' } }]),
        { type: 'user', ...base(SID, '/Users/a/mobile-app', '08:30:11'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't_plug', content: later, is_error: true }] } },
      ] : []),
    ];
    const shapes = () => rows('SELECT tool_use_id AS id, error_shape AS shape FROM tool_calls ORDER BY tool_use_id');
    file(`-Users-a-mobile-app/${SID}.jsonl`, gh('Exit code 1\nGraphQL: the board is gone (repository.issue.projectCards)'));
    await importDir(db, root, { host: 'mbp' });
    expect(shapes()[0]!.shape).toMatch(/^h:[0-9a-f]{8}$/);

    // the plugin sees the session resume an hour after its last line, and records a call of its own
    const mk = (kind: string, hhmmss: string, data: object, extra: object = {}) =>
      ({ v: 1, id: `00000000-0000-4000-c100-${String(++n).padStart(12, '0')}`, ts: Date.parse(at(hhmmss)), host: 'mbp', user_id: 'local', session_id: SID, project: MOBILE, kind, data, ...extra }) as Event;
    fromPlugin([
      mk('session.start', '08:30:00', { model: 'claude-opus-5-5', source: 'resume', claude_version: '2.1.308', plugin_version: '0.1.0' }),
      mk('prompt.submit', '08:30:05', { length: 5 }, { prompt_id: 'plug-p' }),
      mk('tool.call', '08:30:10', { tool_use_id: 't_plug', tool: 'Bash', input_size: 12 }, { turn_id: 'plug-turn' }),
      mk('tool.result', '08:30:11', { tool_use_id: 't_plug', success: false, error_type: 'error', error_class: 'refused', error_shape: 'hook_blocked', duration_ms: 1, output_size: 1, files_touched: [] }, { turn_id: 'plug-turn' }),
    ]);

    // the next import has a newer table, and the logs hold the plugin's hour too
    file(`-Users-a-mobile-app/${SID}.jsonl`, gh('Exit code 1\nGraphQL: Projects (classic) is being deprecated in favor of the new Projects experience', 'Blocked: sleep 30 followed by: x'));
    const again = await importDir(db, root, { host: 'mbp' });
    expect(again.accepted).toBeGreaterThan(0);
    expect(shapes()).toEqual([{ id: 't_gh', shape: 'gh_projects_classic' }, { id: 't_plug', shape: 'hook_blocked' }]); // the early call is updated, the plugin's is not
    expect((await importDir(db, root, { host: 'mbp' })).accepted).toBe(0);
  });

  it('a session the plugin never saw is imported whole, as before', async () => {
    await seed();
    file('-Users-a-mobile-app/old-1.jsonl', small('old-1', '/Users/a/mobile-app'));
    const s = await importDir(db, root, { host: 'mbp' });
    expect(s.projects.get('mobile-app')).toMatchObject({ imported: 1, filled: 0, requests: 1 });
    expect(rows(`SELECT source, recorded FROM sessions WHERE id = 'old-1'`)).toEqual([{ source: 'import', recorded: null }]);
  });

  it('files a session under the project: by its cwds (a worktree cut back), by its folder name, else a new one with no remote', async () => {
    await seed();
    writeMobile(); // cwd is a worktree of /Users/a/mobile-app
    file('-Users-b-orb/s-3.jsonl', small('s-3', '/Users/b/orb')); // another path, one project named orb
    file('-Users-a-brandnew/s-4.jsonl', small('s-4', '/Users/a/brandnew'));
    file('-Users-c-twin/s-5.jsonl', small('s-5', '/Users/c/twin')); // two projects named twin: not exactly one, so a new project
    file('-Users-a-brandnew/s-6.jsonl', small('s-6', '/Users/a/brandnew/.claude/worktrees/y')); // the new project is found by its cwds
    await importDir(db, root, { host: 'mbp' });
    expect(projectOf('s-1')).toEqual(['github.com/o/mobile-app']);
    expect(projectOf('s-3')).toEqual(['github.com/o/orb']);
    expect(projectOf('s-4')).toEqual(['mbp:/Users/a/brandnew']);
    expect(projectOf('s-6')).toEqual(['mbp:/Users/a/brandnew']);
    expect(projectOf('s-5')).toEqual(['mbp:/Users/c/twin']);
    expect(rows('SELECT id, name FROM projects ORDER BY id').map((p) => ({ ...p, cwds: rows('SELECT cwd FROM project_cwds WHERE project_id = :id ORDER BY cwd', { id: p.id }).map((c) => c.cwd) }))).toEqual([
      { id: 'github.com/o/mobile-app', name: 'mobile-app', cwds: ['/Users/a/mobile-app'] },
      { id: 'github.com/o/orb', name: 'orb', cwds: ['/Users/a/orb', '/Users/b/orb'] },
      { id: 'github.com/o/twin', name: 'twin', cwds: ['/Users/a/twin'] },
      { id: 'github.com/p/twin', name: 'twin', cwds: ['/Users/b/twin'] },
      { id: 'mbp:/Users/a/brandnew', name: 'brandnew', cwds: ['/Users/a/brandnew'] },
      { id: 'mbp:/Users/c/twin', name: 'twin', cwds: ['/Users/c/twin'] },
    ]);
  });

  it('a project the import made is re-homed when the plugin later reports its remote', async () => {
    file('-Users-a-brandnew/s-4.jsonl', small('s-4', '/Users/a/brandnew'));
    await importDir(db, root, { host: 'mbp' });
    expect(projectOf('s-4')).toEqual(['mbp:/Users/a/brandnew']);
    fromPlugin([plugin('live-9', { cwd: '/Users/a/brandnew', name: 'brandnew', git_remote: 'github.com/o/brandnew' })]);
    expect(projectOf('s-4')).toEqual(['github.com/o/brandnew']);
    expect(count('projects')).toBe(1);
  });

  it('a session counts the repeated lines of a resumed copy once, and a file with nothing to import is counted, not an error', async () => {
    const original = small('s-7', '/Users/a/mobile-app');
    file('-Users-a-mobile-app/s-7.jsonl', original);
    file('-Users-a-mobile-app/s-8.jsonl', [...original, ...small('s-8', '/Users/a/mobile-app').slice(1)]); // a resume: the history it resumed first, as it was written
    file('-Users-a-mobile-app/s-9.jsonl', [{ type: 'summary', summary: 'x' }, { type: 'queue-operation', timestamp: at('07:00:00') }]);
    file('-Users-a-mobile-app/s-10.jsonl', '');
    const s = await importDir(db, root, { host: 'mbp' });
    expect(s.empty).toBe(2);
    expect(s.repeated).toBe(2);
    expect(s.projects.get('mobile-app')).toMatchObject({ imported: 2, requests: 2 });
    expect(count('api_requests')).toBe(2);
  });

  it('the host is ORB_HOST, else the one host in the history, else an error that says what to set', async () => {
    file('-Users-a-mobile-app/s-1.jsonl', small('s-1', '/Users/a/mobile-app'));
    await expect(importDir(db, root)).rejects.toThrow(/no host yet; set ORB_HOST/);
    await seed(); // host mbp
    await importDir(db, root);
    expect(rows(`SELECT host FROM sessions WHERE id = 's-1'`)).toEqual([{ host: 'mbp' }]);
    fromPlugin([{ ...plugin('far-1', MOBILE), host: 'nas' } as Event]);
    await expect(importDir(db, root)).rejects.toThrow(/2 hosts \(mbp, nas\).*ORB_HOST/);
    await importDir(db, root, { host: 'nas' }); // given: no error
  });
});

describe('an empty folder', () => {
  it('imports nothing and says the folder holds no session logs (a mount that is not there looks like this)', async () => {
    file('-Users-a-mobile-app/notes.md', '# nothing to import');
    const s = await importDir(db, root, { host: 'mbp' });
    expect(s).toMatchObject({ found: 0, accepted: 0, empty: 0 });
    expect(report(s).join('\n')).toMatch(/No session logs found.*mounted at \/import/);
  });
});

describe('report', () => {
  it('one line per project, the totals and the time; ≥ when a model has no price', () => {
    const lines = report({
      projects: new Map([['mobile-app', { imported: 41, filled: 3, requests: 12_345, cost: 1234.5, partial: false }], ['orb', { imported: 2, filled: 0, requests: 10, cost: 0.5, partial: true }]]),
      found: 44, accepted: 9000, duplicates: 12, empty: 1, repeated: 0, ms: 38_250,
    });
    expect(lines[0]).toMatch(/^mobile-app +41 imported +3 filled +12,345 requests +\$1,234\.50$/);
    expect(lines[1]).toMatch(/^orb +2 imported +0 filled +10 requests +≥ \$0\.50$/);
    expect(lines[2]).toMatch(/^total +43 imported +3 filled +12,355 requests +≥ \$1,235\.00$/);
    expect(lines[3]).toBe('9,000 events new, 12 already there · 38.3 s');
    expect(lines.join('\n')).toMatch(/1 sessions had nothing to import/);
    expect(lines.join('\n')).toMatch(/3 sessions filled in around the plugin's own record/);
  });
});

// The image's entry point: cli.ts is what `docker compose run --rm orb-server import /import` runs. `serve` as the default is cli-serve.test.ts.
// The store is history.db beside CONTENT_DB; the child writes the file this test has open, as the one-off import does beside a running server.
describe('cli.ts', () => {
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  const env = () => ({ PATH: process.env.PATH, CONTENT_DB: join(data, 'content.db') });

  it('import <dir> reads the environment, imports and prints one line per project, then the totals', async () => {
    writeMobile();
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'import', root], { env: { ...env(), ORB_HOST: 'mbp' } });
    expect(stdout).toMatch(/^mobile-app +1 imported +0 filled +4 requests +\$[\d.]+$/m);
    expect(stdout).toMatch(/^total +1 imported/m);
    expect(stdout).toMatch(/^18 events new, 0 already there · [\d.]+ s$/m);
    expect(count('sessions')).toBe(1); // the file this process has open
    const again = await promisify(execFile)(process.execPath, [cli, 'import', root], { env: { ...env(), ORB_HOST: 'mbp' } });
    expect(again.stdout).toMatch(/^0 events new, 18 already there/m);
  }, 60_000);

  it('says what is missing and exits non-zero: a directory, a host', async () => {
    const run_ = (args: string[], e: NodeJS.ProcessEnv) => promisify(execFile)(process.execPath, [cli, ...args], { env: e });
    await expect(run_(['import'], env())).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('usage') });
    await expect(run_(['frobnicate'], env())).rejects.toMatchObject({ code: 2 });
    await expect(run_(['import', join(root, 'nope')], env())).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('nope is not a folder') });
    await expect(run_(['import', root], env())).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('no host yet; set ORB_HOST') });
  }, 60_000);
});

// #86: the import reads a session as a stream, so its memory does not grow with the session. The 150 MB itself is `pnpm import-check`, a gate-time check.
describe('import <dir>: a session is read as a stream (#86)', () => {
  const path = () => join(root, 'lines.txt');
  const read = (reader = lineReader(), p = path()) => [...reader(p)];

  it('reads the lines a file holds: across the buffer\'s end, a multi-byte character on it, a line longer than the buffer, the last with no newline, and empty lines', () => {
    const BUF = 256 * 1024; // the reader's first buffer
    const lines = ['', 'a', 'é'.repeat(10), 'x'.repeat(300_000), '日本語'.repeat(50_000), '{"k":"v"}', 'a'.repeat(BUF - 1) + 'é' + 'b', 'y'.repeat(BUF), 'z'.repeat(BUF + 1), '', 'last'];
    for (const body of [lines.join('\n') + '\n', lines.join('\n')]) {
      writeFileSync(path(), body);
      expect(read()).toEqual(lines);
    }
    writeFileSync(path(), '');
    expect(read()).toEqual([]);
  });

  it('one reader serves a run: a small file after a file that made the buffer grow still reads whole', () => {
    const big = join(root, 'big.txt');
    writeFileSync(big, ['q'.repeat(3_000_000), 'after'].join('\n') + '\n');
    writeFileSync(path(), 'one\ntwo\n');
    const reader = lineReader();
    expect(read(reader, big).map((l) => l.length)).toEqual([3_000_000, 5]);
    expect(read(reader)).toEqual(['one', 'two']);
  });

  it('offers a collection every 2 MB of lines read', () => {
    writeFileSync(path(), (('x'.repeat(999) + '\n').repeat(5000)));
    let offered = 0;
    expect(read(lineReader(() => offered++))).toHaveLength(5000);
    expect(offered).toBe(2); // 4,995,000 bytes of lines
  });

  it('writes a batch of 500 as soon as it is built, whatever is left of the session, and offers a collection after each', async () => {
    const SID = 's-big';
    const cwd = '/Users/a/mobile-app';
    const tool = (r: number) => ({ type: 'tool_use', id: `toolu_${r}`, name: 'Bash', input: { command: 'echo' } });
    const ls: object[] = [prompt(SID, cwd, '07:00:00', 'p1')];
    for (let r = 0; r < 1200; r++) {
      ls.push(reply(SID, cwd, '07:00:02', `msg_${r}`, 'claude-opus-5-5', [1, 2, 3, 4], [tool(r)]));
      ls.push({ type: 'user', ...base(SID, cwd, '07:00:03'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${r}`, content: 'ok' }] } });
    }
    file(`-Users-a-mobile-app/${SID}.jsonl`, ls);
    const written: number[] = [];
    const s = await importDir(db, root, { host: 'mbp', collect: () => written.push(count('ingested')) });
    expect(s.accepted).toBe(1200 * 3 + 4); // a step, a call and a result a round; the prompt, its turn start and end; the session start
    expect(written.slice(0, -1)).toEqual(Array.from({ length: written.length - 1 }, (_, i) => 500 * (i + 1))); // each batch of 500 was in the history when the collector was offered
    expect(written.at(-1)).toBe(s.accepted);
    expect(written.length).toBe(Math.ceil(s.accepted / 500));
  });

  it('the main agent\'s model is the first line\'s, as the session\'s, in a session of several batches whose earliest request by time is another\'s', async () => {
    const SID = 's-model';
    const cwd = '/Users/a/mobile-app';
    const ls = [
      reply(SID, cwd, '07:00:05', 'msg_first', 'claude-opus-5-5', [1, 1, 1, 1]), // the first line
      reply(SID, cwd, '07:00:01', 'msg_early', 'claude-haiku-5-5', [1, 1, 1, 1]), // a line after it that is earlier in time
      ...Array.from({ length: 700 }, (_, r) => reply(SID, cwd, '07:01:00', `msg_${r}`, 'claude-opus-5-5', [1, 1, 1, 1])),
    ];
    file(`-Users-a-mobile-app/${SID}.jsonl`, ls);
    await importDir(db, root, { host: 'mbp' });
    expect(rows(`SELECT model FROM agents WHERE id = '${SID}:main'`)).toEqual([{ model: 'claude-opus-5-5' }]);
  });

  it('counts a message of a resumed copy once whichever file reaches it first, in one run and in the next on the same connection', async () => {
    const ls = small('s-1', '/Users/a/mobile-app');
    file('-Users-a-mobile-app/s-1.jsonl', ls);
    file('-Users-a-mobile-app/s-2.jsonl', ls); // the same lines in another file: a resumed session copies the history it resumed
    const first = await importDir(db, root, { host: 'mbp' });
    expect(first.repeated).toBe(2); // the reply and the prompt of the copy
    const again = await importDir(db, root, { host: 'mbp' }); // the ids of the first run are not the second run's
    expect(again.repeated).toBe(2);
    expect(again.accepted).toBe(0);
  });
});

// v0.3 slice 1 (#43): the import classifies the calls it reads and records the files a Read, Edit or Write touched, from lines alone.
describe('import <dir>: classes and files (v0.3 slice 1)', () => {
  const SID = 's-9';
  const WT = '/Users/a/mobile-app/.claude/worktrees/feat-x';
  const toolUse = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
  const result = (time: string, ...blocks: [string, string, boolean?][]) =>
    ({ type: 'user', ...base(SID, WT, time), message: { role: 'user', content: blocks.map(([id, content, bad]) => ({ type: 'tool_result', tool_use_id: id, content, ...(bad ? { is_error: true } : {}) })) } });
  const lines = () => [
    prompt(SID, WT, '07:00:00', 'p1'),
    reply(SID, WT, '07:00:02', 'msg_9', 'claude-opus-5-5', [1, 2, 3, 4], [
      toolUse('t_test', 'Bash', { command: 'pnpm -C /Users/a/mobile-app test' }),
      toolUse('t_ls', 'Bash', { command: 'ls src' }),
      toolUse('t_read', 'Read', { file_path: `${WT}/src/a.ts` }),
      toolUse('t_edit', 'Edit', { file_path: `${WT}/src/a.ts`, old_string: 'x', new_string: 'y' }),
      toolUse('t_miss', 'Edit', { file_path: `${WT}/src/a.ts`, old_string: 'gone', new_string: 'y' }),
      toolUse('t_write', 'Write', { file_path: `${WT}/docs/new.md`, content: 'x' }),
    ]),
    result('07:00:09', ['t_test', 'Exit code 1\n FAIL test/a.test.ts', true], ['t_ls', 'a.ts'], ['t_read', 'x'], ['t_edit', 'ok'],
      ['t_miss', '<tool_use_error>String to replace not found in file.</tool_use_error>', true], ['t_write', 'ok']),
  ];
  const classes = () => rows('SELECT tool_use_id AS id, command_class, error_class, success AS ok FROM tool_calls ORDER BY tool_use_id');
  const touched = () => rows('SELECT tool_use_id AS id, mode, path, project_id AS project FROM files_touched ORDER BY tool_use_id');
  const WANT_CLASSES = [
    { id: 't_edit', command_class: null, error_class: null, ok: 1 },
    { id: 't_ls', command_class: 'other', error_class: null, ok: 1 },
    { id: 't_miss', command_class: null, error_class: 'no_match', ok: 0 },
    { id: 't_read', command_class: null, error_class: null, ok: 1 },
    { id: 't_test', command_class: 'test', error_class: 'exit_code', ok: 0 },
    { id: 't_write', command_class: null, error_class: null, ok: 1 },
  ];
  const WANT_TOUCHED = [
    { id: 't_edit', mode: 'write', path: 'src/a.ts', project: 'mbp:/Users/a/mobile-app' },
    { id: 't_read', mode: 'read', path: 'src/a.ts', project: 'mbp:/Users/a/mobile-app' },
    { id: 't_write', mode: 'write', path: 'docs/new.md', project: 'mbp:/Users/a/mobile-app' },
  ];

  it('stores the classes and the project-relative files, keeps no text, and a second run adds nothing', async () => {
    file(`-Users-a-mobile-app/${SID}.jsonl`, lines());
    const first = await importDir(db, root, { host: 'mbp' });
    expect(classes()).toEqual(WANT_CLASSES);
    expect(touched()).toEqual(WANT_TOUCHED);
    expect(dump().join('\n')).not.toMatch(/FAIL|pnpm|String to replace/); // neither the command nor the output
    const second = await importDir(db, root, { host: 'mbp' });
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(first.accepted);
    expect(classes()).toEqual(WANT_CLASSES);
    expect(touched()).toEqual(WANT_TOUCHED);
  });

  it('a history imported before this slice takes the classes and the files on the next run, and nothing doubles', async () => {
    file(`-Users-a-mobile-app/${SID}.jsonl`, lines());
    const NAMESPACE = '5e1c2a1e-7c0b-4f0e-9a52-0c6b8f3d7a41';
    const evs = await sessionEvents(SID, await digest(lines(), 'main'), [], { host: 'mbp', project: { cwd: '/Users/a/mobile-app', name: 'mobile-app' } });
    // what the v0.2 import wrote: the same events with the ids they had, and no class and no file
    const before = evs.map((e) => {
      if (e.kind === 'tool.call') return { ...e, id: uuid5(NAMESPACE, `${SID}|tool.call|${e.data.tool_use_id}`), data: { ...e.data, command_class: undefined } };
      if (e.kind === 'tool.result') return { ...e, id: uuid5(NAMESPACE, `${SID}|tool.result|${e.data.tool_use_id}`), data: { ...e.data, error_class: undefined, files_touched: [] } };
      return e;
    }) as Event[];
    fromImport(before);
    expect(classes()).toEqual(WANT_CLASSES.map((c) => ({ ...c, command_class: null, error_class: null })));
    expect(touched()).toEqual([]);
    const second = await importDir(db, root, { host: 'mbp' });
    expect(second.accepted).toBe(7); // the 2 Bash calls, which now say a class, and the 5 results with a class or a path (t_test, t_miss, t_read, t_edit, t_write); the rest are as they were
    expect(classes()).toEqual(WANT_CLASSES);
    expect(touched()).toEqual(WANT_TOUCHED);
    expect(count('tool_calls')).toBe(6);
    expect((await importDir(db, root, { host: 'mbp' })).accepted).toBe(0);
  });
});

// v0.3 slice 3 (#45): the shape of a failed call, so failure patterns can group the same failure across sessions.
describe('import <dir>: error shapes (v0.3 slice 3)', () => {
  const SID = 's-8';
  const NAMESPACE = '5e1c2a1e-7c0b-4f0e-9a52-0c6b8f3d7a41';
  const toolUse = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
  const result = (time: string, ...blocks: [string, string, boolean?][]) =>
    ({ type: 'user', ...base(SID, '/Users/a/mobile-app', time), message: { role: 'user', content: blocks.map(([id, content, bad]) => ({ type: 'tool_result', tool_use_id: id, content, ...(bad ? { is_error: true } : {}) })) } });
  const lines = () => [
    prompt(SID, '/Users/a/mobile-app', '07:00:00', 'p1'),
    reply(SID, '/Users/a/mobile-app', '07:00:02', 'msg_8', 'claude-opus-5-5', [1, 2, 3, 4], [
      toolUse('t_test', 'Bash', { command: 'pnpm -C /Users/a/mobile-app test' }),
      toolUse('t_sleep', 'Bash', { command: 'sleep 30 && tail -f /tmp/SECRETWORD' }),
      toolUse('t_bare', 'Bash', { command: 'false' }),
      toolUse('t_ls', 'Bash', { command: 'ls' }),
    ]),
    result('07:00:09', ['t_test', 'Exit code 1\n FAIL  test/a.test.ts\nSECRETWORD', true], ['t_sleep', '<tool_use_error>Blocked: sleep 30 followed by: tail -f /tmp/SECRETWORD</tool_use_error>', true],
      ['t_bare', 'Exit code 1', true], ['t_ls', 'a.ts']),
  ];
  const stored = () => rows('SELECT tool_use_id AS id, error_class, error_shape FROM tool_calls ORDER BY tool_use_id');
  const WANT = [
    { id: 't_bare', error_class: 'exit_code', error_shape: null }, // a bare exit code has no shape
    { id: 't_ls', error_class: null, error_shape: null },
    { id: 't_sleep', error_class: 'refused', error_shape: 'sleep_blocked' },
    { id: 't_test', error_class: 'exit_code', error_shape: 'h:dc10f167' }, // Bash, test, "FAIL P": worked out apart, in python
  ];

  it('stores the shape of a failed call, keeps no text, and a second run adds nothing', async () => {
    file(`-Users-a-mobile-app/${SID}.jsonl`, lines());
    const first = await importDir(db, root, { host: 'mbp' });
    expect(stored()).toEqual(WANT);
    expect(dump().join('\n')).not.toMatch(/SECRETWORD|FAIL|tail/);
    const second = await importDir(db, root, { host: 'mbp' });
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(first.accepted);
    expect(stored()).toEqual(WANT);
  });

  it('a result whose shape changes between runs (a pattern added to the table since) takes the new one on the next run: no second call, and the run after accepts nothing', async () => {
    const log = (text: string) => [
      prompt(SID, '/Users/a/mobile-app', '07:00:00', 'p1'),
      reply(SID, '/Users/a/mobile-app', '07:00:02', 'msg_8', 'claude-opus-5-5', [1, 2, 3, 4], [toolUse('t_gh', 'Bash', { command: 'gh issue edit 12 --add-label bug' })]),
      result('07:00:09', ['t_gh', text, true]),
    ];
    const shapeOf = () => rows('SELECT tool_use_id AS id, error_shape AS shape FROM tool_calls');
    file(`-Users-a-mobile-app/${SID}.jsonl`, log('Exit code 1\nGraphQL: the board is gone (repository.issue.projectCards)'));
    expect((await importDir(db, root, { host: 'mbp' })).accepted).toBeGreaterThan(0);
    const [first] = shapeOf();
    expect(first!.shape).toMatch(/^h:[0-9a-f]{8}$/);
    file(`-Users-a-mobile-app/${SID}.jsonl`, log('Exit code 1\nGraphQL: Projects (classic) is being deprecated in favor of the new Projects experience'));
    expect((await importDir(db, root, { host: 'mbp' })).accepted).toBe(1); // the result alone
    expect(shapeOf()).toEqual([{ id: 't_gh', shape: 'gh_projects_classic' }]); // one call, with the new shape
    expect((await importDir(db, root, { host: 'mbp' })).accepted).toBe(0);
    expect(shapeOf()).toEqual([{ id: 't_gh', shape: 'gh_projects_classic' }]);
  });

  it('a history imported with the classes alone (slice 1) takes the shapes on the next run: only the results that gain one are new, and nothing doubles', async () => {
    file(`-Users-a-mobile-app/${SID}.jsonl`, lines());
    const evs = await sessionEvents(SID, await digest(lines(), 'main'), [], { host: 'mbp', project: { cwd: '/Users/a/mobile-app', name: 'mobile-app' } });
    // what the slice 1 import wrote: the result has its class and the id with |v2, and no shape
    const before = evs.map((e) => {
      if (e.kind !== 'tool.result' || !('error_shape' in e.data)) return e;
      const { error_shape: _shape, ...data } = e.data;
      return { ...e, id: uuid5(NAMESPACE, `${SID}|tool.result|${e.data.tool_use_id}|v2`), data };
    }) as Event[];
    fromImport(before);
    expect(stored()).toEqual(WANT.map((w) => ({ ...w, error_shape: null })));
    const second = await importDir(db, root, { host: 'mbp' });
    expect(second.accepted).toBe(2); // t_test and t_sleep gained a shape; t_bare did not and keeps its |v2 id, t_ls is as it was
    expect(stored()).toEqual(WANT);
    expect(count('tool_calls')).toBe(4);
    expect((await importDir(db, root, { host: 'mbp' })).accepted).toBe(0);
  });
});

// v0.3 slice 2 (#42, Worth): Claude Code's `pr-link` lines link a session to the PRs it opened, so Worth can say what a PR cost.
describe('import <dir>: PR links (v0.3 slice 2)', () => {
  const link = (sid: string, n: number, repo: string, time: string) =>
    ({ type: 'pr-link', sessionId: sid, prNumber: n, prUrl: `https://github.com/${repo}/pull/${n}`, prRepository: repo, timestamp: at(time) });
  const opened = () => rows('SELECT s.session_id AS session, pr.id AS pr, pr.number, pr.merged_at AS merged FROM session_prs s JOIN pull_requests pr ON pr.id = s.pr_id ORDER BY session, number');
  const lines = (sid: string, cwd: string, ...more: object[]) => [...small(sid, cwd), ...more];

  it('a session of a project whose remote the graph knows opens the PRs of that repository, once each; a second run accepts nothing', async () => {
    await seed(); // mobile-app, with its remote
    file('-Users-a-mobile-app/p-1.jsonl', lines('p-1', '/Users/a/mobile-app',
      link('p-1', 7, 'o/mobile-app', '07:05:00'), link('p-1', 7, 'o/mobile-app', '07:06:00'), link('p-1', 8, 'o/mobile-app', '07:30:00'), // PR 7 twice
      link('p-1', 3, 'someone/else', '07:07:00'), // another repository
      link('other-session', 9, 'o/mobile-app', '07:08:00'))); // the line of a session whose history this file copied
    const first = await importDir(db, root, { host: 'mbp' });
    expect(opened()).toEqual([
      { session: 'p-1', pr: 'github.com/o/mobile-app:7', number: 7, merged: null }, // a PR the import knows of is not a merged one: gh's list says when
      { session: 'p-1', pr: 'github.com/o/mobile-app:8', number: 8, merged: null },
    ]);
    const second = await importDir(db, root, { host: 'mbp' });
    expect(second.accepted).toBe(0);
    expect(second.duplicates).toBe(first.accepted);
    expect(opened()).toHaveLength(2);
    expect(dump().join('\n')).not.toMatch(/someone|pull\//); // no URL, no other repository
  });

  it('running the import again gives a link stored without a time its time: the same log line makes the same event (#103)', async () => {
    await seed();
    file('-Users-a-mobile-app/p-1.jsonl', lines('p-1', '/Users/a/mobile-app', link('p-1', 7, 'o/mobile-app', '07:06:00'), link('p-1', 7, 'o/mobile-app', '07:05:00')));
    await importDir(db, root, { host: 'mbp' });
    const times = () => rows('SELECT ts FROM session_prs').map((r) => r.ts);
    expect(times()).toEqual([Date.parse(at('07:05:00'))]);
    run(db, 'UPDATE session_prs SET ts = NULL'); // a link stored before #103
    expect((await importDir(db, root, { host: 'mbp' })).accepted).toBe(0);
    expect(times()).toEqual([Date.parse(at('07:05:00'))]);
  });

  it('a project with no remote links nothing: it cannot tell whose PR it is', async () => {
    file('-Users-a-brandnew/p-2.jsonl', lines('p-2', '/Users/a/brandnew', link('p-2', 7, 'o/brandnew', '07:05:00')));
    const s = await importDir(db, root, { host: 'mbp' });
    expect(s.accepted).toBeGreaterThan(0);
    expect(opened()).toEqual([]);
    expect(count('pull_requests')).toBe(0);
  });

  it('a link joins a PR gh already listed: one row, with its title and merge time', async () => {
    await seed();
    fromPlugin([({ v: 1, id: `00000000-0000-4000-e000-${String(++n).padStart(12, '0')}`, ts: T + 1, host: 'mbp', user_id: 'local', session_id: 'live-1', project: MOBILE, kind: 'project.prs',
      data: { prs: [{ number: 7, title: 'feat: seven', merged_at: Date.parse(at('09:00:00')), additions: 5, deletions: 1 }] } }) as Event]);
    file('-Users-a-mobile-app/p-1.jsonl', lines('p-1', '/Users/a/mobile-app', link('p-1', 7, 'o/mobile-app', '07:05:00')));
    await importDir(db, root, { host: 'mbp' });
    expect(opened()).toEqual([{ session: 'p-1', pr: 'github.com/o/mobile-app:7', number: 7, merged: Date.parse(at('09:00:00')) }]);
    expect(rows('SELECT title, count(*) AS n FROM pull_requests')).toEqual([{ title: 'feat: seven', n: 1 }]);
  });

  it('a session the plugin recorded still gets its link when the line falls inside the stretch the plugin recorded, and one link when the plugin sent it too', async () => {
    const mk = (kind: string, ts: number, data: object, extra: object = {}) =>
      ({ v: 1, id: `00000000-0000-4000-e100-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'local', session_id: 'live-1', project: MOBILE, kind, data, ...extra }) as Event;
    fromPlugin([
      plugin('live-1', MOBILE),
      mk('prompt.submit', Date.parse(at('08:00:00')), { length: 5 }, { prompt_id: 'plug-p' }), // the plugin's stretch: 07:59:00 to 08:01:00
      mk('session.pr', Date.parse(at('08:00:40')), { number: 7 }), // what the plugin saw in a tool's output
    ]);
    file('-Users-a-mobile-app/live-1.jsonl', [
      prompt('live-1', '/Users/a/mobile-app', '08:00:00', 'p-0800'), reply('live-1', '/Users/a/mobile-app', '08:00:02', 'msg_live', 'claude-opus-5-5', [1, 2, 3, 4]),
      link('live-1', 7, 'o/mobile-app', '08:00:30'), link('live-1', 8, 'o/mobile-app', '08:00:31'), // inside the stretch: 8 is one the plugin did not see
    ]);
    await importDir(db, root, { host: 'mbp' });
    expect(opened()).toEqual([
      { session: 'live-1', pr: 'github.com/o/mobile-app:7', number: 7, merged: null },
      { session: 'live-1', pr: 'github.com/o/mobile-app:8', number: 8, merged: null },
    ]);
    expect(rows(`SELECT count(*) AS n FROM session_prs WHERE session_id = 'live-1' AND pr_id LIKE '%:7'`)).toEqual([{ n: 1 }]);
    expect(rows(`SELECT count(*) AS n FROM prompts WHERE session_id = 'live-1'`)).toEqual([{ n: 1 }]); // the stretch still holds: the prompt is the plugin's alone
  });
});
