import { describe, expect, it } from 'vitest';
import { fileTail, layoutMap, MAP_NODE } from '../src/map-layout.ts';

// The Map's geometry (v0.5 slice 1, #66; design/home-issue.html, the Map board): a column per stage, issues top to bottom in each, lines that leave and reach a card on its border,
// and a file's name on its line where a row gap has room for it. Invented issues, as the mockup's.
const STAGES = ['queued', 'building', 'reviewing', 'fixing', 'gate', 'ready', 'merged'];
const ISSUES = [
  { number: 417, stage: 'queued' }, { number: 419, stage: 'queued' }, { number: 421, stage: 'queued' }, { number: 415, stage: 'building' }, { number: 398, stage: 'reviewing' },
  { number: 409, stage: 'fixing' }, { number: 407, stage: 'gate' }, { number: 412, stage: 'ready' }, { number: 403, stage: 'merged' },
];
type L = { a: number; b: number; kind: 'file' | 'mention'; files?: string[]; together?: boolean };
const file = (a: number, b: number, path = 'src/net/client.ts', together = true): L => ({ a, b, kind: 'file', files: [path], together });
const said = (a: number, b: number): L => ({ a, b, kind: 'mention' });
const LINKS = [file(409, 412), file(398, 409, 'src/auth/store.ts'), file(407, 412, 'src/upload/queue.ts'), file(403, 412, 'src/net/status.ts', false), said(417, 409), said(409, 403), said(419, 412)];

const box = (p: { x: number; y: number }) => ({ x0: p.x, y0: p.y, x1: p.x + MAP_NODE.w, y1: p.y + MAP_NODE.h });
const apart = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0;
/** The first and last point of a path, which are where it leaves one card and reaches the other. */
const ends = (d: string) => {
  const nums = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number);
  return [{ x: nums[0]!, y: nums[1]! }, { x: nums.at(-2)!, y: nums.at(-1)! }];
};
const onBorder = (pt: { x: number; y: number }, p: { x: number; y: number }) => {
  const b = box(p);
  const inX = pt.x >= b.x0 && pt.x <= b.x1;
  const inY = pt.y >= b.y0 && pt.y <= b.y1;
  return (inX && (pt.y === b.y0 || pt.y === b.y1)) || (inY && (pt.x === b.x0 || pt.x === b.x1));
};
const CHAR = 7.2; // a 12px monospace character, as the label's width is judged

/** Points along a path of M, C and V commands, 40 to a segment: what a line passes over on its way. */
const along = (d: string) => {
  const pts: { x: number; y: number }[] = [];
  let at = { x: 0, y: 0 };
  for (const [, cmd, args] of d.matchAll(/([MCV])([^MCV]*)/g)) {
    const n = args!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    if (cmd === 'M') at = { x: n[0]!, y: n[1]! };
    else if (cmd === 'V') {
      for (let k = 0; k <= 40; k++) pts.push({ x: at.x, y: at.y + ((n[0]! - at.y) * k) / 40 });
      at = { x: at.x, y: n[0]! };
    } else {
      const [x1, y1, x2, y2, x3, y3] = n as [number, number, number, number, number, number];
      for (let k = 0; k <= 40; k++) {
        const t = k / 40, u = 1 - t;
        pts.push({ x: u * u * u * at.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, y: u * u * u * at.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3 });
      }
      at = { x: x3, y: y3 };
    }
  }
  return pts;
};
/** The cards a line passes behind: a point of it strictly inside a card's box (on the border is where a line leaves or reaches its own card). */
const behind = (m: ReturnType<typeof layoutMap>, d: string) =>
  [...m.pos].filter(([, p]) => along(d).some((pt) => pt.x > p.x + 0.5 && pt.x < p.x + MAP_NODE.w - 0.5 && pt.y > p.y + 0.5 && pt.y < p.y + MAP_NODE.h - 0.5)).map(([n]) => n);
