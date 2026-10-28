# agent-orb — Project definition

> Gamified observability for Claude Code agents: a plugin records everything the agents do (tools, tokens, cost, delegations, skills), a local server stores it in a SQLite file and shows it as a live table, a cost ledger, a per-project pipeline and a small pixel-art office. Open source, self-hosted, zero cost.

Version 2.0, 19 October 2026: English, with the owner's decisions from grill rounds 1 and 2 folded in. Supersedes the Italian 1.0 (the original is in `~/Downloads/PROJECT.md`).
Author: Alfredo Rubin (with Claude). Working name **agent-orb**; the public brand is chosen before launch.

---

## 1. Vision

Working with Claude Code I only see the terminal. I want to:

1. **See** who is working, on what, with which tool, for how long and at what token cost, live. Plainly in a table, and playfully in a pixel-art office (bots at desks typing, reading, thinking, waiting).
2. **Be warned** when something is wrong: an agent stuck on one tool for 15 minutes, a subagent running on a more expensive model than intended.
3. **Understand** how a project works: the real org chart of its pipeline (orchestrator → developer → reviewer → tester…), with delegations and tokens flowing between roles.
4. **Keep** everything in a queryable history (SQLite) to compare sessions and projects: where tokens go, which skills work, which tool sequences fail.

### Why it should exist

Three incidents from the owner's own work, each of which a live per-agent view would have shown as it happened:

- 2026-09-19: a run stopped over token consumption (parallel agents of 300–600k tokens, several resumed).
- 2026-10-05: every workflow subagent had run on Opus although the agent definitions declared Sonnet or Haiku. Found after the fact; $568 API-equivalent across 546 subagents, measured by hand.
- 2026-10-16: a subagent hung for 50 minutes on one tool call and nobody noticed.

Claude Code shows per-session totals (`/cost`), never per-agent model, tokens or liveness. Existing tools each cover a part (§3.1); none joins the agent tree, per-agent cost and history.

Three components: `mod` (capture, inside Claude Code), `server` (ingest + API + live stream), `studio` (the web UI).

---

## 2. Non-negotiable constraints

- **Zero cost.** Free software only: SQLite (built into Node), Node/TypeScript, React, CC0 art. No paid service, not even later.
- **Self-hosted.** `docker compose up -d` on the same machine as Claude Code (v0.1), later a VPS, NAS or home server.
- **One-way flow.** Events always go *from* the working machine *to* the server. The server never reaches the working machine.
- **The server is the only database client.** The mod knows a URL and a token, nothing about the database.
- **Privacy by design.** Every event carries `user_id`, `team_id` and `host` from day one. Content (prompts, tool input/output) is separable from metadata; v0.1 sends metadata only.
- **The mod never slows or blocks Claude Code.** Hooks pass through at once; events go to a local outbox; if the server is down they queue, nothing is lost and nothing blocks.

---

## 3. Prior art and data sources (checked 2026-10-19)

### 3.1 What exists

| Project | Form | Data | Shows | Tokens/cost | History |
|---|---|---|---|---|---|
| Pixel Agents (Pablo De Lucca) | VS Code extension | transcript JSONL | characters typing/reading, bubble when waiting, subagents tied to parent | no | no |
| paulrobello/claude-office (MIT) | standalone app (hooks → FastAPI → PixiJS) | classic hooks | boss + employees, bubbles, context "bin", tool pie, multi-session | no | preferences only |
| JoelHutchinson/agent-visualiser | local daemon | transcript + OTel | desks growing with subagents | no | no |
| dimivelev/pixel-agents, Khanthtutzin/subagent-crew | Claude Code mod | engine | pixel sprites under the prompt | no | no |
| simple10/agents-observe | plugin + SQLite + web dashboard | classic hooks | tool calls, subagent tree, tokens | partial | local SQLite |
| OTel stacks (SigNoz, Grafana LGTM, ColeMurray/claude-code-otel) | collector + dashboards | OpenTelemetry | metrics and logs | yes | yes, not as a graph |

None combines a persistent graph, cost per agent and role, a per-project pipeline view, a live stall alert and gamification.

### 3.2 Data sources in Claude Code

**A. Classic hooks** (`hooks.json`, type `command`): JSON on stdin with `session_id`, `tool_name`, `tool_input`, `agent_id`… **No tokens, no cost.** Not used (decision 5).

**B. OpenTelemetry**: `claude_code.api_request` with tokens and `cost_usd`. Must be enabled by the user in settings (a plugin cannot). Not in v0.1.

**C. Mod API** (TypeScript hooks inside the engine), **the only source**. Verified against the 2.1.299 type definitions:
- `turn.step` — per API request: `turnId`, `index`, `model`, `agentId` (absent on the main loop); its result carries `usage` = `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, model}`, `toolUses`, `stopReason`.
- `turn.start` / `turn.complete` — `turnId`, `agentId`, `reason` (`answer|aborted|refusal|error`), turn `usage`.
- `agent.spawn` — `tool_use_id`, `prompt`, `description` (a few words), `subagentType`, `provider`; `await next(e)` gives the resolved `model` and the child's `agentId`.
- `tool.call` — tool name and input; `await next(e)` gives the result or error; `agentId` names the loop.
- `prompt.submit`, `session.start`, `session.compact`, `session.end`, `skill.prompt`.
- `$.session.usage()` (context window), `$.store` (persistent values), `$.fs` (read/write/list/stat — **no append**), `$.http.fetch`, `$.clock.every`, `$.ui.status`, `$.ui.notify`, `$.ui.open` (panel), `$.command.register`, `userConfig` options in the manifest.
- **No `agent.complete` and no `task.*` events.** The mod derives a subagent's end from the Agent `tool.call` result (or `turn.complete` with that `agentId`), and tasks from the Task tools' calls.
- Develop with `CLAUDE_CODE_PLUGIN_DIRS` or `claude --plugin-dir <dir>`; check with `claude plugin validate` and `claude plugin test`.

**D. Transcript JSONL**: internal, unstable format. Never a source; used only by the acceptance check C (§12).

Versions on the owner's Mac: desktop engine 2.1.299, terminal CLI 2.1.273 (update before testing there). The README states the minimum version once the first build passes.

---

## 4. Architecture

```
┌─ machine running Claude Code ─────────────────────────────────────────┐
│  mod "agent-orb"                                                      │
│   · hooks: session.*, prompt.submit, turn.*, agent.spawn, tool.call,  │
│            skill.prompt, session.compact                              │
│   · normalise → Event (§5), strip content (meta only)                 │
│   · outbox: persisted ($.store or a rewritten file), never blocks     │
│   · flush: POST /ingest every 2 s or 200 events, retry with backoff   │
│   · stall timer ($.clock.every): status line ⚠ + native notification  │
│   · status line + /orb panel                                          │
│   · settings: plugin userConfig (endpoint, token, stall minutes)      │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ HTTP to 127.0.0.1:4040, Bearer token
┌─ server (docker compose) ─────▼───────────────────────────────────────┐
│  orb-server (Node/TS, Fastify), 127.0.0.1:4040                        │
│   · POST /ingest   validate (Zod), check token, enrich, write         │
│   · GET  /stream   SSE, live state per session (in memory)            │
│   · GET  /api/*    sessions, ledger, pipeline, graph                  │
│   · GET  /         studio (static build)                              │
│  history.db (SQLite, node:sqlite): the history, one file (§6)         │
│  content.db (SQLite): captured text and reports, by the same ids      │
└───────────────────────────────────────────────────────────────────────┘
```

Monorepo (pnpm workspaces):

```
agent-orb/
  PROJECT.md
  LICENSE                    ← MIT
  packages/
    shared/                  ← Event types, Zod schema, roles.json, pricing.json
    mod/                     ← Claude Code plugin
      .claude-plugin/plugin.json      (userConfig: endpoint, token, stallMinutes)
      hooks/hooks.json
      hooks/register.tsx
      hooks/outbox.ts
      hooks/stall.ts
      hooks/pane.tsx
      types/index.d.ts
      tests/*.test.ts
    server/
      src/ingest.ts, stream.ts, api/*.ts, store/{schema.sql,store.ts,writer.ts}
      Dockerfile
    studio/                  ← React + Vite, charts in plain SVG
      src/live/  src/ledger/  src/pipeline/  src/office/
      assets/sprites/        ← Kenney CC0
  design/                    ← mockups, approved before each view is built
  deploy/
    docker-compose.yml
    .env.example             ← ORB_TOKEN
    backup.sh, restore.sh    ← the nightly backup and its restore (§10)
  .claude-plugin/marketplace.json
  docs/verified.md           ← empirical checks (§11, slice 1)
```

---

## 5. Event schema (mod ↔ server contract)

One event per line, JSON:

```ts
type Event = {
  v: 1;
  id: string;                 // uuid, idempotency key
  ts: number;                 // epoch ms
  host: string;
  user_id: string;            // the server overwrites it from the token
  team_id?: string;
  session_id: string;
  project: { cwd: string; name: string; git_remote?: string; git_branch?: string; checkout?: string };
  agent_id?: string;          // absent = main agent
  parent_agent_id?: string;
  turn_id?: string;
  prompt_id?: string;
  kind: EventKind;
  data: ...;
};
```

