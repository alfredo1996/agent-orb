import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Event, Usage } from '@agent-orb/shared';
import { DEFAULT_CUTS, DEFAULT_SIZES, openAnalysisStore, type AnalysisStore } from '../src/analysis-store.ts';
import { buildApp } from '../src/app.ts';
import { costUsd } from '../src/cost.ts';
import { all, get as one, openStore, run, type Store } from '../src/store/store.ts';
import { writeEvents } from '../src/store/writer.ts';

// Worth (v0.3 slice 2, #42; PROJECT.md §15, 2026-10-25): the owner's rate, plan price and PR sizes, the merged PRs, the sessions that opened them, and
//   GET /api/worth?project&month&tz   attention, hours by hand, value and return for a month in the viewer's zone
//   PUT /api/worth/settings, PUT /api/worth/size   from the studio only
// Every figure below is worked out by hand from the seed, in seconds, and compared exactly (floats to nine digits).
const TOKEN = 'test-token-0123456789';
const iso = (s: string) => Date.parse(s);
let dir: string;
let history: Store;
let store: AnalysisStore;
let app: ReturnType<typeof buildApp>;
const write = (events: Event[]) => writeEvents(history, events, 'plugin');

type Project = { cwd: string; name: string; git_remote?: string };
const MOBILE: Project = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
const MOBILE_NAS: Project = { cwd: '/srv/mobile-app', name: 'mobile-app' }; // the same repo on a machine that knows no remote: a second node with the name
const SOLO: Project = { cwd: '/Users/a/solo', name: 'solo', git_remote: 'github.com/o/solo' };
let n = 0;
const ev = (project: Project, session: string, ts: number, kind: string, data: object, extra: object = {}, host = 'mbp'): Event =>
  ({ v: 1, id: `00000000-0000-4000-b300-${String(++n).padStart(12, '0')}`, ts, host, user_id: 'local', session_id: session, project, kind, data, ...extra }) as Event;
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const FABLE9 = 'claude-fable-9'; // not in pricing.json: cost null
const u = (input: number, output: number): Usage => ({ input, output, cache_read: 0, cache_creation: 0 });

const prompt = (p: Project, session: string, at: string, host?: string) => ev(p, session, iso(at), 'prompt.submit', { length: 10 }, { prompt_id: `p-${n + 1}` }, host);
let t = 0;
const request = (p: Project, session: string, at: string, model: string, usage: Usage, host?: string) =>
  ev(p, session, iso(at), 'turn.step', { model, usage, stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: `t-${++t}` }, host);
// A tool call held at the permission dialog for `ms` (its run time is the wait's ceiling), or one that was not held.
const toolCall = (p: Project, session: string, at: string, ms: number, waited: boolean) => {
  const id = `toolu_${++t}`;
  const turn = { turn_id: `t-${t}` };
  return [
    ev(p, session, iso(at), 'turn.start', {}, turn),
    ev(p, session, iso(at), 'tool.call', { tool_use_id: id, tool: 'Bash', input_size: 5 }, turn),
    ev(p, session, iso(at) + 1, 'tool.result', { tool_use_id: id, success: true, duration_ms: ms, output_size: 1, files_touched: [] }, turn),
    ...(waited ? [ev(p, session, iso(at) + 2, 'tool.waiting', { tool_use_id: id, tool: 'Bash' }, turn)] : []),
  ];
};
const pr = (number: number, title: string, mergedAt: string, additions: number, deletions: number, head?: string, counted?: [lines: number, files: number]) =>
  ({ number, title, merged_at: iso(mergedAt), additions, deletions, ...(head ? { head } : {}), ...(counted ? { counted_lines: counted[0], counted_files: counted[1] } : {}) });
// A PR link is the time the session opened the PR (#103): a PR gets the session's work up to it, so the default is after all the work the seed holds.
const link = (p: Project, session: string, number: number, at = '2026-10-26T12:00:00Z') => ev(p, session, iso(at), 'session.pr', { number });
const start = (p: Project, session: string, at: string, host?: string) =>
  ev(p, session, iso(at), 'session.start', { model: SONNET, source: 'startup', claude_version: '2.1.308', plugin_version: '0.3.0' }, {}, host);

// Rome is UTC+2 until 25 Oct 2026, UTC+1 after: October there is [2026-09-30T22:00:00Z, 2026-10-31T23:00:00Z).
const seeded: Event[] = [
  start(MOBILE, 'g-1', '2026-09-01T00:00:00Z'), start(MOBILE, 'g-2', '2026-09-01T00:00:00Z'), start(MOBILE, 'g-3', '2026-09-01T00:00:00Z'),
  start(MOBILE, 'g-edge', '2026-09-01T00:00:00Z'), start(MOBILE, 'g-aug', '2026-08-01T00:00:00Z'), start(MOBILE_NAS, 'g-nas', '2026-09-01T00:00:00Z', 'nas'),
  start(SOLO, 's-1', '2026-09-01T00:00:00Z'),

  // Day A, 10 Oct, over g-1 and g-2 (one person, two sessions): gaps 180 s and 120 s count, 1500 s does not, 360 s counts,
  // exactly 600 s does not ("under 10 minutes"), 599 s counts. Seven prompts.
  prompt(MOBILE, 'g-1', '2026-10-10T09:00:00Z'), prompt(MOBILE, 'g-1', '2026-10-10T09:03:00Z'), prompt(MOBILE, 'g-1', '2026-10-10T09:05:00Z'),
  prompt(MOBILE, 'g-2', '2026-10-10T09:30:00Z'), prompt(MOBILE, 'g-1', '2026-10-10T09:36:00Z'), prompt(MOBILE, 'g-2', '2026-10-10T09:46:00Z'),
  prompt(MOBILE, 'g-1', '2026-10-10T09:55:59Z'),
  // Day B, 20 Oct: 60 s, then 240 s to a prompt from the other node named mobile-app (counted: the project is its name)
  prompt(MOBILE, 'g-3', '2026-10-20T14:00:00Z'), prompt(MOBILE, 'g-3', '2026-10-20T14:01:00Z'), prompt(MOBILE_NAS, 'g-nas', '2026-10-20T14:05:00Z', 'nas'),
  // The month's edges in Rome. 21:59:30Z and 22:00:30Z are 60 s apart but in September and October there, so the gap is nobody's;
  // 22:59:30Z on the 31st is 23:59:30 CET (October), 23:00:30Z is November there and October in UTC.
  prompt(MOBILE, 'g-edge', '2026-09-30T21:59:30Z'), prompt(MOBILE, 'g-edge', '2026-09-30T22:00:30Z'),
  prompt(MOBILE, 'g-edge', '2026-10-31T22:59:30Z'), prompt(MOBILE, 'g-edge', '2026-10-31T23:00:30Z'),
  // Another project's prompt inside day A: never in mobile-app's
  prompt(SOLO, 's-1', '2026-10-10T09:01:00Z'),
  // August: ten prompts five minutes apart, 3,900 s of attention for a half hour of work by hand
  ...Array.from({ length: 10 }, (_, i) => prompt(MOBILE, 'g-aug', new Date(iso('2026-08-15T10:00:00Z') + i * 300_000).toISOString())),

  // Permission waits: 90 s and 30 s in October; not held (600 s); held in September (3,600 s); held at 23:30Z on 31 Oct (November in Rome); and one with no turn
  ...toolCall(MOBILE, 'g-1', '2026-10-10T09:10:00Z', 90_000, true),
  ...toolCall(MOBILE, 'g-1', '2026-10-12T09:00:00Z', 30_000, true),
  ...toolCall(MOBILE, 'g-1', '2026-10-12T10:00:00Z', 600_000, false),
  ...toolCall(MOBILE, 'g-edge', '2026-09-30T21:00:00Z', 3_600_000, true),
  ...toolCall(MOBILE, 'g-edge', '2026-10-31T23:30:00Z', 120_000, true),

  // Requests. g-1 and g-2 serve PR 10; g-2 serves PR 11 as well; g-3 serves PR 12; g-edge serves none.
  request(MOBILE, 'g-1', '2026-10-10T09:10:00Z', SONNET, u(0, 10_000)),
  request(MOBILE, 'g-1', '2026-10-05T10:00:00Z', OPUS, u(1_000, 30_000)),
  request(MOBILE, 'g-2', '2026-10-10T09:40:00Z', SONNET, u(0, 20_000)),
  request(MOBILE, 'g-3', '2026-10-20T14:00:30Z', SONNET, u(0, 5_000)),
  request(MOBILE_NAS, 'g-nas', '2026-10-12T09:00:00Z', SONNET, u(0, 7_000), 'nas'),
  request(MOBILE, 'g-edge', '2026-09-30T21:00:00Z', SONNET, u(0, 40_000)), // September
  request(MOBILE, 'g-edge', '2026-09-30T22:00:00Z', SONNET, u(0, 50_000)), // the first instant of October in Rome
  request(MOBILE, 'g-edge', '2026-10-31T22:59:59Z', SONNET, u(0, 60_000)), // the last second of October in Rome
  request(MOBILE, 'g-edge', '2026-10-31T23:00:00Z', SONNET, u(0, 70_000)), // the first instant of November in Rome (the end is not in the month)
  request(SOLO, 's-1', '2026-10-12T09:00:00Z', SONNET, u(0, 1_000_000)),
  request(SOLO, 's-1', '2026-10-13T09:00:00Z', FABLE9, u(0, 1_000)), // unpriced: solo's spend is a floor

  // A subagent of g-1: PR 10 has three agents (g-1's main and subagent, g-2's main)
  ev(MOBILE, 'g-1', iso('2026-10-10T09:05:00Z'), 'agent.spawn', { tool_use_id: 'toolu_sub', agent_type: 'Explore', model: SONNET, prompt_length: 1 }, { agent_id: 'a-sub' }),

  // The merged PRs, as gh listed them; the PRs on the edges of the month in Rome are 15 to 18
  ev(MOBILE, 'g-1', iso('2026-10-26T10:00:00Z'), 'project.prs', { prs: [
    pr(10, 'feat: ten', '2026-10-05T10:00:00Z', 100, 10, 'feat/ten'), pr(11, 'fix: eleven', '2026-10-12T10:00:00Z', 11, 1), pr(12, 'chore: twelve', '2026-10-20T15:00:00Z', 12, 2),
    pr(13, 'docs: thirteen', '2026-10-25T09:00:00Z', 13, 3), pr(14, 'feat: september', '2026-09-10T10:00:00Z', 14, 4),
    pr(15, 'edge: the first instant', '2026-09-30T22:00:00Z', 15, 5), pr(16, 'edge: a second before', '2026-09-30T21:59:59Z', 16, 6),
    pr(17, 'edge: the last second', '2026-10-31T22:59:59Z', 17, 7), pr(18, 'edge: the first of November', '2026-10-31T23:00:00Z', 18, 8),
    pr(20, 'feat: august', '2026-08-15T10:00:00Z', 20, 0),
  ] }),
  ev(SOLO, 's-1', iso('2026-10-26T10:00:00Z'), 'project.prs', { prs: [pr(10, 'solo ten', '2026-10-06T10:00:00Z', 1, 1)] }),
  link(MOBILE, 'g-1', 10), link(MOBILE, 'g-2', 10, '2026-10-10T10:00:00Z'), link(MOBILE, 'g-2', 11), link(MOBILE, 'g-3', 12), link(MOBILE, 'g-aug', 20),
  link(MOBILE, 'g-3', 99), // a PR gh never listed as merged: a node, never a row
  link(SOLO, 's-1', 10),
];

