// The Live board (design/pages.html, the approved rows; PROJECT.md §15): what each agent row says, how far its tasks
// are, what needs the person, and how the rows nest. Pure, for tests.
import { plural } from './format.ts';

type Tool = { name: string; id: string; since: number; waiting: boolean };
// v0.2 slice 2: the plugin flagged it as on a pricier model than it should be, and says what it is held to (the server's `pricier`).
type Family = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'mythos';
/** v0.3 slice 4 (#44): a claim in the agent's last answer that its own calls do not back (the server's `unbacked`), with the facts of why. */
export type ClaimView = { kind: 'test' | 'build' | 'edit'; phrase: string; why: 'no_run' | 'stale' | 'failed' | 'no_write'; ts: number; file?: string; editTs?: number; runTs?: number };
export type CardAgent = {
  id: string; type: string; depth: number; state: 'working' | 'waiting' | 'stalled' | 'done' | 'error'; waitingFor?: 'permission' | 'prompt';
  tool?: Tool; now?: { label: string; text: string }; startedAt: number; lastTs: number;
  tasks: { id: string; subject: string; status: string }[];
  model?: string; pricier?: { allowed: Family; source: 'file' | 'ceiling' };
  unbacked?: ClaimView[];
};
export type Sentence = { verb: string; arg?: string; since?: number; extra?: string; tone?: 'wait' | 'bad' };

export const DELEGATES = new Set(['Agent', 'Task', 'Workflow']);
/** How Live names an agent: a workflow agent has no file of its own and a type only the plugin reads, so it is "workflow agent", as Needs you says it. The Pipeline and the Ledger keep the type. */
export const agentName = (type: string) => (type === 'workflow-subagent' ? 'workflow agent' : type);
// ── Unbacked claims (v0.3 slice 4, #44) ──

const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
/**
 * Why a claim is unbacked, in the words of the mock: `no test ran after its last code edit, at 14:02` for the Live row and Needs you; `long` (the history drawer) names the run
 * it did see: `the last test run (13:58) came before the code edit at 14:02`.
 */
export function claimReason(c: ClaimView, long = false): string {
  const run = c.kind === 'build' ? 'build' : 'test';
  const edit = c.editTs === undefined ? '' : `, at ${clock(c.editTs)}`;
  if (c.why === 'no_write') return `it never wrote ${c.file ?? 'the file'}`;
  if (c.why === 'failed') return `its last ${run} run${c.runTs === undefined ? '' : ` (${clock(c.runTs)})`} failed${c.editTs === undefined ? '' : `, after its last code edit at ${clock(c.editTs)}`}`;
  if (long && c.why === 'stale' && c.runTs !== undefined) return `the last ${run} run (${clock(c.runTs)}) came before the code edit at ${clock(c.editTs ?? c.runTs)}`;
  return `no ${run} ran after its last code edit${edit}`;
}
/** The row says "Said “…”" for the first claim and how many more there are. */
const claimLine = (a: CardAgent): Sentence => {
  const [first, ...more] = a.unbacked!;
  return { verb: `Said “${first!.phrase}”`, extra: `${claimReason(first!)}${more.length ? ` · ${more.length} more unbacked` : ''}`, tone: 'bad' };
};
// A done agent leaves the board this long after its last event. One whose last answer holds an unbacked claim stays, as a stall or a wait does: it is in Needs you (v0.3 slice 4, #44).
const HIDE_DONE_MS = 10 * 60_000;
export const shown = (a: CardAgent, now: number) => a.state !== 'done' || !!a.unbacked?.length || now - a.lastTs < HIDE_DONE_MS;

/** The claim takes the place of "done" and of "waiting for your prompt": it is what the agent last said, and it does not hold. */
const claimed = (a: CardAgent) => !!a.unbacked?.length && (a.state === 'done' || (a.state === 'waiting' && a.waitingFor === 'prompt'));

