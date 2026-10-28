import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Event, Usage } from '@agent-orb/shared';
import { buildApp } from '../src/app.ts';
import { costUsd } from '../src/cost.ts';
import { openStore, run, type Store } from '../src/store/store.ts';
import { writeEvents } from '../src/store/writer.ts';

// GET /api/trends (v0.2 slice 1; design/v0.2-measure.html): API-equivalent cost per week or day, by who spent and by model, per active
// day and per prompt, and what a change did to it. Seeded with named requests so every expected number is a sum of named costs.
const TOKEN = 'test-token-0123456789';
const iso = (s: string) => Date.parse(s);
let dir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
const write = (events: Event[]) => writeEvents(store, events, 'plugin');

const MOBILE = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
const SOLO = { cwd: '/Users/a/solo', name: 'solo', git_remote: 'github.com/o/solo' };
let n = 0;
const ev = (project: typeof MOBILE, session: string, ts: number, kind: string, data: object, extra: object = {}): Event =>
  ({ v: 1, id: `00000000-0000-4000-b000-${String(++n).padStart(12, '0')}`, ts, host: 'mbp', user_id: 'local', session_id: session, project, kind, data, ...extra }) as Event;

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';
const FABLE9 = 'claude-fable-9'; // not in pricing.json: cost null, tokens still counted
const u = (input: number, output: number, cache_read = 0, cache_creation = 0): Usage => ({ input, output, cache_read, cache_creation });

// Local days are Europe/Rome (UTC+2 until 25 Oct 2026). Week 1 starts Mon 12 Oct, week 2 Mon 19 Oct.
type Req = { at: string; agent: string; model: string; usage: Usage };
const R: Record<string, Req> = {
  r00: { at: '2026-10-05T09:00:00Z', agent: 'main', model: OPUS, usage: u(100, 100_000) }, // 8 days before change B: outside its `before`
  r0: { at: '2026-10-06T09:00:00Z', agent: 'main', model: OPUS, usage: u(100, 100_000, 10_000) }, // 7 days before change B: its `before`, but before `from`
  r1: { at: '2026-10-13T10:00:00Z', agent: 'main', model: OPUS, usage: u(100, 100_000, 50_000) },
  r2: { at: '2026-10-13T10:05:00Z', agent: 'gp', model: OPUS, usage: u(200, 200_000, 0, 10_000) },
  r3: { at: '2026-10-15T12:00:00Z', agent: 'main', model: SONNET, usage: u(300, 100_000, 30_000) },
  r4: { at: '2026-10-15T12:10:00Z', agent: 'impl', model: HAIKU, usage: u(1_000, 100_000) },
  r5: { at: '2026-10-18T23:30:00Z', agent: 'main', model: OPUS, usage: u(100, 100_000, 20_000) }, // Sunday in UTC, 01:30 Monday 19 Oct in Rome
  r6: { at: '2026-10-19T08:00:00Z', agent: 'main', model: OPUS, usage: u(100, 100_000, 40_000) },
  r7: { at: '2026-10-21T09:00:00Z', agent: 'main', model: OPUS, usage: u(100, 50_000, 10_000) },
  r8: { at: '2026-10-21T09:30:00Z', agent: 'impl', model: SONNET, usage: u(100, 100_000, 5_000) },
  r9: { at: '2026-10-21T10:00:00Z', agent: 'wf', model: OPUS, usage: u(100, 100_000) },
  r10: { at: '2026-10-22T09:00:00Z', agent: 'ghost', model: OPUS, usage: u(100, 50_000) }, // an agent whose spawn was never seen: no type
  r11: { at: '2026-10-22T09:10:00Z', agent: 'main', model: FABLE9, usage: u(10, 1_000) },
  r12: { at: '2026-10-23T09:00:00Z', agent: 'main', model: OPUS, usage: u(100, 100_000) }, // after `to`
  r13: { at: '2026-10-20T09:00:00Z', agent: 'main', model: SONNET, usage: u(100, 20_000, 7_000) }, // 7 days after change B: outside its `after`
};
const c = (name: string) => costUsd(R[name]!.model, R[name]!.usage)!;
const sum = (...names: string[]) => names.reduce((t, k) => t + c(k), 0);
const tokens = (...names: string[]) => names.reduce((t, k) => { const x = R[k]!.usage; return t + x.input + x.output + x.cache_read + x.cache_creation; }, 0);
const reads = (...names: string[]) => names.reduce((t, k) => t + R[k]!.usage.cache_read, 0);
const inputSide = (...names: string[]) => names.reduce((t, k) => { const x = R[k]!.usage; return t + x.input + x.cache_read + x.cache_creation; }, 0);