// The owner's sizes: 10 L, 11 S, 12 skipped, 13 not sized, 15 M, 17 XL, 18 S, 20 S. October in Rome is 10, 11, 12, 13, 15, 17.
const SIZES: [number, string][] = [[10, 'L'], [11, 'S'], [12, 'skip'], [15, 'M'], [17, 'XL'], [18, 'S'], [20, 'S']];
const setSizes = (rows: [string, string][]) => rows.forEach(([id, size]) => run(history, 'UPDATE pull_requests SET size = :size WHERE id = :id', { id, size }));
const resetSizes = () => {
  run(history, 'UPDATE pull_requests SET size = NULL');
  setSizes(SIZES.map(([k, v]) => [`${MOBILE.git_remote}:${k}`, v]));
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-worth-'));
  history = openStore(join(dir, 'history.db'));
  store = openAnalysisStore(':memory:');
  app = buildApp({ store: history, token: TOKEN, reports: store });
  write(seeded);
});
beforeEach(() => {
  store.setWorth({ rate: null, plan: null, sizes: { ...DEFAULT_SIZES }, cuts: { ...DEFAULT_CUTS } });
  resetSizes();
});
afterAll(async () => {
  await app?.close();
  history?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (q: Record<string, string | number>) => {
  const res = await app.inject({ method: 'GET', url: `/api/worth?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}` });
  return { status: res.statusCode, body: res.json() };
};
const rome = (month = '2026-10', project = 'mobile-app') => get({ project, month, tz: 'Europe/Rome' });
const send = async (method: 'PUT', url: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method, url, payload: body as object, headers });
  return { status: res.statusCode, body: res.json() };
};
const putSettings = (body: unknown, headers?: Record<string, string>) => send('PUT', '/api/worth/settings', body, headers);
const putSize = (body: unknown, headers?: Record<string, string>) => send('PUT', '/api/worth/size', body, headers);
const sizeOf = async (project: string, number: number) =>
  all(history, 'SELECT pr.size AS size FROM pull_requests pr JOIN projects p ON p.id = pr.project_id WHERE p.name = :project AND pr.number = :number ORDER BY pr.id', { project, number }).map((r) => r.size);
const close = (got: number, want: number) => expect(got).toBeCloseTo(want, 9);
const hours = (seconds: number) => seconds / 3600;
const c = (model: string, usage: Usage) => costUsd(model, usage)!;

// What the seed adds up to, in seconds. Day A: seven prompts (840) and the gaps under ten minutes (180 + 120 + 360 + 599). Day B: three prompts (360) and 60 + 240.
const DAY_A = 7 * 120 + 180 + 120 + 360 + 599;
const DAY_B = 3 * 120 + 60 + 240;
const ROME_OCT_PROMPTS = 120 + DAY_A + DAY_B + 120; // the two edge prompts stand alone: the gap between a prompt and its neighbour across the month's edge is nobody's
const ROME_OCT_WAITS = 90 + 30;

describe('GET /api/worth: attention', () => {
  it('prompt windows: 2 minutes a prompt plus every gap under 10 minutes, over the project\'s sessions together; waits on top; a month in Rome', async () => {
    const { status, body } = await rome();
    expect(status).toBe(200);
    expect(ROME_OCT_PROMPTS).toBe(2999); // by hand
    close(body.waitsHours, hours(ROME_OCT_WAITS));
    close(body.attentionHours, hours(ROME_OCT_PROMPTS + ROME_OCT_WAITS));
    expect(body.month).toBe('2026-10');
    expect(body.prompts).toBe(1 + 7 + 3 + 1);
    expect(body.days).toBe(4); // 1 Oct 00:00:30, the 10th, the 20th and the 31st 23:59:30, all local days in Rome
  });

  it('a gap of 599 seconds counts, exactly ten minutes does not, 661 does not, and two prompts at one instant are a gap of 0', async () => {
    const G: Project = { cwd: '/Users/a/gaps', name: 'gaps', git_remote: 'github.com/o/gaps' }; // a project of its own, so the figure is these five prompts'
    write(['2026-07-10T09:00:00Z', '2026-07-10T09:09:59Z', '2026-07-10T09:19:59Z', '2026-07-10T09:19:59Z', '2026-07-10T09:31:00Z'].map((at) => prompt(G, 'gap-1', at)));
    const { body } = await rome('2026-07', 'gaps');
    expect(body.prompts).toBe(5);
    close(body.attentionHours, hours(5 * 120 + 599)); // 599 s; 09:09:59 to 09:19:59 is exactly 600; 0; 09:19:59 to 09:31:00 is 661
  });

  it('the half-open month: the edge prompts, waits and PRs of October in Rome are those from 22:00:00Z on the 30th up to, not including, 23:00:00Z on the 31st', async () => {
    const octRome = (await rome()).body;
    const octUtc = (await get({ project: 'mobile-app', month: '2026-10', tz: 'UTC' })).body;
    const novRome = (await rome('2026-11')).body;
    const sepRome = (await rome('2026-09')).body;
    // Rome October: the edge prompt at 22:00:30Z and the one at 22:59:30Z; UTC October: day A, day B, 22:59:30Z and 23:00:30Z (the last two 60 s apart: counted)
    expect(octUtc.prompts).toBe(7 + 3 + 2);
    close(octUtc.attentionHours, hours(DAY_A + DAY_B + 2 * 120 + 60 + (90 + 30 + 120)));
    // November in Rome holds the 23:00:30Z prompt and the wait at 23:30Z, and nothing before the edge
    expect(novRome.prompts).toBe(1);
    close(novRome.attentionHours, hours(120 + 120));
    close(novRome.waitsHours, hours(120));
    // September in Rome: the 21:59:30Z prompt, the wait of 3,600 s at 21:00Z, which counts its first 10 minutes
    expect(sepRome.prompts).toBe(1);
    close(sepRome.attentionHours, hours(120 + 600));
    expect(octRome.prompts + novRome.prompts + sepRome.prompts).toBe(12 + 1 + 1); // every prompt of the three months, once
  });

  it('only the project\'s own prompts: another project\'s prompt inside day A changes nothing, and has its own month', async () => {
    const solo = (await rome('2026-10', 'solo')).body;
    expect(solo.prompts).toBe(1);
    close(solo.attentionHours, hours(120));
    expect(solo.waitsHours).toBe(0);
  });

  it('August: ten prompts five minutes apart are 3,900 seconds', async () => {
    const { body } = await rome('2026-08');
    expect(body.prompts).toBe(10);
    close(body.attentionHours, hours(10 * 120 + 9 * 300));
  });

  it('a permission wait is the call\'s duration when it was held at the dialog, in the month of the call; a call that was not held is not a wait', async () => {
    const { body } = await rome();
    close(body.waitsHours, hours(120)); // 90 + 30, not the 600 s of the call that was not held, not September's 3,600 s, not the 31st's 23:30Z
  });

  it('a wait counts at most 10 minutes: a dialog left open longer means nobody was there (#76)', async () => {
    const W: Project = { cwd: '/Users/a/waits', name: 'waits', git_remote: 'github.com/o/waits' }; // a project of its own, so the figure is these three waits'
    write([
      ...toolCall(W, 'w-1', '2026-07-10T09:00:00Z', 540_000, true), // 9 minutes: whole
      ...toolCall(W, 'w-1', '2026-07-10T10:00:00Z', 600_000, true), // exactly 10: whole
      ...toolCall(W, 'w-1', '2026-07-10T11:00:00Z', 10_800_000, true), // 3 hours, overnight-like: 10 minutes
    ]);
    const { body } = await rome('2026-07', 'waits');
    close(body.waitsHours, hours(540 + 600 + 600));
    close(body.attentionHours, hours(540 + 600 + 600));
  });
});

