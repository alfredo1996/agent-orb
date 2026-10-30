// The mod's pure logic: no engine calls here, so Vitest can test it and check its events against the shared Zod schema.

export const CAP = 100_000; // §13: past this the outbox drops its oldest events
export const BATCH = 200; // §4: flush every 2 s or at 200 events
// Characters of JSON a batch may hold, as COMMIT_BUDGET: the server takes 1 MB a request, and 250,000 characters are at most 750 KB of
// UTF-8. Past it, 200 events of full content were about 39 MB, refused (413) and resent for ever (#97).
const BATCH_BUDGET = 250_000;
const BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

export type Ev = { id: string; ts: number; kind: string; session_id: string; [k: string]: unknown };

export type Ctx = {
  host: string;
  session_id: string;
  project: { cwd: string; name: string; git_remote?: string; git_branch?: string; checkout?: string };
};

/** One §5 event. `user_id` is a placeholder: the server sets it from the token. */
export const makeEvent = (ctx: Ctx, kind: string, data: object, extra: Record<string, unknown> = {}, ts = Date.now()): Ev => ({
  v: 1,
  id: crypto.randomUUID(),
  ts,
  host: ctx.host,
  user_id: 'local',
  session_id: ctx.session_id,
  project: ctx.project,
  ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
  kind,
  data,
});

type ApiUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
export const usageOf = (u: ApiUsage | null | undefined) => ({
  input: u?.input_tokens ?? 0,
  output: u?.output_tokens ?? 0,
  cache_read: u?.cache_read_input_tokens ?? 0,
  cache_creation: u?.cache_creation_input_tokens ?? 0,
});
export const tokensOf = (u: ReturnType<typeof usageOf>) => u.input + u.output + u.cache_read + u.cache_creation;

/** What `$.process.run` gives back, as `hostName` needs it; it rejects when the command cannot start. */
export type Run = (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string }>;

/**
 * The machine's name. On a Mac `hostname -s` is whatever the network's DNS calls it while no HostName is set, so one Mac was several hosts as it
 * changed network (#107, `Host-009` on a home router); LocalHostName is the name set in System Settings → Sharing and stays put. `platform` is
 * lowercase `uname -s` (the hooks environment has no `process.platform`). '' when nothing answers; the caller names the host then.
 */
export async function hostName(run: Run, platform: string): Promise<string> {
  const ask = (argv: string[]) => run(argv).then((r) => (r.exitCode === 0 ? r.stdout.trim() : ''), () => '');
  return (platform === 'darwin' && (await ask(['scutil', '--get', 'LocalHostName']))) || ask(['hostname', '-s']);
}

// ── Outbox ──────────────────────────────────────────────────────────────────

export type Outbox = { queue: Ev[]; dropped: number; droppedSince?: number; failures: number; nextTryAt: number; rejected: number };
export const newOutbox = (): Outbox => ({ queue: [], dropped: 0, failures: 0, nextTryAt: 0, rejected: 0 });

export function enqueue(o: Outbox, e: Ev) {
  o.queue.push(e);
  if (o.queue.length <= CAP) return;
  const over = o.queue.length - CAP;
  o.queue.splice(0, over);
  o.dropped += over;
  o.droppedSince ??= e.ts;
}

/** The next batch to send, oldest first, within BATCH events and BATCH_BUDGET, or null while backing off or empty. */
export function takeBatch(o: Outbox, now: number): Ev[] | null {
  if (!o.queue.length || now < o.nextTryAt) return null;
  // The first event always goes, so the outbox never stalls on an empty batch: capText keeps any one event far under 1 MB.
  let n = 1;
  let size = JSON.stringify(o.queue[0]).length;
  while (n < Math.min(BATCH, o.queue.length) && (size += JSON.stringify(o.queue[n]).length + 1) <= BATCH_BUDGET) n++;
  return o.queue.slice(0, n);
}

/** Applies the server's answer to the batch of `sent` events. status 0 = no answer (server down). */
export function settle(o: Outbox, sent: number, status: number, now: number, refused = 0) {
  if (status >= 200 && status < 300) {
    o.queue.splice(0, sent);
    o.rejected += Math.min(refused, sent); // #114: the server took the batch and refused these of its events, one by one
    o.failures = 0;
    o.nextTryAt = 0;
  } else if (status === 400 || status === 413) {
    // ponytail: an invalid batch, or one too big (413), would block the queue forever, so it is dropped and counted (shown in /orb).
    // The shared schema test keeps the mod's events valid and takeBatch keeps a batch under 1 MB; either here means a bug, not bad luck.
    o.queue.splice(0, sent);
    o.rejected += sent;
  } else {
    o.failures++;
    o.nextTryAt = now + Math.min(BACKOFF_MS * 2 ** o.failures, MAX_BACKOFF_MS);
  }
}

/** How many events a 2xx reply says the server refused (#114): its `rejected`, or 0 for any reply that does not say (an older server, a proxy). */
export function rejectedIn(text: string): number {
  try {
    const n = (JSON.parse(text) as { rejected?: unknown } | null)?.rejected;
    return Number.isInteger(n) && (n as number) > 0 ? (n as number) : 0;
  } catch {
    return 0;
  }
}

// ── Project facts ───────────────────────────────────────────────────────────

/** `host/owner/repo`, with any scheme, user, password, port and `.git` stripped. */
export function normalizeRemote(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const scp = /^[^@/]+@([^:/]+):(?!\d+\/)(.+)$/.exec(url); // git@github.com:o/r.git
  let host: string | undefined;
  let path: string | undefined;
  if (scp) [host, path] = [scp[1], scp[2]];
  else {
    try {
      const u = new URL(url);
      [host, path] = [u.hostname, u.pathname.replace(/^\/+/, '')];
    } catch {
      return undefined;
    }
  }
  return host && path ? `${host}/${path.replace(/\.git$/, '').replace(/\/+$/, '')}` : undefined;
}

const WRITES = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
/** §5: project-relative paths only; anything outside the project is left out. */
export function filesTouched(tool: string, input: Record<string, unknown>, root: string) {
  const mode = tool === 'Read' ? 'read' : WRITES.has(tool) ? 'write' : null;
  const path = input.file_path ?? input.notebook_path;
  if (!mode || typeof path !== 'string' || !path.startsWith(`${root}/`)) return [];
  return [{ path: path.slice(root.length + 1), mode } as const];
}

// ── Error and command classes (v0.3 slice 1, #43) ────────────────────────────
// A copy of packages/shared/src/classes.ts (the plugin imports nothing from shared, as MOD_ROLES shows); contract.spec.ts holds the two to the
// same tables (shared/test/class-tables.ts), so change both together. A short class travels instead of the text it was worked out from.

export const MOD_ERROR_CLASSES = ['not_found', 'no_match', 'exit_code', 'timeout', 'refused', 'read_first', 'invalid_input', 'unknown_command', 'other'] as const;
export type ErrorClass = (typeof MOD_ERROR_CLASSES)[number];
export const MOD_COMMAND_CLASSES = ['test', 'build', 'lint', 'git', 'gh', 'docker', 'install', 'other'] as const;
export type CommandClass = (typeof MOD_COMMAND_CLASSES)[number];