/** The lines drawn as an arc under a row: both ends on the bottom of a card. */
const arcs = (m: ReturnType<typeof layoutMap>) => m.edges.filter((e) => {
  const [from, to] = ends(e.d);
  return from!.y === m.pos.get(e.link.a)!.y + MAP_NODE.h && to!.y === m.pos.get(e.link.b)!.y + MAP_NODE.h;
}).map((e) => [e.link.a, e.link.b]);
// #67's fixture, the one its screenshots show: ISSUES without #421, and LINKS
const FIXTURE = ISSUES.filter((i) => i.number !== 421);

describe('layoutMap: where each issue sits', () => {
  const m = layoutMap(STAGES, ISSUES, LINKS);

  it('puts each issue in the column of its stage, the columns side by side in the stages\' order', () => {
    for (const i of ISSUES) expect(m.pos.get(i.number)!.col, `#${i.number}`).toBe(STAGES.indexOf(i.stage));
    const xs = STAGES.map((_, c) => m.cols[c]!.x);
    for (let c = 1; c < xs.length; c++) expect(xs[c]! - xs[c - 1]!).toBeGreaterThanOrEqual(MAP_NODE.w); // a column never runs into the next
    for (const i of ISSUES) expect(m.pos.get(i.number)!.x).toBe(xs[STAGES.indexOf(i.stage)]);
    expect(m.cols.map((c) => c.count)).toEqual([3, 1, 1, 1, 1, 1, 1]);
  });

  it('no two cards overlap: three in one column sit one under the other, top to bottom by number', () => {
    const all = ISSUES.map((i) => box(m.pos.get(i.number)!));
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(apart(all[i]!, all[j]!), `#${ISSUES[i]!.number} and #${ISSUES[j]!.number}`).toBe(true);
    const [a, b, c] = [417, 419, 421].map((n) => m.pos.get(n)!);
    expect([a!.row, b!.row, c!.row]).toEqual([0, 2, 4]);
    expect(b!.y - a!.y).toBeGreaterThanOrEqual(MAP_NODE.h);
    expect(c!.y - b!.y).toBe(b!.y - a!.y);
  });

  it('every card and heading is inside the canvas', () => {
    for (const p of m.pos.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThan(0); // under the headings
      expect(p.x + MAP_NODE.w).toBeLessThanOrEqual(m.width);
      expect(p.y + MAP_NODE.h).toBeLessThanOrEqual(m.height);
    }
    for (const e of m.edges) for (const pt of along(e.d)) expect(pt.x, e.d).toBeGreaterThanOrEqual(0), expect(pt.x, e.d).toBeLessThanOrEqual(m.width), expect(pt.y, e.d).toBeLessThanOrEqual(m.height);
  });

  it('a line between two cards of the last column, rows apart, runs down the lane right of it, inside the canvas and behind no card, and names its file', () => {
    const three = layoutMap(STAGES, [...ISSUES, { number: 404, stage: 'merged' }, { number: 405, stage: 'merged' }], [file(403, 405, 'src/net/status.ts'), said(404, 417)]); // #404 is linked too, so it keeps the row between the two
    const e = three.edges[0]!;
    const right = three.pos.get(403)!.x + MAP_NODE.w;
    const down = along(e.d).filter((pt) => pt.y > three.pos.get(404)!.y && pt.y < three.pos.get(404)!.y + MAP_NODE.h); // beside #404, the card between the two
    expect(down.length).toBeGreaterThan(0);
    for (const pt of down) expect(pt.x > right && pt.x < three.width, `${pt.x}`).toBe(true);
    expect(behind(three, e.d)).toEqual([]);
    expect(e.label?.text).toBe('net/status.ts');
  });

  it('a card stays where it is whichever is pressed and whatever order the board lists it in: only its stage, whether it has a link and the numbers beside it place it (#90: gaining its first link moves it)', () => {
    const place = (x: ReturnType<typeof layoutMap>) => Object.fromEntries([...x.pos].map(([n, p]) => [n, [p.x, p.y]]));
    expect(place(layoutMap(STAGES, ISSUES, LINKS, 417))).toEqual(place(m));
    expect(place(layoutMap(STAGES, ISSUES.toReversed(), LINKS, 409))).toEqual(place(m));
  });

  it('an issue gaining its first link moves it and the unlinked issues of its stage, and no card of another stage that gains no link (#90)', () => {
    const issues = [1, 2, 3, 4].map((number) => ({ number, stage: 'building' })).concat([{ number: 5, stage: 'queued' }, { number: 6, stage: 'gate' }]);
    const rows = (links: L[]) => Object.fromEntries([...layoutMap(STAGES, issues, links).pos].map(([n, p]) => [n, p.row]));
    expect(rows([])).toEqual({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 0, 6: 0 }); // packed one row apart
    expect(rows([{ a: 3, b: 5, kind: 'mention' }])).toEqual({ 3: 1, 1: 3, 2: 4, 4: 5, 5: 0, 6: 0 }); // #3 joins the linked rows; #1, #2 and #4 move down; #5 (linked either way) and #6 stay
  });

  it('a stage it does not know is not drawn, and a board with no issue is an empty canvas of seven columns', () => {
    expect(layoutMap(STAGES, [{ number: 1, stage: 'shipped' }], []).pos.size).toBe(0);
    const empty = layoutMap(STAGES, [], []);
    expect(empty.cols.map((c) => c.count)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(empty.width).toBe(m.width);
  });
});

describe('layoutMap: the lines', () => {
  const m = layoutMap(STAGES, ISSUES, LINKS);

  it('one line per link, in the links\' order, from the border of one card to the border of the other', () => {
    expect(m.edges.map((e) => e.link)).toEqual(LINKS);
    for (const e of m.edges) {
      const [from, to] = ends(e.d);
      const [a, b] = [m.pos.get(e.link.a)!, m.pos.get(e.link.b)!];
      expect((onBorder(from!, a) && onBorder(to!, b)) || (onBorder(from!, b) && onBorder(to!, a)), `${e.link.a} to ${e.link.b}: ${e.d}`).toBe(true);
    }
  });

  it('a link to an issue that is not on the map, or from an issue to itself, draws nothing', () => {
    expect(layoutMap(STAGES, ISSUES, [file(409, 999), said(409, 409), file(409, 412)]).edges.map((e) => [e.link.a, e.link.b])).toEqual([[409, 412]]);
  });

  it('lines that meet one card each have their own point on it, a file link and a mention between the same two included', () => {
    const both = layoutMap(STAGES, ISSUES, [...LINKS, said(409, 412), said(412, 409)]);
    const at = new Map<number, string[]>();
    for (const e of both.edges) {
      const [from, to] = ends(e.d);
      for (const n of [e.link.a, e.link.b]) {
        const pt = onBorder(from!, both.pos.get(n)!) ? from! : to!;
        at.set(n, [...(at.get(n) ?? []), `${pt.x},${pt.y}`]);
      }
    }
    for (const [n, pts] of at) expect(new Set(pts).size, `#${n}: ${pts.join(' ')}`).toBe(pts.length);
  });

  it('every pair of places is joined: side by side, one above the other, far apart in one column', () => {
    const tall = [1, 2, 3, 4].map((number) => ({ number, stage: 'queued' })).concat([{ number: 5, stage: 'building' }, { number: 6, stage: 'merged' }]);
    const links = [file(1, 2), file(1, 4), file(1, 5), file(1, 6), file(4, 5), file(3, 6)];
    const t = layoutMap(STAGES, tall, links);
    expect(t.edges).toHaveLength(links.length);
    for (const e of t.edges) expect(e.d).toMatch(/^M-?[\d.]+,-?[\d.]+ C(-?[\d.]+,-?[\d.]+ ){2}-?[\d.]+,-?[\d.]+( V-?[\d.]+ C(-?[\d.]+,-?[\d.]+ ){2}-?[\d.]+,-?[\d.]+)?$/);
    expect(new Set(t.edges.map((e) => e.d)).size).toBe(links.length);
  });
});

describe('layoutMap: the rows alternate by column, so a line crosses a gap instead of running along it (#70)', () => {
  it('a stage\'s first issue sits on the top row in Queued, Reviewing, Gate and Merged, on the second in Building, Fixing and Ready; each further linked issue two rows down', () => {
    const m = layoutMap(STAGES, ISSUES, LINKS);
    expect(Object.fromEntries([...m.pos].map(([n, p]) => [n, p.row]))).toEqual({ 417: 0, 419: 2, 421: 4, 415: 1, 398: 0, 409: 1, 407: 0, 412: 1, 403: 0 });
    const twice = layoutMap(STAGES, [{ number: 1, stage: 'fixing' }, { number: 2, stage: 'fixing' }, { number: 3, stage: 'gate' }, { number: 4, stage: 'gate' }], [{ a: 1, b: 2, kind: 'mention' }, { a: 3, b: 4, kind: 'mention' }]);
    expect(Object.fromEntries([...twice.pos].map(([n, p]) => [n, p.row]))).toEqual({ 1: 1, 2: 3, 3: 0, 4: 2 });
  });

  it('issues with no link go after their stage\'s linked ones, one row apart, so five queued ones are not a 1,300px column (#90); linked issues keep their rows', () => {
    const queued = [1, 2, 3, 4, 5].map((number) => ({ number, stage: 'queued' }));
    const m = layoutMap(STAGES, queued, []);
    expect([1, 2, 3, 4, 5].map((n) => m.pos.get(n)!.row)).toEqual([0, 1, 2, 3, 4]);
    expect(m.pos.get(2)!.y - m.pos.get(1)!.y).toBe(140);
    // #2 and #3 are tied to a card in Building: they keep rows 0 and 2, and the unlinked #1, #4 and #5 follow them
    const mixed = layoutMap(STAGES, [...queued, { number: 9, stage: 'building' }], [{ a: 2, b: 9, kind: 'mention' }, { a: 3, b: 9, kind: 'mention' }]);
    expect([2, 3, 1, 4, 5].map((n) => mixed.pos.get(n)!.row)).toEqual([0, 2, 4, 5, 6]);
    expect(mixed.pos.get(9)!.row).toBe(1);
  });

  it('on #67\'s fixture one line is an arc under a row, #409 to #412 (both in odd columns); the other six each cross one gap', () => {
    expect(arcs(layoutMap(STAGES, FIXTURE, LINKS))).toEqual([[409, 412]]);
  });

  it('on #67\'s fixture every file link is still named', () => {
    expect(layoutMap(STAGES, FIXTURE, LINKS).edges.filter((e) => e.link.kind === 'file').map((e) => e.label?.text)).toEqual(['net/client.ts', 'auth/store.ts', 'upload/queue.ts', 'net/status.ts']);
  });

  it('no line passes behind a card: not on the fixture, not where a line skips rows, not in one column, not in a crowd', () => {
    const tall = [1, 2, 3, 4].map((number) => ({ number, stage: 'queued' })).concat([{ number: 5, stage: 'building' }, { number: 6, stage: 'merged' }, { number: 7, stage: 'building' }, { number: 8, stage: 'reviewing' }]);
    const crowd = [1, 2, 3, 4, 5, 6, 7].map((number, i) => ({ number, stage: STAGES[i]! })).concat([8, 9, 10, 11, 12, 13].map((number, i) => ({ number, stage: STAGES[i]! })));
    const boards: [string, { number: number; stage: string }[], L[]][] = [
      ['fixture', FIXTURE, LINKS],
      ['three queued', ISSUES, [...LINKS, file(417, 421), said(421, 415), file(419, 403), said(421, 412)]],
      ['tall', tall, [file(1, 2), file(1, 4), file(1, 5), file(1, 6), file(4, 5), file(3, 6), file(2, 7), file(4, 8), said(8, 3), file(7, 6)]],
      ['crowd', crowd, [1, 2, 3, 4, 5, 6, 7].flatMap((n) => [8, 9, 10, 11, 12, 13].map((to) => file(n, to, `src/f${n}.ts`, false)))],
    ];
    for (const [name, issues, links] of boards) {
      const m = layoutMap(STAGES, issues, links);
      for (const e of m.edges) expect(behind(m, e.d), `${name}: #${e.link.a} to #${e.link.b}: ${e.d}`).toEqual([]);
    }
  });
});

describe('layoutMap: the file a line names', () => {
  const m = layoutMap(STAGES, ISSUES, LINKS);
  const labelBox = (l: { x: number; y: number; text: string }) => {
    const w = l.text.length * CHAR;
    const x0 = l.x - w / 2;
    return { x0, x1: x0 + w, y0: l.y - 11, y1: l.y + 3 };
  };

  it('a file link names its first file, by the end of its path; a mention names nothing', () => {
    expect(m.edges.map((e) => e.label?.text)).toEqual(['net/client.ts', 'auth/store.ts', 'upload/queue.ts', 'net/status.ts', undefined, undefined, undefined]);
  });

  it('a name sits in the gap between two rows, never over a card, inside the canvas, and no two names overlap', () => {
    const many = layoutMap(STAGES, ISSUES, [...LINKS, file(417, 415, 'a.ts'), file(419, 415, 'b.ts'), file(421, 398, 'c.ts'), file(417, 419, 'd.ts'), file(419, 421, 'e.ts'), file(415, 398, 'f.ts')]);
    const labels = many.edges.flatMap((e) => (e.label ? [labelBox(e.label)] : []));
    expect(labels.length).toBeGreaterThanOrEqual(8);
    for (const l of labels) {
      expect(l.x0).toBeGreaterThanOrEqual(0);
      expect(l.x1).toBeLessThanOrEqual(many.width);
      expect(l.y1).toBeLessThanOrEqual(many.height);
      for (const p of many.pos.values()) expect(apart(l, box(p)), JSON.stringify(l)).toBe(true);
    }
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) expect(apart(labels[i]!, labels[j]!), `${JSON.stringify(labels[i])} ${JSON.stringify(labels[j])}`).toBe(true);
  });

  it('where the names of many lines would run into each other, a line goes unnamed rather than unreadable; the pressed card\'s lines are named first, then those in flight together', () => {
    // seven across the top row, six more under them, and every top card tied to each of those: 42 names of 168px for one gap, which is four lines high and six names wide
    const crowd = [1, 2, 3, 4, 5, 6, 7].map((number, i) => ({ number, stage: STAGES[i]! })).concat([8, 9, 10, 11, 12, 13].map((number, i) => ({ number, stage: STAGES[i]! })));
    const links = [1, 2, 3, 4, 5, 6, 7].flatMap((n) => [8, 9, 10, 11, 12, 13].map((to) => file(n, to, `src/long/enough/file-number-${n}.ts`, false)));
    const key = (l: L) => `${l.a}-${l.b}`;
    const names = (picked?: number, list = links) => layoutMap(STAGES, crowd, list, picked).edges.filter((e) => e.label).map((e) => key(e.link));
    expect(names().length).toBeLessThan(links.length);
    expect(names().length).toBeGreaterThanOrEqual(6); // and it is not all or nothing
    // one that lost its name to another name, and gets it when its card is pressed
    const lost = links.find((l) => !names().includes(key(l)) && names(l.a).includes(key(l)))!;
    expect(lost).toBeDefined();
    expect(names(lost.a)).toContain(key(lost)); // pressed, its lines come first
    expect(names(undefined, links.map((l) => (l === lost ? { ...l, together: true } : l)))).toContain(key(lost));
  });
});

