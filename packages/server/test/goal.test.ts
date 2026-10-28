import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Event, Usage } from '@agent-orb/shared';
import { buildApp } from '../src/app.ts';
import { costUsd } from '../src/cost.ts';
import { all, openStore, run, type Store } from '../src/store/store.ts';
import { writeEvents } from '../src/store/writer.ts';

// The monthly goal (v0.2 slice 3; PROJECT.md §15, 2026-10-24): API-equivalent dollars per project per month, set from the studio, nothing ever
// stopped. GET /api/goal reads it with what the month has spent, from the start of the month in the viewer's zone to now.
const TOKEN = 'test-token-0123456789';
const iso = (s: string) => Date.parse(s);
let dir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
const write = (events: Event[]) => writeEvents(store, events, 'plugin');
const DEFAULT_NOW = iso('2026-10-25T08:00:00Z');
let NOW = DEFAULT_NOW; // the server's clock, moved by the tests, and set back before each

type Project = { cwd: string; name: string; git_remote?: string };
const MOBILE: Project = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
const MOBILE_NAS: Project = { cwd: '/srv/mobile-app', name: 'mobile-app' }; // the same repo on a machine with no remote: a second project row with the name
const SOLO: Project = { cwd: '/Users/a/solo', name: 'solo', git_remote: 'github.com/o/solo' };
let n = 0;
const ev = (project: Project, session: string, ts: number, kind: string, data: object, extra: object = {}, host = 'mbp'): Event =>
  ({ v: 1, id: `00000000-0000-4000-b200-${String(++n).padStart(12, '0')}`, ts, host, user_id: 'local', session_id: session, project, kind, data, ...extra }) as Event;
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const FABLE9 = 'claude-fable-9'; // not in pricing.json: cost null
const u = (input: number, output: number): Usage => ({ input, output, cache_read: 0, cache_creation: 0 });
const step = (project: Project, session: string, at: string, model: string, usage: Usage, host?: string) =>
  ev(project, session, iso(at), 'turn.step', { model, usage, stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: `t-${n + 1}` }, host);

// Rome is UTC+2 until 25 Oct 2026, so October there starts at 2026-09-30T22:00:00Z.
const REQ = {
  early: { at: '2026-09-02T10:00:00Z', model: SONNET, usage: u(0, 10_000) }, // September in Rome and in UTC
  before: { at: '2026-09-30T21:59:59Z', model: SONNET, usage: u(0, 20_000) }, // 23:59:59 on 30 Sep in Rome: September
  start: { at: '2026-09-30T22:00:00Z', model: SONNET, usage: u(0, 40_000) }, // 00:00:00 on 1 Oct in Rome: October there, September in UTC
  mid: { at: '2026-10-10T10:00:00Z', model: OPUS, usage: u(1_000, 30_000) },
  late: { at: '2026-10-24T12:00:00Z', model: SONNET, usage: u(0, 80_000) },
  future: { at: '2026-10-25T09:00:00Z', model: SONNET, usage: u(0, 90_000) }, // an hour after the default `now`
};
const c = (...names: (keyof typeof REQ)[]) => names.reduce((t, k) => t + costUsd(REQ[k].model, REQ[k].usage)!, 0);

const seeded: Event[] = [
  ev(MOBILE, 'g-1', iso('2026-09-01T00:00:00Z'), 'session.start', { model: SONNET, source: 'startup', claude_version: '2.1.308', plugin_version: '0.2.0' }),
  ...(['early', 'before', 'start', 'mid', 'late', 'future'] as const).map((k) => step(MOBILE, 'g-1', REQ[k].at, REQ[k].model, REQ[k].usage)),
  // the same repo from a machine that knows no remote: a second node named mobile-app, with its own October request
  ev(MOBILE_NAS, 'g-2', iso('2026-10-12T00:00:00Z'), 'session.start', { model: SONNET, source: 'startup', claude_version: '2.1.308', plugin_version: '0.2.0' }, {}, 'nas'),
  step(MOBILE_NAS, 'g-2', '2026-10-12T09:00:00Z', SONNET, u(0, 5_000), 'nas'),
  // another project and its own spend: never in mobile-app's
  ev(SOLO, 's-1', iso('2026-10-12T00:00:00Z'), 'session.start', { model: SONNET, source: 'startup', claude_version: '2.1.308', plugin_version: '0.2.0' }),
  step(SOLO, 's-1', '2026-10-12T09:00:00Z', SONNET, u(0, 1_000_000)),
  step(SOLO, 's-1', '2026-10-13T09:00:00Z', FABLE9, u(0, 1_000)), // unpriced: solo's October is partial
];
const nas = costUsd(SONNET, u(0, 5_000))!;
const solo = costUsd(SONNET, u(0, 1_000_000))!;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-goal-'));
  store = openStore(join(dir, 'history.db'));
  app = buildApp({ store, token: TOKEN, now: () => NOW });
  write(seeded);
});
beforeEach(() => {
  NOW = DEFAULT_NOW;
});
afterAll(async () => {
  await app?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (q: Record<string, string | number>) => {
  const res = await app.inject({ method: 'GET', url: `/api/goal?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}` });
  return { status: res.statusCode, body: res.json() };
};
const put = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: 'PUT', url: '/api/goal', payload: body as object, headers });
  return { status: res.statusCode, body: res.json() };
};
const goals = async (name: string) => all(store, 'SELECT id, goal_usd AS goal FROM projects WHERE name = :name ORDER BY id', { name }).map((r) => ({ ...r }));
const close = (got: number, want: number) => expect(got).toBeCloseTo(want, 9);

