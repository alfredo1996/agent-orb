import { describe, expect, it } from 'vitest';
import { edgeLabel, edgePath, edgeWidth, isStall, layoutRoles, NODE, ownSpans, recentFirst } from '../src/pipeline-layout.ts';

// The org chart (design/pipeline.html): orchestrator on top, the doers below, reviewers and the unassigned behind.
describe('layoutRoles', () => {
  const roles = ['orchestrator', 'developer', 'reviewer', 'researcher', 'tester', 'planner', 'unassigned'];
  const pos = layoutRoles(roles, 1000);

  it('puts each role in its row, in the mockup order', () => {
    expect(pos.get('orchestrator')!.row).toBe(0);
    expect(['planner', 'researcher', 'developer', 'tester'].map((r) => pos.get(r)!.row)).toEqual([1, 1, 1, 1]);
    expect(['unassigned', 'reviewer'].map((r) => pos.get(r)!.row)).toEqual([2, 2]);
    const row1 = ['planner', 'researcher', 'developer', 'tester'].map((r) => pos.get(r)!.x);
    expect([...row1].sort((a, b) => a - b)).toEqual(row1); // left to right as listed
  });

  it('centres every row and keeps nodes apart and inside the width', () => {
    expect(pos.get('orchestrator')!.x).toBe(500);
    const xs = ['planner', 'researcher', 'developer', 'tester'].map((r) => pos.get(r)!.x);
    expect((xs[0]! + xs[3]!) / 2).toBeCloseTo(500, 6);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(NODE.w + 20);
    for (const p of pos.values()) {
      expect(p.x - NODE.w / 2).toBeGreaterThanOrEqual(0);
      expect(p.x + NODE.w / 2).toBeLessThanOrEqual(1000);
    }
  });

  it('a role it does not know joins the middle row; an empty row leaves no gap', () => {
    const p = layoutRoles(['developer', 'ghostwriter'], 1000);
    expect(p.get('ghostwriter')!.row).toBe(1);
    expect(p.get('developer')!.y).toBe(p.get('ghostwriter')!.y);
    expect(Math.min(...[...p.values()].map((q) => q.y))).toBe(layoutRoles(['orchestrator'], 1000).get('orchestrator')!.y);
  });
});

describe('edgePath and edgeWidth', () => {
  const pos = layoutRoles(['orchestrator', 'planner', 'researcher', 'developer', 'tester', 'reviewer'], 1000);

  it('an edge to the next row runs from the bottom of the parent to the top of the child', () => {
    const o = pos.get('orchestrator')!;
    const d = pos.get('developer')!;
    expect(edgePath(o, d, pos)).toBe(`M${o.x},${o.y + NODE.h} C${o.x},${(o.y + NODE.h + d.y) / 2} ${d.x},${(o.y + NODE.h + d.y) / 2} ${d.x},${d.y}`);
  });

  it('an edge that skips a row passes through the gap nearest the child, not across a node', () => {
    const path = edgePath(pos.get('orchestrator')!, pos.get('reviewer')!, pos);
    const gapX = Number(/^M[\d.]+,[\d.]+ C([\d.]+),/.exec(path)![1]);
    const row1 = ['planner', 'researcher', 'developer', 'tester'].map((r) => pos.get(r)!.x);
    for (const x of row1) expect(Math.abs(gapX - x)).toBeGreaterThan(NODE.w / 2);
  });

  it('thickness grows with the tokens delegated, from 2 to 16', () => {
    expect(edgeWidth(0, 100)).toBe(2);
    expect(edgeWidth(100, 100)).toBe(16);
    expect(edgeWidth(50, 100)).toBe(9);
  });
});

// Redesign step 7: edges fan out along the parent's bottom, labels sit at the child, a lane's solid bar is its own time.
describe('edgePath with fan: edges leave the parent from spread points', () => {
  const pos = layoutRoles(['orchestrator', 'planner', 'researcher', 'developer', 'generalist', 'tester', 'reviewer'], 1000);
  const o = pos.get('orchestrator')!;
  const startX = (to: string) => Number(/^M([\d.-]+),/.exec(edgePath(o, pos.get(to)!, pos, true))![1]);
  const row1 = ['planner', 'researcher', 'developer', 'generalist', 'tester'];

  it('starts toward the child and stays on the parent\'s bottom edge, so the edges do not share one point', () => {
    const xs = row1.map(startX);
    expect(new Set(xs).size).toBe(row1.length);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs); // children left to right, starts left to right
    for (const x of xs) expect(Math.abs(x - o.x)).toBeLessThanOrEqual(NODE.w / 2 - 14);
    expect(startX('developer')).toBe(o.x); // straight below keeps the centre
  });

  it('a child far to the side is clamped to the parent\'s bottom edge', () => {
    const far = { x: o.x + 900, y: pos.get('developer')!.y, row: 1 };
    const x = Number(/^M([\d.-]+),/.exec(edgePath(o, far, pos, true))![1]);
    expect(x).toBe(o.x + NODE.w / 2 - 14);
  });

  it('still ends at the top of the child, and without fan nothing changes', () => {
    const d = pos.get('tester')!;
    expect(edgePath(o, d, pos, true).endsWith(` ${d.x},${d.y}`)).toBe(true);
    expect(edgePath(o, d, pos)).toBe(edgePath(o, d, pos, false));
    expect(edgePath(o, d, pos).startsWith(`M${o.x},${o.y + NODE.h} `)).toBe(true);
  });

  it('the fan applies to an edge that skips a row as well', () => {
    const r = pos.get('reviewer')!;
    const x = Number(/^M([\d.-]+),/.exec(edgePath(pos.get('planner')!, r, pos, true))![1]);
    expect(x).toBeGreaterThan(pos.get('planner')!.x);
  });
});