// A call stopped before it ran, as the result starts: the permission system (a rule, the worktree sandbox, the user's "no"), a hook's BLOCKED
// (an exit 2 from a PreToolUse hook), Claude Code's own "Blocked:" rule, or the auto-mode classifier (a verdict, or none: it was down).
const REFUSED = /^(?:<tool_use_error>)?\s*(?:Permission (?:for|to) [^\n]*(?:denied|rejected)|The user (?:doesn['’]t|does not) want to proceed|The user rejected|The server-side auto mode classifier|Blocked:|This agent is isolated in the worktree|(?:Pre|Post)ToolUse:\S+ hook error|[^\n]*\bauto mode cannot|[^\n]*\bblocked by a deny rule)/i;
const WINDOW = 1000; // only the start of a result is read: the harness's words come first, and a long output is a command's own

/**
 * The class of a failed call, from the result's text (only its first 1,000 characters are read). `denied`: the engine reported a deny.
 * A Bash failure starts "Exit code N": a command that ran, so `exit_code`, whatever it printed (a failing test run is `exit_code`), unless its
 * first line says `unknown_command` (a 127, or "command not found") or `not_found` (ENOENT, "no such file or directory"); `timeout` is Claude Code's
 * own "Command timed out". Only a first line counts, because the same words deep in a test run's output are the run's, not a missing path.
 * ponytail: the match is on Claude Code's current wording, found on the owner's logs; a reworded message reads `other` until a row is added.
 */
export function errorClass(tool: string, text: string, denied = false): ErrorClass {
  if (denied) return 'refused';
  const head = text.slice(0, WINDOW);
  if (REFUSED.test(head)) return 'refused';
  if (/^(?:Exit code \d+\s+)?Command timed out/.test(head)) return 'timeout';
  if (/^Exit code \d+/.test(head)) {
    if (/^Exit code 127\b|^Exit code \d+\n[^\n]*command not found/.test(head)) return 'unknown_command';
    return /^Exit code \d+\n[^\n]*(?:ENOENT|no such file or directory)/i.test(head) ? 'not_found' : 'exit_code'; // `ls`, `cat`, `cd` on a path that is not there
  }
  if (/InputValidationError|No such tool available|does not match (?:the )?required schema/i.test(head)) return 'invalid_input';
  if (/has not been read|must read/i.test(head)) return 'read_first';
  if (/String to replace not found/i.test(head)) return 'no_match';
  if (/ENOENT|does not exist|no such file/i.test(head)) return 'not_found';
  if (/timed? ?out|timeout/i.test(head)) return 'timeout';
  return 'other';
}

// ── Error shape (v0.3 slice 3, #45) ──────────────────────────────────────────
// A copy of errorShape and what it uses in packages/shared/src/classes.ts; contract.spec.ts holds the two to the same tables, so change both together.

const NAMED: [id: string, matches: RegExp][] = [
  ['sleep_blocked', /Blocked: sleep \d+ followed by/],
  ['hook_blocked', /(?:Pre|Post)ToolUse:\S+ hook error/],
  ['wrong_tool_name', /No such tool available/],
  ['gh_projects_classic', /Projects \(classic\)/],
  ['classifier_denied', /denied by the Claude Code auto mode classifier/],
  ['user_rejected', /The user doesn['’]t want to proceed/],
  ['safety_check', /denied by a built-in Claude Code safety check/],
  ['deny_rule', /was blocked by a deny rule/],
  ['outside_worktree', /This agent is isolated in the worktree/],
];
export const MOD_NAMED_SHAPES = NAMED.map(([id]) => id);

/** The first meaningful line of a failure's text (its first 1,000 characters): not empty, not "Exit code N" alone, not tags alone, with its tags dropped. */
export function firstLine(text: string): string | undefined {
  for (const raw of text.slice(0, WINDOW).split('\n')) {
    const line = raw.replace(/<[^>]*>/g, '').trim();
    if (line && !/^Exit code \d+$/.test(line)) return line;
  }
}

const normalized = (line: string) =>
  line
    .replace(/"[^"]*"|(?<!\w)'[^']*'|`[^`]*`/g, 'Q')
    .replace(/[~\w@.-]*(?:\/[\w@.-]+)+/g, 'P')
    .replace(/\b[0-9a-f]{7,}\b/g, 'H')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * What a failed call failed on: the id of a named pattern when the first 1,000 characters of its text match one, else `h:` and 8 hex digits, a hash of the
 * tool, the Bash call's command class and the first meaningful line with its paths, quotes, numbers and hex runs set aside; none for a bare `Exit code 1`.
 * Only this short value is sent, whatever Content is set to.
 */
export function errorShape(tool: string, text: string, command?: CommandClass): string | undefined {
  const head = text.slice(0, WINDOW);
  for (const [id, matches] of NAMED) if (matches.test(head)) return id;
  const line = firstLine(head);
  return line === undefined ? undefined : `h:${fnv1a(`${tool}\n${command ?? ''}\n${normalized(line)}`)}`;
}

// ── Command class ───────────────────────────────────────────────────────────

/**
 * A shell line → its simple commands, each a list of words: cut at an unquoted ; | & ( ) or newline, quotes and comments removed.
 * A heredoc body is dropped unless a shell reads it (`bash <<'EOF'`), when its lines are commands too.
 */
function commands(line: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote = '';
  const heredocs: { delim: string; shell: boolean }[] = [];
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\') {
      if (line[i + 1] === '\n') i++;
      else if (i + 1 < line.length) {
        word += line[++i];
        inWord = true;
      }
    } else if (c === '#' && !inWord) {
      while (i + 1 < line.length && line[i + 1] !== '\n') i++;
    } else if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<' && line[i + 2] !== '(') {
      const m = /^<<-?[ \t]*(['"]?)(\w+)\1/.exec(line.slice(i, i + 100));
      if (m) {
        heredocs.push({ delim: m[2]!, shell: [...words, word].some((w) => /^(?:ba|z)?sh$/.test(w.split('/').at(-1)!)) });
        i += m[0].length - 1;
      } else i++;
    } else if (c === '\n') {
      endCommand();
      for (const h of heredocs.splice(0)) {
        const end = new RegExp(`^[ \\t]*${h.delim}[ \\t]*$`, 'm').exec(line.slice(i + 1));
        const body = line.slice(i + 1, end ? i + 1 + end.index : line.length);
        if (h.shell) out.push(...commands(body));
        i += end ? end.index + end[0].length : body.length;
      }
    } else if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') endCommand();
    else if (c === ' ' || c === '\t') endWord();
    else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return out;
}

const CLASS_RANK: CommandClass[] = ['test', 'build', 'lint', 'install', 'docker', 'gh', 'git', 'other'];
const BEFORE = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'time', 'nohup', 'sudo', 'exec', 'command', 'builtin', 'nice', 'env', 'corepack']);
const WITH_ARG = new Set(['-C', '--dir', '--filter', '-F', '--prefix', '--workspace', '--cwd', '-p', '--package']); // package-manager flags that take a value
const PACKAGE_RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const POSITIONAL_AFTER = new Set(['go', 'cargo', 'deno', 'dotnet', 'mix', 'swift', 'mvn', 'gradle', 'gradlew', 'make', 'just']); // `<tool> test`, `<tool> build`

const positional = (args: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) out.push(a);
    else if (WITH_ARG.has(a)) i++;
  }
  return out;
};

/** A program or a package script, with its arguments, → test, build or lint. A bare command word is a program only: `test -f x` is the shell's. */
function nameClass(name: string | undefined, args: string[], script = true): CommandClass {
  const n = name?.split('/').at(-1);
  if (!n) return 'other';
  if (/^(?:vitest|jest|mocha|pytest|py\.test|ava|cypress|unittest)$/.test(n)) return 'test';
  if (n === 'playwright') return args[0] === 'test' ? 'test' : 'other';
  if (/^(?:tsc|tsup|esbuild|webpack|rollup)$/.test(n)) return 'build';
  if (/^(?:vite|next|nuxt|astro)$/.test(n)) return args[0] === 'build' ? 'build' : 'other';
  if (/^(?:eslint|prettier|stylelint|ruff|biome)$/.test(n)) return 'lint';
  if (!script) return 'other';
  if (n === 'test' || n === 'tests' || n.startsWith('test:')) return 'test';
  if (n === 'build' || n === 'typecheck' || n === 'type-check' || n.startsWith('build:')) return 'build';
  return n === 'lint' || n.startsWith('lint:') ? 'lint' : 'other';
}

const testScript = (path: string | undefined) => path !== undefined && path.length < 300 && /(?:^|\/)(?:test|[^/]*[._-]tests?)(?:[._-][^/]*)?\.\w+$/.test(path); // test.sh, check.test.sh, run-tests.sh

/** One simple command → its class. */
function classOf(words: string[]): CommandClass {
  let i = 0;
  while (i < words.length && (BEFORE.has(words[i]!) || /^[A-Za-z_]\w*=/.test(words[i]!) || /^-|^\d+[smhd]?$/.test(words[i]!))) i++;
  if (words[i] === 'timeout') i += 2; // timeout 120 cmd
  const head = words[i]?.split('/').at(-1);
  const rest = words.slice(i + 1);
  if (!head) return 'other';
  const args = positional(rest);
  if (head === 'git') return 'git';
  if (head === 'gh') return 'gh';
  if (head === 'docker' || head === 'docker-compose' || head === 'podman') return args.slice(0, 3).includes('build') ? 'build' : 'docker';
  if (/^(?:ba|z)?sh$/.test(head)) {
    const c = rest.findIndex((a) => /^-[a-z]*c$/.test(a));
    return c >= 0 && rest[c + 1] !== undefined ? commandClass(rest[c + 1]!) : testScript(args[0]) ? 'test' : 'other';
  }
  if (testScript(words[i])) return 'test'; // ./scripts/test.sh
  if (/^python3?$|^py$/.test(head)) return rest.includes('-m') ? classOf(rest.slice(rest.indexOf('-m') + 1)) : 'other';
  if ((head === 'node' || head === 'bun' || head === 'deno') && rest.includes('--test')) return 'test';
  if (head === 'claude') return args[0] === 'plugin' && args[1] === 'test' ? 'test' : 'other';
  if (head === 'pip' || head === 'pip3' || head === 'uv' || head === 'poetry') return args.slice(0, 2).some((a) => a === 'install' || a === 'add' || a === 'sync') ? 'install' : 'other';
  if (head === 'npx' || head === 'pnpx' || head === 'bunx') return nameClass(args[0], args.slice(1));
  if (PACKAGE_RUNNERS.has(head)) {
    const [sub, ...more] = args;
    if (sub === 'install' || sub === 'i' || sub === 'add' || sub === 'ci') return 'install';
    if (sub === 'run' || sub === 'run-script' || sub === 'exec' || sub === 'dlx' || sub === 'x') return nameClass(more[0], more.slice(1));
    return nameClass(sub, more);
  }
  if (POSITIONAL_AFTER.has(head)) return nameClass(args[0], args.slice(1));
  return nameClass(head, args, false);
}

/**
 * The class of a Bash call, from its command string. A chain is the first of: test, build, lint, install, docker, gh, git
 * (so `pnpm install && pnpm test` is a test run). Only a command's own word counts: the same word in a quoted message, an
 * argument or a file name does not (`git commit -m "pnpm test"` is git, `ls test` is other).
 * ponytail: a naive reading of the shell, no variables or aliases; a script run by name (`./ci.sh`) reads `other`.
 */
export function commandClass(command: string): CommandClass {
  let best = CLASS_RANK.length - 1;
  for (const words of commands(command)) best = Math.min(best, CLASS_RANK.indexOf(classOf(words)));
  return CLASS_RANK[best]!;
}

// ── Changes: the git history of what a change watches (v0.2 slice 1) ─────────

export type Commit = { sha: string; ts: number; subject?: string; files: string[]; blobs: string[] }; // blobs: each file's new blob id, parallel to files (slice 3)
const US = '\x1f';
const HEADER = new RegExp(`^C${US}([0-9a-f]{40,64})${US}(\\d+)${US}(.*)$`);
// `:100644 100644 <old blob> <new blob> M\t<path>`; a rename or copy is `R100\t<old>\t<new>`, and the last path is the file's name now.
const RAW = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*\t(?:[^\t]*\t)?(.+)$/;
const COMMIT_BUDGET = 250_000; // characters of JSON: the server takes 1 MB a request, and a refused event would block the outbox for good

/**
 * `git log` over every ref, oldest first, with the blob ids, over the three places a change watches: the project's agents and skills,
 * and its CLAUDE.md. HEAD's history alone dates a change at the release commit that carried it to the current branch, days late.
 */
export const changesArgv = (root: string) =>
  ['git', '-C', root, 'log', '--all', '--reverse', '--since=90.days', '--format=C%x1f%H%x1f%ct%x1f%s', '--raw', '--no-abbrev', '--', '.claude/agents', '.claude/skills', 'CLAUDE.md'];

/**
 * The commits in `changesArgv`'s output, oldest first: a header line (`C`, hash, committer time, subject), then a raw line per file.
 * A file counts in a commit when its new blob differs from the last one seen for that path (a deletion is the all-zero blob), so a
 * revert is a change; a commit that only repeats a file's current version, as a squash or a release merge does, keeps no files and is
 * dropped. `blobs` is each kept file's new blob id, parallel to `files` (a deletion is the all-zero blob), so a fingerprint (the same
 * blob id from `git hash-object`) can be matched to the commit that made it. At most 500 commits, 50 files each, 200 characters of subject,
 * and 250 KB of JSON in all; the oldest go first.
 * `subjects: false` (an excluded project) leaves the subject line out.
 * ponytail: git quotes a path with unusual characters, and the quoted form is sent as it came. Two branches interleaving edits to one
 * file can make a release copy look new: the file's last version is then the other branch's, not the one the copy repeats.
 */
export function parseChanges(stdout: string, subjects = true): Commit[] {
  const commits: Commit[] = [];
  const last = new Map<string, string>(); // path -> the blob last seen for it
  let current: Commit | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const h = HEADER.exec(line);
    if (h) {
      const ts = Number(h[2]) * 1000;
      current = ts > 0 ? { sha: h[1]!.slice(0, 40), ts, ...(subjects && h[3] ? { subject: h[3].slice(0, 200) } : {}), files: [], blobs: [] } : undefined;
      if (current) commits.push(current);
      continue;
    }
    const f = RAW.exec(line);
    if (!f || !current) continue;
    if (last.get(f[2]!) === f[1]) continue;
    last.set(f[2]!, f[1]!);
    if (current.files.length < 50) (current.files.push(f[2]!), current.blobs.push(f[1]!));
  }
  let size = 0;
  return commits.filter((c) => c.files.length).slice(-500).reverse().filter((c) => (size += JSON.stringify(c).length + 1) <= COMMIT_BUDGET).reverse();
}

// ── Fingerprints: what a change watches, as the files are now (v0.2 slice 3) ──

export type FpFile = { abs: string; path: string; scope: 'project' | 'user' };
export type Fingerprint = { path: string; hash: string; scope: 'project' | 'user' };
/** What `$.fs` gives the listing: a directory's entries, and whether a path exists. */
export type FpFs = { list: (dir: string) => Promise<{ name: string; kind: 'file' | 'dir' | 'other' }[]>; exists: (path: string) => Promise<boolean> };
const FP_PROJECT_MAX = 500; // files under .claude/agents and .claude/skills
const FP_RULES_MAX = 100; // the project's 501 and the owner's 101 stay under the 1000 the event takes
const FP_PATH_MAX = 300; // a path travels in the event, and the event must fit the server's 1 MB request
const bySortedName = <T extends { name: string }>(entries: T[]) => [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
// Hidden files change by themselves (.DS_Store, whenever Finder looks), node_modules is not a skill, and `git hash-object --stdin-paths` reads one path per line.
const skipped = (name: string) => name.startsWith('.') || name === 'node_modules' || name.includes('\n');

async function walk(fs: FpFs, abs: string, rel: string, out: FpFile[], cap: number): Promise<void> {
  const entries = await fs.list(abs).catch(() => []); // a folder that is missing, or cannot be read, has no files
  for (const e of bySortedName(entries)) {
    if (out.length >= cap) return;
    if (skipped(e.name) || `${rel}/${e.name}`.length > FP_PATH_MAX) continue;
    if (e.kind === 'dir') await walk(fs, `${abs}/${e.name}`, `${rel}/${e.name}`, out, cap);
    else if (e.kind === 'file') out.push({ abs: `${abs}/${e.name}`, path: `${rel}/${e.name}`, scope: 'project' });
  }
}

/**
 * The files a change watches (PROJECT.md §15, 2026-10-24): every file under the project's `.claude/agents` and `.claude/skills`
 * (at most 500, the first by path) and its CLAUDE.md, scope `project` with project-relative paths; then the owner's `~/.claude/CLAUDE.md`
 * and `~/.claude/rules/*.md` (at most 100), scope `user`, written `~/.claude/...`. `home` undefined leaves the owner's files out.
 * ponytail: a symbolic link is not followed (a linked skill folder or rules file is not listed); `fs.stat(path, { resolve: true })`
 * and a visited set of real paths would follow them. Past the 500 cap the files that sort last are not watched, and one that a new
 * file pushes past the cap reads as deleted.
 */
export async function fingerprintFiles(root: string, home: string | undefined, fs: FpFs): Promise<FpFile[]> {
  const project: FpFile[] = [];
  for (const dir of ['.claude/agents', '.claude/skills']) await walk(fs, `${root}/${dir}`, dir, project, FP_PROJECT_MAX);
  if (await fs.exists(`${root}/CLAUDE.md`).catch(() => false)) project.push({ abs: `${root}/CLAUDE.md`, path: 'CLAUDE.md', scope: 'project' });
  const user: FpFile[] = [];
  if (home) {
    const own = (name: string): FpFile => ({ abs: `${home}/.claude/${name}`, path: `~/.claude/${name}`, scope: 'user' });
    if (await fs.exists(`${home}/.claude/CLAUDE.md`).catch(() => false)) user.push(own('CLAUDE.md'));
    const rules = (await fs.list(`${home}/.claude/rules`).catch(() => [])).filter((e) => e.kind === 'file' && e.name.endsWith('.md') && !skipped(e.name));
    user.push(...bySortedName(rules).slice(0, FP_RULES_MAX).map((e) => own(`rules/${e.name}`)));
  }
  return [...project, ...user];
}

/** The blob ids `git hash-object --stdin-paths` printed, one line per path in the order sent; nothing unless every line is one. */
export function fingerprintsFrom(files: FpFile[], stdout: string): Fingerprint[] {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  if (!files.length || lines.length !== files.length || !lines.every((l) => /^[0-9a-f]{40,64}$/.test(l))) return [];
  return files.map((f, i) => ({ path: f.path, hash: lines[i]!, scope: f.scope }));
}

// ── Worth: the merged PRs and the PR links (v0.3 slice 2, #42, PROJECT.md §15, 2026-10-25) ──────────────

export type Pr = { number: number; title?: string; merged_at: number; additions: number; deletions: number; head?: string; counted_lines?: number; counted_files?: number };
const PRS_DAYS = 90;
const PRS_MAX = 500;
const PRS_BUDGET = 250_000; // characters of JSON, as COMMIT_BUDGET: the server takes 1 MB a request, and a refused event would block the outbox for good

/** `gh pr list` for the PRs merged in the past 90 days (a UTC date), at most 500, with the fields the event carries. `now` is epoch ms. */
export const prsArgv = (now: number) => [
  'gh', 'pr', 'list', '--state', 'merged', '--search', `merged:>=${new Date(now - PRS_DAYS * 86_400_000).toISOString().slice(0, 10)}`,
  '--limit', String(PRS_MAX), '--json', 'number,title,mergedAt,additions,deletions,headRefName,files',
];

const lines = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : 0);

/**
 * The files a PR's size does not count (#103): lockfiles, images, build output (`dist/`, `build/`, `coverage/`), minified files and source maps, and generated files
 * (`*.generated.*`, `__generated__/`, and `*.snap`, which a test run writes). A path is judged by its name alone, never by what is in the file.
 * ponytail: by path, so a generated file under a name nothing here knows counts in full, and a hand-written file under `build/` or `dist/` is left out. Upgrade path:
 * `git check-attr linguist-generated` over the paths (the repo's own marks), or a list in the project's settings. Images include `.svg`, which is text but an asset.
 */
const UNCOUNTED = new RegExp([
  '(^|/)(dist|build|coverage|__generated__)/',
  '\\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|heic|svg|map|snap)$',
  '\\.min\\.[^/]+$',
  '\\.generated\\.[^/]*$',
  '(^|/)([^/]*\\.lock|pnpm-lock\\.yaml|package-lock\\.json|npm-shrinkwrap\\.json|bun\\.lockb|go\\.sum|packages\\.lock\\.json|gradle\\.lockfile)$',
].join('|'), 'i');

/**
 * The lines (additions + deletions) and files left in a PR once `UNCOUNTED` is set aside, from gh's `files` (`{ path, additions, deletions }`). Nothing when gh gave no usable
 * list, or an empty one for a PR that changed lines (gh did not say which files), because a guess would size it wrongly; a PR that changed nothing is 0 and 0.
 * ponytail: gh lists at most 100 files a PR (measured on two real repos: 3 of 200 PRs hit it), so a larger PR counts the first 100, a floor; it is XL either way.
 */
function counted(files: unknown, changed: number): { counted_lines: number; counted_files: number } | undefined {
  if (!Array.isArray(files) || (files.length === 0 && changed > 0)) return undefined;
  let total = 0;
  let n = 0;
  for (const f of files as Record<string, unknown>[]) {
    if (typeof f?.path !== 'string' || UNCOUNTED.test(f.path)) continue;
    n++;
    total += lines(f.additions) + lines(f.deletions);
  }
  return { counted_lines: total, counted_files: n };
}

/**
 * The PRs in `prsArgv`'s output, newest merge first, as the event carries them: `merged_at` in ms, a title and a branch cut at 200 characters.
 * Anything that is not gh's list (no gh, a login prompt, an error body) gives none, and an entry the schema would refuse is repaired (lines that
 * are not counts read 0) or left out, because one refused event drops the whole batch. `text: false` (an excluded project) leaves the title and
 * the branch out. At most 500, and 250 KB of JSON in all; the oldest go first.
 * A PR also carries `counted_lines` and `counted_files` (see `counted`): its files reach the event as those two numbers, never a path.
 * ponytail: nothing but gh's own fields is read, so a PR's body and author never reach an event.
 */
export function parsePrs(stdout: string, text = true): Pr[] {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const words = (x: unknown) => (text && typeof x === 'string' && x ? x.slice(0, 200) : undefined);
  const prs: Pr[] = [];
  for (const p of list as Record<string, unknown>[]) {
    const merged = typeof p?.mergedAt === 'string' ? Date.parse(p.mergedAt) : NaN;
    if (typeof p?.number !== 'number' || !Number.isInteger(p.number) || p.number < 1 || !(merged > 0)) continue;
    const title = words(p.title);
    const head = words(p.headRefName);
    const additions = lines(p.additions);
    const deletions = lines(p.deletions);
    prs.push({ number: p.number, ...(title ? { title } : {}), merged_at: merged, additions, deletions, ...(head ? { head } : {}), ...counted(p.files, additions + deletions) });
  }
  let size = 0;
  return prs.sort((a, b) => b.merged_at - a.merged_at || b.number - a.number).slice(0, PRS_MAX).filter((p) => (size += JSON.stringify(p).length + 1) <= PRS_BUDGET);
}

/**
 * The numbers of this repository's pull requests a tool's output names as `https://<remote>/pull/<n>` (the remote as the event carries it,
 * `github.com/owner/repo`), once each, in the order they appear. Another repository, a `pull/new/<branch>` page and a lookalike name are not.
 * ponytail: a regex over text the plugin already holds, linear in it; the caller reads Bash and MCP output only, because a file or a web page
 * read can mention any PR (a changelog names dozens) and a session that read it did not open them.
 */
export function prNumbersIn(text: string, remote: string | undefined): number[] {
  if (!remote) return [];
  const found = new Set<number>();
  for (const m of text.matchAll(new RegExp(`https?://${esc(remote)}/pull/(\\d{1,9})\\b`, 'gi'))) {
    const n = Number(m[1]);
    if (n > 0) found.add(n);
  }
  return [...found];
}

// ── The monthly goal (v0.2 slice 3, PROJECT.md §15, 2026-10-24) ──────────────

/** The project's goal for a month, in API-equivalent dollars, and what it has spent so far: the server's GET /api/goal. */
export type Goal = { project: string; month: string; goal: number; spent: number };
export type GoalSent = { at80?: true; over?: true };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
/** Whole dollars with thousands separators, by hand: the text must not depend on the runtime's locale. */
export const usd = (n: number) => `$${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const atLeast80 = (g: Goal) => g.spent * 5 >= g.goal * 4; // no 0.8 * goal: 0.8 * 3 is 2.4000000000000004
const isOver = (g: Goal) => g.spent > g.goal; // ponytail: by cents, so $2,500.40 of $2,500 reads "$2,500 of $2,500": whole dollars are for reading, not for deciding
const percent = (g: Goal) => Math.round((100 * g.spent) / g.goal);

/**
 * The server's answer to GET /api/goal: `{ goal: Goal }`, `{ goal: null }` when the project has none (that clears the last answer), or
 * nothing when the text is not that answer at all (the last answer stays).
 */
export function parseGoal(project: string, text: string): { goal: Goal | null } | undefined {
  let body: Record<string, unknown> | null;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== 'object' || typeof body.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month)) return undefined;
  if (body.goal === null) return { goal: null };
  const { goal, spent } = body;
  return typeof goal === 'number' && Number.isFinite(goal) && goal > 0 && typeof spent === 'number' && Number.isFinite(spent) && spent >= 0
    ? { goal: { project, month: body.month, goal, spent } } : undefined;
}

/**
 * The notification a goal answer earns, given what was sent already this month: one at 80% and one past 100%, each once. First seen
 * already past 100%, only the second is sent, and the first counts as sent.
 * ponytail: the answer is exact dollars against the goal; a goal edited mid-month keeps what was sent, so raising it re-sends nothing.
 */
export function goalNotice(g: Goal, sent: GoalSent): { text?: string; sent: GoalSent } {
  const month = monthName(g.month);
  if (isOver(g)) return sent.over ? { sent } : { text: `${g.project} is over its ${month} goal: ${usd(g.spent)} of ${usd(g.goal)}`, sent: { at80: true, over: true } };
  if (atLeast80(g) && !sent.at80) return { text: `${g.project} is at ${percent(g)}% of its ${month} goal (${usd(g.spent)} of ${usd(g.goal)})`, sent: { ...sent, at80: true } };
  return { sent };
}

// ── Live tracking, for the stall alert and the status line ───────────────────

/** v0.2 slice 2: an agent on a pricier model than it should be (see modelCheck): who it is called, what it runs on, and what it is held to. */
export type Pricier = { who: string; used: Family; allowed: Family; source: 'file' | 'ceiling' };
export type AgentLive = { key: string; label: string; inTurn: boolean; lastTs: number; done: boolean; tokens: number; pricier?: Pricier };
export type ToolLive = { id: string; tool: string; agent: string; since: number; waiting: boolean };
export type Stall = { key: string; agent: string; tool_use_id?: string; tool?: string; since: number };
export type Tracker = { agents: Map<string, AgentLive>; tools: Map<string, ToolLive>; stalled: Map<string, Stall> };
export const newTracker = (): Tracker => ({ agents: new Map(), tools: new Map(), stalled: new Map() });

/**
 * §13: a tool running past the threshold, or an agent mid-turn with no tool running and no event, is stalled.
 * A tool at the permission prompt, and an agent between turns, wait for the person and never stall.
 */
export function checkStalls(t: Tracker, now: number, thresholdMs: number) {
  const current = new Map<string, Stall>();
  for (const tool of t.tools.values()) {
    if (!tool.waiting && now - tool.since >= thresholdMs) {
      current.set(tool.id, { key: tool.id, agent: tool.agent, tool_use_id: tool.id, tool: tool.tool, since: tool.since });
    }
  }
  const busy = new Set([...t.tools.values()].map((x) => x.agent));
  for (const a of t.agents.values()) {
    if (a.inTurn && !a.done && !busy.has(a.key) && now - a.lastTs >= thresholdMs) {
      current.set(`agent:${a.key}`, { key: `agent:${a.key}`, agent: a.key, since: a.lastTs });
    }
  }
  const started = [...current.values()].filter((s) => !t.stalled.has(s.key));
  const ended = [...t.stalled.values()].filter((s) => !current.has(s.key));
  t.stalled = current;
  return { started, ended };
}

export const fmtTokens = (n: number) =>
  n >= 999_500 ? `${(n / 1e6).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);

/**
 * §8.5: `👥 3 · 412k tok · ctx 61%`; the oldest stall, else (v0.2 slice 2) the oldest running agent on a pricier model, else (slice 3)
 * the project past its month's goal, instead. From 80% of the goal the normal line ends with ` · Oct 81%`.
 */
export function statusText(t: Tracker, ctxPercent: number | undefined, now: number, goal?: Goal) {
  const oldest = [...t.stalled.values()].sort((a, b) => a.since - b.since)[0];
  if (oldest) {
    const label = t.agents.get(oldest.agent)?.label ?? oldest.agent;
    return `⚠ ${label}: ${oldest.tool ?? 'no events'} ${Math.floor((now - oldest.since) / 60_000)}m`;
  }
  const agents = [...t.agents.values()];
  const p = agents.find((a) => a.pricier && !a.done)?.pricier; // the map keeps the order agents appeared in: the oldest first
  if (p) return `⚠ ${p.who} on ${familyName(p.used)}, ${p.source === 'file' ? 'file says' : 'ceiling'} ${familyName(p.allowed)}`;
  if (goal && isOver(goal)) return `⚠ ${goal.project} over its ${monthName(goal.month)} goal: ${usd(goal.spent)} of ${usd(goal.goal)}`;
  const active = agents.filter((a) => !a.done).length;
  const tokens = agents.reduce((sum, a) => sum + a.tokens, 0);
  return `👥 ${active} · ${fmtTokens(tokens)} tok${ctxPercent === undefined ? '' : ` · ctx ${Math.round(ctxPercent)}%`}${goal && atLeast80(goal) ? ` · ${monthName(goal.month).slice(0, 3)} ${percent(goal)}%` : ''}`;
}

// ── Event builders: one per §5 kind the mod sends; the Vitest contract test runs each through the shared schema ──

export const VERSION = '0.3.1';
// The server's ROLES (packages/shared), kept here so the plugin needs no import; a contract test keeps the two equal.
export const MOD_ROLES = ['orchestrator', 'developer', 'researcher', 'reviewer', 'skeptic', 'tester', 'planner', 'writer', 'ops', 'consultant', 'generalist'] as const;
export type Role = (typeof MOD_ROLES)[number];
const ROLE_SET = new Set<string>(MOD_ROLES);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const firstAt = (text: string, patterns: RegExp[]) => Math.min(...patterns.map((re) => text.search(re)).filter((i) => i >= 0));

/**
 * The skills and agent types a skill's or agent's text names (Slice 5), from the session's own lists only, so a path
 * like /lib never counts. A skill counts as /name, "the name skill", `name` skill or Skill("name"); an agent type as a
 * whole word. In the order first seen, each once, never `self`.
 */
export function refsIn(text: string, names: { skills: string[]; agents: string[] }, self?: string) {
  const found = (list: string[], patterns: (n: string) => RegExp[]) =>
    list.filter((n) => n !== self).map((n) => ({ n, at: firstAt(text, patterns(esc(n))) })).filter((x) => x.at !== Infinity)
      .sort((x, y) => x.at - y.at).map((x) => x.n);
  return {
    skills: found(names.skills, (n) => [
      new RegExp(`(?<![\\w/.-])/${n}(?![\\w/-])`), new RegExp(`\\b[Tt]he ${n} skill\\b`), new RegExp(`\`${n}\` skill\\b`),
      new RegExp(`Skill\\(\\s*["']?${n}(?![\\w:-])`), new RegExp(`\\bskill:\\s*["']?${n}(?![\\w:-])`),
    ]),
    agents: found(names.agents, (n) => [new RegExp(`(?<![\\w-])${n}(?![\\w-])`)]),
  };
}

/** An agent definition's `description:` (issue #8), plain, quoted or a folded block; nothing when the frontmatter has none. */
export function descriptionOf(text: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!front) return undefined;
  const lines = front.split(/\r?\n/);
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return undefined;
  const v = lines[i]!.slice('description:'.length).trim();
  const block = /^[>|][-+]?$/.test(v)
    ? lines.slice(i + 1).filter((_, j, all) => all.slice(0, j + 1).every((l) => /^\s+\S/.test(l))).map((l) => l.trim()).join(' ')
    : v.replace(/^["']|["']$/g, '');
  return block || undefined;
}

/** An agent definition's `skills:` list (preloaded before its first turn), block or inline. */
export function preloadOf(text: string): string[] {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const m = /^skills:[ \t]*(.*)$/m.exec(front);
  if (!m) return [];
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');
  if (m[1]!.trim().startsWith('[')) return m[1]!.replace(/^\s*\[|\]\s*$/g, '').split(',').map(unquote).filter(Boolean);
  const rest = front.slice(m.index + m[0].length).split(/\r?\n/).slice(1);
  const items: string[] = [];
  for (const line of rest) {
    const item = /^\s+-\s*(.+)$/.exec(line);
    if (!item) break;
    items.push(unquote(item[1]!));
  }
  return items;
}

/** `orb-role` from an agent definition's frontmatter, if it names a §7 role. */
export function roleFromFrontmatter(text: string): Role | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const role = front && /^orb-role:\s*["']?([a-z]+)["']?\s*$/m.exec(front)?.[1];
  return role && ROLE_SET.has(role) ? (role as Role) : undefined;
}

// ── The model check (v0.2 slice 2, PROJECT.md §15, 2026-10-24) ───────────────

/** An agent file's `model:` as written (`sonnet`, `claude-opus-4-8[1m]`, `inherit`), from the frontmatter only. */
export function modelFromFrontmatter(text: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  return (front && /^model:\s*["']?([^\s"']+)["']?\s*(?:#.*)?$/m.exec(front)?.[1]) || undefined;
}

// The server's MODEL_FAMILIES (packages/shared), kept here so the plugin needs no import; a contract test keeps the two equal.
export const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable', 'mythos'] as const;
export type Family = (typeof FAMILIES)[number];
// ponytail: family rank, not exact price: Opus 4.8 against Opus 5.5 is no difference here, and Fable and Mythos rank alike.
const RANK: Record<Family, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4, mythos: 4 };
export const familyName = (f: Family) => `${f[0]!.toUpperCase()}${f.slice(1)}`;

/** The family of an alias (`opus`) or a full id (`claude-sonnet-5-5`, `claude-opus-4-8[1m]`); nothing for `inherit` or a model it does not know. */
export const familyOf = (model: string | undefined): Family | undefined =>
  FAMILIES.find((f) => new RegExp(`(?<![a-z])${f}(?![a-z])`).test(model?.toLowerCase() ?? ''));

/**
 * Whether the model an agent runs on ranks above what it should: its file's `model:`, or, for an agent with no file model
 * (none, or `inherit`), the ceiling (`off` turns that part off). Nothing for a family it does not know, on either side.
 */
export function modelCheck({ model, declared, ceiling }: { model: string; declared: string | undefined; ceiling: string }): { allowed: Family; source: 'file' | 'ceiling' } | undefined {
  const fromFile = declared !== undefined && declared.toLowerCase() !== 'inherit';
  const allowed = familyOf(fromFile ? declared : ceiling);
  const used = familyOf(model);
  return allowed && used && RANK[used] > RANK[allowed] ? { allowed, source: fromFile ? 'file' : 'ceiling' } : undefined;
}

/** The one notification when an agent first runs on a pricier model; a workflow agent with no file has no name worth saying. */
export const pricierNotice = (p: Pricier) =>
  `${p.who === 'workflow agent' ? 'a workflow agent' : p.who} runs on ${familyName(p.used)}; ${p.source === 'file' ? 'its file says' : 'agents with no file are held to'} ${familyName(p.allowed)}`;

type Who = { agentId?: string; turnId?: string };
export type Refs = { skills: string[]; agents: string[] };
export type SkillLoad = { skill: string; how: 'typed' | 'tool' | 'preload'; plugin?: string; toolUseId?: string; source?: string; description?: string; refs?: Refs };
export type CatalogSkill = { name: string; source: string; plugin?: string; tokens: number; description?: string; refs?: Refs };
export type CatalogAgent = { name: string; source: string; tokens: number; description?: string; refs?: Refs; preload?: string[] };
export type ContentMode = 'off' | 'full' | 'excluded';
/** The keys whose value is set: content fields are left out, not sent empty, when content is off. */
const defined = (o: Record<string, string | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
const who = ({ agentId, turnId }: Who) => ({ agent_id: agentId, turn_id: turnId });

export const build = {
  sessionStart: (c: Ctx, model: string, claudeVersion: string, interactive: boolean, content: ContentMode = 'off') =>
    makeEvent(c, 'session.start', { model, source: interactive ? 'interactive' : 'headless', claude_version: claudeVersion, plugin_version: VERSION, content }),
  sessionEnd: (c: Ctx, reason: string) => makeEvent(c, 'session.end', { reason }),
  sessionCompact: (c: Ctx, before: number, after: number) => makeEvent(c, 'session.compact', { tokens_before: before, tokens_after: after }),
  prompt: (c: Ctx, length: number, promptId: string, text?: string) =>
    makeEvent(c, 'prompt.submit', { length, ...(text === undefined ? {} : { text }) }, { prompt_id: promptId }),
  turnStart: (c: Ctx, w: Who & { turnId: string }, promptId?: string) => makeEvent(c, 'turn.start', {}, { ...who(w), prompt_id: promptId }),
  turnStep: (c: Ctx, w: Who & { turnId: string }, model: string, usage: ApiUsage | null, stopReason: string | null, text: { answer?: string; thinking?: string } = {}) =>
    makeEvent(c, 'turn.step', { model, usage: usageOf(usage), stop_reason: stopReason, tool_use_ids: [], ...defined(text) }, who(w)),
  turnComplete: (c: Ctx, w: Who & { turnId: string }, durationMs: number, usage: ApiUsage | null | undefined, reason: string, answerLength: number, contextPercent?: number) =>
    makeEvent(c, 'turn.complete', {
      duration_ms: durationMs, usage_total: usageOf(usage), reason, answer_length: answerLength,
      ...(contextPercent === undefined ? {} : { context_percent: Math.min(100, Math.max(0, contextPercent)) }),
    }, who(w)),
  agentSpawn: (c: Ctx, a: { agentId: string; parentAgentId?: string; toolUseId: string; type: string; description: string; model: string; promptLength: number; declaredRole?: Role; declaredModel?: string; modelCheck?: { allowed: Family; source: 'file' | 'ceiling' }; prompt?: string }) =>
    makeEvent(c, 'agent.spawn', {
      tool_use_id: a.toolUseId, agent_type: a.type, description: a.description, model: a.model, prompt_length: a.promptLength,
      ...(a.declaredRole ? { declared_role: a.declaredRole } : {}), ...defined({ declared_model: a.declaredModel, prompt: a.prompt }),
      ...(a.modelCheck ? { model_check: a.modelCheck } : {}),
    }, { agent_id: a.agentId, parent_agent_id: a.parentAgentId }),
  agentComplete: (c: Ctx, agentId: string, durationMs: number, usage: ReturnType<typeof usageOf>, reportLength: number) =>
    makeEvent(c, 'agent.complete', { duration_ms: durationMs, usage_total: usage, report_length: reportLength }, { agent_id: agentId }),
  toolCall: (c: Ctx, w: Who, toolUseId: string, tool: string, inputSize: number, input?: string, commandClass?: CommandClass) =>
    makeEvent(c, 'tool.call', { tool_use_id: toolUseId, tool, input_size: inputSize, ...defined({ input }), ...(commandClass ? { command_class: commandClass } : {}) }, who(w)),
  toolResult: (c: Ctx, w: Who, r: { toolUseId: string; success: boolean; errorType?: string; errorClass?: ErrorClass; errorShape?: string; durationMs: number; outputSize: number; files: ReturnType<typeof filesTouched>; output?: string; outputSkipped?: 'env-file' }) =>
    makeEvent(c, 'tool.result', {
      tool_use_id: r.toolUseId, success: r.success, ...(r.errorType ? { error_type: r.errorType } : {}), ...(r.errorClass ? { error_class: r.errorClass } : {}),
      ...(r.errorShape ? { error_shape: r.errorShape } : {}), duration_ms: r.durationMs, output_size: r.outputSize, files_touched: r.files, ...defined({ output: r.output, output_skipped: r.outputSkipped }),
    }, who(w)),
  toolWaiting: (c: Ctx, w: Who, toolUseId: string, tool: string) => makeEvent(c, 'tool.waiting', { tool_use_id: toolUseId, tool }, who(w)),
  skillLoad: (c: Ctx, w: Who, s: SkillLoad) =>
    makeEvent(c, 'skill.load', {
      skill: s.skill, how: s.how, ...defined({ plugin: s.plugin, tool_use_id: s.toolUseId, source: s.source, description: s.description }),
      ...(s.refs ? { refs: s.refs } : {}),
    }, who(w)),
  projectChanges: (c: Ctx, commits: Commit[]) => makeEvent(c, 'project.changes', { commits }),
  projectFingerprint: (c: Ctx, files: Fingerprint[]) => makeEvent(c, 'project.fingerprint', { files }),
  projectPrs: (c: Ctx, prs: Pr[]) => makeEvent(c, 'project.prs', { prs }),
  sessionPr: (c: Ctx, number: number) => makeEvent(c, 'session.pr', { number }), // the session's, not an agent's: no agent_id, no turn_id
  skillsCatalog: (c: Ctx, skills: CatalogSkill[], agents: CatalogAgent[]) => makeEvent(c, 'skills.catalog', { skills, agents }),
  stall: (c: Ctx, edge: 'start' | 'end', s: Stall) =>
    makeEvent(c, `stall.${edge}`, { ...(s.tool_use_id ? { tool_use_id: s.tool_use_id, tool: s.tool } : {}), since: s.since }, { agent_id: s.agent === 'main' ? undefined : s.agent }),
  dropped: (c: Ctx, count: number, since: number) => makeEvent(c, 'outbox.dropped', { count, since }),
  task: (c: Ctx, w: Who, edge: 'create' | 'complete', taskId: string, subject: string, status: string) =>
    makeEvent(c, `task.${edge}`, { task_id: taskId, subject, status }, who(w)),
};

/** `claude-opus-5-5` → `Opus 5.5`; anything else as given. */
export const modelLabel = (id: string) => {
  const m = /claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : id;
};

// ── Content capture (§15, 2026-10-20) ────────────────────────────────────────

/** Same rule as the server's capText (shared/src/event.ts): start 3/4, end 1/4, a marker between. */
export function capText(s: string, max = 32_768): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${s.slice(0, head)}\n[… ${(s.length - head - tail).toLocaleString('en')} characters cut …]\n${s.slice(-tail)}`;
}

const R = '[REDACTED]';
// A name is a secret only when it ENDS in one of these words. `_`, `-` and a lower-to-upper step (camelCase) end a word, so token,
// auth_token, apiKey and GITHUB_TOKEN are secrets and max_tokens (a count), keyboard and monkey are not. No `i` flag: case marks the break.
const WORDS = ['token', 'secret', 'password', 'passwd', 'apikey', 'auth', 'credential', 'key'];
const W_LOW = WORDS.join('|');
const W_UP = W_LOW.toUpperCase();
const W_CAP = WORDS.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('|');
const SECRET_NAME = `[A-Za-z0-9_-]*(?:(?<![A-Za-z0-9])(?:${W_LOW}|${W_UP}|${W_CAP})|(?<=[a-z0-9])(?:${W_UP}|${W_CAP})|(?<=[A-Z])(?:${W_CAP}))`;
// ponytail: mask() runs on captured tool output, so every pattern is linear in the input: a start is anchored at a run's first
// character (lookbehind) or its scan is bounded, and no two quantifiers share a character class. Keep it so when adding one.
// Issue #63: a CLI flag's value is quoted, quoted-and-escaped (a tool input is JSON-stringified before it is masked) or one word.
const VALUE = /\\?"[^"]*"|'[^']*'|(?!-)[^\s"',;]+/.source;
const FLAG = '(?:password|passwd|passphrase|secret|token|api-?key|access-?token|auth-?token|client-?secret|secret-?key|cookie)';
// ponytail: patterns for the common key formats and secret-looking names; an unusual secret can still pass,
// so content stays opt-in and excludeProjects keeps client repos out entirely. Shapes that are also ordinary text are
// held to a context that says "secret" (a keyword before a long hex run, a mysql or 7z command before -p) rather than
// masked everywhere: a commit SHA, a UUID and a lockfile hash must stay readable. Ceilings: a bare hex token with no
// word beside it passes (it is a SHA to us), and a 40-character mixed-case run with a digit reads as an AWS secret.
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, R], // no END line: a key cut short, so the rest goes
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, R],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, R],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/(?<![A-Za-z0-9/+_-])(?=[A-Za-z0-9/+]{0,39}[A-Z])(?=[A-Za-z0-9/+]{0,39}[a-z])(?=[A-Za-z0-9/+]{0,39}\d)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=_-])/g, R],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, R],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, R],
  [/(\bhooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9/_-]+/g, `$1${R}`],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, R],
  [/\bAIza[0-9A-Za-z_-]{35,}/g, R],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, R],
  [/(\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic|Token)\s+)[^\s"']+/gi, `$1${R}`],
  [/(\b(?:X-[A-Za-z-]{0,40}(?:Api-?Key|Auth-?Token|Access-?Token|Token|Secret)|Api-?Key)\s*:\s*)[^\s"'\\]+/gi, `$1${R}`],
  [/(\bCookie\s*:\s*)[^\n"'\\]+/gi, `$1${R}`], // also Set-Cookie: \b sits between the two words
  [new RegExp(`(--${FLAG}(?:=|\\s+))(?:${VALUE})`, 'gi'), `$1${R}`],
  // -pPASSWORD, attached, is a password for these commands only: elsewhere it is a port or a compiler flag (-p8080:80, -pthread)
  [new RegExp(`(\\b(?:mysql\\w{0,30}\\b|mariadb[\\w-]{0,30}(?![\\w-])|7z\\w?\\b|(?:un)?rar\\b)[^\\n|;&]{0,200}?\\s-p)(?:${VALUE})`, 'g'), `$1${R}`], // no 'i': -P is the port
  [/(\b(?:secret|token|password|passwd|api[ _-]?key|auth|credential|bearer)s?(?:\s+is)?[\s:="'\\]{1,6})[0-9a-f]{32,}\b/gi, `$1${R}`],
  // curl -u / --user USER:PASSWORD (the user stays), quoted, quoted-and-escaped or one word; clustered flags (-sSu) pass
  [new RegExp(String.raw`(\bcurl\b[^\n|;&]{0,200}?\s(?:-u\s*|--user(?:=|\s+)))(?:(\\?"[^":\\]*:)[^"\\]*|('[^':]*:)[^']*|([^\s:"'\\]*:)[^\s"']+)`, 'g'), `$1$2$3$4${R}`],
  // sshpass -p PASSWORD, only as sshpass's own option: after -f/-d/-P/-e/-v, never the ssh -p (a port) that follows
  [new RegExp(String.raw`(\bsshpass\s+(?:-[fdP]\s+\S+\s+|-[ev]\s+)*-p\s*)(?:${VALUE})`, 'g'), `$1${R}`],
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^:/\s@]+:)[^@\s/]+(@)/gi, `$1${R}$2`],
  [new RegExp(`("(?:${SECRET_NAME}|[Cc]ookie|COOKIE)"\\s*:\\s*)"[^"]*"`, 'g'), `$1"${R}"`],
  // a value of only digits is never a secret (key=1, auth=0); what the lookahead rejects stays as it is, and the scan moves on
  [new RegExp(`(?<![A-Za-z0-9_-])(${SECRET_NAME})(\\s*[=:]\\s*)(?!\\[REDACTED\\]|\\d+(?![^\\s"',;])|"\\d+"|'\\d+')("[^"]*"|'[^']*'|[^\\s"',;]+)`, 'g'), `$1=${R}`],
];

export const mask = (s: string) => SECRETS.reduce((text, [re, to]) => text.replace(re, to), s);

export const isEnvFile = (path: unknown) => typeof path === 'string' && /(^|\/)\.env(\.[^/]+)?$/.test(path);

/** excludeProjects: comma-separated repo names, remotes (host/owner/repo or owner/repo) or paths. */
export function isExcluded(project: Ctx['project'], list: string) {
  return list.split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean).some((entry) =>
    entry === project.name
    || (project.git_remote && (entry === project.git_remote || project.git_remote.endsWith(`/${entry}`) && entry.includes('/')))
    || (entry.startsWith('/') && (project.cwd === entry || project.cwd.startsWith(`${entry}/`))));
}

const ENV_FIELDS = ['content', 'old_string', 'new_string', 'new_source', 'edits'];
/** A tool call's input (without the envelope) and output, masked and capped; a .env file's contents never go. */
export function toolContent(tool: string, input: Record<string, unknown>, output: string | undefined) {
  const env = isEnvFile(input.file_path ?? input.notebook_path);
  const shown = env ? Object.fromEntries(Object.entries(input).map(([k, v]) => [k, ENV_FIELDS.includes(k) ? '[contents not sent]' : v])) : input;
  const out: { input?: string; output?: string; output_skipped?: 'env-file' } = { input: capText(mask(JSON.stringify(shown))) };
  if (env && tool === 'Read') out.output_skipped = 'env-file';
  else if (output !== undefined) out.output = capText(mask(output));
  return out;
}
