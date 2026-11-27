import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// No board row is wider than its card at any width (#90, F10). The studio cannot lay a page out, so the arithmetic that the breakpoints rest on is checked against the stylesheet: the five columns of a row
// at their least, the gaps and padding the base .board .brow rule gives, against the card each layout leaves. The container is the frame and the page's main pads it by 20px each side.
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))![1]!;
const columns = rule('.factory .board .bcols.fx-cols, .factory .board .brow.fx-row').match(/grid-template-columns: ([^;]*);/)![1]!;
const least = [...columns.matchAll(/minmax\((\d+)px|(?<![\d(])(\d+)px/g)].reduce((n, m) => n + Number(m[1] ?? m[2]), 0);
const base = rule('.board .bcols, .board .brow');
const gap = Number(base.match(/gap: (\d+)px/)![1]);
const pad = Number(base.match(/padding: \d+px (\d+)px/)![1]);
const row = least + 4 * gap + 2 * pad + 2; // five columns, four gaps, padding, and the card's 1px border each side
const breakpoint = (inside: string) => Number(css.match(new RegExp(`@container \\(max-width: (\\d+)px\\) \\{\\s*${inside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))![1]);
const SIDE = 340 + 16; // the side cards and the gap beside the board
const PAGE = 40; // main's padding

describe('a board row fits its card (F10)', () => {
  it('reads the stylesheet as the arithmetic expects: five columns of at least 684px, a row of 790px with its gaps, padding and border', () => {
    expect(columns.split(' ').length).toBeGreaterThan(5); // minmax(..) pairs and fixed columns
    expect(least).toBe(684);
    expect(row).toBe(790);
  });

  it('the rows stack on a frame where a one-column card is narrower than a row, and not before', () => {
    const stack = breakpoint('/* a row stacks');
    expect(stack - PAGE).toBeLessThan(row); // at the breakpoint the card cannot hold a row, so the row stacks
    expect(stack + 1 - PAGE).toBeGreaterThanOrEqual(row); // one pixel wider it can: the five columns are not given up early
  });

  it('two columns only where the board column holds a row, and one column below that', () => {
    const one = breakpoint('.factory .fx-grid');
    expect(one - PAGE - SIDE).toBeLessThan(row);
    expect(one + 1 - PAGE - SIDE).toBeGreaterThanOrEqual(row);
  });

  it('a stacked row is no wider than its card at 320px: one column of the card, and the page does not scroll sideways for it', () => {
    expect(css).toMatch(/\.factory \.board \.brow\.fx-row \{ grid-template-columns: minmax\(0, 1fr\) auto;/);
    expect(css).toMatch(/\.factory \.bcols\.fx-cols \{ display: none; \}/); // the column heads go with the columns
  });
});
