import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetCard, BudgetField, BudgetLine, type BudgetData } from '../src/Factory.tsx';

// Change, type, save and close on the Budget card (#90, F13), driven as the owner drives it: the studio has no DOM, so React's hooks are replaced by a few lines that keep state between renders
// (as since-home.spec.ts does), the component is called as a function, and what is asserted is what the tree holds after each click and what the save is sent.
const h = vi.hoisted(() => ({ slots: [] as unknown[], i: 0 }));
vi.mock('react', async (orig) => {
  const r = await orig<typeof import('react')>();
  return {
    ...r,
    useId: () => 'id-1',
    useEffect: () => undefined,
    useState: (init: unknown) => {
      const k = h.i++;
      if (!(k in h.slots)) h.slots[k] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [h.slots[k], (v: unknown) => void (h.slots[k] = typeof v === 'function' ? (v as (x: unknown) => unknown)(h.slots[k]) : v)];
    },
  };
});

type Props = Record<string, unknown> & { children?: ReactNode };
const find = (n: ReactNode, test: (e: ReactElement<Props>) => boolean): ReactElement<Props> | undefined => {
  if (Array.isArray(n)) return n.map((x) => find(x, test)).find(Boolean);
  if (!isValidElement(n)) return undefined;
  const e = n as ReactElement<Props>;
  return test(e) ? e : find(e.props.children, test);
};
const button = (tree: ReactNode) => find(tree, (e) => e.type === 'button' && e.props['aria-expanded'] !== undefined)!;
const field = (tree: ReactNode) => find(tree, (e) => e.type === BudgetField);
const line = (onSave: (usd: number | null) => Promise<string | undefined>, value: number | null = 150) => {
  h.i = 0;
  return BudgetLine({ label: 'Default for v0.4 Factory', value, onSave }) as ReactElement<Props>;
};

beforeEach(() => {
  h.slots = [];
});

describe('a budget line: Change, save, close', () => {
  it('shows no field until Change is pressed, then the field in place; pressing again closes it', () => {
    const onSave = vi.fn(async () => undefined);
    let tree = line(onSave);
    expect(field(tree)).toBeUndefined();
    expect(button(tree).props['aria-expanded']).toBe(false);
    expect(renderToStaticMarkup(tree)).not.toContain('<input');
    (button(tree).props.onClick as () => void)();
    tree = line(onSave);
    expect(button(tree).props['aria-expanded']).toBe(true);
    expect(field(tree)!.props.value).toBe(150); // the field holds what is stored
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain('aria-label="Default for v0.4 Factory"');
    expect(markup).toContain('value="150"');
    expect(button(tree).props['aria-controls']).toBe(markup.match(/<div id="([^"]+)" class="fx-bud-edit"/)![1]);
    (button(tree).props.onClick as () => void)();
    expect(field(line(onSave))).toBeUndefined();
  });

  it('a save the server accepts closes the field and sends the amount; one it refuses keeps the field open and hands its words to the field', async () => {
    const onSave = vi.fn<(usd: number | null) => Promise<string | undefined>>(async () => undefined);
    (button(line(onSave)).props.onClick as () => void)();
    const save = field(line(onSave))!.props.onSave as typeof onSave;
    expect(await save(200)).toBeUndefined();
    expect(onSave).toHaveBeenCalledWith(200);
    expect(field(line(onSave))).toBeUndefined(); // closed
    (button(line(onSave)).props.onClick as () => void)();
    onSave.mockResolvedValueOnce('A budget is at most $1,000,000');
    expect(await (field(line(onSave))!.props.onSave as typeof onSave)(2_000_000)).toBe('A budget is at most $1,000,000');
    expect(field(line(onSave))).toBeDefined(); // still open, so the error shows where it was typed
  });

  it('a line with no budget says Set, not Change, and saving nothing removes (sends null)', async () => {
    const onSave = vi.fn(async () => undefined);
    expect(renderToStaticMarkup(line(onSave, null))).toContain('>Set</button>');
    (button(line(onSave, null)).props.onClick as () => void)();
    await (field(line(onSave, null))!.props.onSave as (u: number | null) => Promise<string | undefined>)(null);
    expect(onSave).toHaveBeenCalledWith(null);
  });
});

describe('the card sends a milestone\'s default for the milestone of the line', () => {
  const data: BudgetData = { project: 'p', month: '2026-11', issues: [], notOnIssue: { usd: 0, partial: false }, milestones: [{ name: 'v0.4 Factory', budget: 150 }, { name: 'v0.5 Follow', budget: null }] };

  it('the line of the milestone shown and each folded one save {milestone}, never {issue}', async () => {
    const save = vi.fn(async () => undefined);
    const tree = BudgetCard({ data, shown: 'v0.4 Factory', inFlight: new Set(), onSave: save }) as ReactElement<Props>;
    const lines = [] as ReactElement<Props>[];
    const walk = (n: ReactNode): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!isValidElement(n)) return;
      const e = n as ReactElement<Props>;
      if (e.type === BudgetLine) lines.push(e);
      walk(e.props.children);
    };
    walk(tree);
    expect(lines.map((l) => l.props.label)).toEqual(['Default for v0.4 Factory', 'Default for v0.5 Follow']);
    await (lines[0]!.props.onSave as (u: number | null) => Promise<string | undefined>)(200);
    await (lines[1]!.props.onSave as (u: number | null) => Promise<string | undefined>)(null);
    expect(save.mock.calls).toEqual([[{ milestone: 'v0.4 Factory' }, 200], [{ milestone: 'v0.5 Follow' }, null]]);
  });
});
