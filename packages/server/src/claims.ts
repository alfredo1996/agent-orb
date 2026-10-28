import type { Event } from '@agent-orb/shared';
import type { ContentStore } from './content-store.ts';
import { all, get, run, type Row, type Store } from './store/store.ts';

// Unbacked claims (v0.3 slice 4, #44; PROJECT.md §6; §15, 2026-10-25): with Content on full, the test, build and edit claims in a final answer are checked against
// the calls of the agent that gave it. Two halves. `claimsOf` and `verdict` are pure: the text in, the claims out, and a claim with the calls it is held to, out
// with its verdict (the check on the big corpus in the issue runs these two over Claude Code's own logs, through `checkText`). `checkAnswers` is the ingest side: when a turn
// or an agent ends with its text, it reads the calls already stored and keeps one row per claim in `claims` (history.db), so Live, History and Patterns are
// queries. Only the claim's place in the text is kept (`at`, `len`), never the words: the phrase is cut from the text store when a view wants it.

export type Kind = 'test' | 'build' | 'edit';
/** Why a claim is unbacked: no run of that kind after the agent's last code edit (none at all, or only ones before it), the last one failed, or no write to the file it names. */
export type Why = 'no_run' | 'stale' | 'failed' | 'no_write';
/** A claim as the text makes it: where, and for an edit claim the file it names. */
export type Found = { kind: Kind; at: number; len: number; file?: string };
/** One call of the agent, as the store holds it: `command` is a Bash call's command class, `error` a failed call's error class, `writes` the project paths it wrote. */
export type Call = { ts: number; tool: string; command: string | null; ok: boolean | null; error: string | null; writes: string[] };
export type Verdict = { backed: true } | { backed: false; why: Why; editTs?: number; runTs?: number };

// ── What is a claim ─────────────────────────────────────────────────────────

// A sentence is judged whole. These make it no claim of the agent's: it says what was not done, what would or should be, what a person must do, or what a CI run
// said (a CI run is no call of the agent's: `gh pr checks` is class gh, and "all six checks green" names no run of its own).
// ponytail: words, not grammar. "Tests pass when run alone" or "the build can pass" read as no claim: a missed claim, never a false flag. `fail` words drop a mixed
// sentence too ("typecheck passes but two tests fail"), after "0 failed" and "no failures" are set aside, which are claims.
const NO_CLAIM = new RegExp(
  String.raw`\b(?:not|never|cannot|unable|won'?t|wouldn'?t|shouldn'?t|couldn'?t|can'?t|didn'?t|haven'?t|hasn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|doesn'?t|don'?t|no longer|will|would|should|could|might|may|going to|if|once|until|unless|whether|when|expect(?:ed|s)?|hope|hopefully|need(?:s|ed)? to|must|make sure|ensure|so that|to (?:verify|check|confirm|see)|waiting)\b|'ll\b|\bfail\w*|\bbroken\b` +
  String.raw`|\bCI\b|\bchecks?\b|\bworkflows?\b|\bpipelines?\b|\bactions?\b|\bpull request|\bPRs?\b|#\d+|github\.com`,
  'i',
);
const ZERO_FAILED = /\b(?:0|no|zero|without any|without)\s+(?:\w+\s+)?fail\w*/gi;
const blank = (m: string) => ' '.repeat(m.length);

