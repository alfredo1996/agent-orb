import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { costUsd } from '../src/cost.ts';
import { all, openStore, type Store } from '../src/store/store.ts';
import { seedStore } from './seed-store.ts';

// Slice 5 (§8.3, §15 2026-10-21): the catalogue and skill loads land in the history store, and /api/skills reads them back.
const TOKEN = 'test-token-0123456789';
const T = 1_792_800_000_000;
const shop = { cwd: '/w/shop', name: 'shop', git_remote: 'github.com/o/shop' };
const other = { cwd: '/w/other', name: 'other' };
let n = 0;
const ev = (session: string, project: object, kind: string, data: object, extra: object = {}, ts = T + n * 1000) =>
  ({ v: 1, host: 'mbp', user_id: 'x', session_id: session, project, id: `00000000-0000-4000-9c00-${String(++n).padStart(12, '0')}`, ts, kind, data, ...extra });
const usage = (tokens: number) => ({ input: tokens, output: 0, cache_read: 0, cache_creation: 0 });
const start = (s: string, p: object, ts: number) => ev(s, p, 'session.start', { model: 'claude-opus-5-5', source: 'interactive', claude_version: 'v', plugin_version: 'p' }, {}, ts);
const inTurn = (s: string, agent?: string) => ({ turn_id: `${s}-${agent ?? 'main'}-t`, ...(agent && { agent_id: agent }) });
const step = (s: string, p: object, tokens: number, ts: number, agent?: string) =>
  ev(s, p, 'turn.step', { model: 'claude-sonnet-5-5', usage: usage(tokens), stop_reason: 'end_turn', tool_use_ids: [] }, inTurn(s, agent), ts);
const catalog = (s: string, p: object, ts: number, skills: object[], agents: object[] = []) => ev(s, p, 'skills.catalog', { skills, agents }, {}, ts);

const events = [
  start('s1', shop, T),
  catalog('s1', shop, T + 1, [
    { name: 'code', source: 'projectSettings', tokens: 96, description: 'Implement through the agents', refs: { skills: [], agents: ['implementer'] } },
    { name: 'test', source: 'projectSettings', tokens: 30, refs: { skills: [], agents: [] } },
    { name: 'commit', source: 'projectSettings', tokens: 28, refs: { skills: [], agents: [] } },
    { name: 'issue', source: 'projectSettings', tokens: 40 }, { name: 'issue', source: 'userSettings', tokens: 44 },
  ], [{ name: 'implementer', source: 'projectSettings', tokens: 15, refs: { skills: ['test'], agents: [] }, preload: [] }]),
  ev('s1', shop, 'turn.start', {}, inTurn('s1'), T + 2),
  ev('s1', shop, 'skill.load', { skill: 'code', how: 'typed', source: 'projectSettings' }, inTurn('s1'), T + 2),
  step('s1', shop, 300, T + 5),
  ev('s1', shop, 'tool.call', { tool_use_id: 'tu-a1', tool: 'Agent', input_size: 1 }, inTurn('s1'), T + 10),
  ev('s1', shop, 'agent.spawn', { tool_use_id: 'tu-a1', agent_type: 'implementer', description: 'build', model: 'claude-sonnet-5-5', prompt_length: 5 }, { agent_id: 'a1' }, T + 11),
  ev('s1', shop, 'turn.start', {}, inTurn('s1', 'a1'), T + 12),
  ev('s1', shop, 'tool.call', { tool_use_id: 'tu-s1', tool: 'Skill', input_size: 1 }, inTurn('s1', 'a1'), T + 13),
  ev('s1', shop, 'skill.load', { skill: 'test', how: 'tool', source: 'projectSettings', tool_use_id: 'tu-s1' }, inTurn('s1', 'a1'), T + 14),
  step('s1', shop, 5000, T + 20, 'a1'),
  start('s2', other, T + 100),
  catalog('s2', other, T + 101, [{ name: 'secret-skill', source: 'projectSettings', tokens: 9 }]),
];

let dir: string;
let store: Store;
let app: ReturnType<typeof buildApp>;
const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orb-skills-'));
  store = openStore(join(dir, 'history.db'));
  app = buildApp({ store, token: TOKEN });
  expect(seedStore(store, events)).toEqual({ accepted: events.length, duplicates: 0 });
});