export const short = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};
// The now line belongs to the running tool only when it names it; otherwise it is an older call's. A tool with no
// argument the server knows sends its whole input: cut it, so a card stays a card.
const ARG_MAX = 90;
const cut = (s: string) => (s.length > ARG_MAX ? `${s.slice(0, ARG_MAX - 1)}…` : s);
const argOf = (a: CardAgent) => (a.tool && a.now?.label === a.tool.name ? { arg: cut(a.now.text) } : {});

/** One sentence for what the agent is doing now: the state first, then the tool. */
export function sentence(a: CardAgent, children: CardAgent[], _now: number): Sentence {
  const since = a.tool ? { since: a.tool.since } : {};
  if (claimed(a)) return claimLine(a);
  if (a.state === 'done') return { verb: `Done in ${short(a.lastTs - a.startedAt)}`, ...(a.now?.label === 'answered' && { extra: `“${a.now.text}”` }) };
  if (a.state === 'error') return { verb: 'Stopped with an error', tone: 'bad' };
  if (a.state === 'stalled') return { verb: a.tool ? `${a.tool.name}, no answer` : 'No progress', ...argOf(a), ...since, tone: 'bad' };
  if (a.state === 'waiting') {
    if (a.waitingFor === 'permission' && a.tool) return { verb: `Needs your OK to run ${a.tool.name}`, ...argOf(a), ...since, tone: 'wait' };
    if (a.waitingFor === 'prompt') return { verb: 'Waiting for your next prompt', ...(a.now?.label === 'answered' && { extra: `Answered: “${a.now.text}”` }) };
    return { verb: 'Between steps' };
  }
  if (a.tool && DELEGATES.has(a.tool.name)) {
    const busy = children.filter((k) => k.state !== 'done');
    return busy.length
      ? { verb: `Waiting on the ${busy.length} agent${busy.length === 1 ? '' : 's'} it dispatched`, extra: busy.map((k) => agentName(k.type)).join(', '), ...since }
      : { verb: 'Dispatching an agent', ...since };
  }
  if (a.tool) return { verb: `Running ${a.tool.name}`, ...argOf(a), ...since };
  return { verb: 'Thinking…' };
}

/** Completed tasks against all of them, and what is left; nothing when the agent keeps no task list. */
export function progress(tasks: CardAgent['tasks']) {
  if (!tasks.length) return undefined;
  const left = tasks.filter((t) => t.status !== 'completed').map((t) => t.subject);
  return { done: tasks.length - left.length, total: tasks.length, left };
}

// ── The model check (v0.2 slice 2) ──

/** `claude-opus-5-5[1m]` → `Opus`: the family, as the owner says it; nothing for a model the studio does not know. */
export const familyName = (model?: string) => {
  const f = /(?<![a-z])(haiku|sonnet|opus|fable|mythos)(?![a-z])/.exec(model?.toLowerCase() ?? '')?.[1];
  return f && `${f[0]!.toUpperCase()}${f.slice(1)}`;
};
/** On a pricier model and still at it: a done agent no longer counts. */
export const isPricier = (a: CardAgent) => !!a.pricier && a.state !== 'done';
/** The row's state: a pricier model takes the place of "working" only, so a stall, a wait, an error and done all read as themselves; an unbacked claim takes the place of done and of the wait for a prompt. */
export const rowState = (a: CardAgent) => (claimed(a) ? 'claim' : a.state === 'working' && a.pricier ? 'model' : a.state);
/** The header tally: every agent once, by the state its row shows (`rowState`). An error has a row but no slot in the tally. */
export const rowCounts = (agents: CardAgent[]) => {
  const n = { working: 0, model: 0, waiting: 0, stalled: 0, done: 0, claim: 0 };
  for (const a of agents) {
    const s = rowState(a);
    if (s in n) n[s as keyof typeof n]++;
  }
  return n;
};
/** Whose limit it broke, for the row's sub line. */
export const pricierSub = (a: CardAgent) =>
  isPricier(a) ? (a.pricier!.source === 'file' ? `its file says ${familyName(a.pricier!.allowed)}` : `no file, ceiling ${familyName(a.pricier!.allowed)}`) : undefined;

