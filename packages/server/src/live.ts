import { roles, type Event, type ModelFamily } from '@agent-orb/shared';
import type { ClaimLive, Kind, Why } from './claims.ts';
import { costUsd } from './cost.ts';
import { get, type Store } from './store/store.ts';

// The state behind /stream and the Live view (§8.1), derived from events alone and held in memory.
// ponytail: a server restart starts it empty; agents reappear with their next event. Rebuild from the history store if that matters.
// A session's start is the one exception: it is read from the store when the session first appears here (#101), so a restart does not move it.

const SHOW_ENDED_MS = 10 * 60_000;
const FORGET_ENDED_MS = 60 * 60_000;

/** An unbacked claim in an agent's last answer (v0.3 slice 4, #44): the words it used, and the facts of why the check holds it against the agent's own calls. */
export type LiveClaim = { kind: Kind; phrase: string; why: Why; ts: number; file?: string; editTs?: number; runTs?: number };

export type LiveAgent = {
  id: string; // 'main' or the engine's agent id
  parent?: string;
  type: string;
  role?: string;
  description?: string;
  model?: string;
  /** v0.2 slice 2: the plugin flagged it, on a pricier model than its file says (`file`) or than the owner's ceiling (`ceiling`): what it is held to. Stays after it is done. */
  pricier?: { allowed: ModelFamily; source: 'file' | 'ceiling' };
  tokens: number;
  cost: number;
  tool?: { name: string; id: string; since: number; waiting: boolean };
  /** What it is doing, when content is on: what it was asked, a tool's main argument, or its answer (§15). */
  now?: { label: string; text: string };
  /** Slice 6, for the cards: the skills this turn loaded, in order, what the person last asked main (content on), its tasks, its calls. */
  skills: string[];
  asked?: string;
  tasks: { id: string; subject: string; status: string }[];
  /** Its last answer's unbacked claims, until its next turn starts (claims.ts). Absent: none, or the answer was not checked. */
  unbacked?: LiveClaim[];
  calls: number;
  failed: number;
  startedAt: number;
  lastTs: number;
  inTurn: boolean;
  stalled: boolean;
  errored: boolean;
  done: boolean;
};

type Session = {
  id: string; project: string; branch?: string; host: string; startedAt: number; lastTs: number; endedAt?: number;
  tokens: number; cost: number; costPartial: boolean; contextPercent?: number; content?: 'off' | 'full' | 'excluded';
  agents: Map<string, LiveAgent>; seen: Set<string>;
  skills: Map<string, { count: number; by: Map<string, number> }>; // which skills ran, how often, and who ran them
};

export type LiveState = { sessions: Map<string, Session>; store?: Store };
export const newLive = (store?: Store): LiveState => ({ sessions: new Map(), store });

const roleOf = (type: string) => (roles as Record<string, string>)[type];

const LINE = 160;
const line = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > LINE ? `${one.slice(0, LINE)}…` : one;
};
// The argument that says most about a call, by the names the built-in tools use.
const MAIN_ARG = ['command', 'file_path', 'notebook_path', 'url', 'pattern', 'query', 'prompt', 'description', 'skill', 'subject'];
function mainArg(input: string) {
  try {
    const o = JSON.parse(input) as Record<string, unknown>;
    const key = MAIN_ARG.find((k) => typeof o[k] === 'string' && o[k]);
    return key ? String(o[key]) : input;
  } catch {
    return input;
  }
}

function agentOf(s: Session, id: string, ts: number): LiveAgent {
  let a = s.agents.get(id);
  if (!a) {
    // A subagent can show up before its spawn event (docs/verified.md): it sits under main until the spawn says otherwise.
    a = { id, parent: id === 'main' ? undefined : 'main', type: id === 'main' ? 'main' : 'agent', role: id === 'main' ? roleOf('main') : undefined,
      tokens: 0, cost: 0, skills: [], tasks: [], calls: 0, failed: 0, startedAt: ts, lastTs: ts, inTurn: false, stalled: false, errored: false, done: false };
    s.agents.set(id, a);
  }
  return a;
}

