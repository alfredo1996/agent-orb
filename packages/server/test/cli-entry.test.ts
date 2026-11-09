import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// What cli-serve.test.ts leaves: `import <dir>`, bad arguments, and what main.ts reads from its environment (ORB_ALLOWED_HOSTS, ANTHROPIC_API_KEY), all seen from
// outside, in a child process. Vitest's coverage does not count lines run in a child; the PR shows each branch tested by mutation instead.
const cli = new URL('../src/cli.ts', import.meta.url).pathname;
// No child can reach the real API: a key is a dummy and the base URL is a closed local port.
const NO_API = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' };
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-entry-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.once('exit', (code) => resolve({ code, out, err }));
  });
}

describe('cli.ts import and arguments', () => {
  it('import <dir> imports a log folder, prints its report and exits 0', async () => {
    const logs = join(dir, 'logs');
    const sid = '11111111-1111-4111-8111-111111111111';
    mkdirSync(join(logs, '-Users-a-orb'), { recursive: true });
    const line = (o: object) => JSON.stringify({ sessionId: sid, cwd: '/Users/a/orb', version: '2.1.304', isSidechain: false, ...o });
    writeFileSync(join(logs, '-Users-a-orb', `${sid}.jsonl`), [
      line({ type: 'user', uuid: 'u1', timestamp: '2026-10-20T07:00:00.000Z', promptId: 'p1', message: { role: 'user', content: 'hi' } }),
      line({ type: 'assistant', uuid: 'u2', timestamp: '2026-10-20T07:00:02.000Z', message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'yo' }], usage: { input_tokens: 1, output_tokens: 2 } } }),
    ].join('\n') + '\n');
    mkdirSync(join(dir, 'ok'));
    const r = await run(['import', logs], { CONTENT_DB: join(dir, 'ok', 'content.db'), ORB_HOST: 'testbox' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^orb +1 imported/m); // the report names the project the session was filed under
    expect(r.out).toMatch(/\d+ events new, 0 already there/);
    expect(r.err).toBe('');
  }, 30_000);

  it('a failing import exits 1 with its message on stderr: a folder that does not exist', async () => {
    const r = await run(['import', join(dir, 'nope')], { CONTENT_DB: join(dir, 'x.db') });
    expect([r.code, r.out]).toEqual([1, '']);
    expect(r.err).toContain(`${join(dir, 'nope')} is not a folder`);
  }, 30_000);

  it('a failing import exits 1 with its message on stderr: no host to file the sessions under', async () => {
    const logs = join(dir, 'nohost-logs');
    const sid = '22222222-2222-4222-8222-222222222222';
    mkdirSync(join(dir, 'nohost'));
    mkdirSync(join(logs, '-Users-a-orb'), { recursive: true });
    writeFileSync(join(logs, '-Users-a-orb', `${sid}.jsonl`), JSON.stringify({ type: 'user', sessionId: sid, uuid: 'u', cwd: '/Users/a/orb', timestamp: '2026-10-20T07:00:00.000Z', promptId: 'p', message: { role: 'user', content: 'hi' } }) + '\n');
    const f = await run(['import', logs], { CONTENT_DB: join(dir, 'nohost', 'content.db') });
    expect([f.code, f.out]).toEqual([1, '']);
    expect(f.err).toContain('set ORB_HOST');
  }, 30_000);

  it.each([[['frobnicate']], [['import']], [['import', 'a', 'b']]])('%j exits 2 with the usage line', async (args) => {
    const r = await run(args);
    expect([r.code, r.out]).toEqual([2, '']);
    expect(r.err.trim()).toBe('usage: cli.ts serve | cli.ts import <dir>');
  }, 30_000);
});

describe('main.ts environment', () => {
  // Start `serve` on a free port; get(path, host) sends the request with that Host header.
  async function serve(env: Record<string, string>, use: (get: (path: string, host?: string) => Promise<{ status: number; body: string }>) => Promise<void>) {
    const name = `s${Math.random().toString(36).slice(2)}`;
    mkdirSync(join(dir, name));
    const child: ChildProcess = spawn(process.execPath, [cli], { env: { PATH: process.env.PATH, ORB_TOKEN: 'test-token-0123456789', HOST: '127.0.0.1', PORT: '0', CONTENT_DB: join(dir, name, 'content.db'), ...NO_API, ...env } });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let out = '';
        child.stdout!.on('data', (d) => {
          out += d;
          const m = /listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
          if (m) resolve(Number(m[1]));
        });
        void exited.then((code) => reject(new Error(`exited ${code}: ${out}`)));
      });
      await use((path, host) => new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, headers: host ? { host } : {} }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject).end();
      }));
    } finally {
      child.kill('SIGTERM'); // the child this test started
      await exited;
    }
  }

  it('without ANTHROPIC_API_KEY the Analysis page is told no key is set; with one, it is', async () => {
    await serve({}, async (get) => expect(JSON.parse((await get('/api/analysis')).body).keySet).toBe(false));
    await serve({ ANTHROPIC_API_KEY: 'sk-ant-dummy-not-a-real-key' }, async (get) => expect(JSON.parse((await get('/api/analysis')).body).keySet).toBe(true));
  }, 30_000);

  it('an empty ANTHROPIC_API_KEY counts as none', async () => {
    await serve({ ANTHROPIC_API_KEY: '' }, async (get) => expect(JSON.parse((await get('/api/analysis')).body).keySet).toBe(false));
  }, 30_000);

  it('a Host that is not this machine\'s is refused unless ORB_ALLOWED_HOSTS names it', async () => {
    await serve({}, async (get) => {
      expect((await get('/healthz', 'orb.example.test')).status).toBe(403);
      expect((await get('/healthz', 'localhost:4040')).status).toBe(200);
    });
    await serve({ ORB_ALLOWED_HOSTS: 'other.test,orb.example.test' }, async (get) => {
      expect((await get('/healthz', 'orb.example.test:8080')).status).toBe(200);
      expect((await get('/healthz', 'other.test')).status).toBe(200);
      expect((await get('/healthz', 'evil.test')).status).toBe(403);
    });
  }, 30_000);
});
