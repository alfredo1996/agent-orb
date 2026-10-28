import type { CommandClass, ErrorClass } from '../src/index.ts';

// The inputs for the classifiers (#43), as shapes Claude Code really writes (surveyed on the owner's logs). Not a test file, so that
// packages/mod/test/contract.spec.ts can hold the plugin's copy of both classifiers to the same rows: a row added here is a row it must agree on.

export const COMMANDS: [CommandClass, string][] = [
  // test: the runner, however it is reached
  ['test', 'pnpm test'],
  ['test', 'pnpm test --run packages/server/test/ingest.test.ts'],
  ['test', 'pnpm -C /Users/alfredorubin/WebstormProjects/agent-orb test'],
  ['test', 'pnpm --filter @agent-orb/server test'],
  ['test', 'npm test'],
  ['test', 'npm run test:e2e'],
  ['test', 'pnpm test:e2e'],
  ['test', 'npx vitest run'],
  ['test', 'npx --no-install vitest run packages/mod'],
  ['test', 'pnpm exec vitest run'],
  ['test', './node_modules/.bin/jest --ci'],
  ['test', 'pytest -x tests/'],
  ['test', 'python3 -m pytest tests'],
  ['test', 'npx playwright test e2e/login.spec.ts'],
  ['test', 'go test ./...'],
  ['test', 'cargo test'],
  ['test', 'env -i HOME="$HOME" USER="$USER" PATH="$PATH" "/Users/alfredorubin/Library/Application Support/Claude/claude" plugin test /x/packages/mod'],
  ['test', 'cd /x && APP_ENV=staging pnpm test --run'],
  ['test', 'for m in full lite demo; do APP_ENV=$m pnpm test --run; done'],
  ['test', 'pnpm test 2>&1 | tail -20'],
  ['test', 'time pnpm test'],
  ['test', 'bash <<\'EOF\'\ncd /x\npnpm -C packages/server test\nEOF'],
  ['test', 'bash -c "cd /x && pnpm test"'],
  ['test', 'bash .claude/hooks/__tests__/check-branch.test.sh'],
  ['test', './scripts/test.sh --fast'],
  ['test', 'sh run-tests.sh'],
  ['test', 'pnpm install && pnpm test'], // a chain is its most telling step: running the tests outranks setting up for them
  // build
  ['build', 'pnpm build'],
  ['build', 'npm run build'],
  ['build', 'pnpm -r build'],
  ['build', 'pnpm --filter studio build'],
  ['build', 'pnpm build:web'],
  ['build', 'npx --no-install tsc -p /x/packages/mod'],
  ['build', 'tsc --noEmit'],
  ['build', 'pnpm typecheck'],
  ['build', 'vite build'],
  ['build', 'npx next build'],
  ['build', 'docker build -t agent-orb .'],
  ['build', 'docker compose build server'],
  ['build', 'cd /x && pnpm install && pnpm build'],
  // lint
  ['lint', 'eslint .'],
  ['lint', 'npx eslint src --fix'],
  ['lint', 'pnpm lint'],
  ['lint', 'pnpm run lint:fix'],
  ['lint', 'prettier --check .'],
  ['lint', 'npx prettier -w src'],
  ['lint', 'ruff check .'],
  // git, gh, docker
  ['git', 'git status'],
  ['git', 'git -C /Users/alfredorubin/WebstormProjects/agent-orb log --oneline -5'],
  ['git', 'git add -A && git commit -m "feat: x" && git push'],
  ['git', 'git diff | head -50'],
  ['git', 'cd /x && git status --short'],
  ['git', 'git commit -m "fix: pnpm test passes on vitest"'], // words inside a quoted message are not commands
  ['git', 'git commit -m "$(cat <<\'EOF\'\nfeat: the build\n\npnpm test\nEOF\n)"'],
  ['gh', 'gh issue view 43 --repo alfredo1996/agent-orb'],
  ['gh', 'gh pr create --title "t" --body "b"'],
  ['gh', 'gh api -X PATCH repos/alfredo1996/agent-orb/issues/43'],
  ['gh', 'gh auth switch --user alfredo1996 && gh pr list'],
  ['gh', 'git log --oneline -3; gh pr view 7'], // git and gh in one line: the gh call is the one that talks to GitHub
  ['docker', 'docker ps'],
  ['docker', 'docker compose up -d'],
  ['docker', 'docker run --rm -p 7474:7474 neo4j'],
  ['docker', 'docker exec -it neo sh'],
  ['docker', 'docker-compose logs -f'],
  // install
  ['install', 'pnpm install'],
  ['install', 'pnpm i --frozen-lockfile'],
  ['install', 'pnpm -C /x add -D vitest'],
  ['install', 'npm install'],
  ['install', 'npm ci'],
  ['install', 'yarn add zod'],
  ['install', 'pip install -r requirements.txt'],
  ['install', 'pip3 install requests'],
  ['install', 'python3 -m pip install requests'],
  ['install', 'uv pip install requests'],
  // other: a word that only looks like a command
  ['other', 'ls -la'],
  ['other', 'cat package.json'],
  ['other', 'node scripts/seed.mjs'],
  ['other', 'echo "pnpm test"'],
  ['other', 'grep -rn "vitest" packages'],
  ['other', 'ls test'],
  ['other', 'cat test.log | grep build'],
  ['other', 'sed -i \'\' s/a/b/ test.ts'],
  ['other', 'sleep 5'],
  ['other', 'curl -s localhost:7474'],
  ['other', 'mkdir -p src/test'],
  ['other', 'pnpm dev'],
  ['other', 'npx vite'],
  ['other', 'bash scripts/latest.sh'],
  ['other', 'bash ./attest.sh'],
  ['other', 'bash deploy/up.sh'],
  ['other', 'ghostscript -q x.ps'],
  ['other', 'gitleaks detect'],
  ['other', 'github-release upload x'],
  ['other', '# run the tests\nls'],
  ['other', 'FOO=1'],
  ['other', ''],
];

