import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Analysis } from '../src/Analysis.tsx';
import { App } from '../src/App.tsx';
import { History } from '../src/History.tsx';
import { Skills } from '../src/Skills.tsx';

// Every page while its read is out (#88): a spinner and, in words, what it is reading. Rendered to markup, where effects do not run, so no read has answered:
// what shows is exactly what a person sees while they wait.
const read = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const at = (hash: string) => {
  vi.stubGlobal('location', { hash, host: '127.0.0.1:4040' });
  return renderToStaticMarkup(createElement(App));
};
/** The wait each page draws, by the page's own main element: `ledger`, `ledger trends hidden`, ... */
const waits = (html: string) => Object.fromEntries(html.split('<main ').slice(1).map((m) => {
  const cls = m.match(/^class="([^"]*)"/)![1]! + (/^[^>]*\bhidden=""/.test(m) ? ' hidden' : '');
  const status = m.match(/<div class="empty loading" role="status"><span class="spin" aria-hidden="true"><\/span>(.*?)<\/div>/);
  return [cls, status ? read(status[1]!) : null];
}));
const wait = (html: string) => {
  const m = html.match(/<div class="empty loading" role="status"><span class="spin" aria-hidden="true"><\/span>(.*?)<\/div>/);
  return m ? read(m[1]!) : null;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 17, 12));
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a page with nothing to show yet says what it is reading', () => {
  it('Home, before its read answers, says it is reading your projects', () => {
    expect(waits(at(''))).toEqual({ home: 'Reading your projects…' });
  });

  it('Live, before the stream has spoken, is connecting, not "nothing to show"', () => {
    const html = at('#/live');
    expect(waits(html)).toEqual({ live: 'Connecting to the server…' });
    expect(read(html)).not.toContain('Nothing to show yet.');
  });

  it('the Ledger: each of its three views names its period and project', () => {
    expect(waits(at('#/ledger?project=agent-orb'))).toEqual({
      ledger: 'Reading the last 7 days for agent-orb…',
      'ledger trends hidden': 'Reading the last 12 weeks for agent-orb…',
      'ledger worth hidden': 'Reading the PRs merged in November 2026 for agent-orb…',
    });
  });

  it('the Ledger on all projects says so, and a one-project view waits for the list before it can name one', () => {
    expect(waits(at('#/ledger'))).toEqual({
      ledger: 'Reading the last 7 days for all projects…',
      'ledger trends hidden': 'Reading your projects…',
      'ledger worth hidden': 'Reading your projects…',
    });
  });

  it('the Pipeline', () => {
    expect(waits(at('#/pipeline?project=agent-orb'))).toEqual({ pipeline: 'Reading who delegated to whom in agent-orb…' });
    expect(waits(at('#/pipeline'))).toEqual({ pipeline: 'Reading your projects…' });
  });

  it('Factory', () => {
    expect(waits(at('#/factory?project=agent-orb'))).toEqual({ factory: "Reading agent-orb's PRs and board…" });
  });

  it('Analysis opens on Patterns, which reads the failures', () => {
    expect(waits(at('#/analysis?project=agent-orb'))).toEqual({ patterns: 'Reading the failures…' });
  });

  it('Analysis\'s Reports reads the past reports, and does not say there are none before it knows', () => {
    vi.stubGlobal('location', { hash: '#/analysis?project=agent-orb', host: '127.0.0.1:4040' });
    const html = renderToStaticMarkup(createElement(Analysis, { initial: 'reports' }));
    expect(wait(html.slice(html.indexOf('aria-label="Reports"')))).toBe('Reading past reports…');
    expect(read(html)).not.toContain('No analysis yet.');
  });

  it('the Pipeline\'s Skills view', () => {
    expect(wait(renderToStaticMarkup(createElement(Skills, { query: 'project=agent-orb', now: 0 })))).toBe('Reading which skills ran…');
  });

  it('an agent\'s history drawer', () => {
    const html = renderToStaticMarkup(createElement(History, { picked: { session: 's-1', agent: 'main' }, now: 0, onClose: () => {} }));
    expect(wait(html)).toBe('Reading what this agent did…');
  });
});
