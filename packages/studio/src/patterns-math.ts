import { plural } from './format.ts';
import type { FigureData, Said } from './kit.tsx';
import { FAILED_USUAL } from './ledger-math.ts';

// The Analysis page's Patterns view (v0.3 slice 3, #45, design/v0.3-worth-truth.html), kept pure for tests: the words for each shape and kind,
// the five figures with the sentence on top of them (#102) and the table's rows. The figures come from GET /api/patterns (packages/server/src/api/patterns.ts).

export type Repeat = { shape: string; tool: string; errorClass: string; commandClass: string | null; count: number; sessions: number; lastAt: number; sample: string | null };
export type Kind = { errorClass: string; count: number; commands?: { commandClass: string; count: number }[] };
/** v0.3 slice 4 (#44): the project's claims by kind, and how many of its `sessions` were `checked` (Content on full). */
export type Claims = { sessions: number; checked: number; test: ClaimCount; build: ClaimCount; edit: ClaimCount };
type ClaimCount = { total: number; unbacked: number };
export type PatternsData = { calls: number; failed: number; kinds: Kind[]; repeats: Repeat[]; testsEditedAfterFailure: { count: number; sessions: number }; claims: Claims };

// A shape or class the server sends is `^[a-z_]+$`, so `constructor` is one: a table is read for its own keys only.
const own = <T,>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

// ── Repeats ──────────────────────────────────────────────────────────────────

export type RepeatText = { title: string; what?: string; fix?: string; sample?: string };

// The named shapes (packages/shared/src/classes.ts errorShape): what happened, and what to try. `backticks` are code.
const NAMED: Record<string, { title: string; what: string; fix: string }> = {
  sleep_blocked: { title: 'Waiting with sleep, blocked', what: 'Agents waited with `sleep`, then read a log or a status; Claude Code blocks it.', fix: 'Tell agents to run long jobs in the background and wait for the notification.' },
  hook_blocked: { title: 'Stopped by a hook', what: 'A hook in the project refused the call.', fix: 'Tell agents which files and branches the hook protects, before they start.' },
  wrong_tool_name: { title: 'A tool called by the wrong name', what: "An agent called a tool that doesn't exist, such as `bash` for `Bash`.", fix: 'Check the tool names in the agent files and briefs.' },
  gh_projects_classic: { title: 'gh edit on a Projects (classic) repo', what: '`gh issue edit` and `gh pr edit` fail with a GraphQL deprecation error.', fix: 'Use `gh api -X PATCH` instead, and put it in the briefs.' },
  classifier_denied: { title: 'Refused by the auto-mode classifier', what: "Auto mode's classifier stopped the call.", fix: 'Allow the commands you approve every time, or run them yourself.' },
  user_rejected: { title: 'You said no', what: 'You declined the call at the permission prompt.', fix: "Say in the brief what you don't want agents to do." },
  safety_check: { title: "Stopped by Claude Code's safety check", what: 'A built-in check stopped a removal.', fix: 'Tell agents to remove things by name, never in bulk.' },
  deny_rule: { title: 'Stopped by a deny rule', what: 'A deny rule in your settings stopped the call.', fix: "Tell agents what the rule covers, so they don't try." },
  outside_worktree: { title: 'Refused inside a worktree', what: "An agent isolated in a worktree ran a command Claude Code couldn't verify stays inside it, most often a chained or computed `git` call.", fix: 'Tell agents to run commands from the worktree itself, as plain separate commands.' },
};

// A hash shape says nothing a person can read: the row is the tool and what kind of failure it was.
const FAILED_COMMAND: Record<string, string> = {
  test: 'a test run failed', build: 'a build failed', lint: 'a lint run failed', git: 'a git command failed', gh: 'a gh command failed',
  docker: 'a docker command failed', install: 'an install failed', other: 'a command failed',
};
const FAILED: Record<string, string> = {
  not_found: "a path that doesn't exist", timeout: 'a timeout', refused: 'a call that was refused', no_match: "an edit whose text wasn't in the file",
  read_first: 'a write before the read', invalid_input: 'invalid input', unknown_command: "a command that doesn't exist", other: 'an error',
};
const failedWith = (r: Repeat) =>
  (r.errorClass === 'exit_code' ? own(FAILED_COMMAND, r.commandClass ?? 'other') ?? FAILED_COMMAND.other : own(FAILED, r.errorClass)) ?? 'a failure';

