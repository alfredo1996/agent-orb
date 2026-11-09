import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';

// The studio's frame, rendered to markup (#16): the top bar, its six views, the route in the hash. Effects do not run here, so the stream has not spoken: the empty states are what shows.
const read = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const at = (hash: string) => {
  vi.stubGlobal('location', { hash, host: '127.0.0.1:4040' });
  return renderToStaticMarkup(createElement(App));
};

let error: ReturnType<typeof vi.spyOn>, warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  expect(error).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the studio frame', () => {
  it('the top bar links the six views in order and the brand', () => {
    const html = at('');
    expect(html).toContain('agent-orb');
    expect([...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1])).toEqual(['#/', '#/ledger', '#/pipeline', '#/factory', '#/office', '#/analysis']);
    expect(read(html.match(/<nav.*<\/nav>/s)![0])).toBe('Live Ledger Pipeline Factory Office Analysis');
  });

  it.each([
    ['', 'Live'], ['#/ledger', 'Ledger'], ['#/pipeline', 'Pipeline'], ['#/factory', 'Factory'], ['#/office', 'Office'], ['#/analysis', 'Analysis'],
  ])('at %j the current page is %s, and only it', (hash, name) => {
    const html = at(hash);
    const current = [...html.matchAll(/<a href="[^"]*" aria-current="page">(.*?)<\/a>/g)].map((m) => m[1]);
    expect(current).toEqual([name]);
  });

  it('an unknown hash falls back to Live; the query after ? does not change the view', () => {
    expect(at('#/nowhere')).toContain('aria-current="page">Live');
    expect(at('#/ledger?project=garden-app')).toContain('aria-current="page">Ledger');
  });

  it('the connection shows the host and is reconnecting before the stream opens', () => {
    const html = at('');
    expect(read(html)).toContain('Reconnecting… · 127.0.0.1:4040');
    expect(html).toContain('class="conn dropped"');
  });

  it('the menu button starts closed and controls the views', () => {
    const html = at('');
    expect(html).toContain('<button type="button" class="btn menu" aria-expanded="false" aria-controls="views">Menu</button>');
    expect(html).toContain('id="views"');
    expect(html).not.toContain('class="open"');
  });

  it('the Analysis route opens on Patterns, with Reports one tap away and not yet loaded', () => {
    const html = at('#/analysis');
    expect(html).toContain('<h1>Analysis</h1>');
    expect([...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>(Patterns|Reports)</g)].map((m) => [m[2], m[1]])).toEqual([['Patterns', 'true'], ['Reports', 'false']]);
    expect(html).not.toContain('New analysis');
  });

  it('with no session, Live shows no running count; the Office shows its empty floor', () => {
    expect(at('')).not.toContain('class="count"');
    expect(read(at('#/office'))).toContain('The floor is empty.');
  });
});
