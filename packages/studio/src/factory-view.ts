// What the Factory board says of its rows (#90): whose move each issue in flight is, the rows Home draws built from the page's own reads, and the sentence on top. Pure, for tests.
// The state of a row is Home's (`rowKey`), so the two pages never disagree; the groups only sort those states by who has to act.
import type { BoardData, FactoryPr, IssueCost } from './Factory.tsx';
import type { IssueLink } from './FactoryMap.tsx';
import type { HomeRow } from './Home.tsx';
import { ranked, STATES } from './home-view.ts';
import type { Said } from './kit.tsx';
import type { Session } from './Live.tsx';
import { agentOn } from './now-on.ts';
import type { RowKey } from './home-view.ts';

export type GroupId = 'ready' | 'blocked' | 'running';
/** The strips of the board, in order: a PR ready for your ok, what waits on you to look, and what an agent is on. */
export const GROUPS: Record<GroupId, { name: string; hint: string; tone: 'ok' | 'bad' | 'run' }> = {
  ready: { name: 'Ready for your ok', hint: 'Every check passes. Merging stays yours.', tone: 'ok' },
  blocked: { name: 'Blocked', hint: 'Nothing moves these until you look.', tone: 'bad' },
  running: { name: 'Running', hint: 'An agent is on it now.', tone: 'run' },
};

/** A row's group: ready is Ready; a stalled agent, or one that waits for your OK, is Blocked though it is on the issue; any other row is Running with an agent on it now, and Blocked with nobody. */
export const groupOf = (key: RowKey, agent: boolean): GroupId => (key === 'ready' ? 'ready' : key === 'stalled' || key === 'waits' ? 'blocked' : agent ? 'running' : 'blocked');

export type Group = { id: GroupId; rows: { row: HomeRow; key: RowKey }[] };

/** The rows of issues in flight (a queued or merged one is in no group) in their groups, an empty group left out; within one, Home's order (worst first). */
export function boardGroups(rows: readonly HomeRow[], sessions: readonly Session[]): Group[] {
  const all = ranked(rows.filter((r) => r.stage !== 'queued' && r.stage !== 'merged'), sessions).map((r) => ({ ...r, group: groupOf(r.key, agentOn(r.row, sessions) !== undefined) }));
  return (Object.keys(GROUPS) as GroupId[]).map((id) => ({ id, rows: all.filter((r) => r.group === id).map(({ row, key }) => ({ row, key })) })).filter((g) => g.rows.length > 0);
}

/**
 * The board's issues in flight as Home's rows: the files each shares with another (the file links of the milestone, both ends on the board), whether the newest open PR of the issue has findings open
 * (the server's rule for Home's rows), and the issue's budget when it has one. Queued and merged issues are no row.
 */
export function boardRows(board: BoardData, prs: readonly FactoryPr[], costs: ReadonlyMap<number, IssueCost> | undefined, links: readonly IssueLink[] | undefined): HomeRow[] {
  const shown = new Set(board.issues.map((i) => i.number));
  const shares = new Map<number, { issue: number; together: boolean }[]>();
  for (const l of links ?? []) {
    if (l.kind !== 'file' || !shown.has(l.a) || !shown.has(l.b)) continue;
    shares.set(l.a, [...(shares.get(l.a) ?? []), { issue: l.b, together: l.together }]);
    shares.set(l.b, [...(shares.get(l.b) ?? []), { issue: l.a, together: l.together }]);
  }
  return board.issues.filter((i) => i.stage !== 'queued' && i.stage !== 'merged').map((i) => {
    const newest = prs.filter((p) => p.issue === i.number).toSorted((a, b) => b.number - a.number)[0];
    const c = costs?.get(i.number);
    return {
      ...i,
      shares: (shares.get(i.number) ?? []).toSorted((a, b) => a.issue - b.issue),
      ...(newest?.conditions.findings.ok === false ? { openFindings: true as const } : {}),
      ...(c && c.budget !== null ? { budget: { usd: c.usd, budget: c.budget, mark: c.mark, partial: c.partial } } : {}),
    };
  });
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const word = (n: number) => WORDS[n] ?? String(n);
const list = (parts: string[]) => parts.join(', ').replace(/, ([^,]*)$/, ' and $1');

/**
 * The sentence on top, counted from the groups: how many PRs are ready for your ok (named), how many issues are blocked (each named with its pill's label) and how many are running. With nothing in flight
 * and some issues queued it says so, and that the project has no open PR when it has none. Anything else (no read of GitHub yet, no milestone, nothing queued) is the page's old wording: undefined.
 */
export function boardReading({ groups, project, milestone, queued, noPr, readAt }: { groups: readonly Group[]; project: string; milestone: string | null; queued: number; noPr: boolean; readAt: number | null }): Said | undefined {
  if (!groups.length) {
    if (readAt === null || milestone === null || queued === 0) return undefined;
    return [{ b: 'Nothing is in flight' }, ` in ${milestone}: its ${word(queued).toLowerCase()} ${queued === 1 ? 'issue is' : 'issues are'} queued${noPr ? `, and ${project} has no open PR` : ''}.`];
  }
  const rows = (id: GroupId) => groups.find((g) => g.id === id)?.rows ?? [];
  const [ready, blocked, running] = [rows('ready'), rows('blocked'), rows('running')];
  const clauses: [string, string][] = [];
  if (ready.length) clauses.push([`${word(ready.length)} ${ready.length === 1 ? 'PR is' : 'PRs are'} ready for your ok`, `: ${list(ready.map((r) => `#${r.row.number}`))}.`]);
  if (blocked.length) clauses.push([`${word(blocked.length)} ${blocked.length === 1 ? 'issue is' : 'issues are'} blocked`, `: ${list(blocked.map((r) => `#${r.row.number} ${STATES[r.key].label.toLowerCase()}`))}.`]);
  if (running.length) clauses.push([`${word(running.length)} ${running.length === 1 ? 'is' : 'are'} running`, '.']);
  return clauses.flatMap(([lead, rest], i): Said => (i === 0 ? [{ b: lead }, rest] : [` ${lead}${rest}`]));
}
