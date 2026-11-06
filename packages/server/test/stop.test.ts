import type { Event } from '@agent-orb/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { all, openStore } from '../src/store/store.ts';

// v0.4 slice 5 (#31, Factory; PROJECT.md §15): Live's Stop. The studio queues one stop per session (POST /api/stop); the session's plugin takes it on its 60-second poll (GET /api/stop) and
// answers with a session.stopped event, which clears it. The tests send the plugin's events to /ingest, so the writer, the table and the route are held together.
const TOKEN = 'test-token-0123456789';
const MIN = 60_000;
const NOW0 = Date.parse('2026-11-06T12:00:00Z');

let n = 0;
const ev = (session: string, ts: number, kind: string, data: object): Event =>
  ({ v: 1, id: `00000000-0000-4000-b291-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'local', session_id: session, project: { cwd: '/Users/a/mobile-app', name: 'mobile-app' }, kind, data }) as Event;
const started = (session: string) => ev(session, NOW0 - 30 * MIN, 'session.start', { model: 'claude-sonnet-5-5', source: 'startup', claude_version: '2.1.316', plugin_version: '0.4.0' });
const stopped = (session: string, aborted = true) => ev(session, NOW0, 'session.stopped', { aborted });

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
const take = async (session: string) => {
  const res = await app.inject({ url: `/api/stop?${new URLSearchParams({ session })}` });
  return { status: res.statusCode, body: res.json() };
};

describe('queueing a stop', () => {
  it('queues one for a session the history has seen', async () => {
    await send(started('s-1'));
    expect(await queue({ session: 's-1' })).toEqual({ status: 200, body: { session: 's-1', queued: true } });
  });

  it('a second POST while one waits changes nothing: it says it was already queued', async () => {
    await send(started('s-1'));
    await queue({ session: 's-1' });
    expect((await queue({ session: 's-1' })).body).toEqual({ session: 's-1', queued: false });
    expect((await take('s-1')).body).toEqual({ session: 's-1', stop: true });
  });

  it('404 for a session nobody has seen, 400 for anything else, and nothing is queued', async () => {
    expect((await queue({ session: 'ghost' })).status).toBe(404);
    for (const bad of [{}, { session: '' }, { session: 5 }, { session: ['s-1'] }]) expect((await queue(bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await take('ghost')).body).toEqual({ session: 'ghost', stop: false });
  });

  it('studio only: a page from another site is refused (403) and queues nothing, while the studio\'s own origin is taken', async () => {
    await send(started('s-1'));
    expect((await queue({ session: 's-1' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await take('s-1')).body.stop).toBe(false);
    expect((await queue({ session: 's-1' }, { origin: 'http://localhost:80' })).status).toBe(200); // inject's host is localhost:80
    expect((await take('s-1')).body.stop).toBe(true);
  });
});

describe('taking a stop', () => {
  it('hands it out once: the next poll finds nothing, so the session is not stopped twice', async () => {
    await send(started('s-1'));
    await queue({ session: 's-1' });
    expect((await take('s-1')).body).toEqual({ session: 's-1', stop: true });
    expect((await take('s-1')).body).toEqual({ session: 's-1', stop: false });
  });

  it('is per session: another session\'s poll finds nothing, and its stop is still there', async () => {
    await send(started('s-1'), started('s-2'));
    await queue({ session: 's-1' });
    expect((await take('s-2')).body.stop).toBe(false);
    expect((await take('s-1')).body.stop).toBe(true);
  });

  it('400 without a session', async () => {
    expect((await app.inject({ url: '/api/stop' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/stop?session=' })).statusCode).toBe(400);
  });

  it('a stop nobody took in ten minutes is dead: a session that comes back later is not stopped by it, and a new one can be queued', async () => {
    await send(started('s-1'));
    await queue({ session: 's-1' });
    NOW = NOW0 + 10 * MIN + 1;
    expect((await take('s-1')).body.stop).toBe(false);
    expect((await queue({ session: 's-1' })).body.queued).toBe(true);
    expect((await take('s-1')).body.stop).toBe(true);
  });

  it('ten minutes to the millisecond still counts, as the refusal\'s age does', async () => {
    await send(started('s-1'));
    await queue({ session: 's-1' });
    NOW = NOW0 + 10 * MIN;
    expect((await take('s-1')).body.stop).toBe(true);
  });
});

describe('session.stopped', () => {
  it('clears the stop, taken or not, so the next one queues again', async () => {
    await send(started('s-1'));
    await queue({ session: 's-1' });
    await take('s-1');
    expect((await queue({ session: 's-1' })).body.queued).toBe(false); // taken but not answered: still the one stop
    await send(stopped('s-1'));
    expect((await queue({ session: 's-1' })).body.queued).toBe(true);
    expect((await take('s-1')).body.stop).toBe(true);
  });

  it('clears only its own session\'s stop', async () => {
    await send(started('s-1'), started('s-2'));
    await queue({ session: 's-1' });
    await queue({ session: 's-2' });
    await send(stopped('s-1', false));
    expect((await take('s-1')).body.stop).toBe(false);
    expect((await take('s-2')).body.stop).toBe(true);
  });
});

// The table is the server's alone: the plugin and the studio reach it through the two routes, so what it holds is checked directly here once.
describe('the table', () => {
  it('holds one row per session, with when it was asked for and when it was taken', async () => {
    const s = openStore(':memory:');
    const a = buildApp({ store: s, token: TOKEN, now: () => NOW });
    await a.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events: [started('s-1')] } });
    await a.inject({ method: 'POST', url: '/api/stop', payload: { session: 's-1' } });
    NOW += 30_000;
    await a.inject({ method: 'POST', url: '/api/stop', payload: { session: 's-1' } }); // the second asks again: the first's time stays
    expect(all(s, 'SELECT * FROM stops')).toEqual([{ session_id: 's-1', requested_at: NOW0, picked_at: null }]);
    await a.inject({ url: '/api/stop?session=s-1' });
    expect(all(s, 'SELECT * FROM stops')).toEqual([{ session_id: 's-1', requested_at: NOW0, picked_at: NOW0 + 30_000 }]);
    await a.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events: [stopped('s-1')] } });
    expect(all(s, 'SELECT * FROM stops')).toEqual([]);
  });
});
