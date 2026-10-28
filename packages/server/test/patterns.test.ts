import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandClass, ErrorClass, Event } from '@agent-orb/shared';
import { buildApp } from '../src/app.ts';
import { contentRows, openContentStore, type ContentStore } from '../src/content-store.ts';
import { openStore, type Store } from '../src/store/store.ts';
import { writeEvents } from '../src/store/writer.ts';

// Failure patterns (v0.3 slice 3, #45; PROJECT.md §6): GET /api/patterns?project over a project's whole history. Every figure below is counted by hand
// from the seed, and compared exactly. Times are seconds after T, written `at(n)`.
let dir: string;
let store: Store;
let content: ContentStore;
let app: ReturnType<typeof buildApp>;

const T = Date.parse('2026-10-01T00:00:00Z');
const at = (seconds: number) => T + seconds * 1000;
type Project = { cwd: string; name: string; git_remote?: string };
const MOBILE: Project = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
const NAS: Project = { cwd: '/srv/mobile-app', name: 'mobile-app' }; // the same repo seen from a machine that knows no remote: a second node with the name
const SOLO: Project = { cwd: '/Users/a/solo', name: 'solo', git_remote: 'github.com/o/solo' };
const MANY: Project = { cwd: '/Users/a/many', name: 'many', git_remote: 'github.com/o/many' };
const TIES: Project = { cwd: '/Users/a/ties', name: 'ties', git_remote: 'github.com/o/ties' };
const QUIET: Project = { cwd: '/Users/a/quiet', name: 'quiet', git_remote: 'github.com/o/quiet' };

let n = 0;
let k = 0;
const ev = (project: Project, session: string, ts: number, kind: string, data: object, extra: object = {}, host = 'mbp'): Event =>
  ({ v: 1, id: `00000000-0000-4000-c000-${String(++n).padStart(12, '0')}`, ts, host, user_id: 'local', session_id: session, project, kind, data, ...extra }) as Event;
const start = (project: Project, session: string, host?: string) =>
  ev(project, session, at(-1), 'session.start', { model: 'claude-sonnet-5-5', source: 'startup', claude_version: '2.1.308', plugin_version: '0.3.0' }, {}, host);

type Call = {
  tool?: string; command?: CommandClass; agent?: string; host?: string;
  fail?: { cls?: ErrorClass | null; shape?: string }; // a failed result; cls null = a result from before the classes
  wrote?: string; read?: string; output?: string; inFlight?: boolean;
};
/** One tool call at `seconds` and its result a second later, in the agent's own turn. */
function call(project: Project, session: string, seconds: number, o: Call = {}): Event[] {
  const id = `toolu_${++k}`;
  const who = { turn_id: `t-${session}-${o.agent ?? 'main'}`, ...(o.agent ? { agent_id: o.agent } : {}) };
  const tool = o.tool ?? 'Bash';
  const touched = [...(o.wrote ? [{ path: o.wrote, mode: 'write' }] : []), ...(o.read ? [{ path: o.read, mode: 'read' }] : [])];
  return [
    ev(project, session, at(seconds), 'tool.call', { tool_use_id: id, tool, input_size: 5, ...(o.command ? { command_class: o.command } : {}) }, who, o.host),
    ...(o.inFlight ? [] : [ev(project, session, at(seconds) + 1, 'tool.result', {
      tool_use_id: id, success: !o.fail, duration_ms: 1, output_size: 3, files_touched: o.fail ? [] : touched,
      ...(o.fail ? { error_type: 'error' } : {}), ...(o.fail?.cls ? { error_class: o.fail.cls } : {}), ...(o.fail?.shape ? { error_shape: o.fail.shape } : {}),
      ...(o.output ? { output: o.output } : {}),
    }, who, o.host)]),
  ];
}
const fails = (cls: ErrorClass | null, shape?: string) => ({ cls, shape });
const test = (project: Project, session: string, seconds: number, o: Call = {}) => call(project, session, seconds, { command: 'test', ...o });

