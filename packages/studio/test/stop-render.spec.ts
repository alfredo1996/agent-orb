import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Live, NeedRow, type Session } from '../src/Live.tsx';
import { needs, sendStop, STOPPED_MS, type Need } from '../src/live-cards.ts';

// Live's Stop (v0.4 slice 5, #31; design/v0.4-factory.html, the Stop board): a Stop turn button on a stalled session's row in Needs you, that asks in place, then shows Stopping until the
// session's event arrives, then Stopped; a background agent gets no button. The views are rendered to markup, which runs no effects: what each state draws is checked here, and the click
// behind each (the request it sends) through `sendStop`.
const T = Date.parse('2026-11-06T12:00:00Z');
const MIN = 60_000;
const read = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].map((m) => ({ label: read(m[2]!), disabled: /\bdisabled\b/.test(m[1]!), danger: /\bdanger\b/.test(m[1]!) }));

const agent = (o: object = {}) => ({ id: 'a1', type: 'implementer', depth: 1, parent: 'main', state: 'stalled', tokens: 0, cost: 0, startedAt: T - 30 * MIN, lastTs: T - 22 * MIN, tasks: [], skills: [], calls: 3, failed: 0,
  tool: { name: 'Bash', id: 't1', since: T - 22 * MIN, waiting: false }, now: { label: 'Bash', text: 'pnpm test:e2e' }, model: 'claude-sonnet-5-5', ...o }) as any;
const main = (o: object = {}) => agent({ id: 'main', type: 'main', depth: 0, parent: undefined, state: 'working', tool: undefined, now: undefined, ...o });
const session = (agents: any[], o: Partial<Session> = {}): Session =>
  ({ id: 's-1234567', project: 'mobile-app', branch: 'fix/415-sync-dialog', host: 'mbp', startedAt: T - 40 * MIN, lastTs: T, tokens: 1e6, cost: 2, costPartial: false, content: 'full', agents, ...o }) as Session;

const stalled = (): Need => needs([session([main(), agent()])], T)[0]!;
const row = (n: Need, mode: Parameters<typeof NeedRow>[0]['mode'], extra: object = {}) =>
  renderToStaticMarkup(createElement(NeedRow, { n, project: 'mobile-app', branch: 'fix/415-sync-dialog', now: T, mode, onOpen: () => {}, onStop: () => {}, ...extra }));

describe('needs: what the Stop button is offered for', () => {
  it('a stalled foreground agent is stoppable; a stalled background one says so; a wait for a permission is neither', () => {
    expect(stalled()).toMatchObject({ session: 's-1234567', agent: 'a1', tone: 'bad', tool: 'Bash' });
    expect(stalled()).not.toHaveProperty('background');
    expect(needs([session([main(), agent({ background: true })])], T)[0]).toMatchObject({ tone: 'bad', background: true });
    expect(needs([session([main(), agent({ state: 'waiting', waitingFor: 'permission' })])], T)[0]).not.toHaveProperty('background');
  });

  it('a session the studio stopped is listed as stopped, with when and whether anything ran, for ten minutes', () => {
    const s = (o: object) => [session([main({ state: 'waiting', waitingFor: 'prompt' })], o)];
    expect(needs(s({ stoppedAt: T - 5_000, stoppedAborted: true }), T)).toEqual([{ session: 's-1234567', agent: 'main', type: 'main', tone: 'stopped', since: T - 5_000, aborted: true }]);
    expect(needs(s({ stoppedAt: T - STOPPED_MS + 1, stoppedAborted: false }), T)[0]).toMatchObject({ tone: 'stopped', aborted: false });
    expect(needs(s({ stoppedAt: T - STOPPED_MS }), T)).toEqual([]); // ten minutes on, the row has gone
    expect(needs(s({}), T)).toEqual([]);
    expect(needs(s({ stoppedAt: T - 5_000 })).length).toBe(0); // no clock, no stopped row: it cannot be told how old it is
  });

  it('the stopped row comes after what is waiting or stalled, which is what the person is there for', () => {
    const list = needs([session([main(), agent()], { id: 's-a', stoppedAt: T - 1000, stoppedAborted: true }), session([main({ state: 'waiting', waitingFor: 'permission', tool: { name: 'Bash', id: 'p', since: T - 60_000, waiting: true } })], { id: 's-b' })], T);
    expect(list.map((n) => n.tone)).toEqual(['bad', 'wait', 'stopped']);
  });
});

