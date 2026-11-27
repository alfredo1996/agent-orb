import { describe, expect, it } from 'vitest';
import type { BoardData, BoardIssue, FactoryPr, IssueCost } from '../src/Factory.tsx';
import { boardGroups, boardReading, boardRows, groupOf, otherPrs } from '../src/factory-view.ts';
import type { Agent, Session } from '../src/Live.tsx';
import type { HomeRow } from '../src/Home.tsx';
import type { Said } from '../src/kit.tsx';

// The Factory board's groups (#90): whose move it is, counted from Home's own state of each row and the sessions Live shows. The rows are the mockup's invented ones.
const MIN = 60_000;
const NOW = Date.parse('2026-11-27T12:00:00Z');
const text = (said: Said) => said.map((p) => (typeof p === 'string' ? p : p.b)).join('');

const row = (number: number, over: Partial<HomeRow> = {}): HomeRow => ({ number, title: `Issue ${number}`, milestone: 'v2.3', outside: false, stage: 'building', pr: null, ready: null, reason: null, sessions: [], sessionCount: 0, shares: [], ...over });
const agent = (over: Partial<Agent> = {}): Agent => ({ id: 'implementer', type: 'implementer', depth: 1, state: 'working', startedAt: NOW - 30 * MIN, lastTs: NOW - MIN, tasks: [], tokens: 0, cost: 0, skills: [], calls: 0, failed: 0, ...over });
const live = (id: string, agents: Agent[]): Session => ({ id, project: 'mobile-app', host: 'mbp', startedAt: NOW - 30 * MIN, lastTs: NOW - MIN, tokens: 0, cost: 0, costPartial: false, agents });
const on = (id: string) => ({ sessions: [{ id, at: NOW - 5 * MIN }], sessionCount: 1 });

describe('which group a row is in', () => {
  it('ready is Ready, whoever is on it', () => {
    expect(groupOf('ready', false)).toBe('ready');
    expect(groupOf('ready', true)).toBe('ready');
  });
  it('a stalled agent and one that waits for your OK are Blocked, though an agent is on them', () => {
    expect(groupOf('stalled', true)).toBe('blocked');
    expect(groupOf('waits', true)).toBe('blocked');
  });
  it('open findings, a budget reached, working and idle: Running with an agent on it, Blocked without', () => {
    for (const k of ['findings', 'over', 'working', 'idle'] as const) {
      expect(groupOf(k, true), k).toBe('running');
      expect(groupOf(k, false), k).toBe('blocked');
    }
  });
});

describe('the groups of the board, from the rows and the sessions', () => {
  const rows = [
    row(412, { stage: 'ready', ready: true, pr: { number: 418, head: 'f', merged: false } }),
    row(415, on('s-415')),
    row(409, { ...on('s-409'), openFindings: true }),
    row(411, { openFindings: true }),
    row(407, { budget: { usd: 96, budget: 80, mark: 'at100', partial: false } }),
    row(399),
    row(410, on('s-410')),
    row(400, { ...on('s-400'), openFindings: true }),
    row(420, { stage: 'queued' }),
    row(421, { stage: 'merged' }),
  ];
  const sessions = [
    live('s-415', [agent({ state: 'stalled', lastTs: NOW - 22 * MIN })]),
    live('s-409', [agent({ type: 'fixer', id: 'fixer' })]),
    live('s-410', [agent({ state: 'waiting', waitingFor: 'permission', tool: { name: 'Bash', id: 't', since: NOW - MIN, waiting: true } })]),
    live('s-400', [agent({ type: 'fixer', id: 'fixer' })]),
  ];
  const g = boardGroups(rows.filter((r) => r.stage !== 'queued' && r.stage !== 'merged'), sessions);
  const ids = (name: string) => g.find((x) => x.id === name)?.rows.map((r) => r.row.number);

  it('ready is Ready; a stalled agent, one waiting for your OK, and every row nobody is on are Blocked; a working agent on findings is Running', () => {
    expect(g.map((x) => x.id)).toEqual(['ready', 'blocked', 'running']);
    expect(ids('ready')).toEqual([412]);
    expect(ids('blocked')).toEqual([415, 410, 411, 407, 399]); // ranked's order: stalled, waits, findings, over budget, idle
    expect(ids('running')).toEqual([409, 400]);
  });

  it('the pill still says what Home says, whichever group it sits in', () => {
    expect(g.find((x) => x.id === 'running')!.rows.map((r) => r.key)).toEqual(['findings', 'findings']);
    expect(g.find((x) => x.id === 'blocked')!.rows.map((r) => r.key)).toEqual(['stalled', 'waits', 'findings', 'over', 'idle']);
  });

  it('queued and merged issues are in no group, and an empty group is left out', () => {
    expect(g.flatMap((x) => x.rows.map((r) => r.row.number))).not.toContain(420);
    expect(g.flatMap((x) => x.rows.map((r) => r.row.number))).not.toContain(421);
    expect(boardGroups([row(1, { stage: 'queued' })], []).map((x) => x.id)).toEqual([]);
    expect(boardGroups([row(399)], []).map((x) => x.id)).toEqual(['blocked']);
  });
});

