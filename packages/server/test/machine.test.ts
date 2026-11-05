import { beforeEach, describe, expect, it } from 'vitest';
import type { Event } from '@agent-orb/shared';
import { buildApp } from '../src/app.ts';

// v0.4 slice 3 (#29, Factory; PROJECT.md §15): what runs on the Mac. The plugin's latest sample per host, its containers grouped by compose project, by Testcontainers run, or alone, each
// group joined to the agent-orb project it belongs to, with "Unhealthy" and "Left running" flags. The tests send the plugin's events to /ingest and read GET /api/machine, so the writer,
// the grouping and the route are held together.
const TOKEN = 'test-token-0123456789';
const MIN = 60_000;
const HOUR = 60 * MIN;
const MiB = 1_048_576;
const T0 = Date.parse('2026-11-05T08:00:00Z');
const SAMPLE_AT = T0 + 5 * HOUR;
const NOW0 = SAMPLE_AT + 4 * MIN;

type Project = { cwd: string; name: string; git_remote?: string; git_branch?: string; checkout?: string };
const MOBILE: Project = { cwd: '/Users/a/mobile-app', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' };
const NOTES: Project = { cwd: '/Users/a/field-notes', name: 'field-notes', git_remote: 'github.com/o/field-notes' };
const SAMPLER: Project = { cwd: '/Users/a/scratch', name: 'scratch' }; // the session that happens to take the sample, in a project of its own so it reaches none of the containers
let n = 0;
const ev = (session: string, ts: number, kind: string, data: object, extra: object = {}, project: Project = MOBILE, host = 'mbp'): Event =>
  ({ v: 1, id: `00000000-0000-4000-b291-${String(++n).padStart(12, '0')}`, ts, host, user_id: 'local', session_id: session, project, kind, data, ...extra }) as Event;
const start = (session: string, project: Project, ts = T0, host = 'mbp') => ev(session, ts, 'session.start', { model: 'claude-sonnet-5-5', source: 'startup', claude_version: '2.1.308', plugin_version: '0.4.0' }, {}, project, host);
const end = (session: string, project: Project, ts: number, host = 'mbp') => ev(session, ts, 'session.end', { reason: 'exit' }, {}, project, host);
const prompt = (session: string, project: Project, ts: number, host = 'mbp') => ev(session, ts, 'prompt.submit', { length: 5 }, { prompt_id: `p-${n + 1}` }, project, host);
let calls = 0;
/** A test run (a Bash call of class test) from `ts` for `ms`; ms undefined: it never reported a result. */
const testRun = (session: string, project: Project, ts: number, ms?: number, host = 'mbp'): Event[] => {
  const id = `toolu_${++calls}`;
  return [
    ev(session, ts, 'tool.call', { tool_use_id: id, tool: 'Bash', input_size: 12, command_class: 'test' }, { turn_id: `t-${id}` }, project, host),
    ...(ms === undefined ? [] : [ev(session, ts + ms, 'tool.result', { tool_use_id: id, success: true, duration_ms: ms, output_size: 3, files_touched: [] }, { turn_id: `t-${id}` }, project, host)]),
  ];
};

type Sent = { name?: string; created_at?: number; state?: string; health?: 'healthy' | 'unhealthy' | 'starting'; memory?: number; compose?: string; working_dir?: string; testcontainers?: { session?: string }; excluded?: true };
const box = (c: Sent = {}): Sent => ({ state: 'running', memory: 100 * MiB, ...c });
const sample = (containers: Sent[], over: { ts?: number; host?: string; docker?: string; mem_free?: number; mem_total?: number } = {}): Event => {
  const { ts = SAMPLE_AT, host = 'mbp', ...data } = over;
  return ev('s-sampler', ts, 'machine.sample', { docker: 'ok', mem_free: 6_200 * MiB, mem_total: 36_000 * MiB, containers, ...data }, {}, SAMPLER, host);
};

type Group = { kind: string; name: string; project: string | null; compose: string | null; containers: number; memory: number; unhealthy: number; leftRunning: boolean; idleMs: number | null };
type Host = { host: string; at: number; ageMs: number; docker: string; memFree: number | null; memTotal: number | null; containers: number; memory: number; groups: Group[] };

let app: ReturnType<typeof buildApp>;
let NOW = NOW0;
beforeEach(() => {
  NOW = NOW0;
  app = buildApp({ token: TOKEN, now: () => NOW });
});
const send = async (...events: Event[]) => {
  const r = await app.inject({ method: 'POST', url: '/ingest', headers: { authorization: `Bearer ${TOKEN}` }, payload: { events } });
  expect(r.json()).toMatchObject({ accepted: events.length, rejected: 0 });
};
const read = async (): Promise<Host[]> => (await app.inject({ url: '/api/machine' })).json().hosts;
const only = async (): Promise<Host> => {
  const hosts = await read();
  expect(hosts).toHaveLength(1);
  return hosts[0]!;
};
const group = (h: Host, name: string) => h.groups.find((g) => g.name === name);

describe('GET /api/machine: the latest sample per host', () => {
  it('nothing sampled: no hosts', async () => {
    expect(await read()).toEqual([]);
  });

  it('the memory, Docker\'s state, the container count and what they use, and the sample\'s age', async () => {
    await send(start('s-mobile', MOBILE), sample([box({ compose: 'mobile-app', working_dir: '/Users/a/mobile-app/deploy' }), box({ memory: 28 * MiB }), box({ memory: undefined })]));
    expect(await only()).toMatchObject({ host: 'mbp', at: SAMPLE_AT, ageMs: 4 * MIN, docker: 'ok', memFree: 6_200 * MiB, memTotal: 36_000 * MiB, containers: 3, memory: 128 * MiB });
  });

  it('the latest sample of a host replaces the one before; one that arrives late, older than what is stored, changes nothing', async () => {
    await send(start('s-mobile', MOBILE), sample([box(), box(), box()], { ts: SAMPLE_AT - 20 * MIN }));
    expect((await only()).containers).toBe(3);
    await send(sample([box()], { ts: SAMPLE_AT - 10 * MIN }));
    expect((await only()).containers).toBe(1);
    await send(sample([box(), box()], { ts: SAMPLE_AT - 15 * MIN })); // sent late, taken earlier
    expect((await only()).containers).toBe(1);
    expect((await only()).at).toBe(SAMPLE_AT - 10 * MIN);
  });

  it('one sample per host: another Mac is another entry, the newest first; a host not heard from in 24 hours is left out', async () => {
    await send(start('s-mobile', MOBILE), sample([box()], { ts: SAMPLE_AT - HOUR }), sample([box(), box()], { host: 'studio', ts: SAMPLE_AT }), sample([box()], { host: 'old', ts: NOW0 - 25 * HOUR }));
    expect((await read()).map((h) => [h.host, h.containers])).toEqual([['studio', 2], ['mbp', 1]]);
    NOW = NOW0 + 24 * HOUR - 3 * HOUR; // 21 hours on: the 25-hour-old one is still out, and the hour-old ones are still in
    expect((await read()).map((h) => h.host)).toEqual(['studio', 'mbp']);
    NOW = SAMPLE_AT + 24 * HOUR + MIN;
    expect(await read()).toEqual([]);
  });

  it('Docker absent or stopped is a sample with the memory and no containers, and the state is said', async () => {
    await send(start('s-mobile', MOBILE), sample([], { docker: 'stopped' }), sample([], { docker: 'absent', host: 'linux', mem_free: undefined, mem_total: undefined }));
    const [linux, mbp] = [...(await read())].sort((a, b) => a.host.localeCompare(b.host));
    expect(mbp).toMatchObject({ docker: 'stopped', containers: 0, memory: 0, groups: [], memFree: 6_200 * MiB });
    expect(linux).toMatchObject({ docker: 'absent', memFree: null, memTotal: null });
  });
});

describe('GET /api/machine: grouping', () => {
  it('compose containers group by compose project and reach the agent-orb project whose folder holds their working directory', async () => {
    await send(start('s-mobile', MOBILE, SAMPLE_AT - MIN), sample([
      box({ name: 'mobile-app-api-1', compose: 'mobile-app', working_dir: '/Users/a/mobile-app/deploy', memory: 50 * MiB }),
      box({ name: 'mobile-app-db-1', compose: 'mobile-app', working_dir: '/Users/a/mobile-app/deploy', memory: 70 * MiB }),
      box({ name: 'cache-1', compose: 'shared-cache', working_dir: '/Users/a/elsewhere', memory: 10 * MiB }),
    ]));
    const h = await only();
    expect(h.groups.map((g) => [g.kind, g.name, g.project, g.compose, g.containers, g.memory])).toEqual([
      ['compose', 'mobile-app', 'mobile-app', 'mobile-app', 2, 120 * MiB],
      ['compose', 'shared-cache', null, 'shared-cache', 1, 10 * MiB], // a folder no project holds: shown under its compose name, with no project
    ]);
  });

  it('a working directory equal to a project\'s folder counts, one in a folder with a similar name does not, and the deepest folder wins', async () => {
    const inner: Project = { cwd: '/Users/a/mobile-app/packages/web', name: 'mobile-web', git_remote: 'github.com/o/mobile-web' }; // sorts after its parent's name, so only the depth picks it
    await send(start('s-mobile', MOBILE, SAMPLE_AT - MIN), start('s-web', inner, SAMPLE_AT - MIN), sample([
      box({ compose: 'a', working_dir: '/Users/a/mobile-app' }),
      box({ compose: 'b', working_dir: '/Users/a/mobile-app-2/deploy' }),
      box({ compose: 'c', working_dir: '/Users/a/mobile-app/packages/web/deploy' }),
    ]));
    const h = await only();
    expect(h.groups.map((g) => [g.compose, g.project]).sort()).toEqual([['a', 'mobile-app'], ['b', null], ['c', 'mobile-web']]);
  });

  it('a working directory in a git worktree of the project reaches it, through the checkout its session reported', async () => {
    const worktree = { ...MOBILE, checkout: '/Users/a/worktrees/mobile-app-29' };
    await send(
      ev('s-wt', T0, 'project.fingerprint', { files: [{ path: 'CLAUDE.md', hash: '1'.repeat(40), scope: 'project' }] }, {}, worktree),
      sample([box({ compose: 'wt-stack', working_dir: '/Users/a/worktrees/mobile-app-29/deploy' })]),
    );
    expect(group(await only(), 'mobile-app')).toMatchObject({ kind: 'compose', compose: 'wt-stack', project: 'mobile-app' });
  });

  it('a project that no session on this host ran in is not reached', async () => {
    await send(start('s-away', MOBILE, SAMPLE_AT - MIN, 'other-mac'), sample([box({ compose: 'mobile-app', working_dir: '/Users/a/mobile-app' })]));
    expect((await only()).groups).toMatchObject([{ name: 'mobile-app', project: null }]);
  });

  it('Testcontainers group by the run\'s session id and reach the project that had a test run going when the group\'s first container was created', async () => {
    const made = SAMPLE_AT - 3 * HOUR;
    await send(
      start('s-notes', NOTES, made - 10 * MIN), ...testRun('s-notes', NOTES, made - 2 * MIN, 8 * MIN), // field-notes' run, from 2 minutes before the container to 6 minutes after
      start('s-mobile', MOBILE, made - 10 * MIN), ...testRun('s-mobile', MOBILE, made - 50 * MIN, 5 * MIN), // mobile-app ran tests too, but not then
      sample([
        box({ name: 'ryuk', created_at: made, testcontainers: { session: 'aaa' }, memory: 12 * MiB }),
        box({ name: 'quirky_curie', created_at: made + 30_000, testcontainers: { session: 'aaa' }, memory: 400 * MiB }),
        box({ name: 'eager_euler', created_at: made + 20 * MIN, testcontainers: { session: 'bbb' }, memory: 90 * MiB }), // a second run, started after the tests ended
      ]),
    );
    const h = await only();
    expect(h.groups.map((g) => [g.kind, g.name, g.project, g.containers, g.memory]).sort()).toEqual([
      ['testcontainers', 'Testcontainers', null, 1, 90 * MiB], // 'bbb' was created 14 minutes after field-notes' run ended
      ['testcontainers', 'field-notes', 'field-notes', 2, 412 * MiB],
    ].sort());
  });

  it('a Testcontainers group is the project\'s only if a test run was going at its first container\'s creation, not before and not after it ended', async () => {
    const made = SAMPLE_AT - 3 * HOUR;
    await send(
      start('s-notes', NOTES, made - HOUR),
      ...testRun('s-notes', NOTES, made - 30 * MIN, 10 * MIN), // ended 20 minutes before
      ...testRun('s-notes', NOTES, made + MIN, 5 * MIN), // began after
      sample([box({ name: 'late', created_at: made, testcontainers: { session: 'ccc' } })]),
    );
    expect((await only()).groups).toMatchObject([{ kind: 'testcontainers', name: 'Testcontainers', project: null }]);
  });

  it('a test run that never reported a result is going while its container is made, if it began within two hours before', async () => {
    const made = SAMPLE_AT - 3 * HOUR;
    await send(
      start('s-notes', NOTES, made - 2 * HOUR), ...testRun('s-notes', NOTES, made - 10 * MIN), // stopped halfway: no result
      start('s-mobile', MOBILE, made - 5 * HOUR), ...testRun('s-mobile', MOBILE, made - 3 * HOUR), // and one so old it is no run in flight
      sample([box({ name: 'left', created_at: made, testcontainers: { session: 'ddd' } })]),
    );
    expect((await only()).groups).toMatchObject([{ name: 'field-notes', project: 'field-notes' }]);
  });

  it('a test run on another host is not the container\'s', async () => {
    const made = SAMPLE_AT - 3 * HOUR;
    await send(start('s-away', NOTES, made - HOUR, 'other-mac'), ...testRun('s-away', NOTES, made - MIN, 5 * MIN, 'other-mac'), sample([box({ created_at: made, testcontainers: { session: 'eee' } })]));
    expect((await only()).groups).toMatchObject([{ name: 'Testcontainers', project: null }]);
  });

  it('a Testcontainers container with no session id and no creation time still groups: alone, and not reached', async () => {
    await send(sample([box({ testcontainers: {} }), box({ testcontainers: {} })]));
    expect((await only()).groups).toMatchObject([{ kind: 'testcontainers', name: 'Testcontainers', project: null, containers: 2 }]);
  });

  it('what has no label is "No project", started by hand; an excluded project\'s containers are "An excluded project", with no name', async () => {
    await send(sample([box({ name: 'scratch-redis', memory: 30 * MiB }), box({ name: 'scratch-pg', memory: 60 * MiB }), box({ excluded: true, memory: 5 * MiB, name: undefined }), box({ excluded: true, memory: 7 * MiB })]));
    const h = await only();
    expect(h.groups.map((g) => [g.kind, g.name, g.project, g.containers, g.memory]).sort()).toEqual([
      ['excluded', 'An excluded project', null, 2, 12 * MiB],
      ['none', 'No project', null, 2, 90 * MiB],
    ]);
    expect(JSON.stringify(h)).not.toMatch(/scratch/);
  });

  it('the groups hold every container once, and the totals are theirs', async () => {
    await send(start('s-mobile', MOBILE, SAMPLE_AT - MIN), sample([
      box({ compose: 'mobile-app', working_dir: '/Users/a/mobile-app' }), box({ testcontainers: { session: 'x' } }), box(), box({ excluded: true }), box({ compose: 'mobile-app', working_dir: '/Users/a/mobile-app' }),
    ]));
    const h = await only();
    expect(h.groups.reduce((t, g) => t + g.containers, 0)).toBe(h.containers);
    expect(h.groups.reduce((t, g) => t + g.memory, 0)).toBe(h.memory);
    expect(h.containers).toBe(5);
  });
});

describe('GET /api/machine: flags', () => {
  const stack = (extra: Sent = {}) => box({ name: 'notes-db-1', compose: 'notes', working_dir: '/Users/a/field-notes/deploy', ...extra });

  it('"Left running" when the group\'s project has had no event for an hour before the sample, and not before the hour is up', async () => {
    const last = SAMPLE_AT - HOUR; // the project\'s last event: exactly an hour before the sample
    await send(start('s-notes', NOTES, last - 30 * MIN), end('s-notes', NOTES, last), sample([stack()]));
    expect(group(await only(), 'field-notes')).toMatchObject({ leftRunning: true, idleMs: HOUR });
  });

  it('a project that was active a second inside the hour is not left running; the idle time is read at the sample', async () => {
    await send(start('s-notes', NOTES, SAMPLE_AT - 2 * HOUR), end('s-notes', NOTES, SAMPLE_AT - HOUR + 1_000), sample([stack()]));
    expect(group(await only(), 'field-notes')).toMatchObject({ leftRunning: false, idleMs: HOUR - 1_000 });
  });

  it('what a session did counts as an event: a prompt, a call or a request, not only a start and an end', async () => {
    await send(start('s-notes', NOTES, SAMPLE_AT - 3 * HOUR), prompt('s-notes', NOTES, SAMPLE_AT - 20 * MIN), sample([stack()]));
    expect(group(await only(), 'field-notes')).toMatchObject({ leftRunning: false });
  });

  it('an open-PR read is an event too: a session that is open and quiet still reads the repository every five minutes', async () => {
    await send(start('s-notes', NOTES, SAMPLE_AT - 3 * HOUR), ev('s-notes', SAMPLE_AT - 10 * MIN, 'project.open_prs', { prs: [] }, {}, NOTES), sample([stack()]));
    expect(group(await only(), 'field-notes')).toMatchObject({ leftRunning: false });
  });

  it('an event after the sample counts as well: the project is being worked on', async () => {
    await send(start('s-notes', NOTES, SAMPLE_AT - 3 * HOUR), sample([stack()]), prompt('s-notes', NOTES, SAMPLE_AT + 2 * MIN));
    expect(group(await only(), 'field-notes')).toMatchObject({ leftRunning: false });
  });

  it('only a session on this host counts for the project: another Mac working in it does not keep these containers alive', async () => {
    await send(start('s-notes', NOTES, SAMPLE_AT - 3 * HOUR), end('s-notes', NOTES, SAMPLE_AT - 2 * HOUR), start('s-away', NOTES, SAMPLE_AT - 10 * MIN, 'other-mac'), prompt('s-away', NOTES, SAMPLE_AT - 5 * MIN, 'other-mac'), sample([stack()]));
    expect(group(await only(), 'field-notes')).toMatchObject({ leftRunning: true });
  });

  it('a Testcontainers group reached through a test run is left running by the same rule', async () => {
    const made = SAMPLE_AT - 3 * HOUR;
    await send(start('s-notes', NOTES, made - HOUR), ...testRun('s-notes', NOTES, made - MIN), end('s-notes', NOTES, made + 5 * MIN), sample([box({ created_at: made, testcontainers: { session: 'zzz' } })]));
    expect(group(await only(), 'field-notes')).toMatchObject({ kind: 'testcontainers', leftRunning: true, idleMs: SAMPLE_AT - (made + 5 * MIN) });
  });

  it('a group with no project is never left running, however old: it is unhealthy or nothing', async () => {
    await send(
      start('s-mobile', MOBILE, T0), end('s-mobile', MOBILE, T0 + MIN), // a long-idle project that owns none of these
      sample([box({ name: 'scratch', memory: 10 * MiB }), box({ compose: 'shared-cache', working_dir: '/Users/a/elsewhere' }), box({ testcontainers: {} }), box({ excluded: true })]),
    );
    const h = await only();
    expect(h.groups).toHaveLength(4);
    expect(h.groups.map((g) => [g.leftRunning, g.idleMs])).toEqual(Array(4).fill([false, null]));
  });

  it('unhealthy is flagged on a group whatever its project, and counts the containers', async () => {
    await send(start('s-mobile', MOBILE, SAMPLE_AT - MIN), sample([
      box({ compose: 'mobile-app', working_dir: '/Users/a/mobile-app', health: 'unhealthy' }), box({ compose: 'mobile-app', working_dir: '/Users/a/mobile-app', health: 'unhealthy' }),
      box({ compose: 'mobile-app', working_dir: '/Users/a/mobile-app', health: 'healthy' }),
      box({ name: 'scratch', health: 'unhealthy' }), box({ name: 'starting-one', compose: 'other', health: 'starting' }),
    ]));
    const h = await only();
    expect(group(h, 'mobile-app')).toMatchObject({ unhealthy: 2, leftRunning: false });
    expect(group(h, 'No project')).toMatchObject({ unhealthy: 1, leftRunning: false });
    expect(group(h, 'other')).toMatchObject({ unhealthy: 0 }); // starting is not unhealthy
  });

  it('the flagged groups come first, then the biggest', async () => {
    await send(
      start('s-notes', NOTES, SAMPLE_AT - 4 * HOUR), end('s-notes', NOTES, SAMPLE_AT - 3 * HOUR), start('s-mobile', MOBILE, SAMPLE_AT - MIN),
      sample([
        box({ name: 'big', memory: 900 * MiB }),
        box({ compose: 'mobile-app', working_dir: '/Users/a/mobile-app', memory: 300 * MiB }),
        box({ compose: 'billing', health: 'unhealthy', memory: 20 * MiB }),
        stack({ memory: 10 * MiB }),
      ]),
    );
    expect((await only()).groups.map((g) => g.name)).toEqual(['billing', 'field-notes', 'No project', 'mobile-app']); // billing is unhealthy, field-notes left running; each by memory
  });
});
