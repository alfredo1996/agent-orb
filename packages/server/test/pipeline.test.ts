import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_INFO, ROLES, types } from '@agent-orb/shared';
import { buildApp } from '../src/app.ts';
import { all, get as one, openStore, type Store } from '../src/store/store.ts';
import { seedStore } from './seed-store.ts';

// Slice 3 (PROJECT.md §7, §8.3, §15 2026-10-20): role fixes, the pipeline by role, one session's lanes. Since #81's slice 3 it reads and writes the SQLite
// history store, on a temp file: the cases and every number are the ones the graph gave.
const TOKEN = 'test-token-0123456789';
const T = 1_792_700_000_000;
const DAY = 86_400_000;
const shop = { cwd: '/w/shop', name: 'shop', git_remote: 'github.com/o/shop' };
let n = 0;
const ev = (session: string, project: object, kind: string, data: object, extra: object = {}, ts = T + n * 1000) =>
  ({ v: 1, host: 'mbp', user_id: 'x', session_id: session, project, id: `00000000-0000-4000-9c00-${String(++n).padStart(12, '0')}`, ts, kind, data, ...extra });
const usage = (tokens: number) => ({ input: tokens, output: 0, cache_read: 0, cache_creation: 0 });
const start = (s: string, p: object, ts: number) => ev(s, p, 'session.start', { model: 'claude-opus-5-5', source: 'interactive', claude_version: 'v', plugin_version: 'p' }, {}, ts);
const step = (s: string, p: object, tokens: number, agent?: string, ts?: number) =>
  ev(s, p, 'turn.step', { model: agent ? 'claude-sonnet-5-5' : 'claude-opus-5-5', usage: usage(tokens), stop_reason: 'end_turn', tool_use_ids: [] }, { turn_id: `${s}-${agent ?? 'main'}-t`, ...(agent && { agent_id: agent }) }, ts);
const turn = (s: string, p: object, agent: string | undefined, ts: number) => ev(s, p, 'turn.start', {}, { turn_id: `${s}-${agent ?? 'main'}-t`, ...(agent && { agent_id: agent }) }, ts);
const spawn = (s: string, p: object, agent: string, type: string, ts: number, declared_role?: string) =>
  ev(s, p, 'agent.spawn', { tool_use_id: `tu-${agent}`, agent_type: type, description: `${type} task`, model: 'claude-sonnet-5-5', prompt_length: 9, ...(declared_role && { declared_role }) }, { agent_id: agent }, ts);
const call = (s: string, p: object, agent: string, id: string, tool: string, ts: number, ms: number) => [
  ev(s, p, 'tool.call', { tool_use_id: id, tool, input_size: 1 }, { agent_id: agent, turn_id: `${s}-${agent}-t` }, ts),
  ev(s, p, 'tool.result', { tool_use_id: id, success: true, duration_ms: ms, output_size: 1, files_touched: [] }, { agent_id: agent, turn_id: `${s}-${agent}-t` }, ts + ms),
];

const events = [
  start('s1', shop, T), turn('s1', shop, undefined, T + 1), step('s1', shop, 1000, undefined, T + 2),
  spawn('s1', shop, 'a1', 'implementer', T + 10), turn('s1', shop, 'a1', T + 11), step('s1', shop, 5000, 'a1', T + 20),
  ...call('s1', shop, 'a1', 'c1', 'Bash', T + 12, 900), ...call('s1', shop, 'a1', 'c2', 'Edit', T + 14, 50),
  spawn('s1', shop, 'a2', 'Explore', T + 30), turn('s1', shop, 'a2', T + 31), step('s1', shop, 2000, 'a2', T + 40),
  ...call('s1', shop, 'a2', 'c3', 'WebFetch', T + 32, 1_200_000),
  spawn('s1', shop, 'a3', 'adversarial-reviewer', T + 50, 'reviewer'), turn('s1', shop, 'a3', T + 51), step('s1', shop, 3000, 'a3', T + 60),
  start('s2', shop, T + DAY), turn('s2', shop, undefined, T + DAY + 1), step('s2', shop, 500, undefined, T + DAY + 2),
  spawn('s2', shop, 'a4', 'implementer', T + DAY + 10), turn('s2', shop, 'a4', T + DAY + 11), step('s2', shop, 5000, 'a4', T + DAY + 20),
  start('s3', { cwd: '/w/other', name: 'other' }, T + 2 * DAY), step('s3', { cwd: '/w/other', name: 'other' }, 7, undefined, T + 2 * DAY + 1),
];

