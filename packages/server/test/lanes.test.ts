import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedSyntheticSession } from '../scripts/synthetic-session.ts';
import { buildApp } from '../src/app.ts';
import { get, openStore, type Store } from '../src/store/store.ts';
import { fullLanes } from './lanes-full.ts';

// #90: /api/lanes sends what the studio draws. A session of more than 5,000 calls is answered without the calls too short to draw (a wait narrower than a thousandth
// of the time axis is no bar and cuts no turn), and says where the axis ends so it does not shrink with them; a smaller one is answered whole, as before.
const NOW = 1_793_000_000_000;
const SHAPE = { agents: 60, turns: 150, calls: 6_000, requests: 100, days: 60 };

let dir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
const lanes = async (session: string) => (await app.inject({ url: `/api/lanes?session=${session}` })).json();
const full = (session: string) => fullLanes(store, session);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-lanes-'));
  store = openStore(join(dir, 'history.db'));
  seedSyntheticSession(store, { shape: SHAPE, now: NOW });
  app = buildApp({ store, token: 't' });
});
afterAll(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/lanes on a big session', () => {
  it('leaves out the closed calls shorter than a thousandth of the axis, keeps the rest and every open one, and says where the axis ends', async () => {
    const session = get(store, "SELECT started_at, ended_at FROM sessions WHERE id = 'soak-big'")!;
    const before = full('soak-big');
    const calls = before.flatMap((l) => l.tools);
    expect(calls.length).toBeGreaterThan(5_000);
    expect(calls.filter((c) => c.duration_ms === null)).toHaveLength(1); // still open: it draws up to now, so it stays

    // The axis ends at the latest end of anything closed; the studio's own floor (a thousandth of it) can only be higher, as now only widens the axis.
    const ends = [session.started_at + 10_000, session.ended_at ?? 0, ...calls.filter((c) => c.duration_ms !== null).map((c) => c.ts + c.duration_ms),
      ...before.flatMap((l) => l.turns).filter((t) => t.duration_ms !== null).map((t) => (t.started_at ?? 0) + t.duration_ms)];
    const until = Math.max(...ends);
    const floor = (until - session.started_at) / 1000;

    const body = await lanes('soak-big');
    expect(body.until).toBe(until);
    expect(body.lanes.map((l: any) => ({ ...l, tools: undefined }))).toEqual(before.map((l) => ({ ...l, tools: undefined }))); // every agent, every turn, as before
    for (const [i, l] of before.entries()) expect(body.lanes[i].tools).toEqual(l.tools.filter((c: any) => c.duration_ms === null || c.duration_ms >= floor));

    const kept = body.lanes.flatMap((l: any) => l.tools).length;
    expect(kept).toBeGreaterThan(10); // not an empty answer that would pass any rule
    expect(kept).toBeLessThan(calls.length / 20);
  });

  it('puts the axis at the session end, or at the end of a turn, whichever is the latest', async () => {
    const until = (await lanes('soak-big')).until;
    const ended = until + 5 * 86_400_000;
    store.exec(`UPDATE sessions SET ended_at = ${ended} WHERE id = 'soak-big'`);
    expect((await lanes('soak-big')).until).toBe(ended);
    store.exec("UPDATE sessions SET ended_at = NULL WHERE id = 'soak-big'");
    store.exec(`INSERT INTO turns (id, agent_id, started_at, duration_ms) VALUES ('late', 'soak-big:main', ${until}, 3600000)`);
    expect((await lanes('soak-big')).until).toBe(until + 3_600_000);
    store.exec("DELETE FROM turns WHERE id = 'late'");
    expect((await lanes('soak-big')).until).toBe(until);
  });

  it('is a fraction of what it was', async () => {
    const res = await app.inject({ url: '/api/lanes?session=soak-big' });
    expect(res.body.length).toBeLessThan(JSON.stringify({ session: {}, lanes: full('soak-big') }).length / 3);
  });
});

describe('GET /api/lanes on a small session', () => {
  it('keeps every call, as before, and adds nothing', async () => {
    const body = await lanes('soak-0');
    expect(body).not.toHaveProperty('until');
    expect(body.lanes).toEqual(full('soak-0'));
    expect(body.lanes.flatMap((l: any) => l.tools)).toHaveLength(120);
  });
});
