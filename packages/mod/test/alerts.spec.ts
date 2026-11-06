import { describe, expect, it } from 'vitest';
import { ALERT_KEEP_MS, budgetNotice, newMarks, newlyReady, parseBudget, parseFactory, readyNotice, staleAlerts, type BudgetMark, type PrMemory } from '../hooks/core.ts';

// v0.4 slice 4 (#30): alerts are desktop notifications. What decides one lives here, as pure functions: which PRs and budget marks are new since the last poll, what a notice says,
// which kept keys are old. The sending, once per key across sessions, is the engine tests'.
const ok = { ok: true, note: 'fine' };
const pr = (number: number, ready: boolean, headOid = 'a'.repeat(40)): PrMemory => ({ number, head: `fix/${number}-x`, headOid, ready, conditions: { findings: ok, gate: ok, bots: ok, clean: ok } });
const mark = (issue: number, m: 80 | 100, spent = 64, budget = 80): BudgetMark => ({ issue, mark: m, spent, budget });

describe('parseFactory keeps the server\'s verdict', () => {
  const served = (rest: object) => JSON.stringify({ project: 'r', readAt: 1, prs: [{ number: 416, head: 'fix/409-x', headOid: 'e'.repeat(40), ...rest,
    conditions: { findings: ok, gate: ok, bots: ok, clean: ok } }] });

  it('ready is the server\'s own boolean (which also covers old data), never worked out from the four conditions', () => {
    expect(parseFactory(served({ ready: true }))?.prs[0]?.ready).toBe(true);
    expect(parseFactory(served({ ready: false }))?.prs[0]?.ready).toBe(false); // all four hold, but the server read the data as old
    expect(parseFactory(served({}))?.prs[0]?.ready).toBe(false); // an answer without it is not a yes
    expect(parseFactory(served({ ready: 'true' }))?.prs[0]?.ready).toBe(false);
  });
});

describe('newlyReady: a PR that is ready now and was not at the last poll', () => {
  it('the first poll ever is a baseline: what is ready already alerts nothing, and is remembered', () => {
    expect(newlyReady(undefined, [pr(418, true), pr(419, false)])).toEqual({ fresh: [], seen: [`418:${'a'.repeat(40)}`] });
  });

  it('a PR not ready at the last poll that is ready now alerts; one ready at the last poll does not', () => {
    const last = [`418:${'a'.repeat(40)}`];
    expect(newlyReady(last, [pr(418, true), pr(419, true)]).fresh.map((p) => p.number)).toEqual([419]);
    expect(newlyReady([], [pr(418, true)]).fresh.map((p) => p.number)).toEqual([418]);
  });

  it('a ready PR on a new head is a new ready: the old head\'s ready does not cover it', () => {
    const last = [`418:${'a'.repeat(40)}`];
    expect(newlyReady(last, [pr(418, true, 'b'.repeat(40))]).fresh.map((p) => p.number)).toEqual([418]);
  });

  it('what is remembered is what is ready now: a PR that stopped being ready is forgotten, so it alerts again when it is', () => {
    expect(newlyReady([`418:${'a'.repeat(40)}`], [pr(418, false)])).toEqual({ fresh: [], seen: [] });
  });

  it('a remembered value that is not a list is no memory at all: the baseline', () => {
    for (const bad of [null, 'x', 5, {}]) expect(newlyReady(bad, [pr(418, true)]).fresh, String(bad)).toEqual([]);
  });
});

