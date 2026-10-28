import { describe, expect, it } from 'vitest';
import { checkStalls, goalNotice, monthName, newTracker, parseGoal, statusText, usd, type Goal, type Tracker } from '../hooks/core.ts';

// v0.2 slice 3 (PROJECT.md §15, 2026-10-24): the monthly goal in API-equivalent dollars per project. Nothing is stopped;
// the status line shows it from 80% and says so past 100%; each state sends one notification.
const MIN = 60_000;
const tracker = (): Tracker => {
  const t = newTracker();
  t.agents.set('main', { key: 'main', label: 'main', inTurn: true, lastTs: 0, done: false, tokens: 1_200_000 });
  t.agents.set('a1', { key: 'a1', label: 'Explore', inTurn: true, lastTs: 0, done: false, tokens: 0 });
  return t;
};
const goal = (spent: number, goalUsd = 2500, month = '2026-10'): Goal => ({ project: 'mobile-app', month, goal: goalUsd, spent });

describe('usd and monthName', () => {
  it('whole dollars with thousands separators, rounded', () => {
    expect(usd(0)).toBe('$0');
    expect(usd(999.4)).toBe('$999');
    expect(usd(999.5)).toBe('$1,000');
    expect(usd(2540.4)).toBe('$2,540');
    expect(usd(1_000_000)).toBe('$1,000,000');
  });

  it('names the month from YYYY-MM', () => {
    expect(monthName('2026-01')).toBe('January');
    expect(monthName('2026-10')).toBe('October');
    expect(monthName('2026-12')).toBe('December');
  });
});

describe('parseGoal', () => {
  const answer = (o: object) => JSON.stringify({ project: 'mobile-app', month: '2026-10', goal: 2500, spent: 2029.4, costPartial: false, ...o });

  it('reads the server\'s answer for the project', () => {
    expect(parseGoal('mobile-app', answer({}))).toEqual({ goal: { project: 'mobile-app', month: '2026-10', goal: 2500, spent: 2029.4 } });
  });

  it('no goal set is an answer too: it clears the last one', () => {
    expect(parseGoal('mobile-app', answer({ goal: null, spent: 12 }))).toEqual({ goal: null });
  });

  it('anything that is not that answer is nothing, so the last answer stays', () => {
    for (const bad of ['', 'not json', '<html>proxy</html>', '[]', 'null', '{}', answer({ month: 'October' }), answer({ month: '2026-13' }), answer({ month: '2026-00' }),
      answer({ goal: 0 }), answer({ goal: -5 }), answer({ goal: '2500' }), '{"month":"2026-10","goal":1e999,"spent":1}', answer({ spent: -1 }), answer({ spent: '3' }), answer({ spent: null })]) {
      expect(parseGoal('mobile-app', bad), bad).toBeUndefined();
    }
  });
});

