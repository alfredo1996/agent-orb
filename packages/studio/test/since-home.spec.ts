import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Home, type Since } from '../src/Home.tsx';

// Caught up, end to end through Home (#108): the studio has no DOM, so React's two hooks are replaced by a few lines that keep state between calls and run an effect when its deps change; Home is then
// called as a function and its fetches and timers are the real ones, faked. What is asserted is what the owner would see: the mark kept in the browser, and what the card asks the server next.
const h = vi.hoisted(() => ({ slots: [] as unknown[], i: 0, e: 0, queued: [] as { n: number; fn: () => unknown; deps?: unknown[] }[], prev: [] as (unknown[] | undefined)[], cleanup: [] as unknown[] }));
vi.mock('react', async (orig) => {
  const r = await orig<typeof import('react')>();
  return {
    ...r,
    useState: (init: unknown) => {
      const k = h.i++;
      if (!(k in h.slots)) h.slots[k] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [h.slots[k], (v: unknown) => void (h.slots[k] = typeof v === 'function' ? (v as (x: unknown) => unknown)(h.slots[k]) : v)];
    },
    useEffect: (fn: () => unknown, deps?: unknown[]) => void h.queued.push({ n: h.e++, fn, deps }),
  };
});

const T0 = Date.parse('2026-11-10T11:48:00Z');
const render = (): ReactElement => {
  h.i = 0;
  h.e = 0;
  h.queued = [];
  const tree = Home({ now: T0, sessions: [] }) as ReactElement;
  for (const { n, fn, deps } of h.queued) {
    const before = h.prev[n];
    if (before && deps && before.length === deps.length && deps.every((d, k) => Object.is(d, before[k]))) continue;
    if (typeof h.cleanup[n] === 'function') (h.cleanup[n] as () => void)();
    h.prev[n] = deps;
    h.cleanup[n] = fn();
  }
  return tree;
};
const find = (n: ReactNode, test: (p: Record<string, unknown>) => boolean): ReactElement | undefined => {
  if (Array.isArray(n)) return n.map((x) => find(x, test)).find(Boolean);
  if (!isValidElement(n)) return undefined;
  const p = (n as ReactElement<Record<string, unknown>>).props;
  return test(p) ? (n as ReactElement) : find(p.children as ReactNode, test);
};
const sinceOf = (tree: ReactElement) => find(tree, (p) => 'since' in p && 'data' in p)!.props as { since?: Since };

beforeEach(() => {
  h.slots = [];
  h.prev = [];
  h.cleanup = [];
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  for (const c of h.cleanup) if (typeof c === 'function') c();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Caught up through Home', () => {
  it('saves the time the shown list was asked for, not the time of the click, and the next ask is from it', async () => {
    const kept = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) });
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => (url.startsWith('/api/home') ? { projects: [], quiet: [] } : { changes: [{ at: T0 - 60_000, kind: 'picked-up', project: 'mobile-app', issue: 415 }], total: 1 }) };
    });
    render();
    await vi.advanceTimersByTimeAsync(0);
    expect(urls.filter((u) => u.startsWith('/api/changes'))).toEqual([`/api/changes?since=${T0 - 86_400_000}`]); // a first look: the past 24 hours
    let since = sinceOf(render()).since!;
    expect(since.changes).toHaveLength(1);
    vi.setSystemTime(T0 + 20_000); // the list has been on the screen for 20 seconds
    since.onCaughtUp();
    expect(kept.get('orb.lookedAt')).toBe(String(T0));
    since = sinceOf(render()).since!; // the mark moved: the card asks again at once, from the mark
    await vi.advanceTimersByTimeAsync(0);
    expect(urls.filter((u) => u.startsWith('/api/changes')).at(-1)).toBe(`/api/changes?since=${T0}`);
    expect(since.mark).toBe(T0);
    expect(since.changes).toEqual([]); // until the answer comes
  });

  it('asks the page and the card on one timer, and a stored mark is the first ask', async () => {
    vi.stubGlobal('localStorage', { getItem: () => String(T0 - 3_600_000), setItem: () => {} });
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => (urls.push(url), { ok: true, status: 200, json: async () => (url.startsWith('/api/home') ? { projects: [], quiet: [] } : { changes: [], total: 0 }) }));
    render();
    await vi.advanceTimersByTimeAsync(0);
    expect(urls.map((u) => u.split('?')[0])).toEqual(['/api/home', '/api/changes']);
    expect(urls[1]).toBe(`/api/changes?since=${T0 - 3_600_000}`);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(urls).toHaveLength(4); // one tick: both
  });
});
