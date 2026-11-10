-- The history store (#81): the history in one SQLite file. Every statement is idempotent; the server applies this at open.
-- A key is what an event's write upserts on, so a write is idempotent. Timestamps are epoch ms. `cost_usd` is the only REAL.
-- What is not stored, because a read derives it: User and Host (a session carries both), Tool (tool_calls.tool), HAS_PROMPT.order (rank prompts by ts in a session),
-- CALLED.order and NEXT (rank an agent's calls by ts; parallel calls with one ts share a predecessor), Skill (the names in skill_loads).
-- A foreign key is never declared: the writer makes the parent row in the same transaction, and a delete is the writer's own (the re-home).

-- The event ids already written (§5, idempotency on Event.id).
CREATE TABLE IF NOT EXISTS ingested (id TEXT PRIMARY KEY) WITHOUT ROWID;

-- id is the git remote, else `host:cwd` (a project the import filed before the plugin knew the remote; the re-home moves it).
-- goal_usd is the owner's monthly goal, set by PUT /api/goal, never by the writer. prs_read_at is when the plugin last read the project's open PRs (#27; open_prs below).
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, git_remote TEXT, goal_usd REAL, prs_read_at INTEGER) WITHOUT ROWID;
-- Project.cwds: every distinct project.cwd seen for it.
CREATE TABLE IF NOT EXISTS project_cwds (project_id TEXT NOT NULL, cwd TEXT NOT NULL, PRIMARY KEY (project_id, cwd)) WITHOUT ROWID;
-- RoleRule: the role the owner fixed for an agent type in a project. The writer reads it on a spawn and moves it on a re-home; the API writes it.
CREATE TABLE IF NOT EXISTS role_rules (project_id TEXT NOT NULL, agent_type TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (project_id, agent_type)) WITHOUT ROWID;

-- One session, one project: the first an event named, then the re-home. user_id and host are the Host and User nodes.
-- branch (#28) is the git branch the first session.start that had one was on: a session on an issue branch counts whole for that issue.
-- source is the first session.start source seen; recorded is 1 once a session.start with another source arrived.
-- plugin_first and plugin_last are the first and last ts of the prompts, requests and calls the plugin wrote (the writer's `source` is 'plugin'):
-- the stretch the import never fills. An imported session the plugin resumed later has a stretch from the resume on (#79); null = the plugin wrote none.
-- seen_at (#29) is the last ts of any event of the session, of any kind (a machine sample and a read of the open PRs among them); null = none since the column was added.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, host TEXT NOT NULL, project_id TEXT NOT NULL,
  started_at INTEGER, ended_at INTEGER, model TEXT, claude_version TEXT, content TEXT, source TEXT, recorded INTEGER,
  plugin_first INTEGER, plugin_last INTEGER, dropped_events INTEGER, branch TEXT, seen_at INTEGER
) WITHOUT ROWID;

-- id is `session:agent_id`, the main agent `session:main`. parent_id and spawn_tool_use_id are the SPAWNED edge and the SPAWNED_AGENT one.
-- role_source: map, declared, rule, manual (set by the API, which the writer never overwrites). pricier is 1 when the spawn carried a model_check.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT, type TEXT, role TEXT, role_source TEXT, description TEXT, model TEXT,
  started_at INTEGER, ended_at INTEGER, spawn_tool_use_id TEXT, declared_model TEXT, allowed_model TEXT, check_source TEXT, pricier INTEGER
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, started_at INTEGER, duration_ms INTEGER) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, ts INTEGER, length INTEGER) WITHOUT ROWID;
-- id is the turn.step event's id.
CREATE TABLE IF NOT EXISTS api_requests (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, ts INTEGER NOT NULL, model TEXT NOT NULL,
  input INTEGER, output INTEGER, cache_read INTEGER, cache_creation INTEGER, cost_usd REAL
) WITHOUT ROWID;

-- One row per tool_use_id: a call copied into a forked session is this row, not a second one. turn_id (so the session, through turns and agents)
-- is the first tool.call that named one; a row made by a result or a wait alone has none yet, and is no call until it does.
CREATE TABLE IF NOT EXISTS tool_calls (
  tool_use_id TEXT PRIMARY KEY, turn_id TEXT, tool TEXT, ts INTEGER, input_size INTEGER, command_class TEXT,
  success INTEGER, error_type TEXT, error_class TEXT, error_shape TEXT, duration_ms INTEGER, output_size INTEGER, output_skipped TEXT, waited INTEGER
) WITHOUT ROWID;
-- TOUCHED: project_id is the File node's project key (File = project_id + path).
CREATE TABLE IF NOT EXISTS files_touched (
  tool_use_id TEXT NOT NULL, path TEXT NOT NULL, mode TEXT NOT NULL, project_id TEXT NOT NULL, PRIMARY KEY (tool_use_id, path, mode)
) WITHOUT ROWID;

-- One row per skill.load event. tool_use_id is INVOKED_SKILL, turn_id with ts, how and source is LOADED_SKILL. Several events can say one (call, skill):
-- count DISTINCT.
CREATE TABLE IF NOT EXISTS skill_loads (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, tool_use_id TEXT, skill TEXT NOT NULL, ts INTEGER NOT NULL, how TEXT, source TEXT
) WITHOUT ROWID;
-- SkillDef: id is `project|kind|source|name`. calls_skills, calls_agents and preload are JSON arrays; tokens is 0 until a session says. LISTED is session_skill_defs.
CREATE TABLE IF NOT EXISTS skill_defs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, plugin TEXT, tokens INTEGER NOT NULL, description TEXT,
  calls_skills TEXT, calls_agents TEXT, preload TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_skill_defs (session_id TEXT NOT NULL, def_id TEXT NOT NULL, PRIMARY KEY (session_id, def_id)) WITHOUT ROWID;

-- Task ids are per-session counters, so id is `session:task_id`. WORKED_ON is agent_tasks (an agent that creates a task and another that completes it both worked on it).
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, subject TEXT, status TEXT) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS agent_tasks (agent_id TEXT NOT NULL, task_id TEXT NOT NULL, PRIMARY KEY (agent_id, task_id)) WITHOUT ROWID;

-- Change: source 'git' has id `project:sha` and a sha and subject; source 'fingerprint' has id `project:fp:path:hash` and a scope. files and hashes are JSON arrays.
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sha TEXT, ts INTEGER NOT NULL, subject TEXT, files TEXT NOT NULL, hashes TEXT, scope TEXT, source TEXT NOT NULL
) WITHOUT ROWID;
-- The last hash seen for a path; cwd is the checkout, null for the owner's files. hash is 'deleted' once the path went missing.
CREATE TABLE IF NOT EXISTS fingerprints (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cwd TEXT, path TEXT NOT NULL, scope TEXT NOT NULL, hash TEXT NOT NULL, ts INTEGER NOT NULL
) WITHOUT ROWID;

-- id is `project:number`. project_id is set by gh's list alone (MERGED): a row with none was only mentioned by a session, and is no row in Worth.
-- size is the owner's, set by PUT /api/worth/size, never by the writer (null: the PR is sized from the counts, #103). counted_lines and counted_files are the lines and files
-- the plugin counted once lockfiles, images, build output and generated files were set aside (null: an older plugin, or gh listed no files). OPENED is session_prs.
-- created_at and issue (#28) are when the PR opened and the issue it closes, from the open-PR read alone (project.open_prs): a PR no read saw has neither. A row that read made has no project_id.
-- ts of a session_prs row is when the session first linked the PR (epoch ms; null for a link recorded before #103): a PR gets the session's work from the session's previous link up to this one.
-- store.ts adds a column to a file made before it was here (CREATE TABLE IF NOT EXISTS does not).
CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY, project_id TEXT, number INTEGER NOT NULL, title TEXT, merged_at INTEGER, additions INTEGER, deletions INTEGER, head TEXT, size TEXT,
  counted_lines INTEGER, counted_files INTEGER, created_at INTEGER, issue INTEGER
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_prs (session_id TEXT NOT NULL, pr_id TEXT NOT NULL, ts INTEGER, PRIMARY KEY (session_id, pr_id)) WITHOUT ROWID;

-- v0.3 slice 4 (#44): one row per test, build or edit claim in a final answer (a main agent's turn, a subagent's report), checked against that agent's own calls when the
-- answer ended (claims.ts). agent_id is `session:agent`; turn_id the turn whose last request holds the text, request_id that request (the text store's `request:<id>`,
-- field `answer`), and `at` and `len` where the claim sits in it: the words are never stored here. `file` is the path an edit claim names. why, when not backed:
-- no_run, stale, failed, no_write; edit_ts and run_ts are the last code edit and the last run the check saw, for the reason it gives. ts is the answer's.
CREATE TABLE IF NOT EXISTS claims (
  agent_id TEXT NOT NULL, turn_id TEXT NOT NULL, n INTEGER NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, file TEXT, backed INTEGER NOT NULL, why TEXT,
  edit_ts INTEGER, run_ts INTEGER, request_id TEXT NOT NULL, at INTEGER NOT NULL, len INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (agent_id, turn_id, n)
) WITHOUT ROWID;

-- v0.4 slice 1 (#27, Factory). open_prs: the open PRs as the plugin last read them from GitHub (project.open_prs), a snapshot per project: a read newer than
-- projects.prs_read_at replaces the project's rows, so a PR merged or closed since leaves. checks and bots are JSON arrays ({ name, state }, { author, at }).
CREATE TABLE IF NOT EXISTS open_prs (
  project_id TEXT NOT NULL, number INTEGER NOT NULL, head TEXT, head_oid TEXT NOT NULL, merge_state TEXT NOT NULL, last_commit_at INTEGER, checks TEXT NOT NULL, bots TEXT NOT NULL,
  PRIMARY KEY (project_id, number)
) WITHOUT ROWID;
-- One finding per project, ref and id, as reviewers and developers reported it (findings.report): the latest report wins, across rounds, and a finding no later
-- report names keeps its fate. ref is `pr:416` for a report whose fence named its PR, else the branch it was made on (a branch name never holds `:`); an open PR reads
-- both its own and its head branch's. A title and a dismissal's reason are text: the text store holds them (node 'finding', id `project|ref|id`), with Content on full only.
-- finding_reports is the last report a ref had (an empty one says "nothing found") and how many lines did not parse, kept until a reviewer's report drops none.
-- reviewed_at (#32) is the time of the latest *reviewer's* report on the ref (the writer's `reviewer`: orb-role, else an agent that wrote no file): the board's Reviewing, Fixing and Gate
-- compare against it, never against a report by an agent that wrote code (a fixer says what it did; that is not a review).
CREATE TABLE IF NOT EXISTS findings (
  project_id TEXT NOT NULL, ref TEXT NOT NULL, id TEXT NOT NULL, severity TEXT NOT NULL, file TEXT NOT NULL, fate TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (project_id, ref, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS finding_reports (project_id TEXT NOT NULL, ref TEXT NOT NULL, ts INTEGER NOT NULL, dropped INTEGER NOT NULL, reviewed_at INTEGER, PRIMARY KEY (project_id, ref)) WITHOUT ROWID;
-- v0.4 slice 2 (#28, issue cost). open_issues: the open issues' numbers and milestones as the plugin last read them, a snapshot per project replaced like open_prs (a read
-- with no `issues` leaves it). budgets: the owner's, set by PUT /api/budget and never by the writer, per project *name* like goal_usd: kind 'milestone' (key the milestone's title:
-- the default for each issue in it) or 'issue' (key the number: that issue's own budget, which wins). No default ships: with none, nothing warns.
-- title (#32) is the issue's own title, sent only with Content on full: the board names its rows with it, and a read without one clears it of the issues the read lists.
-- gone_at (#32) is when an issue left the list (closed, or past gh's limit of 200): the row keeps its milestone and title, so the board can show it as Merged on its milestone when its PR merged.
-- Null: it is in the last read. A later read that lists the issue again (reopened) clears it. ponytail: the closed rows are never pruned (a few a week); a DELETE of the old ones if a project ever closes thousands.
-- mentions (#66) is the issues its text names as `#N`, a JSON array of numbers the plugin found on the machine (at most 20; the text itself is never sent): each read sets it with the row, and
-- null is none, or a plugin from before #66. GET /api/links draws the ones between two issues the board shows.
CREATE TABLE IF NOT EXISTS open_issues (project_id TEXT NOT NULL, number INTEGER NOT NULL, milestone TEXT, title TEXT, gone_at INTEGER, mentions TEXT, PRIMARY KEY (project_id, number)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS budgets (project TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, usd REAL NOT NULL, PRIMARY KEY (project, kind, key)) WITHOUT ROWID;
-- A test run's result per project and commit, from a run on a clean tree (#34; 7 to 64 hex characters, matched against a PR's head by prefix): the latest wins.
CREATE TABLE IF NOT EXISTS gates (project_id TEXT NOT NULL, commit_sha TEXT NOT NULL, result TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (project_id, commit_sha)) WITHOUT ROWID;

-- v0.4 slice 3 (#29, Factory). machine_samples: one row per host, the latest machine.sample the plugin sent (a sample older than the row's changes nothing): free and total memory in bytes (null: the
-- plugin could not read them), Docker's state (ok, absent, stopped) and the running containers as JSON (name, created_at, state, health, memory, and the compose and Testcontainers labels, as the event
-- carries them). The grouping and the flags are a read's (api/machine.ts), against the history as it stands then.
CREATE TABLE IF NOT EXISTS machine_samples (host TEXT PRIMARY KEY, ts INTEGER NOT NULL, mem_free INTEGER, mem_total INTEGER, docker TEXT NOT NULL, containers TEXT NOT NULL) WITHOUT ROWID;

-- v0.4 slice 5 (#31, Stop). One queued stop per session, asked for by the studio (POST /api/stop) and taken by the session's plugin on its poll (GET /api/stop, which sets picked_at);
-- the session's session.stopped event deletes the row. It is tied to the stall it was clicked on, `agent` and `stall_since` (the stall.start's `since`): the plugin ends the turn only if
-- that stall still holds. A stop is live for 10 minutes from requested_at: past that it is never handed out, and the next request (anyone's) prunes it, so a session that is resumed hours
-- later is not stopped by a request nobody remembers.
CREATE TABLE IF NOT EXISTS stops (session_id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL, picked_at INTEGER, agent TEXT NOT NULL, stall_since INTEGER NOT NULL) WITHOUT ROWID;

-- The indexes the writer's own lookups and the reads walk. A read goes from a project down to its calls (projects, sessions, agents, turns), and what it counts
-- must come from an index, not from a table row fetched for every call: that, not the joins, was the cost (#83, slice 2). So calls_turn carries `success`,
-- and a failure, a test run and a permission wait, which a read picks out of a project's whole history, have a partial index of their own (a few percent of the table).
CREATE INDEX IF NOT EXISTS projects_name ON projects (name);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions (project_id);
CREATE INDEX IF NOT EXISTS agents_session ON agents (session_id);
CREATE INDEX IF NOT EXISTS agents_parent ON agents (parent_id);
CREATE INDEX IF NOT EXISTS turns_agent ON turns (agent_id);
CREATE INDEX IF NOT EXISTS prompts_session ON prompts (session_id);
CREATE INDEX IF NOT EXISTS requests_turn ON api_requests (turn_id);
CREATE INDEX IF NOT EXISTS requests_ts ON api_requests (ts);
CREATE INDEX IF NOT EXISTS calls_turn_success ON tool_calls (turn_id, success);
CREATE INDEX IF NOT EXISTS calls_failed ON tool_calls (turn_id) WHERE success = 0;
CREATE INDEX IF NOT EXISTS calls_tests ON tool_calls (turn_id) WHERE command_class = 'test';
CREATE INDEX IF NOT EXISTS calls_waits ON tool_calls (turn_id) WHERE waited = 1;
CREATE INDEX IF NOT EXISTS calls_ts ON tool_calls (ts);
CREATE INDEX IF NOT EXISTS changes_project ON changes (project_id, ts);
CREATE INDEX IF NOT EXISTS fingerprints_project ON fingerprints (project_id);
CREATE INDEX IF NOT EXISTS files_project ON files_touched (project_id, path);
CREATE INDEX IF NOT EXISTS agents_spawn ON agents (spawn_tool_use_id);
CREATE INDEX IF NOT EXISTS skill_loads_turn ON skill_loads (turn_id, ts);
CREATE INDEX IF NOT EXISTS session_prs_pr ON session_prs (pr_id);
CREATE INDEX IF NOT EXISTS claims_session ON claims (session_id);
