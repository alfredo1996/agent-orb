import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Live, NeedRow, type Session } from '../src/Live.tsx';
import { loadStops, needKey, needs, saveStops, sendStop, stopClick, stopKey, stopMode, STOP_LAPSE_MS, STOPPED_MS, type Need, type StopMode, type StopState } from '../src/live-cards.ts';

// Live's Stop (v0.4 slice 5, #31; design/v0.4-factory.html, the Stop board): a Stop turn button on a stalled session's row in Needs you, that asks in place, then shows Stopping until the
// session's event arrives, then Stopped; a background agent gets no button. The views are rendered to markup, which runs no effects: what each state draws is checked here. The click behind
// each is checked without a DOM: NeedRow is a plain function of its props, so its buttons' handlers are taken from the element it returns, and what a click does is `stopClick`.
const T = Date.parse('2026-11-06T12:00:00Z');
const MIN = 60_000;
const read = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].map((m) => ({ label: read(m[2]!), disabled: /\bdisabled\b/.test(m[1]!), danger: /\bdanger\b/.test(m[1]!) }));

const agent = (o: object = {}) => ({ id: 'a1', type: 'implementer', depth: 1, parent: 'main', state: 'stalled', stalledSince: T - 22 * MIN, tokens: 0, cost: 0, startedAt: T - 30 * MIN, lastTs: T - 22 * MIN, tasks: [], skills: [], calls: 3, failed: 0,
  tool: { name: 'Bash', id: 't1', since: T - 22 * MIN, waiting: false }, now: { label: 'Bash', text: 'pnpm test:e2e' }, model: 'claude-sonnet-5-5', ...o }) as any;
const main = (o: object = {}) => agent({ id: 'main', type: 'main', depth: 0, parent: undefined, state: 'working', tool: undefined, now: undefined, stalledSince: undefined, ...o });
const session = (agents: any[], o: Partial<Session> = {}): Session =>
  ({ id: 's-1234567', project: 'mobile-app', branch: 'fix/415-sync-dialog', host: 'mbp', startedAt: T - 40 * MIN, lastTs: T, tokens: 1e6, cost: 2, costPartial: false, content: 'full', agents, ...o }) as Session;

const stalled = (): Need => needs([session([main(), agent()])], T)[0]!;
type Props = Parameters<typeof NeedRow>[0];
const props = (n: Need, mode: StopMode, extra: Partial<Props> = {}): Props => ({ n, project: 'mobile-app', branch: 'fix/415-sync-dialog', now: T, mode, onOpen: () => {}, onStop: () => {}, ...extra });
const row = (n: Need, mode: StopMode, extra: Partial<Props> = {}) => renderToStaticMarkup(createElement(NeedRow, props(n, mode, extra)));

