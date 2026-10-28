import { tokens } from './format.ts';
import { dayKeys } from './ledger-math.ts';

// The Skills graph's geometry (design/pages.html): a column per depth along the edges, rows top-down. Pure, for tests.

export const SKILL_NODE = { w: 176, h: 58 };
const PITCH_X = 440; // the mock's: 264px between two columns, room for edges to fan out and a count at the target
const PITCH_Y = 90;
const TOP = 30; // room for the column headings
const PORT = 14; // between two edges that meet at one side of a node
const TUCK = 12; // an edge runs this far under its nodes (the SVG is drawn beneath them), so a pill's round end never shows a gap

export type Pos = { x: number; y: number; col: number };

/** Each node one column right of the deepest node that calls or names it; a cycle stops at the node count. */
export function layoutSkills(nodes: { id: string; kind: string }[], edges: { from: string; to: string }[]) {
  const depth = new Map(nodes.map((nd) => [nd.id, 0]));
  const max = Math.max(0, nodes.length - 1);
  for (let changed = true; changed;) {
    changed = false;
    for (const e of edges) {
      const d = (depth.get(e.from) ?? 0) + 1;
      if (e.from !== e.to && depth.has(e.to) && d <= max && d > depth.get(e.to)!) {
        depth.set(e.to, d);
        changed = true;
      }
    }
  }
  const rows: number[] = [];
  const pos = new Map<string, Pos>();
  for (const nd of nodes) {
    const col = depth.get(nd.id)!;
    const row = rows[col] ?? 0;
    rows[col] = row + 1;
    pos.set(nd.id, { x: col * PITCH_X, y: TOP + row * PITCH_Y, col });
  }
  const cols = rows.length;
  return {
    pos, cols: Array.from({ length: cols }, (_, c) => c * PITCH_X),
    width: Math.max(0, cols - 1) * PITCH_X + SKILL_NODE.w,
    height: TOP + Math.max(1, ...rows) * PITCH_Y - (PITCH_Y - SKILL_NODE.h) + 12,
  };
}

/**
 * Edges from a node's right side to the next column's left side. Where several meet at one side, they are spread by
 * the height of their other end, so no two share a point or a label.
 */
export function routeEdges<E extends { from: string; to: string }>(edges: E[], pos: Map<string, Pos>) {
  const spread = (side: 'from' | 'to', other: 'from' | 'to') => {
    const off = new Map<E, number>();
    const groups = new Map<string, E[]>();
    for (const e of edges) groups.set(e[side], [...(groups.get(e[side]) ?? []), e]);
    for (const list of groups.values()) {
      const sorted = [...list].sort((a, b) => (pos.get(a[other])?.y ?? 0) - (pos.get(b[other])?.y ?? 0));
      sorted.forEach((e, i) => off.set(e, (i - (sorted.length - 1) / 2) * PORT));
    }
    return off;
  };
  const out = spread('from', 'to');
  const into = spread('to', 'from');
  return edges.filter((e) => pos.has(e.from) && pos.has(e.to)).map((e) => {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    if (b.col <= a.col) {
      // ponytail: a back edge (a cycle) loops out to the right; rare enough not to route around nodes.
      const [x1, y1, x2, y2] = [a.x + SKILL_NODE.w - TUCK, a.y + SKILL_NODE.h / 2 + out.get(e)!, b.x + SKILL_NODE.w - TUCK, b.y + SKILL_NODE.h / 2 + into.get(e)!];
      return { ...e, d: `M${x1},${y1} C${x1 + 40},${y1} ${x2 + 40},${y2} ${x2},${y2}`, lx: x2 + TUCK + 30, ly: y2 };
    }
    const [x1, y1, x2, y2] = [a.x + SKILL_NODE.w - TUCK, a.y + SKILL_NODE.h / 2 + out.get(e)!, b.x + TUCK, b.y + SKILL_NODE.h / 2 + into.get(e)!];
    // The count sits on its own edge at the target's end, just before the node, so two edges into one node keep their counts apart.
    const [lx, ly] = [b.x - 8, y2];
    // An edge that skips a column would cross a node there: it rises above the highest one in its way and runs across.
    const lo = Math.min(y1, y2) - 6;
    const hi = Math.max(y1, y2) + 6;
    const inWay = [...pos.values()].filter((p) => p.col > a.col && p.col < b.col && p.y < hi && p.y + SKILL_NODE.h > lo);
    if (inWay.length) {
      const yc = Math.min(...inWay.map((p) => p.y)) - 10;
      return { ...e, d: `M${x1},${y1} C${x1 + 30},${y1} ${x1 + 30},${yc} ${x1 + 60},${yc} L${x2 - 60},${yc} C${x2 - 30},${yc} ${x2 - 30},${y2} ${x2},${y2}`, lx, ly };
    }
    const dx = Math.max(30, (x2 - x1) / 2);
    return { ...e, d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, lx, ly };
  });
}

/** The one muted line under a node's name: where a skill comes from and how much it ran, or how often an agent type was spawned. */
export function nodeLine(n: { kind: string; ran: boolean; runs: number; spawns: number; tokens: number }, origin: string) {
  if (n.kind === 'agent') return n.spawns ? `spawned ${n.spawns}× · ${tokens(n.tokens)}` : 'named, never spawned';
  return n.ran ? `${origin} skill · ran ${n.runs}× · ${tokens(n.tokens)}` : `${origin} skill · never ran`;
}

/** What a node called, as the phone's list says it: "implementer 2× · general-purpose 1× · named: reviewer". */
export function calledText(out: { to: string; did: number }[], name: (id: string) => string) {
  const did = out.filter((e) => e.did).sort((a, b) => b.did - a.did).map((e) => `${name(e.to)} ${e.did}×`);
  const named = out.filter((e) => !e.did).map((e) => name(e.to));
  return [...did, ...(named.length ? [`named: ${named.join(', ')}`] : [])].join(' · ');
}

/** How many loads fell on each of the last `days` local days up to `to`, oldest first. */
export function byDay(loads: number[], to: number, days = 7) {
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));
  const keys = dayKeys(from.getTime(), to);
  const local = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const count = new Map<string, number>();
  for (const ts of loads) count.set(local(ts), (count.get(local(ts)) ?? 0) + 1);
  return keys.map((k) => count.get(k) ?? 0);
}
