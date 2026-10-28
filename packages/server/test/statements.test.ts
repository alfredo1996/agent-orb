import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getRoutes } from '../scripts/routes.ts';
import { seedSyntheticSession, type Seeded } from '../scripts/synthetic-session.ts';
import { buildApp } from '../src/app.ts';
import { openStore, type Store } from '../src/store/store.ts';

// #90: a route prepares its SQL once, whichever store it reads. A statement prepared on every request is a parse and an allocation per call, for ever; the
// first round fills the cache and the second must find every statement in it.
const NOW = 1_793_000_000_000;
let dir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
let seeded: Seeded;
let prepares = 0;
const prepare = DatabaseSync.prototype.prepare;

beforeAll(() => {
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    prepares++;
    return prepare.call(this, sql);
  };
  dir = mkdtempSync(join(tmpdir(), 'orb-statements-'));
  store = openStore(join(dir, 'history.db'));
  seeded = seedSyntheticSession(store, { shape: { agents: 5, turns: 20, calls: 200, requests: 50, days: 10 }, now: NOW });
  app = buildApp({ store, token: 't' });
});
afterAll(async () => {
  DatabaseSync.prototype.prepare = prepare;
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('every GET route finds all its statements in the cache on its second call', async () => {
  const urls = getRoutes({ ...seeded, now: NOW });
  const again: Record<string, number> = {};
  for (const round of [1, 2]) {
    for (const url of urls) {
      const before = prepares;
      const res = await app.inject({ url });
      expect([url.split('?')[0], res.statusCode]).toEqual([url.split('?')[0], 200]);
      if (round === 2 && prepares > before) again[url.split('?')[0]!] = (again[url.split('?')[0]!] ?? 0) + prepares - before;
    }
  }
  expect(again).toEqual({});
});