describe('needs: what the Stop button is offered for', () => {
  it('a stalled foreground agent is stoppable; a stalled background one says so; a wait for a permission is neither', () => {
    expect(stalled()).toMatchObject({ session: 's-1234567', agent: 'a1', tone: 'bad', tool: 'Bash' });
    expect(stalled()).not.toHaveProperty('background');
    expect(needs([session([main(), agent({ background: true })])], T)[0]).toMatchObject({ tone: 'bad', background: true });
    expect(needs([session([main(), agent({ state: 'waiting', waitingFor: 'permission' })])], T)[0]).not.toHaveProperty('background');
  });

  // R5: only the spawned agent carries `background`; whatever it starts runs apart from the turn too, so a Stop that ends main's turn does not reach it either.
  it('R5: an agent under a background agent is a background agent, however deep; one under a foreground agent is not', () => {
    const tree = (bg: boolean) => session([main(), agent({ id: 'a1', parent: 'main', state: 'working', stalledSince: undefined, tool: undefined, ...(bg && { background: true }) }),
      agent({ id: 'a2', parent: 'a1', state: 'working', stalledSince: undefined, tool: undefined }), agent({ id: 'a3', parent: 'a2' })]);
    expect(needs([tree(true)], T)).toEqual([expect.objectContaining({ agent: 'a3', tone: 'bad', background: true })]);
    expect(needs([tree(false)], T)[0]).not.toHaveProperty('background');
  });

  it('R5: a loop in the parents (it should not happen) neither hangs nor makes anything a background agent', () => {
    const loop = session([agent({ id: 'a1', parent: 'a2' }), agent({ id: 'a2', parent: 'a1', state: 'working' })]);
    expect(needs([loop], T).map((n) => n.background)).toEqual([undefined]);
  });

  // R11: a stall with no tool running (a hung model step) has no tool start to count from. The plugin's stall time is the one thing that tells one stall from another.
  it('R11: a stall with no tool running counts from when the stall began, and is told from another stall by it', () => {
    const quiet = (id: string, since: number) => agent({ id, tool: undefined, now: undefined, stalledSince: since });
    const [a, b] = needs([session([main(), quiet('a1', T - 20 * MIN), quiet('a2', T - 18 * MIN)])], T);
    expect([a!.since, b!.since]).toEqual([T - 20 * MIN, T - 18 * MIN]);
    expect(new Set([stopKey(a!), stopKey(b!)]).size).toBe(2);
    expect(stopKey({ ...a!, since: T - 5 * MIN })).not.toBe(stopKey(a!)); // a later stall of the same agent starts from the button again
    expect(stopKey({ ...a!, session: 's-other' })).not.toBe(stopKey(a!));
  });

  it('a stall that began while a tool ran is the stall\'s time, not the tool\'s; with neither, the row has none', () => {
    expect(stalled().since).toBe(T - 22 * MIN);
    expect(needs([session([main(), agent({ stalledSince: T - 20 * MIN })])], T)[0]!.since).toBe(T - 20 * MIN);
    expect(needs([session([main(), agent({ stalledSince: undefined })])], T)[0]!.since).toBe(T - 22 * MIN);
    expect(needs([session([main(), agent({ stalledSince: undefined, tool: undefined, now: undefined })])], T)[0]!.since).toBeUndefined();
  });

  it('a session the studio stopped is listed as stopped, with when and whether anything was stopped, for ten minutes', () => {
    const s = (o: object) => [session([main({ state: 'waiting', waitingFor: 'prompt' })], o)];
    expect(needs(s({ stoppedAt: T - 5_000, stoppedAborted: true }), T)).toEqual([{ session: 's-1234567', agent: 'main', type: 'main', tone: 'stopped', since: T - 5_000, aborted: true }]);
    expect(needs(s({ stoppedAt: T - STOPPED_MS + 1, stoppedAborted: false }), T)[0]).toMatchObject({ tone: 'stopped', aborted: false });
    expect(needs(s({ stoppedAt: T - STOPPED_MS }), T)).toEqual([]); // ten minutes on, the row has gone
    expect(needs(s({}), T)).toEqual([]);
    expect(needs(s({ stoppedAt: T - 5_000 })).length).toBe(0); // no clock, no stopped row: it cannot be told how old it is
  });

  it('R24: a stopped row of a session that has ended says so', () => {
    const n = needs([session([main({ state: 'done' })], { stoppedAt: T - 5_000, stoppedAborted: true, endedAt: T - 1_000 })], T)[0]!;
    expect(n).toMatchObject({ tone: 'stopped', ended: true });
    expect(needs([session([main()], { stoppedAt: T - 5_000, stoppedAborted: true })], T)[0]).not.toHaveProperty('ended');
  });

  it('the stopped row comes after what is waiting or stalled, which is what the person is there for', () => {
    const list = needs([session([main(), agent()], { id: 's-a', stoppedAt: T - 1000, stoppedAborted: true }), session([main({ state: 'waiting', waitingFor: 'permission', tool: { name: 'Bash', id: 'p', since: T - 60_000, waiting: true } })], { id: 's-b' })], T);
    expect(list.map((n) => n.tone)).toEqual(['bad', 'wait', 'stopped']);
  });
});