// Bounded, as every run below must be: the check runs inside POST /ingest, and `\d[\d,]*` took 8 s on a line of 50,000 numbers. A count over 9,999,999 is no claim.
const COUNT = String.raw`(?:\d{1,3}(?:,\d{3}){1,2}|\d{1,7})`;
const NAME = String.raw`(?:(?:unit|emulator|e2e|integration|contract|full|new|existing|regression|vitest|playwright|my|the|these|those|all|every)\s+(?:and\s+)?){0,3}`;
const PASS = String.raw`(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|green)`;
// A noun in the singular does not take the bare "pass" ("the full test pass" is a stage, "the test passes" a claim).
const PASSES = String.raw`(?:passes|passed|passing|succeeds|succeeded|green)`;
const SEP = String.raw`[\s:*—–-]{1,6}`;
const THEN = String.raw`(?:(?:all|now|also|still|each)\s+)?(?:(?:are|is|were|was)\s+(?:all\s+)?)?`;
// "all 48 tests pass", "the suite is green", "1550 unit tests pass", "921/921 pass", "966 passed", "vitest passes", "e2e green". A "pass" that is not about a run (a compiler's,
// a "test pass") is left out by needing a count, a test noun or a runner beside the verb.
const TEST = [
  String.raw`\b${NAME}(?:${COUNT}\s+)?${NAME}(?:(?:tests|specs|suites|test suites)${SEP}${THEN}${PASS}|(?:test|spec|suite|test suite)${SEP}${THEN}${PASSES})\b`,
  String.raw`\b${COUNT}(?:\/${COUNT})?\s+(?:(?:unit|emulator|e2e|integration)\s+)?(?:tests?\s+)?(?:passed|passing|pass|passes)\b`,
  String.raw`\b(?:vitest|jest|pytest|playwright|e2e)\x60?${SEP}(?:(?:suite|run)\s+)?(?:(?:is|are)\s+)?${PASS}\b`,
];
// "typecheck is clean", "tsc passes", "the build succeeds", "production builds: all three pass", "compiles clean".
const BUILD = [
  String.raw`\b(?:type-?check|type check|tsc(?:\s+--noEmit)?|(?:production |local )?builds?|compil(?:es|ed|ation))\x60?${SEP}(?:(?:is|are|was|were|now|also|still|all|three|\w+ of them)\s+){0,3}(?:clean|green|pass(?:es|ed|ing)?|succe(?:ed|eds|eded|ssful(?:ly)?)|ok|compiles?|compiled)\b`,
  String.raw`\bno (?:type|typescript|compile) errors\b`,
];
const FILE_EXT = String.raw`(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|css|scss|html|py|rb|go|rs|java|rules|yml|yaml|sql|sh|toml|md|mdx|txt)`;
const PATH = String.raw`(?:\.{0,2}\/)?(?:[\w@.~-]+\/)*[\w@-][\w@.-]*\.${FILE_EXT}(?![\w/])`;
const VERB = String.raw`(?:edited|updated|changed|modified|patched|rewrote|rewritten|fixed|added|wrote|written|created|replaced|extended|renamed)`;
const editClaim = (subject: string) =>
  new RegExp(String.raw`(?:${subject})${VERB}\b(?:[^.\n\x60]|\x60[^\x60\n]{0,40}\x60){0,60}?(?:\x60(?<q>${PATH})(?::\d+)?\x60|(?<![\w/\x60.@-])(?<b>${PATH}))`, 'i');
// "I added `usd(0)` to `format.spec.ts`", "I've updated plan.ts": the agent saying what its own hands did. In a subagent's report a sentence or a bullet that starts with the verb
// says the same ("Fixed the totals in `plan.ts`"); in a main agent's answer it is as likely the story of an earlier turn or another agent, so only the "I" form is held to its calls.
// "the implementer updated plan.ts" and "plan.ts was updated" say nobody's own.
const I_EDIT = editClaim(String.raw`\bI(?:'ve| have| just| also| then| now)?\s+(?:now\s+)?`);
const LEAD_EDIT = editClaim(String.raw`^[\s>*_#|-]*(?:\d+[.)]\s+)?[*_]*`);
// A way the edit was made that Edit and Write leave no trace of: not a claim this check can hold anyone to.
const BY_SHELL = /\b(?:script|sed|awk|perl|python3?|heredoc|shell|bash|tee)\b|cat\s*>/i;
const EDIT_HEDGE = /\b(?:not|never|didn'?t|haven'?t|would|will|should|could|if|once|until)\b|'ll\b/i;

// ponytail: a claim is a sentence. A unit longer than this is output pasted into the answer, not the agent's word, and is skipped unread, which also caps what any
// pattern here can cost on one unit. A status line that long is a missed claim.
const MAX_UNIT = 1000;

/** Fenced code is output or a sample, not the agent's own word: blank it, keeping every offset. */
const unfenced = (text: string) => text.replace(/```[\s\S]*?(?:```|$)/g, (m) => m.replace(/[^\n]/g, ' '));

