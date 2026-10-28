import { createHash } from 'node:crypto';
import type { Event } from '@agent-orb/shared';
import { commandClass, errorClass, errorShape, filesTouched, type CommandClass, type ErrorClass } from '@agent-orb/shared/classes';

// The import's pure mapping (v0.2 slice 1, PROJECT.md §15 2026-10-24): Claude Code's own session logs → §5 events.
// Usage and metadata only. A line is reduced to numbers, names and ids the moment it is read; a text, a thinking block or a tool's
// input or output is measured and dropped, so nothing a file keeps and no event ever holds one. The transcript format is internal and unstable
// (§3.2 D): a line shape that is not the one below is skipped, never guessed at.
// v0.3 slice 1 (#43): the one exception is worked out and dropped on the spot: a Bash call's command becomes its class, a failed result's
// first 1,000 characters become its error class, and a Read, Edit or Write call keeps the path it names (a path is metadata, as the plugin
// sends it); no digest holds the command or the text.
// v0.3 slice 3 (#45): a failed result's text also becomes its error shape (a named pattern, or a hash of its first line), dropped the same way.
// v0.3 slice 2 (#42): Claude Code's `pr-link` lines (a session opened a PR) become session.pr, the number alone; the URL and the repository are
// compared with the project's remote on the spot and dropped.
// #86: a session is read as a stream, each event leaving as soon as the lines that make it are read, so the memory the import holds does not grow with the session.

// ── Ids ─────────────────────────────────────────────────────────────────────

// A fixed namespace: the same session, kind and key give the same event id on every run, so a second run is all duplicates.
const NAMESPACE = '5e1c2a1e-7c0b-4f0e-9a52-0c6b8f3d7a41';

/** RFC 9562 UUID v5: SHA-1 of the namespace bytes and the name, with the version and variant bits set. */
export function uuid5(namespace: string, name: string): string {
  const h = createHash('sha1').update(Buffer.from(namespace.replaceAll('-', ''), 'hex')).update(name).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** A session started in a worktree counts under the repository: `/.claude/worktrees/<name>` and anything after it is cut. */
export const projectPath = (cwd: string) => cwd.replace(/\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/, '');
/** The working tree a session ran in: the worktree's root when its cwd is in one, else the cwd itself (files_touched paths are relative to it, as the plugin's are). */
const checkoutOf = (cwd: string) => /^(.*\/\.claude\/worktrees\/[^/]+)(?:\/.*)?$/.exec(cwd)?.[1] ?? cwd;

// ── One session, read as a stream ───────────────────────────────────────────

type Usage = { input: number; output: number; cache_read: number; cache_creation: number };
type Msg = { ts: number; model: string; usage: Usage; stop: string | null; tools: string[]; turn: string };
type Result = { ts: number; success: boolean; outputSize: number; errorClass?: ErrorClass; errorShape?: string };
// A call is held from its line until its message has left the window (`out`) and its result has come: then both are written and it is dropped.
type Call = { ts: number; tool: string; inputSize: number; turn: string; command?: CommandClass; file?: string; result?: Result; out?: boolean };
type Turn = { start?: number; last: number; usage: Usage; extra: object };
export type Meta = { agentType?: string; description?: string; toolUseId?: string };

type PrLink = { ts: number; session: string; remote: string; number: number }; // remote: `host/owner/repo`, lowercase, as a project's git_remote reads

const zero = (): Usage => ({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });
const USAGE = Object.keys(zero()) as (keyof Usage)[];
// A message is written once per content block, so its lines come one after the other; a message leaves the window, and its step is written, when this many
// others have begun after it. In the big corpus (236,247 lines, 37,042 of them a message's repeat) every repeat is next to the one before.
// ponytail: a line of a message that left the window counts as a repeated line of a resumed copy (its id is in `seen`) and is dropped; widen the window if that is ever seen.
const WINDOW = 8;

/** What one file keeps of itself between its lines: a few numbers, the last WINDOW messages, the calls and results not yet paired, and ids. No event, no text. */
type File = {
  kind: 'main' | 'sub';
  fileAgentId: string; // a subagent file's own name: agent-<id>.jsonl
  meta: Meta;
  firstTs?: number;
  lastTs?: number;
  cwd?: string;
  version?: string;
  model?: string;
  agentId?: string;
  firstUserLength?: number; // a subagent's first user string is the task it was given
  turn: string; // the turn the next assistant line joins: the key of the prompt before it, '0' before any
  promptKeys: Set<string>;
  msgs: Map<string, Msg>; // by message.id, in the order first seen
  calls: Map<string, Call>;
  results: Map<string, Result>; // results whose call has not been read (yet)
  skills: Set<string>; // `${turn}|${skill}`
  prs: Map<string, PrLink>; // by session, repository and number: the first line's time
  turns: Map<string, Turn>;
  duplicates: number; // lines of a message or prompt another file of the run already counted
  lines: number;
};

const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.trunc(x) : 0);
const str = (x: unknown): x is string => typeof x === 'string' && x !== '';
// The length of a tool result's text: a string, or the text blocks of a list (an image block has none).
const textLength = (c: unknown): number =>
  typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n: number, b) => n + (b?.type === 'text' && typeof b.text === 'string' ? b.text.length : 0), 0) : 0;
