import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusWanted, Live, type Session } from '../src/Live.tsx';

// The link a Factory board row makes to a session (#32): `#/live?session=<id>`. Live draws each session's card with an id the link can name, and the view brings the named card into view and
// focuses it, once. The views are rendered to markup, which runs no effects, so the hook's one step (`focusWanted`) is taken apart from it and checked against a fake document.
const T = Date.parse('2026-11-06T12:00:00Z');
const session = (id: string): Session =>
  ({ id, project: 'mobile-app', branch: 'fix/415-sync-dialog', host: 'mbp', startedAt: T - 40 * 60_000, lastTs: T, tokens: 1e6, cost: 2, costPartial: false, content: 'full', agents: [] }) as Session;

describe('Live\'s session cards', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  afterEach(() => vi.unstubAllGlobals());

  it('each card has an id made of its session\'s, and can take focus without being a tab stop', () => {
    const html = renderToStaticMarkup(createElement(Live, { list: [session('s-aaa'), session('s-bbb')], all: {}, now: T }));
    expect(html).toMatch(/<section class="card sess" id="session-s-aaa" tabindex="-1"/);
    expect(html).toMatch(/<section class="card sess" id="session-s-bbb" tabindex="-1"/);
  });
});

describe('focusWanted: the card a link named is brought into view and focused, once', () => {
  const card = () => ({ scrollIntoView: vi.fn(), focus: vi.fn() });
  const doc = (cards: Record<string, ReturnType<typeof card>>) => ({ getElementById: (id: string) => cards[id] ?? null }) as unknown as Document;

  it('scrolls to the card and focuses it without scrolling again, then forgets the wish', () => {
    const c = card();
    const want = { current: 's-aaa' as string | null };
    focusWanted(want, 2, doc({ 'session-s-aaa': c }), false);
    expect(c.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    expect(c.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(want.current).toBeNull();
    focusWanted(want, 2, doc({ 'session-s-aaa': c }), false); // a later render of the list: the card is not pulled back
    expect(c.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('does not animate for a viewer who asked for reduced motion', () => {
    const c = card();
    focusWanted({ current: 's-aaa' }, 1, doc({ 'session-s-aaa': c }), true);
    expect(c.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('waits while the stream has not spoken, and takes the card when it comes', () => {
    const c = card();
    const want = { current: 's-aaa' as string | null };
    focusWanted(want, 0, doc({}), false);
    expect(want.current).toBe('s-aaa'); // still wanted
    focusWanted(want, 1, doc({ 'session-s-aaa': c }), false);
    expect(c.focus).toHaveBeenCalledTimes(1);
  });

  it('gives up on a session Live does not show (it ended more than ten minutes ago) once the list has loaded without it', () => {
    const other = card();
    const want = { current: 's-gone' as string | null };
    focusWanted(want, 2, doc({ 'session-s-other': other }), false);
    expect(want.current).toBeNull();
    expect(other.scrollIntoView).not.toHaveBeenCalled();
    expect(other.focus).not.toHaveBeenCalled();
  });

  it('a link that names no session does nothing', () => {
    const c = card();
    focusWanted({ current: null }, 2, doc({ 'session-s-aaa': c }), false);
    focusWanted({ current: undefined }, 2, doc({ 'session-s-aaa': c }), false);
    expect(c.scrollIntoView).not.toHaveBeenCalled();
  });
});
