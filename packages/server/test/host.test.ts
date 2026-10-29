import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { get, openStore, run, type Store } from '../src/store/store.ts';

// Issue #62: DNS rebinding. A hostile page whose name was rebound to 127.0.0.1 sends that name as Host and as Origin,
// which foreign() reads as the studio's own. Only this machine's names are answered. A throwaway store in memory.
const TOKEN = 'test-token-0123456789';
const apps: ReturnType<typeof buildApp>[] = [];
const make = (allowedHosts?: string[], store?: Store) => {
  const app = buildApp({ store, token: TOKEN, allowedHosts });
  apps.push(app);
  return app;
};
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const send = (app: ReturnType<typeof buildApp>, host: string, o: { method?: 'GET' | 'PUT' | 'POST'; url?: string; headers?: Record<string, string>; payload?: object } = {}) =>
  app.inject({ method: o.method ?? 'GET', url: o.url ?? '/healthz', payload: o.payload, headers: { host, ...o.headers } });

const refused = ['evil.example', 'evil.example:4040', 'localhost.evil.example:4040', '127.0.0.1.evil.example', 'localhost@evil.example', '0.0.0.0:4040', '[::2]:4040', '10.0.0.5:4040'];
const admitted = ['127.0.0.1:4040', 'localhost:14040', '[::1]:4040', '127.0.0.1', 'localhost', '[::1]', 'LocalHost:4040'];

describe('the Host check', () => {
  it.each(refused)('Host %j is refused (403) on a GET, with the reason', async (host) => {
    const res = await send(make(), host);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/127\.0\.0\.1.*localhost.*\[::1\]/);
  });

  it.each(admitted)('Host %j passes', async (host) => {
    const res = await send(make(), host);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('every route is behind it: /stream and /ingest too, even with a valid token, and an unknown path', async () => {
    const app = make();
    expect((await send(app, 'evil.example:4040', { url: '/stream' })).statusCode).toBe(403);
    expect((await send(app, 'evil.example:4040', { url: '/nowhere' })).statusCode).toBe(403);
    const ingest = await send(app, 'evil.example:4040', { method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events: [] } });
    expect(ingest.statusCode).toBe(403);
    // the plugin posts to 127.0.0.1: the same request with that Host gets as far as the route
    expect((await send(app, '127.0.0.1:4040', { method: 'POST', url: '/ingest', payload: { events: [] } })).statusCode).toBe(401);
    expect((await send(app, 'localhost:4040', { url: '/nowhere' })).statusCode).toBe(404);
  });

  it('a matching evil Origin and Host cannot write: PUT /api/goal is refused before the route, and the goal stays unset', async () => {
    const store = openStore(':memory:');
    run(store, "INSERT INTO projects (id, name) VALUES ('p', 'mobile-app')");
    const res = await send(make(undefined, store), 'evil.example:4040', { method: 'PUT', url: '/api/goal', headers: { origin: 'http://evil.example:4040' }, payload: { project: 'mobile-app', usd: 1 } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/127\.0\.0\.1/); // the Host check's reason, not foreign()'s
    expect(get(store, "SELECT goal_usd FROM projects WHERE id = 'p'")?.goal_usd).toBeNull(); // the route would have set it to 1
    store.close();
  });

  it('no Host at all (HTTP/1.0 sends none) is refused too, even when the allow list holds an empty entry', async () => {
    const app = make(['']);
    const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: address.hostname, port: Number(address.port) }, () => socket.write('GET /healthz HTTP/1.0\r\n\r\n'));
      let got = '';
      socket.on('data', (d) => (got += d)).on('end', () => resolve(got)).on('error', reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 403 /);
  });

  it('the headers are on every response: a 200, a 404 and a refusal', async () => {
    const app = make();
    for (const res of [await send(app, '127.0.0.1:4040'), await send(app, '127.0.0.1:4040', { url: '/nowhere' }), await send(app, 'evil.example')]) {
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('the headers are on /stream too, which writes its own head; and /stream is open to 127.0.0.1', async () => {
    const app = make();
    const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
    const head = await new Promise<{ status: number | undefined; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ host: address.hostname, port: address.port, path: '/stream', headers: { host: 'localhost:14040' } }, (res) => {
        resolve({ status: res.statusCode, headers: res.headers });
        res.destroy();
      });
      req.on('error', reject).end();
    });
    expect(head.status).toBe(200);
    expect(head.headers['content-type']).toBe('text/event-stream');
    expect(head.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(head.headers['x-content-type-options']).toBe('nosniff');
  });
});

