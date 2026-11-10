import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// The image's default command (cli.ts with no argument) starts the server, as main.ts does: it opens content.db and history.db (beside CONTENT_DB) and
// needs nothing else, no database server and no password for one. No container. The second describe is what main.ts reads from its environment, seen from
// outside. Vitest's coverage does not count lines run in a child, so the PR shows each branch tested by mutation instead.
let dir: string;
const children = new Set<ChildProcess>();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-serve-'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
// Every child a test started is gone when the test ends, whether it passed, failed or timed out (a timeout skips a `finally`).
afterEach(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  children.clear();
});

const cli = new URL('../src/cli.ts', import.meta.url).pathname;
// No child can reach the real API: the key is a dummy and the base URL is a closed local port, unless a test points it at its own stub.
const BASE = { PATH: process.env.PATH, ORB_TOKEN: 'test-token-0123456789', PORT: '0', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' };

/** Start cli.ts. `exited` is armed at once: a child that died early must not leave a test waiting for an exit that already happened. */
function start(env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, [cli], { env: { ...BASE, ...env } });
  children.add(child);
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  return { child, exited, out: () => out, err: () => err };
}

/** Start the server on a free port and wait for its "listening at" line; `use` gets the port. SIGTERM at the end, and the exit code is returned. */
async function serve(env: Record<string, string | undefined>, use: (port: number, s: ReturnType<typeof start>) => Promise<void>) {
  const s = start({ HOST: '127.0.0.1', CONTENT_DB: join(dir, `${Math.random().toString(36).slice(2)}.db`), ...env });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line in 15 s: ${s.out()}${s.err()}`)), 15_000); // before the test's own timeout
    const look = () => {
      const m = /listening at http:\/\/[\d.]+:(\d+)"/.exec(s.out());
      if (m) (clearTimeout(timer), resolve(Number(m[1])));
    };
    s.child.stdout.on('data', look);
    void s.exited.then((code) => (clearTimeout(timer), reject(new Error(`exited ${code}: ${s.out()}${s.err()}`))));
  });
  await use(port, s);
  s.child.kill('SIGTERM');
  return s.exited;
}

const get = (port: number, path: string, host?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers: host ? { host } : {} }, (res) => {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
  });
  req.on('error', reject).end();
});
const keySet = async (port: number) => JSON.parse((await get(port, '/api/analysis')).body).keySet;

describe('cli.ts', () => {
  it.each(['change-me', ''])('refuses ORB_TOKEN=%j before opening any file, and says how to make a real one', async (token) => {
    mkdirSync(join(dir, 'refused'));
    const s = start({ ORB_TOKEN: token, HOST: '127.0.0.1', CONTENT_DB: join(dir, 'refused', 'refused.db') });
    expect(await s.exited).toBe(1);
    expect(s.err()).toContain(token ? 'openssl rand -hex 24' : 'ORB_TOKEN is required');
    expect(readdirSync(join(dir, 'refused'))).toEqual([]); // no history.db, no content.db: nothing was opened
    rmSync(join(dir, 'refused'), { recursive: true });
  }, 30_000);

  it('serve is the default: no argument starts the server on the two SQLite files and nothing else, and SIGTERM stops it cleanly', async () => {
    mkdirSync(join(dir, 'default'));
    const code = await serve({ CONTENT_DB: join(dir, 'default', 'content.db') }, async (port) => {
      expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).toEqual({ status: 'ok' });
      expect([existsSync(join(dir, 'default', 'content.db')), existsSync(join(dir, 'default', 'history.db'))]).toEqual([true, true]);
    });
    expect(code).toBe(0);
  }, 30_000);
});

describe('main.ts environment', () => {
  it('HOST defaults to loopback: with none set, the server listens on 127.0.0.1 and no other address', async () => {
    await serve({ HOST: undefined }, async (port, s) => {
      expect((await get(port, '/healthz')).status).toBe(200);
      const hosts = [...s.out().matchAll(/listening at http:\/\/([\d.]+):\d+"/g)].map((m) => m[1]);
      expect(hosts).toEqual(['127.0.0.1']);
    });
  }, 30_000);

  it('without ANTHROPIC_API_KEY the Analysis page is told no key is set; with one, it is; an empty one counts as none', async () => {
    await serve({}, async (port) => expect(await keySet(port)).toBe(false));
    await serve({ ANTHROPIC_API_KEY: 'sk-ant-dummy-not-a-real-key' }, async (port) => expect(await keySet(port)).toBe(true));
    await serve({ ANTHROPIC_API_KEY: '' }, async (port) => expect(await keySet(port)).toBe(false));
  }, 30_000);

  it('ANTHROPIC_WORKSPACE_ID reaches the API as the anthropic-workspace-id header, and is left off when empty', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const stub: Server = createServer((req, res) => {
      seen.push(req.headers);
      req.resume().on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":7}'));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const env = { ANTHROPIC_API_KEY: 'sk-ant-dummy-not-a-real-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}` };
    const estimate = (port: number) => fetch(`http://127.0.0.1:${port}/api/analysis/estimate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'p', from: 1, to: 2, model: 'claude-opus-5-5' }),
    });
    try {
      await serve({ ...env, ANTHROPIC_WORKSPACE_ID: 'wrkspc_01' }, async (port) => expect((await estimate(port)).status).toBe(200));
      await serve({ ...env, ANTHROPIC_WORKSPACE_ID: '' }, async (port) => expect((await estimate(port)).status).toBe(200));
    } finally {
      await new Promise((resolve) => stub.close(resolve));
    }
    expect(seen.map((h) => h['anthropic-workspace-id'])).toEqual(['wrkspc_01', undefined]);
  }, 30_000);

  it('a Host that is not this machine\'s is refused unless ORB_ALLOWED_HOSTS names it', async () => {
    await serve({}, async (port) => {
      expect((await get(port, '/healthz', 'orb.example.test')).status).toBe(403);
      expect((await get(port, '/healthz', 'localhost:4040')).status).toBe(200);
    });
    await serve({ ORB_ALLOWED_HOSTS: 'other.test,orb.example.test' }, async (port) => {
      expect((await get(port, '/healthz', 'orb.example.test:8080')).status).toBe(200);
      expect((await get(port, '/healthz', 'other.test')).status).toBe(200);
      expect((await get(port, '/healthz', 'evil.test')).status).toBe(403);
    });
  }, 30_000);
});
