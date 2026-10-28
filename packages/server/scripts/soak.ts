// The memory soak (#90): every GET API, over real HTTP, 40 rounds in one process. It fails unless the RSS after the last round is within 20% of round 5 and under
// 256 MB, every route answers 200, and no statement is prepared after round 2 (a route that prepares per request does it for ever).
//
// Over HTTP, not `app.inject`: a loop of awaited injects never gives the event loop a turn, and light-my-request queues a setImmediate per request that pins its
// response until one does (a bare Fastify route returning 3 MB, injected 20 times in a loop, holds 126 MB of ArrayBuffers after a full GC, and 6 MB one turn
// later; over HTTP, every request yields and none piles up), so an inject soak measures itself, not the server.
//
//   node --expose-gc packages/server/scripts/soak.ts                            a synthetic session the size of the biggest real session (synthetic-session.ts)
//   node --expose-gc packages/server/scripts/soak.ts --db <copy of history.db>   a real history: the biggest session's project, session and main agent
//   --route <i>  one route of getRoutes (0-based, see routes.ts) instead of all;  --rounds <n>  default 40, at least 5
// `--db` opens the file as the server does (WAL, the schema): give it a copy.
//
// In Linux, on the server's base image (Node 22; the repo bind-mounted, the db's directory writable for WAL):
//   docker run --rm --memory 1500m -v "$PWD":/repo:ro -w /repo node:22-alpine node --expose-gc packages/server/scripts/soak.ts
//   docker run --rm --memory 1500m -v "$PWD":/repo:ro -v /path/to/dir:/data -w /repo node:22-alpine node --expose-gc packages/server/scripts/soak.ts --db /data/history.db
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app.ts';
import { all, openStore } from '../src/store/store.ts';
import { getRoutes } from './routes.ts';
import { BIGGEST, seedSyntheticSession } from './synthetic-session.ts';

const LIMIT_MB = 256;
const GROWTH = 1.2; // the last round's RSS against round 5's: the first rounds fill the caches and the allocator, a server that has settled is flat from there
const WARM = 5;

const { values } = parseArgs({ options: { db: { type: 'string' }, route: { type: 'string' }, rounds: { type: 'string', default: '40' } } });
const rounds = Number(values.rounds);
if (!(rounds >= WARM)) throw new Error(`--rounds must be at least ${WARM}: round ${WARM} is what the last is measured against`);

let prepares = 0; // statements prepared, from the first: the store's cache and the two side stores' own files all go through DatabaseSync.prepare
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
  prepares++;
  return prepare.call(this, sql);
};

const dir = mkdtempSync(join(tmpdir(), 'orb-soak-'));
const store = openStore(values.db ?? join(dir, 'history.db'));
const now = Date.now();
let target: { project: string; session: string; agent: string };
if (values.db) {
  const big = all(store, `SELECT s.id AS session, p.name AS project, count(*) AS agents FROM sessions s JOIN agents a ON a.session_id = s.id JOIN projects p ON p.id = s.project_id
    GROUP BY s.id ORDER BY agents DESC LIMIT 1`)[0];
  if (!big) throw new Error(`${values.db} holds no session`);
  target = { project: big.project, session: big.session, agent: 'main' };
  console.log(`soak on ${values.db}: the biggest session has ${big.agents} agents`);
} else {
  target = seedSyntheticSession(store, { now });
  console.log(`soak on a synthetic session: ${BIGGEST.agents + 1} agents, ${BIGGEST.calls.toLocaleString('en')} calls, ${BIGGEST.turns.toLocaleString('en')} turns, ${BIGGEST.requests.toLocaleString('en')} requests`);
}

const app = buildApp({ store, token: 'soak' });
const address = await app.listen({ port: 0, host: '127.0.0.1' });
const routes = getRoutes({ ...target, now });
const urls = values.route === undefined ? routes : [routes[Number(values.route)] ?? (() => { throw new Error(`no route ${values.route}: 0 to ${routes.length - 1}`); })()];
const mb = (bytes: number) => Math.round(bytes / 1_048_576);
const rss: number[] = [];
const bad = new Set<string>();
let preparesAfterWarm = 0;
console.log(`${urls.length} route${urls.length === 1 ? '' : 's'} x ${rounds} rounds, over HTTP at ${address}`);

for (let round = 1; round <= rounds; round++) {
  for (const url of urls) {
    const res = await fetch(address + url);
    await res.text();
    if (res.status !== 200) bad.add(`${res.status} ${url.split('?')[0]}`);
  }
  if (round === 2) preparesAfterWarm = prepares;
  rss[round] = process.memoryUsage.rss();
  if ([1, WARM, 10, 20, 30, 40].includes(round) || round === rounds) {
    console.log(`round ${String(round).padStart(2)}: rss ${mb(rss[round]!)} MB, heap used ${mb(process.memoryUsage().heapUsed)} MB, ${prepares} statements prepared`);
  }
}
(globalThis as { gc?: () => void }).gc?.();
console.log(`after a full GC: rss ${mb(process.memoryUsage.rss())} MB, heap used ${mb(process.memoryUsage().heapUsed)} MB`);

const last = rss[rounds]!;
const failures = [
  ...(bad.size ? [`not 200: ${[...bad].join(', ')}`] : []),
  ...(last > rss[WARM]! * GROWTH ? [`rss grew from ${mb(rss[WARM]!)} MB at round ${WARM} to ${mb(last)} MB at round ${rounds}: more than ${Math.round((GROWTH - 1) * 100)}%`] : []),
  ...(last >= LIMIT_MB * 1_048_576 ? [`rss ${mb(last)} MB at round ${rounds}: not under ${LIMIT_MB} MB`] : []),
  ...(prepares > preparesAfterWarm ? [`${prepares - preparesAfterWarm} statements prepared after round 2: a route prepares per request`] : []),
];
console.log(failures.length ? `FAIL\n${failures.map((f) => `  ${f}`).join('\n')}` : `PASS: rss ${mb(rss[WARM]!)} MB at round ${WARM}, ${mb(last)} MB at round ${rounds}; every route 200; no statement prepared after round 2`);

await app.close();
store.close();
rmSync(dir, { recursive: true, force: true });
process.exitCode = failures.length ? 1 : 0;