describe('GET /api/worth: the PRs of the month', () => {
  it('lists those merged in the month in the viewer\'s zone, newest first, with their lines, size and what served them', async () => {
    const { body } = await rome();
    expect(body.prs.map((p: any) => p.number)).toEqual([17, 13, 12, 11, 10, 15]);
    expect(body.prs.map((p: any) => p.size)).toEqual(['XL', null, 'skip', 'S', 'L', 'M']);
    expect(body.prs[0]).toEqual({ number: 17, title: 'edge: the last second', mergedAt: iso('2026-10-31T22:59:59Z'), additions: 17, deletions: 7, countedLines: null, countedFiles: null, size: 'XL', yours: true, sessions: 0, agents: 0, cost: 0 });
    expect(body.prs.find((p: any) => p.number === 10)).toMatchObject({ title: 'feat: ten', mergedAt: iso('2026-10-05T10:00:00Z'), additions: 100, deletions: 10 });
  });

  it('the edges: 22:00:00Z on the 30th is October in Rome and September in UTC; 23:00:00Z on the 31st is November in Rome and October in UTC', async () => {
    const utc = (await get({ project: 'mobile-app', month: '2026-10', tz: 'UTC' })).body;
    expect(utc.prs.map((p: any) => p.number)).toEqual([18, 17, 13, 12, 11, 10]);
    expect((await rome('2026-11')).body.prs.map((p: any) => p.number)).toEqual([18]);
    expect((await rome('2026-09')).body.prs.map((p: any) => p.number)).toEqual([16, 14]);
  });

  it('sessions, agents and cost are those of the sessions that opened the PR, each a slice of it (the full split is under "a PR\'s share of a session")', async () => {
    const { body } = await rome();
    const by = (number: number) => body.prs.find((p: any) => p.number === number);
    const g1 = c(SONNET, u(0, 10_000)) + c(OPUS, u(1_000, 30_000));
    const g2 = c(SONNET, u(0, 20_000));
    expect(by(10)).toMatchObject({ sessions: 2, agents: 3 }); // g-1 (main and a subagent) and g-2 (main)
    close(by(10).cost, g1 + g2);
    expect(by(11)).toMatchObject({ sessions: 1, agents: 0, cost: 0 }); // g-2 again, but its only request came before it opened 10, so 10 has it; 11 is the slice after
    expect(by(12)).toMatchObject({ sessions: 1, agents: 1 });
    close(by(12).cost, c(SONNET, u(0, 5_000)));
    expect(by(13)).toMatchObject({ sessions: 0, agents: 0, cost: 0 });
  });

  it('a PR that only a session mentioned (gh never listed it as merged) is no row, and has no merge time', async () => {
    expect((await rome()).body.prs.map((p: any) => p.number)).not.toContain(99);
    const r = all(history, `SELECT pr.merged_at AS m, pr.id AS id FROM session_prs o JOIN pull_requests pr ON pr.id = o.pr_id WHERE o.session_id = 'g-3' AND pr.number = 99`);
    expect(r.map((x) => ({ ...x }))).toEqual([{ m: null, id: 'github.com/o/mobile-app:99' }]);
  });

  it('another project\'s PR with the same number is its own: solo\'s 10 is not mobile-app\'s', async () => {
    const solo = (await rome('2026-10', 'solo')).body;
    expect(solo.prs).toEqual([{ number: 10, title: 'solo ten', mergedAt: iso('2026-10-06T10:00:00Z'), additions: 1, deletions: 1, countedLines: null, countedFiles: null, size: null, yours: false, sessions: 1, agents: 1, cost: c(SONNET, u(0, 1_000_000)) }]);
  });

  it('a project that sent no titles (an excluded one) lists its PRs with title null', async () => {
    write([ev({ cwd: '/Users/a/secret', name: 'secret', git_remote: 'github.com/o/secret' }, 'x-1', iso('2026-10-26T10:00:00Z'), 'project.prs', { prs: [{ number: 3, merged_at: iso('2026-10-07T10:00:00Z'), additions: 3, deletions: 0 }] })]);
    expect((await rome('2026-10', 'secret')).body.prs).toEqual([{ number: 3, title: null, mergedAt: iso('2026-10-07T10:00:00Z'), additions: 3, deletions: 0, countedLines: null, countedFiles: null, size: null, yours: false, sessions: 0, agents: 0, cost: 0 }]);
  });
});

describe('GET /api/worth: release PRs', () => {
  const S: Project = { cwd: '/Users/a/shipper', name: 'shipper', git_remote: 'github.com/o/shipper' };
  it('a PR whose head starts with release/ is no row and in no total, sized or hours; it stays in the graph, and a PR with no head known stays in', async () => {
    write([ev(S, 'r-1', iso('2026-10-26T10:00:00Z'), 'project.prs', { prs: [
      pr(21, 'feat: one', '2026-10-05T10:00:00Z', 10, 1, 'feat/one'), pr(22, 'chore(release): 0.14.0', '2026-10-20T10:00:00Z', 500, 50, 'release/0.14'),
      pr(23, 'no head known', '2026-10-21T10:00:00Z', 3, 0), pr(24, 'a folder inside a name', '2026-10-22T10:00:00Z', 4, 0, 'feat/release/notes'), pr(25, 'a dash, not a slash', '2026-10-23T10:00:00Z', 5, 0, 'release-notes'),
    ] })]);
    // sized by the owner, the release PR too (before the rule, or by hand): it must still not count
    setSizes([[21, 'M'], [22, 'XL'], [23, 'S']].map(([k, v]) => [`${S.git_remote}:${k}`, v as string]));
    const { body } = await rome('2026-10', 'shipper');
    expect(body.prs.map((p: any) => p.number)).toEqual([25, 24, 23, 21]);
    expect(body).toMatchObject({ total: 4, sized: 2, releaseMerges: 1 }); // 22 alone: a folder inside a name and a dash are not the prefix
    close(body.byHandHours, 2 + 0.5); // M and S; the release's XL (16) is not there
    const kept = all(history, `SELECT pr.head AS head, pr.size AS size FROM pull_requests pr JOIN projects p ON p.id = pr.project_id WHERE p.name = 'shipper' AND pr.number = 22`);
    expect(kept.map((r) => ({ ...r }))).toEqual([{ head: 'release/0.14', size: 'XL' }]);
  });
});