describe('the rows of the board are the issues in flight, with what Home knows of each', () => {
  const issue = (number: number, over: Partial<BoardIssue> = {}): BoardIssue => ({ number, outside: false, stage: 'building', pr: null, ready: null, reason: null, sessions: [], sessionCount: 0, ...over });
  const board: BoardData = { project: 'p', milestone: 'v2.3', content: 'full', milestones: [], issues: [issue(412), issue(409), issue(417, { stage: 'queued' }), issue(403, { stage: 'merged' })] };
  const gate = { ok: true, note: '' };
  const pr = (number: number, issue: number | null, findings: boolean | null): FactoryPr => ({ number, head: 'h', issue, headOid: 'a'.repeat(40), ready: false, reason: null, dropped: 0, findings: [], conditions: { findings: { ok: findings, note: '' }, gate, bots: gate, clean: gate } });
  const cost = (n: number, over: Partial<IssueCost> = {}): IssueCost => ({ number: n, milestone: 'v2.3', usd: 96, partial: false, whole: 0, windows: 0, budget: 80, milestoneBudget: 80, source: 'milestone', mark: 'at100', ...over });

  it('only the issues in flight; queued and merged are not rows', () => {
    expect(boardRows(board, [], undefined, undefined).map((r) => r.number)).toEqual([412, 409]);
  });
  it('open findings are those of the newest open PR of the issue, as the server marks Home\'s rows', () => {
    const r = boardRows(board, [pr(10, 409, false), pr(12, 409, true), pr(11, 412, false), pr(13, null, false)], undefined, undefined);
    expect(r.find((x) => x.number === 409)!.openFindings).toBeUndefined(); // #12 is the newest and holds
    expect(r.find((x) => x.number === 412)!.openFindings).toBe(true);
  });
  it('a budget only when the issue has one, and the file links make "same files as"', () => {
    const r = boardRows(board, [], new Map([[412, cost(412)], [409, cost(409, { budget: null, mark: null })]]), [{ kind: 'file', a: 409, b: 412, files: ['a.ts'], count: 1, together: true }, { kind: 'mention', a: 409, b: 412 }, { kind: 'file', a: 409, b: 999, files: ['b.ts'], count: 1, together: false }]);
    expect(r.find((x) => x.number === 412)!.budget).toEqual({ usd: 96, budget: 80, mark: 'at100', partial: false });
    expect(r.find((x) => x.number === 409)!.budget).toBeUndefined();
    expect(r.find((x) => x.number === 409)!.shares).toEqual([{ issue: 412, together: true }]);
    expect(r.find((x) => x.number === 412)!.shares).toEqual([{ issue: 409, together: true }]);
  });
});

