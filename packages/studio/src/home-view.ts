// What Home says of its rows (v0.5 slice 3, #107): the state of each issue in flight, their order and the sentence on top, all counted from the server's rows and the sessions Live shows. Pure, for tests.
import type { HomeProject, HomeRow } from './Home.tsx';
import type { Said } from './kit.tsx';
import type { Session } from './Live.tsx';
import { plural } from './format.ts';
import { agentOn, nowOn } from './now-on.ts';

export type RowKey = 'stalled' | 'waits' | 'findings' | 'over' | 'working' | 'idle' | 'ready';
/** The state pill, worst first by `rank`, in the mockup's order: an agent stalled, one waiting for your OK to run a tool, a PR with findings open, a budget reached, a PR ready for your ok, then an agent working on it or nobody. */
export const STATES: Record<RowKey, { label: string; tone: 'stalled' | 'waiting' | 'working' | 'done' | 'ready'; rank: number }> = {
  stalled: { label: 'Stalled', tone: 'stalled', rank: 0 }, waits: { label: 'Waits on you', tone: 'waiting', rank: 1 }, findings: { label: 'Open findings', tone: 'waiting', rank: 2 },
  over: { label: 'Over budget', tone: 'waiting', rank: 3 }, ready: { label: 'Ready', tone: 'ready', rank: 4 }, working: { label: 'Working', tone: 'working', rank: 5 }, idle: { label: 'Idle', tone: 'done', rank: 5 },
};

export function rowKey(row: HomeRow, sessions: readonly Session[]): RowKey {
  const { mark } = nowOn(row, sessions);
  if (mark === 'bad') return 'stalled';
  if (mark === 'wait') return 'waits';
  if (row.openFindings) return 'findings';
  if (row.budget?.mark === 'at100') return 'over';
  if (row.ready) return 'ready';
  const on = agentOn(row, sessions);
  // an agent that waits for your next prompt is waiting on you; one between steps is not working either
  if (on?.state === 'waiting') return on.waitingFor === 'prompt' ? 'waits' : 'idle';
  return on ? 'working' : 'idle';
}

/** The rows with their state, worst first; those of one rank keep the server's order (the newest session first). */
export const ranked = (rows: readonly HomeRow[], sessions: readonly Session[]) =>
  rows.map((row) => ({ row, key: rowKey(row, sessions) })).toSorted((a, b) => STATES[a.key].rank - STATES[b.key].rank);

const list = (parts: string[]) => parts.join(', ').replace(/, ([^,]*)$/, ' and $1');

/** The running sessions of a project that are on no issue (the server names them) with an agent that is stalled or waits for you: a permission or the next prompt. */
const loose = (p: HomeProject, sessions: readonly Session[]) => {
  const named = new Set(p.notOnIssue.sessions.map((s) => s.id));
  return sessions.filter((s) => !s.endedAt && s.project === p.name && named.has(s.id) && s.agents.some((a) => a.state === 'stalled' || (a.state === 'waiting' && a.waitingFor !== undefined)));
};

/** The sentence on top: how many sessions are running and where, and how many things wait on you: every row that is not just worked on (a stalled agent, one that asks for your OK, open findings, a budget reached, a PR ready for your ok) and every session on no issue that is stalled or waits for you. `since` (the card's clause) goes before them. Counted, never written by a model. */
export function homeSentence(projects: readonly HomeProject[], sessions: readonly Session[], since = ''): Said {
  const running = sessions.filter((s) => !s.endedAt);
  const where = new Map<string, number>();
  for (const s of running) where.set(s.project, (where.get(s.project) ?? 0) + 1);
  const waits = projects.reduce((n, p) => n + ranked(p.rows, sessions).filter(({ key }) => key !== 'working' && key !== 'idle').length + loose(p, sessions).length, 0);
  const wait = waits === 0 ? 'Nothing waits on you.' : `${plural(waits, 'thing')} ${waits === 1 ? 'waits' : 'wait'} on you.`;
  const said = since ? `${since} ${wait}` : wait; // Since you last looked (#108): the clause the card's list gives, counted there
  if (!running.length) return ['No session is running. ', said];
  const places = [...where].toSorted(([an, a], [bn, b]) => b - a || (an < bn ? -1 : 1));
  const on = running.length === 1 ? `, on ${places[0]![0]}` : `, ${list(places.map(([name, n]) => `${n} on ${name}`))}`;
  return [{ b: `${plural(running.length, 'session')} ${running.length === 1 ? 'is' : 'are'} running` }, `${on}. ${said}`];
}