const AGENT_TYPES: Record<string, string> = { impl: 'implementer', gp: 'general-purpose', wf: 'workflow-subagent' };
const seeded: Event[] = [
  ev(MOBILE, 'g-1', iso('2026-10-08T08:00:00Z'), 'session.start', { model: OPUS, source: 'startup', claude_version: '2.1.304', plugin_version: '0.1.0' }),
  ...Object.entries(AGENT_TYPES).map(([id, type]) =>
    ev(MOBILE, 'g-1', iso('2026-10-08T08:00:01Z'), 'agent.spawn', { tool_use_id: `toolu_${id}`, agent_type: type, model: OPUS, prompt_length: 1 }, { agent_id: id })),
  ...Object.values(R).map((r, i) =>
    ev(MOBILE, 'g-1', iso(r.at), 'turn.step', { model: r.model, usage: r.usage, stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: `t-${r.agent}-${i}`, ...(r.agent === 'main' ? {} : { agent_id: r.agent }) })),
  // prompts: two in week 1; in week 2 one at 01:25 Monday Rome (Sunday in UTC), one on Monday morning, one on Wednesday
  ...['2026-10-13T09:59:00Z', '2026-10-15T11:59:00Z', '2026-10-18T23:25:00Z', '2026-10-19T07:59:00Z', '2026-10-21T08:59:00Z'].map((at, i) =>
    ev(MOBILE, 'g-1', iso(at), 'prompt.submit', { length: 10 }, { prompt_id: `p-${i}` })),
  // changes: cA between the two weeks (08:00 Monday 19 Oct in Rome), cB on 13 Oct, one before `from`, one past `to`; cE is cA's day too in
  // Rome (00:30 on the 19th, but 22:30 on the 18th in UTC)
  ev(MOBILE, 'g-1', iso('2026-10-24T00:00:00Z'), 'project.changes', { commits: [
    { sha: 'e'.repeat(40), ts: iso('2026-10-18T22:30:00Z'), subject: 'feat: skills first', files: ['.claude/agents/implementer.md', 'CLAUDE.md'] },
    { sha: 'a'.repeat(40), ts: iso('2026-10-19T06:00:00Z'), subject: 'feat: route issues through the agents', files: ['.claude/skills/code/SKILL.md', 'CLAUDE.md'] },
    { sha: 'b'.repeat(40), ts: iso('2026-10-13T15:00:00Z'), subject: 'feat: the agents arrive', files: ['.claude/agents/implementer.md'] },
    { sha: 'c'.repeat(40), ts: iso('2026-10-05T10:00:00Z'), files: ['CLAUDE.md'] },
    { sha: 'd'.repeat(40), ts: iso('2026-10-23T10:00:00Z'), subject: 'chore: later', files: [] },
  ] }),
  // a second project: one request on 20 Oct, and a change on each side of it
  ev(SOLO, 's-1', iso('2026-10-20T10:00:00Z'), 'turn.step', { model: SONNET, usage: u(0, 100_000), stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: 't-solo' }),
  ev(SOLO, 's-1', iso('2026-10-20T11:00:00Z'), 'project.changes', { commits: [
    { sha: '1'.repeat(40), ts: iso('2026-10-20T10:00:00Z'), files: ['CLAUDE.md'] },
    { sha: '2'.repeat(40), ts: iso('2026-10-21T10:00:00Z'), files: ['CLAUDE.md'] },
  ] }),
];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-trends-'));
  store = openStore(join(dir, 'history.db'));
  app = buildApp({ store, token: TOKEN });
  write(seeded);
});
afterAll(async () => {
  await app?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const FROM = iso('2026-10-11T22:00:00Z'); // Monday 12 Oct 00:00 in Rome
const TO = iso('2026-10-22T12:00:00Z'); // Thursday 22 Oct, mid-day
const view = { project: 'mobile-app', unit: 'week', from: FROM, to: TO, tz: 'Europe/Rome' };
const get = async (q: Record<string, string | number>) => {
  const res = await app.inject({ method: 'GET', url: `/api/trends?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}` });
  return { status: res.statusCode, body: res.json() };
};
const close = (got: number, want: number) => expect(got).toBeCloseTo(want, 9);

describe('GET /api/trends: buckets', () => {
  it('a bucket per week starting Monday, in the viewer\'s zone: who spent, model family, tokens, cache, active days, prompts', async () => {
    const { status, body } = await get(view);
    expect(status).toBe(200);
    expect(body.buckets.map((b: any) => b.bucket)).toEqual(['2026-10-12', '2026-10-19']);
    const [w1, w2] = body.buckets;
    // week of 12 Oct: r1 r2 r3 r4
    close(w1.main, sum('r1', 'r3'));
    close(w1.typed, sum('r4'));
    close(w1.generic, sum('r2'));
    close(w1.opus, sum('r1', 'r2'));
    close(w1.sonnet, sum('r3'));
    close(w1.haiku, sum('r4'));
    expect(w1.other).toBe(0);
    expect(w1).toMatchObject({ tokens: tokens('r1', 'r2', 'r3', 'r4'), cacheRead: reads('r1', 'r2', 'r3', 'r4'), inputSide: inputSide('r1', 'r2', 'r3', 'r4'), activeDays: 2, prompts: 2, costPartial: false });
    // week of 19 Oct: r5 (01:30 Monday in Rome, Sunday in UTC) r6 r13 r7 r8 r9 r10 r11 (r12 is past `to`)
    close(w2.main, sum('r5', 'r6', 'r7', 'r13')); // r11 is unpriced: it adds tokens, not cost
    close(w2.typed, sum('r8'));
    close(w2.generic, sum('r9', 'r10')); // a workflow agent, and an agent with no type
    close(w2.opus, sum('r5', 'r6', 'r7', 'r9', 'r10'));
    close(w2.sonnet, sum('r8', 'r13'));
    expect(w2.haiku).toBe(0);
    expect(w2.other).toBe(0);
    const wk2 = ['r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r13'];
    expect(w2).toMatchObject({ tokens: tokens(...wk2), cacheRead: reads(...wk2), inputSide: inputSide(...wk2), activeDays: 4, prompts: 3, costPartial: true });
    // every total is the sum of its parts, both ways
    for (const b of body.buckets) close(b.main + b.typed + b.generic, b.opus + b.sonnet + b.haiku + b.other);
  });

  it('the same data in UTC puts the 23:30 request in the earlier week, the 01:25 prompt too', async () => {
    const { body } = await get({ ...view, tz: 'UTC' });
    const [w1, w2] = body.buckets;
    expect(w1.bucket).toBe('2026-10-12');
    close(w1.main, sum('r1', 'r3', 'r5'));
    expect(w1).toMatchObject({ activeDays: 3, prompts: 3 });
    close(w2.main, sum('r6', 'r7', 'r13'));
    expect(w2).toMatchObject({ activeDays: 4, prompts: 2 });
  });

  it('unit=day: a bucket per local day with requests, and prompts counted on their local day', async () => {
    const { body } = await get({ ...view, unit: 'day' });
    expect(body.buckets.map((b: any) => [b.bucket, b.activeDays, b.prompts])).toEqual([
      ['2026-10-13', 1, 1], ['2026-10-15', 1, 1], ['2026-10-19', 1, 2], ['2026-10-20', 1, 0], ['2026-10-21', 1, 1], ['2026-10-22', 1, 0],
    ]);
    const day = Object.fromEntries(body.buckets.map((b: any) => [b.bucket, b]));
    close(day['2026-10-19'].main, sum('r5', 'r6')); // the Rome date of r5
    close(day['2026-10-21'].generic, sum('r9'));
    expect(day['2026-10-22'].costPartial).toBe(true);
    expect(day['2026-10-13'].costPartial).toBe(false);
  });

  it('a request on a model that is not priced counts its tokens and marks the bucket partial, and a model family is by name', async () => {
    const { body } = await get({ ...view, unit: 'day', from: iso('2026-10-21T22:00:00Z'), to: TO });
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0]).toMatchObject({ bucket: '2026-10-22', tokens: tokens('r10', 'r11'), costPartial: true, other: 0, haiku: 0, sonnet: 0 });
    close(body.buckets[0].opus, sum('r10'));
  });

  it('without a project: every project together', async () => {
    const { project: _, ...all } = view;
    const { body } = await get(all);
    const solo = costUsd(SONNET, u(0, 100_000))!; // solo's one request, 20 Oct: a main agent's, in the week of 19 Oct
    const w2 = body.buckets.find((b: any) => b.bucket === '2026-10-19');
    close(w2.main, sum('r5', 'r6', 'r7', 'r13') + solo);
    expect(w2.activeDays).toBe(4); // 19, 20, 21 and 22 Oct: distinct days over every project, not a sum per project
  });

  it('nothing for a project with no data, and 400 on a bad query', async () => {
    expect((await get({ ...view, project: 'nobody' })).body).toEqual({ buckets: [], changes: [] });
    expect((await get({ ...view, to: view.from })).status).toBe(400);
    expect((await get({ ...view, unit: 'month' })).status).toBe(400);
    expect((await get({ ...view, tz: 'Mars/Olympus' })).status).toBe(400);
    const { from: _, ...noFrom } = view;
    expect((await get(noFrom)).status).toBe(400);
  });
});

