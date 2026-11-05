import { describe, expect, it } from 'vitest';
import { Event } from '../../shared/src/index.ts';
import {
  build, containersFrom, dockerPsArgv, dockerStatsArgv, excludedDirs, linuxMemory, macMemory, parseDockerStats, readMachine, type Ctx, type Run,
} from '../hooks/core.ts';

// v0.4 slice 3 (#29, Factory): the Mac's free memory and its running containers, read on the machine. Only names, a few labels, state, health and memory leave; the command,
// the environment, the mounts and every other label stay home, and a container of an excluded project leaves as numbers alone.
const ctx: Ctx = { host: 'mbp', session_id: 's-1', project: { cwd: '/r', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' } };
const MiB = 1_048_576;
const GiB = 1024 * MiB;

// A row of `docker ps` as dockerPsArgv's template renders it, with what a fuller `docker ps --format json` row would add (the command, the mounts, the labels, the image), which must go nowhere.
const row = (o: Record<string, unknown> = {}) => JSON.stringify({
  id: 'a1b2c3d4e5f6', name: 'mobile-app-db-1', created: '2026-11-05 10:12:03 +0100 CET', state: 'running', status: 'Up 2 hours', project: '', dir: '', tc: '', session: '',
  command: 'postgres -c password=hunter2', env: ['API_KEY=sk-live-1'], mounts: '/Users/a/.ssh', labels: 'owner=x,com.example.secret=s3cret', image: 'sha256:deadbeef', ...o,
});
const ps = (...rows: string[]) => `${rows.join('\n')}\n`;
const stat = (id: string, mem: string) => JSON.stringify({ id, mem });
const stats = (...rows: string[]) => `${rows.join('\n')}\n`;

describe('what is asked of Docker', () => {
  it('names the four labels and the fields it keeps, and nothing that holds a command, an environment, a mount or a label list', () => {
    const asked = dockerPsArgv.join(' ');
    for (const label of ['com.docker.compose.project', 'com.docker.compose.project.working_dir', 'org.testcontainers', 'org.testcontainers.sessionId']) expect(asked).toContain(`"${label}"`);
    expect(asked).not.toMatch(/\.Command|\.Mounts|\.Labels|\.Image|\.Ports|\{\{json \.\}\}|inspect/);
    expect(dockerStatsArgv.join(' ')).not.toMatch(/\{\{json \.\}\}/);
    expect(dockerPsArgv.slice(0, 2)).toEqual(['docker', 'ps']); // running containers only: no -a
    expect(dockerPsArgv).not.toContain('-a');
    expect(dockerStatsArgv).toContain('--no-stream');
  });
});

describe('memory', () => {
  const VM_STAT = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                    57470.',
    'Pages active:                                1567612.',
    'Pages inactive:                              1556096.',
    'Pages speculative:                             11092.',
    'Pages throttled:                                   0.',
    'Pages wired down:                             234035.',
    'Pages purgeable:                               22108.',
  ].join('\n');

  it('macOS: free, inactive and speculative pages times the page size vm_stat prints, of hw.memsize', () => {
    expect(macMemory(VM_STAT, '68719476736\n')).toEqual({ free: (57_470 + 1_556_096 + 11_092) * 16_384, total: 68_719_476_736 });
    expect(macMemory(VM_STAT.replace('16384', '4096'), '8589934592')!.free).toBe((57_470 + 1_556_096 + 11_092) * 4_096); // an Intel Mac's page is 4 KiB
  });

  it('macOS: output that is not vm_stat\'s or sysctl\'s reads as nothing, not as zero', () => {
    expect(macMemory('command not found', '68719476736')).toBeUndefined();
    expect(macMemory(VM_STAT, 'sysctl: unknown oid')).toBeUndefined();
    expect(macMemory(VM_STAT.replace(/Pages free:\s+57470\./, ''), '1')).toBeUndefined();
  });

  it('Linux: MemAvailable of MemTotal, in kibibytes', () => {
    expect(linuxMemory('MemTotal:       16384000 kB\nMemFree:          200000 kB\nMemAvailable:    8192000 kB\n')).toEqual({ free: 8_192_000 * 1024, total: 16_384_000 * 1024 });
    expect(linuxMemory('MemTotal: 1 kB\n')).toBeUndefined(); // a kernel without MemAvailable (before 3.14)
    expect(linuxMemory('')).toBeUndefined();
  });
});

describe('docker stats', () => {
  it('a container\'s memory in bytes, from the first number of "used / limit", in binary or decimal units', () => {
    const m = parseDockerStats(stats(stat('aaa111aaa111', '73.62MiB / 41.08GiB'), stat('bbb222bbb222', '1.5GB / 8GB'), stat('ccc333ccc333', '0B / 0B'), stat('ddd444ddd444', '512kB / 1GiB'), stat('eee555eee555', '2GiB / 41GiB')));
    expect(m.get('aaa111aaa111')).toBe(Math.round(73.62 * MiB));
    expect(m.get('bbb222bbb222')).toBe(1_500_000_000);
    expect(m.get('ccc333ccc333')).toBe(0);
    expect(m.get('ddd444ddd444')).toBe(512_000);
    expect(m.get('eee555eee555')).toBe(2 * GiB);
  });

  it('a line that is not a stats row, or a memory it cannot read, is left out rather than guessed', () => {
    const m = parseDockerStats(`Error: something\n${stat('aaa111aaa111', '-- / --')}\n${JSON.stringify({ mem: '1MiB / 2MiB' })}\n${stat('bbb222bbb222', '12 parsecs / 1GiB')}\n${stat('ccc333ccc333', '1MiB / 2GiB')}\n`);
    expect([...m.keys()]).toEqual(['ccc333ccc333']);
  });
});

describe('the containers of a sample', () => {
  it('a compose container: its name, project, working directory, state, health, memory and creation time; nothing else of the row', () => {
    const [c] = containersFrom(ps(row({ project: 'mobile-app', dir: '/Users/a/mobile-app/deploy', status: 'Up 2 days (healthy)' })), new Map([['a1b2c3d4e5f6', 100 * MiB]]), new Set());
    expect(c).toEqual({ name: 'mobile-app-db-1', created_at: Date.parse('2026-11-05T10:12:03+01:00'), state: 'running', health: 'healthy', memory: 100 * MiB, compose: 'mobile-app', working_dir: '/Users/a/mobile-app/deploy' });
  });

  it('a Testcontainers container carries whether it is one and its run\'s session id; one with the label and no id is still one', () => {
    const [a, b] = containersFrom(ps(row({ name: 'quirky_curie', tc: 'true', session: '3f2a9b' }), row({ id: 'f6e5d4c3b2a1', name: 'older', tc: 'true' })), new Map(), new Set());
    expect(a).toMatchObject({ name: 'quirky_curie', testcontainers: { session: '3f2a9b' } });
    expect(b).toMatchObject({ name: 'older', testcontainers: {} });
    expect(b!.testcontainers).not.toHaveProperty('session');
  });

  it('a container started by hand has a name, a state and no labels', () => {
    const [c] = containersFrom(ps(row({ name: 'scratch-redis' })), new Map(), new Set());
    expect(c).toEqual({ name: 'scratch-redis', created_at: Date.parse('2026-11-05T10:12:03+01:00'), state: 'running' });
  });

  it('health comes from the status text: unhealthy, healthy, starting, and none when the container has no check', () => {
    const health = (status: string) => containersFrom(ps(row({ status })), new Map(), new Set())[0]!.health;
    expect(health('Up 3 hours (unhealthy)')).toBe('unhealthy');
    expect(health('Up 3 hours (healthy)')).toBe('healthy');
    expect(health('Up 4 seconds (health: starting)')).toBe('starting');
    expect(health('Up 3 hours')).toBeUndefined();
    expect(health('Up 3 hours (Paused)')).toBeUndefined();
  });

  it('a container that is restarting or paused keeps the state Docker gave; one whose state is not a plain word is "unknown"', () => {
    const state = (s: unknown) => containersFrom(ps(row({ state: s })), new Map(), new Set())[0]!.state;
    expect(state('restarting')).toBe('restarting');
    expect(state('Running!')).toBe('unknown');
    expect(state(7)).toBe('unknown');
  });

  it('memory is matched by id, whichever of the two ids is the longer; a container stats did not list has none', () => {
    const by = Object.fromEntries(containersFrom(ps(row({ id: 'a1b2c3d4e5f6', name: 'a' }), row({ id: 'b2b2b2b2b2b2', name: 'b' }), row({ id: 'c3c3c3c3c3c3', name: 'c' })), new Map([['a1b2c3d4e5f6a7b8', 10], ['b2b2b2b2', 20]]), new Set()).map((c) => [c.name, c.memory]));
    expect(by).toEqual({ a: 10, b: 20, c: undefined });
  });

  it('a container of an excluded project sends its state, health and memory and no name, label, directory or time', () => {
    const [c, d] = containersFrom(ps(row({ project: 'secret-app', dir: '/Users/a/secret/deploy', status: 'Up 1 hour (unhealthy)' }), row({ id: 'f6e5d4c3b2a1', name: 'plain', project: 'mobile-app', dir: '/Users/a/mobile-app' })),
      new Map([['a1b2c3d4e5f6', 7 * MiB]]), new Set(['/Users/a/secret/deploy']));
    expect(c).toEqual({ state: 'running', health: 'unhealthy', memory: 7 * MiB, excluded: true });
    expect(d).toMatchObject({ name: 'plain', compose: 'mobile-app' });
  });

  it('nothing of the row beyond what the event names is read: not the command, the environment, the mounts, the labels or the image', () => {
    const out = JSON.stringify(containersFrom(ps(row({ project: 'mobile-app', dir: '/Users/a/mobile-app' })), new Map(), new Set()));
    expect(out).not.toMatch(/postgres|hunter2|sk-live|\.ssh|owner=|s3cret|deadbeef/);
  });

  it('lines that are not a container row are skipped, and the biggest by memory survive the cap of 200', () => {
    expect(containersFrom('Cannot connect to the Docker daemon\n\n{"id":5}\n[]\nnull\n', new Map(), new Set())).toEqual([]);
    const many = ps(...Array.from({ length: 205 }, (_, i) => row({ id: `id${String(i).padStart(10, '0')}`, name: `c${i}` })));
    const memory = new Map(Array.from({ length: 205 }, (_, i) => [`id${String(i).padStart(10, '0')}`, i] as const));
    const kept = containersFrom(many, memory, new Set());
    expect(kept).toHaveLength(200);
    expect(kept[0]!.memory).toBe(204);
    expect(kept.map((c) => c.memory)).not.toContain(4); // the five smallest went
  });
});

describe('which working directories are in an excluded project', () => {
  // git answers per directory: its top level, and its origin
  const git = (tops: Record<string, string>, remotes: Record<string, string> = {}) => {
    const calls: string[][] = [];
    const run: Run = async (argv) => {
      calls.push([...argv]);
      const dir = argv[2]!;
      if (argv[3] === 'rev-parse') return dir in tops ? { exitCode: 0, stdout: `${tops[dir]}\n` } : { exitCode: 128, stdout: '' };
      return dir in remotes ? { exitCode: 0, stdout: `${remotes[dir]}\n` } : { exitCode: 2, stdout: '' };
    };
    return { run, calls };
  };

  it('with nothing excluded git is never asked', async () => {
    const g = git({});
    expect([...await excludedDirs(g.run, ['/Users/a/x'], '')]).toEqual([]);
    expect(g.calls).toEqual([]);
  });

  it('an excluded path holds the directories inside it, and only those', async () => {
    const g = git({});
    expect([...await excludedDirs(g.run, ['/Users/a/secret', '/Users/a/secret/deploy', '/Users/a/secretive', '/Users/a/mobile-app'], '/Users/a/secret')].sort()).toEqual(['/Users/a/secret', '/Users/a/secret/deploy']);
  });

  it('an excluded name holds a directory inside a repository of that name, however deep it sits', async () => {
    const g = git({ '/Users/a/code/secret-app/deploy': '/Users/a/code/secret-app', '/Users/a/code/mobile-app': '/Users/a/code/mobile-app' });
    expect([...await excludedDirs(g.run, ['/Users/a/code/secret-app/deploy', '/Users/a/code/mobile-app'], 'secret-app')]).toEqual(['/Users/a/code/secret-app/deploy']);
  });

  it('an excluded remote holds the directory whose origin it is, written as the plugin writes a remote', async () => {
    const g = git({ '/w/a': '/w/a', '/w/b': '/w/b' }, { '/w/a': 'git@github.com:o/secret.git', '/w/b': 'git@github.com:o/other.git' });
    expect([...await excludedDirs(g.run, ['/w/a', '/w/b'], 'o/secret, ~/nowhere')]).toEqual(['/w/a']);
  });

  it('a directory git does not know is judged by its path and its last name', async () => {
    const g = git({});
    expect([...await excludedDirs(g.run, ['/gone/secret-app'], 'secret-app')]).toEqual(['/gone/secret-app']);
    expect([...await excludedDirs(async () => { throw new Error('spawn git ENOENT'); }, ['/gone/mobile-app'], 'secret-app')]).toEqual([]);
  });
});

describe('reading the machine', () => {
  type Reply = { exitCode: number; stdout: string } | 'enoent' | 'timeout';
  /** A fake `run`: each command answers from the table by its first words; the rest exit 127. */
  const machine = (os: string, answers: Record<string, Reply>) => {
    const calls: string[][] = [];
    const run: Run = async (argv) => {
      calls.push([...argv]);
      const a = argv[0] === 'uname' ? { exitCode: 0, stdout: `${os}\n` } : answers[argv.slice(0, 2).join(' ')] ?? answers[argv[0]!] ?? { exitCode: 127, stdout: '' };
      if (a === 'enoent') throw new Error(`spawn ${argv[0]} ENOENT`);
      if (a === 'timeout') throw new Error('timed out after 30000 ms');
      return a;
    };
    return { run, calls };
  };
  const VM = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 50.\nPages speculative: 10.\n';
  const mac = { 'vm_stat': { exitCode: 0, stdout: VM }, 'sysctl -n': { exitCode: 0, stdout: '1000000\n' } };
  const PS = ps(row({ project: 'mobile-app', dir: '/Users/a/mobile-app' }), row({ id: 'f6e5d4c3b2a1', name: 'scratch' }));
  const STATS = stats(stat('a1b2c3d4e5f6', '10MiB / 1GiB'), stat('f6e5d4c3b2a1', '20MiB / 1GiB'));

  it('on a Mac: the memory from vm_stat and sysctl, Docker ok, and the containers with their memory', async () => {
    const m = machine('Darwin', { ...mac, 'docker ps': { exitCode: 0, stdout: PS }, 'docker stats': { exitCode: 0, stdout: STATS } });
    const s = await readMachine(m.run, '');
    expect(s).toMatchObject({ docker: 'ok', mem_free: 160 * 16_384, mem_total: 1_000_000 });
    expect(s.containers.map((c) => [c.name, c.memory])).toEqual([['scratch', 20 * MiB], ['mobile-app-db-1', 10 * MiB]]); // biggest first
  });

  it('on Linux: /proc/meminfo, through cat', async () => {
    const m = machine('Linux', { 'cat /proc/meminfo': { exitCode: 0, stdout: 'MemTotal: 2000 kB\nMemAvailable: 1000 kB\n' }, 'docker ps': { exitCode: 0, stdout: '' } });
    expect(await readMachine(m.run, '')).toEqual({ docker: 'ok', mem_free: 1_024_000, mem_total: 2_048_000, containers: [] });
    expect(m.calls.map((c) => c[0])).not.toContain('vm_stat');
  });

  it('with no docker binary the state is "absent", no stats are asked, and the memory still comes', async () => {
    const m = machine('Darwin', { ...mac, docker: 'enoent' });
    expect(await readMachine(m.run, '')).toMatchObject({ docker: 'absent', containers: [], mem_total: 1_000_000 });
    expect(m.calls.some((c) => c[0] === 'docker' && c[1] === 'stats')).toBe(false);
  });

  it('with a daemon that does not answer, whether it exits non-zero or hangs, the state is "stopped"', async () => {
    for (const reply of [{ exitCode: 1, stdout: '' }, 'timeout' as const]) {
      const m = machine('Darwin', { ...mac, docker: reply });
      expect(await readMachine(m.run, '')).toMatchObject({ docker: 'stopped', containers: [] });
    }
  });

  it('no running container means no stats call, and a stats call that fails leaves the containers without memory', async () => {
    const none = machine('Linux', { 'docker ps': { exitCode: 0, stdout: '' } });
    expect((await readMachine(none.run, '')).containers).toEqual([]);
    expect(none.calls.some((c) => c[1] === 'stats')).toBe(false);
    const down = machine('Linux', { 'docker ps': { exitCode: 0, stdout: PS }, 'docker stats': { exitCode: 1, stdout: '' } });
    const s = await readMachine(down.run, '');
    expect(s.containers).toHaveLength(2);
    expect(s.containers.every((c) => c.memory === undefined)).toBe(true);
  });

  it('an unknown system sends no memory, and a memory read that fails sends none either', async () => {
    const s = await readMachine(machine('Plan9', { docker: { exitCode: 1, stdout: '' } }).run, '');
    expect(s).toEqual({ docker: 'stopped', containers: [] });
    const broken = await readMachine(machine('Darwin', { vm_stat: 'enoent', 'sysctl -n': { exitCode: 0, stdout: '5' }, 'docker ps': { exitCode: 0, stdout: '' } }).run, '');
    expect(broken).not.toHaveProperty('mem_free');
  });

  it('a container of an excluded project is reduced to numbers before it leaves', async () => {
    const m = machine('Linux', { 'docker ps': { exitCode: 0, stdout: ps(row({ project: 'secret-app', dir: '/Users/a/secret/deploy' })) }, 'docker stats': { exitCode: 0, stdout: STATS } });
    const s = await readMachine(m.run, '/Users/a/secret');
    expect(s.containers).toEqual([{ state: 'running', memory: 10 * MiB, excluded: true }]);
    expect(JSON.stringify(s)).not.toMatch(/secret|mobile-app-db/);
  });

  it('the sample passes the server\'s schema unchanged, with nothing stripped, and holds nothing the row had beyond its labels', async () => {
    const m = machine('Darwin', { ...mac, 'docker ps': { exitCode: 0, stdout: PS }, 'docker stats': { exitCode: 0, stdout: STATS } });
    const e = build.machineSample(ctx, await readMachine(m.run, ''));
    const parsed = Event.safeParse(e);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toEqual(e);
    expect(JSON.stringify(e)).not.toMatch(/postgres|hunter2|sk-live|\.ssh|owner=|s3cret|deadbeef/);
  });
});
