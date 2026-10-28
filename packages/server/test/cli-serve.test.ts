import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The image's default command (cli.ts with no argument) starts the server, as main.ts does: it opens content.db and history.db (beside CONTENT_DB) and
// needs nothing else, no database server and no password for one. No container.
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-serve-'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('cli.ts', () => {
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;

  it('serve is the default: no argument starts the server on the two SQLite files and nothing else, and SIGTERM stops it cleanly', async () => {
    const env = { PATH: process.env.PATH, ORB_TOKEN: 'test-token-0123456789', HOST: '127.0.0.1', PORT: '0', CONTENT_DB: join(dir, 'content.db') };
    const child = spawn(process.execPath, [cli], { env });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve)); // armed at once: a child that died early must not leave the test waiting for an exit that already happened
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const port = await new Promise<string>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
        const m = /listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m) resolve(m[1]!);
      });
      void exited.then((code) => reject(new Error(`exited ${code}: ${out}${err}`)));
    }).catch((e: Error) => {
      child.kill('SIGTERM'); // the child this test started, if it is still there
      throw e;
    });
    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()).toEqual({ status: 'ok' });
    expect([existsSync(join(dir, 'content.db')), existsSync(join(dir, 'history.db'))]).toEqual([true, true]);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 30_000);
});
