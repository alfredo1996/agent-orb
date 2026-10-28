import { z } from 'zod';
import { COMMAND_CLASSES, ERROR_CLASSES } from './classes.ts';

// The mod ↔ server contract (PROJECT.md §5).
// z.object() drops every key it does not name, at every level. Content (prompts, answers, thinking,
// tool input and output) is accepted only in the fields named for it, and only when the owner turned
// content on (§15, 2026-10-20); a field is capped here too, whatever the sender did.

const count = z.number().int().nonnegative();
const id = z.string().min(1);

const Usage = z.object({ input: count, output: count, cache_read: count, cache_creation: count });

const Base = z.object({
  v: z.literal(1),
  id: z.uuid(),
  ts: z.number().int().positive(),
  host: id,
  user_id: id,
  team_id: id.optional(),
  session_id: id,
  // `cwd` is the repository's root (for a git worktree, the main working tree's: project identity hangs on it); `checkout` is the session's own
  // working tree, sent only when it is not `cwd`, i.e. in a worktree (v0.2 slice 3).
  project: z.object({ cwd: id, name: id, git_remote: id.optional(), git_branch: id.optional(), checkout: id.optional() }),
  agent_id: id.optional(),
  parent_agent_id: id.optional(),
  turn_id: id.optional(),
  prompt_id: id.optional(),
});