// What shows an agent is alive. A stall ends with the agent's next one, since a stall raised by one process is never ended by the next process of the same session (#109).
const ALIVE = new Set(['session.start', 'prompt.submit', 'session.end', 'turn.start', 'turn.step', 'turn.complete', 'tool.call', 'tool.waiting', 'tool.result', 'agent.complete']);

function apply(s: Session, e: Event) {
  const a = agentOf(s, e.agent_id ?? 'main', e.ts);
  a.lastTs = Math.max(a.lastTs, e.ts);
  s.lastTs = Math.max(s.lastTs, e.ts);
  if (ALIVE.has(e.kind)) a.stalled = false;
  switch (e.kind) {
    case 'session.start':
      a.model ??= e.data.model;
      if (e.data.content) s.content = e.data.content;
      break;
    case 'prompt.submit':
      if (e.data.text) {
        a.now = { label: 'asked', text: line(e.data.text) };
        a.asked = a.now.text;
        s.content ??= 'full'; // text only comes with content on, so a restart that missed session.start still knows
      }
      break;
    case 'session.end':
      s.endedAt = e.ts;
      break;
    case 'turn.start':
      Object.assign(a, { inTurn: true, done: false, errored: false, skills: [], unbacked: undefined }); // a skill counts for its own turn (Slice 5); a claim for its own answer
      break;
    case 'skill.load': {
      if (!a.skills.includes(e.data.skill)) a.skills = [...a.skills, e.data.skill]; // alpha › beta: the chain this turn
      const k = s.skills.get(e.data.skill) ?? { count: 0, by: new Map<string, number>() };
      const who = e.data.how === 'typed' ? 'you' : a.type;
      k.count++;
      k.by.set(who, (k.by.get(who) ?? 0) + 1);
      s.skills.set(e.data.skill, k);
      break;
    }
    case 'task.create':
    case 'task.complete': {
      const i = a.tasks.findIndex((x) => x.id === e.data.task_id);
      const task = { id: e.data.task_id, subject: e.data.subject, status: e.data.status };
      if (e.data.status === 'deleted') { if (i >= 0) a.tasks.splice(i, 1); }
      else if (i >= 0) a.tasks[i] = task;
      else a.tasks.push(task);
      break;
    }
    case 'turn.step': {
      const tokens = e.data.usage.input + e.data.usage.output + e.data.usage.cache_read + e.data.usage.cache_creation;
      const cost = costUsd(e.data.model, e.data.usage);
      a.model = e.data.model;
      if (e.data.answer) (a.now = { label: 'answered', text: line(e.data.answer) }), (s.content ??= 'full');
      a.tokens += tokens;
      s.tokens += tokens;
      if (cost === null) s.costPartial = true;
      else (a.cost += cost), (s.cost += cost);
      break;
    }
    case 'turn.complete':
      a.inTurn = false;
      a.errored = e.data.reason === 'error';
      if (e.data.context_percent !== undefined && !e.agent_id) s.contextPercent = e.data.context_percent;
      break;
    case 'agent.spawn':
      Object.assign(a, {
        parent: e.parent_agent_id ?? 'main', type: e.data.agent_type, description: e.data.description, model: e.data.model, pricier: e.data.model_check,
        role: e.data.declared_role ?? roleOf(e.data.agent_type), startedAt: Math.min(a.startedAt, e.ts),
      });
      if (e.data.prompt) a.now ??= { label: 'task', text: line(e.data.prompt) };
      break;
    case 'agent.complete':
      Object.assign(a, { done: true, inTurn: false, tool: undefined });
      break;
    case 'tool.call':
      a.tool = { name: e.data.tool, id: e.data.tool_use_id, since: e.ts, waiting: false };
      a.calls++;
      if (e.data.input) (a.now = { label: e.data.tool, text: line(mainArg(e.data.input)) }), (s.content ??= 'full');
      break;
    case 'tool.waiting':
      if (a.tool?.id === e.data.tool_use_id) a.tool.waiting = true;
      break;
    case 'tool.result':
      if (a.tool?.id === e.data.tool_use_id) a.tool = undefined;
      if (!e.data.success) a.failed++;
      break;
    case 'stall.start':
    case 'stall.end':
      a.stalled = e.kind === 'stall.start';
      break;
  }
}

