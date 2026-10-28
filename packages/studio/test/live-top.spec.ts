import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTokens } from '../src/format.ts';
import { Connection } from '../src/kit.tsx';
import { Live, type Session } from '../src/Live.tsx';
import { freshness, lastEventOf, liveSentence, runFor, startedLabel } from '../src/live-cards.ts';

// Live (#101, design/v0.3-readable.html, the Live board): the connection in words, the sentence on top, a session's own start, the figures as words with units.
const NOW = 1793029946340; // 26 Oct 2026, 16:52:26 in Rome: the two sessions the mock shows
const MIN = 60_000;
const read = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

describe('the connection says how fresh it is, in words', () => {
  const conn = (isOpen: boolean, lastEvent: number | undefined, now = NOW) => renderToStaticMarkup(createElement(Connection, { isOpen, lastEvent, now, host: '127.0.0.1:4040' }));

  it('"Live" while the stream is open and an event came in the last minute', () => {
    const html = conn(true, NOW - 2000);
    expect(html).toContain('<span class="pulse live"></span>Live<span class="addr"> · 127.0.0.1:4040</span>');
    expect(html).toContain('class="conn live"');
  });

  it('"Quiet for 4m" with a grey dot after four minutes without an event, and no seconds', () => {
    const html = conn(true, NOW - 4 * MIN - 12_000);
    expect(html).toContain('<span class="pulse quiet"></span>Quiet for 4m<span class="addr">');
    expect(read(html)).not.toMatch(/\d+s\b/);
  });

  it('"Reconnecting…" in amber when the stream is closed, whatever the last event was', () => {
    for (const last of [NOW - 2000, NOW - 10 * MIN, undefined]) {
      const html = conn(false, last);
      expect(html).toContain('<span class="pulse dropped"></span>Reconnecting…');
      expect(html).toContain('class="conn dropped"');
    }
  });

  it('a count never runs: while events come in, the text is the same word every second', () => {
    const texts = new Set([0, 1000, 2000, 5000, 20_000, 59_000].map((age) => freshness(true, NOW - age, NOW).text));
    expect([...texts]).toEqual(['Live']);
  });

  it('quiet starts after 60 s, not at 60 s: the minute is the boundary', () => {
    expect(freshness(true, NOW - MIN, NOW).tone).toBe('live');
    expect(freshness(true, NOW - MIN - 1, NOW)).toEqual({ tone: 'quiet', text: 'Quiet for 1m' });
  });

  it('says the age in minutes, then hours, then days, never in seconds', () => {
    const quiet = (ms: number) => freshness(true, NOW - ms, NOW).text;
    expect(quiet(61_000)).toBe('Quiet for 1m');
    expect(quiet(59 * MIN + 59_000)).toBe('Quiet for 59m');
    expect(quiet(65 * MIN)).toBe('Quiet for 1h 05m');
    expect(quiet(26 * 3_600_000)).toBe('Quiet for 1d');
  });

  it('nothing known yet is not quiet: a connected studio with no session says Live', () => {
    expect(freshness(true, undefined, NOW)).toEqual({ tone: 'live', text: 'Live' });
  });

  it('an event stamped ahead of the studio\'s clock is fresh, not negative', () => {
    expect(freshness(true, NOW + 5000, NOW).tone).toBe('live');
  });

  it('the last event is the newest one any session holds, not the time of a stream message', () => {
    expect(lastEventOf([{ lastTs: 5 }, { lastTs: 90 }, { lastTs: 12 }])).toBe(90);
    expect(lastEventOf([])).toBeUndefined();
  });
});

describe('the sentence on top of Live', () => {
  const agent = (o: object = {}) => ({ id: 'main', type: 'main', depth: 0, state: 'working', startedAt: 0, lastTs: 0, tasks: [], ...o }) as any;
  const sess = (agents: any[], o: object = {}) => ({ agents, ...o });

  it('the mock\'s two sessions: one working, one waiting for the next prompt, nothing stalled', () => {
    expect(liveSentence([sess([agent()]), sess([agent({ state: 'waiting', waitingFor: 'prompt' })])]))
      .toBe('2 sessions are running: 1 is working, 1 is waiting for you. Nothing is stalled.');
  });

  it('one session reads in the singular', () => {
    expect(liveSentence([sess([agent()])])).toBe('1 session is running: 1 is working. Nothing is stalled.');
  });

  it('says what is stalled, in agents, and a session with a stalled agent is still a running one', () => {
    expect(liveSentence([sess([agent(), agent({ id: 'a1', state: 'stalled' })]), sess([agent({ state: 'stalled' })])]))
      .toBe('2 sessions are running: 1 is working. 2 agents are stalled.');
    expect(liveSentence([sess([agent({ state: 'stalled' })])])).toBe('1 session is running. 1 agent is stalled.');
  });

  it('a session with an agent waiting for your OK is waiting for you, even while another agent works', () => {
    const blocked = sess([agent(), agent({ id: 'a1', state: 'waiting', waitingFor: 'permission' })]);
    expect(liveSentence([blocked, sess([agent()])])).toBe('2 sessions are running: 1 is working, 1 is waiting for you. Nothing is stalled.');
  });

  it('a subagent between steps is the session working, not a wait for you', () => {
    expect(liveSentence([sess([agent({ state: 'waiting' })])])).toBe('1 session is running. Nothing is stalled.');
  });

  it('an ended session is not running', () => {
    expect(liveSentence([sess([agent({ state: 'done' })], { endedAt: 1 })])).toBe('No session is running.');
    expect(liveSentence([])).toBe('No session is running.');
    expect(liveSentence([sess([agent()]), sess([agent()], { endedAt: 1 })])).toBe('1 session is running: 1 is working. Nothing is stalled.');
  });

  it('an unbacked claim and a pricier model are named only when there is one', () => {
    const claim = { kind: 'test', phrase: 'all pass', why: 'stale', ts: 1 };
    expect(liveSentence([sess([agent(), agent({ id: 'a1', state: 'done', unbacked: [claim] })])])).toBe('1 session is running: 1 is working. Nothing is stalled. 1 agent has an unbacked claim.');
    expect(liveSentence([sess([agent({ pricier: { allowed: 'sonnet', source: 'file' } }), agent({ id: 'a2', pricier: { allowed: 'sonnet', source: 'file' } })])]))
      .toBe('1 session is running: 1 is working. Nothing is stalled. 2 agents are on a pricier model.');
    expect(liveSentence([sess([agent()])])).not.toMatch(/claim|pricier/);
  });
});