/** A repeat's words: a named shape has a title, what happened and what to try; any other shape (a hash, or one this studio does not know yet) the tool and kind, and the sample when there is one. */
export function repeatText(r: Repeat): RepeatText {
  return own(NAMED, r.shape) ?? { title: `${r.tool}: ${failedWith(r)}`, ...(r.sample ? { sample: r.sample } : {}) };
}

/**
 * The repeats the card has a row for: a named one, or one with a sample. An unnamed repeat with no sample (Content off, or no output kept) reads "Bash: a command failed"
 * and tells a person nothing to act on, so those are `folded` into a closing line, in the server's order.
 */
export const foldRepeats = (repeats: Repeat[]) => {
  const named = (r: Repeat) => own(NAMED, r.shape) !== undefined || !!r.sample;
  return { rows: repeats.filter(named), folded: repeats.filter((r) => !named(r)) };
};

/** `5 more failures repeat with no name (38, 16, 12, 11 and 11 times). With Content on full, their first line shows here.` None folded, no line. */
export function foldedLine(folded: Repeat[]): string | undefined {
  if (!folded.length) return undefined;
  const times = folded.map((r) => r.count.toLocaleString('en'));
  const list = times.length > 1 ? `${times.slice(0, -1).join(', ')} and ${times.at(-1)}` : times[0];
  const one = folded.length === 1;
  return `${plural(folded.length, 'more failure')} ${one ? 'repeats' : 'repeat'} with no name (${list} times). With Content on full, ${one ? 'its' : 'their'} first line shows here.`;
}

/** `155 · 4 sessions`. */
export const repeatCount = (r: Repeat) => `${r.count.toLocaleString('en')} · ${plural(r.sessions, 'session')}`;

// ── Kinds ────────────────────────────────────────────────────────────────────

const KINDS: Record<string, string> = {
  exit_code: 'A command failed', not_found: "A path that doesn't exist", timeout: 'A timeout', refused: 'Refused (permission, a hook or the classifier)',
  no_match: "An edit whose text wasn't in the file", read_first: 'Written before it was read', invalid_input: 'Invalid input', unknown_command: "A command that doesn't exist", other: 'Other',
};
const COMMANDS: Record<string, string> = { test: 'tests', build: 'builds', lint: 'lint', git: 'git', gh: 'gh', docker: 'docker', install: 'installs', other: 'other commands' };

export type KindRow = { key: string; label: string; count: number; width: number; sub: boolean };

/** The table's rows in the server's order, a kind's commands right under it; every bar on the scale of the biggest kind, and never thinner than a sliver. */
export function kindRows(kinds: Kind[]): KindRow[] {
  const max = Math.max(1, ...kinds.map((k) => k.count));
  const width = (n: number) => Math.max(2, (n / max) * 100);
  return kinds.flatMap((k) => [
    { key: k.errorClass, label: own(KINDS, k.errorClass) ?? k.errorClass, count: k.count, width: width(k.count), sub: false },
    ...(k.commands ?? []).map((c) => ({ key: `${k.errorClass}/${c.commandClass}`, label: own(COMMANDS, c.commandClass) ?? c.commandClass, count: c.count, width: width(c.count), sub: true })),
  ]);
}

// ── Figures and the reading ────────────────────────────────────────────────────────────────

const n = (x: number) => x.toLocaleString('en');
/** One decimal; a rate that would round to nothing says so instead of 0.0%. */
const pct = (part: number, whole: number) => {
  const p = whole ? (part / whole) * 100 : 0;
  return part > 0 && p < 0.05 ? '<0.1%' : `${p.toFixed(1)}%`;
};

// ponytail: fixed thresholds for "rare"; make them settings if they turn out wrong for someone.
const RARE = 0.01; // a kind under 1 call in 100 is rare

