import type { Event } from '@agent-orb/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { all, openStore } from '../src/store/store.ts';

// v0.4 slice 5 (#31, Factory; PROJECT.md §15): Live's Stop. The studio queues one stop per session, for the stall it was clicked on (the agent and the stall's `since`; POST /api/stop); the
// session's plugin takes it on its 60-second poll (GET /api/stop, with its token) and answers with a session.stopped event, which clears it. The tests send the plugin's events to /ingest,
// so the writer, the table and the route are held together.
const TOKEN = 'test-token-0123456789';
const MIN = 60_000;
const NOW0 = Date.parse('2026-11-06T12:00:00Z');
const STALL = { agent: 'main', since: NOW0 - 22 * MIN }; // the stall the studio showed: main, 22 minutes in

let n = 0;
const ev = (session: string, ts: number, kind: string, data: object): Event =>
  ({ v: 1, id: `00000000-0000-4000-b291-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'local', session_id: session, project: { cwd: '/Users/a/mobile-app', name: 'mobile-app' }, kind, data }) as Event;
const started = (session: string) => ev(session, NOW0 - 30 * MIN, 'session.start', { model: 'claude-sonnet-5-5', source: 'startup', claude_version: '2.1.316', plugin_version: '0.4.0' });
const stopped = (session: string, aborted = true, ts = NOW0) => ev(session, ts, 'session.stopped', { aborted });

let app: ReturnType<typeof buildApp>;
let NOW = NOW0;
beforeEach(() => {
  NOW = NOW0;
  app = buildApp({ token: TOKEN, now: () => NOW });
});
const send = async (...events: Event[]) => {
  const r = await app.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events } });
  expect(r.json()).toMatchObject({ accepted: events.length, rejected: 0 });
};
const queue = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: 'POST', url: '/api/stop', payload: body as object, headers });
  return { status: res.statusCode, body: res.json() };
};
const stopFor = (session: string, extra: object = {}) => ({ session, ...STALL, ...extra });
const take = async (session: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) => {
  const res = await app.inject({ url: `/api/stop?${new URLSearchParams({ session })}`, headers });
  return { status: res.statusCode, body: res.json() };
};

describe('queueing a stop', () => {
  it('queues one for a session the history has seen', async () => {
    await send(started('s-1'));
    expect(await queue(stopFor('s-1'))).toEqual({ status: 200, body: { session: 's-1', queued: true } });
  });

  it('a second POST while one waits changes nothing: it says it was already queued, and the stall it names stays the first\'s', async () => {
    await send(started('s-1'));
    await queue(stopFor('s-1'));
    expect((await queue(stopFor('s-1', { agent: 'a-child', since: NOW0 - MIN }))).body).toEqual({ session: 's-1', queued: false });
    expect((await take('s-1')).body).toEqual({ session: 's-1', stop: true, ...STALL });
  });

  it('404 for a session nobody has seen, 400 for anything else (the stall is named, or there is nothing to tie the stop to), and nothing is queued', async () => {
    expect((await queue(stopFor('ghost'))).status).toBe(404);
    await send(started('s-1'));
    for (const bad of [{}, { session: '' }, { session: 5 }, { session: ['s-1'] }, { session: 's-1' }, { session: 's-1', agent: 'main' }, { session: 's-1', since: 5 },
      { session: 's-1', agent: '', since: 5 }, { session: 's-1', agent: 'main', since: '5' }, { session: 's-1', agent: 'main', since: 1.5 }]) {
      expect((await queue(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await take('s-1')).body).toEqual({ session: 's-1', stop: false });
    expect((await take('ghost')).body).toEqual({ session: 'ghost', stop: false });
  });

  it('studio only: a page from another site is refused (403) and queues nothing, while the studio\'s own origin is taken', async () => {
    await send(started('s-1'));
    expect((await queue(stopFor('s-1'), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await take('s-1')).body.stop).toBe(false);
    expect((await queue(stopFor('s-1'), { origin: 'http://localhost:80' })).status).toBe(200); // inject's host is localhost:80
    expect((await take('s-1')).body.stop).toBe(true);
  });
});

describe('taking a stop', () => {
  it('hands it out once, with the stall it was clicked for: the next poll finds nothing, so the session is not stopped twice', async () => {
    await send(started('s-1'));
    await queue(stopFor('s-1'));
    expect((await take('s-1')).body).toEqual({ session: 's-1', stop: true, ...STALL });
    expect((await take('s-1')).body).toEqual({ session: 's-1', stop: false });
  });

  it('is per session: another session\'s poll finds nothing, and its stop is still there', async () => {
    await send(started('s-1'), started('s-2'));
    await queue(stopFor('s-1'));
    expect((await take('s-2')).body.stop).toBe(false);
    expect((await take('s-1')).body.stop).toBe(true);
  });

  it('400 without a session', async () => {
    const headers = { authorization: `Bearer ${TOKEN}` };
    expect((await app.inject({ url: '/api/stop', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/stop?session=', headers })).statusCode).toBe(400);
  });

  // #31 R10: a GET that changes state must not be a link any page or process can follow: `<img src="http://127.0.0.1:4040/api/stop?session=…">` takes the stop, the plugin never sees it, and
  // the studio shows Stopping for ever. It takes the plugin's token, as POST /ingest does.
  it('R10: needs the plugin\'s token: a request without it, with a wrong one or with the token in the query takes nothing and leaves the stop for the plugin', async () => {
    await send(started('s-1'));
    await queue(stopFor('s-1'));
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }, { authorization: `bearer ${TOKEN}` }, { origin: 'https://evil.example' }] as Record<string, string>[]) {
      const r = await take('s-1', headers);
      expect([r.status, r.body], JSON.stringify(headers)).toEqual([401, { error: 'unauthorized' }]);
    }
    expect((await app.inject({ url: `/api/stop?session=s-1&token=${TOKEN}` })).statusCode).toBe(401);
    expect((await take('s-1')).body).toEqual({ session: 's-1', stop: true, ...STALL }); // still there
  });

  it('a stop nobody took in ten minutes is dead: a session that comes back later is not stopped by it, and a new one can be queued', async () => {
    await send(started('s-1'));
    await queue(stopFor('s-1'));
    NOW = NOW0 + 10 * MIN + 1;
    expect((await take('s-1')).body.stop).toBe(false);
    expect((await queue(stopFor('s-1', { since: NOW0 }))).body.queued).toBe(true);
    expect((await take('s-1')).body).toEqual({ session: 's-1', stop: true, agent: 'main', since: NOW0 });
  });

  it('ten minutes to the millisecond still counts, as the refusal\'s age does', async () => {
    await send(started('s-1'));
    await queue(stopFor('s-1'));
    NOW = NOW0 + 10 * MIN;
    expect((await take('s-1')).body.stop).toBe(true);
  });
});

describe('session.stopped', () => {
  it('clears the stop, taken or not, so the next one queues again', async () => {
    await send(started('s-1'));
    await queue(stopFor('s-1'));
    await take('s-1');
    expect((await queue(stopFor('s-1'))).body.queued).toBe(false); // taken but not answered: still the one stop
    await send(stopped('s-1'));
    expect((await queue(stopFor('s-1'))).body.queued).toBe(true);
    expect((await take('s-1')).body.stop).toBe(true);
  });

  it('clears only its own session\'s stop', async () => {
    await send(started('s-1'), started('s-2'));
    await queue(stopFor('s-1'));
    await queue(stopFor('s-2'));
    await send(stopped('s-1', false));
    expect((await take('s-1')).body.stop).toBe(false);
    expect((await take('s-2')).body.stop).toBe(true);
  });

  // R26: the plugin's outbox can deliver an event late. It answers the stop that was waiting when it was made, so it does not clear one asked for after.
  it('R26: an answer made before a newer stop was asked for does not clear it', async () => {
    await send(started('s-1'));
    await queue(stopFor('s-1'));
    await take('s-1'); // taken; the plugin's answer (made at NOW0 + 1 s) is held up in its outbox
    NOW = NOW0 + 11 * MIN; // the stop has lapsed, and the person asks again
    expect((await queue(stopFor('s-1', { since: NOW }))).body.queued).toBe(true);
    await send(stopped('s-1', true, NOW0 + 1_000)); // the late answer arrives
    expect((await take('s-1')).body.stop).toBe(true); // the newer stop is still there
    await send(stopped('s-1', true, NOW + 1_000)); // its own answer clears it
    expect((await take('s-1')).body.stop).toBe(false);
  });
});

// The table is the server's alone: the plugin and the studio reach it through the two routes, so what it holds is checked directly here once.
describe('the table', () => {
  const ingest = (a: ReturnType<typeof buildApp>, ...events: Event[]) => a.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events } });

  it('holds one row per session, with the stall it was asked for, when it was asked for and when it was taken', async () => {
    const s = openStore(':memory:');
    const a = buildApp({ store: s, token: TOKEN, now: () => NOW });
    await ingest(a, started('s-1'));
    await a.inject({ method: 'POST', url: '/api/stop', payload: stopFor('s-1') });
    NOW += 30_000;
    await a.inject({ method: 'POST', url: '/api/stop', payload: stopFor('s-1') }); // the second asks again: the first's time stays
    expect(all(s, 'SELECT * FROM stops')).toEqual([{ session_id: 's-1', requested_at: NOW0, picked_at: null, agent: 'main', stall_since: STALL.since }]);
    await a.inject({ url: '/api/stop?session=s-1', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(all(s, 'SELECT * FROM stops')).toEqual([{ session_id: 's-1', requested_at: NOW0, picked_at: NOW0 + 30_000, agent: 'main', stall_since: STALL.since }]);
    await ingest(a, stopped('s-1', true, NOW));
    expect(all(s, 'SELECT * FROM stops')).toEqual([]);
  });

  // R27: a session that never answers (closed, plugin off) leaves its row. They are tiny, and a new request prunes the expired ones in the one statement it already makes.
  it('R27: a stop that lapsed for a session that never answered is pruned by the next request, anyone\'s', async () => {
    const s = openStore(':memory:');
    const a = buildApp({ store: s, token: TOKEN, now: () => NOW });
    await ingest(a, started('s-1'), started('s-2'));
    await a.inject({ method: 'POST', url: '/api/stop', payload: stopFor('s-1') });
    NOW += 5 * MIN;
    await a.inject({ method: 'POST', url: '/api/stop', payload: stopFor('s-2') });
    expect(all(s, 'SELECT session_id FROM stops ORDER BY session_id')).toEqual([{ session_id: 's-1' }, { session_id: 's-2' }]); // s-1's is still live
    NOW += 6 * MIN; // s-1's is now 11 minutes old, s-2's 6
    await a.inject({ method: 'POST', url: '/api/stop', payload: stopFor('s-2') });
    expect(all(s, 'SELECT session_id FROM stops')).toEqual([{ session_id: 's-2' }]);
  });
});
