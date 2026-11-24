// What Home says of what changed since the owner last looked (v0.5 slice 4, #108): the mark kept in this browser, the rows of GET /api/changes with the stalls the stream shows, and the words of the card, its hint and the
// clause of the sentence on top, all counted from the list and never written by a model. Pure, for tests.
import { day, DAY, plural } from './format.ts';
import type { HomeProject } from './Home.tsx';
import type { Session } from './Live.tsx';
import { agentName } from './live-cards.ts';

/** A row of GET /api/changes (`open`, `sha` and `branch` are what its sub line says), or a stall from the stream (`stalled`, with the agent in `who` and what it was running in `tool`). */
export type Change = { at: number; kind: string; project: string; issue: number; title?: string; pr?: number; who?: string; open?: number; sha?: string; branch?: string; tool?: string };
export type FeedRow = { change: Change; tone?: 'ok' | 'bad' | 'wait'; what: string; sub: string; code?: string };

const KEY = 'orb.lookedAt';
const store = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // blocked storage
  }
};
/** When the owner last pressed Caught up in this browser; null for a first look, and when the storage is missing, blocked or holds something that is not a time. */
export function loadMark(storage: Storage | undefined = store()): number | null {
  try {
    const n = Number(storage?.getItem(KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
/** Moves the mark. A storage that throws loses it on a reload, and the page goes on. */
export function saveMark(at: number, storage: Storage | undefined = store()) {
  try {
    storage?.setItem(KEY, String(at));
  } catch {
    // the mark then lives in the page only
  }
}
/** What the card asks the server from: the mark, else the past 24 hours. */
export const sinceOf = (mark: number | null, now: number) => mark ?? now - DAY;

const clock = (ms: number) => `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}`;
export const timeOf = clock;
/** `09:12`, and the day before it when it is not today: `09:12 on 9 Nov`. */
export const whenOf = (ms: number, now: number) => (new Date(ms).toDateString() === new Date(now).toDateString() ? clock(ms) : `${clock(ms)} on ${day(ms, now)}`);

/**
 * The agents stalled now whose stall began after `since`, as changes. A stall is in /stream only (nothing stores it), so one that ended before the owner looked is not listed. The issue is the one
 * the board's row names for the session.
 * ponytail: a stalled agent of a session that no row of Home's projects shows (one on no issue) is not listed. Upgrade: a stalls table written from stall.start.
 */
export function stalls(projects: readonly HomeProject[], sessions: readonly Session[], since: number): Change[] {
  const out: Change[] = [];
  for (const p of projects) {
    for (const r of p.rows) {
      const mine = new Set(r.sessions.map((s) => s.id));
      for (const s of sessions) {
        if (s.endedAt || !mine.has(s.id)) continue;
        for (const a of s.agents) {
          const at = a.state === 'stalled' ? (a.stalledSince ?? a.tool?.since) : undefined;
          if (at !== undefined && at > since) out.push({ at, kind: 'stalled', project: p.name, issue: r.number, ...(r.title ? { title: r.title } : {}), who: agentName(a.type), ...(a.tool ? { tool: a.tool.name } : {}) });
        }
      }
    }
  }
  return out;
}

const findings = (open: number | undefined) => (open ? `${plural(open, 'finding')} open` : 'no finding open');
/** One change in the card's words. */
export function rowOf(c: Change): FeedRow {
  const pr = c.pr === undefined ? '' : `PR #${c.pr}`;
  switch (c.kind) {
    case 'merged': return { change: c, tone: 'ok', what: 'merged.', sub: `${c.project} · ${pr}` };
    case 'ready': return { change: c, tone: 'ok', what: 'is ready for your ok.', sub: `${c.project} · ${pr}` };
    case 'stalled': return { change: c, tone: 'bad', what: 'stalled.', sub: `${c.project} · the ${c.who} has had no event since ${clock(c.at)}${c.tool ? ', on' : ''}`, ...(c.tool ? { code: c.tool } : {}) };
    case 'reviewed': case 'reviewed-again':
      return { change: c, ...(c.open ? { tone: 'wait' as const } : {}), what: c.kind === 'reviewed' ? 'was reviewed.' : 'was reviewed again.', sub: `${c.project} · ${findings(c.open)}` };
    case 'gate': return { change: c, what: 'reached the gate.', sub: `${c.project} · a test run passed on ${c.sha}` };
    case 'picked-up': return { change: c, what: 'was picked up.', sub: `${c.project} · a session started${c.branch ? ' on' : ''}`, ...(c.branch ? { code: c.branch } : {}) };
    default: return { change: c, what: 'has a PR.', sub: `${c.project} · ${pr} opened` };
  }
}

/** The server's changes and the stalls, newest first. The server caps its own list at 50; the stalls are few (the agents stalled now). */
export const feedOf = (changes: readonly Change[], stalled: readonly Change[]): FeedRow[] =>
  [...changes, ...stalled].toSorted((a, b) => b.at - a.at || a.project.localeCompare(b.project) || a.issue - b.issue).map(rowOf);

/** The card's hint: `7 changes since 09:12 today`, `last looked at 11:44` when nothing changed, `the past 24 hours` on a first look. */
export function hintOf(count: number, mark: number | null, now: number) {
  if (mark === null) return 'the past 24 hours';
  if (!count) return `last looked at ${whenOf(mark, now)}`;
  return `${plural(count, 'change')} since ${new Date(mark).toDateString() === new Date(now).toDateString() ? `${clock(mark)} today` : whenOf(mark, now)}`;
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const word = (n: number) => WORDS[n] ?? String(n);
const count = (rows: readonly FeedRow[], kind: string) => rows.filter((r) => r.change.kind === kind).length;

/** The clause the sentence on top gains, counted from the list: `Since you last looked at 09:12, one issue merged, one became ready and one session stalled.` */
export function sinceClause(rows: readonly FeedRow[], mark: number | null, now: number): string {
  const from = mark === null ? 'In the past 24 hours,' : `Since you last looked at ${whenOf(mark, now)},`;
  if (!rows.length) return mark === null ? 'Nothing has changed in the past 24 hours.' : `Nothing has changed since you last looked at ${whenOf(mark, now)}.`;
  const merged = count(rows, 'merged');
  const ready = count(rows, 'ready');
  const stalled = count(rows, 'stalled');
  const parts = [
    ...(merged ? [`${word(merged)} ${merged === 1 ? 'issue' : 'issues'} merged`] : []),
    ...(ready ? [`${word(ready)} became ready`] : []),
    ...(stalled ? [`${word(stalled)} ${stalled === 1 ? 'session' : 'sessions'} stalled`] : []),
  ];
  const list = parts.length ? parts.join(', ').replace(/, ([^,]*)$/, ' and $1') : plural(rows.length, 'thing') + ' changed';
  return `${from} ${list}.`;
}