const A = 'h:a0038b0f'; // Bash, test, "FAIL P": a failing test run
const LONG = `GraphQL: Projects (classic) is being deprecated in favor of the new Projects experience, see: ${'x'.repeat(200)}`;
const seeded: Event[] = [
  start(MOBILE, 'g-1'), start(MOBILE, 'g-2'), start(MOBILE, 'g-3'), start(NAS, 'g-nas', 'nas'), start(SOLO, 's-1'), start(MANY, 'm-1'), start(TIES, 'x-1'), start(QUIET, 'q-1'),

  // ── tests edited after a failure: g-1's main agent ──
  ...test(MOBILE, 'g-1', 100, { fail: fails('exit_code', A) }),
  ...call(MOBILE, 'g-1', 110, { tool: 'Edit', wrote: 'src/__tests__/a.test.ts' }), // counted: a test file, after a failing run, before the next run (1)
  ...call(MOBILE, 'g-1', 120, { tool: 'Edit', wrote: 'src/lib/a.ts' }), // not a test file
  ...call(MOBILE, 'g-1', 125, { tool: 'Write', wrote: 'test/helper.ts' }), // counted (2): the next run has not come
  ...test(MOBILE, 'g-1', 130),
  ...call(MOBILE, 'g-1', 140, { tool: 'Edit', wrote: 'src/a.test.ts' }), // not counted: the last run passed
  ...test(MOBILE, 'g-1', 150, { fail: fails('exit_code', A) }),
  ...test(MOBILE, 'g-1', 155, { fail: fails('exit_code', A) }),
  ...call(MOBILE, 'g-1', 160, { tool: 'Edit', wrote: 'e2e/login.spec.ts' }), // counted (3), once, after two failures in a row
  ...test(MOBILE, 'g-1', 170),
  ...test(MOBILE, 'g-1', 180, { fail: fails('unknown_command', 'h:b0000001') }), // the tests never ran
  ...call(MOBILE, 'g-1', 185, { tool: 'Edit', wrote: 'src/x.test.ts' }), // not counted
  ...call(MOBILE, 'g-1', 190, { command: 'build', fail: fails('exit_code', 'h:b0000002') }), // a build, not a test run
  ...call(MOBILE, 'g-1', 195, { tool: 'Edit', wrote: 'src/y.spec.ts' }), // not counted: the last test run is the one that never ran

  // g-2's main agent and its subagent: each agent has its own run to follow
  ...test(MOBILE, 'g-2', 1000, { fail: fails('exit_code', A) }),
  ...call(MOBILE, 'g-2', 1010, { tool: 'Edit', wrote: 'src/tests/b.ts' }), // counted (4)
  ...call(MOBILE, 'g-2', 1020, { tool: 'Edit', wrote: 'src/b.ts' }),
  ...test(MOBILE, 'g-2', 1030),
  ...test(MOBILE, 'g-2', 1100, { agent: 'sub-a', fail: fails('exit_code', A) }),
  ...call(MOBILE, 'g-2', 1110, { tool: 'Edit', wrote: 'src/c.test.ts' }), // the main agent's, after the subagent's failure but its own run passed: not counted
  ...call(MOBILE, 'g-2', 1120, { tool: 'Edit', agent: 'sub-a', wrote: 'src/d.spec.ts' }), // counted (5): the subagent's own

  // g-3: names that look like tests and are not, a read, and one that is
  ...test(MOBILE, 'g-3', 2000, { fail: fails('exit_code', A) }),
  ...['src/contest/a.ts', 'src/latest.ts', 'src/a.testing.ts', 'docs/test-plan.md', 'src/attest/x.ts'].flatMap((path, i) => call(MOBILE, 'g-3', 2010 + i * 10, { tool: 'Edit', wrote: path })),
  ...call(MOBILE, 'g-3', 2060, { tool: 'Read', read: 'packages/x/__tests__/z.ts' }), // read, not written
  ...call(MOBILE, 'g-3', 2070, { tool: 'Write', wrote: 'packages/x/__tests__/y.ts' }), // counted (6)

  // the node that knows no remote: the project is its name
  ...test(NAS, 'g-nas', 3000, { host: 'nas', fail: fails('exit_code', A) }),
  ...call(NAS, 'g-nas', 3010, { tool: 'Edit', host: 'nas', wrote: 'e2e/a.ts' }), // counted (7)

  // another project's failures and test edits never reach mobile-app's
  ...Array.from({ length: 5 }, (_, i) => test(SOLO, 's-1', 4000 + i, { fail: fails('exit_code', A) })).flat(),
  ...call(SOLO, 's-1', 4010, { tool: 'Edit', wrote: 'src/solo.test.ts' }),

  // ── repeats ──
  // a named shape across two tools: Write 3, Edit 2. The Edit at 303 had its output captured.
  ...[300, 301].flatMap((s) => call(MOBILE, 'g-1', s, { tool: 'Write', fail: fails('refused', 'hook_blocked') })),
  ...call(MOBILE, 'g-2', 302, { tool: 'Write', fail: fails('refused', 'hook_blocked') }),
  ...call(MOBILE, 'g-2', 303, { tool: 'Edit', fail: fails('refused', 'hook_blocked'), output: 'PreToolUse:Edit hook error: [bash .claude/hooks/check-branch.sh]: BLOCKED: Cannot edit files on main.' }),
  ...call(MOBILE, 'g-3', 304, { tool: 'Edit', fail: fails('refused', 'hook_blocked') }),
  // sleep_blocked: four Bash calls in one session, three of them `other` and one `git`
  ...[310, 311, 312].flatMap((s) => call(MOBILE, 'g-1', s, { command: 'other', fail: fails('refused', 'sleep_blocked') })),
  ...call(MOBILE, 'g-1', 313, { command: 'git', fail: fails('refused', 'sleep_blocked') }),
  // wrong_tool_name: three tool names, `bash` the most
  ...[320, 321].flatMap((s) => call(MOBILE, 'g-1', s, { tool: 'bash', fail: fails('invalid_input', 'wrong_tool_name') })),
  ...call(MOBILE, 'g-2', 322, { tool: 'Zed', fail: fails('invalid_input', 'wrong_tool_name') }),
  ...call(MOBILE, 'g-3', 323, { tool: 'alpha', fail: fails('invalid_input', 'wrong_tool_name') }),
  // one hash on two tools is two groups, not one
  ...call(MOBILE, 'g-1', 400, { tool: 'Read', fail: fails('not_found', 'h:c0000001') }),
  ...[401, 402].flatMap((s) => call(MOBILE, 'g-2', s, { tool: 'Read', fail: fails('not_found', 'h:c0000001') })),
  ...[410, 411, 412].flatMap((s) => call(MOBILE, 'g-1', s, { tool: 'Glob', fail: fails('not_found', 'h:c0000001') })),
  // e1: the sample is the newest call that has one, here the oldest of three
  ...[418, 419, 420].flatMap((s) => call(MOBILE, 'g-1', s, {
    tool: 'Edit', fail: fails('no_match', 'h:e0000001'), ...(s === 418 ? { output: '<tool_use_error>String to replace not found in file.\nString: const x = 1</tool_use_error>' } : {}),
  })),
  // e2: two have output; the newest wins, and its line is cut at 120 characters
  ...[428, 429, 430].flatMap((s) => call(MOBILE, 'g-2', s, {
    command: 'gh', fail: fails('exit_code', 'h:e0000002'), ...(s === 429 ? { output: 'Exit code 1\nolder' } : s === 430 ? { output: `Exit code 1\n\n<tool_use_error>\n${LONG}\nmore` } : {}),
  })),
  // two is under the threshold
  ...[440, 441].flatMap((s) => call(MOBILE, 'g-1', s, { command: 'other', fail: fails('exit_code', 'h:d0000001') })),

  // ── failures with no shape, for the kinds ──
  ...call(MOBILE, 'g-1', 450, { fail: fails('exit_code') }), // a Bash failure with no command class
  ...[460, 461].flatMap((s) => call(MOBILE, 'g-2', s, { command: 'docker', fail: fails('exit_code') })),
  ...call(MOBILE, 'g-2', 462, { command: 'lint', fail: fails('exit_code') }),
  ...call(MOBILE, 'g-2', 463, { command: 'install', fail: fails('exit_code') }),
  ...[470, 471].flatMap((s) => call(MOBILE, 'g-1', s, { command: 'other', fail: fails('timeout') })),
  ...call(MOBILE, 'g-1', 480, { tool: 'Write', fail: fails('read_first') }),
  ...call(MOBILE, 'g-1', 490, { fail: fails('other') }),
  ...call(MOBILE, 'g-1', 491, { fail: fails(null) }), // from before the classes: counted as other
  ...[500, 501, 502].flatMap((s) => call(MOBILE, 'g-1', s, { command: 'git' })), // worked
  ...call(MOBILE, 'g-1', 510, { inFlight: true }), // no result yet: a call, not a failure

  // ── the top ten: twelve groups of 3 to 14 calls, and one of two ──
  ...Array.from({ length: 12 }, (_, i) => Array.from({ length: 3 + i }, (_, j) => call(MANY, 'm-1', 100 * i + j, { fail: fails('other', `h:f00000${String(i).padStart(2, '0')}`) })).flat()).flat(),
  ...[5000, 5001].flatMap((s) => call(MANY, 'm-1', s, { fail: fails('other', 'h:f0000090') })),

  // ── the tie-break: the same count, sessions and last call; the shape decides ──
  ...['h:00000b01', 'h:00000a01'].flatMap((shape) => [10, 11, 12].flatMap((s) => call(TIES, 'x-1', s, { fail: fails('other', shape) }))),
];

