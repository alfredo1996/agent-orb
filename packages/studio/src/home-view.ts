// What Home says of its rows (v0.5 slice 3, #107): the state of each issue in flight, their order and the sentence on top, all counted from the server's rows and the sessions Live shows. Pure, for tests.
import type { HomeProject, HomeRow } from './Home.tsx';
import type { Said } from './kit.tsx';
import type { Session } from './Live.tsx';
import { nowOn } from './now-on.ts';

export type RowKey = 'stalled' | 'waits' | 'findings' | 'over' | 'working' | 'idle' | 'ready';
/** The state pill, worst first by `rank`: an agent stalled, one waiting for your OK to run a tool, a PR with findings open, a budget reached, then an agent on it, then nobody, and last a PR ready for your ok. */
export const STATES: Record<RowKey, { label: string; tone: 'stalled' | 'waiting' | 'working' | 'done' | 'ready'; rank: number }> = {
  stalled: { label: 'Stalled', tone: 'stalled', rank: 0 }, waits: { label: 'Waits on you', tone: 'waiting', rank: 1 }, findings: { label: 'Open findings', tone: 'waiting', rank: 2 },
  over: { label: 'Over budget', tone: 'waiting', rank: 3 }, working: { label: 'Working', tone: 'working', rank: 4 }, idle: { label: 'Idle', tone: 'done', rank: 4 }, ready: { label: 'Ready', tone: 'ready', rank: 5 },
};

export function rowKey(row: HomeRow, sessions: readonly Session[]): RowKey {
  const { who, mark } = nowOn(row, sessions);
  if (mark === 'bad') return 'stalled';
  if (mark === 'wait') return 'waits';
  if (row.openFindings) return 'findings';
  if (row.budget?.mark === 'at100') return 'over';
  if (row.ready) return 'ready';
  return who ? 'working' : 'idle';
}

/** The rows with their state, worst first; those of one rank keep the server's order (the newest session first). */
export const ranked = (rows: readonly HomeRow[], sessions: readonly Session[]) =>
  rows.map((row) => ({ row, key: rowKey(row, sessions) })).toSorted((a, b) => STATES[a.key].rank - STATES[b.key].rank);

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const list = (parts: string[]) => parts.join(', ').replace(/, ([^,]*)$/, ' and $1');

/** The sentence on top: how many sessions are running and where, and how many things wait on you (a stalled agent, one that asks for your OK, a PR ready for it). Counted, never written by a model. */
export function homeSentence(projects: readonly HomeProject[], sessions: readonly Session[]): Said {
  const running = sessions.filter((s) => !s.endedAt);
  const where = new Map<string, number>();
  for (const s of running) where.set(s.project, (where.get(s.project) ?? 0) + 1);
  const waits = projects.flatMap((p) => ranked(p.rows, sessions)).filter(({ key }) => key === 'stalled' || key === 'waits' || key === 'ready').length;
  const wait = waits === 0 ? 'Nothing waits on you.' : `${waits} ${plural(waits, 'thing waits', 'things wait')} on you.`;
  if (!running.length) return ['No session is running. ', wait];
  const places = [...where].toSorted(([an, a], [bn, b]) => b - a || (an < bn ? -1 : 1));
  const on = running.length === 1 ? `, on ${places[0]![0]}` : `, ${list(places.map(([name, n]) => `${n} on ${name}`))}`;
  return [{ b: `${running.length} ${plural(running.length, 'session is', 'sessions are')} running` }, `${on}. ${wait}`];
}