describe('GET /api/goal', () => {
  it('no goal set: goal is null, and the month\'s spend is there all the same', async () => {
    const { status, body } = await get({ project: 'mobile-app', tz: 'Europe/Rome' });
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['costPartial', 'goal', 'month', 'project', 'spent']);
    expect(body).toMatchObject({ project: 'mobile-app', month: '2026-10', goal: null, costPartial: false });
    close(body.spent, c('start', 'mid', 'late') + nas); // by name: both nodes called mobile-app; `future` is after now, `early` and `before` are September
  });

  it('the month starts at midnight in the viewer\'s zone: the request at 00:00:00 on 1 October in Rome is October there and September in UTC', async () => {
    const rome = (await get({ project: 'mobile-app', tz: 'Europe/Rome' })).body;
    const utc = (await get({ project: 'mobile-app', tz: 'UTC' })).body;
    expect(rome.month).toBe('2026-10');
    expect(utc.month).toBe('2026-10');
    close(rome.spent, c('start', 'mid', 'late') + nas);
    close(utc.spent, c('mid', 'late') + nas); // `start` is 22:00 on 30 Sep in UTC
    expect((await get({ project: 'mobile-app' })).body.spent).toBe(utc.spent); // UTC when no zone is given
  });

  it('the second before midnight is still the month before', async () => {
    NOW = iso('2026-09-30T21:59:59Z') + 1; // 21:59:59.001 UTC = 23:59:59.001 in Rome
    const { body } = await get({ project: 'mobile-app', tz: 'Europe/Rome' });
    expect(body.month).toBe('2026-09');
    close(body.spent, c('early', 'before')); // up to now: `before` is at 21:59:59.000
  });

  it('a month boundary crossed at `now`: Rome is in October at 22:30 UTC on the 30th, UTC is not; spend counts up to now', async () => {
    NOW = iso('2026-09-30T22:30:00Z');
    const rome = (await get({ project: 'mobile-app', tz: 'Europe/Rome' })).body;
    expect(rome.month).toBe('2026-10');
    close(rome.spent, c('start')); // 22:00 to 22:30 UTC: one request; everything later is in the future
    const utc = (await get({ project: 'mobile-app', tz: 'UTC' })).body;
    expect(utc.month).toBe('2026-09');
    close(utc.spent, c('early', 'before', 'start'));
  });

  it('the first instant of the month is `now` itself: nothing yet, no error', async () => {
    NOW = iso('2026-09-30T22:00:00Z') - 1;
    expect((await get({ project: 'mobile-app', tz: 'Europe/Rome' })).body.month).toBe('2026-09');
    NOW = iso('2026-10-31T23:00:00Z'); // 00:00 on 1 Nov in Rome (CET after the 25th: UTC+1)
    const { body } = await get({ project: 'mobile-app', tz: 'Europe/Rome' });
    expect(body).toMatchObject({ month: '2026-11', spent: 0, costPartial: false });
  });

  it('only that project\'s requests: another project, and an unknown one', async () => {
    const other = (await get({ project: 'solo', tz: 'Europe/Rome' })).body;
    close(other.spent, solo); // the unpriced request adds tokens elsewhere, no dollars here
    expect(other.costPartial).toBe(true); // so the figure is a floor
    expect((await get({ project: 'nobody', tz: 'Europe/Rome' })).body).toEqual({ project: 'nobody', month: '2026-10', goal: null, spent: 0, costPartial: false });
  });

  it('400 without a project, with an empty one, and with an unknown zone', async () => {
    expect((await get({ tz: 'UTC' })).status).toBe(400);
    expect((await get({ project: '' })).status).toBe(400);
    expect((await get({ project: 'mobile-app', tz: 'Mars/Olympus' })).status).toBe(400);
  });
});