describe('the Reading, counted from the groups', () => {
  const g = (...ids: string[]) => boardGroups(ids.map((id, i) => (id === 'ready' ? row(412 + i, { stage: 'ready', ready: true }) : id === 'stalled' ? row(415 + i, on('s-st')) : id === 'over' ? row(407 + i, { budget: { usd: 96, budget: 80, mark: 'at100', partial: false } }) : row(409 + i, { ...on('s-run'), openFindings: true }))), [live('s-st', [agent({ state: 'stalled' })]), live('s-run', [agent()])]);
  const base = { project: 'mobile-app', milestone: 'v2.3 Offline', queued: 2, merged: 0, noPr: false, readAt: NOW as number | null, failed: false, others: [] as FactoryPr[] };
  const read = (groups: ReturnType<typeof g>, over: Partial<Parameters<typeof boardReading>[0]> = {}) => boardReading({ ...base, groups, ...over });
  const gate = { ok: true, note: '' };
  const pr = (number: number, issue: number | null, over: Partial<FactoryPr> = {}): FactoryPr => ({ number, head: 'h', issue, headOid: 'a'.repeat(40), ready: false, reason: null, dropped: 0, findings: [], conditions: { findings: gate, gate, bots: gate, clean: gate }, ...over });

  it('the mockup\'s sentence: one PR ready, two issues blocked and named by their pill, two running', () => {
    expect(text(read(g('ready', 'stalled', 'over', 'run', 'run')))).toBe('One PR is ready for your ok: #412. Two issues are blocked: #416 stalled and #409 over budget. Two are running.');
  });
  it('the first clause is the bold one, and a clause with a count of 0 is dropped', () => {
    const said = read(g('over', 'run'));
    expect(said[0]).toEqual({ b: 'One issue is blocked' });
    expect(text(said)).toBe('One issue is blocked: #407 over budget. One is running.');
    expect(text(read(g('ready', 'ready')))).toBe('Two PRs are ready for your ok: #412 and #413.');
  });
  it('a ready PR whose issue is over budget is counted ready, and its row is not Blocked (F4)', () => {
    const groups = boardGroups([row(7, { stage: 'ready', ready: true, pr: { number: 9, head: 'h', merged: false }, budget: { usd: 96, budget: 80, mark: 'at100', partial: false } })], []);
    expect(groups.map((x) => x.id)).toEqual(['ready']);
    expect(groups[0]!.rows[0]!.key).toBe('over'); // the pill keeps Home's word
    expect(text(read(groups))).toBe('One PR is ready for your ok: #7.');
  });
  it('a ready PR that is on no board row is counted ready, and named as not on this board (F1)', () => {
    expect(text(read(g('stalled'), { others: [pr(130, 125, { ready: true })] }))).toBe('One issue is blocked: #415 stalled. PR #130, not on this board, is ready for your ok.');
    expect(text(read([], { others: [pr(130, 125, { ready: true }), pr(131, null, { ready: true })] }))).toBe('PRs #130 and #131, not on this board, are ready for your ok.');
    expect(read([], { others: [pr(130, 125, { ready: true })] })[0]).toEqual({ b: 'PR #130, not on this board, is ready for your ok' });
  });
  it('with nothing in flight it says so and what is queued and merged, dropping a zero (F18)', () => {
    expect(text(read([], { queued: 5, noPr: true, project: 'agent-orb', milestone: 'v0.6 Explain' }))).toBe('Nothing is in flight in v0.6 Explain: 5 issues are queued, and agent-orb has no open PR.');
    expect(text(read([], { queued: 1 }))).toBe('Nothing is in flight in v2.3 Offline: 1 issue is queued.');
    expect(text(read([], { queued: 2, merged: 3, milestone: 'v1.2 Search' }))).toBe('Nothing is in flight in v1.2 Search: 2 issues are queued and 3 merged.');
    expect(text(read([], { queued: 0, merged: 3, milestone: 'v1.2 Search' }))).toBe('Nothing is in flight in v1.2 Search: 3 merged.');
    expect(text(read([], { queued: 0, merged: 0, milestone: 'v1.2 Search' }))).toBe('Nothing is in flight in v1.2 Search.');
  });
  it('the old "N PRs are ready, M aren\'t" sentence never comes back: no milestone, nothing queued, no GitHub read, or a board that failed all say what the page shows (F5)', () => {
    expect(text(read([], { milestone: null, queued: 0, noPr: true }))).toBe('Nothing is in flight: mobile-app has no open PR.');
    expect(text(read([], { milestone: null, queued: 0, others: [pr(1, null), pr(2, null)] }))).toBe('Nothing is in flight: 2 open PRs are under Other open PRs.');
    expect(text(read([], { queued: 0, noPr: true, readAt: null }))).toBe('Nothing is in flight in v2.3 Offline: nothing was read from GitHub for mobile-app.');
    expect(text(read([], { failed: true, queued: 0, others: [pr(1, 4), pr(2, null), pr(3, null), pr(4, null)] }))).toBe('The board could not be read: 4 open PRs are under Other open PRs.');
    expect(text(read([], { failed: true, queued: 0, noPr: true }))).toBe('The board could not be read: mobile-app has no open PR.');
    for (const said of [read([], { milestone: null, queued: 0, others: [pr(1, null)] }), read([], { failed: true, others: [pr(1, null)] })]) expect(text(said)).not.toContain("aren't");
  });
});