// The text of the calls that had output, as the ingest would have kept it (masked already, when the plugin masks).
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-patterns-'));
  store = openStore(join(dir, 'history.db'));
  content = openContentStore(':memory:');
  app = buildApp({ store, token: 'test-token-0123456789', content });
  content.put(contentRows(seeded));
  writeEvents(store, seeded, 'plugin');
});
afterAll(async () => {
  await app?.close();
  store?.close();
  content?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (project?: string) => {
  const res = await app.inject({ method: 'GET', url: `/api/patterns${project === undefined ? '' : `?project=${encodeURIComponent(project)}`}` });
  return { status: res.statusCode, body: res.json() };
};

describe('GET /api/patterns: calls, failed and kinds', () => {
  it('counts the project\'s whole history, every node with its name, and not another project\'s', async () => {
    const { status, body } = await get('mobile-app');
    expect(status).toBe(200);
    // by hand: 31 calls in the test-edit blocks (22 that worked, 9 that failed) and 41 in the others (37 that failed, 3 that worked, 1 with no result yet)
    expect(body.calls).toBe(72);
    expect(body.failed).toBe(46);
  });

  it('failed calls by kind, by count and then by name; a Bash exit code by the kind of command; a call from before the classes is `other`', async () => {
    const { body } = await get('mobile-app');
    expect(body.kinds).toEqual([
      { errorClass: 'exit_code', count: 18, commands: [
        { commandClass: 'test', count: 7 }, { commandClass: 'gh', count: 3 }, { commandClass: 'other', count: 3 }, // other: two with the class, one with none
        { commandClass: 'docker', count: 2 }, { commandClass: 'build', count: 1 }, { commandClass: 'install', count: 1 }, { commandClass: 'lint', count: 1 },
      ] },
      { errorClass: 'refused', count: 9 },
      { errorClass: 'not_found', count: 6 },
      { errorClass: 'invalid_input', count: 4 },
      { errorClass: 'no_match', count: 3 },
      { errorClass: 'other', count: 2 }, // the class `other` and the call with none
      { errorClass: 'timeout', count: 2 },
      { errorClass: 'read_first', count: 1 },
      { errorClass: 'unknown_command', count: 1 },
    ]);
    expect(body.kinds.reduce((t: number, x: { count: number }) => t + x.count, 0)).toBe(body.failed);
    for (const kind of body.kinds) if (kind.errorClass !== 'exit_code') expect(kind).not.toHaveProperty('commands');
  });
});

describe('GET /api/patterns: repeats', () => {
  it('groups by shape and tool at 3 calls or more, a named shape across tools, by count, then sessions, then the latest call; no sample without captured output', async () => {
    const { body } = await get('mobile-app');
    expect(body.repeats).toEqual([
      { shape: A, tool: 'Bash', errorClass: 'exit_code', commandClass: 'test', count: 7, sessions: 4, lastAt: at(3000), sample: null }, // g-1 3, g-2 2, g-3 1, and the node with no remote 1
      { shape: 'hook_blocked', tool: 'Write', errorClass: 'refused', commandClass: null, count: 5, sessions: 3, lastAt: at(304), sample: 'PreToolUse:Edit hook error: [bash .claude/hooks/check-branch.sh]: BLOCKED: Cannot edit files on main.' }, // Write 3, Edit 2
      { shape: 'wrong_tool_name', tool: 'bash', errorClass: 'invalid_input', commandClass: null, count: 4, sessions: 3, lastAt: at(323), sample: null }, // three names, bash twice
      { shape: 'sleep_blocked', tool: 'Bash', errorClass: 'refused', commandClass: 'other', count: 4, sessions: 1, lastAt: at(313), sample: null }, // other 3, git 1
      { shape: 'h:c0000001', tool: 'Read', errorClass: 'not_found', commandClass: null, count: 3, sessions: 2, lastAt: at(402), sample: null },
      { shape: 'h:e0000002', tool: 'Bash', errorClass: 'exit_code', commandClass: 'gh', count: 3, sessions: 1, lastAt: at(430), sample: LONG.slice(0, 120) },
      { shape: 'h:e0000001', tool: 'Edit', errorClass: 'no_match', commandClass: null, count: 3, sessions: 1, lastAt: at(420), sample: 'String to replace not found in file.' },
      { shape: 'h:c0000001', tool: 'Glob', errorClass: 'not_found', commandClass: null, count: 3, sessions: 1, lastAt: at(412), sample: null }, // the same hash on another tool: its own group
    ]);
  });

  it('a group of two is not a repeat, and a shape-less failure is in none', async () => {
    const { body } = await get('mobile-app');
    const shapes = body.repeats.map((r: { shape: string }) => r.shape);
    expect(shapes).not.toContain('h:d0000001'); // 2 calls
    expect(shapes).not.toContain('h:b0000001'); // 1 call
    expect(body.repeats.every((r: { count: number }) => r.count >= 3)).toBe(true);
  });

  it('the top ten by count, of twelve groups of 3 to 14 calls', async () => {
    const { body } = await get('many');
    expect(body.failed).toBe(3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14 + 2);
    expect(body.repeats.map((r: { shape: string; count: number }) => [r.shape, r.count])).toEqual(
      Array.from({ length: 10 }, (_, j) => [`h:f00000${String(11 - j).padStart(2, '0')}`, 14 - j]),
    );
  });

  it('the same count, sessions and last call: the shape decides', async () => {
    const { body } = await get('ties');
    expect(body.repeats.map((r: { shape: string }) => r.shape)).toEqual(['h:00000a01', 'h:00000b01']);
  });
});

describe('GET /api/patterns: tests edited after a failure', () => {
  it('counts the writes to a test file that follow a failing test run of the same agent before its next test run, and the sessions they are in', async () => {
    const { body } = await get('mobile-app');
    // g-1: three (the passing run in between spares a fourth); g-2: its main agent's tests/b.ts and its subagent's d.spec.ts; g-3: one; the node with no remote: one
    expect(body.testsEditedAfterFailure).toEqual({ count: 7, sessions: 4 });
  });

  it('a project with failing runs and no test edit has none, and another project\'s edits are not its own', async () => {
    const { body } = await get('many');
    expect(body.testsEditedAfterFailure).toEqual({ count: 0, sessions: 0 });
    expect((await get('solo')).body.testsEditedAfterFailure).toEqual({ count: 1, sessions: 1 });
  });
});

describe('GET /api/patterns: the project', () => {
  it('a project with sessions and no calls answers zeros', async () => {
    // its one session recorded no content mode, so its claims were not checked: 0 sessions checked, not "0 unbacked of 0" (#44)
    const none = { total: 0, unbacked: 0 };
    expect((await get('quiet')).body).toEqual({ calls: 0, failed: 0, kinds: [], repeats: [], testsEditedAfterFailure: { count: 0, sessions: 0 }, claims: { sessions: 1, checked: 0, test: none, build: none, edit: none } });
  });

  it('answers exactly the documented fields', async () => {
    const { body } = await get('mobile-app');
    expect(Object.keys(body).sort()).toEqual(['calls', 'claims', 'failed', 'kinds', 'repeats', 'testsEditedAfterFailure']);
    for (const r of body.repeats) expect(Object.keys(r).sort()).toEqual(['commandClass', 'count', 'errorClass', 'lastAt', 'sample', 'sessions', 'shape', 'tool']);
  });

  it('404 for a project nobody has seen, 400 for none', async () => {
    expect((await get('nope')).status).toBe(404);
    expect((await get()).status).toBe(400);
    expect((await get('')).status).toBe(400);
  });
});

// A forked session replays the calls of the one it was forked from, with their tool_use_ids. The graph counted such a call once per turn that called it; the store
// has one row per tool_use_id, in the session that wrote it first, so the project's counts are of calls, not of copies (#81, slice 1: this figure moves, by design).
describe('GET /api/patterns: a call a forked session copied', () => {
  const FORKY: Project = { cwd: '/Users/a/forky', name: 'forky', git_remote: 'github.com/o/forky' };
  const shared = (session: string) => {
    const who = { turn_id: `t-${session}-main` };
    return [
      ev(FORKY, session, at(10), 'tool.call', { tool_use_id: 'toolu_forked', tool: 'Bash', input_size: 5, command_class: 'test' }, who),
      ev(FORKY, session, at(10) + 1, 'tool.result', { tool_use_id: 'toolu_forked', success: false, duration_ms: 1, output_size: 3, files_touched: [], error_type: 'error', error_class: 'exit_code', error_shape: A }, who),
    ];
  };

  it('is one call and one failure, in the session that wrote it first: two own failures of the fork make a repeat of three, in two sessions', async () => {
    writeEvents(store, [start(FORKY, 'f-a'), start(FORKY, 'f-b'), ...shared('f-a'), ...shared('f-b'),
      ...test(FORKY, 'f-b', 70, { fail: fails('exit_code', A) }), ...test(FORKY, 'f-b', 80, { fail: fails('exit_code', A) })], 'plugin');
    const { body } = await get('forky');
    expect(body.calls).toBe(3); // the graph said 4
    expect(body.failed).toBe(3);
    expect(body.repeats).toEqual([{ shape: A, tool: 'Bash', errorClass: 'exit_code', commandClass: 'test', count: 3, sessions: 2, lastAt: at(80), sample: null }]);
  });
});