const WHY_CLAIMS =
  "With Content on full, an agent's final answer and every subagent's report are read for test, build and edit claims, and each is checked against that agent's own calls: a passing run after its last edit to code or tests, and a write to the file it names. "
  + 'Edits to notes, PR bodies and memory files do not count. A session without Content on full is not checked, which is not the same as clean.';

/**
 * "Unbacked claims: N of M test claims" (design/v0.3-worth-truth.html), with the builds and edits beside it. A project none of whose sessions had Content on full says it was
 * not checked, never 0: nothing was read. Some of them checked says how many.
 */
export function claimsStat(c: Claims): FigureData {
  const label = 'Unbacked claims';
  if (!c.checked) return { label, value: 'not checked', usual: 'Content is not on full in any session', why: WHY_CLAIMS };
  const parts = [`of ${plural(c.test.total, 'test claim')}`];
  if (c.build.total) parts.push(`builds ${c.build.unbacked} of ${c.build.total}`);
  if (c.edit.total) parts.push(`edits ${c.edit.unbacked} of ${c.edit.total}`);
  if (c.checked < c.sessions) parts.push(`${c.checked} of ${plural(c.sessions, 'session')} checked`);
  return { label, value: n(c.test.unbacked), usual: parts.join(' · '), bad: c.test.unbacked + c.build.unbacked + c.edit.unbacked > 0, why: WHY_CLAIMS };
}

/** "Rare: 1 in 750 calls." A kind that never happened says so. */
const rarity = (count: number, calls: number) =>
  count ? `${count / calls < RARE ? 'Rare' : 'Not rare'}: 1 in ${n(Math.round(calls / count))} calls.` : `None in ${n(calls)} calls.`;

/** The five figures: the failed calls and their share, two kinds that are a person's to fix, the tests edited after a failure ("worth a look", not a flag), and the unbacked claims. */
export function figures(d: PatternsData): FigureData[] {
  const of = (errorClass: string) => d.kinds.find((k) => k.errorClass === errorClass)?.count ?? 0;
  const tests = d.testsEditedAfterFailure;
  return [
    {
      label: 'Calls that failed', value: n(d.failed),
      usual: `of ${n(d.calls)} tool calls (${pct(d.failed, d.calls)}). ${d.failed / d.calls >= FAILED_USUAL ? 'More than usual' : 'Usual'}: under ${FAILED_USUAL * 100}% is normal.`,
      why: 'A tool call that came back with an error: a command that exited non-zero, a file that was not there, a call that was refused. Some failure is normal (a failing test is a call that did its job); what matters is what repeats.',
    },
    {
      label: "Paths that weren't there", value: n(of('not_found')), usual: rarity(of('not_found'), d.calls),
      why: 'An agent asked for a file or folder that does not exist: a name it invented, or one that was renamed or removed. A handful is normal; many in one session means the agent did not look before it guessed.',
    },
    {
      label: 'Edits that missed', value: n(of('no_match')), usual: rarity(of('no_match'), d.calls),
      why: 'An agent tried to replace text that was not in the file, usually because the file had changed since it last read it.',
    },
    {
      label: 'Test files changed right after a failing run', value: n(tests.count), usual: tests.count ? `In ${plural(tests.sessions, 'session')}. Worth a look, not a worry.` : 'None.',
      why: 'A test file edited right after a test run failed. Often that is the right fix (the test was wrong); sometimes it is an agent bending a test to pass. Look at the diff to tell which.',
    },
    claimsStat(d.claims),
  ];
}

/** The failure rate on its own is rarely the story; the repeats are. */
export function patternsReading(project: string, d: PatternsData): Said {
  const usual = d.failed / d.calls < FAILED_USUAL;
  return [
    { b: pct(d.failed, d.calls) }, ` of ${project}'s tool calls failed, which on its own is ${usual ? 'normal' : 'more than usual'}.`,
    ...(foldRepeats(d.repeats).rows.length ? [' The repeats below are worth your time: each happens again and again, and a Try line is a rule you can change.'] : []),
  ];
}