describe('edgeLabel: the token count sits at the child end of its edge', () => {
  const to = { x: 400, y: 172, row: 1 };
  const parentLeft = { x: 100, y: 10, row: 0 };
  const parentRight = { x: 700, y: 10, row: 0 };

  it('is just above the child, on the side the edge does not come from', () => {
    expect(edgeLabel(parentLeft, to, 0)).toEqual({ x: 410, y: 164, anchor: 'start' });
    expect(edgeLabel(parentRight, to, 0)).toEqual({ x: 390, y: 164, anchor: 'end' });
    expect(edgeLabel({ ...to, y: 10 }, to, 0)).toEqual({ x: 410, y: 164, anchor: 'start' }); // straight above: the right
  });

  it('a second edge into the same child takes the other side, a third stacks above the first', () => {
    expect(edgeLabel(parentLeft, to, 1)).toEqual({ x: 390, y: 164, anchor: 'end' });
    expect(edgeLabel(parentLeft, to, 2)).toEqual({ x: 410, y: 149, anchor: 'start' });
    expect(edgeLabel(parentLeft, to, 3)).toEqual({ x: 390, y: 149, anchor: 'end' });
    expect(edgeLabel(parentRight, to, 1)).toEqual({ x: 410, y: 164, anchor: 'start' });
  });
});

describe('ownSpans: what is left of a turn once its waits are taken out', () => {
  it('a turn with nothing to wait on is one solid bar', () => {
    expect(ownSpans(0, 100, [])).toEqual([[0, 100]]);
    expect(ownSpans(5, 5, [])).toEqual([[5, 5]]);
  });

  it('a wait in the middle splits the turn in two', () => {
    expect(ownSpans(0, 100, [[30, 60]])).toEqual([[0, 30], [60, 100]]);
  });

  it('overlapping and out-of-order waits count once', () => {
    expect(ownSpans(0, 100, [[50, 70], [20, 40], [30, 55]])).toEqual([[0, 20], [70, 100]]);
  });

  it('a wait that starts before the turn, ends after it, or lies outside it is clipped to it', () => {
    expect(ownSpans(10, 100, [[0, 30]])).toEqual([[30, 100]]);
    expect(ownSpans(0, 100, [[80, 500]])).toEqual([[0, 80]]);
    expect(ownSpans(10, 20, [[0, 5], [30, 40]])).toEqual([[10, 20]]);
  });

  it('a wait that covers the whole turn leaves nothing solid', () => {
    expect(ownSpans(10, 20, [[0, 100]])).toEqual([]);
  });
});

describe('isStall: a long tool is a stall, but a long wait on another agent is not', () => {
  it('a tool open for 15 minutes or more stalls its lane', () => {
    expect(isStall('WebFetch', 15 * 60_000)).toBe(true);
    expect(isStall('Bash', 3 * 3_600_000)).toBe(true);
    expect(isStall('WebFetch', 15 * 60_000 - 1)).toBe(false);
  });

  it('a call that hands work to another agent only waits, however long: the stall is in that agent\'s lane', () => {
    for (const tool of ['Agent', 'Task', 'Workflow']) expect(isStall(tool, 40 * 60_000)).toBe(false);
  });
});

describe('roleText and typeText (issue #8)', () => {
  it('says what a role or a type means, and something honest when nothing does', async () => {
    const { roleText, typeText } = await import('../src/pipeline-layout.ts');
    expect(roleText('developer', 'Writes and changes code.')).toBe('Writes and changes code.');
    expect(roleText('unassigned', null)).toBe('No role yet: nothing declares or maps one for these agent types.');
    expect(roleText('mystery', undefined)).toBe('A role with no description.');
    expect(typeText('Builds the change, test first')).toBe('Builds the change, test first');
    expect(typeText(null)).toBe('No description: its file has none, and it is not a built-in type.');
  });
});

// Finding on the role panel: it shows the first five agents, so "first" has to mean the newest, and the API sends the oldest first.
describe('recentFirst: the role panel lists the newest agents first', () => {
  const at = (id: string, started_at: number | null) => ({ id, started_at });

  it('sorts by start time, newest first, and puts an agent with no start time last', () => {
    // The API order: oldest first, an unknown start at the end (the API puts a null start last). A plain reverse would put it first.
    const list = [at('a', 100), at('b', 300), at('c', 200), at('n1', null), at('n2', null)];
    expect(recentFirst(list).map((a) => a.id)).toEqual(['b', 'c', 'a', 'n1', 'n2']);
  });

  it('keeps the given order between agents that started together, and leaves its input alone', () => {
    const list = [at('x', 50), at('y', 50), at('z', 50)];
    const before = [...list];
    expect(recentFirst(list).map((a) => a.id)).toEqual(['x', 'y', 'z']);
    expect(list).toEqual(before);
  });
});