describe('GET /api/worth: the month\'s totals', () => {
  it('sized counts the PRs the owner answered (a size or Skip), total all of them, and the hours are those of the sizes, skips excluded', async () => {
    const { body } = await rome();
    expect(body).toMatchObject({ total: 6, sized: 5 }); // 13 is not answered; 12 is skipped, which is an answer
    close(body.byHandHours, 16 + 0.5 + 6 + 2); // 17 XL, 11 S, 10 L, 15 M; 12 skip adds nothing
  });

  it('the API-equivalent cost of the month\'s requests of every node with the name, up to but not including the end of the month', async () => {
    const { body } = await rome();
    close(body.apiCost, c(SONNET, u(0, 10_000)) + c(OPUS, u(1_000, 30_000)) + c(SONNET, u(0, 20_000)) + c(SONNET, u(0, 5_000)) + c(SONNET, u(0, 7_000)) + c(SONNET, u(0, 50_000)) + c(SONNET, u(0, 60_000)));
    expect(body.costPartial).toBe(false);
    const solo = (await rome('2026-10', 'solo')).body;
    close(solo.apiCost, c(SONNET, u(0, 1_000_000)));
    expect(solo.costPartial).toBe(true); // a request on a model with no price: a floor
  });

  it('neither a rate nor a plan: value and return are null, and everything else is there', async () => {
    const { body } = await rome();
    expect(body.settings).toEqual({ rate: null, plan: null, sizes: { S: 0.5, M: 2, L: 6, XL: 16 }, cuts: { S: 300, M: 1500, L: 6000 } });
    expect(body.value).toBeNull();
    expect(body.return).toBeNull();
    close(body.netHours, 24.5 - hours(ROME_OCT_PROMPTS + ROME_OCT_WAITS));
  });

  it('a rate without a plan gives the value and no return', async () => {
    store.setWorth({ rate: 90 });
    const { body } = await rome();
    close(body.value, (24.5 - hours(ROME_OCT_PROMPTS + ROME_OCT_WAITS)) * 90);
    expect(body.return).toBeNull();
  });

  it('value = (hours by hand - attention) x rate, and return = value - the plan price', async () => {
    store.setWorth({ rate: 90, plan: 200 });
    const { body } = await rome();
    const net = 24.5 - hours(ROME_OCT_PROMPTS + ROME_OCT_WAITS);
    close(body.netHours, net);
    close(body.value, net * 90);
    close(body.return, net * 90 - 200);
    expect(body.value).toBeGreaterThan(2000); // 23.63 h at $90: by hand, about $2,127
    expect(body.value).toBeLessThan(2200);
  });

  it('a plan with no rate gives neither: the return needs the value', async () => {
    store.setWorth({ plan: 200 });
    const { body } = await rome();
    expect(body.value).toBeNull();
    expect(body.return).toBeNull();
  });

  it('a losing month is negative: a plan dearer than the value, and attention beyond the hours by hand', async () => {
    store.setWorth({ rate: 90, plan: 5000 });
    const dear = (await rome()).body;
    expect(dear.value).toBeGreaterThan(0);
    expect(dear.return).toBeLessThan(0);
    close(dear.return, dear.value - 5000);
    store.setWorth({ rate: 90, plan: 200 });
    const august = (await rome('2026-08')).body; // a half hour by hand, 1.0833 h of attention
    expect(august).toMatchObject({ total: 1, sized: 1 });
    close(august.byHandHours, 0.5);
    close(august.netHours, 0.5 - hours(3900));
    close(august.value, (0.5 - hours(3900)) * 90);
    expect(august.value).toBeLessThan(0);
    close(august.return, (0.5 - hours(3900)) * 90 - 200);
  });

  it('the sizes\' hours are the owner\'s: changing M from 2 to 3 hours moves the month by one hour', async () => {
    store.setWorth({ sizes: { ...DEFAULT_SIZES, M: 3 } });
    const { body } = await rome();
    close(body.byHandHours, 16 + 0.5 + 6 + 3);
    expect(body.settings.sizes).toEqual({ S: 0.5, M: 3, L: 6, XL: 16 });
  });

  it('a month with no activity: zeros and empty lists, and with a plan set the return is the plan\'s price, negative', async () => {
    const empty = (await rome('2026-01')).body;
    expect(empty).toMatchObject({ month: '2026-01', attentionHours: 0, waitsHours: 0, apiCost: 0, costPartial: false, prs: [], sized: 0, total: 0, byHandHours: 0, netHours: 0, value: null, return: null, prompts: 0, days: 0 });
    store.setWorth({ rate: 90, plan: 200 });
    const lost = (await rome('2026-01')).body;
    expect(lost.value).toBe(0);
    expect(lost.return).toBe(-200);
  });

  it('an unknown project is an empty month, not an error', async () => {
    const { status, body } = await rome('2026-10', 'nobody');
    expect(status).toBe(200);
    expect(body).toMatchObject({ prs: [], total: 0, attentionHours: 0, apiCost: 0 });
  });

  it('the answer has exactly the keys the studio reads', async () => {
    const { body } = await rome();
    expect(Object.keys(body).sort()).toEqual(['apiCost', 'attentionHours', 'byHandHours', 'costPartial', 'days', 'month', 'netHours', 'prompts', 'prs', 'releaseMerges', 'return', 'sized', 'settings', 'total', 'value', 'waitsHours'].sort());
    expect(Object.keys(body.prs[0]).sort()).toEqual(['additions', 'agents', 'cost', 'countedFiles', 'countedLines', 'deletions', 'mergedAt', 'number', 'sessions', 'size', 'title', 'yours']);
    expect(Object.keys(body.settings).sort()).toEqual(['cuts', 'plan', 'rate', 'sizes']);
  });

  it('400 without a project or a month, with a month that is not YYYY-MM, and with an unknown zone; no zone is UTC', async () => {
    expect((await get({ month: '2026-10' })).status).toBe(400);
    expect((await get({ project: '', month: '2026-10' })).status).toBe(400);
    expect((await get({ project: 'mobile-app' })).status).toBe(400);
    for (const month of ['2026-13', '2026-00', '2026-1', '26-10', 'October', '2026-10-01', '']) expect((await get({ project: 'mobile-app', month })).status, month).toBe(400);
    expect((await get({ project: 'mobile-app', month: '2026-10', tz: 'Mars/Olympus' })).status).toBe(400);
    const noZone = (await get({ project: 'mobile-app', month: '2026-10' })).body;
    expect(noZone.prs.map((p: any) => p.number)).toEqual([18, 17, 13, 12, 11, 10]); // UTC
  });
});