/** Applies events (each id once) and returns the ids of the sessions they changed. */
export function applyEvents(state: LiveState, events: Event[]): string[] {
  const changed = new Set<string>();
  for (const e of [...events].sort((x, y) => x.ts - y.ts)) {
    let s = state.sessions.get(e.session_id);
    if (!s) {
      // The session's own start (its session.start, as the store holds it) when there is one; the event's time when the store has none yet.
      const stored = state.store && get(state.store, 'SELECT started_at FROM sessions WHERE id = :id', { id: e.session_id })?.started_at;
      s = { id: e.session_id, project: e.project.name, branch: e.project.git_branch, host: e.host, startedAt: stored ?? e.ts, lastTs: e.ts,
        tokens: 0, cost: 0, costPartial: false, agents: new Map(), seen: new Set(), skills: new Map() };
      state.sessions.set(e.session_id, s);
    }
    if (s.seen.has(e.id)) continue;
    s.seen.add(e.id);
    s.startedAt = Math.min(s.startedAt, e.ts);
    apply(s, e);
    changed.add(s.id);
  }
  return [...changed];
}

/**
 * The unbacked claims a batch's answers were found to make (claims.ts), onto the agents that made them; returns the sessions they changed. An answer's claims replace the
 * agent's last ones, backed or not, so a rechecked answer that is now backed clears the mark.
 */
export function applyClaims(state: LiveState, claims: ClaimLive[]): string[] {
  const changed = new Set<string>();
  const turn = new Map<string, string>();
  for (const c of claims) {
    const a = state.sessions.get(c.session_id)?.agents.get(c.agent_id.slice(c.session_id.length + 1));
    if (!a) continue;
    if (turn.get(c.agent_id) !== c.turn_id) (a.unbacked = undefined), turn.set(c.agent_id, c.turn_id);
    if (!c.backed) {
      (a.unbacked ??= []).push({ kind: c.kind, phrase: c.phrase, why: c.why!, ts: c.ts, ...(c.file && { file: c.file }), ...(c.edit_ts && { editTs: c.edit_ts }), ...(c.run_ts && { runTs: c.run_ts }) });
    }
    changed.add(c.session_id);
  }
  return [...changed];
}

export type AgentState = 'working' | 'waiting' | 'stalled' | 'done' | 'error';
const stateOf = (a: LiveAgent): { state: AgentState; waitingFor?: 'permission' | 'prompt' } =>
  a.done ? { state: 'done' }
  : a.stalled ? { state: 'stalled' }
  : a.errored ? { state: 'error' }
  : a.tool?.waiting ? { state: 'waiting', waitingFor: 'permission' }
  : !a.inTurn && !a.tool ? { state: 'waiting', waitingFor: a.id === 'main' ? 'prompt' : undefined }
  : { state: 'working' };

/** One session as the studio draws it: agents in tree order (each parent before its children). */
export function view(s: Session) {
  const kids = new Map<string | undefined, LiveAgent[]>();
  for (const a of s.agents.values()) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);
  const ordered: (LiveAgent & { depth: number; state: AgentState; waitingFor?: string })[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const a of (kids.get(parent) ?? []).sort((x, y) => x.startedAt - y.startedAt)) {
      ordered.push({ ...a, depth, ...(s.endedAt ? { state: 'done' as const } : stateOf(a)) });
      if (depth < 20) walk(a.id, depth + 1);
    }
  };
  walk(undefined, 0);
  const { agents: _a, seen: _s, skills, ...rest } = s; // the session's skill counts, not an agent's
  const byCount = <T extends { count: number }>(list: T[]) => list.sort((x, y) => y.count - x.count);
  return {
    ...rest, agents: ordered,
    skills: byCount([...skills].map(([skill, k]) => ({ skill, count: k.count, by: byCount([...k.by].map(([who, count]) => ({ who, count }))) }))),
  };
}

/** Running sessions and those ended in the last 10 minutes, newest first; long-ended ones are forgotten. */
export function visible(state: LiveState, now: number) {
  for (const s of state.sessions.values()) if (s.endedAt && now - s.endedAt > FORGET_ENDED_MS) state.sessions.delete(s.id);
  return [...state.sessions.values()]
    .filter((s) => !s.endedAt || now - s.endedAt <= SHOW_ENDED_MS)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(view);
}
