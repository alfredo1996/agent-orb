// The Map's geometry (v0.5 slice 1, #66; design/home-issue.html, the Map board): a column per stage, the issues of a stage top to bottom, and the lines between them. Pure, for tests.
// A card moves only when its stage does: its row is its place by number among the issues of its stage, so a refresh, a new link or a pressed card never moves it.
// The cards are HTML over an SVG layer (as on Pipeline and Skills), so a line is drawn under them: it leaves and reaches a card on its border, and turns in the gap between two rows,
// the one band no card is ever in. A file's name sits in that gap too, on its line. The cards of one row are tied by arcs under it, deeper the further apart the two are, so they nest.
// ponytail: nothing keeps a line from passing behind a card that sits between its two ends (rows more than one apart). Upgrade: order each column by the rows of its neighbours.

export const MAP_NODE = { w: 152, h: 76 };
const COL = 168; // a column: the card and 16px to the next
const ROW = 140; // a row: the card and a 64px gap under it (the mockup's 36px held its hand-placed lines; arcs that nest and their names need more)
const GAP = ROW - MAP_NODE.h;
const LEFT = 8;
const TOP = 34; // room for the column headings
const PORT = 24; // between two lines that meet one side of a card
const DIP = [18, 78]; // how far a line between two cards of one row is pulled into the gap under them (it reaches three quarters of it): neighbours least, the far ends of the row most
const BULGE = 28; // and how far out one between two cards of one column, rows apart, is pulled to the right
const CHAR = 7.3; // a 12px monospace character
const LINE = 14; // a name's height, and how far one moves to clear another
const TAIL_MAX = 24;

export type MapPos = { x: number; y: number; col: number; row: number };
export type MapLink = { a: number; b: number; kind: 'file' | 'mention'; files?: string[]; together?: boolean };
/** A file's name on its line: where its text is anchored (`y` is its baseline) and `w`, how wide it is taken to be. */
export type MapLabel = { x: number; y: number; w: number; text: string; anchor: 'middle' | 'start' };
export type MapEdge<L> = { link: L; d: string; label?: MapLabel };

/** A path by its end, short enough for a line: its last two parts, the name alone when those are long, and a long name cut. The list under the map has the path whole. */
export function fileTail(path: string) {
  const parts = path.split('/');
  const two = parts.slice(-2).join('/');
  const name = parts.at(-1)!;
  return two.length <= TAIL_MAX ? two : name.length <= TAIL_MAX ? name : `${name.slice(0, TAIL_MAX - 1)}…`;
}

