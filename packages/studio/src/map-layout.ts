// The Map's geometry (v0.5 slice 1, #66; design/home-issue.html, the Map board): a column per stage, the issues of a stage top to bottom, and the lines between them. Pure, for tests.
// A card moves only when its stage does: its row comes from its column and its place by number among the issues of its stage, so a refresh, a new link or a pressed card never moves it.
// #70: the rows alternate by column, as the mockup's hand-placed cards do. A stage's first issue sits on row 0 in an even column (Queued, Reviewing, Gate, Merged) and on row 1 in an odd one
// (Building, Fixing, Ready), and each further issue two rows down. So two neighbouring stages are a row apart, and the line between them crosses one gap instead of running along it.
// The cards are HTML over an SVG layer (as on Pipeline and Skills), so a line is drawn under them: it leaves and reaches a card on its border, and turns in the gap between two rows,
// the one band no card is ever in. A file's name sits in that gap too, on its line. The cards of one row are tied by arcs under it, deeper the further apart the two are, so they nest.
// A line between cards rows apart (two cards of one column always are) would cross the rows between them, where cards sit: it runs down the lane between two columns instead, the other
// band no card is in, and turns into the gaps at either end. So no line passes behind a card.
// ponytail: the lane is the one beside the upper card, toward the lower; lines that share a lane are spread across its middle 12px, a stroke apart up to five of them, and closer past that
// (the centre 12px keep a line clear of the card's focus outline). Upgrade: pick the emptier lane, or spill into the one on the other side of the upper card.

export const MAP_NODE = { w: 152, h: 76 };
const LANE = 24; // between two columns: room for three lines that run down it (the mockup's 16px held none); the canvas is 1240px wide (1196 before #70, the mockup's 1176)
const COL = MAP_NODE.w + LANE;
const ROW = 140; // a row: the card and a 64px gap under it (the mockup's 36px held its hand-placed lines; arcs that nest and their names need more)
const GAP = ROW - MAP_NODE.h;
const LEFT = 8;
const TOP = 34; // room for the column headings
const PORT = 24; // between two lines that meet one side of a card
const DIP = [18, 64]; // how far a line between two cards of one row is pulled into the gap under them (it reaches three quarters of it): neighbours least, the far ends of the row most
const DEEPER = 14; // a second line between the same two cards dips this much more, so it nests round the first (two issues have at most two links: a file and a mention)
const STEP = 6; // between two lines that share a lane, and the whole spread of them is LANE - 12: the line on its edge is then 6px from a card, clear of its focus outline (2 to 4px)
const CHAR = 7.3; // a 12px monospace character
const LINE = 14; // a name's height, and how far one moves to clear another
const TAIL_MAX = 24;

export type MapPos = { x: number; y: number; col: number; row: number };
export type MapLink = { a: number; b: number; kind: 'file' | 'mention'; files?: string[]; together?: boolean };
/** A file's name on its line: the middle of its text (`y` is its baseline) and `w`, how wide it is taken to be. */
export type MapLabel = { x: number; y: number; w: number; text: string };
export type MapEdge<L> = { link: L; d: string; label?: MapLabel };

/** A path by its end, short enough for a line: its last two parts, the name alone when those are long, and a long name cut. The list under the map has the path whole. */
export function fileTail(path: string) {
  const parts = path.split('/');
  const two = parts.slice(-2).join('/');
  const name = parts.at(-1)!;
  return two.length <= TAIL_MAX ? two : name.length <= TAIL_MAX ? name : `${name.slice(0, TAIL_MAX - 1)}…`;
}

const round = (n: number) => Math.round(n * 10) / 10;

type Side = 'top' | 'bottom';
type Shape = 'under' | 'down' | 'lane';

/**
 * The map of `issues` (each in the column of its stage, `stages` in order) and `links` (those whose two ends are on it). A line runs from the bottom of the upper card to the top of the lower
 * one; under both when they share a row; down a lane between two columns when they are rows apart. Lines that meet one side of a card each get their own point on it. A file link's line names
 * its first file where the gap has room: the pressed card's lines first (`picked`), then the ones in flight together, then the rest, and a name that would run into another is left out.
 */