// A store on a temp file with its app, and the calls the cases make on it.
const dirs: string[] = [];
const open = () => {
  const dir = mkdtempSync(join(tmpdir(), 'orb-pipeline-'));
  dirs.push(dir);
  const store = openStore(join(dir, 'history.db'));
  const app = buildApp({ store, token: TOKEN });
  return {
    store, app,
    get: async (url: string) => {
      const res = await app.inject({ method: 'GET', url });
      return { status: res.statusCode, body: res.json() };
    },
    put: async (body: object, headers: Record<string, string> = {}) => {
      const res = await app.inject({ method: 'PUT', url: '/api/roles', payload: body, headers });
      return { status: res.statusCode, body: res.json() };
    },
    roleOf: (id: string) => ({ ...one(store, 'SELECT role, role_source AS src FROM agents WHERE id = :id', { id }) }),
  };
};

let history: Store;
let app: ReturnType<typeof buildApp>;
let get: ReturnType<typeof open>['get'];
let put: ReturnType<typeof open>['put'];
let roleOf: ReturnType<typeof open>['roleOf'];
const ingest = (batch: object[]) => seedStore(history, batch);

beforeAll(() => {
  ({ store: history, app, get, put, roleOf } = open());
  expect(ingest(events)).toEqual({ accepted: events.length, duplicates: 0 });
});

