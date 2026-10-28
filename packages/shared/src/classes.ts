// v0.3 slice 1 (#43, PROJECT.md §5): a short class for every failed tool call and for every Bash call, worked out where the text is
// (the plugin, the import) so that only the class travels: it works with Content off and no tool text leaves the machine.
// v0.3 slice 3 (#45) adds the error shape: a named pattern or a short hash of a failure's first line, the same way.
// Pure functions with no imports. The plugin keeps a copy of errorClass and commandClass, and what they use, in packages/mod/hooks/core.ts
// (it imports nothing from here); packages/mod/test/contract.spec.ts holds the two to the same tables, so change both together.

export const ERROR_CLASSES = ['not_found', 'no_match', 'exit_code', 'timeout', 'refused', 'read_first', 'invalid_input', 'unknown_command', 'other'] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];
export const COMMAND_CLASSES = ['test', 'build', 'lint', 'git', 'gh', 'docker', 'install', 'other'] as const;
export type CommandClass = (typeof COMMAND_CLASSES)[number];

// ── Error class ─────────────────────────────────────────────────────────────

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

// A failure that has a name, in the table's order: the first that matches the start of the text wins. Case matters where the words are the same
// in another case: Claude Code's own "Blocked: sleep" and "was blocked by a deny rule" are not each other's. A hook's refusal is `<Pre|Post>ToolUse:<Tool> hook error`
// and nothing looser: a command that prints BLOCKED (a hook's own test run, a CI log) is a failed command, not a hook.
// Measured on a real project's logs, in 2 or more sessions each (PROJECT.md §5); a reworded message reads as a hash until a row is added.
// The one exception is outside_worktree: 50 calls in 1 session, named all the same because it is Claude Code's own fixed message, not a command's output.
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
export const NAMED_SHAPES = NAMED.map(([id]) => id);

/**
 * The first meaningful line of a failure's text (its first 1,000 characters): not empty, not "Exit code N" alone, not tags alone, with its tags dropped.
 * The line a shape is made of, and what the patterns view shows as a sample.
 */
export function firstLine(text: string): string | undefined {
  for (const raw of text.slice(0, WINDOW).split('\n')) {
    const line = raw.replace(/<[^>]*>/g, '').trim();
    if (line && !/^Exit code \d+$/.test(line)) return line;
  }
}

/** A line with what varies from run to run set aside: quoted strings, paths, hex runs of 7 or more, numbers, spacing; cut to 120 characters. */
const normalized = (line: string) =>
  line
    .replace(/"[^"]*"|(?<!\w)'[^']*'|`[^`]*`/g, 'Q') // an apostrophe inside a word opens no quote
    .replace(/[~\w@.-]*(?:\/[\w@.-]+)+/g, 'P') // /abs/path, ~/x, ./x, src/a.ts
    .replace(/\b[0-9a-f]{7,}\b/g, 'H')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

/** FNV-1a, 32 bits, over the string's UTF-16 code units (no dependency, and the plugin has none to import): 8 hex digits. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * What a failed call failed on, short enough to leave the machine whatever Content is set to, and the same for the same failure in another session:
 * the id of a named pattern (`sleep_blocked`) when the text matches one, else `h:` and 8 hex digits, a hash of the tool, the Bash call's command class
 * and the failure's first meaningful line with its paths, quotes, numbers and hex runs set aside. A text with no meaningful line (a bare `Exit code 1`)
 * has no shape. `command` is the call's command class, for a Bash call. Only the first 1,000 characters are read, as errorClass does.
 * ponytail: 32 bits and one line: two different failures may share a hash, and one failure worded with two first lines is two shapes.
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

// ── Files touched ───────────────────────────────────────────────────────────

const WRITES = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
/** §5: project-relative paths only; anything outside `root` (the session's working tree) is left out. */
export function filesTouched(tool: string, input: Record<string, unknown>, root: string): { path: string; mode: 'read' | 'write' }[] {
  const mode = tool === 'Read' ? 'read' : WRITES.has(tool) ? 'write' : null;
  const path = input.file_path ?? input.notebook_path;
  if (!mode || typeof path !== 'string' || !path.startsWith(`${root}/`)) return [];
  return [{ path: path.slice(root.length + 1), mode }];
}