afterAll(async () => {
  await app?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/skills', () => {
  const week = `from=${T - 1000}&to=${T + 86_400_000}`;

  it('the typed skill owns its turn and the agent it dispatched; the agent\'s own skill hangs from the agent type', async () => {
    const { status, body } = await get(`/api/skills?project=shop&${week}`);
    expect(status).toBe(200);
    expect(body.usage.map((u: any) => [u.name, u.runs, u.tokens, u.how])).toEqual([
      ['code', 1, 5300, { you: 1, model: 0, agent: 0, preload: 0 }],
      ['test', 1, 5000, { you: 0, model: 0, agent: 1, preload: 0 }],
    ]);
    const e = (from: string, to: string) => body.edges.find((x: any) => x.from === from && x.to === to);
    expect(e('skill:projectSettings:code', 'agent:implementer')).toMatchObject({ did: 1, named: true, tokens: 5000 });
    expect(e('agent:implementer', 'skill:projectSettings:test')).toMatchObject({ did: 1, named: true });
    expect(body.nodes.find((x: any) => x.id === 'skill:projectSettings:code')).toMatchObject({ description: 'Implement through the agents', listed: 96, byYou: 1 });
    expect(body.nodes.find((x: any) => x.id === 'agent:implementer')).toMatchObject({ spawns: 1, tokens: 5000 });
  });

  it('lists what never ran with its listing tokens, flags the name two skills share, and keeps other projects out', async () => {
    const { body } = await get(`/api/skills?project=shop&${week}`);
    expect(body.idle).toEqual([
      { name: 'issue', source: 'userSettings', tokens: 44, clash: true },
      { name: 'issue', source: 'projectSettings', tokens: 40, clash: true },
      { name: 'commit', source: 'projectSettings', tokens: 28, clash: false },
    ]);
    expect(JSON.stringify(body)).not.toContain('secret-skill');
  });

  it('one session alone, and a 400 without a project or a range', async () => {
    expect((await get('/api/skills?project=shop&session=s1')).body.usage).toHaveLength(2);
    expect((await get('/api/skills?project=shop&session=s2')).body.usage).toEqual([]);
    expect((await get('/api/skills?project=shop')).status).toBe(400);
    expect((await get(`/api/skills?${week}`)).status).toBe(400);
  });

  it('a second catalogue without references keeps the ones an earlier event gave', async () => {
    const later = [start('s3', shop, T + 200), catalog('s3', shop, T + 201, [{ name: 'code', source: 'projectSettings', tokens: 97 }])];
    seedStore(store, later);
    const rows = all(store, `SELECT d.tokens AS tokens, d.calls_agents AS agents, (SELECT count(*) FROM session_skill_defs l WHERE l.def_id = d.id) AS sessions FROM skill_defs d WHERE d.name = 'code'`);
    expect(rows.map((r) => ({ ...r, agents: JSON.parse(r.agents) }))).toEqual([{ tokens: 97, agents: ['implementer'], sessions: 2 }]);
  });
});

// What a turn's requests are charged to: the skill that started the chain, from its load on; requests before it are no skill's, and an unpriced request adds
// its tokens and marks the figure a floor. The store hands the graph these requests grouped by the load they follow, not one by one.
describe('GET /api/skills: what the requests of a turn are charged to', () => {
  const rack = { cwd: '/w/rack', name: 'rack', git_remote: 'github.com/o/rack' };
  const sonnet = 'claude-sonnet-5-5';
  const priced = (tokens: number) => costUsd(sonnet, usage(tokens))!;
  const req = (s: string, tokens: number, ts: number, model = sonnet, agent?: string) =>
    ev(s, rack, 'turn.step', { model, usage: usage(tokens), stop_reason: 'end_turn', tool_use_ids: [] }, inTurn(s, agent), ts);
  const load = (s: string, skill: string, how: string, ts: number, agent?: string) => ev(s, rack, 'skill.load', { skill, how, source: 'projectSettings' }, inTurn(s, agent), ts);
  const R = T + 1_000_000;
  const rackEvents = [
    start('r1', rack, R),
    catalog('r1', rack, R + 1, [{ name: 'alpha', source: 'projectSettings', tokens: 10, refs: { skills: ['beta'], agents: ['scout'] } }, { name: 'beta', source: 'projectSettings', tokens: 20 }],
      [{ name: 'scout', source: 'projectSettings', tokens: 5 }]),
    ev('r1', rack, 'turn.start', {}, inTurn('r1'), R + 2),
    req('r1', 100, R + 3), // before any skill: nobody's
    load('r1', 'alpha', 'typed', R + 10),
    req('r1', 1000, R + 11),
    load('r1', 'beta', 'tool', R + 12), // called from alpha, so it starts no chain
    req('r1', 2000, R + 13),
    req('r1', 400, R + 14, 'claude-fable-9'), // no price: tokens, and a floor
    // alpha dispatches scout: two requests of its own, one unpriced
    ev('r1', rack, 'tool.call', { tool_use_id: 'tu-scout', tool: 'Agent', input_size: 1 }, inTurn('r1'), R + 15),
    ev('r1', rack, 'agent.spawn', { tool_use_id: 'tu-scout', agent_type: 'scout', description: 'look', model: sonnet, prompt_length: 1 }, { agent_id: 'sc' }, R + 16),
    ev('r1', rack, 'turn.start', {}, inTurn('r1', 'sc'), R + 17),
    req('r1', 70, R + 18, sonnet, 'sc'),
    req('r1', 30, R + 19, 'claude-fable-9', 'sc'),
  ];

  it('the first skill loaded owns the requests after it, in its tokens and its priced cost, and is partial for an unpriced one; the spawn it started counts its agent\'s own', async () => {
    expect(seedStore(store, rackEvents)).toEqual({ accepted: rackEvents.length, duplicates: 0 });
    const { body } = await get(`/api/skills?project=rack&from=${R - 1000}&to=${R + 100_000}`);
    const alpha = body.usage.find((u: any) => u.name === 'alpha');
    // 1000 + 2000 + 400 after its load, and the 100 before it are not its own; plus the scout's 70 + 30
    expect(alpha).toMatchObject({ runs: 1, tokens: 1000 + 2000 + 400 + 70 + 30, costPartial: true });
    expect(alpha.cost).toBeCloseTo(priced(1000) + priced(2000), 12); // a spawn with an unpriced request has no cost at all, so the scout's priced 70 is not added: the figure is a floor
    const beta = body.usage.find((u: any) => u.name === 'beta');
    expect(beta).toMatchObject({ runs: 1, tokens: 0, costPartial: false }); // it was called from alpha: its requests stay with its caller
    const scout = body.nodes.find((n: any) => n.id === 'agent:scout');
    expect(scout).toMatchObject({ spawns: 1, tokens: 100, costPartial: true });
    expect(scout.cost).toBe(0); // a type with an unpriced request in it has no cost, only the floor flag
    expect(body.edges.find((e: any) => e.from === 'skill:projectSettings:alpha' && e.to === 'agent:scout')).toMatchObject({ did: 1, tokens: 100 });
  });
});