describe('GET /api/trends: changes', () => {
  const sha = (c: string) => c.repeat(40);

  it('one change per project and local day, oldest first: its commits in time order, the files they touched, and the first commit\'s time', async () => {
    const { body } = await get(view);
    expect(body.changes.map((x: any) => Object.keys(x).sort())).toEqual([['after', 'before', 'commits', 'day', 'files', 'id', 'seen', 'ts'], ['after', 'before', 'commits', 'day', 'files', 'id', 'seen', 'ts']]);
    expect(body.changes.map((x: any) => x.seen)).toEqual([[], []]); // nothing was found by a fingerprint (v0.2 slice 3); trends-seen.test.ts has those
    expect(body.changes.map((x: any) => [x.id, x.day, x.ts, x.files])).toEqual([
      ['github.com/o/mobile-app:2026-10-13', '2026-10-13', iso('2026-10-13T15:00:00Z'), ['.claude/agents/implementer.md']],
      // cE (00:30 Rome) then cA (08:00 Rome): two commits, one change; CLAUDE.md is in both and listed once, in the order first seen
      ['github.com/o/mobile-app:2026-10-19', '2026-10-19', iso('2026-10-18T22:30:00Z'), ['.claude/agents/implementer.md', 'CLAUDE.md', '.claude/skills/code/SKILL.md']],
    ]); // 5 Oct is before `from`, 23 Oct is past `to`
    expect(body.changes.map((x: any) => x.commits.map((c: any) => [c.sha, c.ts, c.subject, c.files]))).toEqual([
      [[sha('b'), iso('2026-10-13T15:00:00Z'), 'feat: the agents arrive', ['.claude/agents/implementer.md']]],
      [
        [sha('e'), iso('2026-10-18T22:30:00Z'), 'feat: skills first', ['.claude/agents/implementer.md', 'CLAUDE.md']],
        [sha('a'), iso('2026-10-19T06:00:00Z'), 'feat: route issues through the agents', ['.claude/skills/code/SKILL.md', 'CLAUDE.md']],
      ],
    ]);
  });

  it('the day is the viewer\'s: in UTC the same two commits are two changes, on the 18th and the 19th', async () => {
    const { body } = await get({ ...view, tz: 'UTC' });
    expect(body.changes.map((x: any) => [x.id, x.commits.map((c: any) => c.sha.slice(0, 1))])).toEqual([
      ['github.com/o/mobile-app:2026-10-13', ['b']], ['github.com/o/mobile-app:2026-10-18', ['e']], ['github.com/o/mobile-app:2026-10-19', ['a']],
    ]);
  });

  it('before: the 7 whole local days before the change\'s day; after: its day and 6 more, up to `to`; only active days count', async () => {
    const { body } = await get(view);
    const [b, a] = body.changes;
    // cB, 13 Oct: before is 6 to 12 Oct (r0 on the 6th, outside the view's range; r00 on the 5th is out), after is 13 to 19 Oct (r13 on the 20th is out)
    expect(b.before.days).toBe(1);
    close(b.before.cost, sum('r0'));
    close(b.before.generic, 0);
    close(b.before.typed, 0);
    close(b.before.opus, sum('r0'));
    expect(b.after.days).toBe(3); // 13, 15 and 19 Oct
    close(b.after.cost, sum('r1', 'r2', 'r3', 'r4', 'r5', 'r6'));
    close(b.after.generic, sum('r2'));
    close(b.after.typed, sum('r4'));
    close(b.after.opus, sum('r1', 'r2', 'r5', 'r6'));
    // cA, 19 Oct 08:00 in Rome: before is 12 to 18 Oct, after is 19 to 25 Oct cut at `to` (r12 on the 23rd is out)
    expect(a.before.days).toBe(2); // 13 and 15 Oct; r5 is on the 19th in Rome
    close(a.before.cost, sum('r1', 'r2', 'r3', 'r4'));
    close(a.before.generic, sum('r2'));
    close(a.before.typed, sum('r4'));
    close(a.before.opus, sum('r1', 'r2'));
    expect(a.after.days).toBe(4); // 19, 20, 21 and 22 Oct, the 19th from 01:30 on: the whole day
    close(a.after.cost, sum('r5', 'r6', 'r13', 'r7', 'r8', 'r9', 'r10')); // r11 unpriced
    close(a.after.generic, sum('r9', 'r10'));
    close(a.after.typed, sum('r8'));
    close(a.after.opus, sum('r5', 'r6', 'r7', 'r9', 'r10'));
    expect(Object.keys(a.after).sort()).toEqual(['cost', 'days', 'generic', 'opus', 'typed']);
  });

  it('a side with no active day is null', async () => {
    const { body } = await get({ ...view, project: 'solo', unit: 'day' });
    const [first, second] = body.changes;
    expect(first.before).toBeNull();
    expect(first.after).toMatchObject({ days: 1 });
    close(first.after.cost, costUsd(SONNET, u(0, 100_000))!);
    expect(second.before).toMatchObject({ days: 1 });
    expect(second.after).toBeNull();
    expect(second.commits.map((c: any) => c.subject)).toEqual([null]); // sent without one (an excluded project)
  });

  it('a change is compared on its own project; without a project every project\'s changes come, each on its own', async () => {
    const { project: _, ...all } = view;
    const { body } = await get(all);
    expect(body.changes).toHaveLength(4);
    const solo = body.changes.filter((x: any) => x.id.startsWith('github.com/o/solo'));
    expect(solo.map((x: any) => [x.before?.days ?? null, x.after?.days ?? null])).toEqual([[null, 1], [1, null]]);
  });

  it('a project with no changes gives an empty list, not an error', async () => {
    run(store, `INSERT INTO projects (id, name) VALUES ('bare', 'bare')`);
    expect((await get({ ...view, project: 'bare' })).body).toEqual({ buckets: [], changes: [] });
  });

  it('the same day in two projects is two changes, each on its own project (this one runs last: it adds a project)', async () => {
    const TWIN = { cwd: '/Users/a/twin', name: 'twin', git_remote: 'github.com/o/twin' };
    write([ev(TWIN, 't-1', iso('2026-10-20T12:00:00Z'), 'project.changes', { commits: [{ sha: sha('9'), ts: iso('2026-10-20T11:00:00Z'), files: ['CLAUDE.md'] }] })]);
    const { project: _, ...all } = view;
    const { body } = await get(all);
    expect(body.changes.filter((x: any) => x.day === '2026-10-20').map((x: any) => x.id).sort()).toEqual(['github.com/o/solo:2026-10-20', 'github.com/o/twin:2026-10-20']);
    expect(body.changes.map((x: any) => x.ts)).toEqual([...body.changes.map((x: any) => x.ts)].sort((a: number, b: number) => a - b)); // oldest first across projects
  });
});
