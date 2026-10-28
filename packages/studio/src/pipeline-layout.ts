// The org chart's geometry (design/pages.html), kept pure for tests.
// Rows (§7): the orchestrator on top, the doers below, reviewers and the unassigned behind.

import { DELEGATES } from './live-cards.ts';

export type Pos = { x: number; y: number; row: number };
export const NODE = { w: 190, h: 94 };
const ROWS = [
  ['orchestrator'],
  ['planner', 'researcher', 'consultant', 'developer', 'generalist', 'tester'],
  ['unassigned', 'reviewer', 'skeptic', 'writer', 'ops'],
];
const STEP = 230; // centre to centre in a row
const TOP = 10;
const ROW_H = 160;

const rowOf = (role: string) => {
  const i = ROWS.findIndex((r) => r.includes(role));
  return i < 0 ? 1 : i; // a role nobody listed joins the doers
};
const order = (role: string) => {
  const i = ROWS[rowOf(role)]!.indexOf(role);
  return i < 0 ? 99 : i;
};

/** Each role's centre x and top y; rows are centred in `width` (the chart widens if a row needs more). */
export function layoutRoles(roles: string[], width = 1000): Map<string, Pos> {
  const rows = new Map<number, string[]>();
  for (const r of [...roles].sort((a, b) => order(a) - order(b))) rows.set(rowOf(r), [...(rows.get(rowOf(r)) ?? []), r]);
  const widest = Math.max(1, ...[...rows.values()].map((r) => r.length));
  const w = Math.max(width, widest * STEP + 40);
  const out = new Map<string, Pos>();
  [...rows.keys()].sort().forEach((row, k) => {
    const list = rows.get(row)!;
    const span = (list.length - 1) * STEP;
    list.forEach((role, i) => out.set(role, { x: w / 2 - span / 2 + i * STEP, y: TOP + k * ROW_H, row }));
  });
  return out;
}

/** Where `fan` makes an edge leave its parent: 22% of the way toward the child, kept 14px inside the parent's bottom corners. */
const fanX = (from: Pos, to: Pos) => from.x + Math.max(14 - NODE.w / 2, Math.min(NODE.w / 2 - 14, (to.x - from.x) * 0.22));

/**
 * From the parent's bottom to the child's top; across a row in between, through the gap nearest the child.
 * With `fan` the edge leaves the parent from a point toward its child, so a parent's edges spread along its bottom instead of sharing one.
 */
export function edgePath(from: Pos, to: Pos, all: Map<string, Pos>, fan = false) {
  const x1 = fan ? fanX(from, to) : from.x;
  const y1 = from.y + NODE.h;
  if (to.y <= from.y) {
    // same row or upwards (rare): a loop under both nodes, bottom to bottom
    const y = Math.max(from.y, to.y) + NODE.h;
    return `M${x1},${y1} C${x1},${y + 60} ${to.x},${y + 60} ${to.x},${to.y + NODE.h}`;
  }
  const between = [...all.values()].filter((p) => p.y > from.y && p.y < to.y);
  if (!between.length) {
    const mid = (y1 + to.y) / 2;
    return `M${x1},${y1} C${x1},${mid} ${to.x},${mid} ${to.x},${to.y}`;
  }
  const xs = between.map((p) => p.x).sort((a, b) => a - b);
  const gaps = [xs[0]! - NODE.w / 2 - 20, ...xs.slice(1).map((x, i) => (x + xs[i]!) / 2), xs.at(-1)! + NODE.w / 2 + 20];
  const g = gaps.reduce((best, x) => (Math.abs(x - to.x) < Math.abs(best - to.x) ? x : best));
  return `M${x1},${y1} C${g},${y1 + 50} ${g},${to.y - 50} ${to.x},${to.y}`;
}

export const edgeWidth = (tokens: number, max: number) => (max > 0 ? 2 + 14 * (tokens / max) : 2);

/**
 * The token label at the child end of an edge: just above the child, on the side the edge does not come from, so it never sits on the stroke.
 * The k-th edge into one child takes the other side, then stacks.
 */
export function edgeLabel(from: Pos, to: Pos, k: number) {
  const left = (from.x > to.x) !== (k % 2 === 1);
  return { x: to.x + (left ? -10 : 10), y: to.y - 8 - 15 * Math.floor(k / 2), anchor: left ? ('end' as const) : ('start' as const) };
}

const LONG_TOOL_MS = 15 * 60_000; // the stall threshold's default (§8.1)

/** A tool open this long is a stall, unless it hands work to another agent: that lane is then waiting, and the stall shows in the agent's own lane. */
export const isStall = (tool: string, ms: number) => ms >= LONG_TOOL_MS && !DELEGATES.has(tool);

/** A turn's own time: [from, to] less the spans spent waiting on a tool or an agent (the thin bars), each wait counted once. */
export function ownSpans(from: number, to: number, waits: [number, number][]): [number, number][] {
  if (!waits.length) return [[from, to]];
  const out: [number, number][] = [];
  let at = from;
  for (const [a, b] of [...waits].sort((x, y) => x[0] - y[0])) {
    if (a > at) out.push([at, Math.min(a, to)]);
    at = Math.max(at, b);
    if (at >= to) break;
  }
  if (at < to) out.push([at, to]);
  return out;
}

// Issue #8: the line under a role or an agent type, with an honest fallback when nothing describes it.
export const roleText = (role: string, info?: string | null) =>
  role === 'unassigned' ? 'No role yet: nothing declares or maps one for these agent types.' : info ?? 'A role with no description.';
export const typeText = (info?: string | null) => info ?? 'No description: its file has none, and it is not a built-in type.';

/** The role panel lists the newest agents first (the API sends them oldest first); one with no start time goes last. */
export const recentFirst = <T extends { started_at: number | null }>(list: T[]): T[] =>
  [...list].sort((a, b) => (a.started_at === null ? 1 : 0) - (b.started_at === null ? 1 : 0) || (b.started_at ?? 0) - (a.started_at ?? 0));