describe('statusText with a goal', () => {
  it('below 80% the line is the normal one, and so it is without a goal', () => {
    expect(statusText(tracker(), 41, 0, goal(1999))).toBe('👥 2 · 1.2M tok · ctx 41%');
    expect(statusText(tracker(), 41, 0, undefined)).toBe('👥 2 · 1.2M tok · ctx 41%');
  });

  it('from 80% it ends with the month\'s short name and a rounded percentage', () => {
    expect(statusText(tracker(), 41, 0, goal(2029))).toBe('👥 2 · 1.2M tok · ctx 41% · Oct 81%');
    expect(statusText(tracker(), 41, 0, goal(2000))).toBe('👥 2 · 1.2M tok · ctx 41% · Oct 80%'); // exactly 80%
    expect(statusText(tracker(), 41, 0, goal(2499.9))).toBe('👥 2 · 1.2M tok · ctx 41% · Oct 100%'); // still not past it
    expect(statusText(tracker(), 41, 0, goal(2500))).toBe('👥 2 · 1.2M tok · ctx 41% · Oct 100%');
    expect(statusText(tracker(), 41, 0, goal(56, 70, '2026-09'))).toBe('👥 2 · 1.2M tok · ctx 41% · Sep 80%');
    expect(statusText(tracker(), undefined, 0, goal(2029))).toBe('👥 2 · 1.2M tok · Oct 81%'); // no context figure yet
  });

  it('the 80% edge does not drift with floating point', () => {
    expect(statusText(tracker(), 41, 0, goal(2.4, 3))).toMatch(/ · Oct 80%$/);
    expect(statusText(tracker(), 41, 0, goal(2.39, 3))).not.toMatch(/Oct/);
  });

  it('past 100% the line says so, in whole dollars, with the project and the month', () => {
    expect(statusText(tracker(), 41, 0, goal(2540.3))).toBe('⚠ mobile-app over its October goal: $2,540 of $2,500');
    expect(statusText(tracker(), 41, 0, { ...goal(1300), goal: 1000, project: 'agent-orb', month: '2026-05' })).toBe('⚠ agent-orb over its May goal: $1,300 of $1,000');
  });

  it('ranks after a stall and after a pricier model', () => {
    const t = tracker();
    t.agents.get('a1')!.pricier = { who: 'implementer', used: 'opus', allowed: 'sonnet', source: 'file' };
    t.tools.set('toolu_1', { id: 'toolu_1', tool: 'WebFetch', agent: 'a1', since: 0, waiting: false });
    checkStalls(t, 16 * MIN, 15 * MIN);
    expect(statusText(t, 41, 16 * MIN, goal(2540))).toBe('⚠ Explore: WebFetch 16m'); // a stall first
    t.tools.delete('toolu_1');
    for (const a of t.agents.values()) a.lastTs = 17 * MIN; // events again: no agent is silent
    checkStalls(t, 17 * MIN, 15 * MIN);
    expect(statusText(t, 41, 17 * MIN, goal(2540))).toBe('⚠ implementer on Opus, file says Sonnet'); // then a pricier model
    t.agents.get('a1')!.done = true;
    expect(statusText(t, 41, 17 * MIN, goal(2540))).toBe('⚠ mobile-app over its October goal: $2,540 of $2,500'); // then the goal
  });
});

describe('goalNotice: one notification per state, per project and month', () => {
  it('at 80%: names the percentage, the month and the dollars', () => {
    expect(goalNotice(goal(2029), {})).toEqual({ text: 'mobile-app is at 81% of its October goal ($2,029 of $2,500)', sent: { at80: true } });
  });

  it('past 100%: says it is over', () => {
    expect(goalNotice(goal(2540), { at80: true })).toEqual({ text: 'mobile-app is over its October goal: $2,540 of $2,500', sent: { at80: true, over: true } });
  });

  it('below 80% sends nothing', () => {
    expect(goalNotice(goal(1999), {})).toEqual({ sent: {} });
  });

  it('each state is sent once: a repeat of the same answer, or a later one in the same state, sends nothing', () => {
    expect(goalNotice(goal(2029), { at80: true })).toEqual({ sent: { at80: true } });
    expect(goalNotice(goal(2300), { at80: true })).toEqual({ sent: { at80: true } });
    expect(goalNotice(goal(2540), { at80: true, over: true })).toEqual({ sent: { at80: true, over: true } });
  });

  it('first seen already over: the over notice only, and the 80% one is not sent after it', () => {
    const n = goalNotice(goal(2540), {});
    expect(n.text).toBe('mobile-app is over its October goal: $2,540 of $2,500');
    expect(goalNotice(goal(2540), n.sent)).toEqual({ sent: { at80: true, over: true } });
  });

  it('exactly the goal is at 100%, not over', () => {
    expect(goalNotice(goal(2500), {}).text).toBe('mobile-app is at 100% of its October goal ($2,500 of $2,500)');
  });
});