export type Need = {
  session: string; agent: string; type: string; tone: 'wait' | 'bad' | 'model' | 'claim'; tool?: string; arg?: string; since?: number;
  /** An unbacked claim: what the agent said and why its calls do not back it. */
  claim?: { phrase: string; reason: string };
  /** A pricier model: the sentence in parts, `A <b>workflow agent</b> in <b>mobile-app</b> runs on Opus; …`: `generic` says to lead with "A". */
  pricier?: { subject: string; generic: boolean; tail: string };
};

const pricierNeed = (a: CardAgent): NonNullable<Need['pricier']> => {
  const generic = a.type === 'workflow-subagent';
  const rule = a.pricier!.source === 'file' ? 'its agent file says' : 'agents with no file are held to';
  return { subject: agentName(a.type), generic, tail: `runs on ${familyName(a.model) ?? 'a pricier model'}; ${rule} ${familyName(a.pricier!.allowed)}` };
};

/**
 * What needs the person, across sessions: agents waiting for permission and stalled ones, the longest-waiting first, then agents whose last answer holds an unbacked claim
 * (v0.3 slice 4), the oldest first, then every agent still on a pricier model (once, unless it is already listed above), the longest-running first.
 */
export function needs(sessions: { id: string; agents: CardAgent[] }[]): Need[] {
  const blocked = (a: CardAgent) => a.state === 'stalled' || (a.state === 'waiting' && a.waitingFor === 'permission');
  const by = (key: (n: Need) => number) => (x: Need, y: Need) => key(x) - key(y);
  const list = sessions.flatMap((s) => s.agents.filter((a) => blocked(a) || claimed(a) || isPricier(a)).map((a): Need =>
    blocked(a)
      ? { session: s.id, agent: a.id, type: a.type, tone: a.state === 'stalled' ? 'bad' : 'wait', ...(a.tool && { tool: a.tool.name, since: a.tool.since }), ...argOf(a) }
      : claimed(a)
        ? { session: s.id, agent: a.id, type: a.type, tone: 'claim', since: a.unbacked![0]!.ts, claim: { phrase: a.unbacked![0]!.phrase, reason: claimReason(a.unbacked![0]!) } }
        : { session: s.id, agent: a.id, type: a.type, tone: 'model', since: a.startedAt, pricier: pricierNeed(a) }));
  const group = (keep: (n: Need) => boolean) => list.filter(keep).sort(by((n) => n.since ?? Infinity));
  return [...group((n) => n.tone === 'wait' || n.tone === 'bad'), ...group((n) => n.tone === 'claim'), ...group((n) => n.tone === 'model')];
}

/** A session's agents as rows: each parent, then its subagents beneath it. A parent that is not in the list makes its agent a root. */
export function tree<A extends { id: string; parent?: string }>(agents: A[]): { agent: A; level: number; more: boolean }[] {
  const ids = new Set(agents.map((a) => a.id));
  const seen = new Set<string>();
  const out: { agent: A; level: number; more: boolean }[] = [];
  const walk = (list: A[], level: number) => list.forEach((agent, i) => {
    if (seen.has(agent.id)) return;
    seen.add(agent.id);
    out.push({ agent, level, more: i < list.length - 1 }); // more: a later sibling, so the tree line runs on
    walk(agents.filter((k) => k.parent === agent.id), level + 1);
  });
  walk(agents.filter((a) => !a.parent || !ids.has(a.parent)), 0);
  walk(agents.filter((a) => !seen.has(a.id)), 0); // a parent loop would hide its agents: list them rather than lose them
  return out;
}

/** How a skill started, from who ran it ("you" is the person typing it): `you typed it`, `implementer ran it 2×`. */
export const skillHow = (by: { who: string; count: number }[]) =>
  by.map((b) => `${b.who === 'you' ? 'you typed it' : `${b.who} ran it`}${b.count > 1 ? ` ${b.count}×` : ''}`).join(' · ');