/** Where a unit of text starts and ends: a line, cut again at a full stop that ends a sentence (not the dot in `plan.ts` or `0.5`). */
function* units(text: string): Generator<[number, number]> {
  let start = 0;
  for (const line of text.split('\n')) {
    const lineEnd = start + line.length;
    let from = start;
    for (const m of line.matchAll(/[.!?](?=\s|$)/g)) {
      const end = start + m.index! + 1;
      yield [from, end];
      from = end;
    }
    if (lineEnd > from) yield [from, lineEnd];
    start = lineEnd + 1;
  }
}

/** A path as the store keeps it: relative to the working tree. One outside the tree is `undefined`: no write of it is ever recorded, so it cannot be checked. */
const inTree = (path: string, root?: string) => {
  const p = path.replace(/^\.\//, '');
  if (!p.startsWith('/') && !p.startsWith('~')) return p;
  return root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : undefined;
};

/**
 * The test, build and edit claims in a final answer, in order. `root` is the agent's working tree, to read an absolute path in an edit claim as the project path the store
 * keeps; `report` says it is a subagent's report, not a main agent's answer (the edit claims it holds differ, above).
 * ponytail: a regex per kind, no model. It finds the plain phrasings of a status line and misses the others; a missed claim is a hole, a wrong one is a false flag, so
 * where the two pull apart it misses. One claim of each kind per sentence.
 */
export function claimsOf(text: string, { root, report = false }: { root?: string; report?: boolean } = {}): Found[] {
  const body = unfenced(text);
  const found: Found[] = [];
  for (const [from, to] of units(body)) {
    if (to - from > MAX_UNIT) continue;
    const unit = body.slice(from, to);
    const plain = unit.replace(ZERO_FAILED, blank);
    const add = (kind: Kind, m: RegExpExecArray, file?: string) => {
      const bullet = /^[\s>*_#|-]*(?:\d+[.)]\s+)?[*_]*/.exec(m[0])![0].length; // a list marker before the verb is no part of the words
      found.push({ kind, at: from + m.index + bullet, len: m[0].length - bullet, ...(file ? { file } : {}) });
    };
    if (!NO_CLAIM.test(plain)) {
      for (const [kind, patterns] of [['test', TEST], ['build', BUILD]] as const) {
        const m = patterns.map((p) => new RegExp(p, 'i').exec(plain)).find(Boolean);
        if (m) add(kind, m);
      }
    }
    const e = I_EDIT.exec(unit) ?? (report ? LEAD_EDIT.exec(unit) : null);
    if (e && !EDIT_HEDGE.test(unit.slice(0, e.index + e[0].length)) && !BY_SHELL.test(unit)) {
      const file = inTree(e.groups!.q ?? e.groups!.b!, root);
      if (file) add('edit', e, file);
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

// ── Held to its calls ───────────────────────────────────────────────────────

// ponytail: "not code" is a rule on the path: prose and notes by extension (md, mdx, txt, rst, adoc), anything in a docs/ or notes/ folder, and the files named README,
// CHANGELOG or LICENSE. A note, a PR body or a memory file written in the tree does not break a claim (the big corpus's only two flags were exactly those). The ceiling: a
// document that is a test fixture reads as not code, and a note kept in a .json or .yml file reads as code. Make it a setting if either is ever seen.
const NOT_CODE = /\.(?:md|mdx|txt|rst|adoc)$|(?:^|\/)(?:docs?|notes?)\/|(?:^|\/)(?:readme|changelog|license)[^/]*$/i;
export const isCode = (path: string) => !NOT_CODE.test(path);

// A call that never ran is no run: a permission refusal, a command the shell did not know, a path that was not there.
const NEVER_RAN = new Set(['refused', 'unknown_command', 'not_found', 'invalid_input']);
const DELEGATES = new Set(['Agent', 'Task', 'Workflow']);
const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const same = (written: string, named: string) => written === named || written.endsWith(`/${named}`) || named.endsWith(`/${written}`);

/**
 * One claim against the calls it is held to (a main agent's turn, or all of a subagent's), in the order they were made.
 * - test, build: after the agent's last edit to code or tests (`isCode`), the last run of that kind must have succeeded. None after it is `no_run` (none at all) or `stale`
 *   (only before the edit), and a last run that failed is `failed`. An agent that edited nothing has made no change a run has to cover: only a failed last run flags it.
 *   A test run backs a build claim too, because a chain (`pnpm test && tsc`) has the class of its first link. An agent that handed work to a subagent after its last edit is
 *   not held to it: what it says may be that agent's run, and that agent's own report is checked against its own calls.
 * - edit: a successful write to the file it names by this agent, in these calls or in `earlier` ones: a main agent's answer may recap the turns before it, and a file
 *   is written once, not once per turn. A write the store cannot see backs it: an Edit or Write that succeeded and recorded no path (outside the working tree), a Bash call of
 *   class `other` (an edit through the shell), and a hand-off.
 * ponytail: the class is the only thing known of a command, so a test run of one suite backs "all tests pass", and an edit made through Bash (`sed -i`, a heredoc) is invisible:
 * any such call backs every edit claim of its agent, which leaves this check to catch the agent that never wrote anything and never ran a shell command. the big corpus made it
 * (2 of its 5 edit claims were written through Python). Both read as backed, never as a flag the owner would have to dismiss.
 */
export function verdict(claim: Found, calls: Call[], earlier: Call[] = []): Verdict {
  const delegated = calls.some((c) => DELEGATES.has(c.tool));
  if (claim.kind === 'edit') {
    // An edit made through the shell (a `python3` heredoc, `sed -i`: a Bash call of class `other`) leaves no path either, so an agent that ran one may have made it.
    const wrote = [...earlier, ...calls].some((c) => c.writes.some((w) => same(w, claim.file!)) || (c.ok === true && ((WRITERS.has(c.tool) && !c.writes.length) || (c.tool === 'Bash' && c.command === 'other'))));
    return wrote || delegated ? { backed: true } : { backed: false, why: 'no_write' };
  }
  const edits = calls.filter((c) => c.writes.some(isCode));
  const editTs = edits.length ? Math.max(...edits.map((c) => c.ts)) : undefined;
  const after = (c: Call) => editTs === undefined || c.ts > editTs;
  const ran = (c: Call) => c.ok !== null && !(c.error && NEVER_RAN.has(c.error));
  const own = calls.filter((c) => c.command === claim.kind && ran(c));
  const last = own.filter(after).at(-1);
  if (last?.ok || (claim.kind === 'build' && calls.some((c) => c.command === 'test' && c.ok === true && after(c)))) return { backed: true };
  const edit = editTs === undefined ? {} : { editTs };
  if (last) return { backed: false, why: 'failed', runTs: last.ts, ...edit };
  if (editTs === undefined || calls.some((c) => DELEGATES.has(c.tool) && c.ts > editTs)) return { backed: true };
  const before = own.at(-1);
  return { backed: false, why: before ? 'stale' : 'no_run', ...edit, ...(before && { runTs: before.ts }) };
}

/** An answer's claims, each with its verdict: what the ingest and the big-corpus check both run. */
export function checkText(text: string, calls: Call[], opts?: Parameters<typeof claimsOf>[1] & { earlier?: () => Call[] }) {
  let earlier: Call[] | undefined; // the agent's writes before these calls: asked for only when an edit claim is not backed by these
  return claimsOf(text, opts).map((claim) => {
    const v = verdict(claim, calls);
    return { claim, verdict: v.backed || claim.kind !== 'edit' || !opts?.earlier ? v : verdict(claim, calls, (earlier ??= opts.earlier())) };
  });
}

// ── At ingest ───────────────────────────────────────────────────────────────

export type ClaimRow = {
  agent_id: string; session_id: string; turn_id: string; n: number; kind: Kind; file: string | null; backed: boolean; why: Why | null;
  edit_ts: number | null; run_ts: number | null; request_id: string; at: number; len: number; ts: number;
};
/** A row with its words, for the live view; the words are never stored. */
export type ClaimLive = ClaimRow & { phrase: string };

const CALLS = `x.tool AS tool, x.ts AS ts, x.command_class AS command, x.success AS success, x.error_class AS error,
  (SELECT json_group_array(f.path) FROM files_touched f WHERE f.tool_use_id = x.tool_use_id AND f.mode = 'write') AS writes`;

const callOf = (r: Row): Call => ({ ts: r.ts, tool: r.tool, command: r.command, ok: r.success === null ? null : r.success === 1, error: r.error, writes: JSON.parse(r.writes) });

/**
 * The answers a batch ends, checked: a main agent's `turn.complete` (reason `answer`) and a subagent's `agent.complete`. The answer is the text of the agent's last
 * request at or before it, read from the text store, so nothing is checked with Content off. A main agent's claims are held to its calls in that turn, a subagent's to all
 * its calls, those made no later than the answer. Idempotent: an answer's rows are replaced, so a batch sent again gives the same rows (or better ones, if a call arrived
 * late). Returns the rows it wrote, for the live view.
 * ponytail: a call that reaches the store after its agent's end (a batch out of order) is not in the check; the plugin's outbox is FIFO, and a resent batch reruns it.
 */
export function checkAnswers(db: Store, content: ContentStore, events: Event[]): ClaimLive[] {
  const out: ClaimLive[] = [];
  for (const e of events) {
    const main = e.kind === 'turn.complete' && !e.agent_id && e.data.reason === 'answer';
    if (!main && e.kind !== 'agent.complete') continue;
    const agent = `${e.session_id}:${e.agent_id ?? 'main'}`;
    const request = main
      ? get(db, 'SELECT id, ts, turn_id FROM api_requests WHERE turn_id = :turn AND ts <= :ts ORDER BY ts DESC, id DESC LIMIT 1', { turn: e.turn_id, ts: e.ts })
      : get(db, 'SELECT r.id AS id, r.ts AS ts, r.turn_id AS turn_id FROM turns t JOIN api_requests r ON r.turn_id = t.id WHERE t.agent_id = :agent AND r.ts <= :ts ORDER BY r.ts DESC, r.id DESC LIMIT 1', { agent, ts: e.ts });
    if (!request) continue;
    const text = content.get([{ node: 'request', id: request.id }]).get(`request:${request.id}`)?.answer;
    const calls = !text ? [] : (main
      ? all(db, `SELECT ${CALLS} FROM tool_calls x WHERE x.turn_id = :turn AND x.ts <= :ts ORDER BY x.ts`, { turn: request.turn_id, ts: request.ts })
      : all(db, `SELECT ${CALLS} FROM turns t JOIN tool_calls x ON x.turn_id = t.id WHERE t.agent_id = :agent AND x.ts <= :ts ORDER BY x.ts`, { agent, ts: request.ts })
    ).map(callOf);
    // A main agent's answer is held to its turn's calls, but it may recap the turns before: for an edit claim, its writes in them count too, and one shell call is enough (it may have been the edit).
    const writers = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map((t) => `'${t}'`).join(', ');
    const before = `FROM turns t JOIN tool_calls x ON x.turn_id = t.id WHERE t.agent_id = :agent AND x.turn_id <> :turn AND x.ts <= :ts`;
    const earlier = () => [
      ...all(db, `SELECT ${CALLS} ${before} AND x.tool IN (${writers})`, { agent, turn: request.turn_id, ts: request.ts }),
      ...all(db, `SELECT ${CALLS} ${before} AND x.tool = 'Bash' AND x.command_class = 'other' AND x.success = 1 LIMIT 1`, { agent, turn: request.turn_id, ts: request.ts }),
    ].map(callOf);
    db.exec('BEGIN');
    try {
      run(db, 'DELETE FROM claims WHERE agent_id = :agent AND turn_id = :turn', { agent, turn: request.turn_id });
      (text ? checkText(text, calls, { root: e.project.checkout ?? e.project.cwd, report: !main, ...(main && { earlier }) }) : []).forEach(({ claim, verdict: v }, n) => {
        const row: ClaimRow = {
          agent_id: agent, session_id: e.session_id, turn_id: request.turn_id, n, kind: claim.kind, file: claim.file ?? null, backed: v.backed, why: v.backed ? null : v.why,
          edit_ts: v.backed ? null : v.editTs ?? null, run_ts: v.backed ? null : v.runTs ?? null, request_id: request.id, at: claim.at, len: claim.len, ts: request.ts,
        };
        run(db, `INSERT INTO claims (agent_id, session_id, turn_id, n, kind, file, backed, why, edit_ts, run_ts, request_id, at, len, ts)
                 VALUES (:agent_id, :session_id, :turn_id, :n, :kind, :file, :backed, :why, :edit_ts, :run_ts, :request_id, :at, :len, :ts)`, row);
        out.push({ ...row, phrase: text!.slice(claim.at, claim.at + claim.len) });
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return out;
}