describe('the Stop button, state by state (the mockup\'s Stop board)', () => {
  it('stalled: the row is the project and branch, with the agent on its command; one Stop turn button beside Open, and nothing asked yet', () => {
    const html = row(stalled(), 'ask');
    expect(buttons(html)).toEqual([{ label: 'Open', disabled: false, danger: false }, { label: 'Stop turn', disabled: false, danger: false }]);
    expect(read(html)).toContain('mobile-app · fix/415-sync-dialog implementer on pnpm test:e2e');
    expect(html).toContain('<code>pnpm test:e2e</code>');
    expect(read(html)).not.toContain('Stop this session');
    expect(read(html)).toContain('22m 0s'); // how long it has been stuck
  });

  it('stalled with Content off (no command): the agent on its tool; with neither, on its last step', () => {
    const off = needs([session([main(), agent({ now: undefined })])], T)[0]!;
    expect(read(row(off, 'ask'))).toContain('implementer on Bash');
    const quiet = needs([session([main(), agent({ now: undefined, tool: undefined })])], T)[0]!;
    expect(read(row(quiet, 'ask'))).toContain('implementer on its last step');
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

  it('R22: sent: says it was sent and is waiting for the session, how many seconds ago, with the button disabled and called Stopping', () => {
    const html = row(stalled(), 'sent', { sentAt: T - 12_000 });
    expect(read(html)).toContain('mobile-app · fix/415-sync-dialog Stop sent, waiting for the session to pick it up');
    expect(read(html)).toContain('12s');
    expect(read(html)).not.toContain('22m');
    expect(buttons(html)).toEqual([{ label: 'Open', disabled: false, danger: false }, { label: 'Stopping', disabled: true, danger: false }]);
  });

  it('failed: the request did not reach the server, and Stop turn can be tried again', () => {
    const html = row(stalled(), 'failed');
    expect(read(html)).toContain('The stop did not reach the server. Try again.');
    expect(buttons(html).map((b) => b.label)).toEqual(['Open', 'Stop turn']);
    expect(buttons(html)[1]!.disabled).toBe(false);
  });

  it('R12: gone (the server answered 404) does not say it was unreachable; lapsed (nobody took it in ten minutes) says so; both can be asked again', () => {
    const gone = row(stalled(), 'gone');
    expect(read(gone)).toContain("The server has no record of this session. Reload the page, or stop it at its terminal.");
    expect(read(gone)).not.toContain('did not reach');
    const lapsed = row(stalled(), 'lapsed');
    expect(read(lapsed)).toContain('The session did not pick the stop up. Try again.');
    for (const html of [gone, lapsed]) expect(buttons(html).map((b) => b.label)).toEqual(['Open', 'Stop turn']);
  });

  it('R22: stopped: the state reads Stopped, the title is the project and branch, it says now, and says the session is open and idle; nothing left to press', () => {
    const n = needs([session([main({ state: 'waiting', waitingFor: 'prompt' })], { stoppedAt: T - 3_000, stoppedAborted: true })], T)[0]!;
    const html = row(n, 'ask');
    expect(html).toContain('<span class="state stopped">stopped</span>');
    expect(read(html)).toContain('mobile-app · fix/415-sync-dialog Stopped from the studio. The session is open and idle.');
    expect(html).toMatch(/<span class="since num">now<\/span>/);
    expect(buttons(html)).toEqual([]);
  });

  it('stopped, with nothing stopped: the stall had ended before the stop arrived', () => {
    const n = needs([session([main({ state: 'waiting', waitingFor: 'prompt' })], { stoppedAt: T - 3_000, stoppedAborted: false })], T)[0]!;
    expect(read(row(n, 'ask'))).toContain('The stall had ended before the stop arrived; nothing was stopped.');
    expect(read(row(n, 'ask'))).not.toContain('open and idle');
  });

  it('R24: stopped, and the session has since ended: it no longer says the session is open', () => {
    const n = needs([session([main({ state: 'done' })], { stoppedAt: T - 3_000, stoppedAborted: true, endedAt: T - 1_000 })], T)[0]!;
    expect(read(row(n, 'ask'))).toContain('Stopped from the studio. The session has ended.');
    expect(read(row(n, 'ask'))).not.toContain('open and idle');
  });

  it('a background agent gets no button, and the row (project and branch) says where to stop it', () => {
    const n = needs([session([main(), agent({ background: true })])], T)[0]!;
    const html = row(n, 'ask');
    expect(read(html)).toContain("mobile-app · fix/415-sync-dialog A background agent can't be stopped from here. Use agent view.");
    expect(buttons(html)).toEqual([{ label: 'Open', disabled: false, danger: false }]);
    expect(buttons(row(n, 'confirm'))).toEqual([{ label: 'Open', disabled: false, danger: false }]); // whatever the session's state says
  });

  it('a wait for a permission and a pricier model have no Stop: only a stalled session does', () => {
    const wait = needs([session([main(), agent({ state: 'waiting', waitingFor: 'permission' })])], T)[0]!;
    const pricier = needs([session([main(), agent({ state: 'working', stalledSince: undefined, pricier: { allowed: 'sonnet', source: 'file' }, model: 'claude-opus-5-5' })])], T)[0]!;
    for (const n of [wait, pricier]) expect(buttons(row(n, 'ask')).map((b) => b.label), n.tone).toEqual(['Open']);
  });
});

describe('the state a row shows', () => {
  it('R12: a stop sent more than ten minutes ago, which the server no longer hands out, has lapsed; before that it is still waiting', () => {
    expect(stopMode({ mode: 'sent', at: T - STOP_LAPSE_MS + 1 }, T)).toBe('sent');
    expect(stopMode({ mode: 'sent', at: T - STOP_LAPSE_MS }, T)).toBe('lapsed');
    expect(stopMode(undefined, T)).toBe('ask');
    expect(stopMode({ mode: 'confirm' }, T)).toBe('confirm');
    expect(stopMode({ mode: 'failed' }, T + STOP_LAPSE_MS)).toBe('failed');
  });
});

describe('Live', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  afterEach(() => vi.unstubAllGlobals());
  const live = (list: Session[]) => renderToStaticMarkup(createElement(Live, { list, all: {}, now: T }));

  it('draws Stop turn for a stalled session and none for a session that is only working', () => {
    expect(buttons(live([session([main(), agent()])])).map((b) => b.label)).toContain('Stop turn');
    expect(buttons(live([session([main(), agent({ state: 'working', stalledSince: undefined })])])).map((b) => b.label)).not.toContain('Stop turn');
  });

  it('R24: the header counts agents, and the stopped session by itself', () => {
    const hint = (list: Session[]) => /<h2 id="needs-h">Needs you <span class="hint">(.*?)<\/span>/.exec(live(list))?.[1];
    const stopped = { stoppedAt: T - 3_000, stoppedAborted: true };
    expect(hint([session([main(), agent()])])).toBe('1 agent');
    expect(hint([session([main({ state: 'waiting', waitingFor: 'prompt' })], stopped)])).toBe('1 stopped');
    expect(hint([session([main(), agent()], stopped)])).toBe('1 agent · 1 stopped');
  });

  it('R23: a stopped session and a claim of the same main agent are two rows, and no two rows of a board share a key', () => {
    const claim = { kind: 'test', phrase: 'all tests pass', why: 'no_run', ts: T - MIN };
    const both = session([main({ state: 'done', unbacked: [claim] })], { stoppedAt: T - 3_000, stoppedAborted: true });
    const rows = needs([both], T);
    expect(rows.map((n) => n.tone)).toEqual(['stopped', 'claim']);
    expect(new Set(rows.map(needKey)).size).toBe(2);
    const html = live([both]);
    expect(html).toContain('said');
    expect(html).toContain('Stopped from the studio');
    const board = needs([session([main({ state: 'done', unbacked: [claim] }), agent(), agent({ id: 'a2', state: 'waiting', waitingFor: 'permission' })], { stoppedAt: T - 3_000, stoppedAborted: true })], T);
    expect(new Set(board.map(needKey)).size).toBe(board.length);
  });
});

// R16: what a click does. NeedRow is a plain function of its props (no hooks), so the element it returns is walked for its buttons and their handlers are called, the way a click does.
const buttonsOf = (el: ReactNode): { label: string; click: (e?: unknown) => void }[] => {
  const out: { label: string; click: (e?: unknown) => void }[] = [];
  const text = (n: ReactNode): string => (Array.isArray(n) ? n.map(text).join('') : typeof n === 'string' || typeof n === 'number' ? String(n) : (n as ReactElement | null)?.props ? text((n as ReactElement<{ children?: ReactNode }>).props.children) : '');
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    const e = n as ReactElement<{ children?: ReactNode; onClick?: (e?: unknown) => void }> | null;
    if (!e || typeof e !== 'object' || !('props' in e)) return;
    if (e.type === 'button' && e.props.onClick) out.push({ label: text(e.props.children), click: e.props.onClick });
    walk(e.props.children);
  };
  walk(el);
  return out;
};
const click = (n: Need, mode: StopMode, label: string, onStop = vi.fn()) => {
  const b = buttonsOf(NeedRow(props(n, mode, { onStop })) as ReactNode).filter((x) => x.label === label);
  expect(b, `${label} in ${mode}`).toHaveLength(1);
  b[0]!.click();
  return onStop;
};

