import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedSyntheticSession } from '../../server/scripts/synthetic-session.ts';
import { buildApp } from '../../server/src/app.ts';
import { openStore, type Store } from '../../server/src/store/store.ts';
import { fullLanes } from '../../server/test/lanes-full.ts';
import { Lanes, type LaneData } from '../src/Pipeline.tsx';

// #90: for a big session /api/lanes leaves out the calls too short to draw. The studio must draw exactly what it drew from the whole answer: the same session,
// whole and thinned, renders to the same markup, bar for bar, at any moment `now` (an open call is drawn up to it, and it can stretch the time axis).
const DAY = 86_400_000;
const NOW = 1_793_000_000_000;

let dir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-lanes-render-'));
  store = openStore(join(dir, 'history.db'));
  seedSyntheticSession(store, { shape: { agents: 60, turns: 150, calls: 6_000, requests: 100, days: 60 }, now: NOW });
  // A call far too short to draw that is also the last thing that happened: the axis runs to its end, so the thinned answer has to say so.
  store.exec(`INSERT INTO tool_calls (tool_use_id, turn_id, tool, ts, success, duration_ms) SELECT 'last', id, 'Bash', ${NOW + 2 * DAY}, 1, 100 FROM turns WHERE agent_id = 'soak-big:main' LIMIT 1`);
  app = buildApp({ store, token: 't' });
});
afterAll(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const html = (data: LaneData, now: number) => renderToStaticMarkup(createElement(Lanes, { data, now }));
const calls = (data: LaneData) => data.lanes.reduce((n, l) => n + l.tools.length, 0);

describe('the Pipeline\'s lanes, from a thinned answer', () => {
  it.each([
    ['just after the last event', NOW],
    ['mid-session', NOW - 40 * DAY],
    ['a month later: the open call stretches the axis', NOW + 30 * DAY],
  ])('draw the same as from the whole one, %s', async (_when, now) => {
    const thin = (await app.inject({ url: '/api/lanes?session=soak-big' })).json() as LaneData;
    const whole: LaneData = { session: thin.session, lanes: fullLanes(store, 'soak-big') as LaneData['lanes'] };
    expect(thin.until).toBeGreaterThan(0);
    expect(calls(thin)).toBeLessThan(calls(whole) / 20); // it did leave most of them out
    const drawn = html(whole, now);
    expect(drawn.match(/class="lbar wait/g)?.length).toBeGreaterThan(5); // and the page draws waits, so this is no empty comparison
    expect(html(thin, now)).toBe(drawn);
  });

  it('would not, had the axis end been left out', async () => {
    const thin = (await app.inject({ url: '/api/lanes?session=soak-big' })).json() as LaneData;
    const whole: LaneData = { session: thin.session, lanes: fullLanes(store, 'soak-big') as LaneData['lanes'] };
    const { until: _, ...without } = thin;
    expect(html(without, NOW - 40 * DAY)).not.toBe(html(whole, NOW - 40 * DAY)); // with now before the end, the axis is the data's: the calls left out ended last
  });
});
