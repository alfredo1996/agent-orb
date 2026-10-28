import type { Event, EventKind } from '@agent-orb/shared';
import roles from '@agent-orb/shared/roles.json' with { type: 'json' };
import { costUsd } from '../cost.ts';
import { all, get, run, type Store } from './store.ts';

// The history writer (#81): a batch of events into the store's tables. Every statement is an upsert on the key the table is known by, one execution per event,
// which SQLite applies in the order they come: two events for one row in a batch fold in that order, and an event that says nothing about a field keeps
// what is stored. The ids already written are the `ingested` table; the whole batch is one transaction.
// ponytail: a session is on one project, the first an event named (then the re-home).

/** Who is writing. The plugin's events are the session's record while it ran: the writer keeps their first and last ts, and the import fills only outside them. */
export type Source = 'plugin' | 'import';
type Of<K extends EventKind> = Extract<Event, { kind: K }>;
const only = <K extends EventKind>(events: Event[], kind: K) => events.filter((e): e is Of<K> => e.kind === kind);
const uniqueBy = <T>(rows: T[], key: (r: T) => string) => [...new Map(rows.map((r) => [key(r), r])).values()];

// Agent ids are scoped to their session; the main agent has no agent_id of its own.
const keyOf = (e: Event, agentId: string | undefined) => `${e.session_id}:${agentId ?? 'main'}`;
const agentKey = (e: Event) => keyOf(e, e.agent_id);
const projectId = (e: Event) => e.project.git_remote ?? `${e.host}:${e.project.cwd}`;
const roleOf = (type: string) => (roles as Record<string, string>)[type] ?? null;
const json = (v: unknown[] | undefined | null) => (v ? JSON.stringify(v) : null);

// The MERGE of a timestamp the earliest event sets.
const earliest = (col: string, param: string) => `CASE WHEN ${col} IS NULL OR :${param} < ${col} THEN :${param} ELSE ${col} END`;