// The review of #70: the same lines, judged by what is drawn (the crossings, the spacing, what a name covers).
const patch = (l: { x: number; y: number; w: number }) => ({ x0: l.x - l.w / 2 - 3, x1: l.x + l.w / 2 + 3, y0: l.y - 11, y1: l.y + 4 }); // as FactoryMap's rect under a name
const inPatch = (r: ReturnType<typeof patch>, pt: { x: number; y: number }) => pt.x > r.x0 && pt.x < r.x1 && pt.y > r.y0 && pt.y < r.y1;
/** The straight run of a line down a lane: its x and the y it spans, or none for a line that does not run down one. */
const run = (d: string) => {
  const v = d.match(/ (-?[\d.]+),(-?[\d.]+) V(-?[\d.]+)/);
  return v && { x: Number(v[1]), y0: Number(v[2]), y1: Number(v[3]) };
};
const laneOf = (d: string) => Math.round((run(d)!.x - 172) / 176) + 0; // lane k is the 24px right of column k, centred on 172 + 176k
const cross = (p: { x: number; y: number }[], q: { x: number; y: number }[]) => {
  const side = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  let n = 0;
  for (let i = 2; i < p.length - 3; i++) for (let j = 2; j < q.length - 3; j++) { // the first and last points are the ports, which no two lines share
    if (side(p[i]!, p[i + 1]!, q[j]!) * side(p[i]!, p[i + 1]!, q[j + 1]!) < 0 && side(q[j]!, q[j + 1]!, p[i]!) * side(q[j]!, q[j + 1]!, p[i + 1]!) < 0) n++;
  }
  return n;
};
const crossings = (edges: { d: string }[]) => edges.flatMap((e, i) => edges.slice(i + 1).map((f) => cross(along(e.d), along(f.d)))).reduce((a, b) => a + b, 0);
const arcEdges = (m: ReturnType<typeof layoutMap>) => m.edges.filter((e) => arcs(m).some(([a, b]) => a === e.link.a && b === e.link.b));
const queued = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1, stage: 'queued' }));
const depth = (d: string) => Math.max(...along(d).map((pt) => pt.y));

