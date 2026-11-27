import { describe, expect, it } from 'vitest';
import type { BoardData, BoardIssue, FactoryPr, IssueCost } from '../src/Factory.tsx';
import { boardGroups, boardReading, boardRows, groupOf } from '../src/factory-view.ts';
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
  const read = (groups: ReturnType<typeof g>, over = {}) => boardReading({ groups, project: 'mobile-app', milestone: 'v2.3 Offline', queued: 2, noPr: false, readAt: NOW, ...over });

  it('the mockup\'s sentence: one PR ready, two issues blocked and named by their pill, two running', () => {
    expect(text(read(g('ready', 'stalled', 'over', 'run', 'run'))!)).toBe('One PR is ready for your ok: #412. Two issues are blocked: #416 stalled and #409 over budget. Two are running.');
  });
  it('the first clause is the bold one, and a clause with a count of 0 is dropped', () => {
    const said = read(g('over', 'run'))!;
    expect(said[0]).toEqual({ b: 'One issue is blocked' });
    expect(text(said)).toBe('One issue is blocked: #407 over budget. One is running.');
    expect(text(read(g('ready', 'ready'))!)).toBe('Two PRs are ready for your ok: #412 and #413.');
  });
  it('with nothing in flight it says so, how many are queued, and that the project has no open PR', () => {
    expect(text(read([], { queued: 5, noPr: true, project: 'agent-orb', milestone: 'v0.6 Explain' })!)).toBe('Nothing is in flight in v0.6 Explain: its five issues are queued, and agent-orb has no open PR.');
    expect(text(read([], { queued: 1 })!)).toBe('Nothing is in flight in v2.3 Offline: its one issue is queued.');
  });
  it('with no read of GitHub or nothing queued it leaves the existing wording to the page', () => {
    expect(read([], { readAt: null })).toBeUndefined();
    expect(read([], { queued: 0 })).toBeUndefined();
    expect(read([], { milestone: null })).toBeUndefined();
  });
});