describe('parseBudget: GET /api/budget', () => {
  const row = (rest: object) => ({ number: 407, milestone: 'v0.4 Factory', usd: 64.2, partial: false, whole: 64.2, windows: 0, budget: 80, milestoneBudget: 80, source: 'milestone', mark: 'at80', ...rest });
  const body = (...issues: object[]) => JSON.stringify({ project: 'r', month: '2026-11', issues, notOnIssue: { usd: 0, partial: false }, milestones: [] });

  it('keeps each issue at a mark, with what it spent and its budget', () => {
    expect(parseBudget(body(row({}), row({ number: 408, usd: 80, mark: 'at100' }), row({ number: 409, usd: 10, mark: null })))).toEqual({
      budgeted: true, marks: [{ issue: 407, mark: 80, spent: 64.2, budget: 80 }, { issue: 408, mark: 100, spent: 80, budget: 80 }],
    });
  });

  it('a project with no budget is an answer: budgeted false, no marks', () => {
    expect(parseBudget(body(row({ budget: null, source: null, mark: null, milestoneBudget: null })))).toEqual({ budgeted: false, marks: [] });
    expect(parseBudget(body())).toEqual({ budgeted: false, marks: [] });
  });

  it('the mark is the server\'s: a row whose mark the plugin would not have worked out is still taken as it came', () => {
    expect(parseBudget(body(row({ usd: 1, mark: 'at100' })))?.marks).toEqual([{ issue: 407, mark: 100, spent: 1, budget: 80 }]);
  });

  it('anything that is not that answer is nothing, so the last answer stays; a malformed row is left out', () => {
    for (const bad of ['', 'not json', '<html>proxy</html>', '[]', 'null', '{}', JSON.stringify({ issues: 'x' })]) expect(parseBudget(bad), bad).toBeUndefined();
    const rows = [row({ number: 0 }), row({ number: 1.5 }), row({ usd: '3' }), row({ budget: 0 }), row({ budget: 'x' }), row({ mark: 'at90' }), row({ mark: 80 }), null];
    for (const r of rows) expect(parseBudget(body(r as object))?.marks, JSON.stringify(r)).toEqual([]);
  });
});

describe('newMarks: a mark absent at the last poll and present now', () => {
  it('the first poll ever is a baseline', () => {
    expect(newMarks(undefined, [mark(407, 80)])).toEqual({ fresh: [], seen: { 407: 80 } });
  });

  it('a new mark alerts; the same mark again does not; going from 80 to 100 alerts for the 100', () => {
    expect(newMarks({}, [mark(407, 80)]).fresh).toEqual([mark(407, 80)]);
    expect(newMarks({ 407: 80 }, [mark(407, 80, 70)]).fresh).toEqual([]);
    expect(newMarks({ 407: 80 }, [mark(407, 100, 80)]).fresh).toEqual([mark(407, 100, 80)]);
  });

  it('only the marks of now are remembered, so an issue whose budget was raised starts again', () => {
    expect(newMarks({ 407: 100 }, [])).toEqual({ fresh: [], seen: {} });
  });

  it('a remembered value that is not a record is no memory at all', () => {
    for (const bad of [null, 'x', 5, [407]]) expect(newMarks(bad, [mark(407, 80)]).fresh, String(bad)).toEqual([]);
  });
});

describe('what an alert says', () => {
  it('a budget: the issue, dollars as whole numbers, the mark and the word estimate', () => {
    expect(budgetNotice(mark(407, 80, 64.2, 80))).toBe('#407: $64 of $80, 80% (estimate)');
    expect(budgetNotice(mark(407, 100, 80.4, 80))).toBe('#407: $80 of $80, 100% (estimate)');
  });

  it('a PR is ready for the owner\'s ok, not merged', () => {
    expect(readyNotice(418)).toBe('PR #418 is ready for your ok');
  });
});

describe('staleAlerts: keys the plugin forgets', () => {
  const NOW = Date.parse('2026-11-30T00:00:00Z');
  it('an alert key sent more than 30 days ago goes; a newer one, and every other key, stays', () => {
    expect(ALERT_KEEP_MS).toBe(30 * 24 * 3600_000);
    const entries: [string, unknown][] = [
      ['alert:ready:r:418:aaa', NOW - ALERT_KEEP_MS - 1], ['alert:budget:r:407:80', NOW - ALERT_KEEP_MS], ['alert:stall:s-1:main:1', NOW - 1000],
      ['machine:sampled', NOW - 99 * ALERT_KEEP_MS], ['goal:r:2026-09', { at80: true }], ['seen:ready:r', []], ['outbox:s-1', { updatedAt: 1, events: [] }],
    ];
    expect(staleAlerts(entries, NOW)).toEqual(['alert:ready:r:418:aaa']);
  });

  it('an alert key that holds no time is not ours to keep; one dated in the future is kept (the clock moved)', () => {
    expect(staleAlerts([['alert:x', 'yes'], ['alert:y', undefined], ['alert:z', NOW + 5 * ALERT_KEEP_MS]], NOW)).toEqual(['alert:x', 'alert:y']);
  });
});