describe("a session's own start and the figures as words", () => {
  const started = Date.parse('2026-10-19T16:23:43Z'); // the mock's first session

  it('started on another day reads as that day, started today as the time', () => {
    expect(startedLabel(started, NOW)).toBe('19 Oct');
    const today = new Date(2026, 9, 26, 9, 5).getTime();
    expect(startedLabel(today, new Date(2026, 9, 26, 16, 52).getTime())).toBe('09:05');
  });

  it('running for: days from two days on, then hours, then minutes', () => {
    expect(runFor(NOW - started)).toBe('6 days');
    expect(runFor(47 * 3_600_000)).toBe('47 hours');
    expect(runFor(48 * 3_600_000)).toBe('2 days');
    expect(runFor(3 * 3_600_000 + 5 * MIN)).toBe('3 hours');
    expect(runFor(3_600_000)).toBe('1 hour');
    expect(runFor(12 * MIN)).toBe('12 minutes');
    expect(runFor(20_000)).toBe('under a minute');
  });

  it('tokens read as a number and a unit: 4.9 M, 312 k, 8.1 B', () => {
    expect(readTokens(4_900_000)).toBe('4.9\u00a0M');
    expect(readTokens(312_400)).toBe('312\u00a0k');
    expect(readTokens(8_100_000_000)).toBe('8.1\u00a0B');
    expect(readTokens(950)).toBe('950');
    expect(readTokens(120_000_000)).toBe('120\u00a0M');
  });

  describe('the card', () => {
    beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
    afterEach(() => vi.unstubAllGlobals());
    const main = { id: 'main', type: 'main', role: 'orchestrator', depth: 0, state: 'working', tokens: 4_900_000, cost: 1.34, startedAt: started, lastTs: NOW, tasks: [], skills: [], calls: 1, failed: 0, model: 'claude-opus-5-5' } as any;
    const session = (o: Partial<Session> = {}): Session =>
      ({ id: 'b738da1234', project: 'mobile-app', branch: 'release/2.16', host: 'Alfredos-MBP-4', startedAt: started, lastTs: NOW, tokens: 4_900_000, cost: 1.34, costPartial: false, content: 'full', agents: [main], ...o }) as Session;
    const live = (s: Session, now = NOW) => renderToStaticMarkup(createElement(Live, { list: [s], all: { [s.id]: s }, now }));

    it('the page is titled Live, with the sentence under it', () => {
      const html = live(session());
      expect(html).toContain('<h1>Live</h1>');
      expect(read(html)).toContain('Live 1 session is running: 1 is working. Nothing is stalled.');
    });

    it('shows the start the session has, and how long it has run, not a clock that restarts', () => {
      expect(read(live(session()))).toContain('Alfredos-MBP-4 · session b738da · started 19 Oct · running 6 days');
    });

    it('says the figures as words: "4.9 M tokens so far · $1.34 at API prices" and "Context 41% full"', () => {
      const text = read(live(session({ contextPercent: 41 })));
      expect(text).toContain('4.9 M tokens so far · $1.34 at API prices'); // read() makes the non-breaking space a plain one
      expect(text).toContain('Context 41% full');
      expect(live(session({ contextPercent: 41 }))).toContain('role="img" aria-label="Context 41% full"');
      expect(text.slice(0, text.indexOf('How to read Live'))).not.toMatch(/API-equivalent/); // the card and the column say API cost and at API prices now; the explainer below keeps its words
    });

    it('before the first turn the context is not known, and says so', () => {
      expect(read(live(session()))).toContain('Context: known after the first turn');
    });

    it('near the limit the meter is amber and says so', () => {
      const html = live(session({ contextPercent: 86 }));
      expect(read(html)).toContain('Context 86% full · near the limit');
      expect(html).toContain('class="bar warn"');
    });

    it('an ended session keeps its start and says when it ended', () => {
      expect(read(live(session({ endedAt: NOW - 3 * MIN })))).toContain('started 19 Oct · ended 3m ago');
    });
  });
});