// §15: one content field is at most 32 KB; a longer one keeps its start (3/4) and end (1/4), with a marker.
export const CONTENT_MAX = 32_768;
export function capText(s: string, max = CONTENT_MAX): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${s.slice(0, head)}\n[… ${(s.length - head - tail).toLocaleString('en')} characters cut …]\n${s.slice(-tail)}`;
}
const content = z.string().transform((s) => capText(s));

const inTurn = { turn_id: id };
// A skill's or agent's one-line description (its frontmatter or the typeahead's), and the other skills and agents its text names.
const describe = z.string().transform((s) => (s.length > 300 ? `${s.slice(0, 299)}…` : s));
const Refs = z.object({ skills: z.array(id).max(200), agents: z.array(id).max(200) });
// A git object name: SHA-1 (40) or SHA-256 (64) hex.
const BLOB = z.string().regex(/^[0-9a-f]{40,64}$/);
const Stall = z.object({ tool_use_id: id.optional(), tool: id.optional(), since: z.number().int().positive() });
const Task = z.object({ task_id: id, subject: z.string(), status: id });
// §7: the roles an agent definition may declare as `orb-role`.
export const ROLES = ['orchestrator', 'developer', 'researcher', 'reviewer', 'skeptic', 'tester', 'planner', 'writer', 'ops', 'consultant', 'generalist'] as const;
export type Role = (typeof ROLES)[number];
// Issue #8: what each role means, in one line, for the Pipeline's panel, tooltip and phone list.
export const ROLE_INFO: Record<Role, string> = {
  orchestrator: 'Runs the session: takes the request, plans it and hands pieces to other agents.',
  developer: 'Writes and changes code.',
  researcher: 'Reads and searches (files, docs, the web) and reports back; changes nothing.',
  reviewer: 'Reads finished work and judges it against the request and the rules.',
  skeptic: 'Tries to break the work: looks for what is wrong, missing or untested.',
  tester: 'Runs the tests and checks, and reports what passed and what failed.',
  planner: 'Designs how a change should be made before anyone builds it.',
  writer: 'Writes prose: docs, PR bodies, issues, reports.',
  ops: 'Runs and changes the environment: builds, deploys, servers, CI.',
  consultant: 'Answers questions about a tool or product from its documentation.',
  generalist: 'A general-purpose agent that takes whatever task it is given.',
};

// v0.2 slice 2, the model check: the families a model is ranked by (haiku < sonnet < opus < fable = mythos; family rank, not exact price).
export const MODEL_FAMILIES = ['haiku', 'sonnet', 'opus', 'fable', 'mythos'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

export const Event = z.discriminatedUnion('kind', [
  Base.extend({
    kind: z.literal('session.start'),
    data: z.object({ model: id, source: id, claude_version: id, plugin_version: id, content: z.enum(['off', 'full', 'excluded']).optional() }),
  }),
  Base.extend({ kind: z.literal('session.end'), data: z.object({ reason: id }) }),
  Base.extend({ kind: z.literal('session.compact'), data: z.object({ tokens_before: count, tokens_after: count }) }),
  Base.extend({ kind: z.literal('prompt.submit'), data: z.object({ length: count, text: content.optional() }) }),
  Base.extend({ kind: z.literal('turn.start'), ...inTurn, data: z.object({}) }),
  Base.extend({
    kind: z.literal('turn.step'),
    ...inTurn,
    data: z.object({ model: id, usage: Usage, stop_reason: id.nullable(), tool_use_ids: z.array(id), answer: content.optional(), thinking: content.optional() }),
  }),
  Base.extend({
    kind: z.literal('turn.complete'),
    ...inTurn,
    data: z.object({
      duration_ms: count,
      usage_total: Usage,
      reason: z.enum(['answer', 'aborted', 'refusal', 'error']),
      answer_length: count,
      context_percent: z.number().min(0).max(100).optional(), // the session's context window in use, main loop only
    }),
  }),
  Base.extend({
    kind: z.literal('agent.spawn'),
    agent_id: id, // the child; parent_agent_id absent = the main agent
    data: z.object({
      tool_use_id: id,
      agent_type: id,
      description: z.string().transform((s) => s.slice(0, 200)).optional(),
      model: id,
      prompt_length: count,
      declared_role: z.enum(ROLES).optional(), // `orb-role` from the agent definition's frontmatter
      declared_model: id.optional(), // `model:` from the agent definition's frontmatter, as written
      // Present only when the agent runs on a pricier model than it should: what it is held to, and whether its file or the owner's ceiling says so.
      model_check: z.object({ allowed: z.enum(MODEL_FAMILIES), source: z.enum(['file', 'ceiling']) }).optional(),
      prompt: content.optional(), // the task the subagent was given
    }),
  }),
  Base.extend({
    kind: z.literal('agent.complete'),
    agent_id: id,
    data: z.object({ duration_ms: count, usage_total: Usage, report_length: count }),
  }),
  // v0.3 slice 1 (#43): `command_class` is on a Bash call only, `error_class` on a failed result only, both worked out where the text is, so they
  // travel with Content off and no tool text leaves the machine (classes.ts).
  Base.extend({ kind: z.literal('tool.call'), data: z.object({ tool_use_id: id, tool: id, input_size: count, input: content.optional(), command_class: z.enum(COMMAND_CLASSES).optional() }) }),
  Base.extend({
    kind: z.literal('tool.result'),
    data: z.object({
      tool_use_id: id,
      success: z.boolean(),
      error_type: id.optional(),
      error_class: z.enum(ERROR_CLASSES).optional(),
      // v0.3 slice 3 (#45): on a failed result only. A named pattern (`sleep_blocked`) or `h:` and 8 hex digits, a hash of the failure's first line (classes.ts errorShape).
      error_shape: z.string().regex(/^(?:[a-z_]+|h:[0-9a-f]{8})$/).optional(),
      duration_ms: count,
      output_size: count,
      // project-relative paths; mode feeds (ToolCall)-[:TOUCHED {mode}]->(File)
      files_touched: z.array(z.object({ path: id, mode: z.enum(['read', 'write']) })),
      output: content.optional(),
      output_skipped: z.enum(['env-file']).optional(), // why no output was sent although content is on
    }),
  }),
  // tool_use_id is not in §5: optional, so the writer can tie the skill to its Skill tool call when the mod knows it.
  // Slice 5: how it started, whose it is, and the names its text mentions (docs/verified.md, Skills).
  Base.extend({ kind: z.literal('skill.load'), data: z.object({
    skill: id, plugin: id.optional(), tool_use_id: id.optional(),
    how: z.enum(['typed', 'tool', 'preload']).optional(), source: id.optional(), description: describe.optional(), refs: Refs.optional(),
  }) }),
  // v0.2 slice 1: the commits of the past 90 days that touched the project's agents, skills or CLAUDE.md, from git. Metadata only:
  // a hash, a time, the subject line and the paths (the project's own, relative), never a diff or a body.
  // Slice 3: `blobs` is each file's new git blob id, parallel to `files` (all zeros = deleted), so a fingerprint can be matched to its commit.
  Base.extend({ kind: z.literal('project.changes'), data: z.object({
    commits: z.array(z.object({
      sha: z.string().regex(/^[0-9a-f]{7,40}$/),
      ts: z.number().int().positive(),
      subject: z.string().transform((s) => s.slice(0, 200)).optional(),
      files: z.array(id).max(50),
      blobs: z.array(BLOB).max(50).optional(),
    }).refine((c) => !c.blobs || c.blobs.length === c.files.length, 'blobs must be parallel to files')).max(500),
  }) }),
  // v0.2 slice 3: what a change watches, as the files are now, sent at session start: the project's .claude/agents and .claude/skills and
  // its CLAUDE.md (scope 'project', project-relative paths), and the owner's ~/.claude/CLAUDE.md and rules (scope 'user', paths `~/.claude/...`).
  // A path and a git blob id (the file's hash), never the file.
  Base.extend({ kind: z.literal('project.fingerprint'), data: z.object({
    files: z.array(z.object({ path: id, hash: BLOB, scope: z.enum(['project', 'user']) })).max(1000),
  }) }),
  // v0.3 slice 2 (#42, Worth): the PRs merged in the past 90 days, from `gh` at session start: a number, when it merged, its size in lines, and (unless the
  // project is excluded) its title and branch. Never a body, an author or a diff. `merged_at` is epoch ms.
  // #103: `counted_lines` and `counted_files` are the lines and files left once lockfiles, images, build output and generated files are set aside (the mod's list, by path),
  // which the server sizes the PR from. Two numbers, never a path; an older plugin sends neither, and the PR stays "not sized".
  Base.extend({ kind: z.literal('project.prs'), data: z.object({
    prs: z.array(z.object({
      number: z.number().int().positive(),
      title: z.string().transform((s) => s.slice(0, 200)).optional(),
      merged_at: z.number().int().positive(),
      additions: count,
      deletions: count,
      head: id.transform((s) => s.slice(0, 200)).optional(),
      counted_lines: count.optional(),
      counted_files: count.optional(),
    })).max(500),
  }) }),
  // v0.3 slice 2: the session opened, or worked on, this PR: seen in a tool's output on the machine, or in Claude Code's own `pr-link` log line (the import).
  // Only the number travels; the project is the event's.
  Base.extend({ kind: z.literal('session.pr'), data: z.object({ number: z.number().int().positive() }) }),
  // Slice 5: every skill and custom agent the session lists, once per session; refs where the mod could read the text.
  Base.extend({ kind: z.literal('skills.catalog'), data: z.object({
    skills: z.array(z.object({ name: id, source: id, plugin: id.optional(), tokens: count, description: describe.optional(), refs: Refs.optional() })).max(1000),
    agents: z.array(z.object({ name: id, source: id, tokens: count, description: describe.optional(), refs: Refs.optional(), preload: z.array(id).max(100).optional() })).max(500),
  }) }),
  Base.extend({ kind: z.literal('task.create'), data: Task }),
  Base.extend({ kind: z.literal('task.complete'), data: Task }),
  Base.extend({ kind: z.literal('stall.start'), data: Stall }),
  Base.extend({ kind: z.literal('stall.end'), data: Stall }),
  // A tool held at the permission prompt: the agent waits for the user, so it is never stalled (§13).
  Base.extend({ kind: z.literal('tool.waiting'), data: z.object({ tool_use_id: id, tool: id }) }),
  // The outbox passed its cap (§13) and dropped this many of its oldest events since `since`.
  Base.extend({ kind: z.literal('outbox.dropped'), data: z.object({ count: z.number().int().positive(), since: z.number().int().positive() }) }),
]);
export type Event = z.infer<typeof Event>;
export type EventKind = Event['kind'];
export type Usage = z.infer<typeof Usage>;

export const EVENT_KINDS = Event.options.map((o) => o.shape.kind.value);

// §5: at most 500 events per batch (the 1 MB cap is the server's body limit).
export const IngestBatch = z.object({ events: z.array(Event).max(500) });