// The start of that text, as much as errorClass reads (1,000 characters).
const textHead = (c: unknown, n = 1000): string => {
  if (typeof c === 'string') return c.slice(0, n);
  let out = '';
  for (const b of Array.isArray(c) ? c : []) if (out.length < n && b?.type === 'text' && typeof b.text === 'string') out += b.text;
  return out.slice(0, n);
};

/**
 * A `pr-link` line: `{ sessionId, prNumber, prRepository: 'owner/repo', prUrl, timestamp }`, written when the session opens a PR and again as it goes on.
 * Kept by the session it names, the repository and the number, at its earliest time. The host is the URL's (a line with none usable is GitHub's), so
 * `remote` reads like a project's git_remote. It is no activity: it never stretches a session's first or last time.
 */
function digestPrLink(d: File, o: any) {
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (!Number.isInteger(o.prNumber) || o.prNumber < 1 || !str(o.prRepository) || !str(o.sessionId) || !Number.isFinite(ts)) return;
  let host = 'github.com';
  try {
    host = new URL(o.prUrl).host || host;
  } catch {
    // no URL, or not one: GitHub's
  }
  const remote = `${host}/${o.prRepository}`.toLowerCase();
  const key = `${o.sessionId}|${remote}#${o.prNumber}`;
  const known = d.prs.get(key);
  if (!known || ts < known.ts) d.prs.set(key, { ts, session: o.sessionId, remote, number: o.prNumber });
}

// ── A session's lines → its events ──────────────────────────────────────────

export type Where = { host: string; project: { cwd: string; name: string; git_remote?: string } };

/** The ids a run has counted: a Set will do, and the import keeps them in a table. */
export type Seen = { has(id: string): boolean; add(id: string): unknown };

/**
 * One session's §5 events, read as a stream (#86): its main file and its subagents' files go through `read`, one after the other, and each event goes to `sink`
 * as soon as the lines that make it have been read, so what the session holds in memory is the same whatever its size. `end` writes what only the whole session
 * knows and says what was read. The caller batches, `writeEvents` sorts each batch by ts.
 *
 * What is kept between lines: the last WINDOW messages (a message is one event, from its last line), the calls whose result has not come, the results whose
 * call has not, one record per turn, and ids (`seen`, the prompts and skills of a file). A call or a result that never finds its pair stays until its file ends, and a
 * turn or a prompt id costs a few hundred bytes for as long as the file: what grows with a session is its prompts and its unanswered calls (a thousand prompts, 300 KB), never
 * its messages. A subagent's header (agent.spawn, its turn, agent.complete) and the
 * session.start, whose time is the first of ALL the lines (one file in the big corpus starts at a line that is not its first), are written when their
 * files end, so they come after the events they head; the writer does not care for these events (they are upserts, and it sorts a batch itself).
 * The project is the first cwd of the main file, else of the first subagent's: events before it is known wait in `held` (none, with Claude Code's logs: every
 * line has its cwd); `project` is asked for it then. A session that never names one writes nothing.
 * ponytail: a file whose first lines have no cwd or no agentId gets the project path, or its file's name, until one comes (the old reader waited for the last).
 */
