import { describe, expect, it } from 'vitest';
import { byDay, calledText, layoutSkills, nodeLine, routeEdges, SKILL_NODE } from '../src/skills-layout.ts';

// Slice 5 (design/skills.html): columns by depth along the edges, rows that never overlap, edges that never share a port.
const n = (id: string, kind: 'skill' | 'agent' = 'skill') => ({ id, kind });

describe('layoutSkills', () => {
  it('puts each node one column right of whatever calls or names it', () => {
    const l = layoutSkills([n('code'), n('impl', 'agent'), n('test'), n('pr-body'), n('pr')],
      [{ from: 'code', to: 'impl' }, { from: 'impl', to: 'test' }, { from: 'pr-body', to: 'pr' }, { from: 'pr', to: 'impl' }]);
    const col = (id: string) => l.pos.get(id)!.col;
    expect([col('code'), col('pr-body'), col('pr'), col('impl'), col('test')]).toEqual([0, 0, 1, 2, 3]);
    expect(l.pos.get('impl')!.x).toBeGreaterThan(l.pos.get('pr')!.x);
    expect(l.width).toBeGreaterThanOrEqual(l.pos.get('test')!.x + SKILL_NODE.w);
  });

  it('never stacks two nodes of one column on top of each other; a node with no edges sits in the first column', () => {
    const l = layoutSkills([n('a'), n('b'), n('c'), n('lonely')], [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }]);
    const first = ['a', 'b', 'lonely'].map((id) => l.pos.get(id)!);
    expect(first.every((p) => p.col === 0)).toBe(true);
    const ys = first.map((p) => p.y).sort((x, y) => x - y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(SKILL_NODE.h);
    expect(l.height).toBeGreaterThanOrEqual(ys.at(-1)! + SKILL_NODE.h);
  });

  it('a cycle ends: both nodes placed, in different columns', () => {
    const l = layoutSkills([n('a'), n('b')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]);
    expect(l.pos.get('a')!.col).not.toBe(l.pos.get('b')!.col);
  });
});

describe('layoutSkills spacing', () => {
  it('leaves two columns room between their nodes for the edges to fan out and carry a count', () => {
    const l = layoutSkills([n('a'), n('b', 'agent')], [{ from: 'a', to: 'b' }]);
    expect(l.pos.get('b')!.x - (l.pos.get('a')!.x + SKILL_NODE.w)).toBeGreaterThanOrEqual(120);
  });
});

describe('routeEdges', () => {
  it('two edges into one node arrive at different heights, and their labels too', () => {
    const nodes = [n('code'), n('pr'), n('tr', 'agent')];
    const edges = [{ from: 'code', to: 'tr' }, { from: 'pr', to: 'tr' }];
    const r = routeEdges(edges, layoutSkills(nodes, edges).pos);
    const ends = r.map((e) => Number(e.d.split(' ').at(-1)!.split(',')[1]));
    expect(new Set(ends).size).toBe(2);
    expect(Math.abs(r[0]!.ly - r[1]!.ly)).toBeGreaterThanOrEqual(12);
  });
});

describe('routeEdges around nodes', () => {
  it('an edge that skips a column passes above the node in between instead of through it (a real run, 2026-10-21)', () => {
    const nodes = [n('alpha'), n('scout', 'agent'), n('beta')];
    const edges = [{ from: 'alpha', to: 'scout' }, { from: 'scout', to: 'beta' }, { from: 'alpha', to: 'beta' }];
    const l = layoutSkills(nodes, edges);
    const skip = routeEdges(edges, l.pos).find((e) => e.from === 'alpha' && e.to === 'beta')!;
    const ys = skip.d.match(/-?\d+(\.\d+)?,-?\d+(\.\d+)?/g)!.map((pt) => Number(pt.split(',')[1]));
    expect(Math.min(...ys)).toBeLessThan(l.pos.get('scout')!.y);
  });
});

describe('routeEdges under the nodes', () => {
  it('an edge starts and ends a little inside its nodes, which are drawn over it, so a pill never shows a gap; its count sits just before the target', () => {
    const edges = [{ from: 'a', to: 'b' }];
    const l = layoutSkills([n('a'), n('b', 'agent')], edges);
    const [e] = routeEdges(edges, l.pos);
    const a = l.pos.get('a')!;
    const b = l.pos.get('b')!;
    const xs = e!.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(xs[0]).toBeGreaterThan(a.x);
    expect(xs[0]).toBeLessThan(a.x + SKILL_NODE.w);
    expect(xs.at(-2)).toBeGreaterThan(b.x);
    expect(xs.at(-2)).toBeLessThan(b.x + SKILL_NODE.w);
    expect(e!.lx).toBeLessThan(b.x);
    expect(b.x - e!.lx).toBeLessThanOrEqual(12);
  });
});

describe('nodeLine', () => {
  const skill = { kind: 'skill', ran: true, runs: 2, spawns: 0, tokens: 1_200_000 };
  const agent = { kind: 'agent', ran: true, runs: 0, spawns: 9, tokens: 2_600_000 };
  it('says where a skill comes from and how much it ran', () => {
    expect(nodeLine(skill, 'project')).toBe('project skill · ran 2× · 1.2M');
  });
  it('says a skill that only a text names never ran', () => {
    expect(nodeLine({ ...skill, ran: false, runs: 0, tokens: 0 }, 'user')).toBe('user skill · never ran');
  });
  it('says how often an agent type was spawned, and that a named one never was', () => {
    expect(nodeLine(agent, 'project')).toBe('spawned 9× · 2.6M');
    expect(nodeLine({ ...agent, ran: false, spawns: 0, tokens: 0 }, 'project')).toBe('named, never spawned');
  });
});

describe('calledText', () => {
  const name = (id: string) => id.toUpperCase();
  it('lists what it called, most first, then what its text only names', () => {
    expect(calledText([{ to: 'b', did: 1 }, { to: 'c', did: 0 }, { to: 'a', did: 2 }, { to: 'd', did: 0 }], name)).toBe('A 2× · B 1× · named: C, D');
  });
  it('is empty when it called nothing and names nothing', () => {
    expect(calledText([], name)).toBe('');
  });
  it('says only what its text names when it called nothing', () => {
    expect(calledText([{ to: 'r', did: 0 }], name)).toBe('named: R');
  });
});

describe('byDay', () => {
  it('counts loads per local day over the last 7, oldest first, leaving out older ones', () => {
    const to = new Date(2026, 9, 21, 15).getTime();
    const at = (day: number, h = 10) => new Date(2026, 9, day, h).getTime();
    expect(byDay([at(21), at(21, 1), at(19), at(15), at(14)], to)).toEqual([1, 0, 0, 0, 1, 0, 2]);
  });
});