describe('PUT /api/goal', () => {
  it('sets goal_usd on every project row with that name, and GET gives it back', async () => {
    expect(await put({ project: 'mobile-app', usd: 2500 })).toEqual({ status: 200, body: { project: 'mobile-app', goal: 2500 } });
    expect(await goals('mobile-app')).toEqual([{ id: 'github.com/o/mobile-app', goal: 2500 }, { id: 'nas:/srv/mobile-app', goal: 2500 }]);
    expect((await get({ project: 'mobile-app', tz: 'Europe/Rome' })).body.goal).toBe(2500);
    expect(await goals('solo')).toEqual([{ id: 'github.com/o/solo', goal: null }]); // another project is untouched
  });

  it('changes it, takes cents, and clears it with null', async () => {
    expect((await put({ project: 'mobile-app', usd: 2500.5 })).body).toEqual({ project: 'mobile-app', goal: 2500.5 });
    expect((await get({ project: 'mobile-app', tz: 'UTC' })).body.goal).toBe(2500.5);
    expect(await put({ project: 'mobile-app', usd: null })).toEqual({ status: 200, body: { project: 'mobile-app', goal: null } });
    expect((await goals('mobile-app')).map((g) => g.goal)).toEqual([null, null]);
    expect((await get({ project: 'mobile-app', tz: 'UTC' })).body.goal).toBeNull();
  });

  it('a goal on a project row created later is still found: GET reads the name', async () => {
    await put({ project: 'mobile-app', usd: 3000 });
    write([ev({ cwd: '/Users/b/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app-fork' }, 'g-3', iso('2026-10-14T00:00:00Z'), 'session.start', { model: SONNET, source: 'startup', claude_version: '2.1.308', plugin_version: '0.2.0' })]);
    expect((await goals('mobile-app')).map((g) => g.goal)).toEqual([3000, null, 3000]); // the new row has none yet
    expect((await get({ project: 'mobile-app', tz: 'UTC' })).body.goal).toBe(3000);
    await put({ project: 'mobile-app', usd: null });
    run(store, `DELETE FROM projects WHERE id = 'github.com/o/mobile-app-fork'`); // the other tests count two rows
  });

  it('accepts above 0 and up to 1,000,000; refuses 0, a negative, more, a string, nothing, and a missing project', async () => {
    for (const usd of [0.01, 1_000_000]) expect((await put({ project: 'mobile-app', usd })).status).toBe(200);
    for (const usd of [0, -1, 1_000_000.01, 1e9, '2500', true, undefined]) expect((await put({ project: 'mobile-app', usd })).status, String(usd)).toBe(400);
    expect((await put({ usd: 100 })).status).toBe(400);
    expect((await put({ project: '', usd: 100 })).status).toBe(400);
    expect((await put({ project: 'mobile-app', usd: 100, extra: 1 })).status).toBe(200); // unknown keys are ignored, like the other PUTs
    expect((await goals('mobile-app')).map((g) => g.goal)).toEqual([100, 100]);
    await put({ project: 'mobile-app', usd: null });
  });

  it('404 for a project nobody has seen, and nothing is created', async () => {
    expect((await put({ project: 'ghost', usd: 100 })).status).toBe(404);
    expect((await put({ project: 'ghost', usd: null })).status).toBe(404);
    expect(await goals('ghost')).toEqual([]);
  });

  it('studio only: a page from another site is refused (403) and changes nothing, while the studio\'s own origin is taken', async () => {
    expect((await put({ project: 'mobile-app', usd: 1234 }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await goals('mobile-app')).map((g) => g.goal)).toEqual([null, null]);
    expect((await put({ project: 'mobile-app', usd: 1234 }, { origin: 'http://localhost:80' })).status).toBe(200); // inject's host is localhost:80
    expect((await goals('mobile-app')).map((g) => g.goal)).toEqual([1234, 1234]);
    await put({ project: 'mobile-app', usd: null });
  });
});