const round = (n: number) => Math.round(n * 10) / 10;
const bezier = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};
/** Where a curve that only goes down crosses the height `y`: its parameter, by halving. */
const crossing = (y0: number, y1: number, y2: number, y3: number, y: number) => {
  let [lo, hi] = [0, 1];
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    if (bezier(y0, y1, y2, y3, mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

type Side = 'top' | 'bottom' | 'right';
type Shape = 'under' | 'down' | 'side';

/**
 * The map of `issues` (each in the column of its stage, `stages` in order) and `links` (those whose two ends are on it). A line runs from the bottom of the upper card to the top of the lower
 * one; under both when they share a row; out to the right when they share a column, rows apart. Lines that meet one side of a card each get their own point on it. A file link's line names
 * its first file where the gap has room: the pressed card's lines first (`picked`), then the ones in flight together, then the rest, and a name that would run into another is left out.
 */
export function layoutMap<L extends MapLink>(stages: readonly string[], issues: readonly { number: number; stage: string }[], links: readonly L[], picked?: number) {
  const pos = new Map<number, MapPos>();
  const rows = stages.map(() => 0);
  for (const i of issues.toSorted((a, b) => a.number - b.number)) {
    const col = stages.indexOf(i.stage);
    if (col < 0 || pos.has(i.number)) continue;
    const row = rows[col]!++;
    pos.set(i.number, { x: LEFT + COL * col, y: TOP + ROW * row, col, row });
  }
  const width = LEFT * 2 + COL * (stages.length - 1) + MAP_NODE.w;
  const last = Math.max(1, ...rows) - 1;

  // Each line: its two ends, upper (or left) first, and its shape.
  const drawn = links.filter((l) => l.a !== l.b && pos.has(l.a) && pos.has(l.b)).map((link) => {
    const [a, b] = [pos.get(link.a)!, pos.get(link.b)!];
    const [u, l] = a.row < b.row || (a.row === b.row && a.x <= b.x) ? [a, b] : [b, a];
    const shape: Shape = u.row === l.row ? 'under' : u.col === l.col && l.row - u.row > 1 ? 'side' : 'down';
    const sides: [Side, Side] = shape === 'under' ? ['bottom', 'bottom'] : shape === 'side' ? ['right', 'right'] : ['bottom', 'top'];
    return { link, u, l, shape, sides, at: [0, 0] as [number, number] };
  });

  // The lines at one side of a card, spread along it in the order of where each goes, so no two share a point and neighbours do not cross at the card.
  const meet = new Map<string, { e: (typeof drawn)[number]; end: 0 | 1; other: MapPos }[]>();
  for (const e of drawn) {
    for (const end of [0, 1] as const) {
      const [node, other] = end === 0 ? [e.u, e.l] : [e.l, e.u];
      const key = `${node.col}:${node.row}:${e.sides[end]}`;
      meet.set(key, [...(meet.get(key) ?? []), { e, end, other }]);
    }
  }
  for (const [key, list] of meet) {
    const upright = key.endsWith('right');
    const room = (upright ? MAP_NODE.h : MAP_NODE.w) - 24;
    const step = Math.min(PORT, room / Math.max(1, list.length - 1));
    list.sort((p, q) => (upright ? p.other.y - q.other.y || p.other.x - q.other.x : p.other.x - q.other.x || p.other.y - q.other.y));
    list.forEach((p, i) => (p.e.at[p.end] = (i - (list.length - 1) / 2) * step));
  }

  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const gapTop = (row: number) => TOP + ROW * row + MAP_NODE.h;
  const labels = new Map<(typeof drawn)[number], MapLabel>();
  const edges = drawn.map((e) => {
    const { u, l, shape } = e;
    if (shape === 'under') {
      const [x1, x2, y] = [u.x + MAP_NODE.w / 2 + e.at[0], l.x + MAP_NODE.w / 2 + e.at[1], u.y + MAP_NODE.h];
      const dip = DIP[0]! + ((DIP[1]! - DIP[0]!) * (l.col - u.col - 1)) / Math.max(1, stages.length - 2);
      return { e, d: `M${round(x1)},${y} C${round(x1)},${round(y + dip)} ${round(x2)},${round(y + dip)} ${round(x2)},${y}`, gap: u.row, x: (x1 + x2) / 2, y: y + 0.75 * dip, anchor: 'middle' as const };
    }
    const middle = gapTop(l.row - 1) + GAP / 2; // the gap just above the lower card: where the name goes
    if (shape === 'side') {
      const [x, y1, y2] = [u.x + MAP_NODE.w, u.y + MAP_NODE.h / 2 + e.at[0], l.y + MAP_NODE.h / 2 + e.at[1]];
      const t = crossing(y1, y1, y2, y2, middle);
      return { e, d: `M${x},${round(y1)} C${x + BULGE},${round(y1)} ${x + BULGE},${round(y2)} ${x},${round(y2)}`, gap: l.row - 1, x: bezier(x, x + BULGE, x + BULGE, x, t) + 6, y: middle, anchor: 'start' as const };
    }
    const [x1, y1, x2, y2] = [u.x + MAP_NODE.w / 2 + e.at[0], u.y + MAP_NODE.h, l.x + MAP_NODE.w / 2 + e.at[1], l.y];
    const mid = (y1 + y2) / 2;
    const t = crossing(y1, mid, mid, y2, middle);
    return { e, d: `M${round(x1)},${y1} C${round(x1)},${mid} ${round(x2)},${mid} ${round(x2)},${y2}`, gap: l.row - 1, x: bezier(x1, x1, x2, x2, t), y: middle, anchor: 'middle' as const };
  });

  // The names, the ones that matter most first. A name sits on its line, where the line is lowest in the gap (an arc) or crosses the gap's middle; if another name is there it moves a line
  // down, then up, and if neither is free or still in the gap, the line goes unnamed: the list under the map has every file.
  const rank = (l: MapLink) => (picked !== undefined && (l.a === picked || l.b === picked) ? 0 : l.together ? 1 : 2);
  for (const g of edges.filter((x) => x.e.link.kind === 'file' && x.e.link.files?.length).toSorted((p, q) => rank(p.e.link) - rank(q.e.link))) {
    const text = fileTail(g.e.link.files![0]!);
    const w = text.length * CHAR;
    const x0 = Math.max(4, Math.min(width - 4 - w, g.anchor === 'middle' ? g.x - w / 2 : g.x));
    const top = gapTop(g.gap);
    const y = [0, LINE, -LINE, 2 * LINE, -2 * LINE].map((dy) => g.y + 4 + dy) // the baseline: the text's middle on the line
      .find((base) => base - 11 >= top + 2 && base + 3 <= top + GAP - 2 && !placed.some((p) => x0 < p.x1 + 8 && p.x0 < x0 + w + 8 && base - 11 < p.y1 && p.y0 < base + 3));
    if (y === undefined) continue;
    placed.push({ x0, x1: x0 + w, y0: y - 11, y1: y + 3 });
    labels.set(g.e, { x: round(g.anchor === 'middle' ? x0 + w / 2 : x0), y: round(y), w: round(w), text, anchor: g.anchor });
  }

  // The gap under the last row is there only when a line needs it: two cards of that row tied to each other.
  const height = TOP + ROW * last + MAP_NODE.h + (drawn.some((e) => e.shape === 'under' && e.u.row === last) ? GAP : 12);
  return {
    width, height, pos,
    cols: stages.map((_, c) => ({ x: LEFT + COL * c, count: rows[c]! })),
    edges: edges.map(({ e, d }): MapEdge<L> => ({ link: e.link, d, ...(labels.has(e) ? { label: labels.get(e)! } : {}) })),
  };
}