describe('layoutMap: the review of #70', () => {
  const three = [...LINKS, file(417, 421), said(421, 415), file(419, 403), said(421, 412)];
  const merge = { issues: [...queued(3), { number: 10, stage: 'building' }], links: [said(1, 3), file(2, 10, 'src/sync/merge.ts')] };

  it('a name never sits on the straight run of another line down a lane, which it would cut and look like its own', () => {
    for (const [name, issues, links] of [['merge', merge.issues, merge.links], ['fixture', ISSUES, LINKS], ['three queued', ISSUES, three]] as const) {
      const m = layoutMap(STAGES, issues, links);
      for (const e of m.edges) {
        if (!e.label) continue;
        const r = patch(e.label);
        for (const f of m.edges) {
          const v = f !== e && run(f.d);
          expect(!v || !(v.x > r.x0 && v.x < r.x1 && v.y0 < r.y1 && r.y0 < v.y1), `${name}: ${e.label.text} covers #${f.link.a} to #${f.link.b}`).toBe(true);
        }
      }
    }
  });

  it('two lines that leave one card for different sides of a lane do not cross on the way, in the gap under the card or in the lane', () => {
    const lanes = layoutMap(STAGES, [...queued(3), { number: 10, stage: 'building' }, { number: 11, stage: 'building' }], [file(1, 3), file(1, 11)]);
    const far = layoutMap(STAGES, [{ number: 30, stage: 'fixing' }, ...[20, 21, 22].map((number) => ({ number, stage: 'reviewing' })), ...[10, 11, 12, 13].map((number) => ({ number, stage: 'building' }))], [file(30, 22), file(30, 13)]);
    expect(lanes.edges.map((e) => run(e.d)?.x)).toHaveLength(2);
    expect(crossings(lanes.edges)).toBe(0);
    expect(crossings(far.edges)).toBe(0);
  });

  it('lines down one lane keep a stroke apart along it and a card\'s focus outline clear of them, five of them as much as two', () => {
    const five = layoutMap(STAGES, queued(4), [file(1, 2), file(1, 3), file(1, 4), file(2, 3), file(2, 4)]);
    for (const k of [2, 5]) {
      const xs = five.edges.slice(0, k).map((e) => run(e.d)!.x).toSorted((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!, `${k} lines`).toBeGreaterThanOrEqual(2.5);
      for (const x of xs) expect(Math.min(x - (8 + MAP_NODE.w), 8 + 176 - x), `${k} lines: ${x}`).toBeGreaterThanOrEqual(5.25); // the outline reaches 4px, and half a stroke is 1.25
    }
  });

  it('a line between cards rows apart runs down the lane beside the upper card, toward the lower one', () => {
    const m = layoutMap(STAGES, ISSUES, three);
    const at = (a: number, b: number) => laneOf(m.edges.find((e) => e.link.a === a && e.link.b === b)!.d);
    expect(at(421, 415)).toBe(0); // #415 is in column 1, #421 below it in column 0: left of #415
    expect(at(419, 403)).toBe(5); // #403 is in column 6, #419 below it in column 0: left of #403
    expect(at(417, 421)).toBe(0); // two cards of one column: right of the upper
  });

  it('on #67\'s fixture every line that is not an arc is one S across one gap, and none goes up its own V', () => {
    for (const e of layoutMap(STAGES, FIXTURE, LINKS).edges) expect(e.d, `#${e.link.a} to #${e.link.b}`).toMatch(/^M[\d.]+,[\d.]+ C[\d.]+,[\d.]+ [\d.]+,[\d.]+ [\d.]+,[\d.]+$/);
  });

  it('arcs under a row nest: the farther card\'s is the deeper and runs outside, a second link between two cards dips deeper than the first, and none cross', () => {
    const both = layoutMap(STAGES, FIXTURE, [...LINKS, said(409, 412)]);
    const [file409, said409] = arcEdges(both);
    expect(arcEdges(both)).toHaveLength(2);
    expect(crossings(arcEdges(both))).toBe(0);
    expect(depth(said409!.d)).toBeGreaterThan(depth(file409!.d));
    const abc = layoutMap(STAGES, [{ number: 1, stage: 'queued' }, { number: 2, stage: 'reviewing' }, { number: 3, stage: 'gate' }], [file(1, 2), file(1, 3), file(2, 3)]);
    expect(crossings(abc.edges)).toBe(0);
    const [near, far] = [abc.edges[0]!, abc.edges[1]!];
    expect(depth(far.d)).toBeGreaterThan(depth(near.d));
    const spans = (d: string) => [Math.min(...along(d).map((p) => p.x)), Math.max(...along(d).map((p) => p.x))];
    expect(spans(far.d)[0]).toBeLessThan(spans(near.d)[0]!); // the farther arc leaves left of the nearer from the card they share, and gets in right of it
    expect(spans(far.d)[1]).toBeGreaterThan(spans(near.d)[1]!);
  });

  it('every name has a point of its own line under its patch', () => {
    for (const [name, issues, links] of [['merge', merge.issues, merge.links], ['fixture', ISSUES, LINKS], ['three queued', ISSUES, three]] as const) {
      for (const e of layoutMap(STAGES, issues, links).edges) if (e.label) expect(along(e.d).some((pt) => inPatch(patch(e.label!), pt)), `${name}: ${e.label.text}`).toBe(true);
    }
  });
});

describe('fileTail', () => {
  it('a path as its last two parts, a file at the root as it is, and a long name cut', () => {
    expect(fileTail('packages/server/src/api/board.ts')).toBe('api/board.ts');
    expect(fileTail('PROJECT.md')).toBe('PROJECT.md');
    expect(fileTail('src/a.ts')).toBe('src/a.ts');
    expect(fileTail('packages/studio/test/a-very-long-spec-file-name.spec.ts')).toBe('a-very-long-spec-file-name.spec.ts'.slice(0, 23) + '…');
    expect(fileTail('some-quite-long-folder/Factory.tsx')).toBe('Factory.tsx'); // two parts too long: the name alone
  });
});