`project.cwd` is the repository's root, the main working tree's for a git worktree, and project identity hangs on it (`git_remote`, else `host:cwd`; the import's matching and the re-home too). `project.checkout` (v0.2 slice 3) is the session's own working tree, `git rev-parse --show-toplevel` at the session's cwd, sent only when it differs from `cwd`, that is in a worktree: the branch (`git_branch`), the fingerprints' files and the `files_touched` paths come from it, so the same file in two checkouts is the same project path.

| kind | data | source |
|---|---|---|
| `session.start` | `{ model, source, claude_version, plugin_version }` | `session.start` |
| `session.end` | `{ reason }` | `session.end` |
| `session.compact` | `{ tokens_before, tokens_after }` | `session.compact` |
| `prompt.submit` | `{ length }` | `prompt.submit` |
| `turn.start` | `{}` | `turn.start` |
| `turn.step` | `{ model, usage: {input, output, cache_read, cache_creation}, stop_reason (may be null), tool_use_ids }` | `turn.step` result |
| `turn.complete` | `{ duration_ms, usage_total, reason, answer_length, context_percent? }` (context on the main loop only) | `turn.complete` |
| `agent.spawn` | `{ tool_use_id, agent_type, description, model, prompt_length, declared_role?, declared_model?, model_check? }` (`orb-role` from the agent file, §7). v0.2: `model_check: { allowed, source }` is present only when the agent runs on a pricier model than it should (the family rank haiku < sonnet < opus < fable = mythos): `allowed` is the family it is held to, `source` is `file` (its agent file's `model:`) or `ceiling` (an agent with no model of its own: none, `model: inherit`, a general-purpose or workflow agent, held to the plugin's `modelCeiling`, Sonnet by default; `off` skips them); `declared_model` is the file's `model:` as written. A fork always inherits and is never checked, nor is the main session. | `agent.spawn` + its result |
| `agent.complete` | `{ duration_ms, usage_total, report_length }` | derived: Agent `tool.call` result |
| `tool.call` | `{ tool_use_id, tool, input_size, command_class? }` (v0.3 slice 1: `command_class` on a Bash call only, from its command string; see Classes below) | `tool.call` |
| `tool.result` | `{ tool_use_id, success, error_type?, error_class?, error_shape?, duration_ms, output_size, files_touched }` (v0.3 slice 1: `error_class` on a failed result only, from its text; slice 3: `error_shape` on a failed result only, from the same text; see Classes below) | `tool.call` result |
| `skill.load` | `{ skill, plugin? }` | `skill.prompt` |
| `task.create` / `task.complete` | `{ task_id, subject, status }` | derived: Task tools |
| `stall.start` / `stall.end` | `{ tool_use_id?, tool?, since }` | mod stall timer |
| `tool.waiting` | `{ tool_use_id, tool }` | `classic.PermissionRequest`: the permission dialog is up for a person (a `tool.check` verdict `ask` alone is not: the mode may settle it without one) |
| `outbox.dropped` | `{ count, since }` | the outbox passed its cap (§13); a counter on `Session` |
| `project.changes` | `{ commits: { sha, ts, subject?, files, blobs? }[] }` (at most 500 commits, 50 files each, a subject cut at 200 characters) | v0.2: `git log --all` at session start, the last 90 days of commits, on any branch, that touched the project's `.claude/agents`, `.claude/skills` or `CLAUDE.md`. A commit keeps only the files whose new version (blob) differs from the last one seen for that path, oldest first, so a revert is a change, a squash or release merge that only repeats a file's current version is dropped, and a change is dated where it was made. Metadata: a hash, a time, a subject line and project-relative paths, never a diff or a body; an excluded project (`excludeProjects`) sends no subjects. Slice 3 adds `blobs?: string[]` to a commit: each kept file's new git blob id, parallel to `files` (all zeros = deleted), so a fingerprint can be matched to the commit that made it; absent from an older plugin's events. |
| `project.fingerprint` | `{ files: { path, hash, scope: 'project' \| 'user' }[] }` (at most 1000) | v0.2 slice 3: at session start, off the hook's path, what a change watches as the files are now. `scope: 'project'`: every file under the project's `.claude/agents` and `.claude/skills` (recursive, at most 500, the first by path; hidden files and `node_modules` skipped) and its `CLAUDE.md`, paths project-relative. `scope: 'user'`: the owner's `~/.claude/CLAUDE.md` and `~/.claude/rules/*.md` (at most 100 rules), paths written `~/.claude/...`. `hash` is the git blob id from one `git hash-object --stdin-paths` call (absolute paths on stdin), so it equals the blob a commit stores for that file. A path and a hash, never the file; an excluded project sends it too. Nothing is sent when no file exists or git fails. |
| `project.prs` | `{ prs: { number, title?, merged_at, additions, deletions, head?, counted_lines?, counted_files? }[] }` (at most 500; `merged_at` is epoch ms; a title and a head cut at 200 characters; at most 250 KB of JSON, the oldest going first) | v0.3 slice 2 (#42, Worth): `gh pr list --state merged --search "merged:>=<90 days ago>" --limit 500 --json number,title,mergedAt,additions,deletions,headRefName,files`, run in the session's checkout at session start, off the hook's path (like `project.changes`), newest merge first. A number, when it merged, its size in lines, its title and its branch name, and (#103) `counted_lines` and `counted_files`: the lines (additions + deletions) and the files left once lockfiles, images, build output (`dist/`, `build/`, `coverage/`), minified files and source maps, and generated files (`*.generated.*`, `__generated__/`, `*.snap`) are set aside, judged by path alone with one list in `core.ts`; never a path, a body, an author or a diff. `gh` lists at most 100 files a PR (measured on two real repositories: 1 of 57 PRs and 3 of 200 hit it), so a larger PR counts the first 100, a floor that such a PR clears by far; a PR whose files `gh` did not list sends no counts and stays "not sized". An older plugin sends neither count. An excluded project (`excludeProjects`) sends no titles or heads. No `gh`, a `gh` that is not logged in or fails, or output that is not gh's list sends nothing, quietly. |
| `session.pr` | `{ number }` | v0.3 slice 2: this session opened, or worked on, PR `number` of the project's repository. The plugin sends it when the output of a Bash or MCP tool call contains `https://<remote>/pull/<n>` for this project's own remote (a file or a web page read can mention any PR, so those are not read), once per number per session; the import sends it for each `pr-link` line of Claude Code's logs (below). The project is the event's, so only the number leaves the machine. It is a session-level event: no `agent_id`, no `turn_id`. |

Rules:
- **Metadata only in v0.1.** No prompt text, tool input/output, answers or thinking leave the machine. Kept: lengths, names, the spawn's short `description` (a task title, shown in Live), `files_touched` as project-relative paths, and (v0.3) the two classes and (slice 3) the error shape below, and (v0.3 slice 2) a merged PR's number, title and branch name (an excluded project sends no titles or branches).
- History import (v0.2): the server image's `import <dir>` writes the same events from Claude Code's own session logs, usage and metadata only (lengths, never text), whatever `content` is set to. Its `session.start` has `source: 'import'`, `plugin_version: 'import'`. Every id is a UUID v5 of the session, the kind and the line's own key, so a second run is all duplicates. Every imported turn ends with a `turn.complete` (its last event minus its start, `reason: 'answer'`, `answer_length: 0`).
  - v0.3 slice 2 (#42): Claude Code's logs hold a `type: 'pr-link'` line (`sessionId`, `prNumber`, `prRepository: 'owner/repo'`, `prUrl`, `timestamp`) when a session opens a PR, repeated as the session goes on (a real project's logs: 3,460 lines for 10 sessions). The import emits one `session.pr` per session, repository and number, at the earliest line's time, with an id that is a UUID v5 of the session and the number. It does so only for a line whose own `sessionId` is the file's session (a resumed session's file copies the history it resumed, and those lines are the original session's) and whose repository is the project's: `prUrl`'s host (GitHub's when the line has none usable) and `prRepository` equal the project's `git_remote`, without regard to case. A project the import knows no remote for links nothing. Unlike the other events it sends for a session the plugin recorded, a `session.pr` is sent whatever its time: it is one MERGE, so the plugin's own and the logs' say the same thing once, and a plugin from before this slice sent none. The URL and the repository are compared on the spot and dropped.
  - v0.3 slice 1: the import classifies the same way from the lines it reads (a Bash command and the start of a failed result are reduced to a class and dropped on the spot) and records `files_touched` for the Read, Edit and Write calls (and `NotebookEdit`, `MultiEdit`) that worked: the path relative to the session's working tree (a worktree's root when the session ran in one, else the project path; a subagent isolated in a worktree has its own), mode `read` or `write`, nothing outside the tree, as the plugin sends them. An event that gained a class or a path takes a new id (the key gets `|v2`), so a history imported before takes them on its next run; the graph merges by `tool_use_id`, so nothing doubles, and every other event keeps its id. The run after that accepts nothing.
  - v0.3 slice 3 (#45): the import works out the error shape the same way, from the tool, the call's command class and the result's first 1,000 characters, and drops the text on the spot. A failed result that has a shape takes a new id, keyed on the shape (the key gets `|s:` and the shape, after slice 1's `|v2`), so a history imported with the classes alone takes the shapes on its next run, and a shape that changes (a named pattern added to the table since) is a new event again; the graph merges by `tool_use_id` and `coalesce` takes the new shape, so nothing doubles. A failed result with a class but no shape (a bare `Exit code 1`) keeps its `|v2` id, and every other keeps the id it had. The run after that accepts nothing.
  - #86: the import reads each session as a stream, so its memory does not grow with the session (§6, "The import's memory"). Its events are the same, with the same ids; they reach the writer file by file, each in the order of its lines, and a session's `session.start` and each subagent's `agent.spawn`, turn and `agent.complete` come when their files end (their time is the earliest of all the lines, which is not always the first).
- **Classes (v0.3 slice 1, #43).** A short class for every failed call and every Bash call, worked out where the text is (the plugin, the import) so that only the class travels: it works with Content off, and no command or output text leaves the machine. Failure patterns (#45, built on the shape below) and the unbacked-claim checks (#44, §6 "Unbacked claims") read them.
  - `command_class`, on a Bash `tool.call`: `test | build | lint | git | gh | docker | install | other`. Only a command's own word counts, so `git commit -m "pnpm test"` is `git` and `ls test` is `other`; `pnpm -C x test`, `npx vitest`, `claude plugin test` and `bash x.test.sh` are `test`; `tsc` and `pnpm typecheck` are `build`; `docker build` is `build`, other `docker` is `docker`. A chain is the first of test, build, lint, install, docker, gh, git that appears in it (`pnpm install && pnpm test` is `test`). A naive reading of the shell: no variables or aliases, and a script run by name (`./ci.sh`) is `other`.
  - `error_class`, on a failed `tool.result`, from the first 1,000 characters of its text: `refused` (stopped before it ran: a permission rule or the user's "no", the worktree sandbox, a hook's BLOCKED, Claude Code's "Blocked:" rule, the auto-mode classifier with a verdict or without one, or the engine's own deny); `exit_code` (a Bash command that ran and exited non-zero, "Exit code N", whatever it printed: a failing test run is `exit_code` with command class `test`), except `unknown_command` (a 127, or "command not found" on its first line) and `not_found` (its first line says ENOENT or no such file, as `cat` or `cd` on a missing path); `timeout` (Claude Code's "Command timed out", or another tool's timeout); `not_found` (ENOENT, "does not exist", "no such file"); `no_match` (an Edit's "String to replace not found"); `read_first` ("has not been read", "must read"); `invalid_input` (InputValidationError, an unknown tool name, a schema mismatch); `other`. The match is on Claude Code's current wording, found on the owner's logs.
  - `error_shape` (v0.3 slice 3, #45), on a failed `tool.result`, from the same first 1,000 characters: a short name for how it failed, so the same failure in other sessions can be grouped (`GET /api/patterns`, §6) with no text leaving the machine. It matches `^[a-z_]+$` (a named pattern) or `^h:[0-9a-f]{8}$` (a hash).
    - **A named pattern** when the text matches one, the first in this order, case-sensitively (Claude Code's `Blocked:` and `blocked by a deny rule` are not each other's): `sleep_blocked` (`Blocked: sleep N followed by`), `hook_blocked` (`PreToolUse:<Tool> hook error`, or the same with `PostToolUse`; a bare `BLOCKED` is no hook's mark, since a command can print it), `wrong_tool_name` (`No such tool available`), `gh_projects_classic` (`Projects (classic)`, the GraphQL error of `gh issue edit` and `gh pr edit`), `classifier_denied` (`denied by the Claude Code auto mode classifier`), `user_rejected` (`The user doesn't want to proceed`), `safety_check` (`denied by a built-in Claude Code safety check`), `deny_rule` (`was blocked by a deny rule`), `outside_worktree` (`This agent is isolated in the worktree`, Claude Code's refusal of a command from an agent isolated in a worktree). Each was measured in 2 or more sessions of a real project's logs (calls, sessions: 261, 6; 89, 7; 35, 3; 23, 4; 17, 3; 13, 5; 5, 2; 3, 2); a pattern is added only on such a measure. The exception is `outside_worktree` (50, 1): one session, named because it is Claude Code's own fixed message, which had split into five hashes by command class.
    - **Otherwise a hash**, `h:` and 8 hex digits: FNV-1a (32 bits, over the UTF-16 code units) of `<tool>\n<command class, empty unless a Bash call>\n<line>`. The line is the first meaningful line of the text (not empty, not `Exit code N` alone, not tags alone, its tags dropped) with quoted strings, paths (absolute, `~`, `./` and relative ones with a slash), hex runs of 7 or more characters and numbers replaced, spaces collapsed, cut to 120 characters. A text with no meaningful line (a bare `Exit code 1`) has no shape.
    - ponytail: 32 bits and one line. Two different failures can share a hash, and one failure whose first line varies is two shapes. A reworded message reads as a hash until a row is added.
  - The classifiers are `packages/shared/src/classes.ts` (pure, unit-tested) and a copy in `packages/mod/hooks/core.ts`; the plugin imports nothing from shared. `packages/mod/test/contract.spec.ts` holds both to one table (`packages/shared/test/class-tables.ts`), so a row added there is a row both must agree on.
- Batch: `POST /ingest` with `{ events: Event[] }`, at most 500 events or 1 MB; reply `{ accepted, duplicates, rejected }`. Each event is checked on its own (#114): an invalid one is refused and counted in `rejected`, the rest are written, and the server logs one warn line, "refused invalid events", with the refused events' kinds and the first 20 distinct failures (a failure repeated across events once, at its first), each its code, path and message, never the event's text. A body that is not a list of at most 500 is refused whole, 400, with the line "refused an invalid batch" (#111). The plugin adds a 2xx's `rejected`, and every event of a 400 or 413, to the count `/orb` shows. Idempotent on `id`, with one exception (#103): a duplicate `session.pr` still moves its link's time (Worth, below). Since #81 (slice 1) the batch is written to the SQLite history store (`history.db`, §6 "The store"), and its text to the text store; wherever this section says the graph merges or MERGEs on a key, the store upserts on the same key. The import writes the same store, and says so to the writer (`source`: `import`), as `POST /ingest` says `plugin`.
- Cost is computed by the server from `pricing.json` (per model), never by the mod. An unknown model has cost `null` and still counts its tokens.

---

## 6. History model

### The store (SQLite, #81; v0.3, in four slices on `feat/sqlite`)

The history is one SQLite file, `history.db`, in the directory of `CONTENT_DB` (the text store's own folder and volume), opened with `node:sqlite` (`packages/server/src/store/`). WAL, `PRAGMA cache_size = -8192` (8 MB, set explicitly: memory must not grow with the file) and a 5 s busy timeout, because `import` is a second process on the file beside the server. The schema is `store/schema.sql`, applied at open, every statement idempotent.

**State of the move.** Done: slice 1 (#87) the store, the writer and the import; slice 2 (#83) the read APIs; slice 3 (#84) the Pipeline and `/healthz`; slice 4 (#85) the deploy, with one container, one volume and a backup that copies two files. The server opens `content.db` and `history.db` and no database server, and the gate runs `pnpm soak` ("The memory soak" below).

**Tables and keys.** A key is what the graph MERGEd on. Times are epoch ms.

| table | key | holds |
|---|---|---|
| `ingested` | `id` | every event id already written (§5 idempotency) |
| `projects` | `id` (remote, else `host:cwd`) | `name`, `git_remote`, `goal_usd` (the API's) |
| `project_cwds` | `(project_id, cwd)` | `Project.cwds` |
| `role_rules` | `(project_id, agent_type)` | the owner's `role`; the API writes it, the writer reads it and moves it on a re-home |
| `sessions` | `id` | `user_id`, `host`, `project_id`, `started_at`, `ended_at`, `model`, `claude_version`, `content`, `source`, `recorded`, `plugin_first`, `plugin_last`, `dropped_events` |
| `agents` | `id` (`session:agent_id`, main is `session:main`) | `session_id`, `parent_id` (SPAWNED), `spawn_tool_use_id` (SPAWNED_AGENT), `type`, `role`, `role_source`, `description`, `model`, `started_at`, `ended_at`, `declared_model`, `allowed_model`, `check_source`, `pricier` |
| `turns` | `id` | `agent_id`, `started_at`, `duration_ms` |
| `prompts` | `id` | `session_id`, `agent_id`, `ts`, `length` |
| `api_requests` | `id` (the `turn.step` event's) | `turn_id`, `ts`, `model`, the four token counts, `cost_usd` |
| `tool_calls` | `tool_use_id` | `turn_id`, `tool`, `ts`, `input_size`, `command_class`, `success`, `error_type`, `error_class`, `error_shape`, `duration_ms`, `output_size`, `output_skipped`, `waited` |
| `files_touched` | `(tool_use_id, path, mode)` | `project_id` (the File node's project) |
| `skill_loads` | `id` (the `skill.load` event's) | `session_id`, `turn_id`, `tool_use_id`, `skill`, `ts`, `how`, `source` |
| `skill_defs`, `session_skill_defs` | `id` (`project\|kind\|source\|name`); `(session_id, def_id)` | SkillDef and LISTED; `calls_skills`, `calls_agents`, `preload` are JSON arrays |
| `tasks`, `agent_tasks` | `id` (`session:task_id`); `(agent_id, task_id)` | Task and WORKED_ON |
| `changes` | `id` (`project:sha`, or `project:fp:path:hash`) | `project_id`, `sha`, `ts`, `subject`, `files` and `hashes` (JSON arrays), `scope`, `source` |
| `fingerprints` | `id` | `project_id`, `cwd`, `path`, `scope`, `hash`, `ts` |
| `claims` | `(agent_id, turn_id, n)` | v0.3 slice 4 (#44): `session_id`, `kind` (`test`, `build`, `edit`), `file` (an edit claim's), `backed`, `why`, `edit_ts`, `run_ts`, `request_id`, `at`, `len`, `ts`: one row per claim in a final answer, checked when the answer ended; where the words sit in the text store, never the words ("Unbacked claims" below) |
| `pull_requests`, `session_prs` | `id` (`project:number`); `(session_id, pr_id)` | `project_id` (set by gh's list alone), `number`, `title`, `merged_at`, `additions`, `deletions`, `head`, `size` (the owner's); OPENED |

Not stored, derived on read: User and Host (a session carries both), Tool (`tool_calls.tool`), `HAS_PROMPT.order` and `CALLED.order` (rank by `ts`), `NEXT` (an agent's previous call by `ts`; parallel calls with one `ts` share a predecessor), Skill (the names in `skill_loads`).

**One call, one session.** `tool_calls` has one row per `tool_use_id`, and its `turn_id` is the first `tool.call` that named one (events are applied in `ts` order), so a call a forked session copies stays one row, in the session that wrote it first; its session is `turns.agent_id` → `agents.session_id`. A row made by a result or a wait alone has no `turn_id` and is no call until a `tool.call` gives it one. The graph counted such a call once per turn that called it.

**The plugin's stretch (#79).** The writer takes its source, `plugin` (`POST /ingest`) or `import`. For the plugin's events it keeps, on the session, the first and last `ts` of the prompts, requests and tool calls it wrote (`plugin_first`, `plugin_last`); a session with only a start has none, and the import's own events are never counted. The import sends a session the plugin recorded only what is outside that stretch, a minute wider each side (`session.start` and `session.pr` always): the logs fill in before and after it, and with none the whole session. An imported session the plugin resumed later is therefore re-imported up to the plugin's first event, which is what lets a re-import update its early calls with a field a newer server adds.

**The read APIs (slice 2, #83; the Pipeline's, slice 3, #84).** Each keeps its response shape (one addition: `/api/pipeline`'s agents carry a `depth`). The grouping is SQL (`GROUP BY`, window functions), so a response is built from aggregated rows and the server's memory does not grow with the history; the walk the graph made, `Project <- Session -> Agent -> Turn -> ApiRequest | ToolCall`, is `projects` ← `sessions` ← `agents` ← `turns` ← `api_requests` | `tool_calls` on their keys, and a project is read by name, every project row with it.

| API | reads | how |
|---|---|---|
| `GET /api/ledger` | `api_requests`, `tool_calls`, `files_touched` (and the analysis spend, `analysis_reports`, in the text store's file) | one `GROUP BY` per breakdown (totals, previous period, pricier, series by bucket and model, project, model, role and type, calls, files); a window by `ts` |
| `GET /api/trends` | `api_requests`, `prompts`, `changes` | spend per bucket by who and by model family (`CASE` inside `sum`); one row per project and local day for the before/after sides; a fingerprint's entry that git explains is dropped in the query (`NOT EXISTS` over `json_each` of a commit's `files` and `hashes`, the all-zero blob being `deleted`) |
| `GET /api/worth`, `PUT /api/worth/size` | `prompts` (the month's, `lag()` over them: the gaps under 10 minutes are summed in SQL), `tool_calls` where `waited`, `api_requests`, `pull_requests` and `session_prs` | a PR's sessions, agents and cost are its slices of each session that linked it (`session_prs.ts`, a window function over the session's links in time); the size is `pull_requests.size` when the owner set one, else the score of `counted_lines` and `counted_files` |
| `GET /api/patterns` | `tool_calls`, `files_touched`, `claims` | kinds and commands by `GROUP BY`; repeats by `GROUP BY` on the shape, the most frequent tool and classes by `row_number()` over the counts, and each group's newest 50 calls (the sample's candidates) by `row_number()` over its calls; the claims by one `GROUP BY` on their kind, the project's sessions and those with Content on full by one `count`; only a sample reads the text store |
| `GET /api/history` | `sessions`, `agents`, `prompts`, `api_requests`, `tool_calls`, `claims` | the newest 100 of each kind by `ORDER BY ts DESC LIMIT 100`, merged by time and cut to 100; the text from the text store, and a claim's words cut from its answer there (`at`, `len`) |
| `GET /api/goal`, `PUT /api/goal` | `api_requests`; `projects.goal_usd` | the month's spend to now; the goal is set on every project row with the name |
| `GET /api/skills` | `skill_defs`, `session_skill_defs`, `skill_loads`, `agents`, `tool_calls`, `api_requests` | the turns that loaded a skill, their loads and spawns as rows, their requests grouped by the load they follow (each belongs to the latest skill loaded before it, which is the one `skill-graph.ts` charges), the agent types with their own spend |
| `GET /api/analysis/reads` and the digest | the same, by project name and session or range | the top 10 sessions, the sessions' content modes, the agents by type, the tools with up to 5 error kinds each (by name), the newest 200 failures: each cut in the query |
| `GET /api/pipeline` | `sessions`, `agents`, `turns`, `api_requests`, and `skill_defs` for an agent type's description | the scope is Skills' (the session, or the agents that started in the period); the roles are one `GROUP BY` role over those agents joined to their requests summed per agent (`json_group_array` for the types, `avg` for the mean duration), the edges one `GROUP BY` on the parent's role and the agent's; the agents behind a role are the scope's own rows (the studio lists them and fixes them one at a time), each with its `depth` in the delegation tree, from a recursive CTE that walks `agents.parent_id` up from each agent in scope (the ancestors need not be in scope; 32 levels at most, so a loop in `parent_id` ends) |
| `PUT /api/roles` | `role_rules`, `agents` | scope `agent`: `role` and `role_source = 'manual'` on the agent. Scope `type`: a rule is upserted on every project row with the name, then applied to the agents of that type in those projects' sessions unless they are `manual`, as one transaction (`updated` is those agents); the writer reads the rule on later spawns, so manual > rule > declared > map holds |
| `GET /api/lanes` | `sessions`, `agents`, `turns`, `api_requests`, `tool_calls` | one row per agent whose turns (with the model of the turn's first request) and calls are `json_group_array`s ordered by time, built by the query and read one row at a time; a call is a `tool_calls` row with a `turn_id`. A session of more than 5,000 calls is answered without its closed calls shorter than a thousandth of the time axis, which the studio draws as no bar and which cut no turn, and with `until`, where that axis ends (#90); a smaller one is answered whole, with no `until` |
| `GET /api/projects`, `GET /api/sessions` | `projects`, `sessions`; and `agents`, `turns`, `api_requests` for a session's tokens | a `GROUP BY` on the project's name; the newest 50 sessions first (`LIMIT 50` in a CTE), and only then their tokens |
| `GET /healthz` | `projects` | `SELECT 1 FROM projects LIMIT 1`: 200 `ok`, or 503 `history store unavailable` when the query throws |

**The memory soak (#90; in the gate since #85).** `pnpm soak` runs `packages/server/scripts/soak.ts`, which calls every GET API 40 times in one process, over real HTTP, on a synthetic session the size of the biggest real session (`synthetic-session.ts`: 1,301 agents, 46,000 calls, 2,100 turns, 43,000 requests, sixty days, still open), or on a copy of a real `history.db` with `--db`. It fails unless every route answers 200, the RSS after round 40 is within 20% of round 5 and under 256 MB, and no statement is prepared after round 2 (every route reuses the store's cached `prepare`, including the text and analysis stores). In Linux, on the server's base image: `docker run --rm --memory 1500m -v "$PWD":/repo:ro -w /repo node:22-alpine node --expose-gc packages/server/scripts/soak.ts`. It runs over HTTP and not `app.inject`: a loop of awaited injects never gives the event loop a turn, and light-my-request queues a `setImmediate` per request that pins its response until one does (a bare Fastify route answering 3 MB, injected 20 times in a loop, holds 126 MB of ArrayBuffers after a full GC, and 6 MB one turn later; over HTTP every request yields and none piles up). The 81 MB the lanes route seemed to keep after a full GC in #90 was that: its 3.2 MB answers, queued. CI runs `pnpm soak` after the tests.

**What it measured (2026-10-27, slice 4).** In `node:22-alpine`: RSS 142 MB at round 5 and 141 MB at round 40, PASS. In the compose container, on the same synthetic history written to its `history.db` (16.7 MB), with the 16 routes called 40 times over HTTP from outside: `VmRSS` 135 MB after round 5, 153 MB after round 40 (peak 163 MB), 154 MB after round 120, so it settles; 114 MB just after the start, before any request; `docker stats --no-stream` says 90.7 MiB after the 40 rounds, which leaves out the file cache. Node alone is about 94 MB of it before a database opens (the spike). #81 asked for a failure above 150 MB of RSS; the soak keeps #90's limit of 256 MB, because 153 MB on this history is over 150: the owner kept the no-growth check over a hard 150 MB line (2026-10-27). The server image went from 233 MB to 221 MB without `neo4j-driver`.

**The import's memory (#86).** `import <dir>` held a whole session in memory before it wrote it: a peak RSS of 510 MiB (535 MB) on the big corpus (one real project's Claude Code logs, 17 Aug to 24 Oct 2026, frozen for measurement: 15 sessions, 1,488 files, 1.3 GB, 144,047 events, the biggest session 128,763; every "the big corpus" in this file and in the code is this one), and 496 MiB for the reader alone with no store, so the store was never the cause. It reads each session as a stream now (`openSession` in `transcripts.ts`): a line at a time through one reused buffer, each event on its way to a batch of 500 as soon as the lines that make it are read, and kept only what a later line can still need. That is the last 8 messages (a message is one event, from its last line; all 37,042 repeated lines of the big corpus sit next to the one before), a call until its message is written and its result has come, a result whose call has not, one record per turn and per prompt id, and the ids the run has counted, which are a temporary table in the connection's SQLite file and no longer a `Set` (140 bytes an id: 19 MB more for 133,000 messages, so the peak grew with the history). What grows with a session is its prompts, a few hundred bytes each, and its unanswered calls; its messages do not.

*The order.* A session's events are written file by file, each in the order of its lines, with the session's `session.start` and each subagent's header last. A merge by ts across a session's files would need all of them open at once (1,300 in the biggest real session) and was not built: every one of these events is an upsert on its key, so the rows come out the same, which the checks below show. The one thing order decided was an agent's model, the first request written, so for an import the writer leaves it to the start and the spawn (`writeRows`, `turn.step`); the plugin's requests still fill it in.

*What stays the same.* Today's code and the new were run on the big corpus, on a second corpus of 34 sessions, and on random corpora of the line shapes Claude Code writes (resumed copies, results before their calls, repeated blocks, time going back, lines with no cwd), and every table and every `ingested` id was equal, the report too, and a second run accepted nothing. One thing differs by design: a message whose lines are more than 8 messages apart counts its later lines as a resumed copy's.

*The numbers (2026-10-27, Node 24, macOS, `/usr/bin/time -l`).* The big corpus: 510 MiB before, 114 to 127 MiB after (12 runs; 120 to 133 MB), in 11 s instead of 13. The soak's MB and this check's are MiB. `pnpm import-check` generates a session of 200,000 events, a main file and 24 subagent files (110 MB), and runs the CLI on it: 486 MiB before, 104 to 108 after; at 600,000 events, 101. It fails above 150 MB, and fails on the old reader. It is not in CI: the 150 MB is the one measured here, on this Node and this system, and the image's Node 22 on Alpine (whose idle RSS is higher: "Node alone is about 94 MB" above) has not been measured; add the step beside `pnpm soak` once it has.

*V8, which is why `runImport` tunes the process (`tame`).* With the stream and V8's defaults the peak was still 327 MB: the young generation doubles to 64 MB in the first busy second, and what a line leaves behind is promoted and freed only by a full collection that V8 puts off until the heap has grown 20 MB. `--semi-space-growth-factor=1`, set at run time, keeps the young generation at its first size (about 140 to 170 MiB), and a collection taken when the heap holds 8 MB more than after the last one, offered every 2 MB of log read and after each batch, ends the climb (37 collections, 77 ms, for the 1.3 GB). The history store's page cache is 1 MB and its WAL 800 KB for the import (the server keeps its 8 MB). The import also stopped loading zod: `@agent-orb/shared/classes`, `pricing.json` and `roles.json` are exports of their own, so the import does not load the schemas (19 MB of RSS, measured by loading the package index alone).

*The viewer's calendar.* SQLite knows UTC only. `api/local-time.ts` reads the zone's offsets from `Intl` and puts them in the query as a `CASE` over the instants the offset changes inside the window, so a request's local day is `date((ts + offset) / 1000, 'unixepoch')`, a week starts on Monday and a month on the first, as `date.truncate` did; a month's bounds (Worth, the goal) are local midnight on its first day and on the next month's. A window is walked by whole days from 2025-01-01 (Claude Code's logs begin there).

*Indexes.* The spike's 537 ms for Patterns was not the four joins but a table row fetched for every call to read its `success`. `calls_turn_success (turn_id, success)` answers the counts from the index, and a failure, a test run and a permission wait have a partial index of their own (`calls_failed`, `calls_tests`, `calls_waits`), a few percent of the table; `agents_spawn`, `skill_loads_turn` and `session_prs_pr` serve Skills and Worth. `project_id` was not added to the fact tables: it would have cost about half again the file for nothing the indexes do not give. Measured on the big corpus (15 sessions, 144,047 events, 46,473 calls, 38 MB), Patterns takes 53 ms, where the spike's SQL takes 205 ms on the same file.

**Differences from v0.2's graph.** A session is on one project, the first an event named (then the re-home), where the graph could hang it on several. The lists (`/api/projects`, `/api/sessions`) put a session with no start time last, where the graph's `DESC` put it first. The re-home also moves the stub's `files_touched` to the new project key, which the graph never did. The writer applies a batch's events in `ts` order, one statement per event, and the import's writes and the plugin's are one transaction per batch, as the graph's were.

### Nodes

The logical model: what the tables hold, named as nodes and relationships (the "Tables and keys" above say which table each is).

- `User {id, name}` · `Team {id, name}` · `Host {id, name}`
- `Project {id, name, git_remote?, cwds, goal_usd?}` — `cwds` is every distinct `project.cwd` seen for it (v0.2); `goal_usd` is the project's monthly goal in API-equivalent dollars, set by `PUT /api/goal` on every Project node with the name and absent when there is none (v0.2 slice 3)
- `Session {id, started_at, ended_at?, model, claude_version, source, recorded?}` — `source` is the first `session.start` source seen (`import` for a session the import made); `recorded` is `true` once any `session.start` with another source arrived. A session counts as the plugin's when it has no `source` or one that is not `import`, or `recorded` is `true`; the import sends only the events of such a session outside the stretch the plugin recorded (v0.3: the first to the last prompt, request or tool call the plugin itself wrote, kept by the store; see "The store"; a minute wider each side), and its `session.start` never overwrites the session's model, version or content (v0.2)
- `Change {id, ts, files, hashes?, source, sha?, subject?, scope?}` — a change to what the project watches (its agents, skills, `CLAUDE.md`; the owner's `~/.claude/CLAUDE.md` and rules). `source: 'git'`: a commit, `id` is `<project id>:<sha>`, `hashes` its files' blobs (slice 3). `source: 'fingerprint'` (slice 3): a file the plugin saw with another hash than last time, or gone; `id` is `<project id>:fp:<path>:<hash>`, `ts` the fingerprint event's, `files: [path]`, `hashes: [hash]` (`'deleted'` for a deletion), `scope`. `GET /api/trends` groups them into one change per project and local day (v0.2)
- `Fingerprint {id, project, cwd?, path, scope, hash, ts}` (v0.2 slice 3) — the last hash seen for a path. A project file (`scope: 'project'`) is kept per checkout, because the main checkout and each git worktree on another branch have their own `.claude/` and sessions alternate between them: `id` is `<project id>|<cwd>|<path>`, `cwd` the event's `project.checkout`, or its `project.cwd` when it has none, so a checkout's first event is its own baseline and a deletion is judged within that checkout. The owner's files (`scope: 'user'`, read alike by every checkout) are kept per project: `id` is `<project id>|<path>`, no `cwd`. `hash` is `'deleted'` once the path went missing, `ts` is when this hash was first seen. A path seen for the first time is a baseline and makes no Change; a known path with another hash is updated and makes a fingerprint Change; a known path missing from an event makes a deletion Change, judged within the scope (project or user) of the paths the event lists and only for a scope it lists at least one of (an event with no home to read deletes none of the owner's files); the same path in a later event while deleted makes none. Events in a batch are folded in time order. Idempotent: the same files again change nothing, and a Change's id by project, path and hash (not checkout) means one edit seen in two checkouts is one Change, dated at the latest sighting, and a version that comes back keeps its latest Change. A `git switch` inside one checkout is an edit there and reads as a change.
- `PullRequest {id, number, title?, merged_at?, additions?, deletions?, head?, size?}` (v0.3 slice 2, #42, Worth) — `id` is `<project id>:<number>`, one per project and number. `project.prs` creates or updates it and links `(Project)-[:MERGED]->`; its properties are coalesced, so a list with no titles (an excluded project's) keeps the ones sent before. `session.pr` makes the node if it is not there, with its `number` alone, and links `(Session)-[:OPENED]->`: a PR gh never listed as merged has no `merged_at` and no `MERGED` link, and is no row in Worth. `counted_lines` and `counted_files` (#103) are what the plugin counted, coalesced like the title. `size` is `'S' | 'M' | 'L' | 'XL' | 'skip'`, set only by the owner (`PUT /api/worth/size`); no event touches it. `session_prs` carries `ts`, the earliest time the session was seen to name the PR (the plugin's event, or the import's first `pr-link` line); a row from before #103 has none until one `import <dir>` run over the owner's Claude Code logs gives it one (Worth, below). The columns added since a file could exist are added at open (`store.ts`).
- `Prompt {id, ts, length}`
- `Agent {id, type, description?, model, role?, role_source, started_at, ended_at?, declared_model?, allowed_model?, check_source?, pricier?}` — the main agent is `Agent {type:'main'}`; `pricier` is `true` when the spawn carried a `model_check`, with `allowed_model` and `check_source` from it and `declared_model` as the file wrote it (v0.2 slice 2; a later spawn event for the same agent, the import's, never erases them)
- `Turn {id, started_at, duration_ms}`
- `ApiRequest {id, ts, model, input, output, cache_read, cache_creation, cost_usd}`
- `ToolCall {id (tool_use_id), tool, ts, duration_ms, success, error_type?, error_class?, error_shape?, command_class?, input_size, output_size}` — `command_class` is on a Bash call, `error_class` on a failed one (v0.3 slice 1) and `error_shape` on a failed one with a shape (slice 3, §5 Classes); a later event that says none of them keeps what is stored
- `Tool {name}` · `Skill {name}` · `File {path}` · `Task {id, subject, status}`
- `SkillDef {id, name, kind: skill|agent, source, plugin, tokens, description, calls_skills, calls_agents, preload}` (Slice 5): a skill or custom agent as a session lists it, one per project, kind, origin and name

### Relationships

```
(User)-[:OWNS]->(Session)            (Team)-[:HAS_MEMBER]->(User)
(Session)-[:ON_PROJECT]->(Project)   (Session)-[:ON_HOST]->(Host)
(Session)-[:HAS_PROMPT {order}]->(Prompt)
(Session)-[:HAS_AGENT]->(Agent)      (Agent)-[:SPAWNED {at, via_tool_use}]->(Agent)
(Prompt)-[:HANDLED_BY]->(Agent)
(Agent)-[:RAN]->(Turn)               (Turn)-[:REQUESTED]->(ApiRequest)
(Turn)-[:CALLED {order}]->(ToolCall) (ToolCall)-[:NEXT]->(ToolCall)
(ToolCall)-[:OF_TOOL]->(Tool)        (ToolCall)-[:INVOKED_SKILL]->(Skill)
(ToolCall)-[:SPAWNED_AGENT]->(Agent) (ToolCall)-[:TOUCHED {mode:'read'|'write'}]->(File)
(Agent)-[:WORKED_ON]->(Task)         (Project)-[:CHANGED]->(Change)
(Project)-[:MERGED]->(PullRequest)   (Session)-[:OPENED]->(PullRequest)
(Turn)-[:LOADED_SKILL {ts, how, source}]->(Skill)        (Session)-[:LISTED]->(SkillDef)
```

Keys and indexes are the tables' (`store/schema.sql`); the writer upserts one batch in one transaction.

**The monthly goal (v0.2 slice 3).** API-equivalent dollars per project per month; nothing is ever stopped.
- `GET /api/goal?project=<name>&tz=<IANA>` → `{ project, month: 'YYYY-MM', goal: number | null, spent: number, costPartial: boolean }`. `month` and `spent` are for the current month in `tz` (UTC without one): `spent` is the API-equivalent cost of the project's requests (by project name, every project row with it) from midnight on the month's first day in `tz` to now, and `costPartial` says a request on an unpriced model is missing from it, so it is a floor. `goal` is `Project.goal_usd`, `null` when none. An unknown project answers `goal: null, spent: 0`.
- `PUT /api/goal` `{ project, usd }`, from the studio only (a request carrying another site's `Origin` is refused, 403): `usd` above 0 and at most 1,000,000, or `null` to clear; sets `goal_usd` on every project row with that name; 404 for an unknown project, 400 for anything else.
- The plugin asks `GET /api/goal` at session start and every 60 s from its 2-second timer, never on a hook's path; a failure changes nothing and the last answer stays.

A session the import files under a project it knows no remote for gets the project `<host>:<cwd>`. When the plugin first reports that cwd with its remote, the writer moves the stub's sessions (and any role rule on it) to the project the remote names and deletes the stub, with its Changes and Fingerprints (v0.2). In the store it moves the stub's touched files too.

**Worth (v0.3 slice 2, #42; §15, 2026-10-25).** Is it paying off? The owner's rate, plan price and PR sizes against what the logs measured; every figure that is the owner's is labelled so in the studio.
- **The owner's numbers** (`GET` shows them as `settings`): `rate` (dollars an hour), `plan` (dollars a month, the price of the plan, not the API-equivalent), both `null` until set, `sizes` (the hours behind S, M, L and XL; 0.5, 2, 6 and 16 by default) and `cuts` (#103: the score each of S, M and L is below, 300, 1,500 and 6,000 by default; XL is from L's). They live in the analysis store's SQLite file (`content.db`, table `analysis_settings`, key `worth`) beside the cap, and nowhere else: not in the graph, not in an event.
- `GET /api/worth?project=<name>&month=YYYY-MM&tz=<IANA>` → the month is midnight on its first day to midnight on the next in `tz` (UTC without one), read by project name (every project row with it). `project` and `month` are required, 400 otherwise.
  ```
  { settings: { rate: number|null, plan: number|null, sizes: { S, M, L, XL }, cuts: { S, M, L } },
    month: 'YYYY-MM',
    attentionHours, waitsHours, prompts, days, apiCost, costPartial,
    prs: [{ number, title: string|null, mergedAt (epoch ms), additions, deletions, countedLines: number|null, countedFiles: number|null, size: 'S'|'M'|'L'|'XL'|'skip'|null, yours: boolean, sessions, agents, cost }],
    releaseMerges,
    sized, total, byHandHours, netHours, value: number|null, return: number|null }
  ```
  - `attentionHours` is the owner's attention, a floor: **prompt windows** (the prompts of the project's sessions, taken together as one person's, with `ts` in the month: 2 minutes a prompt, plus every gap between two consecutive prompts under 10 minutes, which counts as working; exactly 10 minutes does not, and a gap never reaches across the month's edge) **plus permission waits** (the `duration_ms` of the ToolCalls with `waited` and `ts` in the month, the ceiling of the wait, each counting at most 10 minutes as a gap between prompts does: a dialog left open longer means nobody was there, #76). `waitsHours` is the waits part of it. `prompts` is the number of prompts and `days` the number of local days in `tz` they fall on.
  - `apiCost` is the API-equivalent cost of the project's requests in the month; `costPartial` says a request on an unpriced model is missing, so it is a floor.
  - `prs` is the PRs merged in the month (`merged_at` in `[start, end)`), newest first. A PR gets its share of each session that linked it (#103): a link owns the slice of the session after the session's previous link (by time, then PR number) up to and including its own. `sessions` is the number of sessions with a `session.pr` for it, `cost` the API-equivalent cost of the requests whose `ts` falls in its slices, `agents` the agents that started in them (the main agent starts with the session, so it is in the first slice). The slices of a session do not overlap, so the shares of its PRs add up to the session up to its last link; what came after the last link is no PR's. A link with no time (made before #103) owns the whole session, as every link did, until its time is filled in: the store keeps no raw events, only their ids, and the import makes the same id from the same `pr-link` line, so a `session.pr` event whose id is already stored still sets its link's time when the stored one is null or later (`UPDATE … WHERE ts IS NULL OR ts > :ts`, in the writer, so `POST /ingest` and `import <dir>` both do it) and the rest of a duplicate is skipped. **One `import <dir>` run over the owner's Claude Code logs gives the links stored before #103 their times.** Two PRs named at one instant: the lower number takes the slice. A link to a PR gh never listed still ends the slice before it. `size` is the one in force: the owner's when `yours`, else the score's, `null` when the PR has no counts; the score is `counted_lines × (1 + log₂ counted_files)` with files below 1 read as 1 (so a PR whose files were all set aside scores 0 and is S), S below `cuts.S`, M below `cuts.M`, L below `cuts.L`, XL from there. A PR is left out of the rows, `total`, `sized` and the hours when its head starts `release/` or its title opens `chore(release)`, `chore: merge ` or `Merge `; it stays in the store. `releaseMerges` is how many of the month's PRs that rule left out (each counted once, whichever of the four rules it meets); the studio says it in "How a size is chosen" ("are left out: 18 in October").
  - The studio draws the PRs by size under the six figures, one row per size ("S · 12 PRs, 6 h, 0.5 h each"): the PRs that are that size (a skip and an unsized PR are none) and their hours, which add up to the PRs sized and to `byHandHours`.
  - `total` is `prs.length`; `sized` the PRs that have a size, the owner's (a Skip is an answer) or the score's, so `total - sized` is the PRs with nothing counted yet. `byHandHours` is the sum of their hours (`settings.sizes`), skips adding none.
  - `netHours = byHandHours - attentionHours`; `value = netHours * rate`; `return = value - plan`. `value` is `null` until a rate is set, `return` until a rate and a plan are. A losing month is negative, and so is a month whose attention beats the hours by hand.
- `PUT /api/worth/settings` `{ rate?, plan?, sizes?, cuts? }`, from the studio only (a request carrying another site's `Origin` is refused, 403): `rate` above 0 and at most 100,000; `plan` 0 to 1,000,000; each of `sizes.S/M/L/XL` above 0 and at most 1,000 hours; each of `cuts.S/M/L` above 0 and at most 10,000,000, and going up (S < M < L) once merged with the cut points already kept; `null` clears a rate or a plan, a size or a cut point not named keeps its value; 400 for anything else, and a refused body changes nothing. Answers the settings.
- `PUT /api/worth/size` `{ project, number, size }`, from the studio only: `size` is `'S' | 'M' | 'L' | 'XL' | 'skip'`, or `null` to take it back; sets it on the merged PR of every project row with that name; 404 when there is none (a PR only a session mentioned is not merged), 400 for anything else. Answers `{ project, number, size }`.
- A session is the fallback for work that never became a PR (§15, 2026-10-25); it is not built yet.

**Failure patterns (v0.3 slice 3, #45; §15, 2026-10-25).** What keeps failing, over a project's whole history, read from the store's classes, shapes and files, so it works with Content off.
- `GET /api/patterns?project=<name>` → by project name (every project row with it); 400 without a project, 404 for a project no session was seen on.
  ```
  { calls, failed,
    kinds: [{ errorClass, count, commands?: [{ commandClass, count }] }],
    repeats: [{ shape, tool, errorClass, commandClass: string|null, count, sessions, lastAt (epoch ms), sample: string|null }],
    testsEditedAfterFailure: { count, sessions } }
  ```
  - `calls` is every tool call of the project's sessions and `failed` those with `success: false`.
  - `kinds` is the failed calls by `error_class`, most first, equal counts by name. A failed call with no class (from before slice 1) counts as `other`, so the counts add up to `failed`. `commands` is on `exit_code` only: the Bash calls that ran and exited non-zero, by `command_class` (`other` for a call with none), most first, equal counts by name; a class with no call is left out.
  - `repeats` groups the failed calls that have a shape by `(error_shape, tool)` and keeps the groups of 3 or more calls, the top 10 by `count`, then `sessions`, then `lastAt`, then `shape`. A named shape groups across tools (`hook_blocked` on Write and Edit is one repeat). `tool`, `errorClass` and `commandClass` are the group's most frequent value (equal counts: the first by name), `commandClass` null when no call has one. `sessions` is the number of distinct sessions, `lastAt` the start of the group's latest call. `sample` is the first meaningful line (as for the hash, tags dropped) of the output of the group's newest call whose output the text store holds (Content on full; masked already; looked for among the newest 50), cut to 120 characters, else null.
  - `testsEditedAfterFailure`: a `test`-class Bash call that failed with `exit_code`, then, in the same agent, a write (`TOUCHED` with mode `write`) to a test file before that agent's next `test`-class call, whether that one passes or fails. `count` is those writes, and `sessions` the sessions they are in. A write after a passing run, after a run that never ran (`unknown_command`, `refused`, a timeout) or in another agent than the failing one is not counted. A test file is one in a directory called `test`, `tests`, `__tests__` or `e2e`, or with `.test.` or `.spec.` in its name.
  - ponytail: calls are ordered by when they started, so a test file written in the message of the run counts; and the path rule misses a repo that keeps its tests elsewhere.

**Unbacked claims (v0.3 slice 4, #44; §15, 2026-10-25).** Did the agent do what it says it did? With Content on `full`, the test, build and edit claims in the main agent's final answer and in each subagent's report are checked against that agent's own calls. Nothing is checked without the text, and a session without Content on `full` reads "not checked", never "clean". No drift check and no model: those are v0.4 (Analysis v2).
- **The text.** An agent's final answer is the `answer` of its last `turn.step` request (the content store's `request:<id>`, field `answer`), which the plugin already sends with Content on full: nothing in `packages/mod` changed. For a main agent it is the last request of the turn that `turn.complete` (reason `answer`) ends, for a subagent the last request at or before its `agent.complete`. A subagent that hands back through a tool (`StructuredOutput`, `SubagentHandback`) has no answer text and is not checked. The import carries no text, so an imported session is never checked.
- **A claim** is found by a regex per kind (`claimsOf`, `packages/server/src/claims.ts`), one claim of each kind per sentence, with fenced code left out. *Test:* "all 48 tests pass", "the suite is green", "1550 unit tests pass", "921/921 pass", "966 passed", "vitest passes", "E2E green". *Build:* "typecheck is clean", "tsc passes", "the build succeeds", "production builds: all three pass", "no type errors". *Edit:* a file named after "I added/edited/updated/changed/fixed/wrote/created/…", and, in a subagent's report only, a sentence or bullet that starts with the verb ("Fixed the totals in `plan.ts`"): in a main agent's answer that form is as likely the story of an earlier turn or another agent, and "the implementer updated plan.ts" or "plan.ts was updated" is nobody's own. A sentence that says what was not done, what would or should be, or what a CI run said ("all six checks green", a PR number, "CI") is no claim, nor is one that mixes in a failure ("typecheck passes but two tests fail", while "0 failed" is not one); nor an edit made "with a script", `sed` or `python`, which Edit and Write leave no trace of; nor a file outside the working tree. ponytail: words, not grammar: it finds a status line's plain phrasings and misses the rest, and where a missed claim and a false flag pull apart it misses.
- **The scope.** A main agent's answer is held to its calls in that turn, a subagent's report to all its calls (those made no later than the answer). A main agent's edit claim also counts its writes in the turns before (a recap names a file written once, not once per turn). A turn that restates an earlier result holds no claim against a run it had no need of (below).
- **The rule** (`verdict`). *Test and build:* after the agent's last edit to code or tests, the last run of that kind (a Bash call of command class `test` or `build` that ran: not refused, not an unknown command, not a missing path) must have succeeded. None after it is `no_run` (none at all) or `stale` (only before the edit); a last run that failed is `failed`. An agent that edited no code has changed nothing a run has to cover, so only a failed last run flags it. A passing `test` run also backs a build claim, because a chain (`pnpm test && tsc`) has the class of its first link; an agent that handed work to a subagent (`Agent`, `Task`, `Workflow`) after its last edit is not held to a run, since its report may be that agent's run, which is checked against its own calls. *Edit:* a successful write to the file it names by this agent (`files_touched`, mode `write`, matched by its end: `plan.ts` is `src/lib/plan.ts`), `no_write` otherwise; an Edit or Write that succeeded and recorded no path wrote outside the working tree and may be that file, a Bash call of class `other` (a `python3` heredoc, `sed -i`) may have made the edit, and a hand-off may have: each backs the claim. ponytail: any such call backs every edit claim of its agent, so the check catches the agent that never wrote anything and never ran a shell command; the big corpus made 2 of its 5 edit claims through Python.
- **Not code.** Only an edit to code or tests breaks a test or build claim. Notes, PR bodies and memory files do not (the big corpus's only two flags were exactly those): `isCode` is a rule on the path, where prose and notes are `.md`, `.mdx`, `.txt`, `.rst` and `.adoc` files, anything in a `docs/` or `notes/` folder, and the files named README, CHANGELOG and LICENSE. ponytail: a document that is a test fixture reads as not code, and a note kept in a `.json` or `.yml` file reads as code.
- **Where it is computed, and why.** At ingest, in `POST /ingest` after the batch is written (`checkAnswers`): the answer that ended is checked against the calls already stored, and one row per claim goes to `claims` (kind, the file an edit claim names, backed or not, `why` with the last code edit's and the last run's time, the answer's time), so Live, Needs you, History and Patterns are queries and none reads the text to count. The words are text, so they are not in `history.db`: the row keeps where they sit (`request_id`, `at`, `len`) and a view cuts them from the answer in the text store. Rows are replaced per answer, so a batch sent again gives the same rows; a check that throws is logged and never fails the batch. ponytail: a call that reaches the store after its agent's end is not in the check (the plugin's outbox is FIFO, and a resent batch reruns it).
- **Reads.** `GET /api/history` adds items `{ kind: 'claim', claim: 'test'|'build'|'edit', ts, backed, phrase?, why?, file?, editTs?, runTs? }` to an agent's timeline. `GET /api/patterns` adds `claims: { sessions, checked, test|build|edit: { total, unbacked } }`: `checked` of the project's `sessions` had Content on full, so 0 reads "not checked". The live state (`/stream`) gives an agent `unbacked: [{ kind, phrase, why, ts, file?, editTs?, runTs? }]` for its last answer, until its next turn starts.
- **The studio** (the current layout; the readable restyle is #80). Live: an agent whose last answer holds an unbacked claim reads "unbacked claim" in red in the state column, in place of done and of waiting for a prompt, its row says `Said "all 48 tests pass"` and why (`no test ran after its last code edit, at 14:02`), and the header tally counts it (only when there is one: a 0 would read as clean). Needs you lists it after what blocks you and before the pricier models. The history drawer marks it in the timeline and under Failed, with the longer reason (`the last test run (13:58) came before the code edit at 14:02`). A session without Content on full carries a "claims not checked" chip in Live, and its drawer says so. Analysis, Patterns: a fifth stat, "Unbacked claims: N of M test claims", with the builds and edits beside it, and "not checked" for a project none of whose sessions had Content on full.
- **Checked on the big corpus.** The same `claimsOf` and `verdict`, run over the final answers and reports in the big corpus (735: 707 main turns and 28 subagent reports with text; 67 of them make a claim), found 60 test, 43 build and 5 edit claims and no unbacked one. Only 15 of the 103 test and build claims were made after a code edit by an agent that then ran the check; the other 88 had no code edit in scope, and 19 of those had no run of their kind either (status lines such as "Suites: 1001 unit, 317 emulator, E2E green", which restate an earlier turn): the strict reading, which demands a run whatever the agent edited, flags them, and they are why the rule above does not. The first version of the rules flagged 26 (13 test, 8 build, 5 edit); by hand, none was real: 19 had no code edit in scope and no run (those status lines, and a subagent's gate whose build ran inside a chain), 2 followed a `pnpm test && tsc` chain whose class is `test`, and the 5 edit claims were of files written outside the working tree, through a script, or in an earlier turn. The planted cases are in `packages/server/test/claims.test.ts`.

### Reference queries

For your own questions: open `history.db` from a backup in any SQLite client (`sqlite3 ~/agent-orb-backups/<date>/history.db`). Times are epoch ms.

```sql
-- Tokens and cost per agent in a session
SELECT a.id, a.type, a.role, a.model, sum(r.input + r.output + r.cache_read + r.cache_creation) AS tokens, sum(r.cost_usd) AS usd
FROM agents a JOIN turns t ON t.agent_id = a.id JOIN api_requests r ON r.turn_id = t.id
WHERE a.session_id = :sid GROUP BY a.id ORDER BY tokens DESC;

-- Subagent tree: how many agents sit at each depth under the main one
WITH RECURSIVE tree(id, depth) AS (
  SELECT id, 0 FROM agents WHERE id = :sid || ':main'
  UNION ALL SELECT a.id, tree.depth + 1 FROM agents a JOIN tree ON a.parent_id = tree.id)
SELECT depth, count(*) AS agents FROM tree GROUP BY depth;

-- Tokens and cost per project per week (UTC, a week starts on Monday)
SELECT p.name, date(r.ts / 1000, 'unixepoch', 'weekday 0', '-6 days') AS week,
       sum(r.input + r.output + r.cache_read + r.cache_creation) AS tokens, sum(r.cost_usd) AS usd
FROM api_requests r JOIN turns t ON t.id = r.turn_id JOIN agents a ON a.id = t.agent_id
JOIN sessions s ON s.id = a.session_id JOIN projects p ON p.id = s.project_id
GROUP BY p.name, week ORDER BY week DESC, tokens DESC;
```

---

## 7. Pipeline roles

A role is a property of `Agent`, set by the server, correctable by hand. Precedence:

1. **Declared**: the agent definition (`.claude/agents/*.md` of the project or a plugin) carries `orb-role: orchestrator|developer|researcher|reviewer|skeptic|tester|planner|writer|ops` in its frontmatter; the mod reads it when the file is reachable.
2. **Static map** for known types in `roles.json` (extensible): `Explore` → researcher, `Plan` → planner, `claude-code-guide` → consultant, `general-purpose` → generalist, the main agent → orchestrator.
3. **Manual override** from the studio, stored on the node (`role_source: 'manual'`).

Behavioural inference (reading the tools an agent used) comes after v0.1. Known ceiling until then: workflow agents that are all `general-purpose` show as one role, unless corrected by hand.

---

## 8. Studio — the web UI

One React app served by the server. Every view is mocked up (desktop and phone) in `design/` and approved before it is built.

### 8.1 Live (first)
- One row per agent of the running sessions, nested under its parent: type/role, `description`, **model**, tokens, API-equivalent cost, current tool and how long it has run, time since the last event, state (`working`, `waiting` for you, `stalled`, `done`, `error`).
- Session header: total tokens, API-equivalent cost, context used (%).
- Stalled rows are red; done agents fade after a while.
- v0.3 slice 4 (#44): an agent whose last answer holds an unbacked claim (§6) reads "unbacked claim" in red, with what it said and why, in its row and in Needs you; a session without Content on full says its claims are not checked.
- Data from `/stream` (SSE); target latency under 1 s from the event.

### 8.2 Ledger
- Tokens first, then API-equivalent cost, per project / model / role / day-week-month (per person once there are teams).
- Efficiency: tokens per file changed, failed tool calls %, time waiting, cache share.

### 8.3 Pipeline (per project)
- Org chart by role (§7) over a session, day or week: nodes with role avatar, agent count, tokens, cost, mean duration; edges as thick as the tokens delegated; click → the agents and sessions behind a role; role correction in place.
- Instance view: the same chart for one session, with a swimlane timeline per agent below.
- Skills scope (a Roles | Skills switch, same project picker): every skill the project's sessions list (project, user, plugin, built-in, tagged by origin) and the agent types they dispatch. Dashed edges are what a skill's text says it can call; solid edges are what it did call, as thick as the times or tokens. A skill that never ran shows its listing tokens per session.

### 8.4 Office (pixel art)
- One floor (v0.1 is one user), one room per project. A floor per person or host comes with teams.
- Each agent is a Kenney CC0 bot at a desk. States: `typing` (Edit/Write/Bash), `reading` (Read/Grep/Glob), `browsing` (Web*), `thinking` (between tool calls, a "…" bubble, never the thinking text), `delegating` (walks to the child's desk and back), `waiting` (amber bubble), `stalled` (red bubble), `done` (green check, leaves), `error`.
- The main agent has the big desk; subagents sit near their parent; the office grows with spawns.
- Overlay: session tokens, API-equivalent cost, context bar, each bot's current tool.

### 8.5 In the terminal (the mod)
- Status line: `👥 3 · 412k tok · ctx 61%`, or `⚠ Explore: WebFetch 16m` while something is stalled; failing that, `⚠ implementer on Opus, file says Sonnet` (or `⚠ workflow agent on Opus, ceiling Sonnet`) while an agent runs on a pricier model (v0.2 slice 2); failing that, `⚠ mobile-app over its October goal: $2,540 of $2,500` once the project's month is past its goal (whole dollars). From 80% of the goal the normal line ends with the month and the percentage, `👥 3 · 1.2M tok · ctx 41% · Oct 81%` (v0.2 slice 3). Each new state sends one notification, as a stall does: at 80% (`mobile-app is at 81% of its October goal ($2,029 of $2,500)`) and past 100%, each at most once per project and month, remembered in the plugin's store.
- `/orb` opens a compact panel: active agents, current tool, tokens, last 10 events, the studio URL.
- Settings live in Claude Code's plugin config menu (`userConfig`): endpoint, token, stall minutes (default 15), model ceiling (default Sonnet).

---

## 9. Security and privacy

- v0.1: the server listens on 127.0.0.1 only. One token (`ORB_TOKEN` in `deploy/.env`) is required on `/ingest`; the studio has no login.
- The history is two SQLite files in a Docker volume on the owner's machine, and no database port is open; the owner queries a backup's copy with any SQLite client.
- Metadata only (§5). The server overwrites `user_id`/`team_id` from the token.
- Later, with teams: a token per machine tied to a user, revocable; per-user studio login; an opt-in `full` content mode with secret redaction, visible only to its owner.

---

## 10. Deploy

`deploy/docker-compose.yml` runs one service:
- `orb-server`: image `ghcr.io/alfredo1996/agent-orb-server:<version>` (built locally while developing), port `127.0.0.1:4040:4040`, env `ORB_TOKEN`; the volume `orb-content-data` at `/var/lib/agent-orb` holds both SQLite files, `history.db` (the history) and `content.db` (the captured text and the reports). The volume keeps the name it had when it held `content.db` alone, so a machine that ran an earlier version keeps its text.

Install at launch: `docker compose up -d` → in Claude Code, `/plugin marketplace add alfredo1996/agent-orb` and `/plugin install agent-orb` → set endpoint and token in the plugin config menu → the main agent appears in Live.

While developing: `docker compose up --build`, and the mod loaded through `CLAUDE_CODE_PLUGIN_DIRS` / `--plugin-dir`.

Backup (v0.2 slice 4, §15 2026-10-24; v0.3 slice 4, #85): `deploy/backup.sh run` writes `~/agent-orb-backups/<YYYY-MM-DD>/` and keeps the newest 7 (`ORB_BACKUP_KEEP`).
- Both files are copied with `VACUUM INTO`, a consistent snapshot while the server runs: inside the `orb-server` container when it runs (`compose exec`, then `compose cp`, then the snapshot is removed from its volume), and in a one-off from the container's own image when it is stopped. Nothing is stopped, so the plugin's outbox has nothing to queue. A volume that lacks either file (the server has not started yet) fails the backup, and nothing is published.
- It writes into `.partial-<date>` and renames it only when complete, so a failed run leaves the earlier folders as they were; the one summary line gives the folder and both sizes.
- `install` schedules it daily at 03:30 as a launchd agent on macOS (`install --dry-run` prints it, `uninstall` removes it) and prints the crontab line on Linux. It is opt-in; nothing is scheduled by `docker compose up`.
- `deploy/restore.sh <folder>` refuses a folder that lacks `history.db` or `content.db` (a v0.2 folder, with a `neo4j.dump`, is said plainly to be unrestorable here), asks, stops `orb-server`, copies both files back beside the old ones and renames them over, dropping the old files' `-wal` and `-shm`, then starts `orb-server`.
- Neither script pulls or builds an image: every one-off runs from the image of the stack's own container, so the stack must have been started once. Settings, by environment variable: `ORB_COMPOSE_FILE`, `ORB_COMPOSE_PROJECT`, `ORB_BACKUP_DIR`, `ORB_BACKUP_KEEP`. A drill points them at a throwaway project; the real volumes are never needed.

---

## 11. Work plan

v0.1 is the doc's v1 minus the cuts below, built in slices. Each slice ends with a local preview on the owner's Mac before the next starts. The repo goes public when all acceptance criteria (§12) pass.

**Slice 0 — Foundations**
- [ ] Private repo `alfredo1996/agent-orb`, `main` for releases, `dev` for integration; pnpm workspaces; MIT license.
- [ ] `packages/shared`: Zod event schema, `pricing.json`, `roles.json`.
- [ ] Compose with an empty server; the schema.
- [ ] Server: `/ingest` (validation, token, idempotency), batched writer, `/healthz`.
- [ ] Test: a synthetic events file → the expected graph.

**Slice 1 — Mod + Live** (mockup first)
- [ ] `register.tsx` hooks → Events; outbox with flush, batch and retry.
- [ ] Stall timer → status line, notification, `stall.*` events.
- [ ] Status line, `/orb` panel, `userConfig`.
- [ ] `/stream` SSE with live state; studio Live view.
- [ ] Empirical checks in `docs/verified.md`: exact `tool.call` result fields; `tool_use_id` on `agent.spawn` for Agent vs Workflow; `turn.step` for subagents with `agentId`; behaviour under `claude -p`; whether the panel draws in the terminal, the desktop app and VS Code.

**Slice 2 — Ledger** (mockup first)
- [ ] `/api/ledger`; the Ledger view.

**Slice 3 — Pipeline** (mockup first)
- [ ] Role assignment (§7) and override; `/api/projects/:id/pipeline`; the Pipeline view with the instance swimlane.

**Slice 4 — Office** (mockup first)
- [ ] Canvas renderer with Kenney sprites, animation state machine (§8.4), one floor with a room per project, overlay.

**Slice 5 — Skills graph** (mockup first)
- [ ] The mod sends the session's skill and agent catalogue (`$.session.usage` breakdown, free) and each loaded skill's references (from `skill.prompt`'s text and frontmatter); probe whether an unrun skill's text can be read.
- [ ] Skills per project in the graph, declared `CAN_CALL` edges, observed calls derived from Skill calls and spawns within a turn; `/api/skills`; the Pipeline's Skills scope.
- [ ] Skill usage: each skill's runs, when, how (typed, called by the model, by an agent, preloaded), tokens and cost, most to least used, and the listing cost of the ones never used.

**Slice 6 — Live, redesigned** (mockup first)
- [ ] One card per agent: what it is doing now in words, the skill it runs, tokens; a tap opens its history beside it (what it did, what failed, what is left).

**Slice 7 — Analysis with Claude, run by hand** (mockup first)
- [ ] A project's week, read by Claude through the Anthropic API (key in `deploy/.env`, set by the owner): where tokens go, skills that waste them, repeated failures, changes to try; kept as a report.
- [ ] Never automatic: Run shows the measured input (token-counting endpoint) and the estimated cost, nothing is sent before Confirm; a monthly cap blocks runs past it; every run lands in the Ledger.

**Slice 8 — Launch**
- [ ] Public brand chosen; README (with a not-affiliated-with-Anthropic line and the minimum Claude Code version), demo GIF.
- [ ] Server image on GHCR on each tag; `.claude-plugin/marketplace.json`.
- [ ] Repo made public.
- [ ] Published from a fresh repository (the tree as one first commit); this one stays private as the archive, with its issues and PRs (decided on #99).

**After v0.1:** the versions approved on 2026-10-22 (§15): v0.2 Measure, v0.3 Explain, v0.4 Share, v1.0 The loop, each mockup first and each ending on a check run on real sessions. They take in everything cut on 2026-10-19 except XP and badges and sounds, which stay out. (`full` content mode shipped as the opt-in capture in #5.)

---

## 12. Acceptance criteria for v0.1

| | Criterion | How it is checked |
|---|---|---|
| A | The main agent appears in Live within 2 s of a session starting; a subagent appears under its parent when spawned | E2E: post a `session.start` and an `agent.spawn`, time the rows; then by hand in a real session |
| B | After a session the store holds its Session, Agent, Turn, ApiRequest and ToolCall rows matching what happened | Writer test on a recorded event file; an SQL check after a real session |
| C | Token totals in the store match the usage recorded in that session's transcript within 1% | A script sums the transcript's per-message usage and compares it with the store |
| D | A tool running past the threshold is flagged within 1 minute | Mod test on a mocked clock; by hand with the threshold at 1 min and `sleep 90` |
| E | With the server stopped for 5 minutes nothing is lost and Claude Code never slows | Stop the server mid-session, restart it, count events; hooks return without awaiting the network |
| F | `docker compose up -d` plus installing the plugin is the whole setup; nothing paid | A clean run on the Mac from the README alone |
| G | The Pipeline of a project with 5+ sessions shows sensible roles, and they can be corrected | By hand on a real project's own sessions |

---

## 13. Edge cases

- **Waiting for you is not a stall.** A main agent at the prompt, or blocked on a permission dialog, is `waiting`. The stall timer counts only an in-flight tool call, or an agent mid-turn with no event.
- **Long legitimate tools** (a test suite) trip the alert at the threshold; the threshold is configurable. `run_in_background` Bash returns at once, so it is never in flight.
- **Workflow agents**: their `agent.spawn` `tool_use_id` is the Workflow call, shared by the whole run; the parent is the agent that called Workflow.
- **Nested subagents**: `parent_agent_id` chains to any depth.
- **Mod hot reload** resets module variables; the outbox is persisted, so nothing queued is lost.
- **Server down for days**: the outbox is capped at 100,000 events; past that the oldest are dropped and the count is sent as one event when the server returns.
- **Duplicates** after a retry are ignored on `id`.
- **Concurrent sessions** on one machine each show in Live.
- **Headless `claude -p`**: no surface, so the status line and notifications do nothing; events still ship.
- **Resumed session**: `session.start` with source `resume` merges into the same `Session` node.
- **Unknown model**: cost `null`, shown as "—"; tokens still counted.
- **Agent file unreachable** (a plugin's agent): no declared role; falls back to `roles.json`.

---

## 14. Required tests by layer

- **shared** (Vitest): the schema accepts one example per `kind` and rejects an event missing `session_id` or `user_id`; content fields are stripped.
- **mod** (`claude plugin test`): `turn.step` → an event with all four token counts; `agent.spawn` → child linked to parent with the resolved model; a tool in flight past the threshold → `stall.start` and a status line on the mocked clock, cleared by its result; an agent waiting for input is never flagged; server 500 → events kept and retried, 200 → flushed; every hook returns without awaiting the network.
- **server** (Vitest, on temp SQLite files, no container): the claims check (#44): a planted unbacked claim caught, the backed, failed-run, written-file and note-edit cases, "not checked" without content; the same batch twice → `duplicates` equals its size and the store is unchanged; a missing or wrong token → 401; a recorded events file → the expected rows; cost from `pricing.json`, `null` for an unknown model.
- **studio** (Vitest + Playwright): Live renders working, waiting, stalled and done rows; criterion A timed end to end.
- **acceptance**: the C comparison script and the E stop/restart run, recorded in `docs/verified.md`.
- **memory** (`pnpm soak`, in CI; "The memory soak" in §6): every GET API 40 times over HTTP on a synthetic session the size of the biggest history, failing on growth, on RSS over the limit, on a non-200 and on a statement prepared per request.
- **import memory** (`pnpm import-check`; "The import's memory" in §6): a session of 200,000 events, a main file and subagent files, imported by the CLI under `time`, failing above 150 MB of RSS, on fewer events written than the session holds, or on tables that do not hold what was generated.

---

## 15. Decisions

### Decision (owner, 2026-10-19, in chat): grill round 1
1. Scope v0.1: owner alone on one Mac; the cuts listed in §11.
2. First view: Live; then Ledger, Pipeline, Office.
3. Stall alert in the mod, 15 min default, configurable.
4. Neo4j is the only store. *(Superseded 2026-10-26: SQLite, the last decision below.)*
5. Mod API only; no classic-hooks fallback.
6. Tokens first; cost labelled "API-equivalent".
7. Roles: declared + `roles.json` + override; inference later.
8. Kenney CC0 sprites.
9. No thinking shown in v1.
10. Working name agent-orb; no "Claude" as the lead word; brand chosen before launch.
11. English repo, docs and UI.
12. MIT license.
13. Private repo now, `main` + `dev`, public once v0.1 passes.

### Decision (owner, 2026-10-19, in chat): grill round 2
1. v0.1 holds all four views, built in slices, each previewed locally as it lands.
2. Token in `.env` for ingest; no studio login; server on 127.0.0.1:4040.
3. Neo4j Browser on 127.0.0.1:17474 / 17687. *(Gone with Neo4j, 2026-10-26.)*
4. Metadata only; the spawn's `description` counts as metadata.
5. React + Vite; charts in plain SVG.
6. Testcontainers for tests that hit Neo4j. *(Gone with Neo4j, 2026-10-26: no test starts a container.)*
7. Server image on GHCR + plugin marketplace in the repo.
8. Settings in the plugin config menu (`userConfig`); `/orb` opens the panel.
9. Acceptance criteria A–G (§12).

### Decision (owner, 2026-10-19, in chat): plan v2.0 approved
This document approved as written; the build starts with Slice 0 and the Live mockup, in its own session opened in this folder.

### Decision (owner, 2026-10-19, in chat): two schema additions for Slice 1
1. A new kind `outbox.dropped {count, since}`, stored as a counter on the Session node, for when the outbox passes its 100,000-event cap.
2. An optional `declared_role` on `agent.spawn`, filled by the mod from the agent definition's `orb-role` frontmatter, sent from Slice 1 on.

### Decision (owner, 2026-10-20, in chat): the Ledger mockup approved
"I like the design": `design/ledger.html` is the Ledger to build (§8.2): tokens first, then API-equivalent cost; a series per day/week/month by model; breakdowns by project, model and role; efficiency per project.

### Decision (owner, 2026-10-20, in chat): full content capture, opt-in; before the Pipeline
The project's goal, in the owner's words: see how token use improves over time and what the models are thinking.
1. **Full content, opt-in** (off by default): prompts, answers, subagent task prompts, tool input and output, and thinking where Claude Code exposes it, sent to the owner's own server. This replaces round 1 decision 9 (no thinking in v1) and round 2 decision 4 (metadata only); the details (setting, size cap, masking, exclusions, display, storage, retention) are settled before building.
2. **Content capture comes before Slice 3**, as its own PR, because the Pipeline swimlane and the Office's thinking bubbles show it.

### Decision (owner, 2026-10-20, in chat): content capture details, the recommended answers
The owner answered "continue" to the eight questions, so each takes its recommended answer; the mockup approval is the checkpoint before code.
1. Setting `content`: `off` (default) or `full`.
2. "Full" holds the owner's prompts, subagent task prompts, the agents' answers, tool input, tool output, and thinking where Claude Code exposes it.
3. One stored field is at most 32 KB; a longer one keeps its start and end, with a marker for the cut.
4. The plugin masks secrets (API keys, tokens, private keys, passwords in URLs, `NAME=value` for secret-looking names) before anything is sent, and never sends the contents of `.env` files.
5. An `excludeProjects` list in the plugin config (repo names or paths): those projects never send content.
6. The studio shows a line per agent in Live (its latest tool input or answer) and an agent's full history on click; search comes later.
7. The text lives on the existing graph nodes (Prompt, Agent, Turn, ToolCall).
8. Content is kept as long as the metadata (retention is after v0.1).

Fact checked the same day: in headless `claude -p` runs the `turn.step` thinking chunks reach the plugin with empty text (194 thinking tokens used, 0 characters received); whether interactive sessions expose it is being checked.

### Decision (owner, 2026-10-20, in chat): captured text in its own store
Neo4j keeps the topology and the properties traversals use (types, roles, models, tokens, cost, timings, sizes, outcomes). The captured text (prompts, task prompts, answers, thinking, tool input and output) moves to a SQLite file beside it (`node:sqlite`, no new dependency), keyed by the same ids. This replaces content detail 7 (text on the graph nodes) and narrows round 1 decision 4 (Neo4j is the only store for the graph). Done now, before the Pipeline, while only test runs hold text. Reasons: size and backups, purging or retention by project or date in one statement, and full-text search later (FTS5 is built in). *Superseded in part, 2026-10-26: the history moved to SQLite too, `history.db`; the text store stays its own file.*

### Decision (owner, 2026-10-20, in chat): the Pipeline mockup approved; role fixes per agent type by default
`design/pipeline.html` is the Pipeline to build (§8.3). Fixing a role applies by default to every agent of that type in the project, now and later (a rule on the project); one agent at a time stays possible. Precedence: a fix on one agent > a rule for its type > declared (`orb-role`) > `roles.json`.

### Decision (owner, 2026-10-20, in chat): the Office mockup approved; its art drawn in code
`design/office.html` is the Office to build (§8.4). The bots and furniture are small pixel grids in the source, each bot coloured by its model; no asset download. This replaces round 1 decision 8 (Kenney CC0): Kenney has no office pack with characters.

### Decision (owner, 2026-10-21, in chat): a skill graph per project, before the launch
A graph of a project's skills, to see why the project works the way it does and to debug it (§8.3). The recommended answer on each question:
1. **Both kinds of edge**: what a skill's text says it can call (dashed) and what it did call (solid, weighted by times or tokens).
2. **Nodes are skills and agent types**, so a skill that dispatches agents, and an agent that preloads skills, sit in one chain.
3. **Every skill the session lists**, from the project, the user, plugins and built-ins, tagged by origin.
4. **A Skills scope on the Pipeline page**, built as Slice 5, mockup first; Launch becomes Slice 6.

### Decision (owner, 2026-10-21, in chat): the Skills mockup approved; skill usage joins Slice 5; Live redesigned next
`design/skills.html` is the Skills scope to build. The recommended answer on each question:
1. **Skill usage goes into Slice 5**: which skills run, when and how, what each costs, most to least used. The owner wants to see the most used skill's consumption against the least used one's.
2. **Live is redesigned in its own slice, right after Slice 5**, mockup first. The owner on the current Live: the table of agents and tasks doesn't say what each one did or didn't do, and nothing in it seems touchable.
3. **The new Live leads with agent cards**: what each agent is doing now in words, the skill it runs, tokens; a tap opens its history beside it.
4. **Content capture on for the owner's own sessions** (`content: full` in `~/.claude/settings.json`).
Launch becomes Slice 7.

### Decision (owner, 2026-10-21, in chat): analysis with Claude, run by hand only
The owner wants Claude to analyse what agent-orb records and suggest improvements, on the €200 a month of API credits. It must never run on its own, so the budget can't burn.
1. **The Anthropic API with a key** (API credits, not a plan). The owner puts the key in `deploy/.env`.
2. **Estimate, then confirm**: the input is counted before anything is sent, with the estimated cost, and nothing goes out until Confirm. A monthly cap blocks runs past it, and every run is in the Ledger.
3. **The first analysis is a project's week**: skills, agents, tokens, failures, thinking where captured, turned into a report with concrete changes to try.
4. **Slice 7, after the Live redesign**; Launch becomes Slice 8. Haiku, Sonnet and Opus selectable per run (the default: see the next decision).

### Decision (owner, 2026-10-21, in chat): the Live v2 mockup approved
`design/live-cards.html` is the Live to build (§8.1), replacing the table: what needs you on top (waiting for permission, stalled), the session's skills, one card per agent saying what it is doing now in words, the skill it runs, its tasks and counts; a tap opens its tasks and history beside the cards (a sheet on phones), with failures on their own tab.

### Decision (owner, 2026-10-21, in chat): the Analysis mockup approved; Opus 5.5 by default, a $20 monthly cap
`design/analysis.html` is the Analysis to build: its own page in the nav; Estimate counts the input with the API's token counter and shows the cost at most (all output used) against the month's spend; nothing is sent before Confirm; past the cap Confirm is disabled. **The default model is Opus 5.5** (the owner's choice over the recommended Sonnet), Sonnet and Haiku selectable per run. **The monthly cap is $20**, changeable on the page.

### Decision (owner, 2026-10-22, in chat): the plan after v0.1, v0.2 to v1.0
The roadmap's proposal approved as written. North star: every change to how Claude Code works shows up as tokens saved or spent. About two weeks per version; every version opens with a mockup for approval and lands in slices like v0.1. Dates are estimates, not commitments.

- **v0.2 Measure: is it getting cheaper?** The wrong-model warning that §1 promised and v0.1 does not have: an agent on a pricier model than its agent file declares is flagged live, like a stall. Trends per project: tokens and cost per session and per turn, cache share, by model and role, week over week. Change markers: the mod fingerprints the project's skills, agents and CLAUDE.md at session start, and the trend marks the day they change and compares the weeks before and after. Budget goals (a monthly goal per project, warned in the status line). Nightly backup of Neo4j and the text store (since 2026-10-26: of both SQLite files), old captured text archived. *Done when:* on the big corpus one change marker shows and its before-and-after numbers match a count by hand.
- **v0.3 Explain: why did it cost that, and what was it thinking?** Search across captured prompts, answers, thinking and tool output (SQLite full-text). Failure patterns: the same tool error, retries and permission refusals grouped across sessions. Analysis v2: compares two periods, reads thinking and failures, proposes an edit to a skill or CLAUDE.md as a diff the owner applies; still by hand, still capped. Thought bubbles in the Office. *Done when:* one proposed edit, once applied, shows up as a change marker with what it saved or cost.
- **v0.4 Share: beyond one Mac.** The server on a VPS, NAS or home server behind HTTPS via Caddy; a token per machine and the admin CLI; team floors in the Office; behavioural role inference; OTel reconciliation of the Ledger against Claude Code's own telemetry. *Done when:* two machines send to one server over HTTPS and the Office shows each on its own floor.
- **v1.0 The loop: does the next change pay off?** One flow: Live spots a problem, the Analysis explains it, the owner changes a skill or an agent, the trend shows what it saved. A versioned event schema, so an older plugin keeps working with a newer server. An optional OpenInference export so the same sessions can also go to Phoenix, built only if the owner asks for it then. *Done when:* one full loop on a real project, with the saving measured in tokens.

Not planned: XP and badges, sounds. The constraints in §2 hold for every version. The v0.1 launch (Slice 8) comes first and still needs the public name.

### Decision (owner, 2026-10-22, in chat): the public name stays agent-orb
No rename for the launch: the repo, the plugin, the marketplace and the GHCR image keep `agent-orb`. Slice 8 opens with the README draft as its mockup; the release workflow, the marketplace manifest, the demo GIF and the criterion F run follow the owner's go on that draft.

### Decision (owner, 2026-10-22, in chat): the README draft approved
`README.md` as drafted in #17 is the launch's README. The rest of Slice 8 follows on the same branch: the release workflow, the marketplace manifest, the demo GIF and the criterion F run.

### Decision (owner, 2026-10-22, in chat): the studio redesign; the Live v3 mock is the design language
An audit of every view (synthetic data, 1440 and 390, both themes) found the same causes on every page: text under 12px, tap targets under 44px, cards inside cards, one purple for accent and Opus alike, uneven widths, fine print. `design/live-v3.html` is approved as the design language: IBM Plex Sans and Mono with Bricolage Grotesque for titles, bundled in the studio (no outside calls); nothing under 12px, sentence-case labels, 44px targets; purple means clickable only, models get their own validated hues (Opus plum, Sonnet blue, Haiku teal) always with their name; one card level per session with agents as rows on a shared grid and subagents as a tree; a Needs-you box for every waiting or stalled agent; history as a full-height drawer, a sheet on phones. Next, mock first: the component library sheet (today → proposed) and the page kit; then every page; nothing is built before those are approved.

### Decision (owner, 2026-10-22, in chat): the component library, the page kit and eight decisions approved
`design/library.html` is the library (today → proposed, 20 components) and the page kit (11 pieces). Approved with it: both waiting states read "waiting for you", the reason in the row's sentence; a selected segment is raised, not purple; origin tags (project, user, plugin) lose their colours; the chart tooltip becomes an HTML layer; the history drawer lays over the page; the context meter turns amber from 80% with "near the limit"; a cost under a cent reads `<$0.01` and a partial total `≥ $0.71` (format.ts and format.spec.ts change together); a loading skeleton. Dead Live v1 CSS is deleted when the library lands. Next, mock first: every page, desktop and phone.

### Decision (owner, 2026-10-22, in chat): the seven page boards approved; the build plan
`design/pages.html` (Live, Ledger, Pipeline roles, Pipeline session, Skills, Office, Analysis; desktop and phone, both themes) is approved with the decisions listed under each board. The build goes on `feat/studio-redesign` (from dev), one PR per step into it, in this order: tokens and bundled fonts; the library restyle with the dead CSS removed; the page kit and page headers; the app shell; the pages by area. Each PR carries before and after screenshots from the synthetic stack. The branch merges into dev after the owner reviews it locally.

### Decision (owner, 2026-10-23, in chat): a standing ok for the redesign steps
"Standing ok, scoped to the redesign steps: merge each step PR into feat/studio-redesign once its gate passes. The merge of feat/studio-redesign into dev stays mine." Recorded on #18; #18 and #19 merged under it.

### Decision (owner, 2026-10-24, in chat): fix the 2.1.308 test, release v0.1.0, start v0.2
"Fix first, after fixing create first release then start working on the next one." #28: on Claude Code 2.1.308 an ask a hook makes is a person's, so the engine test's own `tool.check` hook raised a dialog; the mod was right, the test now settles that request from beneath (docs/verified.md). v0.1.0 is released: `dev` into `main` with a merge commit (#29, 3d15310) and the tag `v0.1.0`. Its server image is not on GHCR, because GitHub billing blocks Actions; the repo stays private. v0.2 opens with `design/v0.2-measure.html` for approval.

### Decision (owner, 2026-10-24, in chat): the v0.2 Measure boards and decisions approved
"The v0.2 Measure boards and their decisions are approved as recommended (PR #30)." `design/v0.2-measure.html`, with every board's decisions as recommended:
- History comes from Claude Code's own logs, through a one-off `docker compose run` of the server image. It imports usage and metadata only, whatever content is set to, and its events are keyed so a second run counts nothing twice.
- Trends is a view inside the Ledger (Totals | Trends), so the nav stays at five. It counts per active day and per prompt, split by who spent (main session, agents on their own model, generic agents) by default, with by model one tap away.
- A change compares up to 7 whole days on each side, per active day. A change watches the project's `.claude/` agents and skills and its CLAUDE.md (git for the past, fingerprints from now) plus the owner's `~/.claude/CLAUDE.md` and rules (fingerprints only).
- The model check uses the agent file's `model:`. Agents with no file (general-purpose, workflow agents, `inherit`) are held to a ceiling the owner sets, Sonnet by default, and the main session is never flagged. It shows as "pricier model" in amber, in Needs you, with one notification.
- The status line order is a stall, then a pricier model, then past the goal; the goal's percentage rides on the normal line from 80%.
- The monthly goal is in API-equivalent dollars per project, and nothing is stopped.
- Backup is a nightly host script that stops Neo4j for the dump, copies the text store with `VACUUM INTO`, and keeps 7 copies. *(Since 2026-10-26: it copies both SQLite files with `VACUUM INTO` and stops nothing.)*
- Archiving old captured text is dropped from v0.2.

Slices, in order: 1 history and Trends (the done check runs here), 2 the model check, 3 fingerprints and the goal, 4 nightly backup.

### Decision (owner, 2026-10-25, in chat): v0.3 adds Worth and unbacked claims; the README compares with ccusage and Anthropic's analytics
"Record the three recommendations (Worth slice, unbacked-claim checks, README comparison) as v0.3 plans in PROJECT.md §15." They come from the research note of 2026-10-24, "agent-orb Worth and Truth" (a private artifact, https://claude.ai/artifact/Hdr64zfS3Q8Xx8h6BDbsua), which looked at how other tools measure time saved and hallucination, and at their prices. v0.2's approved slices come first; v0.3 still opens with a mockup, and the details below settle there.
- **Worth.** Two settings: the owner's hourly rate and what the plan costs a month (the Ledger knows only the API-equivalent cost). One by-hand estimate per finished session, in hours, entered on the session in History or with `/orb worth <hours>`. Nothing asks for it when a session ends, and it is labelled as the owner's estimate wherever it shows. A Worth card in the Ledger: hours by hand, the owner's attention (active windows derived from prompt times, plus permission waits; no new capture), net hours, their value at the rate, and what was paid. A period that lost time shows a negative number. It is an estimate because nobody measures the counterfactual: surveys overstate it (METR 2025: 19% slower, believed 20% faster), and attributed lines measure volume, not time.
- **Unbacked claims**, a group in v0.3's failure patterns, in this order. (1) The plugin sends a short error class beside `error_type` (`not_found`, `no_match`, `unknown_command`) and a command class on Bash calls (`test`, `build`), so invented paths, Edit misses and edits to tests after a failing run show with Content off and no text leaves the machine. (2) With Content on `full`, test, build and edit claims in the final answer and in each subagent's report are checked against that agent's own calls: a test run after the last edit, its success, a write to the file it names. (3) Drift from the task is judged by Analysis v2 from the prompt, the diff and the answer, by hand and under the cap. No local hallucination model: HHEM-2.1-Open is trained on summaries against sources, and span detectors score about 0.60 F1 on code-agent cases.
- **README.** "How it compares" adds one line each for ccusage and Anthropic's Claude Code analytics beside Phoenix, when v0.2 ships.

### Decision (owner, 2026-10-25, in chat): the v0.3 mockup approved; v0.3 split
"Yes approve": `design/v0.3-worth-truth.html` (#61) with every board's decisions as recommended:
- **Worth:** a third Ledger view. One estimate per merged PR, as one tap on a size whose hours the owner sets (S 0.5, M 2, L 6, XL 16 by default). A session is the fallback for work with no PR. Attention is a floor (prompt windows plus permission waits). The return is on the plan price, with the API-equivalent beside it. Revenue from the time log waits.
- **Unbacked claims:** only edits to code and tests break a claim. "Unbacked claim" shows in red, in Needs you and the history. Without Content on full a session reads "not checked". #44's done check becomes: a planted claim caught, and no false flag on the big corpus.
- **Failure patterns, search, reports:** Analysis holds Patterns | Search | Reports. Repeats carry a suggested fix. Tests edited after a failure are "worth a look", not a flag.
- **Analysis v2:** compares two periods, failures and drift. Its edit is a diff the owner applies.
- **Thought bubbles:** the latest thought, cut to one line.

The split: v0.3 "Worth and truth" (#43, #42, #45, #44, in that order) and v0.4 "Explain" (#46, #47, #48); Share moves to v0.5.

### Decision (owner, 2026-10-26, in chat): the history moves to SQLite, and Neo4j is removed
"Sql lite for now, even though I'm scared of how memory will grow over time." (#81) And: "SQL lite first, and 44 built after."
- **Why.** The history was in Neo4j: a JVM with a 1 GB heap and a 512 MB page cache, in its own container, on a machine that runs several projects at once. On 2026-10-26 two whole-graph checks restarted it while the Docker VM was crowded, and it took 8 minutes to come back. The owner wants agent-orb light on memory.
- **The spike** (`spike/store`, 0e2e337) read the big corpus through the import's own reader into SQLite (`node:sqlite`) and DuckDB; both matched Neo4j's numbers exactly (46,473 calls, 1,136 failed). On all projects (450k events): SQLite 101 MB while running (94 MB of it Node before the database opens), 118 MB on disk, imported in 51 s; DuckDB 177 MB, and its file lock lets no second process open it, so the import could not run beside the server.
- **Chosen:** SQLite, in one file beside the text store. Not DuckDB (the memory, the dependency and the lock, though its queries are 5 to 14 times faster). Not Neo4j. The memory worry is answered by an explicit `PRAGMA cache_size`, grouping in SQL, and a gate check: `pnpm soak`.
- **Four slices**, each its own PR into `feat/sqlite`: the store, the writer and the import (#87); the read APIs (#83); the Pipeline (#84); the deploy (#85). #44 (unbacked claims) is built after, on SQLite.
- **No migration.** Slice 4 removed the Neo4j service, driver, writer, Testcontainers setup and dump. The owner's only Neo4j data is a backup kept by hand, and this version cannot restore it. This supersedes round 1 decision 4, round 2 decisions 3 and 6, the 2026-10-24 backup decision's Neo4j dump, and the text store's "Neo4j keeps the topology".

Earlier (v1.0): TypeScript everywhere, Fastify server; Neo4j Community + APOC with the server as its only client (replaced by SQLite on 2026-10-26, above); cost computed server-side from `pricing.json`.

---

## 16. References

- Hooks: https://code.claude.com/docs/en/hooks
- Plugins: https://code.claude.com/docs/en/plugins/components · https://code.claude.com/docs/en/plugins/manifest-reference · https://code.claude.com/docs/en/plugins/cli-reference
- Monitoring (OpenTelemetry): https://code.claude.com/docs/en/monitoring-usage
- Sessions: https://code.claude.com/docs/en/sessions · Subagents: https://code.claude.com/docs/en/sub-agents
- Mod API: the `plugin-authoring` skill in Claude Code (types in `claude-code.d.ts`; examples `pane.tsx`, `band.tsx`, `tool-call.ts`)
- Related projects: https://github.com/paulrobello/claude-office · https://github.com/JoelHutchinson/agent-visualiser · https://github.com/dimivelev/pixel-agents · https://github.com/Khanthtutzin/subagent-crew · https://github.com/simple10/agents-observe · https://github.com/ColeMurray/claude-code-otel
- Anthropic trademark guidelines: https://www.anthropic.com/legal/trademark-guidelines
- CC0 art: https://kenney.nl/assets · https://opengameart.org
