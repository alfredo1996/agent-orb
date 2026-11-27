// What the Factory board says of its rows (#90): whose move each issue in flight is, the rows Home draws built from the page's own reads, and the sentence on top. Pure, for tests.
// The state of a row is Home's (`rowKey`), so the two pages never disagree; the groups only sort those states by who has to act.
import type { BoardData, FactoryPr, IssueCost } from './Factory.tsx';
import type { IssueLink } from './FactoryMap.tsx';
import type { HomeRow } from './Home.tsx';
import { plural } from './format.ts';
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

/** A row's group by its pill's key: ready is Ready; a stalled agent, or one that waits for your OK, is Blocked though it is on the issue; any other row is Running with an agent on it now, and Blocked with nobody. */
export const groupOf = (key: RowKey, agent: boolean): GroupId => (key === 'ready' ? 'ready' : key === 'stalled' || key === 'waits' ? 'blocked' : agent ? 'running' : 'blocked');

export type Group = { id: GroupId; rows: { row: HomeRow; key: RowKey }[] };

/** The rows of issues in flight (a queued or merged one is in no group) in their groups, an empty group left out; within one, Home's order (worst first). */
export function boardGroups(rows: readonly HomeRow[], sessions: readonly Session[]): Group[] {
  // a PR ready for your ok is Ready whatever else its row says (a budget warns and stops nothing); its pill keeps Home's word for the row
  const all = ranked(rows.filter((r) => r.stage !== 'queued' && r.stage !== 'merged'), sessions).map((r) => ({ ...r, group: r.row.ready === true ? 'ready' as const : groupOf(r.key, agentOn(r.row, sessions) !== undefined) }));
  return (Object.keys(GROUPS) as GroupId[]).map((id) => ({ id, rows: all.filter((r) => r.group === id).map(({ row, key }) => ({ row, key })) })).filter((g) => g.rows.length > 0);
}

/** The open PRs that are on no row of the board: one that closes no issue, one whose issue is not in flight on this board (another milestone, closed, or the board could not be read), an older PR of an issue. None vanishes. */
export const otherPrs = (prs: readonly FactoryPr[], groups: readonly Group[]) => {
  const on = new Set(groups.flatMap((g) => g.rows.map((r) => r.row.pr?.number)));
  return prs.filter((p) => !on.has(p.number));
};

/**
 * The board's issues in flight as Home's rows: the files each shares with another (the file links of the milestone, both ends on the board), whether the newest open PR of the issue has findings open
 * (the server's rule for Home's rows) and how many it dismissed, the branch of the issue's newest session the page has (`sessions`, Live's), and the issue's budget when it has one. Queued and merged issues are no row.
 */
export function boardRows(board: BoardData, prs: readonly FactoryPr[], costs: ReadonlyMap<number, IssueCost> | undefined, links: readonly IssueLink[] | undefined, sessions: readonly Session[] = []): HomeRow[] {
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
    const dismissed = newest?.findings.filter((f) => f.fate === 'dismissed').length ?? 0;
    const branch = i.sessions.map((x) => sessions.find((s) => s.id === x.id)?.branch).find((b) => b !== undefined); // i.sessions is newest first
    return {
      ...i,
      ...(branch ? { branch } : {}),
      ...(dismissed > 0 ? { dismissed } : {}),
      shares: (shares.get(i.number) ?? []).toSorted((a, b) => a.issue - b.issue),
      ...(newest?.conditions.findings.ok === false ? { openFindings: true as const } : {}),
      ...(c && c.budget !== null ? { budget: { usd: c.usd, budget: c.budget, mark: c.mark, partial: c.partial } } : {}),
    };
  });
}

const list = (parts: string[]) => parts.join(', ').replace(/, ([^,]*)$/, ' and $1');

const word = (n: number) => ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'][n] ?? String(n);

/**
 * The sentence on top, counted from the groups and the open PRs on no row (`others`): how many PRs are ready for your ok (named; one that is on no row says so), how many issues are blocked (each named with its pill's
 * label) and how many are running. With none of those it says nothing is in flight, what is queued and merged, and where the open PRs are (none, or under Other open PRs); a board that could not be read says so and the same
 * of the PRs. Never the old count of PRs ready and not (#90). The caller shows no Reading while the board has not answered.
 */
export function boardReading({ groups, others, project, milestone, queued, merged, noPr, readAt, failed }: {
  groups: readonly Group[]; others: readonly FactoryPr[]; project: string; milestone: string | null; queued: number; merged: number; noPr: boolean; readAt: number | null; failed: boolean;
}): Said {
  const rows = (id: GroupId) => groups.find((g) => g.id === id)?.rows ?? [];
  const [ready, blocked, running] = [rows('ready'), rows('blocked'), rows('running')];
  const away = others.filter((p) => p.ready);
  const clauses: [string, string][] = [];
  if (ready.length) clauses.push([`${word(ready.length)} ${ready.length === 1 ? 'PR is' : 'PRs are'} ready for your ok`, `: ${list(ready.map((r) => `#${r.row.number}`))}.`]);
  if (blocked.length) clauses.push([`${word(blocked.length)} ${blocked.length === 1 ? 'issue is' : 'issues are'} blocked`, `: ${list(blocked.map((r) => `#${r.row.number} ${STATES[r.key].label.toLowerCase()}`))}.`]);
  if (running.length) clauses.push([`${word(running.length)} ${running.length === 1 ? 'is' : 'are'} running`, '.']);
  if (away.length) clauses.push([`${away.length === 1 ? 'PR' : 'PRs'} ${list(away.map((p) => `#${p.number}`))}, not on this board, ${away.length === 1 ? 'is' : 'are'} ready for your ok`, '.']);
  if (clauses.length) return clauses.flatMap(([lead, rest], i): Said => (i === 0 ? [{ b: lead }, rest] : [` ${lead}${rest}`]));
  const prs = noPr ? (readAt === null ? `nothing was read from GitHub for ${project}` : `${project} has no open PR`) : others.length ? `${plural(others.length, 'open PR')} ${others.length === 1 ? 'is' : 'are'} under Other open PRs` : '';
  if (failed) return [{ b: 'The board could not be read' }, `${prs ? `: ${prs}` : ''}.`];
  const states = list([...(queued ? [`${plural(queued, 'issue')} ${queued === 1 ? 'is' : 'are'} queued`] : []), ...(merged ? [`${merged} merged`] : [])]);
  const parts = [states, prs].filter(Boolean);
  return [{ b: 'Nothing is in flight' }, `${milestone === null ? '' : ` in ${milestone}`}${parts.length ? `: ${parts.join(', and ')}` : ''}.`];
}