// ── Live's top and its connection (#101, design/v0.3-readable.html, the Live board) ──

const be = (n: number) => (n === 1 ? 'is' : 'are');

/**
 * The sentence under the page's title: how many sessions run, which are working, which wait for you, and whether anything is stalled. A session that has an agent waiting for
 * you counts as waiting, not as working. Unbacked claims and pricier models are named only when there is one (a "0 unbacked claims" would read as a clean bill for a session whose
 * claims were never checked), and over every session shown, a just-ended one included, as Needs you lists them.
 */
export function liveSentence(sessions: { endedAt?: number; agents: CardAgent[] }[]): string {
  const running = sessions.filter((s) => !s.endedAt);
  const n = rowCounts(sessions.flatMap((s) => s.agents));
  const extra = [
    ...(n.claim ? [`${plural(n.claim, 'agent')} ${n.claim === 1 ? 'has' : 'have'} an unbacked claim.`] : []),
    ...(n.model ? [`${plural(n.model, 'agent')} ${be(n.model)} on a pricier model.`] : []),
  ];
  if (!running.length) return ['No session is running.', ...extra].join(' ');
  const waiting = running.filter((s) => s.agents.some((a) => a.state === 'waiting' && a.waitingFor)).length;
  const working = running.filter((s) => !s.agents.some((a) => a.state === 'waiting' && a.waitingFor) && s.agents.some((a) => a.state === 'working')).length;
  const parts = [...(working ? [`${working} ${be(working)} working`] : []), ...(waiting ? [`${waiting} ${be(waiting)} waiting for you`] : [])];
  const stalled = running.flatMap((s) => s.agents).filter((a) => a.state === 'stalled').length;
  return [
    `${plural(running.length, 'session')} ${be(running.length)} running${parts.length ? `: ${parts.join(', ')}` : ''}.`,
    stalled ? `${plural(stalled, 'agent')} ${be(stalled)} stalled.` : 'Nothing is stalled.',
    ...extra,
  ].join(' ');
}

/** No event for this long and the studio says it is quiet. */
export const QUIET_MS = 60_000;
export type Freshness = { tone: 'live' | 'quiet' | 'dropped'; text: string };

/**
 * The connection in words, never a running count: `Live` while the stream is open and events keep coming, `Quiet for 4m` once none has for a minute, `Reconnecting…` when the
 * stream dropped. `lastEvent` is the timestamp of the newest event any session holds, not the time the studio last heard from the stream: a snapshot on connect or a ping is no event.
 */
export function freshness(isOpen: boolean, lastEvent: number | undefined, now: number): Freshness {
  if (!isOpen) return { tone: 'dropped', text: 'Reconnecting…' };
  const quiet = lastEvent === undefined ? 0 : Math.max(0, now - lastEvent);
  if (quiet <= QUIET_MS) return { tone: 'live', text: 'Live' };
  return { tone: 'quiet', text: `Quiet for ${quiet >= 86_400_000 ? `${Math.floor(quiet / 86_400_000)}d` : short(quiet)}` };
}

/** The newest event any of the sessions holds, as its timestamp; none when there is no session. */
export const lastEventOf = (sessions: { lastTs: number }[]) => (sessions.length ? Math.max(...sessions.map((s) => s.lastTs)) : undefined);

/** When a session began, for its card: the time if that was today, else the day (`19 Oct`). */
export function startedLabel(ts: number, now: number) {
  const d = new Date(ts);
  return d.toDateString() === new Date(now).toDateString() ? clock(ts) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** How long it has run, in the largest whole unit: `6 days`, `3 hours`, `12 minutes`. */
export function runFor(ms: number) {
  const days = Math.floor(ms / 86_400_000), hours = Math.floor(ms / 3_600_000), minutes = Math.floor(ms / 60_000);
  return days >= 2 ? plural(days, 'day') : hours >= 1 ? plural(hours, 'hour') : minutes >= 1 ? plural(minutes, 'minute') : 'under a minute';
}