afterAll(async () => {
  await app?.close();
  history?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const week = `from=${T - DAY}&to=${T + 6 * DAY}`;

describe('GET /api/pipeline', () => {
  it('roles over a period: agents, types, tokens, cost; a type with no role shows as unassigned', async () => {
    const { status, body } = await get(`/api/pipeline?project=shop&${week}`);
    expect(status).toBe(200);
    const roles = Object.fromEntries(body.roles.map((r: any) => [r.role, [r.agents, r.types, r.tokens]]));
    expect(roles).toEqual({
      orchestrator: [2, ['main'], 1500], unassigned: [2, ['implementer'], 10_000], reviewer: [1, ['adversarial-reviewer'], 3000], researcher: [1, ['Explore'], 2000],
    });
    expect(body.roles.find((r: any) => r.role === 'unassigned').agentList.map((a: any) => [a.id, a.session, a.tokens, a.role_source])).toEqual([
      ['s1:a1', 's1', 5000, null], ['s2:a4', 's2', 5000, null],
    ]);
  });

  it('edges are delegations between roles, as heavy as the tokens the children used', async () => {
    const { body } = await get(`/api/pipeline?project=shop&${week}`);
    expect(body.edges.map((e: any) => [e.from, e.to, e.count, e.tokens])).toEqual([
      ['orchestrator', 'unassigned', 2, 10_000], ['orchestrator', 'reviewer', 1, 3000], ['orchestrator', 'researcher', 1, 2000],
    ]);
  });

  it('one session only; another project never leaks in', async () => {
    const { body } = await get('/api/pipeline?project=shop&session=s2');
    expect(body.roles.map((r: any) => [r.role, r.agents])).toEqual([['unassigned', 1], ['orchestrator', 1]]);
    const other = await get(`/api/pipeline?project=other&${week}`);
    expect(other.body.roles.map((r: any) => r.role)).toEqual(['orchestrator']);
  });

  it('400 without a project or a range', async () => {
    expect((await get('/api/pipeline?project=shop')).status).toBe(400);
    expect((await get(`/api/pipeline?${week}`)).status).toBe(400);
  });
});

describe('PUT /api/roles (fixes: one agent > a rule for its type > declared > roles.json)', () => {
  it('a rule for a type fixes every such agent in the project, now and later, and beats a declared role', async () => {
    expect(await put({ scope: 'type', project: 'shop', agent_type: 'implementer', role: 'developer' })).toEqual({ status: 200, body: { updated: 2 } });
    expect(roleOf('s1:a1')).toEqual({ role: 'developer', src: 'rule' });
    expect(roleOf('s2:a4')).toEqual({ role: 'developer', src: 'rule' });
    ingest([spawn('s2', shop, 'a5', 'implementer', T + DAY + 30, 'tester')]); // later, and declaring another role
    expect(roleOf('s2:a5')).toEqual({ role: 'developer', src: 'rule' });
    ingest([spawn('s3', { cwd: '/w/other', name: 'other' }, 'a6', 'implementer', T + 2 * DAY + 5)]); // another project: untouched
    expect(roleOf('s3:a6')).toEqual({ role: null, src: null });
  });

  it('a fix on one agent wins over the rule, even when the rule is set again', async () => {
    expect(await put({ scope: 'agent', agent_id: 's1:a1', role: 'tester' })).toEqual({ status: 200, body: { updated: 1 } });
    expect(await put({ scope: 'type', project: 'shop', agent_type: 'implementer', role: 'developer' })).toEqual({ status: 200, body: { updated: 2 } }); // s2:a4, s2:a5; not the manual one
    expect(roleOf('s1:a1')).toEqual({ role: 'tester', src: 'manual' });
  });

  it('refuses an unknown role, an unknown agent or project, and a request from another site', async () => {
    expect((await put({ scope: 'agent', agent_id: 's1:a1', role: 'boss' })).status).toBe(400);
    expect((await put({ scope: 'agent', agent_id: 'nope', role: 'tester' })).status).toBe(404);
    expect((await put({ scope: 'type', project: 'ghost', agent_type: 'x', role: 'tester' })).status).toBe(404);
    expect((await put({ scope: 'agent', agent_id: 's1:a2', role: 'tester' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(roleOf('s1:a2')).toEqual({ role: 'researcher', src: 'map' });
  });
});

describe('GET /api/lanes, /api/projects, /api/sessions', () => {
  it("one session's lanes: each agent with its parent, turns and tool calls", async () => {
    const { body } = await get('/api/lanes?session=s1');
    const lanes = Object.fromEntries(body.lanes.map((l: any) => [l.id, l]));
    expect(Object.keys(lanes).sort()).toEqual(['s1:a1', 's1:a2', 's1:a3', 's1:main']);
    expect(lanes['s1:a1']).toMatchObject({ type: 'implementer', parent: 's1:main' });
    expect(lanes['s1:a1'].turns).toEqual([{ started_at: T + 11, duration_ms: null, model: 'claude-sonnet-5-5' }]);
    expect(lanes['s1:a2'].tools).toEqual([{ ts: T + 32, duration_ms: 1_200_000, tool: 'WebFetch', success: true }]);
    expect(body.session).toMatchObject({ id: 's1', started_at: T });
  });

  it('projects by latest activity; sessions of a project, newest first, with tokens', async () => {
    expect((await get('/api/projects')).body.map((p: any) => [p.name, p.sessions])).toEqual([['other', 1], ['shop', 2]]);
    expect((await get('/api/sessions?project=shop')).body.map((s: any) => [s.id, s.tokens])).toEqual([['s2', 5500], ['s1', 11_000]]);
  });
});

describe('issue #8: roles and agent types say what they mean', () => {
  it('each role has its line; a type takes its file\'s description, else the built-in line, else none', async () => {
    const catalog = ev('s1', shop, 'skills.catalog', { skills: [], agents: [{ name: 'implementer', source: 'projectSettings', tokens: 30, description: 'Builds the planned change, test first' }] }, {}, T + 5);
    expect(ingest([catalog])).toEqual({ accepted: 1, duplicates: 0 });
    const { body } = await get(`/api/pipeline?project=shop&from=${T - DAY}&to=${T + 3 * DAY}`);
    const role = (r: string) => body.roles.find((x: any) => x.role === r);
    expect(role('developer')).toMatchObject({ info: ROLE_INFO.developer, typeInfo: { implementer: 'Builds the planned change, test first' } });
    expect(role('researcher')).toMatchObject({ info: ROLE_INFO.researcher, typeInfo: { Explore: types.Explore } });
    expect(role('reviewer').typeInfo).toEqual({ 'adversarial-reviewer': null });
    expect(body.roleCatalog.map((r: any) => r.role)).toEqual([...ROLES]);
    expect(body.roleCatalog.find((r: any) => r.role === 'generalist').info).toBe(ROLE_INFO.generalist);
  });

  it('consultant and generalist can be set from the panel now', async () => {
    expect((await put({ scope: 'type', project: 'shop', agent_type: 'Explore', role: 'generalist' })).status).toBe(200);
    expect(roleOf('s1:a2')).toEqual({ role: 'generalist', src: 'rule' });
  });
});

// The delegation tree: an agent knows its parent, and the Pipeline reads the depth of each with a recursive CTE over agents.parent_id.
// main → implementer → Explore → general-purpose is four levels; a reviewer sits beside the implementer under main.
const deep = { cwd: '/w/deep', name: 'deep', git_remote: 'github.com/o/deep' };
const under = (s: string, agent: string, parent: string | undefined, type: string, ts: number, declared_role?: string) =>
  ({ ...spawn(s, deep, agent, type, ts, declared_role), ...(parent && { parent_agent_id: parent }) });
const tree = [
  start('d1', deep, T), step('d1', deep, 100, undefined, T + 2),
  under('d1', 'a1', undefined, 'implementer', T + 10), step('d1', deep, 200, 'a1', T + 20),
  under('d1', 'a2', 'a1', 'Explore', T + 30), step('d1', deep, 300, 'a2', T + 40),
  under('d1', 'a3', 'a2', 'general-purpose', T + 50), step('d1', deep, 400, 'a3', T + 60),
  under('d1', 'a4', undefined, 'adversarial-reviewer', T + 70, 'reviewer'), step('d1', deep, 50, 'a4', T + 80),
];

describe('the delegation tree', () => {
  it('a four-level tree comes back whole: every agent with its parent and depth, every delegation as an edge', async () => {
    const t = open();
    expect(seedStore(t.store, tree)).toEqual({ accepted: tree.length, duplicates: 0 });
    const { body } = await t.get('/api/pipeline?project=deep&session=d1');
    expect(body.roles.flatMap((r: any) => r.agentList).map((a: any) => [a.id, a.parent, a.depth, a.tokens]).sort()).toEqual([
      ['d1:a1', 'd1:main', 1, 200], ['d1:a2', 'd1:a1', 2, 300], ['d1:a3', 'd1:a2', 3, 400], ['d1:a4', 'd1:main', 1, 50], ['d1:main', null, 0, 100],
    ]);
    expect(body.roles.map((r: any) => [r.role, r.agents, r.tokens])).toEqual([['generalist', 1, 400], ['researcher', 1, 300], ['unassigned', 1, 200], ['orchestrator', 1, 100], ['reviewer', 1, 50]]);
    expect(body.edges.map((e: any) => [e.from, e.to, e.count, e.tokens])).toEqual([
      ['researcher', 'generalist', 1, 400], ['unassigned', 'researcher', 1, 300], ['orchestrator', 'unassigned', 1, 200], ['orchestrator', 'reviewer', 1, 50],
    ]);
    await t.app.close();
    t.store.close();
  });

  it('a period that holds only the deepest agent still knows its depth and its parent, whose own start is outside it', async () => {
    const t = open();
    seedStore(t.store, tree);
    const { body } = await t.get(`/api/pipeline?project=deep&from=${T + 45}&to=${T + 55}`);
    expect(body.roles.map((r: any) => [r.role, r.agents, r.agentList.map((a: any) => [a.id, a.parent, a.depth])])).toEqual([['generalist', 1, [['d1:a3', 'd1:a2', 3]]]]);
    expect(body.edges.map((e: any) => [e.from, e.to, e.count, e.tokens])).toEqual([['researcher', 'generalist', 1, 400]]);
    await t.app.close();
    t.store.close();
  });

  it('an agent named as its own parent (a bad event) does not hang the Pipeline', async () => {
    const t = open();
    seedStore(t.store, [start('d2', deep, T), under('d2', 'x', 'x', 'implementer', T + 10), step('d2', deep, 7, 'x', T + 20)]);
    const { status, body } = await t.get('/api/pipeline?project=deep&session=d2');
    expect(status).toBe(200);
    expect(body.roles.find((r: any) => r.role === 'unassigned')).toMatchObject({ agents: 1, tokens: 7 });
    await t.app.close();
    t.store.close();
  });
});

describe('a rule for a type reaches every project row with the name (a repo seen from two machines)', () => {
  const nas = { cwd: '/srv/shop', name: 'shop' }; // no remote: its own project row, `mbp:/srv/shop`, with the name shop
  it('sets a rule on each row, applies it to both rows\' agents but not to a manual fix, and a later spawn on either row takes it', async () => {
    const t = open();
    seedStore(t.store, [
      start('s1', shop, T), spawn('s1', shop, 'a1', 'implementer', T + 10),
      start('n1', nas, T), spawn('n1', nas, 'a1', 'implementer', T + 10), spawn('n1', nas, 'a2', 'implementer', T + 11),
      start('o1', { cwd: '/w/other', name: 'other' }, T), spawn('o1', { cwd: '/w/other', name: 'other' }, 'a1', 'implementer', T + 10),
    ]);
    expect(await t.put({ scope: 'agent', agent_id: 'n1:a2', role: 'tester' })).toEqual({ status: 200, body: { updated: 1 } });
    expect(await t.put({ scope: 'type', project: 'shop', agent_type: 'implementer', role: 'developer' })).toEqual({ status: 200, body: { updated: 2 } });
    expect(all(t.store, 'SELECT project_id, agent_type, role FROM role_rules ORDER BY project_id').map((r) => ({ ...r }))).toEqual([
      { project_id: 'github.com/o/shop', agent_type: 'implementer', role: 'developer' }, { project_id: 'mbp:/srv/shop', agent_type: 'implementer', role: 'developer' },
    ]);
    expect([t.roleOf('s1:a1'), t.roleOf('n1:a1'), t.roleOf('n1:a2'), t.roleOf('o1:a1')]).toEqual([
      { role: 'developer', src: 'rule' }, { role: 'developer', src: 'rule' }, { role: 'tester', src: 'manual' }, { role: null, src: null },
    ]);
    seedStore(t.store, [spawn('n1', nas, 'a3', 'implementer', T + 20, 'planner')]);
    expect(t.roleOf('n1:a3')).toEqual({ role: 'developer', src: 'rule' });
    await t.app.close();
    t.store.close();
  });
});

describe('the lists and lanes refuse what they cannot answer, and the sessions list stops at 50', () => {
  it('400 without what they need, 404 for a session that is not there, the newest 50 sessions first', async () => {
    const t = open();
    seedStore(t.store, Array.from({ length: 55 }, (_, i) => start(`s${String(i).padStart(2, '0')}`, shop, T + i * 1000)));
    expect((await t.get('/api/lanes')).status).toBe(400);
    expect((await t.get('/api/lanes?session=nope')).status).toBe(404);
    expect((await t.get('/api/sessions')).status).toBe(400);
    const list = (await t.get('/api/sessions?project=shop')).body;
    expect([list.length, list[0].id, list.at(-1).id]).toEqual([50, 's54', 's05']);
    expect((await t.get('/api/sessions?project=ghost')).body).toEqual([]);
    await t.app.close();
    t.store.close();
  });
});