export type Err = [ErrorClass, string, string, boolean?]; // class, tool, text, denied
const TIMED_OUT = 'claude-sonnet-5-5[1m] is temporarily unavailable (timed out), so auto mode cannot determine this action\'s safety. Wait briefly and then try this action again.';
export const ERRORS: Err[] = [
  // exit_code: a command exited non-zero; what it printed does not matter, only that the shell ran it
  ['exit_code', 'Bash', 'Exit code 1\nFAIL  packages/server/test/ingest.test.ts > ingest > writes\nAssertionError: expected 34, got 35'],
  ['exit_code', 'Bash', 'Exit code 1\n\n> vitest run\n\n ❯ packages/mod/test/contract.spec.ts (3 tests | 1 failed)'],
  ['exit_code', 'Bash', 'Exit code 2\nsrc/a.ts(4,7): error TS2322: Type \'string\' is not assignable to type \'number\'.'],
  ['exit_code', 'Bash', 'Exit code 1\n(eval):1: no matches found: --include=*.ts'],
  ['exit_code', 'Bash', 'Exit code 1\nGraphQL: Projects (classic) is being deprecated in favor of the new Projects experience'],
  ['exit_code', 'Bash', 'Exit code 1\nTraceback (most recent call last):\n  File "<stdin>", line 3, in <module>\nKeyError: \'id\''],
  ['exit_code', 'Bash', 'Exit code 1\nPost "https://api.example.com/x": net/http: TLS handshake timeout'], // a command\'s own words, not the harness\'s
  ['exit_code', 'Bash', 'Exit code 1\ncat: secrets.txt: Permission denied'], // the OS said no to the command; Claude Code did not refuse the call
  ['exit_code', 'Bash', 'Exit code 1\n1 file changed\nErrno 2 No such file or directory: \'dist/index.js\''], // a failing run that mentions a path is still a failing run
  ['exit_code', 'Bash', 'Exit code 1\n\n> vitest run\n\n FAIL  test/a.test.ts\n Error: ENOENT: no such file or directory, open \'fixtures/x.json\''], // a failing test run that trips on a path deeper in
  ['exit_code', 'Bash', `Exit code 1\n${'noise\n'.repeat(400)}zsh: command not found: late`], // only the start of a long output decides
  // unknown_command
  ['unknown_command', 'Bash', 'Exit code 127\n(eval):1: command not found: timeout'],
  ['unknown_command', 'Bash', 'Exit code 127\nzsh:1: command not found: gsed'],
  ['unknown_command', 'Bash', 'Exit code 127\nbash: pnpx: command not found'],
  ['unknown_command', 'Bash', 'Exit code 127'],
  // not_found from a command: its first line says the path is not there (an invented or stale path), not a path deep in the output
  ['not_found', 'Bash', 'Exit code 1\ncat: src/missing.ts: No such file or directory'],
  ['not_found', 'Bash', 'Exit code 2\nls: cannot access \'/Users/a/mobile-app/srcc\': No such file or directory'],
  ['not_found', 'Bash', 'Exit code 1\ncd: no such file or directory: /Users/a/agent-orb/packages/modd'],
  ['not_found', 'Bash', 'Exit code 2\npython3: can\'t open file \'/x/seed.py\': [Errno 2] No such file or directory'],
  ['not_found', 'Bash', 'Exit code 1\n(eval):1: no such file or directory: .venv/bin/python'],
  ['not_found', 'Bash', 'Exit code 1\ncd: no such file or directory: /wrong/dir\n'], // `cd /wrong && pnpm test`: the tests never ran
  // timeout
  ['timeout', 'Bash', 'Command timed out after 2m 0s'],
  ['timeout', 'Bash', 'Exit code 124\nCommand timed out after 10m 0s'],
  ['timeout', 'WebFetch', 'Request timed out after 60000ms'],
  ['timeout', 'mcp__playwright__browser_click', 'TimeoutError: locator.click: Timeout 30000ms exceeded.'],
  // not_found: a path that is not there
  ['not_found', 'Read', 'File does not exist. Note: your current working directory is /Users/a/mobile-app.'],
  ['not_found', 'Read', '<tool_use_error>File does not exist.</tool_use_error>'],
  ['not_found', 'Edit', '<tool_use_error>File does not exist. Note: your current working directory is /r.</tool_use_error>'],
  ['not_found', 'Glob', 'Path does not exist: /Users/a/mobile-app/srcc'],
  ['not_found', 'Read', 'ENOENT: no such file or directory, open \'/r/src/missing.ts\''],
  ['not_found', 'NotebookEdit', 'No such file or directory: /r/nb.ipynb'],
  // no_match: the Edit's old text is not in the file
  ['no_match', 'Edit', '<tool_use_error>String to replace not found in file.\nString: const x = 1</tool_use_error>'],
  ['no_match', 'Edit', 'String to replace not found in file.'],
  // read_first
  ['read_first', 'Edit', '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>'],
  ['read_first', 'Write', 'File has not been read yet. Read it first before writing to it.'],
  ['read_first', 'Edit', '<tool_use_error>You must read the file before editing it.</tool_use_error>'],
  // invalid_input
  ['invalid_input', 'Monitor', '<tool_use_error>InputValidationError: Monitor failed due to the following issue:\nThe required parameter `command` is missing</tool_use_error>'],
  ['invalid_input', 'bash', '<tool_use_error>Error: No such tool available: bash. Tool names are case-sensitive</tool_use_error>'],
  ['invalid_input', 'StructuredOutput', 'Output does not match required schema: root: must have required property \'refuted\''],
  // refused: Claude Code or a hook said no, so nothing ran
  ['refused', 'Bash', 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: the command pushes to main'],
  ['refused', 'Bash', 'Permission for this command was denied by a built-in Claude Code safety check, not by a rule you can change.'],
  ['refused', 'Bash', 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).'],
  ['refused', 'ExitPlanMode', 'The user doesn\'t want to proceed with this tool use. The tool use was rejected'],
  ['refused', 'Bash', 'The server-side auto mode classifier gave no verdict (error), so auto mode cannot approve this action.'],
  ['refused', 'Bash', TIMED_OUT], // the classifier timed out; the call was refused, it did not time out
  ['refused', 'Bash', 'anything at all', true], // the engine reports a deny: whatever its reason says
  ['refused', 'Edit', '', true],
  ['refused', 'Bash', 'This agent is isolated in the worktree /Users/a/mobile-app/.claude/worktrees/w but this command is too complex to verify that it stays inside it.'],
  ['refused', 'Bash', 'cat from \'/Users/a/.ssh/id_rsa\' was blocked by a deny rule.'],
  ['refused', 'Write', 'PreToolUse:Write hook error: [bash .claude/hooks/check-branch.sh]: BLOCKED: Cannot edit repo files on main. Create a feature branch first.'],
  ['refused', 'mcp__ccd_turn__update_plan', 'PreToolUse:mcp__ccd_turn__update_plan hook error: Not shown: you are a subagent, and the app shows only the main conversation\'s task list.'],
  ['refused', 'Bash', '<tool_use_error>Blocked: sleep 30 followed by: cat /tmp/log. To wait for a condition, use Monitor with an until-loop.</tool_use_error>'],
  // other
  ['other', 'Bash', ''],
  ['other', 'Bash', '[Request interrupted by user for tool use]'],
  ['other', 'Edit', '<tool_use_error>Found 3 matches of the string to replace, but replace_all is false.</tool_use_error>'],
  ['other', 'Edit', '<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>'],
  ['other', 'Read', 'File content (31524 tokens) exceeds maximum allowed tokens (25000). Use offset and limit parameters to read specific portions of the file.'],
  ['other', 'mcp__Claude_Browser__find', 'no read_page tree cached; call read_page first'],
];

// ── Error shapes (v0.3 slice 3, #45) ─────────────────────────────────────────

export type Shape = [expected: string | undefined, tool: string, text: string, command?: CommandClass]; // expected: a named id, an `h:` hash, or none
const SLEEP = '<tool_use_error>Blocked: sleep 30 followed by: tail -f /private/tmp/claude-501/x/tasks/b1.output. To wait for a condition, use Monitor with an until-loop (e.g. `until grep -q done f; do sleep 2; done`). To wait for a fixed time, use sleep N alone.</tool_use_error>';
const HOOK = 'PreToolUse:Write hook error: [bash .claude/hooks/check-branch.sh]: BLOCKED: Cannot edit repo files on main. Create a feature branch first:';
export const SHAPES: Shape[] = [
  // every named pattern, in the words Claude Code writes today (surveyed on the owner's logs)
  ['sleep_blocked', 'Bash', SLEEP, 'other'],
  ['sleep_blocked', 'Bash', '<tool_use_error>Blocked: sleep 5 followed by: cat /tmp/log</tool_use_error>', 'other'],
  ['hook_blocked', 'Write', HOOK],
  ['hook_blocked', 'Edit', 'PreToolUse:Edit hook error: [bash .claude/hooks/check-branch.sh]: BLOCKED: Cannot edit files on main.'],
  ['hook_blocked', 'mcp__ccd_turn__update_plan', 'PreToolUse:mcp__ccd_turn__update_plan hook error: Not shown: you are a subagent, and the app shows only the main conversation\'s task list.'],
  ['wrong_tool_name', 'bash', '<tool_use_error>Error: No such tool available: bash. Tool names are case-sensitive: call Bash instead.</tool_use_error>'],
  ['wrong_tool_name', 'mcp__ccd_turn__advance', '<tool_use_error>Error: No such tool available: mcp__ccd_turn__advance</tool_use_error>'],
  ['gh_projects_classic', 'Bash', 'Exit code 1\nGraphQL: Projects (classic) is being deprecated in favor of the new Projects experience, see: https://github.blog/changelog/2024-05-23-sunset-notice-projects-classic/. (repository.issue.projectCards)', 'gh'],
  ['classifier_denied', 'Bash', 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked by classifier. If you have other tasks that don\'t depend on this action, continue.', 'git'],
  ['user_rejected', 'Bash', 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.', 'other'],
  ['user_rejected', 'ExitPlanMode', 'The user doesn’t want to proceed with this tool use. The tool use was rejected'],
  ['safety_check', 'Bash', 'Permission for this command was denied by a built-in Claude Code safety check, not by the user. The check stops removals that can delete far more than intended.', 'other'],
  ['deny_rule', 'Bash', 'cat from \'/Users/a/mobile-app/deploy/.env.example\' was blocked by a deny rule.', 'other'],
  // Claude Code's own fixed message for an agent isolated in a worktree; the command class does not split it (it was five hashes)
  ['outside_worktree', 'Bash', 'This agent is isolated in the worktree /Users/a/mobile-app/.claude/worktrees/agent-a2e9, but this command is too complex to verify that it stays inside the worktree. Refusing to run it — a worktree-isolated agent\'s git operations must target its own worktree. Split it into plain, separate commands and run them from /Users/a/mobile-app/.claude/worktrees/agent-a2e9.', 'git'],
  ['outside_worktree', 'Bash', 'This agent is isolated in the worktree /Users/a/mobile-app/.claude/worktrees/wf_83a2-1, but this command changes directory to a location computed at runtime before running git.', 'other'],
  ['outside_worktree', 'Bash', 'This agent is isolated in the worktree /Users/a/mobile-app/.claude/worktrees/agent-a2e9, but this command feeds python text naming git in a plain command, which cannot be shown to stay inside the worktree.'],
  // first match wins, in the table's order: sleep_blocked, hook_blocked, wrong_tool_name, gh_projects_classic, classifier_denied, user_rejected, safety_check, deny_rule, outside_worktree
  ['sleep_blocked', 'Bash', 'Blocked: sleep 30 followed by: echo BLOCKED', 'other'], // BLOCKED in a command's own words is nobody's
  ['hook_blocked', 'Write', 'PreToolUse:Write hook error: [x]: No such tool available: y'], // hook_blocked before wrong_tool_name
  ['hook_blocked', 'Bash', 'PreToolUse:Bash hook error: [x]: denied by the Claude Code auto mode classifier'], // before classifier_denied
  ['wrong_tool_name', 'bash', 'No such tool available: bash. The user doesn\'t want to proceed.'], // before user_rejected
  ['classifier_denied', 'Bash', 'Permission for this action was denied by the Claude Code auto mode classifier. cat x was blocked by a deny rule.', 'other'], // before deny_rule
  ['safety_check', 'Bash', 'Permission for this command was denied by a built-in Claude Code safety check. x was blocked by a deny rule.', 'other'],
  // a bare BLOCKED is no hook's mark: every hook refusal carries `PreToolUse:<Tool> hook error`, and a command that prints BLOCKED (a hook's own test run, a CI log) is a failed command
  ['h:85a9b368', 'Bash', 'Exit code 1\nBLOCKED: pushing to main is not allowed\nok 3 of 4 hook cases', 'test'],
  ['h:5a0cb5ba', 'Bash', 'BLOCKED: pushing to main is not allowed', 'git'],
  // case matters: Claude Code's lower-case "blocked" is no hook's mark, and "Blocked:" is not sleep_blocked's
  ['h:b9dd7db7', 'Bash', 'cat from \'x\' was blocked by something else.', 'other'],
  ['h:984afd23', 'Bash', 'Blocked: this command is not allowed.', 'other'],
  // a pattern is read in the first 1,000 characters only
  ['h:eecd2013', 'Bash', `Exit code 1\n${'x'.repeat(1000)} No such tool available`, 'other'],
  // no meaningful line: no shape
  [undefined, 'Bash', 'Exit code 1', 'test'],
  [undefined, 'Bash', 'Exit code 127\n', 'other'],
  [undefined, 'Bash', 'Exit code 1\n\n  \nExit code 2\n'],
  [undefined, 'Bash', '<tool_use_error></tool_use_error>'],
  [undefined, 'Edit', '<tool_use_error>\n</tool_use_error>'],
  [undefined, 'Bash', ''],
  // a hash is FNV-1a 32 of the tool, the command class and the normalized line (pinned, worked out apart in python)
  ['h:a0038b0f', 'Bash', 'Exit code 1\n FAIL  packages/server/test/ingest.test.ts > ingest > writes\nAssertionError: expected 34, got 35', 'test'],
  ['h:d9431450', 'Read', 'File does not exist. Note: your current working directory is /Users/a/mobile-app.'],
  ['h:cf7cdea6', 'Bash', 'Exit code 2\nsrc/a.ts(4,7): error TS2322: Type \'string\' is not assignable to type \'number\'.', 'build'],
  ['h:d6fb5099', 'Bash', 'Exit code 128\nfatal: bad object 1a2b3c4d5e6f', 'git'],
  ['h:269aa74f', 'Edit', '<tool_use_error>String to replace not found in file.\nString: const x = 1</tool_use_error>'],
];

/** Pairs that differ in a path, a number, a quoted string, a hash, spacing or what follows the first line, and are one shape. */
export const SAME_SHAPE: [Shape, Shape][] = [
  [['_', 'Bash', 'Exit code 1\ncat: /Users/a/mobile-app/src/a.ts: No such file or directory', 'other'], ['_', 'Bash', 'Exit code 2\ncat: /Users/b/other/deep/b.ts: No such file or directory', 'other']], // paths, and the exit code
  [['_', 'Bash', 'Exit code 1\ncat: src/a.ts: No such file or directory', 'other'], ['_', 'Bash', 'Exit code 1\ncat: lib/b/c.ts: No such file or directory', 'other']], // relative paths
  [['_', 'Bash', 'Exit code 1\ncat: ~/.claude/a: No such file or directory', 'other'], ['_', 'Bash', 'Exit code 1\ncat: ./b/c: No such file or directory', 'other']],
  [['_', 'Bash', 'Exit code 1\nFAIL 3 of 12 tests', 'test'], ['_', 'Bash', 'Exit code 1\nFAIL 17 of 244 tests', 'test']], // numbers
  [['_', 'Bash', "Exit code 1\nCannot find module 'zod' from 'src/a.ts'", 'build'], ['_', 'Bash', 'Exit code 1\nCannot find module "vitest" from `lib/b.ts`', 'build']], // quoted strings
  [['_', 'Bash', 'Exit code 128\nfatal: bad object 1a2b3c4d5e6f', 'git'], ['_', 'Bash', 'Exit code 128\nfatal: bad object 9f8e7d6c5b4a3210', 'git']], // hex runs
  [['_', 'Bash', 'Exit code 1\nfatal:    bad   object', 'git'], ['_', 'Bash', 'Exit code 1\n\n\n  fatal: bad object  \nmore', 'git']], // spacing, empty lines, a later line
  [['_', 'Read', '<tool_use_error>File does not exist.</tool_use_error>'], ['_', 'Read', 'File does not exist.\nNote: your current working directory is /r.']], // tags, and what follows
  [['_', 'Bash', `Exit code 1\n${'a'.repeat(120)}one`, 'other'], ['_', 'Bash', `Exit code 1\n${'a'.repeat(120)}two`, 'other']], // cut at 120 characters
  [['_', 'Bash', "Exit code 1\ncan't open 'a.txt'", 'other'], ['_', 'Bash', "Exit code 1\ncan't open 'b.txt'", 'other']], // an apostrophe in a word opens no quote
];
/** Pairs that must not be one shape: another tool, another kind of command, another failure. */
export const OTHER_SHAPE: [Shape, Shape][] = [
  [['_', 'Read', 'File does not exist.'], ['_', 'Edit', 'File does not exist.']], // the tool is part of the shape
  [['_', 'Bash', 'Exit code 1\nFAIL x', 'test'], ['_', 'Bash', 'Exit code 1\nFAIL x', 'build']], // and a Bash call's command class
  [['_', 'Bash', 'Exit code 1\nfatal: bad object', 'git'], ['_', 'Bash', 'Exit code 1\nfatal: not a git repository', 'git']], // another failure
  [['_', 'Bash', 'Exit code 1\ncat: src/a.ts: No such file or directory', 'other'], ['_', 'Bash', 'Exit code 1\nls: src/a.ts: No such file or directory', 'other']], // another command's words
];
