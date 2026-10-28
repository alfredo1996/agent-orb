# Verified against a real engine

Facts the mod is built on, checked on Claude Code **2.1.299** (the desktop app's bundled build) with a throwaway probe plugin that logged the shape of every hook input and result: keys and string lengths, never content. Two headless runs on Haiku, about $0.02 API-equivalent in all.

Run: `claude -p --plugin-dir <probe> --model haiku --allowedTools … --output-format json`, prompts that Read, Bash, load a Skill, and spawn an Explore subagent in the background and in the foreground.

## The mod API (Slice 1 checks, PROJECT.md §11)

| Question | Answer | How |
|---|---|---|
| Fields of a `tool.call` result | `{ ref, result, text, isReadOnly }`, plus `isError` on a failure and `deny` on a refusal. `result` is the tool's own record (`Read` → `{type, file:{filePath, content, numLines, …}}`, `Bash` → `{stdout, stderr, interrupted, …}`); `text` is what the model reads, present for every tool | probe |
| Does a subagent's `turn.step` carry `agentId`? | Yes, on every step of the subagent's loop; absent on the main loop. The same holds for `tool.call` and `turn.start`/`turn.complete` | probe |
| `turn.step` usage | The result carries `usage = {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, model}` and `stopReason` (may be `null`). The step's input has no `agentId` key at all on the main loop | probe |
| Do the steps add up? | Yes: the sum of every step's four counts equalled the session's `modelUsage` totals in `--output-format json` exactly (222,289 tokens) | probe run 1 |
| `agent.spawn` | Input: `tool_use_id` (the Agent call's), `prompt`, `description`, `subagentType`, `provider`, `parentModel`, `parentAgentId` (absent when main spawns), `background`, `fork`. `await next(e)` resolves `{model, agentId}` **after** the child's first `turn.start` | probe |
| Agent vs Workflow `tool_use_id` | Agent: the Agent tool call's id. Workflow: the Workflow call's id, shared by every agent of the run (types doc; not run, to save tokens) | types |
| When does a subagent end? | A **background** subagent's Agent tool call returns at once, before the child runs, so the Agent result cannot mark the end. The child's own `turn.complete` (with its `agentId`, `durationMs`, `usage`) does, foreground and background alike | probe runs 1 and 2 |
| Can `skill.load` get a `tool_use_id`? | Yes: `skill.prompt` fires inside the Skill tool call (between its `tool.call` input and result), so the in-flight Skill call's id is the one | probe run 2 |
| `prompt.submit` origins | `sdk` under `-p`; a subagent's completion delivered to main arrives as a second `prompt.submit` with a 17-character origin kind (`task-notification`), which is not a person's prompt | probe |
| `claude -p` | Every hook runs; `session.start` has `surface: null`, `isInteractive: false`. `$.ui.status`/`notify` have nowhere to draw: events still ship | probe |
| Session facts | `$.session.version()` → `{version, base, builtAt}`; `$.session.repo()` → `{root, remote, name}`; `$.process.run(['hostname','-s'])` works; `crypto.randomUUID` exists. The mod names the machine (#107) with `scutil --get LocalHostName` on macOS and `hostname -s` elsewhere or when scutil fails, because on a Mac `hostname -s` is the network's DNS name while no HostName is set (`Host-009` on a home router). The hooks environment has no `process.platform` (no Node), so the platform is `uname -s` through `$.process.run` | probe for `hostname`; `uname` and `scutil` are run only against the engine suite's stubs, not yet on a live engine |
| Permission wait | Superseded 2026-10-21: see "Permission asks" below. A `tool.check` verdict `ask` is **not** a prompt to a person | types + probe, then probe |
| Where the `/orb` panel draws | Checked by the owner in the desktop app on 2026-10-20, the mod hot-reloaded into a live session; the terminal is not checked yet | owner |
| The Task tools (Slice 2) | `TaskCreate` → `result.task = {id, subject}` (ids are per-session counters: `"1"`). `TaskUpdate` (input `taskId`, `status`) → `{success, taskId, updatedFields, statusChange: {from, to}}`, **no subject**, so the mod remembers subjects from `TaskCreate` | probe run 3 ($0.007) |

## Permission asks (2026-10-21, the false "waiting · permission")

The mod used to mark a tool waiting whenever `tool.check` resolved `ask`. Live and the Office then showed "waiting · permission" and "1 waiting for you" while nobody was asked, and a hung tool never raised its stall (a waiting tool is exempt). In the owner's graph, **238 of 462** tool calls were flagged `waited`: 170 Bash calls (fastest 145 ms), 37 `browser_batch` (fastest 14 ms), against `AskUserQuestion` at 24 minutes on average, the only real waits.

What the engine says (types, 2.1.299): `tool.check` fires "before the mode settles an ask"; `ask` "puts it to the mode's decider (the dialog, the auto-mode classifier, a headless host)". Nothing in the mod API names the session's permission mode or reports a dialog.

| Question | Answer | How |
|---|---|---|
| Auto mode, a Bash `touch` outside the project (verdict `ask`) | `tool.check` → `ask`, **no `classic.PermissionRequest`**, no prompt reaches the host; the classifier approves and the tool runs 1.3-1.6 s later. Same for a plain `date` | probe, `--permission-mode auto`, headless and stream-json host |
| Default mode, the same command | `tool.check` → `ask`, then `classic.PermissionRequest` 1-6 ms later | probe, `--permission-mode default` |
| Stream-json host (the desktop app's path), default mode | `ask` → `PermissionRequest` → the host's `can_use_tool` request; after the host answered (3 s later) `classic.PostToolUse` | probe, `--input-format stream-json --permission-prompt-tool stdio` |
| `AskUserQuestion` (needs a person) in default and in auto mode | `ask` → `PermissionRequest` in both; the host is asked both times | probe |
| What `PermissionRequest` carries | `tool_name`, `tool_input`, `permission_mode`, `agent_id` (absent on main; for a subagent equal to the `agentId` its `tool.call` carries). **No `tool_use_id`** | probe, one subagent run |
| A settings hook answered the request (`decision: allow`) | `next(e)` resolves `{ decision: { behavior: 'allow' } }` and the tool runs with no person; with no such hook it resolves `{}` | probe, `--settings` with a command hook |
| An answer to the dialog | **No event.** The next one is `classic.PostToolUse` (after the tool ran) | probe |

So the mod flags `tool.waiting` on `classic.PermissionRequest` whose `next(e)` came back without a `decision`, on the agent's in-flight call of that tool, and not on `tool.check`. Known ceiling: with no event for the answer, the flag stays until the tool's result, so a tool a person approved shows waiting for its whole run (the Ledger already read `waited` as a ceiling). The terminal REPL's dialog is not checked yet (the probes ran headless and on a stream-json host, the desktop app's path). The desktop app's own per-site approval for the browser tools is the tool's internal prompt, below the engine, and is not seen at all.

After the fix, the real mod on the real engine (events caught by a throwaway local server, not the compose stack): on a stream-json host that approves after 3 s in default mode, the Bash call got one `tool.waiting` and its result 4.6 s later; in auto mode the same command got none and ran in 1.4 s.

15 headless Haiku runs (default, auto, manual stream-json host, one subagent, two settings-hook variants, the two runs of the mod itself), about **$0.09** API-equivalent in all. Probe plugin and driver scripts were throwaways in a scratchpad.

### On 2.1.308 (2026-10-24)

The engine test "an ask the auto-mode classifier settles is no wait" failed on 2.1.308 (17 pass, 1 fail): a `tool.waiting` for the hung Bash call. The mod was right and the test's premise had gone.

| Question | Answer | How |
|---|---|---|
| What changed | A `tool.check` `ask` a hook makes is now a person's: the result names the hook's `plugin`, "no classifier's allow settles it", and the dialog, the host or a PermissionRequest hook answers it. Core's own ask names no plugin and still goes to the mode's decider. New on the input: `approver` (`host`, `person`, absent where nobody can be asked) | types, 2.1.308 against the pinned 2.1.299 copy |
| Why the test flagged | In a test, `$.tool.call` runs the permission check, so the test's `tool.check` hook answering `ask` is a plugin's ask, and the kit raises `classic.PermissionRequest` for it. The mod flags that request as it should. A test cannot play core's ask that the classifier settles | types (the kit's note on `EngineToolCall`) + the failing run |
| The real engine, auto mode, a Bash `touch` outside the project | No `tool.waiting`; the classifier approved and the call ran in 3.0 s | the real mod, headless Haiku, events caught by a throwaway local listener |
| The real engine, default mode, the same command | `tool.waiting` 41 ms after the call, then the denial 1 ms later (headless, nobody to answer) | the same, `--permission-mode default` |

The test now settles the request from beneath with a request hook, standing in for the classifier: a `tool.check` `ask` alone still flags nothing, and the hung tool still raises its stall. It passes on 2.1.304 and 2.1.308, and fails on both with the pre-#11 bug put back (flagging on a `tool.check` `ask`). Two headless Haiku runs, about **$0.009** API-equivalent.

## Thinking text (2026-10-20, for content capture)

| Question | Answer | How |
|---|---|---|
| Does thinking text reach a plugin? | **Not in headless runs.** `turn.step` streams `thinking` chunks (`{kind, index, text, ref}`), but `text` is empty: 194 thinking tokens used, 0 characters received. The step's result has no thinking field at all | probe, Haiku 5.5, `--effort high` |
| With `showThinkingSummaries: true`? | **Still empty** in a headless run (`--settings '{"showThinkingSummaries": true}'`) | probe ($0.004) |
| Why | Claude Code's docs: interactive sessions get redacted thinking by default, and `showThinkingSummaries` turns on summaries; the API's default display for Haiku 5.5 is `omitted` (empty text, billed the same). The docs don't say whether the setting reaches plugins or `-p`; a GitHub report says it had no effect in the desktop app | docs ([model-config](https://code.claude.com/docs/en/model-config), [settings](https://code.claude.com/docs/en/settings-reference)) |
| Interactive sessions | Not checked yet: needs the setting on in a real session and the mod reading the chunks | open |

### Content capture on a real session (2026-10-20)

Headless Haiku run `56fdc961` with `content: full` passed per run (`--settings`), echoing a fake token and reading a fake `.env` from a scratch folder ($0.01):

- **Captured:** the prompt (with `ORB_TOKEN=[REDACTED]`), Bash input and output (masked), the Agent call's input with the subagent's task and its report, and the final answer.
- **The `.env` read** is recorded as `output_skipped: env-file`, with no output.
- **No leaks:** a Cypher count of tool calls whose input or output contains either fake secret returned **0**.
- **Thinking:** the drawer says it was not shared (empty chunks, as above).

## Skills (2026-10-21, for Slice 5)

One headless Haiku run ($0.011) in a fixture project: skill `alpha` runs skill `beta` with the Skill tool, then spawns agent `scout`, whose definition preloads `beta` (`skills: [beta]`). The person typed `/alpha`.

| Question | Answer | How |
|---|---|---|
| The session's skills, even unused ones | `$.session.usage({ breakdown: 'summary' })` → `context.breakdown.skills.skillFrontmatter[]`: `{name, source, pluginName?, tokens}`, ready at `session.start` (134 ms in). 48 skills on the owner's setup. `source` is `userSettings`, `projectSettings`, `plugin`, `built-in` or `syncedSkills`; plugin skills are named `<plugin>:<skill>`. `tokens` is the listing's cost in every session | probe |
| The session's custom agents | The same breakdown's `agents[]`: `{agentType, source, tokens}`, custom agents only (no Explore, Plan, general-purpose) | probe |
| Descriptions | `$.command.list()` → `{name, description, source, plugin?}` for every slash command, skills included. Its `source` calls a project skill `user`, so origin comes from the breakdown | probe |
| A typed `/name` | `prompt.submit` (with `command.name`), then `skill.prompt`, **then** the main loop's `turn.start`: the load belongs to the turn that follows it | probe |
| A Skill tool call | `skill.prompt` fires between the call's `tool.call` input and result | probe (again) |
| A preload into a subagent | `skill.prompt` fires right after the subagent's first `turn.start`, with no Skill call in flight | probe |
| What `skill.prompt` carries | `skill`, `text`, `frontmatter`, `source`, `path` (absolute, absent for built-in and MCP skills), `pluginName?`. **No `agentId`**: the mod infers the agent from the in-flight Skill call, the typed prompt, or the newest subagent | probe + types |
| Reading a skill that never ran | Not through the API: `$.skill.prompt(…)` raises the event with text the caller supplies, it reads no file. Project and user skills can be read from disk (`<root>/.claude/skills/<name>/SKILL.md`, `~/.claude/skills/…`); a plugin skill's text is known once it runs | types |

## The model check (2026-10-25, v0.2 slice 2, Claude Code 2.1.308)

| Question | Answer | How |
|---|---|---|
| What `agent.spawn` gives to check a model against | `model` is the Agent tool's parameter as given (an alias or an id, undefined when the agent's own model or the parent's decides); `next(e)` resolves the model the agent runs on, as a full id (`claude-sonnet-5-5`). No API lists an agent definition's own model: the plugin reads `model:` from the `<type>.md` it already reads for `orb-role` | types |
| A file that says `model: haiku`, spawned with `model: "sonnet"` | runs on `claude-sonnet-5-5`; flagged, `allowed: haiku`, `source: file` | the real plugin, headless Haiku main, events to the preview server |
| `general-purpose` (no file), spawned with `model: "opus"` | runs on `claude-opus-5-5`; flagged, `allowed: sonnet` (the default ceiling), `source: ceiling` | the same run |
| The main session | never flagged | the same run |
| A workflow agent's `subagentType` | not checked on the real engine (a workflow run costs more); the check does not depend on it, since a type with no agent file is held to the ceiling | engine tests' fake only |

One headless run with a Sonnet and an Opus subagent: $0.20 API-equivalent.

## Fingerprints and the goal (2026-10-25, v0.2 slice 3, Claude Code 2.1.308)

| Question | Answer | How |
|---|---|---|
| `git hash-object --stdin-paths` with absolute paths on stdin | Prints the blob id git stores for a committed file (the same id as `git ls-tree`), for files outside the repo too, and runs outside any repo. A path that does not exist ends it with exit 128 after the hashes before it, so the plugin sends nothing that session | git 2.54.0, a scratch repo |
| The real engine's `$.fs.list`, `$.process.run(argv, { cwd, stdin })`, `Intl` time zone and `$.http.fetch` GET | All work in a hooks module. One headless Haiku run of the real plugin in a scratch repo, sending to a logging stand-in server: `project.fingerprint` listed the repo's agent, skill and CLAUDE.md and the owner's `~/.claude/CLAUDE.md` and `rules/*.md`; the project files' hashes equal the `blobs` of the same commit in `project.changes` (what the Trends dedupe compares); `GET /api/goal?project=repo&tz=Europe%2FRome` | the real plugin, `--settings` for the endpoint and token |
| The status line and the goal notification | Not drawn in a headless run (`claude -p`, as above): the engine tests cover them | engine tests only |
| `$.session.repo().root` in a git worktree | The repository's root, **the main working tree's**, as its type documents, not the worktree's. A headless session started inside a real worktree of another repository (`…/<repo>/.claude/worktrees/<name>`, where `git rev-parse --show-toplevel` gives that path) sent events with `project.cwd` = the main checkout and `git_branch` = `release/0.15`, the main checkout's. So for every worktree session the branch, the fingerprints' files and the `files_touched` paths were the main tree's. The plugin now takes the session's own tree from `git -C <cwd> rev-parse --show-toplevel` and sends it as `project.checkout` when it differs from `cwd`. The fix is covered by the engine tests' fake, not re-run on the real engine | one headless Haiku run of the real plugin in a real worktree, $0.006 |

## Cost note

`--output-format json` shows Claude Code writing the prompt cache with **1-hour** entries (`ephemeral_1h_input_tokens`), while `usage` in the mod API does not split 5-minute from 1-hour writes. `pricing.json` prices every cache write as a 5-minute write, so cost runs low when the 1-hour cache is used. Tokens (the headline) are exact.

## Acceptance criteria (§12)

Real sessions were headless (`claude -p --plugin-dir packages/mod`, Haiku, the token passed with `--settings` so no settings file changed), sending to the compose stack on 127.0.0.1:4040.

| | Criterion | Result | Evidence |
|---|---|---|---|
| A | Main agent in Live within 2 s; subagents under their parent | **pass** | Real sessions: a watcher on `/stream` measured arrival minus the session's `session.start` time: **45 ms and 39 ms**. The first measurement was 2,046 ms (a miss): the first flush waited for the 2-second tick, so `session.start` and `agent.spawn` are now sent at once (engine test `criterion A`). Server test: an ingested spawn reaches an open `/stream` in well under 2 s, nested under main |
| B | The graph matches the session | **pass** | Run `c8c5cb1d`: Session (model, version, start, end), 2 Agents with `SPAWNED`, Project `github.com/alfredo1996/agent-orb`, 5 ApiRequests; writer tests on the recorded fixture |
| C | Tokens within 1% of the session | **pass, exact** | Sum of ApiRequest tokens in Neo4j vs Claude Code's own `modelUsage` (`--output-format json`), three runs: 151,435 = 151,435; 208,576 = 208,576; 66,578 = 66,578. (The transcript was not needed: `modelUsage` is the engine's own count.) |
| D | A tool past the threshold flagged within 1 min | **pass** | Threshold 1 min, an 80-s `ping` (Claude Code's Bash refuses a foreground `sleep`). Tool started 1792436536.4 s, crossed the threshold at …596.4 s, `"state":"stalled"` on `/stream` by …597 s: under a second after crossing. Screenshot: the red row, `⚠ Bash 1m 6s` |
| E | Server down 5 min: nothing lost, Claude Code never slows | **pass** | Server stopped; session `da0835f6` ran with it down (6.8 s) and exited; the server stayed down **306 s**; it was not in Neo4j. The next session took over its queue from the plugin store and sent it: Neo4j then held all of it, **68,939 tokens = 68,939** in `modelUsage`, session end included. The same session with the server up took 6.6 s |
| F | `docker compose up -d` + the plugin is the whole setup | **pass, with the deviations named** | 2026-10-22, a fresh clone of `feat/slice-8-launch` through README steps 1–4: `deploy/.env` from the example with two random secrets; `docker compose -f deploy/docker-compose.yml up -d` tried to pull the unpublished `0.1.0` image, then built it from the clone (17 s); `claude plugin marketplace add`, `claude plugin install agent-orb@agent-orb`, `claude plugin configure agent-orb@agent-orb --values-stdin`. Headless Haiku session `86f8d2ae` in a demo repo: main and its Explore subagent in Live; 217,230 tokens in the graph = Claude Code's `modelUsage` 217,230. Nothing paid: no API key in `.env`, the session on the owner's subscription. Deviations, all from sharing the owner's Mac: the clone's compose got its own project name, ports (14040, 37474, 37687) and volume names, so the owner's stack and data were untouched; the marketplace was added from the clone's path, because the repo is private and the branch unmerged (the GitHub path is checked once public); the session ran on the owner's login with the installed plugin loaded from the install cache by `--plugin-dir` and its settings passed per run, because a separate Claude config has no login; Claude Code 2.1.304 (the terminal CLI on this Mac is 2.1.273, below the minimum). `docs/img/demo.gif` is a second such session, `d2d8b308`, its frames recorded with the host name shown as my-mac. The two sessions: $0.011 and $0.010 API-equivalent |
| G | Pipeline roles sensible and correctable | **pass** | Project agent-orb, 15 sessions in 7 days (three short headless runs added Plan and general-purpose agents, $0.04). The Pipeline showed orchestrator → planner (Plan), researcher (Explore) and generalist (general-purpose). Correcting general-purpose to reviewer in the studio's role panel (for every general-purpose agent in the project) moved all 3 at once (role source `rule`); the server test shows a later spawn of that type gets the rule too. Screenshots: `docs/img/pipeline-before-fix.jpg`, `pipeline-after-fix.jpg` |