describe('the open PRs that are on no board row (F1)', () => {
  const gate = { ok: true, note: '' };
  const pr = (number: number, issue: number | null): FactoryPr => ({ number, head: 'h', issue, headOid: 'a'.repeat(40), ready: false, reason: null, dropped: 0, findings: [], conditions: { findings: gate, gate, bots: gate, clean: gate } });
  it('a PR on a row is left out; one that closes no issue, one whose issue is not on the board and an older one on an issue are in', () => {
    const groups = boardGroups([row(409, { pr: { number: 12, head: 'h', merged: false } })], []);
    expect(otherPrs([pr(12, 409), pr(10, 409), pr(130, 125), pr(13, null)], groups).map((p) => p.number)).toEqual([10, 130, 13]);
  });
  it('with no row at all (the board failed or shows nothing in flight) every open PR is in', () => {
    expect(otherPrs([pr(1, 2), pr(3, null)], []).map((p) => p.number)).toEqual([1, 3]);
  });
});

describe('what a row knows beyond Home\'s read (F2, F11)', () => {
  const issue = (number: number, over: Partial<BoardIssue> = {}): BoardIssue => ({ number, outside: false, stage: 'building', pr: null, ready: null, reason: null, sessions: [], sessionCount: 0, ...over });
  const board: BoardData = { project: 'p', milestone: 'v2.3', content: 'full', milestones: [], issues: [issue(415, { sessions: [{ id: 's-new', at: NOW }, { id: 's-old', at: NOW - MIN }], sessionCount: 2 }), issue(412, { stage: 'ready', ready: true, pr: { number: 418, head: 'f', merged: false } }), issue(399)] };
  const gate = { ok: true, note: '' };
  const f = (id: string, fate: 'open' | 'dismissed' | 'fixed') => ({ id, severity: 'minor', file: 'a.ts', fate });
  const pr = (findings: ReturnType<typeof f>[]): FactoryPr => ({ number: 418, head: 'f', issue: 412, headOid: 'a'.repeat(40), ready: true, reason: null, dropped: 0, findings, conditions: { findings: gate, gate, bots: gate, clean: gate } });
  const sess = (id: string, branch?: string): Session => ({ ...live(id, []), ...(branch ? { branch } : {}) });

  it('a row with no PR carries the branch of its newest session the page has', () => {
    const r = boardRows(board, [], undefined, undefined, [sess('s-old', 'fix/old'), sess('s-new', 'fix/415-sync-dialog')]);
    expect(r.find((x) => x.number === 415)!.branch).toBe('fix/415-sync-dialog');
    expect(r.find((x) => x.number === 399)!.branch).toBeUndefined();
    expect(boardRows(board, [], undefined, undefined, [sess('s-old', 'fix/old')]).find((x) => x.number === 415)!.branch).toBe('fix/old'); // the newest the page has
    expect(boardRows(board, [], undefined, undefined, [sess('s-new')]).find((x) => x.number === 415)!.branch).toBeUndefined();
  });
  it('how many findings the newest open PR dismissed, when any', () => {
    const r = boardRows(board, [pr([f('F1', 'dismissed'), f('F2', 'dismissed'), f('F3', 'fixed')])], undefined, undefined, []);
    expect(r.find((x) => x.number === 412)!.dismissed).toBe(2);
    expect(boardRows(board, [pr([f('F3', 'fixed')])], undefined, undefined, []).find((x) => x.number === 412)!.dismissed).toBeUndefined();
  });
});
