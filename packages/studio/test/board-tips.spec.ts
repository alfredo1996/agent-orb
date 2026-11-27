import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardCard } from '../src/Factory.tsx';

// The i buttons of the Board card open their text in place, by keyboard and by touch (#90, F3): a click is all either sends, so the state is driven as since-home.spec.ts drives Home's, with the hooks replaced
// by a few lines that keep state between renders, and what is asserted is what the tree then holds.
const h = vi.hoisted(() => ({ slots: [] as unknown[], i: 0 }));
vi.mock('react', async (orig) => {
  const r = await orig<typeof import('react')>();
  return {
    ...r,
    useId: () => 'u',
    useState: (init: unknown) => {
      const k = h.i++;
      if (!(k in h.slots)) h.slots[k] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [h.slots[k], (v: unknown) => void (h.slots[k] = typeof v === 'function' ? (v as (x: unknown) => unknown)(h.slots[k]) : v)];
    },
  };
});

type Props = Record<string, unknown> & { children?: ReactNode };
const all = (n: ReactNode, test: (e: ReactElement<Props>) => boolean, out: ReactElement<Props>[] = []) => {
  if (Array.isArray(n)) n.forEach((x) => all(x, test, out));
  else if (isValidElement(n)) (test(n as ReactElement<Props>) && out.push(n as ReactElement<Props>), all((n as ReactElement<Props>).props.children, test, out));
  return out;
};
const draw = () => {
  h.i = 0;
  return BoardCard({ data: { project: 'p', milestone: 'v1', content: 'full', milestones: [], issues: [] }, groups: [], sessions: [], now: 0, notOnIssue: { usd: 5, partial: false }, onMap: () => {} }) as ReactElement<Props>;
};
// the Info elements as the card returns them: their props are what the button is drawn from
const info = (tree: ReactElement<Props>, label: string) => all(tree, (e) => e.props.label === label)[0]!;
const tip = (tree: ReactElement<Props>, id: unknown) => all(tree, (e) => e.props.className === 'fx-tip' && e.props.id === id)[0]!;

beforeEach(() => {
  h.slots = [];
});

describe('the Board card\'s i buttons', () => {
  it('a press opens that note, and only that one; a second press closes it', () => {
    let tree = draw();
    const board = info(tree, 'About the board');
    const spend = info(tree, 'What this counts');
    expect([board.props.open, spend.props.open]).toEqual([false, false]);
    expect(tip(tree, board.props.id).props.hidden).toBe(true);
    (board.props.onToggle as () => void)();
    tree = draw();
    expect(info(tree, 'About the board').props.open).toBe(true);
    expect(tip(tree, info(tree, 'About the board').props.id).props.hidden).toBe(false);
    expect(info(tree, 'What this counts').props.open).toBe(false);
    expect(tip(tree, info(tree, 'What this counts').props.id).props.hidden).toBe(true);
    (info(tree, 'What this counts').props.onToggle as () => void)(); // another note replaces it
    tree = draw();
    expect([info(tree, 'About the board').props.open, info(tree, 'What this counts').props.open]).toEqual([false, true]);
    (info(tree, 'What this counts').props.onToggle as () => void)();
    expect(info(draw(), 'What this counts').props.open).toBe(false);
  });
});