export function layoutMap<L extends MapLink>(stages: readonly string[], issues: readonly { number: number; stage: string }[], links: readonly L[], picked?: number) {
  const pos = new Map<number, MapPos>();
  const counts = stages.map(() => 0);
  for (const i of issues.toSorted((a, b) => a.number - b.number)) {
    const col = stages.indexOf(i.stage);
    if (col < 0 || pos.has(i.number)) continue;
    const row = (col % 2) + 2 * counts[col]!++;
    pos.set(i.number, { x: LEFT + COL * col, y: TOP + ROW * row, col, row });
  }
  const width = LEFT + COL * (stages.length - 1) + MAP_NODE.w + LANE; // a lane right of the last column too, for a line between two of its cards (whether or not there is one, so a card never moves)
  const last = Math.max(0, ...[...pos.values()].map((p) => p.row));
  const laneX = (lane: number) => LEFT + COL * lane + MAP_NODE.w + LANE / 2; // the middle of the lane right of column `lane`

  const tied = new Map<string, number>();
  // Each line: its two ends, upper (or left) first, its shape, and for one rows apart the lane it runs down: beside the upper card, toward the lower one (right of it in its own column).
  const drawn = links.filter((l) => l.a !== l.b && pos.has(l.a) && pos.has(l.b)).map((link) => {
    const [a, b] = [pos.get(link.a)!, pos.get(link.b)!];
    const [u, l] = a.row < b.row || (a.row === b.row && a.x <= b.x) ? [a, b] : [b, a];
    const shape: Shape = u.row === l.row ? 'under' : l.row - u.row === 1 ? 'down' : 'lane';
    const lane = l.col < u.col ? u.col - 1 : u.col;
    const sides: [Side, Side] = shape === 'under' ? ['bottom', 'bottom'] : ['bottom', 'top'];
    // where each end heads first: the other card (its lane, for a line that runs down one, once the lanes are spread), and for an arc one px further for each arc already between the two
    // cards, so the deeper arc is the outer one at both ends
    const pair = `${u.x}:${u.y}:${l.x}`;
    const rank = shape === 'under' ? tied.get(pair) ?? 0 : 0;
    if (shape === 'under') tied.set(pair, rank + 1);
    const toward: [number, number] = [l.x + rank, u.x - rank];
    return { link, u, l, shape, lane, sides, toward, rank, at: [0, 0] as [number, number], off: 0 };
  });

  // The lines down one lane, side by side across it. One that leaves the lane to the left (its lower card is left of it) goes left of those that leave to the right; of those that leave left
  // the one that leaves first is furthest left, of those that leave right furthest right, so a line leaving does not cross the ones still running down.
  const lanes = new Map<number, (typeof drawn)[number][]>();
  for (const e of drawn) if (e.shape === 'lane') lanes.set(e.lane, [...(lanes.get(e.lane) ?? []), e]);
  for (const [lane, list] of lanes) {
    const step = Math.min(STEP, (LANE - 12) / Math.max(1, list.length - 1));
    const right = (e: (typeof drawn)[number]) => Number(e.l.col > lane);
    list.sort((p, q) => right(p) - right(q) || (right(p) ? q.l.y - p.l.y : p.l.y - q.l.y) || p.l.x - q.l.x || p.u.y - q.u.y || p.u.x - q.u.x);
    list.forEach((e, i) => {
      e.off = (i - (list.length - 1) / 2) * step;
      e.toward = [laneX(lane) + e.off, laneX(lane) + e.off];
    });
  }

  // The lines at one side of a card, spread along it in the order of where each heads, so no two share a point and neighbours do not cross at the card.
  const meet = new Map<string, { e: (typeof drawn)[number]; end: 0 | 1; other: MapPos }[]>();
  for (const e of drawn) {
    for (const end of [0, 1] as const) {
      const [node, other] = end === 0 ? [e.u, e.l] : [e.l, e.u];
      const key = `${node.col}:${node.row}:${e.sides[end]}`;
      meet.set(key, [...(meet.get(key) ?? []), { e, end, other }]);
    }
  }
  for (const list of meet.values()) {
    const step = Math.min(PORT, (MAP_NODE.w - 24) / Math.max(1, list.length - 1));
    // by where each heads, those heading left first; but the arcs under a row go outward: of those heading the same way the farther is the outer, so the arcs nest and do not cross
    const cx = (list[0]!.end === 0 ? list[0]!.e.u : list[0]!.e.l).x + MAP_NODE.w / 2;
    const key = (p: (typeof list)[number]) => (p.e.shape === 'under' ? -p.e.toward[p.end]! : p.e.toward[p.end]!);
    const group = (p: (typeof list)[number]) => Math.sign(p.e.toward[p.end]! - cx);
    list.sort((p, q) => group(p) - group(q) || key(p) - key(q) || p.other.y - q.other.y || p.other.x - q.other.x);
    list.forEach((p, i) => (p.e.at[p.end] = (i - (list.length - 1) / 2) * step));
  }

  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const gapTop = (row: number) => TOP + ROW * row + MAP_NODE.h;
  const labels = new Map<(typeof drawn)[number], MapLabel>();
  const edges = drawn.map((e) => {
    const { u, l, shape } = e;
    if (shape === 'under') {
      const [x1, x2, y] = [u.x + MAP_NODE.w / 2 + e.at[0], l.x + MAP_NODE.w / 2 + e.at[1], u.y + MAP_NODE.h];
      const dip = DIP[0]! + ((DIP[1]! - DIP[0]!) * (l.col - u.col - 1)) / Math.max(1, stages.length - 2) + DEEPER * e.rank;
      return { e, d: `M${round(x1)},${y} C${round(x1)},${round(y + dip)} ${round(x2)},${round(y + dip)} ${round(x2)},${y}`, gap: u.row, x: (x1 + x2) / 2, y: y + 0.75 * dip , run: undefined };
    }
    const [x1, y1, x2, y2] = [u.x + MAP_NODE.w / 2 + e.at[0], u.y + MAP_NODE.h, l.x + MAP_NODE.w / 2 + e.at[1], l.y];
    const middle = y2 - GAP / 2; // the middle of the gap just above the lower card: where the line turns into it, and where the name goes
    if (shape === 'down') {
      // one gap apart: an S from one card to the other, inside the gap, which it crosses halfway along
      return { e, d: `M${round(x1)},${y1} C${round(x1)},${middle} ${round(x2)},${middle} ${round(x2)},${y2}`, gap: l.row - 1, x: (x1 + x2) / 2, y: middle, run: undefined };
    }
    // rows apart: an S into the lane inside the gap under the upper card, straight down the lane past the rows between, and an S out of it inside the gap above the lower card
    const x = laneX(e.lane) + e.off;
    const [top, bottom] = [y1 + GAP, y2 - GAP];
    return {
      e, d: `M${round(x1)},${y1} C${round(x1)},${y1 + GAP / 2} ${round(x)},${y1 + GAP / 2} ${round(x)},${top} V${bottom} C${round(x)},${middle} ${round(x2)},${middle} ${round(x2)},${y2}`,
      gap: l.row - 1, x: (x + x2) / 2, y: middle, run: { x0: x, x1: x, y0: top, y1: bottom },
    };
  });
  // the straight run of each line down a lane crosses the gaps between rows too, and a name over it would cut it and look like its own
  for (const g of edges) if (g.run) placed.push(g.run);

  // The names, the ones that matter most first. A name sits on its line, where the line is lowest in the gap (an arc) or crosses the gap's middle; if another name is there it moves a line
  // down, then up, and if neither is free or still in the gap, the line goes unnamed: the list under the map has every file.
  const rank = (l: MapLink) => (picked !== undefined && (l.a === picked || l.b === picked) ? 0 : l.together ? 1 : 2);
  for (const g of edges.filter((x) => x.e.link.kind === 'file' && x.e.link.files?.length).toSorted((p, q) => rank(p.e.link) - rank(q.e.link))) {
    const text = fileTail(g.e.link.files![0]!);
    const w = text.length * CHAR;
    const x0 = Math.max(4, Math.min(width - 4 - w, g.x - w / 2));
    const top = gapTop(g.gap);
    const y = [0, LINE, -LINE, 2 * LINE, -2 * LINE].map((dy) => g.y + 4 + dy) // the baseline: the text's middle on the line
      .find((base) => base - 11 >= top + 2 && base + 3 <= top + GAP - 2 && !placed.some((p) => x0 < p.x1 + 8 && p.x0 < x0 + w + 8 && base - 11 < p.y1 && p.y0 < base + 3));
    if (y === undefined) continue;
    placed.push({ x0, x1: x0 + w, y0: y - 11, y1: y + 3 });
    labels.set(g.e, { x: round(x0 + w / 2), y: round(y), w: round(w), text });
  }

  // The gap under the last row is there only when a line needs it: two cards of that row tied to each other.
  const height = TOP + ROW * last + MAP_NODE.h + (drawn.some((e) => e.shape === 'under' && e.u.row === last) ? GAP : 12);
  return {
    width, height, pos,
    cols: stages.map((_, c) => ({ x: LEFT + COL * c, count: counts[c]! })),
    edges: edges.map(({ e, d }): MapEdge<L> => ({ link: e.link, d, ...(labels.has(e) ? { label: labels.get(e)! } : {}) })),
  };
}
