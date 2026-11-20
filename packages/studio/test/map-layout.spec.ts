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
    const three = layoutMap(STAGES, [...ISSUES, { number: 404, stage: 'merged' }, { number: 405, stage: 'merged' }], [file(403, 405, 'src/net/status.ts')]);
    const e = three.edges[0]!;
    const right = three.pos.get(403)!.x + MAP_NODE.w;
    const down = along(e.d).filter((pt) => pt.y > three.pos.get(404)!.y && pt.y < three.pos.get(404)!.y + MAP_NODE.h); // beside #404, the card between the two
    expect(down.length).toBeGreaterThan(0);
    for (const pt of down) expect(pt.x > right && pt.x < three.width, `${pt.x}`).toBe(true);
    expect(behind(three, e.d)).toEqual([]);
    expect(e.label?.text).toBe('net/status.ts');
  });

  it('a card stays where it is whatever links it has, whichever is pressed and whatever order the board lists it in: only its stage and the numbers beside it place it', () => {
    const place = (x: ReturnType<typeof layoutMap>) => Object.fromEntries([...x.pos].map(([n, p]) => [n, [p.x, p.y]]));
    expect(place(layoutMap(STAGES, ISSUES, []))).toEqual(place(m));
    expect(place(layoutMap(STAGES, ISSUES.toReversed(), LINKS, 409))).toEqual(place(m));
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
  it('a stage\'s first issue sits on the top row in Queued, Reviewing, Gate and Merged, on the second in Building, Fixing and Ready; each further issue two rows down', () => {
    const m = layoutMap(STAGES, ISSUES, LINKS);
    expect(Object.fromEntries([...m.pos].map(([n, p]) => [n, p.row]))).toEqual({ 417: 0, 419: 2, 421: 4, 415: 1, 398: 0, 409: 1, 407: 0, 412: 1, 403: 0 });
    const twice = layoutMap(STAGES, [{ number: 1, stage: 'fixing' }, { number: 2, stage: 'fixing' }, { number: 3, stage: 'gate' }, { number: 4, stage: 'gate' }], []);
    expect(Object.fromEntries([...twice.pos].map(([n, p]) => [n, p.row]))).toEqual({ 1: 1, 2: 3, 3: 0, 4: 2 });
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
    const lost = links.find((l) => !names().includes(key(l)))!;
    expect(names(lost.a)).toContain(key(lost)); // pressed, its lines come first
    expect(names(undefined, links.map((l) => (l === lost ? { ...l, together: true } : l)))).toContain(key(lost));
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