// #21: the studio-only rule for writes is the app's, not each route's, so a write route added later is covered without anyone adding it.
describe('writes under /api/ from another site are refused before routing', () => {
  const STUDIO_ONLY = 'writes are accepted from the studio only';
  const evil = { origin: 'https://evil.example' };
  const writes: ['PUT' | 'POST', string, object][] = [
    ['PUT', '/api/goal', { project: 'mobile-app', usd: 1 }],
    ['PUT', '/api/roles', { scope: 'agent', agent_id: 's1:a2', role: 'tester' }],
    ['PUT', '/api/worth/settings', { rate: 90 }],
    ['PUT', '/api/worth/size', { project: 'mobile-app', number: 13, size: 'M' }],
    ['POST', '/api/analysis/estimate', { project: 'mobile-app', from: 0, to: 1, model: 'claude-opus-5-5' }],
    ['POST', '/api/analysis/run', { estimate: 'e-1' }],
    ['PUT', '/api/analysis/cap', { usd: 999 }],
  ];

  it.each(writes)('%s %s: 403 with the app\'s reason, so no route ran', async (method, url, payload) => {
    const res = await send(make(), '127.0.0.1:4040', { method, url, payload, headers: evil });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: STUDIO_ONLY });
  });

  it('a write to an /api/ path no route serves is refused too: 403, not 404', async () => {
    const res = await send(make(), '127.0.0.1:4040', { method: 'POST', url: '/api/no-such-route', payload: {}, headers: evil });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: STUDIO_ONLY });
  });

  it('the studio\'s own origin writes: PUT /api/goal sets the goal', async () => {
    const store = openStore(':memory:');
    run(store, "INSERT INTO projects (id, name) VALUES ('p', 'mobile-app')");
    const res = await send(make(undefined, store), '127.0.0.1:4040', { method: 'PUT', url: '/api/goal', headers: { origin: 'http://127.0.0.1:4040' }, payload: { project: 'mobile-app', usd: 5 } });
    expect(res.statusCode).toBe(200);
    expect(get(store, "SELECT goal_usd FROM projects WHERE id = 'p'")?.goal_usd).toBe(5);
    store.close();
  });

  it('a read is not a write: GET /api/projects with another site\'s Origin answers', async () => {
    const res = await send(make(), '127.0.0.1:4040', { url: '/api/projects', headers: evil });
    expect(res.statusCode).toBe(200);
  });

  it('POST /ingest is outside /api/: the plugin\'s token decides it, whatever the Origin', async () => {
    const res = await send(make(), '127.0.0.1:4040', { method: 'POST', url: '/ingest', payload: { events: [] }, headers: { ...evil, authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 0, duplicates: 0, rejected: 0 });
  });
});

describe('ORB_ALLOWED_HOSTS (allowedHosts)', () => {
  it('admits the names it lists, on any port and in any case, and the loopback names still pass', async () => {
    const app = make([' Orb.LAN ', 'nas.local:4040', '']);
    for (const host of ['orb.lan', 'orb.lan:4040', 'nas.local:9999', '127.0.0.1:4040']) expect((await send(app, host)).statusCode).toBe(200);
  });

  it('refuses the rest', async () => {
    const app = make(['orb.lan']);
    for (const host of ['evil.example', 'orb.lan.evil.example']) expect((await send(app, host)).statusCode).toBe(403);
  });

  it('without it nothing but the three names passes', async () => {
    expect((await send(make(), 'orb.lan:4040')).statusCode).toBe(403);
  });
});