/** Idempotent on event id, in one transaction (but for a repeated session.pr, below). Answers how many events were new. */
export function writeEvents(db: Store, events: Event[], source: Source) {
  db.exec('BEGIN IMMEDIATE'); // the write lock now: the import is a second process on this file
  try {
    const seen = uniqueBy(events, (e) => e.id);
    const fresh = seen.filter((e) => Number(run(db, 'INSERT OR IGNORE INTO ingested (id) VALUES (:id)', { id: e.id }).changes) === 1).sort((a, b) => a.ts - b.ts);
    if (fresh.length) writeRows(db, fresh, source);
    // The one thing a duplicate still does (#103): a PR link stored before links had times has no event left to take its time from (only the ids are kept), and the import
    // makes the same id again from the same log line. So a repeated session.pr moves its link's time to its own when the stored one is null or later; everything else of a duplicate is skipped.
    const freshIds = new Set(fresh.map((e) => e.id));
    for (const e of only(seen.filter((e) => !freshIds.has(e.id)), 'session.pr')) {
      run(db, 'UPDATE session_prs SET ts = :ts WHERE session_id = :session AND pr_id = :id AND (ts IS NULL OR ts > :ts)', { ts: e.ts, session: e.session_id, id: `${projectId(e)}:${e.data.number}` });
    }
    db.exec('COMMIT');
    return { accepted: fresh.length, duplicates: events.length - fresh.length };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ponytail: the writer assumes a session's events arrive in ts order (the mod's FIFO outbox): a call that arrives before an
// earlier one of its session is still one row with the right fields; only what is derived from order on read can differ.
// The import (#86) sends a session file by file, each in the order of its lines, and its session.start and subagent headers last: the rows are the same, because
// every statement below is an upsert on the row's key, and the only first-wins fields (a model, a call's turn) are set by events that no order separates.
function writeRows(db: Store, ev: Event[], source: Source) {
  for (const e of uniqueBy(ev.toReversed(), (e) => e.session_id)) { // reversed: uniqueBy keeps the last, and a session is on the first project its events name
    run(db, `INSERT INTO projects (id, name, git_remote) VALUES (:id, :name, :remote)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, git_remote = coalesce(excluded.git_remote, projects.git_remote)`,
    { id: projectId(e), name: e.project.name, remote: e.project.git_remote });
    run(db, 'INSERT OR IGNORE INTO sessions (id, user_id, host, project_id) VALUES (:id, :user, :host, :project)', { id: e.session_id, user: e.user_id, host: e.host, project: projectId(e) });
  }
  for (const e of uniqueBy(ev, (e) => `${projectId(e)}\0${e.project.cwd}`)) run(db, 'INSERT OR IGNORE INTO project_cwds (project_id, cwd) VALUES (:id, :cwd)', { id: projectId(e), cwd: e.project.cwd });

  // v0.2 slice 1: the import knows no remote, so it files a session under `host:cwd`. When the plugin later reports that cwd with its remote, the import's
  // sessions move to the project the remote names, and the stub goes (with a role rule the owner set on it moving along).
  // The files its calls touched take the new key (a path could count twice across the move).
  for (const e of uniqueBy(ev.filter((e) => e.project.git_remote), (e) => `${e.host}:${e.project.cwd}`)) {
    const id = projectId(e);
    const old = `${e.host}:${e.project.cwd}`;
    if (old === id || !get(db, 'SELECT 1 AS x FROM projects WHERE id = :old', { old })) continue;
    const p = { id, old };
    run(db, 'UPDATE sessions SET project_id = :id WHERE project_id = :old', p);
    run(db, 'INSERT OR IGNORE INTO role_rules (project_id, agent_type, role) SELECT :id, agent_type, role FROM role_rules WHERE project_id = :old', p);
    run(db, 'DELETE FROM role_rules WHERE project_id = :old', { old });
    run(db, 'UPDATE files_touched SET project_id = :id WHERE project_id = :old', p);
    for (const table of ['changes', 'fingerprints']) run(db, `DELETE FROM ${table} WHERE project_id = :old`, { old }); // the plugin sends git's again, under the new id; the fingerprints start over
    run(db, 'DELETE FROM project_cwds WHERE project_id = :old', { old });
    run(db, 'DELETE FROM projects WHERE id = :old', { old });
  }

  const spawns = only(ev, 'agent.spawn');
  const agentRef = (e: Event, agentId?: string) => ({
    id: keyOf(e, agentId), session_id: e.session_id,
    ...(agentId ? { type: null, role: null, role_source: null } : { type: 'main', role: roleOf('main'), role_source: 'map' }),
  });
  for (const r of uniqueBy([...ev.map((e) => agentRef(e, e.agent_id)), ...spawns.map((e) => agentRef(e, e.parent_agent_id))], (r) => r.id)) {
    run(db, 'INSERT OR IGNORE INTO agents (id, session_id, type, role, role_source) VALUES (:id, :session_id, :type, :role, :role_source)', r);
  }
  for (const e of uniqueBy(ev.filter((e) => e.turn_id), (e) => e.turn_id!)) run(db, 'INSERT OR IGNORE INTO turns (id, agent_id) VALUES (:id, :agent)', { id: e.turn_id, agent: agentKey(e) });

  for (const e of spawns) {
    // Precedence (§15, 2026-10-20): a fix on this agent (manual) > a rule for its type in the project > declared (orb-role) > roles.json.
    // The task prompt goes to the text store (content-store.ts), never to this one.
    // The model check (v0.2 slice 2): a spawn the plugin flagged marks its Agent pricier. The columns are coalesced, so the import's spawn for the same
    // agent, which carries no check, does not erase what the plugin recorded.
    const { declared_role, declared_model, model_check, tool_use_id, agent_type, description, model } = e.data;
    const ruled = get(db, 'SELECT r.role FROM sessions s JOIN role_rules r ON r.project_id = s.project_id AND r.agent_type = :type WHERE s.id = :session', { type: agent_type, session: e.session_id })?.role as string | undefined;
    const mapped = declared_role ?? roleOf(agent_type);
    run(db, `INSERT INTO agents (id, session_id, parent_id, type, description, model, started_at, role, role_source, spawn_tool_use_id, declared_model, allowed_model, check_source, pricier)
             VALUES (:id, :session, :parent, :type, :description, :model, :ts, :role, :role_source, :tool_use_id, :declared_model, :allowed, :check_source, :pricier)
             ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, type = excluded.type, description = excluded.description, model = excluded.model,
               started_at = excluded.started_at, spawn_tool_use_id = excluded.spawn_tool_use_id,
               declared_model = coalesce(excluded.declared_model, agents.declared_model), allowed_model = coalesce(excluded.allowed_model, agents.allowed_model),
               check_source = coalesce(excluded.check_source, agents.check_source), pricier = coalesce(excluded.pricier, agents.pricier),
               role = CASE WHEN agents.role_source = 'manual' THEN agents.role ELSE excluded.role END,
               role_source = CASE WHEN agents.role_source = 'manual' THEN 'manual' ELSE excluded.role_source END`,
    {
      id: agentKey(e), session: e.session_id, parent: keyOf(e, e.parent_agent_id), type: agent_type, description: description ?? null, model, ts: e.ts, tool_use_id,
      role: ruled ?? mapped, role_source: ruled ? 'rule' : declared_role ? 'declared' : mapped && 'map',
      declared_model, allowed: model_check?.allowed, check_source: model_check?.source, pricier: model_check ? true : undefined,
    });
  }

  // An import (v0.2 slice 1) never overwrites what the plugin recorded: it sets model, version and content only where the session has none,
  // and it does not claim a session that has started already (an old plugin session has no source, and the import's would read as its own).
  for (const e of only(ev, 'session.start')) {
    const imp = e.data.source === 'import';
    run(db, `UPDATE sessions SET
               started_at = ${earliest('started_at', 'ts')},
               model = CASE WHEN :imp THEN coalesce(model, :model) ELSE :model END,
               claude_version = CASE WHEN :imp THEN coalesce(claude_version, :version) ELSE :version END,
               content = CASE WHEN :imp THEN coalesce(content, :content) ELSE coalesce(:content, content) END,
               source = CASE WHEN :imp AND started_at IS NOT NULL THEN source ELSE coalesce(source, :source) END,
               recorded = CASE WHEN :imp THEN recorded ELSE 1 END
             WHERE id = :id`,
    { id: e.session_id, ts: e.ts, model: e.data.model, version: e.data.claude_version, content: e.data.content, source: e.data.source, imp });
    run(db, `UPDATE agents SET model = coalesce(model, :model), started_at = ${earliest('started_at', 'ts')} WHERE id = :id`, { id: agentKey(e), ts: e.ts, model: e.data.model });
  }

  for (const e of only(ev, 'session.end')) run(db, 'UPDATE sessions SET ended_at = :ts WHERE id = :id', { id: e.session_id, ts: e.ts });

  for (const e of only(ev, 'prompt.submit')) {
    run(db, `INSERT INTO prompts (id, session_id, agent_id, ts, length) VALUES (:id, :session, :agent, :ts, :length)
             ON CONFLICT (id) DO UPDATE SET ts = excluded.ts, length = excluded.length`,
    { id: e.prompt_id ?? e.id, session: e.session_id, agent: agentKey(e), ts: e.ts, length: e.data.length });
  }

  for (const e of ev) {
    if (e.kind === 'turn.start') run(db, 'UPDATE turns SET started_at = coalesce(:ts, started_at) WHERE id = :id', { id: e.turn_id, ts: e.ts });
    if (e.kind === 'turn.complete') run(db, 'UPDATE turns SET duration_ms = coalesce(:ms, duration_ms) WHERE id = :id', { id: e.turn_id, ms: e.data.duration_ms });
  }

  for (const e of only(ev, 'turn.step')) {
    const u = e.data.usage;
    run(db, `INSERT INTO api_requests (id, turn_id, ts, model, input, output, cache_read, cache_creation, cost_usd)
             VALUES (:id, :turn, :ts, :model, :input, :output, :cache_read, :cache_creation, :cost)
             ON CONFLICT (id) DO UPDATE SET turn_id = excluded.turn_id, ts = excluded.ts, model = excluded.model, input = excluded.input, output = excluded.output,
               cache_read = excluded.cache_read, cache_creation = excluded.cache_creation, cost_usd = excluded.cost_usd`,
    { id: e.id, turn: e.turn_id, ts: e.ts, model: e.data.model, input: u.input, output: u.output, cache_read: u.cache_read, cache_creation: u.cache_creation, cost: costUsd(e.data.model, u) });
    // The first request's model is an agent's when nothing else said: the plugin's session.start and spawn come first. The import's come last (#86), so its requests
    // would set the model of whichever batch is written first, and its start and spawn say it exactly.
    if (source === 'plugin') run(db, 'UPDATE agents SET model = coalesce(model, :model) WHERE id = :id', { id: agentKey(e), model: e.data.model });
  }

  // v0.3 slice 1: command_class and error_class are coalesced, so an event that says nothing about them (an older plugin's, the import before this
  // slice) never erases the one stored. Slice 3 (#45): error_shape the same.
  // A call's turn is the first that named one, so a call a forked session copied stays one row, in the session that wrote it first (the events come in ts order).
  for (const e of only(ev, 'tool.call')) {
    const d = e.data;
    run(db, `INSERT INTO tool_calls (tool_use_id, turn_id, tool, ts, input_size, command_class) VALUES (:id, :turn, :tool, :ts, :input_size, :command_class)
             ON CONFLICT (tool_use_id) DO UPDATE SET tool = excluded.tool, ts = excluded.ts, input_size = excluded.input_size,
               command_class = coalesce(excluded.command_class, tool_calls.command_class), turn_id = coalesce(tool_calls.turn_id, excluded.turn_id)`,
    { id: d.tool_use_id, turn: e.turn_id, tool: d.tool, ts: e.ts, input_size: d.input_size, command_class: d.command_class });
  }

  for (const e of only(ev, 'tool.result')) {
    const d = e.data;
    run(db, `INSERT INTO tool_calls (tool_use_id, success, error_type, error_class, error_shape, duration_ms, output_size, output_skipped)
             VALUES (:id, :success, :error_type, :error_class, :error_shape, :duration_ms, :output_size, :output_skipped)
             ON CONFLICT (tool_use_id) DO UPDATE SET success = excluded.success, error_type = excluded.error_type, duration_ms = excluded.duration_ms,
               error_class = coalesce(excluded.error_class, tool_calls.error_class), error_shape = coalesce(excluded.error_shape, tool_calls.error_shape),
               output_size = excluded.output_size, output_skipped = excluded.output_skipped`,
    { id: d.tool_use_id, success: d.success, error_type: d.error_type, error_class: d.error_class, error_shape: d.error_shape, duration_ms: d.duration_ms, output_size: d.output_size, output_skipped: d.output_skipped });
    for (const f of d.files_touched) {
      run(db, 'INSERT OR IGNORE INTO files_touched (tool_use_id, path, mode, project_id) VALUES (:id, :path, :mode, :project)', { id: d.tool_use_id, path: f.path, mode: f.mode, project: projectId(e) });
    }
  }

  for (const e of only(ev, 'agent.complete')) run(db, 'UPDATE agents SET ended_at = :ts WHERE id = :id', { id: agentKey(e), ts: e.ts });

  // Slice 5: when, how and in which turn a skill loaded, typed or preloaded too (a Skill call alone missed those).
  for (const e of only(ev, 'skill.load')) {
    run(db, 'INSERT OR IGNORE INTO skill_loads (id, session_id, turn_id, tool_use_id, skill, ts, how, source) VALUES (:id, :session, :turn, :tool_use_id, :skill, :ts, :how, :source)',
      { id: e.id, session: e.session_id, turn: e.turn_id, tool_use_id: e.data.tool_use_id, skill: e.data.skill, ts: e.ts, how: e.data.how, source: e.data.source });
  }

  // v0.2 slice 1: the commits that touched the project's agents, skills or CLAUDE.md; a Change is keyed by project and sha, so a session that sends
  // the same 90 days again changes nothing. Slice 3: `blobs` is each file's blob, parallel to `files`; a resend from a plugin that sends none keeps what is there.
  for (const e of only(ev, 'project.changes')) {
    for (const c of e.data.commits) {
      run(db, `INSERT INTO changes (id, project_id, sha, ts, subject, files, hashes, source) VALUES (:id, :project, :sha, :ts, :subject, :files, :hashes, 'git')
               ON CONFLICT (id) DO UPDATE SET sha = excluded.sha, ts = excluded.ts, subject = excluded.subject, files = excluded.files,
                 hashes = coalesce(excluded.hashes, changes.hashes), source = 'git'`,
      { id: `${projectId(e)}:${c.sha}`, project: projectId(e), sha: c.sha, ts: c.ts, subject: c.subject, files: json(c.files), hashes: json(c.blobs) });
    }
  }

  writeFingerprints(db, only(ev, 'project.fingerprint'));

  // v0.3 slice 2 (#42, Worth): a PullRequest is one per project and number. gh's list fills in what it is (title, merge time, lines, branch, and #103 the counted lines and files) and links it
  // to the project; a session's link makes the row if it is not there and links the session to it, whichever comes first. Columns are coalesced, so a list from
  // an excluded project (no title, no branch) never erases the ones a list sent before, and `size`, which only the owner sets (PUT /api/worth/size), is never
  // touched here. The project is set by the list alone: a PR gh never listed as merged is no row in Worth.
  for (const e of only(ev, 'project.prs')) {
    for (const x of e.data.prs) {
      run(db, `INSERT INTO pull_requests (id, project_id, number, title, merged_at, additions, deletions, head, counted_lines, counted_files)
               VALUES (:id, :project, :number, :title, :merged_at, :additions, :deletions, :head, :counted_lines, :counted_files)
               ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, number = excluded.number, title = coalesce(excluded.title, pull_requests.title),
                 merged_at = excluded.merged_at, additions = excluded.additions, deletions = excluded.deletions, head = coalesce(excluded.head, pull_requests.head),
                 counted_lines = coalesce(excluded.counted_lines, pull_requests.counted_lines), counted_files = coalesce(excluded.counted_files, pull_requests.counted_files)`,
      { id: `${projectId(e)}:${x.number}`, project: projectId(e), number: x.number, title: x.title, merged_at: x.merged_at, additions: x.additions, deletions: x.deletions, head: x.head,
        counted_lines: x.counted_lines, counted_files: x.counted_files });
    }
  }
  for (const e of only(ev, 'session.pr')) {
    const id = `${projectId(e)}:${e.data.number}`;
    run(db, 'INSERT OR IGNORE INTO pull_requests (id, number) VALUES (:id, :number)', { id, number: e.data.number });
    // The link's time is the earliest the session was seen to name the PR (the import reads the first `pr-link` line; the plugin sees it again whenever a command prints it).
    run(db, `INSERT INTO session_prs (session_id, pr_id, ts) VALUES (:session, :id, :ts)
             ON CONFLICT (session_id, pr_id) DO UPDATE SET ts = ${earliest('session_prs.ts', 'ts')}`, { session: e.session_id, id, ts: e.ts });
  }

  // Slice 5: the skills and custom agents a session lists, one SkillDef per project, kind, origin and name. A field a later event leaves out keeps
  // what an earlier one said (a plugin skill's references arrive with its first load). tokens is 0 until one says.
  const def = (e: Event, kind: 'skill' | 'agent', d: { name: string; source: string; plugin?: string; tokens?: number; description?: string; refs?: { skills: string[]; agents: string[] }; preload?: string[] }) => ({
    session: e.session_id, id: `${projectId(e)}|${kind}|${d.source}|${d.name}`, name: d.name, kind, source: d.source, plugin: d.plugin ?? null,
    tokens: d.tokens ?? null, description: d.description ?? null, calls_skills: json(d.refs?.skills), calls_agents: kind === 'skill' ? json(d.refs?.agents) : null, preload: json(d.preload),
  });
  for (const d of [
    ...only(ev, 'skills.catalog').flatMap((e) => [...e.data.skills.map((s) => def(e, 'skill', s)), ...e.data.agents.map((a) => def(e, 'agent', a))]),
    ...only(ev, 'skill.load').filter((e) => e.data.source)
      .map((e) => def(e, 'skill', { name: e.data.skill, source: e.data.source!, plugin: e.data.plugin, description: e.data.description, refs: e.data.refs })),
  ]) {
    run(db, `INSERT INTO skill_defs (id, name, kind, source, plugin, tokens, description, calls_skills, calls_agents, preload)
             VALUES (:id, :name, :kind, :source, :plugin, coalesce(:tokens, 0), :description, :calls_skills, :calls_agents, :preload)
             ON CONFLICT (id) DO UPDATE SET name = :name, kind = :kind, source = :source, plugin = coalesce(:plugin, skill_defs.plugin), tokens = coalesce(:tokens, skill_defs.tokens),
               description = coalesce(:description, skill_defs.description), calls_skills = coalesce(:calls_skills, skill_defs.calls_skills),
               calls_agents = coalesce(:calls_agents, skill_defs.calls_agents), preload = coalesce(:preload, skill_defs.preload)`,
    { id: d.id, name: d.name, kind: d.kind, source: d.source, plugin: d.plugin, tokens: d.tokens, description: d.description, calls_skills: d.calls_skills, calls_agents: d.calls_agents, preload: d.preload });
    run(db, 'INSERT OR IGNORE INTO session_skill_defs (session_id, def_id) VALUES (:session, :id)', { session: d.session, id: d.id });
  }

  // Task ids from the Task tools are per-session counters ("1", "2"), so they are scoped like agents.
  for (const e of ev) {
    if (e.kind !== 'task.create' && e.kind !== 'task.complete') continue;
    const id = `${e.session_id}:${e.data.task_id}`;
    run(db, 'INSERT INTO tasks (id, subject, status) VALUES (:id, :subject, :status) ON CONFLICT (id) DO UPDATE SET subject = excluded.subject, status = excluded.status', { id, subject: e.data.subject, status: e.data.status });
    run(db, 'INSERT OR IGNORE INTO agent_tasks (agent_id, task_id) VALUES (:agent, :id)', { agent: agentKey(e), id });
  }

  for (const e of only(ev, 'outbox.dropped')) run(db, 'UPDATE sessions SET dropped_events = coalesce(dropped_events, 0) + :count WHERE id = :id', { id: e.session_id, count: e.data.count });

  // A tool held at the permission prompt: the Ledger's "waiting on you" (its run time is the ceiling of the wait).
  for (const e of only(ev, 'tool.waiting')) {
    run(db, 'INSERT INTO tool_calls (tool_use_id, waited) VALUES (:id, 1) ON CONFLICT (tool_use_id) DO UPDATE SET waited = 1', { id: e.data.tool_use_id });
  }

  // session.compact and stall.* have no table: they feed Live (/stream) and are only marked as ingested.

  // The plugin's stretch (#79): the first and last ts of the prompts, requests and calls it wrote. The import fills only outside it. A session with nothing
  // but its start has none, so the logs fill all of it; the import's own events, and a duplicate the import wrote first, are never the plugin's.
  if (source === 'plugin') {
    const span = new Map<string, [number, number]>();
    for (const e of ev) {
      if (e.kind !== 'prompt.submit' && e.kind !== 'turn.step' && e.kind !== 'tool.call') continue;
      const [lo, hi] = span.get(e.session_id) ?? [e.ts, e.ts];
      span.set(e.session_id, [Math.min(lo, e.ts), Math.max(hi, e.ts)]);
    }
    for (const [id, [lo, hi]] of span) {
      run(db, 'UPDATE sessions SET plugin_first = min(coalesce(plugin_first, :lo), :lo), plugin_last = max(coalesce(plugin_last, :hi), :hi) WHERE id = :id', { id, lo, hi });
    }
  }
}

type Fp = { id: string; project: string; cwd: string | null; path: string; scope: 'project' | 'user'; hash: string; ts: number };
const DELETED = 'deleted';

/**
 * v0.2 slice 3 (PROJECT.md §15, 2026-10-24): what a change watches, from now on. One fingerprint keeps the last hash seen for a path
 * (`deleted` once the path went missing). A project's files are kept per checkout, the event's `project.checkout` (a worktree session's own working
 * tree; its `cwd` is the repository's root, the main tree's) or else its `project.cwd` (the main checkout and each git
 * worktree have their own `.claude/`, and sessions alternate between them), so a checkout's first event is its own baseline and a deletion is
 * judged within that checkout; the owner's files (`~/.claude/...`) are read by every checkout alike and are kept per project. A path seen for the
 * first time is a baseline and no change; a known path with another hash is updated and makes a Change (source `fingerprint`, id by project,
 * path and hash, so one edit seen in two checkouts is one Change, dated at the latest sighting); a known path that an event leaves out makes a
 * deletion Change. A deletion is judged within the scope (project or user) of the paths the event lists, and only for a scope it lists at
 * least one of: an event with no home to read does not delete the owner's files. The events come in time order and are folded here, one after the
 * other, because a batch may hold several for one project and a statement per kind would read them all before any wrote.
 * ponytail: a Change's id is by path and hash, so a version that comes back (A, B, A, B) keeps the latest Change for it and a path deleted twice
 * keeps its latest deletion; the owner's files are kept per project, not per host, so two machines with different rules each read as a change
 * to the other (key by host if that is ever seen); an event that arrives out of time order can flip a path back; a `git switch` inside one
 * checkout is a real edit there and reads as a change; a removed worktree's fingerprints stay (prune by `project_cwds` if they pile up).
 */
function writeFingerprints(db: Store, events: Of<'project.fingerprint'>[]) {
  if (!events.length) return;
  const known = new Map<string, Fp>(); // by id: what is stored, then what the events leave behind
  for (const project of new Set(events.map(projectId))) {
    for (const r of all(db, 'SELECT id, project_id AS project, cwd, path, scope, hash, ts FROM fingerprints WHERE project_id = :project', { project })) known.set(r.id, r as Fp);
  }

  const touched = new Map<string, Fp>();
  const changes = new Map<string, { id: string; project: string; ts: number; files: string[]; hashes: string[]; scope: string }>();
  const settle = (fp: Fp, change: boolean) => {
    known.set(fp.id, fp);
    touched.set(fp.id, fp);
    if (change) changes.set(`${fp.project}:fp:${fp.path}:${fp.hash}`, { id: `${fp.project}:fp:${fp.path}:${fp.hash}`, project: fp.project, ts: fp.ts, files: [fp.path], hashes: [fp.hash], scope: fp.scope });
  };
  for (const e of events) { // already in time order
    const project = projectId(e);
    const listed = new Map(e.data.files.map((f) => [f.path, f]));
    const scopes = new Set(e.data.files.map((f) => f.scope));
    const cwdOf = (scope: 'project' | 'user') => (scope === 'project' ? e.project.checkout ?? e.project.cwd : null); // a fingerprint's checkout; the owner's files have none
    for (const f of listed.values()) {
      const cwd = cwdOf(f.scope);
      const id = cwd === null ? `${project}|${f.path}` : `${project}|${cwd}|${f.path}`;
      const was = known.get(id);
      if (!was || was.hash !== f.hash) settle({ id, project, cwd, path: f.path, scope: f.scope, hash: f.hash, ts: e.ts }, was !== undefined);
    }
    for (const was of [...known.values()]) {
      if (was.project === project && scopes.has(was.scope) && was.cwd === cwdOf(was.scope) && !listed.has(was.path) && was.hash !== DELETED) settle({ ...was, hash: DELETED, ts: e.ts }, true);
    }
  }
  for (const fp of touched.values()) {
    run(db, `INSERT INTO fingerprints (id, project_id, cwd, path, scope, hash, ts) VALUES (:id, :project, :cwd, :path, :scope, :hash, :ts)
             ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, cwd = excluded.cwd, path = excluded.path, scope = excluded.scope, hash = excluded.hash, ts = excluded.ts`, fp);
  }
  for (const c of changes.values()) {
    run(db, `INSERT INTO changes (id, project_id, ts, files, hashes, scope, source) VALUES (:id, :project, :ts, :files, :hashes, :scope, 'fingerprint')
             ON CONFLICT (id) DO UPDATE SET ts = excluded.ts, files = excluded.files, hashes = excluded.hashes, scope = excluded.scope, source = 'fingerprint'`,
    { id: c.id, project: c.project, ts: c.ts, files: json(c.files), hashes: json(c.hashes), scope: c.scope });
  }
}