describe('R16: Stop turn asks first; only the confirm\'s button sends', () => {
  it('the row\'s Stop turn only asks; the confirm\'s Stop turn sends; Keep waiting backs out; Open asks nothing', () => {
    expect(click(stalled(), 'ask', 'Stop turn').mock.calls).toEqual([['confirm']]);
    expect(click(stalled(), 'failed', 'Stop turn').mock.calls).toEqual([['confirm']]); // a retry asks again too
    expect(click(stalled(), 'confirm', 'Stop turn').mock.calls).toEqual([['sent']]);
    expect(click(stalled(), 'confirm', 'Keep waiting').mock.calls).toEqual([['ask']]);
    const onStop = vi.fn();
    const open = vi.fn();
    buttonsOf(NeedRow(props(stalled(), 'ask', { onStop, onOpen: open })) as ReactNode).find((b) => b.label === 'Open')!.click({ currentTarget: 'the button' });
    expect(open.mock.calls).toEqual([['s-1234567', 'a1', 'the button']]);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('while Stopping, the disabled button has no handler at all', () => {
    expect(buttonsOf(NeedRow(props(stalled(), 'sent', { sentAt: T })) as ReactNode).map((b) => b.label)).toEqual(['Open']);
  });

  const ask = { session: 's-1234567', agent: 'a1', since: T - 22 * MIN };
  const run = (to: 'ask' | 'confirm' | 'sent', send: (a: typeof ask) => Promise<'sent' | 'gone' | 'failed'>) => {
    const states: StopState[] = [];
    stopClick(to, ask, (s) => states.push(s), () => T, send);
    return states;
  };

  it('asking, or backing out, sends nothing', () => {
    const send = vi.fn(async () => 'sent' as const);
    expect(run('confirm', send)).toEqual([{ mode: 'confirm' }]);
    expect(run('ask', send)).toEqual([{ mode: 'ask' }]);
    expect(send).not.toHaveBeenCalled();
  });

  it('sending shows Stopping at once, with when, and sends the stall it was clicked for once; the server taking it leaves it Stopping', async () => {
    const send = vi.fn(async () => 'sent' as const);
    const states = run('sent', send);
    expect(states).toEqual([{ mode: 'sent', at: T }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(send.mock.calls).toEqual([[ask]]);
    expect(states).toEqual([{ mode: 'sent', at: T }]);
  });

  it('a request that did not reach the server shows failed; one the server knows nothing of shows gone', async () => {
    for (const result of ['failed', 'gone'] as const) {
      const states = run('sent', async () => result);
      await new Promise((r) => setTimeout(r, 0));
      expect(states, result).toEqual([{ mode: 'sent', at: T }, { mode: result }]);
    }
  });
});

describe('sendStop: the request behind the button', () => {
  const ask = { session: 's-1234567', agent: 'a1', since: T - 22 * MIN };

  it('POSTs the session and the stall to /api/stop as JSON, and is sent when the server took it', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    expect(await sendStop(ask, fetcher)).toBe('sent');
    expect(fetcher).toHaveBeenCalledWith('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ask) });
  });

  it('R12: gone for a 404, failed for any other refusal or for a server that could not be reached', async () => {
    expect(await sendStop(ask, async () => ({ ok: false, status: 404 }) as Response)).toBe('gone');
    expect(await sendStop(ask, async () => ({ ok: false, status: 400 }) as Response)).toBe('failed');
    expect(await sendStop(ask, async () => ({ ok: false, status: 403 }) as Response)).toBe('failed');
    expect(await sendStop(ask, async () => { throw new Error('offline'); })).toBe('failed');
  });
});

describe('R12: a Stopping row survives a reload, for as long as the server holds the stop', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as Storage;
  };

  it('keeps what was sent, and only that: asking and failing are the page\'s', () => {
    const storage = memory();
    saveStops({ 'a:b:1': { mode: 'sent', at: T - 5_000 }, 'a:b:2': { mode: 'confirm' }, 'a:b:3': { mode: 'failed' } }, storage);
    expect(loadStops(T, storage)).toEqual({ 'a:b:1': { mode: 'sent', at: T - 5_000 } });
  });

  it('drops a stop sent more than ten minutes ago, which the server has let go of', () => {
    const storage = memory();
    saveStops({ old: { mode: 'sent', at: T - STOP_LAPSE_MS }, fresh: { mode: 'sent', at: T - STOP_LAPSE_MS + 1 } }, storage);
    expect(Object.keys(loadStops(T, storage))).toEqual(['fresh']);
  });

  it('no storage, a storage that throws, or text that is not ours: nothing kept, and nothing broken', () => {
    expect(loadStops(T, undefined)).toEqual({});
    expect(() => saveStops({ k: { mode: 'sent', at: T } }, undefined)).not.toThrow();
    const hostile = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    expect(loadStops(T, hostile)).toEqual({});
    expect(() => saveStops({ k: { mode: 'sent', at: T } }, hostile)).not.toThrow();
    for (const text of ['', 'null', '[]', '{"a":5}', '{"a":{"mode":"sent"}}', '{"a":{"mode":"sent","at":"now"}}', 'not json']) {
      const s = memory();
      s.setItem('orb.stops', text);
      expect(loadStops(T, s), text).toEqual({});
    }
  });
});
