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
    expect([a!.row, b!.row, c!.row]).toEqual([0, 1, 2]);
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
    for (const e of m.edges) for (const n of e.d.match(/-?\d+(?:\.\d+)?/g)!.filter((_, k) => k % 2 === 0).map(Number)) expect(n, e.d).toBeGreaterThanOrEqual(0), expect(n, e.d).toBeLessThanOrEqual(m.width); // every x of every path, control points too
  });

  it('a line between two cards of the last column, rows apart, bulges inside the canvas, and its name is put to the left of the line, where there is room, never clamped away from it', () => {
    const three = layoutMap(STAGES, [...ISSUES, { number: 404, stage: 'merged' }, { number: 405, stage: 'merged' }], [file(403, 405, 'src/net/status.ts')]);
    const e = three.edges[0]!;
    expect(e.d).toMatch(/^M\d/);
    for (const x of e.d.match(/-?\d+(?:\.\d+)?/g)!.filter((_, k) => k % 2 === 0).map(Number)) expect(x).toBeLessThanOrEqual(three.width);
    const l = e.label!;
    expect(l).toBeDefined();
    const edge = three.pos.get(403)!.x + MAP_NODE.w;
    const crossesAt = edge + 21; // the curve's furthest point out is three quarters of its 28px bulge, which is where it crosses the middle of the gap
    const w = l.text.length * 7.3;
    expect(l.anchor).toBe('start');
    expect(Math.abs(l.x + w - (crossesAt - 6))).toBeLessThanOrEqual(8); // the name ends just before the line
    expect(l.x).toBeGreaterThanOrEqual(0);
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
    for (const e of t.edges) expect(e.d).toMatch(/^M-?[\d.]+,-?[\d.]+ C(-?[\d.]+,-?[\d.]+ ){2}-?[\d.]+,-?[\d.]+$/);
    expect(new Set(t.edges.map((e) => e.d)).size).toBe(links.length);
  });
});

describe('layoutMap: the file a line names', () => {
  const m = layoutMap(STAGES, ISSUES, LINKS);
  const labelBox = (l: { x: number; y: number; text: string; anchor: string }) => {
    const w = l.text.length * CHAR;
    const x0 = l.anchor === 'middle' ? l.x - w / 2 : l.x;
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