describe('the Stop button, state by state', () => {
  it('stalled: one Stop turn button beside Open, and nothing asked yet', () => {
    const html = row(stalled(), 'ask');
    expect(buttons(html)).toEqual([{ label: 'Open', disabled: false, danger: false }, { label: 'Stop turn', disabled: false, danger: false }]);
    expect(read(html)).toContain('is stuck on Bash');
    expect(read(html)).not.toContain('Stop this session');
  });

  it('confirm: asks in place, says what it does and that it takes up to a minute, and offers Stop turn (marked dangerous) or Keep waiting', () => {
    const html = row(stalled(), 'confirm');
    expect(read(html)).toContain("Stop this session's turn? Its running tools stop and the session stays open. It reaches the session within a minute.");
    expect(buttons(html)).toEqual([
      { label: 'Open', disabled: false, danger: false },
      { label: 'Stop turn', disabled: false, danger: true },
      { label: 'Keep waiting', disabled: false, danger: false },
    ]);
    expect(html).toContain('role="group"');
  });

  it('sent: says it was sent and is waiting for the session, with the button disabled and called Stopping', () => {
    const html = row(stalled(), 'sent');
    expect(read(html)).toContain('Stop sent, waiting for the session to pick it up');
    expect(buttons(html)).toEqual([{ label: 'Open', disabled: false, danger: false }, { label: 'Stopping', disabled: true, danger: false }]);
  });

  it('failed: the request did not reach the server, and Stop turn can be tried again', () => {
    const html = row(stalled(), 'failed');
    expect(read(html)).toContain('The stop did not reach the server. Try again.');
    expect(buttons(html).map((b) => b.label)).toEqual(['Open', 'Stop turn']);
    expect(buttons(html)[1]!.disabled).toBe(false);
  });

  it('stopped: the state reads Stopped, and says the session is open and idle; nothing left to press', () => {
    const n = needs([session([main({ state: 'waiting', waitingFor: 'prompt' })], { stoppedAt: T - 3_000, stoppedAborted: true })], T)[0]!;
    const html = row(n, 'ask');
    expect(html).toContain('<span class="state stopped">stopped</span>');
    expect(read(html)).toContain('mobile-app · fix/415-sync-dialog');
    expect(read(html)).toContain('Stopped from the studio. The session is open and idle.');
    expect(buttons(html)).toEqual([]);
  });

  it('stopped, with nothing running when the stop arrived: it says so', () => {
    const n = needs([session([main({ state: 'waiting', waitingFor: 'prompt' })], { stoppedAt: T - 3_000, stoppedAborted: false })], T)[0]!;
    expect(read(row(n, 'ask'))).toContain('Nothing was running when the stop arrived. The session is open and idle.');
  });

  it('a background agent gets no button, and the row says where to stop it', () => {
    const n = needs([session([main(), agent({ background: true })])], T)[0]!;
    const html = row(n, 'ask');
    expect(read(html)).toContain("A background agent can't be stopped from here. Use agent view.");
    expect(buttons(html)).toEqual([{ label: 'Open', disabled: false, danger: false }]);
    expect(buttons(row(n, 'confirm'))).toEqual([{ label: 'Open', disabled: false, danger: false }]); // whatever the session's state says
  });

  it('a wait for a permission, an unbacked claim and a pricier model have no Stop: only a stalled session does', () => {
    const wait = needs([session([main(), agent({ state: 'waiting', waitingFor: 'permission' })])], T)[0]!;
    const pricier = needs([session([main(), agent({ state: 'working', pricier: { allowed: 'sonnet', source: 'file' }, model: 'claude-opus-5-5' })])], T)[0]!;
    for (const n of [wait, pricier]) expect(buttons(row(n, 'ask')).map((b) => b.label), n.tone).toEqual(['Open']);
  });
});

describe('Live', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  afterEach(() => vi.unstubAllGlobals());

  it('draws Stop turn for a stalled session and none for a session that is only working', () => {
    const live = (agents: any[]) => renderToStaticMarkup(createElement(Live, { list: [session(agents)], all: {}, now: T }));
    expect(buttons(live([main(), agent()])).map((b) => b.label)).toContain('Stop turn');
    expect(buttons(live([main(), agent({ state: 'working' })])).map((b) => b.label)).not.toContain('Stop turn');
  });
});

describe('sendStop: the request behind the button', () => {
  it('POSTs the session to /api/stop as JSON, and is true when the server took it', async () => {
    const fetcher = vi.fn(async () => ({ ok: true }) as Response);
    expect(await sendStop('s-1234567', fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 's-1234567' }) });
  });

  it('is false when the server refused it or could not be reached', async () => {
    expect(await sendStop('s-1', async () => ({ ok: false, status: 404 }) as Response)).toBe(false);
    expect(await sendStop('s-1', async () => { throw new Error('offline'); })).toBe(false);
  });
});