describe('PUT /api/worth/settings', () => {
  it('sets the rate and the plan, one at a time or both, and GET gives them back', async () => {
    expect(await putSettings({ rate: 90 })).toEqual({ status: 200, body: { rate: 90, plan: null, sizes: DEFAULT_SIZES, cuts: DEFAULT_CUTS } });
    expect((await putSettings({ plan: 200 })).body).toEqual({ rate: 90, plan: 200, sizes: DEFAULT_SIZES, cuts: DEFAULT_CUTS });
    expect((await putSettings({ rate: 100, plan: 20 })).body).toEqual({ rate: 100, plan: 20, sizes: DEFAULT_SIZES, cuts: DEFAULT_CUTS });
    expect((await rome()).body.settings).toEqual({ rate: 100, plan: 20, sizes: DEFAULT_SIZES, cuts: DEFAULT_CUTS });
    expect(store.worth()).toEqual({ rate: 100, plan: 20, sizes: DEFAULT_SIZES, cuts: DEFAULT_CUTS });
  });

  it('takes cents, a plan of 0, and clears with null', async () => {
    expect((await putSettings({ rate: 87.5, plan: 0 })).body).toEqual({ rate: 87.5, plan: 0, sizes: DEFAULT_SIZES, cuts: DEFAULT_CUTS });
    store.setWorth({ rate: 90, plan: 0 });
    expect((await rome()).body.return).toBe((await rome()).body.value); // a free plan: nothing to subtract
    expect((await putSettings({ rate: null, plan: null })).body).toEqual({ rate: null, plan: null, sizes: DEFAULT_SIZES, cuts: DEFAULT_CUTS });
  });

  it('sizes: any of S, M, L, XL, and the others keep their hours', async () => {
    expect((await putSettings({ sizes: { M: 3 } })).body.sizes).toEqual({ S: 0.5, M: 3, L: 6, XL: 16 });
    expect((await putSettings({ sizes: { S: 1, XL: 20.5 } })).body.sizes).toEqual({ S: 1, M: 3, L: 6, XL: 20.5 });
    expect((await putSettings({ sizes: {} })).body.sizes).toEqual({ S: 1, M: 3, L: 6, XL: 20.5 });
    expect((await putSettings({})).body).toEqual({ rate: null, plan: null, sizes: { S: 1, M: 3, L: 6, XL: 20.5 }, cuts: DEFAULT_CUTS }); // nothing asked, nothing changed
  });

  it('refuses a rate of 0 or below or past 100,000, a negative or huge plan, hours of 0 or below or past 1,000, and anything that is not a number', async () => {
    for (const rate of [0, -1, 100_001, '90', true, {}, []]) expect((await putSettings({ rate })).status, `rate ${JSON.stringify(rate)}`).toBe(400);
    for (const plan of [-1, 1_000_001, '200', false]) expect((await putSettings({ plan })).status, `plan ${JSON.stringify(plan)}`).toBe(400);
    for (const sizes of [{ S: 0 }, { M: -2 }, { L: 1001 }, { XL: '16' }, { S: null }, 'big', []]) expect((await putSettings({ sizes })).status, `sizes ${JSON.stringify(sizes)}`).toBe(400);
    expect(store.worth()).toEqual({ rate: null, plan: null, sizes: DEFAULT_SIZES, cuts: DEFAULT_CUTS }); // a refused body changes nothing, not even its good part
    expect((await putSettings({ rate: 90, plan: -1 })).status).toBe(400);
    expect(store.worth().rate).toBeNull();
  });

  it('ignores a size name it does not know, like the other PUTs ignore unknown keys', async () => {
    const { status, body } = await putSettings({ sizes: { XXL: 40, M: 2.5 }, extra: 1 });
    expect(status).toBe(200);
    expect(body.sizes).toEqual({ S: 0.5, M: 2.5, L: 6, XL: 16 });
  });

  it('studio only: a page from another site is refused (403) and changes nothing, while the studio\'s own origin is taken', async () => {
    expect((await putSettings({ rate: 90 }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(store.worth().rate).toBeNull();
    expect((await putSettings({ rate: 90 }, { origin: 'http://localhost:80' })).status).toBe(200); // inject's host is localhost:80
    expect(store.worth().rate).toBe(90);
  });
});

describe('PUT /api/worth/size', () => {
  it('sets a size on that project\'s merged PR, and GET lists it', async () => {
    expect(await putSize({ project: 'mobile-app', number: 13, size: 'M' })).toEqual({ status: 200, body: { project: 'mobile-app', number: 13, size: 'M' } });
    expect(await sizeOf('mobile-app', 13)).toEqual(['M']);
    const { body } = await rome();
    expect(body.prs.find((p: any) => p.number === 13).size).toBe('M');
    expect(body).toMatchObject({ sized: 6, total: 6 });
    close(body.byHandHours, 24.5 + 2);
  });

  it('changes it, skips it, and takes it back with null', async () => {
    expect((await putSize({ project: 'mobile-app', number: 10, size: 'XL' })).body.size).toBe('XL');
    expect((await putSize({ project: 'mobile-app', number: 10, size: 'skip' })).body.size).toBe('skip');
    expect(await sizeOf('mobile-app', 10)).toEqual(['skip']);
    close((await rome()).body.byHandHours, 24.5 - 6);
    expect((await putSize({ project: 'mobile-app', number: 10, size: null })).body).toEqual({ project: 'mobile-app', number: 10, size: null });
    expect(await sizeOf('mobile-app', 10)).toEqual([null]);
    const { body } = await rome();
    expect(body.prs.find((p: any) => p.number === 10).size).toBeNull();
    expect(body).toMatchObject({ sized: 4, total: 6 });
  });

  it('only that project\'s PR: solo\'s 10 is untouched', async () => {
    await putSize({ project: 'mobile-app', number: 10, size: 'XL' });
    expect(await sizeOf('solo', 10)).toEqual([null]);
    await putSize({ project: 'solo', number: 10, size: 'S' });
    expect(await sizeOf('mobile-app', 10)).toEqual(['XL']);
    expect(await sizeOf('solo', 10)).toEqual(['S']);
  });

  it('accepts exactly S, M, L, XL, skip and null', async () => {
    for (const size of ['S', 'M', 'L', 'XL', 'skip', null]) expect((await putSize({ project: 'mobile-app', number: 11, size })).status, String(size)).toBe(200);
    for (const size of ['XXL', 's', 'Skip', '', 3, true, undefined]) expect((await putSize({ project: 'mobile-app', number: 11, size })).status, String(size)).toBe(400);
    expect(await sizeOf('mobile-app', 11)).toEqual([null]); // the last good one was null
  });

  it('400 for a missing project, an empty one, and a number that is not a positive integer', async () => {
    expect((await putSize({ number: 11, size: 'S' })).status).toBe(400);
    expect((await putSize({ project: '', number: 11, size: 'S' })).status).toBe(400);
    for (const number of [0, -1, 1.5, '11', null, undefined]) expect((await putSize({ project: 'mobile-app', number, size: 'S' })).status, String(number)).toBe(400);
  });

  it('404 for a PR nobody merged here: an unknown number, a project nobody has seen, and a PR that only a session mentioned; nothing is created', async () => {
    const count = async () => one(history, 'SELECT count(*) AS n FROM pull_requests')!.n;
    const before = await count();
    expect((await putSize({ project: 'mobile-app', number: 404, size: 'S' })).status).toBe(404);
    expect((await putSize({ project: 'ghost', number: 10, size: 'S' })).status).toBe(404);
    expect((await putSize({ project: 'mobile-app', number: 99, size: 'S' })).status).toBe(404);
    expect((await putSize({ project: 'mobile-app', number: 404, size: null })).status).toBe(404);
    expect(await count()).toBe(before);
    expect(await sizeOf('mobile-app', 99)).toEqual([]);
  });

  it('studio only: a page from another site is refused (403) and changes nothing', async () => {
    expect((await putSize({ project: 'mobile-app', number: 13, size: 'M' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(await sizeOf('mobile-app', 13)).toEqual([null]);
    expect((await putSize({ project: 'mobile-app', number: 13, size: 'M' }, { origin: 'http://localhost:80' })).status).toBe(200);
  });
});

// ── #103: sizes from the diff, cut points, release merges, and a PR's share of a session ─────────────────────────────────────────────────────────────────────────
// Each test files its PRs under a project of its own, so one test's PRs never change another's totals.
let k = 0;
const fresh = (): Project => ({ cwd: `/Users/a/auto-${++k}`, name: `auto-${k}`, git_remote: `github.com/o/auto-${k}` });
let num = 100;
/** PRs merged in October with their counted [lines, files] (none: an older plugin's), filed under `p`; answers their numbers. */
const merge = (p: Project, specs: ([number, number] | undefined | { title: string; counted?: [number, number]; head?: string })[]) => {
  const numbers: number[] = [];
  const prs = specs.map((spec) => {
    const n = ++num;
    numbers.push(n);
    const o = Array.isArray(spec) || spec === undefined ? { title: `feat: ${n}`, counted: spec, head: undefined } : spec;
    return pr(n, o.title, '2026-10-15T10:00:00Z', 1, 1, o.head, o.counted);
  });
  write([ev(p, `auto-s-${k}`, iso('2026-10-26T10:00:00Z'), 'project.prs', { prs })]);
  return numbers;
};
const rows = async (p: Project) => (await rome('2026-10', p.name)).body;
const rowOf = (body: any, n: number) => body.prs.find((x: any) => x.number === n);

describe('GET /api/worth: automatic sizes', () => {
  it('a PR is sized from its score, lines x (1 + log2 files): 299 is S and 300 is M, 1,499 is M and 1,500 is L, 5,999 is L and 6,000 is XL', async () => {
    const p = fresh();
    const cases: [number, string][] = [[0, 'S'], [299, 'S'], [300, 'M'], [1499, 'M'], [1500, 'L'], [5999, 'L'], [6000, 'XL'], [1_000_000, 'XL']];
    const ns = merge(p, cases.map(([lines]) => [lines, 1]));
    const body = await rows(p);
    cases.forEach(([lines, size], i) => expect(rowOf(body, ns[i]!), `${lines} lines in 1 file`).toMatchObject({ size, yours: false, countedLines: lines, countedFiles: 1 }));
  });

  it('files multiply the lines: 150 lines in 2 files and 100 in 4 score exactly 300, 8 files multiply by 4', async () => {
    const p = fresh();
    const cases: [number, number, string][] = [[150, 2, 'M'], [149, 2, 'S'], [100, 4, 'M'], [99, 4, 'S'], [1500, 8, 'XL'], [1499, 8, 'L'], [375, 8, 'L'], [374, 8, 'M']];
    const ns = merge(p, cases.map(([l, f]) => [l, f]));
    const body = await rows(p);
    cases.forEach(([l, f, size], i) => expect(rowOf(body, ns[i]!).size, `${l} lines in ${f} files`).toBe(size));
  });

  it('no counted files reads as one: the score is the lines alone, so a PR of only lockfiles (0 lines in 0 files) is S, and 5,000 lines in 0 files is L', async () => {
    const p = fresh();
    const [none, big] = merge(p, [[0, 0], [5000, 0]]);
    const body = await rows(p);
    expect(rowOf(body, none!)).toMatchObject({ size: 'S', yours: false, countedLines: 0, countedFiles: 0 });
    expect(rowOf(body, big!).size).toBe('L');
  });

  it('a PR with no counts (an older plugin sent none) stays "not sized": a row, no size, and no hours', async () => {
    const p = fresh();
    const [old, sized] = merge(p, [undefined, [100, 1]]);
    const body = await rows(p);
    expect(rowOf(body, old!)).toMatchObject({ size: null, yours: false, countedLines: null, countedFiles: null });
    expect(body).toMatchObject({ total: 2, sized: 1 });
    close(body.byHandHours, 0.5);
    expect(rowOf(body, sized!).size).toBe('S');
  });

  it('half a count is no count: the server sizes only when it has both', async () => {
    const p = fresh();
    const n = ++num;
    write([ev(p, `half-${k}`, iso('2026-10-26T10:00:00Z'), 'project.prs', { prs: [{ number: n, title: 'x', merged_at: iso('2026-10-15T10:00:00Z'), additions: 1, deletions: 0, counted_lines: 5000 }] })]);
    expect(rowOf(await rows(p), n)).toMatchObject({ size: null, countedLines: 5000, countedFiles: null });
  });

  it('an override wins, Skip is an override, and clearing it returns the auto size', async () => {
    const p = fresh();
    const [a, b, none] = merge(p, [[299, 1], [6000, 1], undefined]);
    const put = (number: number, size: string | null) => putSize({ project: p.name, number, size });
    expect(rowOf(await rows(p), a!)).toMatchObject({ size: 'S', yours: false });
    await put(a!, 'XL');
    expect(rowOf(await rows(p), a!)).toMatchObject({ size: 'XL', yours: true, countedLines: 299 });
    await put(b!, 'skip');
    expect(rowOf(await rows(p), b!)).toMatchObject({ size: 'skip', yours: true });
    await put(none!, 'M'); // a PR with no counts can be sized by hand
    expect(rowOf(await rows(p), none!)).toMatchObject({ size: 'M', yours: true });
    const body = await rows(p);
    expect(body).toMatchObject({ total: 3, sized: 3 });
    close(body.byHandHours, 16 + 0 + 2); // XL, skip, M
    await put(a!, null);
    await put(b!, null);
    await put(none!, null);
    const back = await rows(p);
    expect(rowOf(back, a!)).toMatchObject({ size: 'S', yours: false });
    expect(rowOf(back, b!)).toMatchObject({ size: 'XL', yours: false });
    expect(rowOf(back, none!)).toMatchObject({ size: null, yours: false });
    expect(back).toMatchObject({ total: 3, sized: 2 });
    close(back.byHandHours, 0.5 + 16);
  });

  it('the hours are those of the sizes, auto or yours: Edit Sizes moves them', async () => {
    const p = fresh();
    merge(p, [[100, 1], [400, 1], [2000, 1], [9000, 1]]); // S M L XL
    close((await rows(p)).byHandHours, 0.5 + 2 + 6 + 16);
    store.setWorth({ sizes: { ...DEFAULT_SIZES, M: 3 } });
    close((await rows(p)).byHandHours, 0.5 + 3 + 6 + 16);
  });
});

describe('the cut points', () => {
  it('live with the hours in the settings: S below 300, M below 1,500, L below 6,000 until the owner moves them', async () => {
    expect((await rome()).body.settings.cuts).toEqual({ S: 300, M: 1500, L: 6000 });
    expect(store.worth().cuts).toEqual({ S: 300, M: 1500, L: 6000 });
  });

  it('PUT /api/worth/settings moves one or all, the others keep theirs, and every PR is sized by the new ones', async () => {
    const p = fresh();
    const [a, b, c] = merge(p, [[120, 1], [1200, 1], [5000, 1]]); // S M L today
    expect((await putSettings({ cuts: { M: 1000 } })).body.cuts).toEqual({ S: 300, M: 1000, L: 6000 });
    expect(rowOf(await rows(p), b!).size).toBe('L'); // 1,200 is now past M's edge
    expect((await putSettings({ cuts: { S: 100, M: 1000, L: 4000 } })).body.cuts).toEqual({ S: 100, M: 1000, L: 4000 });
    const body = await rows(p);
    expect([a, b, c].map((n) => rowOf(body, n!).size)).toEqual(['M', 'L', 'XL']);
    expect((await rome()).body.settings.cuts).toEqual({ S: 100, M: 1000, L: 4000 });
    expect((await putSettings({ cuts: {} })).body.cuts).toEqual({ S: 100, M: 1000, L: 4000 });
    expect((await putSettings({ rate: 90 })).body.cuts).toEqual({ S: 100, M: 1000, L: 4000 }); // another setting leaves them alone
  });

  it('they must go up, as S < M < L, judged on the result: one moved past its neighbour, two equal, or a number that is not positive are refused, and nothing changes', async () => {
    for (const cuts of [{ S: 1500 }, { M: 300 }, { M: 6000 }, { L: 1500 }, { S: 500, M: 400, L: 600 }, { S: 0 }, { M: -1 }, { L: '6000' }, { S: null }, { S: 1.5e7 }, 'high', []]) {
      expect((await putSettings({ cuts })).status, JSON.stringify(cuts)).toBe(400);
    }
    expect((await putSettings({ rate: 90, cuts: { M: 100 } })).status).toBe(400);
    expect(store.worth()).toEqual({ rate: null, plan: null, sizes: DEFAULT_SIZES, cuts: DEFAULT_CUTS }); // not even its good part
    expect((await putSettings({ cuts: { S: 299, M: 300, L: 301 } })).status).toBe(200); // close is fine, equal is not
  });

  it('studio only: a page from another site is refused', async () => {
    expect((await putSettings({ cuts: { S: 100 } }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(store.worth().cuts).toEqual(DEFAULT_CUTS);
  });
});

describe('GET /api/worth: release merges', () => {
  it('titles that open chore(release), chore: merge or Merge are no row, in no total, sized or hours (besides the head rule); a title that only mentions them stays', async () => {
    const p = fresh();
    const left = [
      'chore(release): 0.14.0', 'chore(release): merge main into dev', 'chore: merge main into release/0.14', 'chore: merge dev into main',
      'Merge pull request #5 from o/feat-x', "Merge branch 'main' into dev", 'Merge main',
    ];
    const kept = ['feat: merge sort in the importer', 'fix: Merge conflicts in the writer', 'chore: merged state is kept', 'chore: mergeable check', 'chore(deps): bump merge-stream', 'merge conflicts, fixed', 'Merged by hand', 'fix(release-notes): a typo', 'docs: chore(release) is a scope'];
    const ns = merge(p, [...left, ...kept].map((title) => ({ title, counted: [100, 1] as [number, number] })));
    for (const n of ns.slice(0, left.length)) await putSize({ project: p.name, number: n, size: 'XL' }); // sized by the owner, and it must still not count
    const body = await rows(p);
    expect(body.prs.map((x: any) => x.title).sort()).toEqual([...kept].sort());
    expect(body).toMatchObject({ total: kept.length, sized: kept.length, releaseMerges: left.length });
    close(body.byHandHours, 0.5 * kept.length); // 100 lines in a file is S; the releases' XL (16 each) is not there
    expect(all(history, `SELECT count(*) AS n FROM pull_requests WHERE id LIKE '${p.git_remote}:%'`)[0]!.n).toBe(left.length + kept.length); // all stay in the store
  });

  it('says how many it left out: the three title shapes and the head rule, a PR once however many rules it meets, only the month\'s and only this project\'s', async () => {
    const p = fresh();
    merge(p, [
      { title: 'chore(release): 0.14.0' }, { title: 'chore: merge main into dev' }, { title: 'Merge pull request #5 from o/feat-x' }, // one of each title shape
      { title: 'feat: shipped from a release branch', head: 'release/0.15' }, // the head rule alone
      { title: 'chore(release): 0.15.0', head: 'release/0.15' }, // both rules: still one
      { title: 'feat: merge sort in the importer' }, { title: 'feat: a folder inside a name', head: 'feat/release/x' }, // kept
    ]);
    write([ev(p, `rel-${k}`, iso('2026-10-26T10:00:00Z'), 'project.prs', { prs: [pr(++num, 'chore(release): 0.13.0', '2026-09-10T10:00:00Z', 1, 1)] })]); // September's
    const other = fresh();
    merge(other, [{ title: 'Merge main' }]);
    expect(await rows(p)).toMatchObject({ total: 2, releaseMerges: 5 });
    expect((await rome('2026-09', p.name)).body).toMatchObject({ total: 0, releaseMerges: 1 });
    expect((await rome('2026-08', p.name)).body).toMatchObject({ total: 0, releaseMerges: 0 });
    expect((await rows(other)).releaseMerges).toBe(1);
  });

  it('a project that hides its titles has none to read, so only the head rule applies', async () => {
    const p = fresh();
    const n = ++num;
    write([ev(p, `h-${k}`, iso('2026-10-26T10:00:00Z'), 'project.prs', { prs: [{ number: n, merged_at: iso('2026-10-15T10:00:00Z'), additions: 1, deletions: 1, counted_lines: 10, counted_files: 1 }] })]);
    expect((await rows(p)).prs.map((x: any) => x.number)).toEqual([n]);
  });
});

describe('GET /api/worth: a PR\'s share of a session', () => {
  const P: Project = { cwd: '/Users/a/splitter', name: 'splitter', git_remote: 'github.com/o/splitter' };
  const day = (hm: string) => `2026-10-05T${hm}:00Z`;
  const turnBy = (session: string, at: string, model: string, usage: Usage, agent?: string) =>
    ev(P, session, iso(at), 'turn.step', { model, usage, stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: `t-${++t}`, ...(agent ? { agent_id: agent } : {}) });
  const spawn = (session: string, at: string, agent: string) => ev(P, session, iso(at), 'agent.spawn', { tool_use_id: `toolu_${agent}`, agent_type: 'Explore', model: SONNET, prompt_length: 1 }, { agent_id: agent });
  const sessionCost = (session: string) => all(history, `SELECT coalesce(sum(x.cost_usd), 0) AS c FROM api_requests x JOIN turns t ON t.id = x.turn_id JOIN agents a ON a.id = t.agent_id WHERE a.session_id = :session`, { session })[0]!.c as number;
  const sessionAgents = (session: string) => all(history, 'SELECT count(*) AS n FROM agents WHERE session_id = :session', { session })[0]!.n as number;
  const by = async (n: number) => rowOf(await rows(P), n);

  beforeAll(() => {
    write([
      ev(P, 'sp-x', iso('2026-10-26T10:00:00Z'), 'project.prs', { prs: [31, 32, 33, 34, 35, 36, 37].map((n) => pr(n, `feat: ${n}`, `2026-10-${String(n - 20).padStart(2, '0')}T10:00:00Z`, 10, 1, undefined, [10, 1])) }),

      // sp-1: two PRs, and every request before the second link. A's slice: 09:00 up to and including 10:30:00 (r2 sits on the link); B's: after it, up to and including 12:00:00.
      start(P, 'sp-1', day('09:00')),
      turnBy('sp-1', day('10:00'), SONNET, u(0, 10_000)), turnBy('sp-1', day('10:30'), OPUS, u(1_000, 30_000)), link(P, 'sp-1', 31, day('10:30')),
      spawn('sp-1', day('11:00'), 'a-1'), turnBy('sp-1', day('11:30'), SONNET, u(0, 20_000), 'a-1'), turnBy('sp-1', day('12:00'), SONNET, u(0, 5_000)), link(P, 'sp-1', 32, day('12:00')),

      // sp-3 opens PR 31 as well: a PR sums its slice of each session that opened it
      start(P, 'sp-3', day('09:00')), turnBy('sp-3', day('09:30'), SONNET, u(0, 7_000)), link(P, 'sp-3', 31, day('10:00')),

      // sp-2: work after the last link belongs to no PR
      start(P, 'sp-2', day('09:00')), turnBy('sp-2', day('09:30'), SONNET, u(0, 3_000)), link(P, 'sp-2', 33, day('10:00')), turnBy('sp-2', day('11:00'), SONNET, u(0, 90_000)),

      // sp-4: a PR the list never showed (not merged here, or closed) still bounds the slices on both sides
      start(P, 'sp-4', day('09:00')), turnBy('sp-4', day('09:30'), SONNET, u(0, 1_000)), link(P, 'sp-4', 90, day('09:45')),
      turnBy('sp-4', day('10:15'), SONNET, u(0, 2_000)), link(P, 'sp-4', 34, day('10:30')),

      // sp-5: two PRs named at one instant (one output): the lower number takes the slice, the other gets an empty one
      start(P, 'sp-5', day('09:00')), turnBy('sp-5', day('09:30'), SONNET, u(0, 4_000)), link(P, 'sp-5', 36, day('10:00')), link(P, 'sp-5', 35, day('10:00')),

      // sp-6: a link with no time (recorded before the server kept it) gets the whole session, as every link did before
      start(P, 'sp-6', day('09:00')), turnBy('sp-6', day('09:30'), SONNET, u(0, 6_000)), spawn('sp-6', day('09:40'), 'a-6'), turnBy('sp-6', day('11:30'), SONNET, u(0, 8_000)), link(P, 'sp-6', 37, day('10:00')),
    ]);
    run(history, `UPDATE session_prs SET ts = NULL WHERE session_id = 'sp-6'`);
  });

  it('a session with two PR links splits its cost and agents at the link time: A takes what came up to its link (the request on the link included), B what came after', async () => {
    const a = await by(32);
    const first = c(SONNET, u(0, 10_000)) + c(OPUS, u(1_000, 30_000));
    const second = c(SONNET, u(0, 20_000)) + c(SONNET, u(0, 5_000));
    // PR 31 also has sp-3 (below); sp-1's own slice is checked through the totals of both
    expect(a).toMatchObject({ sessions: 1, agents: 1 }); // the subagent spawned in B's window; the main agent started before A's
    close(a.cost, second);
    const b31 = await by(31);
    close(b31.cost, first + c(SONNET, u(0, 7_000))); // sp-1's slice up to A, and all of sp-3 (09:30 is before its link at 10:00)
    expect(b31).toMatchObject({ sessions: 2, agents: 2 }); // sp-1's main and sp-3's main
  });

  it('the two shares add up to the session: its cost and its agents, no more and no less', async () => {
    const [x, y] = [await by(31), await by(32)];
    // sp-1 alone: PR 31's part is its total minus PR 32's
    const sp1Cost = sessionCost('sp-1');
    close(sp1Cost, c(SONNET, u(0, 10_000)) + c(OPUS, u(1_000, 30_000)) + c(SONNET, u(0, 20_000)) + c(SONNET, u(0, 5_000)));
    close(x.cost + y.cost, sp1Cost + sessionCost('sp-3'));
    expect(x.agents + y.agents).toBe(sessionAgents('sp-1') + sessionAgents('sp-3'));
  });

  it('what came after the last link is no PR\'s: the session is split, not handed to the last PR', async () => {
    const n = await by(33);
    close(n.cost, c(SONNET, u(0, 3_000))); // not the 90,000 at 11:00
    expect(sessionCost('sp-2')).toBeGreaterThan(n.cost);
  });

  it('a link to a PR the list never showed still ends the slice before it: PR 34 gets only what came after that link', async () => {
    const n = await by(34);
    close(n.cost, c(SONNET, u(0, 2_000))); // not the 1,000 at 09:30, which belongs to PR 90
    expect(n).toMatchObject({ sessions: 1, agents: 0 }); // the main agent started in PR 90's slice
    expect((await rows(P)).prs.map((x: any) => x.number)).not.toContain(90);
  });

  it('PRs named at one instant: the lower number takes the slice and the other is left with an empty one', async () => {
    const [low, high] = [await by(35), await by(36)];
    close(low.cost, c(SONNET, u(0, 4_000)));
    expect(low.agents).toBe(1);
    expect(high).toMatchObject({ sessions: 1, agents: 0, cost: 0 });
  });

  it('a link with no time keeps the whole session, as before the split', async () => {
    const n = await by(37);
    close(n.cost, c(SONNET, u(0, 6_000)) + c(SONNET, u(0, 8_000)));
    expect(n).toMatchObject({ sessions: 1, agents: 2 });
  });

  it('another project\'s session with a link of the same PR number is not in the window: slices are per session', async () => {
    // mobile-app's g-1 and splitter's sessions never meet: PR 31 here has no mobile-app cost
    expect(rowOf((await rome()).body, 31)).toBeUndefined();
  });
});

describe('the settings are kept in the store\'s file', () => {
  it('survive closing and opening it again, with the defaults for what was never set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orb-worth-'));
    try {
      const path = join(dir, 'content.db');
      const first = openAnalysisStore(path);
      expect(first.worth()).toEqual({ rate: null, plan: null, sizes: { S: 0.5, M: 2, L: 6, XL: 16 }, cuts: { S: 300, M: 1500, L: 6000 } });
      first.setWorth({ rate: 90, sizes: { S: 1 } });
      first.setWorth({ plan: 200 });
      first.close();
      const again = openAnalysisStore(path);
      expect(again.worth()).toEqual({ rate: 90, plan: 200, sizes: { S: 1, M: 2, L: 6, XL: 16 }, cuts: { S: 300, M: 1500, L: 6000 } });
      expect(again.cap()).toBe(20); // the cap beside it is untouched
      again.setWorth({ rate: null });
      expect(again.worth().rate).toBeNull();
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The writer: a pull request per project and number, merged by gh's list and opened by a session's link, whichever comes first.
describe('the writer: pull_requests and session_prs', () => {
  const W: Project = { cwd: '/Users/a/writer', name: 'writer', git_remote: 'github.com/o/writer' };
  // a row's fields without the empty ones, as the node had its properties; project_id is the MERGED link, read by merged()
  const nodes = () => all(history, `SELECT id, number, title, merged_at, additions, deletions, head, size, counted_lines, counted_files FROM pull_requests WHERE id LIKE 'github.com/o/writer:%' ORDER BY number`)
    .map((r) => ({ id: r.id as string, props: Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) }));
  const merged = () => all(history, `SELECT pr.number AS number FROM pull_requests pr JOIN projects p ON p.id = pr.project_id WHERE p.name = 'writer' ORDER BY number`).map((r) => r.number);
  const opened = () => all(history, `SELECT o.session_id AS session, pr.number AS number FROM session_prs o JOIN pull_requests pr ON pr.id = o.pr_id
    WHERE pr.id LIKE 'github.com/o/writer:%' ORDER BY session, number`).map((r) => ({ ...r }));

  it('project.prs makes a row per number with its fields, linked to the project', () => {
    write([ev(W, 'w-1', iso('2026-10-26T10:00:00Z'), 'project.prs', { prs: [pr(1, 'one', '2026-10-01T10:00:00Z', 5, 1, 'feat/one'), pr(2, 'two', '2026-10-02T10:00:00Z', 7, 0)] })]);
    expect(nodes()).toEqual([
      { id: 'github.com/o/writer:1', props: { id: 'github.com/o/writer:1', number: 1, title: 'one', merged_at: iso('2026-10-01T10:00:00Z'), additions: 5, deletions: 1, head: 'feat/one' } },
      { id: 'github.com/o/writer:2', props: { id: 'github.com/o/writer:2', number: 2, title: 'two', merged_at: iso('2026-10-02T10:00:00Z'), additions: 7, deletions: 0 } },
    ]);
    expect(merged()).toEqual([1, 2]);
  });

  it('sending them again from another session changes nothing; a size set by the owner survives, and so does a title a later event leaves out', () => {
    run(history, `UPDATE pull_requests SET size = 'L' WHERE id = 'github.com/o/writer:1'`);
    write([
      ev(W, 'w-2', iso('2026-10-27T10:00:00Z'), 'project.prs', { prs: [pr(1, 'one', '2026-10-01T10:00:00Z', 5, 1, 'feat/one'), pr(2, 'two', '2026-10-02T10:00:00Z', 7, 0)] }),
      ev(W, 'w-2', iso('2026-10-27T10:00:01Z'), 'project.prs', { prs: [{ number: 1, merged_at: iso('2026-10-01T10:00:00Z'), additions: 5, deletions: 1 }] }), // an excluded project's: no title, no branch
    ]);
    const all_ = nodes();
    expect(all_).toHaveLength(2);
    expect(all_[0]!.props).toMatchObject({ number: 1, title: 'one', head: 'feat/one', size: 'L' });
    expect(merged()).toEqual([1, 2]);
  });

  it('session.pr links the session to the PR; twice, or from the plugin and the import, it is one link', () => {
    write([link(W, 'w-1', 1), link(W, 'w-1', 1, '2026-10-05T00:00:00Z'), link(W, 'w-2', 1), link(W, 'w-2', 2)]);
    expect(opened()).toEqual([{ session: 'w-1', number: 1 }, { session: 'w-2', number: 1 }, { session: 'w-2', number: 2 }]);
  });

  it('a session.pr for a PR nobody listed makes the row and the link, and no project link and no merge time; gh\'s list fills it in later', () => {
    write([link(W, 'w-1', 3)]);
    expect(merged()).toEqual([1, 2]);
    expect(nodes().find((x) => x.id === 'github.com/o/writer:3')?.props).toEqual({ id: 'github.com/o/writer:3', number: 3 });
    expect(opened()).toContainEqual({ session: 'w-1', number: 3 });
    write([ev(W, 'w-1', iso('2026-10-28T10:00:00Z'), 'project.prs', { prs: [pr(3, 'three', '2026-10-03T10:00:00Z', 1, 1)] })]);
    expect(merged()).toEqual([1, 2, 3]);
    expect(nodes().find((x) => x.id === 'github.com/o/writer:3')?.props).toMatchObject({ number: 3, title: 'three', merged_at: iso('2026-10-03T10:00:00Z') });
    expect(opened()).toContainEqual({ session: 'w-1', number: 3 }); // one row: the link stayed on it
  });

  it('in one batch, the link before the list or after it gives the same store', () => {
    const batch = [link(W, 'w-3', 4, '2026-10-04T00:00:00Z'), ev(W, 'w-3', iso('2026-10-29T10:00:00Z'), 'project.prs', { prs: [pr(4, 'four', '2026-10-04T10:00:00Z', 4, 4)] }), link(W, 'w-3', 4, '2026-10-30T00:00:00Z')];
    write(batch);
    expect(nodes().filter((x) => x.id.endsWith(':4'))).toHaveLength(1);
    expect(merged()).toEqual([1, 2, 3, 4]);
    expect(opened().filter((x) => x.number === 4)).toEqual([{ session: 'w-3', number: 4 }]);
  });

  it('the same number in another project is another row: the id is the project\'s and the number', () => {
    expect(all(history, 'SELECT id FROM pull_requests WHERE number = 10 ORDER BY id').map((r) => r.id)).toEqual(['github.com/o/mobile-app:10', 'github.com/o/solo:10']);
  });

  it('a project with no remote files its PRs under host:cwd', () => {
    write([link({ cwd: '/Users/a/noremote', name: 'noremote' }, 'nr-1', 6)]);
    expect(all(history, 'SELECT id FROM pull_requests WHERE number = 6').map((r) => r.id)).toEqual(['mbp:/Users/a/noremote:6']);
  });

  it('project.prs keeps the counted lines and files, and a later list that leaves them out does not erase them (#103)', () => {
    const P2: Project = { cwd: '/Users/a/counts', name: 'counts', git_remote: 'github.com/o/counts' };
    const stored = () => all(history, `SELECT number, counted_lines, counted_files FROM pull_requests WHERE id LIKE 'github.com/o/counts:%' ORDER BY number`).map((r) => ({ ...r }));
    write([ev(P2, 'c-1', iso('2026-10-26T10:00:00Z'), 'project.prs', { prs: [pr(1, 'one', '2026-10-01T10:00:00Z', 5, 1, undefined, [4, 2]), pr(2, 'two', '2026-10-02T10:00:00Z', 7, 0)] })]);
    expect(stored()).toEqual([{ number: 1, counted_lines: 4, counted_files: 2 }, { number: 2, counted_lines: null, counted_files: null }]);
    write([ev(P2, 'c-2', iso('2026-10-27T10:00:00Z'), 'project.prs', { prs: [pr(1, 'one', '2026-10-01T10:00:00Z', 5, 1), pr(2, 'two', '2026-10-02T10:00:00Z', 7, 0, undefined, [0, 0])] })]);
    expect(stored()).toEqual([{ number: 1, counted_lines: 4, counted_files: 2 }, { number: 2, counted_lines: 0, counted_files: 0 }]);
  });

  it('session.pr keeps the time of the link, the earliest seen: the plugin and the import, in either order, agree (#103)', () => {
    const P3: Project = { cwd: '/Users/a/linktime', name: 'linktime', git_remote: 'github.com/o/linktime' };
    const at = () => all(history, `SELECT ts FROM session_prs WHERE session_id = 'l-1'`).map((r) => r.ts);
    write([link(P3, 'l-1', 1, '2026-10-05T10:00:00Z')]);
    expect(at()).toEqual([iso('2026-10-05T10:00:00Z')]);
    write([link(P3, 'l-1', 1, '2026-10-05T12:00:00Z')]); // seen again later: the link stays where it was
    expect(at()).toEqual([iso('2026-10-05T10:00:00Z')]);
    write([link(P3, 'l-1', 1, '2026-10-05T09:00:00Z')]); // the import finds an earlier mention
    expect(at()).toEqual([iso('2026-10-05T09:00:00Z')]);
    run(history, `UPDATE session_prs SET ts = NULL WHERE session_id = 'l-1'`); // a link recorded before the server kept times
    write([link(P3, 'l-1', 1, '2026-10-06T00:00:00Z')]);
    expect(at()).toEqual([iso('2026-10-06T00:00:00Z')]); // the next mention gives it one
  });

  it('a history file written before #103 gains the columns when it is opened, keeps its rows, and opening it again is harmless', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'orb-old-'));
    try {
      const path = join(dir2, 'history.db');
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE pull_requests (id TEXT PRIMARY KEY, project_id TEXT, number INTEGER NOT NULL, title TEXT, merged_at INTEGER, additions INTEGER, deletions INTEGER, head TEXT, size TEXT) WITHOUT ROWID;
        CREATE TABLE session_prs (session_id TEXT NOT NULL, pr_id TEXT NOT NULL, PRIMARY KEY (session_id, pr_id)) WITHOUT ROWID;
        INSERT INTO pull_requests (id, number, title, size) VALUES ('p:1', 1, 'old', 'L'); INSERT INTO session_prs VALUES ('s', 'p:1');`);
      old.close();
      for (let i = 0; i < 2; i++) {
        const db = openStore(path);
        expect(all(db, `SELECT name FROM pragma_table_info('pull_requests') WHERE name LIKE 'counted_%' ORDER BY name`).map((r) => r.name)).toEqual(['counted_files', 'counted_lines']);
        expect(all(db, `SELECT name FROM pragma_table_info('session_prs') WHERE name = 'ts'`)).toHaveLength(1);
        expect(all(db, 'SELECT title, size, counted_lines FROM pull_requests').map((r) => ({ ...r }))).toEqual([{ title: 'old', size: 'L', counted_lines: null }]);
        expect(all(db, 'SELECT session_id, ts FROM session_prs').map((r) => ({ ...r }))).toEqual([{ session_id: 's', ts: null }]);
        db.close();
      }
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('pull_requests.id is the primary key: one row per project and number', () => {
    expect(all(history, `SELECT name FROM pragma_table_info('pull_requests') WHERE pk > 0`).map((r) => r.name)).toEqual(['id']);
  });
});
