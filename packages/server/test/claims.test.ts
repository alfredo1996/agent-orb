import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event } from '@agent-orb/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { checkAnswers, checkText, claimsOf, isCode, verdict, type Call, type Found } from '../src/claims.ts';
import { openContentStore, type ContentStore } from '../src/content-store.ts';
import { applyClaims, applyEvents, newLive, visible } from '../src/live.ts';
import { all, openStore, type Store } from '../src/store/store.ts';
import { seedStore } from './seed-store.ts';

// Unbacked claims (v0.3 slice 4, #44; PROJECT.md §6): the claims in a final answer, checked against the calls of the agent that gave it. Three parts: the finder (pure),
// the verdict (pure), and the whole path, from a batch POSTed to /ingest to the rows, the history drawer, Patterns and the live state.

const words = (text: string, o?: Parameters<typeof claimsOf>[1]) => claimsOf(text, o).map((c) => [c.kind, text.slice(c.at, c.at + c.len)] as const);

describe('the claims in an answer', () => {
  it.each([
    ['All 48 tests pass.', 'All 48 tests pass'],
    ['The suite is green.', 'The suite is green'],
    ['1550 unit tests pass in each of the three modes', '1550 unit tests pass'],
    ['921/921 pass', '921/921 pass'],
    ['Tests: 24 files, 314 passed', '314 passed'],
    ['vitest passes', 'vitest passes'],
    ['E2E green', 'E2E green'],
    ['The test passes now.', 'The test passes'],
    ['162 passed, 25 skipped by design, 0 failed', '162 passed'], // "0 failed" is a claim, not a failure
  ])('a test claim: %s', (text, phrase) => {
    expect(words(text)).toEqual([['test', phrase]]);
  });

  it.each([
    ['Typecheck is clean.', 'Typecheck is clean'],
    ['`tsc --noEmit` clean', 'tsc --noEmit` clean'],
    ['The production build succeeds.', 'production build succeeds'],
    ['Production builds: all three pass.', 'Production builds: all three pass'],
    ['No type errors.', 'No type errors'],
  ])('a build claim: %s', (text, phrase) => {
    expect(words(text)).toEqual([['build', phrase]]);
  });

  it('a sentence with a test claim and a build claim has both, in order, each at the words it used', () => {
    expect(words('I ran it: all 48 tests pass, typecheck is clean.')).toEqual([['test', 'all 48 tests pass'], ['build', 'typecheck is clean']]);
  });

  it.each([
    'The full test pass runs next.', // a stage, not a result
    'Run the tests to check that all tests pass.',
    'I could not run the tests, so I cannot say they pass.',
    'Tests should pass once the migration lands.',
    'The build can pass.',
    'typecheck passes but two tests fail', // a mixed sentence is nobody's claim
    'All six checks green on PR #123.', // a CI run is no call of the agent's
    'CI is green: all tests pass.',
    '```\n48 tests pass\n```\nnothing else', // quoted output
  ])('is no claim: %s', (text) => {
    expect(claimsOf(text)).toEqual([]);
  });

  it('an edit claim is the agent saying what its own hands did, to a file it names', () => {
    expect(words("I added `usd(0)` to `format.spec.ts` and watched it fail.")).toEqual([['edit', 'I added `usd(0)` to `format.spec.ts`']]);
    expect(claimsOf("I've updated plan.ts.")[0]).toMatchObject({ kind: 'edit', file: 'plan.ts' });
    expect(claimsOf('I wrote notes/review.md')[0]).toMatchObject({ kind: 'edit', file: 'notes/review.md' });
  });

  it('another agent\'s edit, a passive one, a hedge and a way the check cannot see are no edit claim', () => {
    for (const text of ['The implementer updated plan.ts.', 'plan.ts was updated.', 'I would update plan.ts later.', 'I edited PROJECT.md with a script.']) expect(claimsOf(text)).toEqual([]);
  });

  it('a sentence that starts with the verb is a claim in a subagent\'s report only', () => {
    expect(claimsOf('Fixed the totals in `src/lib/plan.ts`.')).toEqual([]);
    expect(claimsOf('- Fixed the totals in `src/lib/plan.ts`', { report: true })).toMatchObject([{ kind: 'edit', file: 'src/lib/plan.ts' }]);
    expect(words('- Fixed the totals in `src/lib/plan.ts`', { report: true })).toEqual([['edit', 'Fixed the totals in `src/lib/plan.ts`']]);
  });

  it('a path is the project\'s: an absolute one inside the working tree is cut to it, one outside is not a claim anyone can be held to', () => {
    expect(claimsOf('I edited /Users/a/proj/src/a.ts', { root: '/Users/a/proj' })[0]).toMatchObject({ file: 'src/a.ts' });
    expect(claimsOf('I edited /elsewhere/b.ts', { root: '/Users/a/proj' })).toEqual([]);
  });

  it('a long line is read in linear time: POST /ingest waits for it (a line of 50,000 numbers took 8 s)', () => {
    const t = performance.now();
    claimsOf(`${'1,'.repeat(50_000)} passed`);
    claimsOf(`${'1 '.repeat(50_000)}tests pass`);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

// ── The verdict ─────────────────────────────────────────────────────────────

const min = (m: number) => Date.parse('2026-10-27T14:00:00Z') + m * 60_000;
const call = (m: number, tool: string, o: Partial<Call> = {}): Call => ({ ts: min(m), tool, command: null, ok: true, error: null, writes: [], ...o });
const test = (m: number, ok = true, error: string | null = null) => call(m, 'Bash', { command: 'test', ok, error: ok ? null : error ?? 'exit_code' });
const build = (m: number, ok = true) => call(m, 'Bash', { command: 'build', ok, error: ok ? null : 'exit_code' });
const edit = (m: number, path: string, tool = 'Edit') => call(m, tool, { writes: [path] });
const testClaim: Found = { kind: 'test', at: 0, len: 17 };
const editClaim = (file: string): Found => ({ kind: 'edit', at: 0, len: 10, file });

describe('a test or build claim, against the agent\'s own calls', () => {
  it('is backed by a passing run after its last edit to code', () => {
    expect(verdict(testClaim, [edit(0, 'src/lib/plan.ts'), test(2)])).toEqual({ backed: true });
  });

  it('is not backed when the run came before the edit: the reason has the edit and the run it saw (the mock: run 13:58, edit 14:02)', () => {
    expect(verdict(testClaim, [test(0), edit(4, 'src/lib/plan.ts')])).toEqual({ backed: false, why: 'stale', editTs: min(4), runTs: min(0) });
  });

  it('is not backed when no run of that kind came at all after an edit', () => {
    expect(verdict(testClaim, [edit(4, 'src/lib/plan.ts'), build(5)])).toEqual({ backed: false, why: 'no_run', editTs: min(4) });
  });

  it('is not backed by a last run that failed, however many passed before', () => {
    expect(verdict(testClaim, [edit(0, 'src/a.ts'), test(1), test(2, false)])).toEqual({ backed: false, why: 'failed', editTs: min(0), runTs: min(2) });
    expect(verdict(testClaim, [test(1), test(2, false)])).toEqual({ backed: false, why: 'failed', runTs: min(2) }); // with no edit too: it contradicts itself
  });

  it('a later passing run after a failing one backs it', () => {
    expect(verdict(testClaim, [edit(0, 'src/a.ts'), test(1, false), edit(2, 'src/a.ts'), test(3)])).toEqual({ backed: true });
  });

  it('an edit to a note, a PR body or a memory file does not break it; an edit to a test file does', () => {
    for (const note of ['notes/review.md', 'docs/guide.mdx', 'pr-body.md', 'README', 'CHANGELOG.md', 'memory/MEMORY.md']) {
      expect(verdict(testClaim, [edit(0, 'src/a.ts'), test(1), edit(2, note)]), note).toEqual({ backed: true });
    }
    expect(verdict(testClaim, [edit(0, 'src/a.ts'), test(1), edit(2, 'src/a.test.ts')])).toMatchObject({ backed: false, why: 'stale' });
    expect(verdict(testClaim, [test(1), edit(2, 'package.json')])).toMatchObject({ backed: false, why: 'stale' });
  });

  it('a run that never ran (refused, a command the shell did not know) is no run', () => {
    expect(verdict(testClaim, [edit(0, 'src/a.ts'), test(1, false, 'refused'), test(2, false, 'unknown_command')])).toEqual({ backed: false, why: 'no_run', editTs: min(0) });
  });

  it('an agent that edited no code has changed nothing a run has to cover', () => {
    expect(verdict(testClaim, [call(0, 'Read'), edit(1, 'notes/a.md')])).toEqual({ backed: true });
  });

  it('a test run backs a build claim (a chain `pnpm test && tsc` is a test run by its class), a build run does not back a test claim', () => {
    const claim: Found = { kind: 'build', at: 0, len: 5 };
    expect(verdict(claim, [edit(0, 'src/a.ts'), test(1)])).toEqual({ backed: true });
    expect(verdict(claim, [edit(0, 'src/a.ts'), build(1, false), test(2, false)])).toMatchObject({ backed: false, why: 'failed' });
    expect(verdict(testClaim, [edit(0, 'src/a.ts'), build(1)])).toMatchObject({ backed: false, why: 'no_run' });
  });

  it('an agent that handed work to a subagent after its last edit is not held to a run: the subagent\'s own report is checked against its own calls', () => {
    expect(verdict(testClaim, [edit(0, 'src/a.ts'), call(1, 'Agent')])).toEqual({ backed: true });
    expect(verdict(testClaim, [call(0, 'Agent'), edit(1, 'src/a.ts')])).toMatchObject({ backed: false, why: 'no_run' }); // the hand-off came before the edit
  });
});

describe('an edit claim, against the agent\'s own calls', () => {
  it('is backed by a successful write to the file it names, by any path to it', () => {
    expect(verdict(editClaim('src/lib/plan.ts'), [edit(0, 'src/lib/plan.ts')])).toEqual({ backed: true });
    expect(verdict(editClaim('plan.ts'), [edit(0, 'src/lib/plan.ts', 'Write')])).toEqual({ backed: true });
  });

  it('is not backed when the agent wrote other files, or only read the one it names', () => {
    expect(verdict(editClaim('src/lib/plan.ts'), [edit(0, 'src/lib/other.ts'), call(1, 'Read')])).toEqual({ backed: false, why: 'no_write' });
  });

  it('is not backed by an Edit that missed (a failed call records no path)', () => {
    expect(verdict(editClaim('src/lib/plan.ts'), [call(0, 'Edit', { ok: false, error: 'no_match' })])).toEqual({ backed: false, why: 'no_write' });
  });

  it('an Edit or Write that succeeded and left no path wrote outside the working tree: it may be the file, so it backs the claim', () => {
    expect(verdict(editClaim('shoot.cjs'), [call(0, 'Write')])).toEqual({ backed: true });
  });

  it('a Bash call of class `other` may have been the edit (a python heredoc, sed -i): it backs the claim; a test run or a git call does not', () => {
    const shell = (m: number) => call(m, 'Bash', { command: 'other' });
    expect(verdict(editClaim('src/lib/plan.ts'), [shell(0)])).toEqual({ backed: true });
    expect(verdict(editClaim('src/lib/plan.ts'), [call(0, 'Bash', { command: 'other', ok: false, error: 'exit_code' })])).toEqual({ backed: false, why: 'no_write' }); // it failed
    expect(verdict(editClaim('src/lib/plan.ts'), [test(0), call(1, 'Bash', { command: 'git' })])).toEqual({ backed: false, why: 'no_write' });
  });

  it('a write in an earlier turn counts when the caller says what it was (a main agent\'s answer may recap)', () => {
    expect(verdict(editClaim('src/lib/plan.ts'), [], [edit(-10, 'src/lib/plan.ts')])).toEqual({ backed: true });
    expect(verdict(editClaim('src/lib/plan.ts'), [], [edit(-10, 'src/lib/other.ts')])).toEqual({ backed: false, why: 'no_write' });
  });

  it('a note counts as a write to the file it names, though it does not break a test claim', () => {
    expect(verdict(editClaim('notes/review.md'), [edit(0, 'notes/review.md', 'Write')])).toEqual({ backed: true });
  });
});

describe('isCode', () => {
  it('prose and notes by extension, docs and notes folders and README, CHANGELOG, LICENSE are not code; everything else is', () => {
    for (const p of ['a.md', 'b/c.mdx', 'x.txt', 'docs/a.ts', 'notes/x.json', 'README', 'readme.rst', 'LICENSE', 'packages/a/CHANGELOG.md']) expect(isCode(p), p).toBe(false);
    for (const p of ['src/a.ts', 'src/a.test.ts', 'package.json', 'firestore.rules', 'scripts/test.sh', 'src/documents/a.ts', 'src/notes.ts']) expect(isCode(p), p).toBe(true);
  });
});

describe('checkText', () => {
  it('holds every claim in an answer to the same calls', () => {
    const r = checkText('All 48 tests pass and typecheck is clean.', [edit(0, 'src/a.ts'), build(1)]);
    expect(r.map(({ claim, verdict: v }) => [claim.kind, v.backed])).toEqual([['test', false], ['build', true]]);
  });
});

// ── From a batch to the rows ────────────────────────────────────────────────

const TOKEN = 'test-token-0123456789';
const MOBILE = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
const SOLO = { cwd: '/Users/a/solo', name: 'solo', git_remote: 'github.com/o/solo' };
let n = 0;
const ev = (session: string, ts: number, kind: string, data: object, extra: object = {}, project = MOBILE): Event =>
  ({ v: 1, id: `00000000-0000-4000-a000-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'x', session_id: session, project, kind, data, ...extra }) as Event;
const usage = { input: 1, output: 2, cache_read: 3, cache_creation: 4 };
const MODEL = 'claude-sonnet-5-5';

type Step = { m: number; do: 'edit' | 'test' | 'build' | 'delegate' | 'shell'; path?: string; fail?: boolean };
type Run = { session: string; agent?: string; content?: 'full' | 'off'; steps: Step[]; answer: string; turn?: number; first?: boolean; project?: typeof MOBILE };
let k = 0;
/**
 * One agent's run as the plugin sends it: its calls (`m` minutes after the session's T, a Bash call that fails has no files), its last step with the answer, and the end of
 * its turn (a subagent's also its completion). `first: false` is a later turn of the same agent: no session start, no spawn.
 */
function run({ session, agent, content = 'full', steps, answer, turn = 1, first = true, project = MOBILE }: Run): Event[] {
  const who = { turn_id: `t-${session}-${agent ?? 'main'}-${turn}`, ...(agent ? { agent_id: agent } : {}) };
  const end = Math.max(...steps.map((s) => s.m), 0) + 1;
  const e = (ts: number, kind: string, data: object, extra: object = who) => ev(session, ts, kind, data, extra, project);
  return [
    ...(first && !agent ? [e(min(-5), 'session.start', { model: MODEL, source: 'startup', claude_version: '2.1.308', plugin_version: '0.3.0', content }, {})] : []),
    ...(first && agent ? [e(min(-5), 'session.start', { model: MODEL, source: 'startup', claude_version: '2.1.308', plugin_version: '0.3.0', content }, {}),
      e(min(-4), 'agent.spawn', { tool_use_id: `tu-${agent}`, agent_type: 'reviewer', model: MODEL, prompt_length: 9 }, { agent_id: agent })] : []),
    e(min((steps[0]?.m ?? 0) - 1), 'turn.start', {}),
    ...steps.flatMap((s): Event[] => {
      const id = `toolu_${++k}`;
      const command = s.do === 'test' || s.do === 'build' ? { command_class: s.do } : s.do === 'shell' ? { command_class: 'other' } : {};
      return [
        e(min(s.m), 'tool.call', { tool_use_id: id, tool: s.do === 'edit' ? 'Edit' : s.do === 'delegate' ? 'Agent' : 'Bash', input_size: 5, ...command }),
        e(min(s.m) + 1, 'tool.result', {
          tool_use_id: id, success: !s.fail, duration_ms: 1, output_size: 3, files_touched: s.path && !s.fail ? [{ path: s.path, mode: 'write' }] : [],
          ...(s.fail ? { error_type: 'error', error_class: s.do === 'edit' ? 'no_match' : 'exit_code' } : {}),
        }),
      ];
    }),
    e(min(end), 'turn.step', { model: MODEL, usage, stop_reason: 'end_turn', tool_use_ids: [], ...(content === 'full' ? { answer } : {}) }),
    e(min(end) + 1, 'turn.complete', { duration_ms: 1, usage_total: usage, reason: 'answer', answer_length: answer.length }),
    ...(agent ? [e(min(end) + 2, 'agent.complete', { duration_ms: 1, usage_total: usage, report_length: answer.length }, { agent_id: agent })] : []),
  ];
}

let dir: string;
let store: Store;
let content: ContentStore;
let app: ReturnType<typeof buildApp>;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-claims-'));
  store = openStore(join(dir, 'history.db'));
  content = openContentStore(':memory:');
  app = buildApp({ store, token: TOKEN, content });
});
afterAll(async () => {
  await app.close();
  store.close();
  content.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = async (events: Event[]) => {
  const res = await app.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events } });
  expect(res.statusCode).toBe(200);
  return res.json() as { accepted: number; duplicates: number };
};
const rowsOf = (session: string) =>
  all(store, 'SELECT agent_id AS agent, kind, file, backed, why, edit_ts AS editTs, run_ts AS runTs FROM claims WHERE session_id = :session ORDER BY agent_id, ts, n', { session })
    .map((r) => ({ ...r, backed: r.backed === 1 }));
const get = async <T = any>(url: string) => (await app.inject({ method: 'GET', url })).json() as T;
const claimItems = async (session: string, agent: string) => (await get<any>(`/api/history?session=${session}&agent=${agent}`)).items.filter((i: any) => i.kind === 'claim');

describe('a subagent\'s report, checked as its batch arrives', () => {
  it('a planted claim is caught: "all 48 tests pass" after a code edit, with no test run since', async () => {
    await post(run({
      session: 's-plant', agent: 'a1', answer: 'The change is in. All 48 tests pass.',
      steps: [{ m: 0, do: 'test' }, { m: 4, do: 'edit', path: 'src/lib/plan.ts' }, { m: 5, do: 'edit', path: 'notes/review.md' }],
    }));
    expect(rowsOf('s-plant')).toEqual([{ agent: 's-plant:a1', kind: 'test', file: null, backed: false, why: 'stale', editTs: min(4), runTs: min(0) }]);
  });

  it('the history drawer has it: the words it used, cut from the answer, and the facts of why', async () => {
    expect(await claimItems('s-plant', 'a1')).toEqual([{ kind: 'claim', claim: 'test', ts: min(6), backed: false, why: 'stale', editTs: min(4), runTs: min(0), phrase: 'All 48 tests pass' }]);
  });

  it('the history store holds where the words are, never the words', () => {
    const cols = all(store, "SELECT name FROM pragma_table_info('claims')").map((c) => c.name);
    expect(cols).not.toContain('phrase');
    expect(cols).not.toContain('text');
    expect(JSON.stringify(all(store, 'SELECT * FROM claims'))).not.toContain('tests pass');
  });

  it('a batch sent again gives the same rows', async () => {
    const again = run({ session: 's-twice', agent: 'a1', answer: 'All 3 tests pass.', steps: [{ m: 0, do: 'edit', path: 'src/a.ts' }] });
    expect(await post(again)).toMatchObject({ duplicates: 0 });
    const before = rowsOf('s-twice');
    expect(before).toEqual([{ agent: 's-twice:a1', kind: 'test', file: null, backed: false, why: 'no_run', editTs: min(0), runTs: null }]);
    expect(await post(again)).toMatchObject({ accepted: 0, duplicates: again.length });
    expect(rowsOf('s-twice')).toEqual(before);
  });

  it('the backed case: a passing run after the last edit', async () => {
    await post(run({ session: 's-backed', agent: 'a1', answer: 'All 48 tests pass.', steps: [{ m: 0, do: 'edit', path: 'src/lib/plan.ts' }, { m: 2, do: 'test' }] }));
    expect(rowsOf('s-backed')).toEqual([{ agent: 's-backed:a1', kind: 'test', file: null, backed: true, why: null, editTs: null, runTs: null }]);
    expect(await claimItems('s-backed', 'a1')).toMatchObject([{ claim: 'test', backed: true, phrase: 'All 48 tests pass' }]);
  });

  it('the failed-run case: the last run after the edit failed', async () => {
    await post(run({ session: 's-failed', agent: 'a1', answer: 'All 48 tests pass.', steps: [{ m: 0, do: 'edit', path: 'src/lib/plan.ts' }, { m: 2, do: 'test', fail: true }] }));
    expect(rowsOf('s-failed')).toEqual([{ agent: 's-failed:a1', kind: 'test', file: null, backed: false, why: 'failed', editTs: min(0), runTs: min(2) }]);
  });

  it('a write to the file it names backs an edit claim; a write to another file does not', async () => {
    await post(run({ session: 's-wrote', agent: 'a1', answer: '- Fixed the totals in `src/lib/plan.ts`', steps: [{ m: 0, do: 'edit', path: 'src/lib/plan.ts' }] }));
    await post(run({ session: 's-other', agent: 'a1', answer: '- Fixed the totals in `src/lib/plan.ts`', steps: [{ m: 0, do: 'edit', path: 'src/lib/other.ts' }] }));
    await post(run({ session: 's-missed', agent: 'a1', answer: '- Fixed the totals in `src/lib/plan.ts`', steps: [{ m: 0, do: 'edit', path: 'src/lib/plan.ts', fail: true }] }));
    expect(rowsOf('s-wrote')).toMatchObject([{ kind: 'edit', file: 'src/lib/plan.ts', backed: true }]);
    expect(rowsOf('s-other')).toMatchObject([{ kind: 'edit', file: 'src/lib/plan.ts', backed: false, why: 'no_write' }]);
    expect(rowsOf('s-missed')).toMatchObject([{ kind: 'edit', backed: false, why: 'no_write' }]); // the Edit missed: the agent said it anyway
    expect(await claimItems('s-other', 'a1')).toMatchObject([{ claim: 'edit', file: 'src/lib/plan.ts', phrase: 'Fixed the totals in `src/lib/plan.ts`' }]);
  });

  it('a note and a PR body written after the run do not break the claim', async () => {
    await post(run({
      session: 's-notes', agent: 'a1', answer: 'All 48 tests pass.',
      steps: [{ m: 0, do: 'edit', path: 'src/lib/plan.ts' }, { m: 2, do: 'test' }, { m: 3, do: 'edit', path: 'notes/review.md' }, { m: 4, do: 'edit', path: 'pr-body.md' }],
    }));
    expect(rowsOf('s-notes')).toMatchObject([{ kind: 'test', backed: true }]);
  });

  it('is held to all its calls, across its turns', async () => {
    const steps = [{ m: 0, do: 'edit' as const, path: 'src/a.ts' }, { m: 1, do: 'test' as const, fail: true }];
    await post([...run({ session: 's-resumed', agent: 'a1', answer: 'Two tests fail.', steps }), ...run({ session: 's-resumed', agent: 'a1', first: false, turn: 2, answer: 'All 3 tests pass.', steps: [{ m: 10, do: 'delegate' }] })]);
    // the second turn made no calls but a hand-off; the run's last test run, in the first turn, failed
    expect(rowsOf('s-resumed')).toMatchObject([{ kind: 'test', backed: false, why: 'failed' }]);
  });
});

describe('a main agent\'s answer, checked as its turn ends', () => {
  it('is held to its calls in that turn: a run in the turn before backs nothing', async () => {
    const t1 = run({ session: 's-main', answer: 'All 12 tests pass.', turn: 1, steps: [{ m: 0, do: 'edit', path: 'src/a.ts' }, { m: 1, do: 'test' }] });
    const t2 = run({ session: 's-main', answer: 'All 12 tests pass.', turn: 2, first: false, steps: [{ m: 10, do: 'edit', path: 'src/a.ts' }] });
    await post([...t1, ...t2]);
    expect(rowsOf('s-main')).toEqual([
      { agent: 's-main:main', kind: 'test', file: null, backed: true, why: null, editTs: null, runTs: null },
      { agent: 's-main:main', kind: 'test', file: null, backed: false, why: 'no_run', editTs: min(10), runTs: null },
    ]);
  });

  it('a turn with no calls at all, restating an earlier result, is not held to a run it had no need of', async () => {
    await post(run({ session: 's-status', answer: 'Status: 1001 unit tests pass.', steps: [] }));
    expect(rowsOf('s-status')).toMatchObject([{ kind: 'test', backed: true }]);
  });

  it('an edit claim in the first person is held to the agent\'s writes: the turn\'s, and those of the turns before it that it may recap', async () => {
    await post(run({ session: 's-first', answer: 'I edited `src/lib/plan.ts` to carry the quarter.', steps: [{ m: 0, do: 'edit', path: 'src/lib/other.ts' }] }));
    expect(rowsOf('s-first')).toMatchObject([{ kind: 'edit', file: 'src/lib/plan.ts', backed: false, why: 'no_write' }]);
    const t1 = run({ session: 's-recap', answer: 'Done.', turn: 1, steps: [{ m: 0, do: 'edit', path: 'src/lib/plan.ts' }] });
    const t2 = run({ session: 's-recap', answer: 'I edited `src/lib/plan.ts` and `src/lib/never.ts`.', turn: 2, first: false, steps: [{ m: 10, do: 'test' }] });
    await post([...t1, ...t2]);
    expect(rowsOf('s-recap')).toMatchObject([{ kind: 'edit', file: 'src/lib/plan.ts', backed: true }]); // the second file is not named: one claim per sentence
    const t3 = run({ session: 's-recap2', answer: 'Done.', turn: 1, steps: [{ m: 0, do: 'edit', path: 'src/lib/other.ts' }] });
    const t4 = run({ session: 's-recap2', answer: 'I edited `src/lib/plan.ts`.', turn: 2, first: false, steps: [{ m: 10, do: 'test' }] });
    await post([...t3, ...t4]);
    expect(rowsOf('s-recap2')).toMatchObject([{ kind: 'edit', file: 'src/lib/plan.ts', backed: false, why: 'no_write' }]);
  });

  it('a shell command an earlier turn ran may have made the edit: it backs a recap, as it backs one in its own turn', async () => {
    const t1 = run({ session: 's-shell', answer: 'Done.', turn: 1, steps: [{ m: 0, do: 'shell' }] });
    const t2 = run({ session: 's-shell', answer: 'I edited `src/lib/plan.ts`.', turn: 2, first: false, steps: [{ m: 10, do: 'test' }] });
    await post([...t1, ...t2]);
    expect(rowsOf('s-shell')).toMatchObject([{ kind: 'edit', backed: true }]);
  });
});

describe('without Content on full', () => {
  it('nothing is checked: no rows, the drawer says content is off, and Patterns says no session was checked', async () => {
    await post(run({ session: 's-off', agent: 'a1', content: 'off', answer: 'All 48 tests pass.', project: SOLO, steps: [{ m: 0, do: 'edit', path: 'src/a.ts' }] }));
    expect(rowsOf('s-off')).toEqual([]);
    const h = await get<any>('/api/history?session=s-off&agent=a1');
    expect(h.content).toBe('off');
    expect(h.items.filter((i: any) => i.kind === 'claim')).toEqual([]);
    expect((await get<any>('/api/patterns?project=solo')).claims).toEqual({ sessions: 1, checked: 0, test: { total: 0, unbacked: 0 }, build: { total: 0, unbacked: 0 }, edit: { total: 0, unbacked: 0 } });
  });
});

describe('Patterns: the claims of a project', () => {
  const OWNER = { cwd: '/Users/a/owner', name: 'owner', git_remote: 'github.com/o/owner' };
  it('counts them by kind, with how many are unbacked and how many sessions were checked', async () => {
    const r = (o: Omit<Run, 'project'>) => run({ ...o, project: OWNER });
    await post([
      // 1: two test claims, one backed (turn 1), one not (turn 2); a build claim, backed by the run in its turn
      ...r({ session: 'p-1', answer: 'All 12 tests pass. Typecheck is clean.', turn: 1, steps: [{ m: 0, do: 'edit', path: 'src/a.ts' }, { m: 1, do: 'test' }, { m: 2, do: 'build' }] }),
      ...r({ session: 'p-1', answer: 'All 12 tests pass.', turn: 2, first: false, steps: [{ m: 10, do: 'edit', path: 'src/a.ts' }] }),
      // 2: a subagent's edit claim that was made up
      ...r({ session: 'p-2', agent: 'a1', answer: '- Fixed the totals in `src/lib/plan.ts`', steps: [{ m: 0, do: 'edit', path: 'src/lib/other.ts' }] }),
      // 3: not checked
      ...r({ session: 'p-3', content: 'off', answer: 'All 12 tests pass.', steps: [{ m: 0, do: 'edit', path: 'src/a.ts' }] }),
    ]);
    expect((await get<any>('/api/patterns?project=owner')).claims).toEqual({
      sessions: 3, checked: 2, test: { total: 2, unbacked: 1 }, build: { total: 1, unbacked: 0 }, edit: { total: 1, unbacked: 1 },
    });
  });
});

describe('the live state', () => {
  const T0 = min(-10);
  const claimsOfRun = (events: Event[]) => {
    const db = openStore(':memory:');
    const text = openContentStore(':memory:');
    seedStore(db, events, text);
    const rows = checkAnswers(db, text, events);
    db.close();
    text.close();
    return rows;
  };

  it('puts an unbacked claim on the agent that made it, with its words and the facts, until its next turn starts', () => {
    const events = run({ session: 'l-1', agent: 'a1', answer: 'All 48 tests pass.', steps: [{ m: 0, do: 'test' }, { m: 4, do: 'edit', path: 'src/a.ts' }] });
    const live = newLive();
    applyEvents(live, events);
    expect(applyClaims(live, claimsOfRun(events))).toEqual(['l-1']);
    const agent = (visible(live, T0 + 3_600_000)[0] as any).agents.find((a: any) => a.id === 'a1');
    expect(agent).toMatchObject({ state: 'done', unbacked: [{ kind: 'test', phrase: 'All 48 tests pass', why: 'stale', editTs: min(4), runTs: min(0), ts: min(5) }] });
    // the agent works again: the mark was for its last answer
    applyEvents(live, [ev('l-1', min(30), 'turn.start', {}, { agent_id: 'a1', turn_id: 't-next' })]);
    expect((visible(live, T0 + 3_600_000)[0] as any).agents.find((a: any) => a.id === 'a1').unbacked).toBeUndefined();
  });

  it('a backed answer leaves no mark, and clears the last one', () => {
    const live = newLive();
    const bad = run({ session: 'l-2', answer: 'All 48 tests pass.', steps: [{ m: 0, do: 'edit', path: 'src/a.ts' }] });
    applyEvents(live, bad);
    applyClaims(live, claimsOfRun(bad));
    const main = () => (visible(live, T0 + 3_600_000)[0] as any).agents.find((a: any) => a.id === 'main');
    expect(main().unbacked).toHaveLength(1);
    applyClaims(live, claimsOfRun(run({ session: 'l-2', answer: 'All 48 tests pass.', steps: [{ m: 0, do: 'edit', path: 'src/a.ts' }, { m: 1, do: 'test' }] })));
    expect(main().unbacked).toBeUndefined();
  });
});