export function openSession(sessionId: string, host: string, project: (cwd: string) => Where['project'], sink: (e: Event) => void, seen: Seen) {
  let at: Where['project'] | undefined;
  let held: object[] = [];
  let emitted = 0;
  let duplicates = 0;
  let main: File | undefined;
  const start: { ts: number; model?: string; version?: string } = { ts: Infinity };

  const emit = (kind: string, key: string, ts: number, data: object, extra: object = {}) => {
    const e = { v: 1, id: uuid5(NAMESPACE, `${sessionId}|${kind}|${key}`), ts, host, user_id: 'local', session_id: sessionId, ...extra, kind, data };
    emitted++;
    if (at) sink({ ...e, project: { ...at } } as Event);
    else held.push(e);
  };
  const named = (cwd: string) => {
    at = project(cwd);
    for (const e of held.splice(0)) sink({ ...e, project: { ...at } } as Event);
  };

  const agentOf = (d: File) => (d.kind === 'sub' ? (d.agentId ?? d.fileAgentId) : undefined);
  const turnId = (d: File, key: string) => (d.kind === 'sub' ? `${sessionId}:${agentOf(d)}` : `${sessionId}:p:${key}`);
  const who = (d: File, key: string) => ({ ...(d.kind === 'sub' ? { agent_id: agentOf(d) } : {}), turn_id: turnId(d, key) });
  // A turn runs from its start to its last step, call, result or skill load; its usage is the sum of its steps.
  const turnOf = (d: File, key: string) => {
    const id = turnId(d, key);
    let t = d.turns.get(id);
    if (!t) d.turns.set(id, (t = { last: -Infinity, usage: zero(), extra: d.kind === 'sub' ? { agent_id: agentOf(d) } : key === '0' ? {} : { prompt_id: key } }));
    return t;
  };
  const touch = (d: File, key: string, ts: number) => {
    const t = turnOf(d, key);
    t.last = Math.max(t.last, ts);
  };
  const begin = (d: File, key: string, ts: number) => {
    const t = turnOf(d, key);
    t.start = ts;
    t.last = Math.max(t.last, ts);
    emit('turn.start', turnId(d, key), ts, {}, { turn_id: turnId(d, key), ...t.extra });
  };
  // Every turn ends with a turn.complete (its last event minus its start), or the Pipeline's session lanes draw an unset turn up to now.
  const complete = (id: string, t: Turn) =>
    emit('turn.complete', id, t.last, { duration_ms: t.last - t.start!, usage_total: { ...t.usage }, reason: 'answer', answer_length: 0 }, { turn_id: id, ...t.extra });

  // The session's own working tree, as the plugin's `checkout`: a worktree's root, else the project path. A subagent isolated in a worktree has its own.
  const treeOf = (d: File) => checkoutOf(d.cwd ?? main?.cwd ?? at?.cwd ?? '');
  // v0.3 slice 1: an event that gained a class or a path is a new event (`|v2` in its key), so a history imported before takes them on its next
  // run; the store upserts by tool_use_id, so nothing doubles. Any other keeps its key, and a second run accepts nothing.
  // v0.3 slice 3 (#45): a failed result that has a shape is keyed on it (`|s:<shape>`), so a history imported with the classes alone takes the shapes on
  // its next run, and a shape that changes (a pattern added to the table since) is a new event whose upsert takes over the old one.
  const V2 = '|v2';

  const result = (d: File, id: string, c: Call, r: Result) => {
    const files = r.success && c.file ? filesTouched(c.tool, { file_path: c.file }, treeOf(d)) : [];
    emit('tool.result', r.errorShape ? `${id}|s:${r.errorShape}` : r.errorClass || files.length ? id + V2 : id, r.ts, {
      tool_use_id: id, success: r.success, duration_ms: Math.max(0, r.ts - c.ts), output_size: r.outputSize, files_touched: files,
      ...(r.errorClass ? { error_class: r.errorClass } : {}),
      ...(r.errorShape ? { error_shape: r.errorShape } : {}),
    }, who(d, c.turn));
    touch(d, c.turn, r.ts);
  };

  // A message leaves the window: its step, then its calls, each with its result if that has come. A call whose result has not stays, written, until it does.
  const step = (d: File, id: string, m: Msg) => {
    if (d.kind === 'main' && m.turn === '0' && turnOf(d, '0').start === undefined) begin(d, '0', m.ts); // assistant lines before any prompt: turn p:0, from the first of them
    emit('turn.step', id, m.ts, { model: m.model, usage: m.usage, stop_reason: m.stop, tool_use_ids: m.tools }, who(d, m.turn));
    const t = turnOf(d, m.turn);
    t.last = Math.max(t.last, m.ts);
    for (const k of USAGE) t.usage[k] += m.usage[k];
    for (const callId of m.tools) {
      const c = d.calls.get(callId)!;
      emit('tool.call', c.command ? callId + V2 : callId, c.ts, { tool_use_id: callId, tool: c.tool, input_size: c.inputSize, ...(c.command ? { command_class: c.command } : {}) }, who(d, c.turn));
      touch(d, c.turn, c.ts);
      c.out = true;
      if (c.result) {
        result(d, callId, c, c.result);
        d.calls.delete(callId);
      }
    }
  };
  const settle = (d: File, all = false) => {
    while (d.msgs.size > (all ? 0 : WINDOW)) {
      const [id, m] = d.msgs.entries().next().value!;
      d.msgs.delete(id);
      step(d, id, m);
    }
  };

  function line(d: File, text: string) {
    d.lines++;
    let o: any;
    try {
      o = JSON.parse(text);
    } catch {
      return;
    }
    if (o?.type === 'pr-link') return digestPrLink(d, o);
    if (!o || (o.type !== 'assistant' && o.type !== 'user') || !o.message || typeof o.message !== 'object') return;
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) return;
    const m = o.message;
    const touched = () => {
      d.firstTs = Math.min(d.firstTs ?? ts, ts);
      d.lastTs = Math.max(d.lastTs ?? ts, ts);
      if (!d.cwd && str(o.cwd)) {
        d.cwd = o.cwd;
        if (!at) named(o.cwd);
      }
      d.version ??= str(o.version) ? o.version : undefined;
      d.agentId ??= str(o.agentId) ? o.agentId : undefined;
    };

    if (o.type === 'assistant') {
      // <synthetic> lines are Claude Code's own notices (an API error, an interrupt), not requests.
      if (!str(m.id) || !str(m.model) || m.model === '<synthetic>' || !m.usage || typeof m.usage !== 'object') return;
      const known = d.msgs.get(m.id);
      if (!known && seen.has(`m:${m.id}`)) return void d.duplicates++;
      seen.add(`m:${m.id}`);
      touched();
      d.model ??= m.model;
      const u = m.usage;
      // A message is written once per content block, each line repeating the usage: the last line's is the message's.
      const msg: Msg = {
        ts, model: m.model, stop: str(m.stop_reason) ? m.stop_reason : (known?.stop ?? null), tools: known?.tools ?? [], turn: known?.turn ?? d.turn,
        usage: { input: count(u.input_tokens), output: count(u.output_tokens), cache_read: count(u.cache_read_input_tokens), cache_creation: count(u.cache_creation_input_tokens) },
      };
      d.msgs.set(m.id, msg);
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type !== 'tool_use' || !str(b.id) || d.calls.has(b.id)) continue;
        const tool = str(b.name) ? b.name : 'unknown';
        const input = b.input && typeof b.input === 'object' ? b.input : {};
        const file = input.file_path ?? input.notebook_path;
        const call: Call = {
          ts, tool, inputSize: JSON.stringify(b.input ?? {}).length, turn: msg.turn,
          ...(tool === 'Bash' && typeof input.command === 'string' ? { command: commandClass(input.command) } : {}),
          ...(str(file) ? { file } : {}),
        };
        const early = d.results.get(b.id);
        if (early) {
          call.result = early;
          d.results.delete(b.id);
        }
        d.calls.set(b.id, call);
        msg.tools.push(b.id);
      }
      if (str(o.attributionSkill) && !d.skills.has(`${msg.turn}|${o.attributionSkill}`)) {
        d.skills.add(`${msg.turn}|${o.attributionSkill}`);
        emit('skill.load', `${turnId(d, msg.turn)}|${o.attributionSkill}`, ts, { skill: o.attributionSkill }, who(d, msg.turn));
        touch(d, msg.turn, ts);
      }
      settle(d);
      return;
    }

    const c = m.content;
    if (typeof c === 'string') {
      d.firstUserLength ??= c.length;
      // A typed prompt: a string that is not a notice from Claude Code (meta, a compact summary, a local command), in the main file.
      const typed = d.kind === 'main' && !o.isSidechain && !o.isMeta && !o.isCompactSummary && !c.startsWith('<local-command');
      if (typed && str(o.uuid)) {
        if (seen.has(`p:${o.uuid}`)) return void d.duplicates++;
        seen.add(`p:${o.uuid}`);
      }
      touched();
      if (!typed) return;
      const key: string = str(o.promptId) ? o.promptId : str(o.uuid) ? o.uuid : `line-${d.lines}`;
      d.turn = key; // two typed lines under one promptId are one turn
      if (!d.promptKeys.has(key)) {
        d.promptKeys.add(key);
        emit('prompt.submit', key, ts, { length: c.length }, { prompt_id: key });
        begin(d, key, ts);
      }
      return;
    }
    touched();
    for (const b of Array.isArray(c) ? c : []) {
      if (b?.type !== 'tool_result' || !str(b.tool_use_id)) continue;
      const id: string = b.tool_use_id;
      const call = d.calls.get(id);
      if (call?.result || d.results.has(id)) continue; // a call's first result is its result
      const success = !b.is_error;
      const head = success ? '' : textHead(b.content);
      const shape = success ? undefined : errorShape(call?.tool ?? '', head, call?.command);
      const r: Result = {
        ts, success, outputSize: textLength(b.content),
        ...(success ? {} : { errorClass: errorClass(call?.tool ?? '', head) }),
        ...(shape ? { errorShape: shape } : {}),
      };
      if (!call) d.results.set(id, r); // an orphan is never written, unless its call comes later
      else if (call.out) {
        result(d, id, call, r);
        d.calls.delete(id);
      } else call.result = r;
    }
  }

  // A file is done: its last messages, its turns, and what only the whole file knows.
  const finish = (d: File) => {
    settle(d, true);
    duplicates += d.duplicates;
    if (d.kind === 'main') for (const [id, t] of d.turns) complete(id, t);
    if (d.firstTs === undefined) return;
    if (d.kind === 'sub') {
      // ponytail: a subagent's parent is always main (the logs name no parent here), as the plugin files a spawn with no parent_agent_id.
      const agentId = agentOf(d)!;
      emit('agent.spawn', agentId, d.firstTs, {
        tool_use_id: d.meta.toolUseId || `import:${agentId}`, agent_type: d.meta.agentType || 'unknown',
        ...(d.meta.description ? { description: d.meta.description.slice(0, 200) } : {}), model: d.model ?? 'unknown', prompt_length: d.firstUserLength ?? 0,
      }, { agent_id: agentId });
      begin(d, '0', d.firstTs);
      const t = turnOf(d, '0');
      complete(turnId(d, '0'), t);
      emit('agent.complete', agentId, d.lastTs!, { duration_ms: d.lastTs! - d.firstTs, usage_total: { ...t.usage }, report_length: 0 }, { agent_id: agentId });
    }
    start.ts = Math.min(start.ts, d.firstTs);
    start.model ??= d.model;
    start.version ??= d.version;
  };

  return {
    /** A file's lines, in order: the main file first, then each subagent's (`meta` from its .meta.json, `fileAgentId` from its name). `seen` is the run's: a message or a prompt already counted (a resumed session's file copies the history it resumed) is not counted again. */
    async read(kind: 'main' | 'sub', lines: AsyncIterable<string> | Iterable<string>, meta: Meta = {}, fileAgentId = '') {
      const d: File = {
        kind, fileAgentId, meta, turn: '0', promptKeys: new Set(), msgs: new Map(), calls: new Map(), results: new Map(), skills: new Set(), prs: new Map(), turns: new Map(), duplicates: 0, lines: 0,
      };
      if (kind === 'main') main = d;
      for await (const text of lines) line(d, text);
      finish(d);
    },
    /** The session is read: its start, the PRs it opened, and what was read. `events` is 0 for a session with no line to import or no cwd. */
    end() {
      const remote = at?.git_remote?.toLowerCase();
      for (const p of main?.prs.values() ?? []) if (remote && p.session === sessionId && p.remote === remote) emit('session.pr', String(p.number), p.ts, { number: p.number });
      if (start.ts !== Infinity) {
        emit('session.start', 'start', start.ts, { model: start.model ?? 'unknown', source: 'import', claude_version: start.version ?? 'unknown', plugin_version: 'import', content: 'off' });
      }
      held = [];
      return { events: at ? emitted : 0, project: at, duplicates };
    },
  };
}
