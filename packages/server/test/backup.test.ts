import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

// The nightly backup and the restore (§10, §15 2026-10-24): host scripts in deploy/. The tests run them with
// /bin/bash (macOS's is 3.2, and it is what launchd runs) and a fake `docker` on PATH that records its arguments and plays the stack's one container.
// The fake runs the scripts' own JS and sh for real, on SQLite files in a folder that stands for the volume, so what a backup holds and what a restore puts back is
// checked as files, and the order of the steps (when the server is stopped, started again, the folder renamed) as calls. No container.
const root = realpathSync(join(import.meta.dirname, '../../..'));
const backup = join(root, 'deploy/backup.sh');
const restore = join(root, 'deploy/restore.sh');

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orb-bk-')));
  tmps.push(d);
  return d;
};

const sh = (script: string, args: string[], env: Record<string, string>, opts: { input?: string; cwd?: string } = {}) =>
  spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', timeout: 30_000, env: { PATH: '/usr/bin:/bin', ...env }, ...opts });

/** Every entry under dir, recursively: folders as `a/`, files as `a/b=<content>`. */
const tree = (dir: string, rel = ''): string[] =>
  readdirSync(join(dir, rel), { withFileTypes: true })
    .flatMap((e) => {
      const p = join(rel, e.name);
      return e.isDirectory() ? [`${p}/`, ...tree(dir, p)] : [`${p}=${readFileSync(join(dir, p), 'utf8')}`];
    })
    .sort();

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('backup.sh prune', () => {
  /** Nine dated folders whose mtimes run opposite to their names, and the entries prune must never touch. */
  const fixture = (): string => {
    const d = tmp();
    for (let i = 1; i <= 9; i++) {
      const name = `2026-10-0${i}`;
      mkdirSync(join(d, name));
      writeFileSync(join(d, name, 'history.db'), name);
      const t = new Date(2026, 0, 20 - i); // the oldest name has the newest mtime
      utimesSync(join(d, name), t, t);
    }
    mkdirSync(join(d, '.partial-2026-10-10'));
    writeFileSync(join(d, '.partial-2026-10-10', 'history.db'), 'half');
    writeFileSync(join(d, 'backup.log'), 'log');
    mkdirSync(join(d, 'notes'));
    writeFileSync(join(d, 'notes', 'a.txt'), 'mine');
    writeFileSync(join(d, '2026-10-10'), 'a file, not a folder'); // newest name, but not a backup folder
    for (const near of ['2026-10-01.bak', 'x2026-10-02', '2026-10-1']) mkdirSync(join(d, near)); // near misses, all older than the cut
    return d;
  };
  const prune = (dir: string, keep: string) => sh(backup, ['prune'], { HOME: dir, ORB_BACKUP_DIR: dir, ORB_BACKUP_KEEP: keep });
  const dated = (dir: string) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort();

  it('keeps the 7 newest by name, not by mtime, and touches nothing else', () => {
    const d = fixture();
    const before = tree(d);
    const r = prune(d, '7');
    expect(r.status, r.stderr).toBe(0);
    expect(dated(d)).toEqual(['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    expect(tree(d)).toEqual(before.filter((p) => !/^2026-10-0[12](\/|=)/.test(p)));
  });

  it('a second run changes nothing', () => {
    const d = fixture();
    prune(d, '7');
    const once = tree(d);
    expect(prune(d, '7').status).toBe(0);
    expect(tree(d)).toEqual(once);
  });

  it('ORB_BACKUP_KEEP=3 leaves 3', () => {
    const d = fixture();
    const before = tree(d);
    expect(prune(d, '3').status).toBe(0);
    expect(dated(d)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
    expect(tree(d)).toEqual(before.filter((p) => !/^2026-10-0[1-6](\/|=)/.test(p)));
  });

  it.each(['0', '-1', 'seven', '3x'])('refuses ORB_BACKUP_KEEP=%j and deletes nothing', (keep) => {
    const d = fixture();
    const before = tree(d);
    expect(prune(d, keep).status).toBe(1); // die(), not a crash or a missing script
    expect(tree(d)).toEqual(before);
  });

  it('a backup folder that does not exist yet is not an error and is not created', () => {
    const d = join(tmp(), 'nope');
    const r = prune(d, '7');
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(d)).toBe(false);
  });
});

describe('backup.sh install', () => {
  const plutilJson = (xml: string) => JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8' }).stdout);

  /** A bin dir with a fake docker (that logs), launchctl (logs) and optionally uname. Returns its path and the log. */
  const fakeBin = (uname?: string) => {
    const dir = tmp();
    const log = join(dir, 'calls.log');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(log, '');
    for (const name of ['docker', 'launchctl']) writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n`);
    if (uname) writeFileSync(join(bin, 'uname'), `#!/bin/bash\necho ${uname}\n`);
    for (const f of readdirSync(bin)) chmodSync(join(bin, f), 0o755);
    return { bin, log };
  };

  it.skipIf(process.platform !== 'darwin')('--dry-run prints the launchd plist and changes nothing', () => {
    const home = tmp();
    const { bin, log } = fakeBin();
    const bk = join(home, 'b&k dir'); // a path that needs XML escaping and has a space
    const r = sh(backup, ['install', '--dry-run'], {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      ORB_BACKUP_DIR: bk,
      ORB_BACKUP_KEEP: '5',
      ORB_COMPOSE_PROJECT: 'drill',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(join(home, 'Library/LaunchAgents/dev.agent-orb.backup.plist')); // says where it would write
    const plist = plutilJson(/<\?xml[\s\S]*<\/plist>/.exec(r.stdout)?.[0] ?? '');
    expect(plist.Label).toBe('dev.agent-orb.backup');
    expect(plist.ProgramArguments).toEqual(['/bin/bash', backup, 'run']);
    expect(plist.StartCalendarInterval).toEqual({ Hour: 3, Minute: 30 });
    expect(plist.StandardOutPath).toBe(join(bk, 'backup.log'));
    expect(plist.StandardErrorPath).toBe(join(bk, 'backup.log'));
    expect(plist.EnvironmentVariables).toMatchObject({
      ORB_COMPOSE_FILE: join(root, 'deploy/docker-compose.yml'),
      ORB_COMPOSE_PROJECT: 'drill',
      ORB_BACKUP_DIR: bk,
      ORB_BACKUP_KEEP: '5',
    });
    expect(plist.EnvironmentVariables.PATH.split(':')).toContain(bin); // the directory of `command -v docker`
    // nothing was written, nothing was loaded
    expect(existsSync(join(home, 'Library'))).toBe(false);
    expect(existsSync(bk)).toBe(false);
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  describe('the plist PATH', () => {
    const fixed = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    /** The dry-run plist's PATH with docker found in dockerDir: a dirname shim stands in for a docker that lives in a directory the test cannot write to. */
    const pathWhenDockerIs = (dockerDir: string) => {
      const { bin } = fakeBin('Darwin');
      writeFileSync(join(bin, 'dirname'), `#!/bin/bash\nif [ "$1" = "${bin}/docker" ]; then echo ${dockerDir}; else exec /usr/bin/dirname "$@"; fi\n`);
      chmodSync(join(bin, 'dirname'), 0o755);
      const r = sh(backup, ['install', '--dry-run'], { HOME: tmp(), PATH: `${bin}:/usr/bin:/bin` });
      expect(r.status, r.stderr).toBe(0);
      return /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(r.stdout)?.[1]?.split(':');
    };

    it.each(['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin'])('leaves docker\'s directory out when it is %s, already in the list', (dir) => {
      expect(pathWhenDockerIs(dir)).toEqual(fixed);
    });

    it('puts docker\'s directory first when it is not in the list, even when the list contains it as part of a longer path', () => {
      expect(pathWhenDockerIs('/usr/local')).toEqual(['/usr/local', ...fixed]);
    });
  });

  it('on Linux it prints the crontab line and changes nothing', () => {
    const home = tmp();
    const { bin, log } = fakeBin('Linux');
    const bk = join(home, 'bk');
    const r = sh(backup, ['install'], { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ORB_BACKUP_DIR: bk });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`30 3 * * * ORB_BACKUP_DIR=${bk} ${backup} run >> ${bk}/backup.log 2>&1`); // the non-default setting rides on the line
    expect(r.stdout).not.toContain('ORB_COMPOSE_FILE='); // defaults do not
    expect(existsSync(join(home, 'Library'))).toBe(false);
    expect(existsSync(bk)).toBe(false);
    expect(readFileSync(log, 'utf8')).toBe('');
  });
});

// Each case starts bash and node a few times, which a loaded machine takes seconds over: the default 5 s is for tests that start nothing.
describe('backup.sh run and restore.sh, against a fake docker', { timeout: 60_000 }, () => {
  /**
   * A fake docker that logs one line per call and plays the stack: one container, c-orb-server, whose image id (sha256:img-orb-server) only `docker inspect` of
   * that container tells, and a folder standing for its /var/lib/agent-orb. FAKE_ORB says whether the container is running (default), stopped or none, as `compose ps`
   * would; FAKE_FAIL plays the failures. A call it does not know exits 98, and `compose run` is one of them: a one-off goes through `docker run` on an image id,
   * never through the compose file. The scripts' node and sh run for real (NODE is the test's own node), with the container's paths mapped onto the folders.
   */
  const stack = () => {
    const dir = tmp();
    const log = join(dir, 'calls.log');
    const vol = join(dir, 'orb-content-data');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    mkdirSync(vol);
    writeFileSync(log, '');
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/bash
echo "$*" | tr '\\n' ' ' >> "${log}"; echo >> "${log}"
kind=docker
if [ "$1" = compose ]; then kind=compose; shift 3; if [ "$1" = -p ]; then shift 2; fi; fi   # compose -f FILE [-p PROJECT]
verb=$1; shift
last=\${!#}
state() { case $1 in orb-server) echo "\${FAKE_ORB:-running}";; *) echo none;; esac; }
onvol() { echo "${vol}/\${1#/var/lib/agent-orb/}"; }   # a path inside orb-server's container, as a path on the host
mnt=; prev=; for a in "$@"; do if [ "$prev" = -v ]; then mnt=\${a%%:*}; fi; prev=$a; done
# the container's paths, as the host's: the volume, then the folder mounted at /backups
mapped() { local t=\${1//\\/var\\/lib\\/agent-orb/${vol}}; echo "\${t//\\/backups/$mnt}"; }
case "$kind $verb" in
  "compose ps")   # without -a, compose lists the running containers only
    svc=$last; st=$(state "$svc")
    case " $* " in
      *" -aq "*) if [ "$st" != none ]; then echo "c-$svc"; fi;;
      *) if [ "$st" = running ]; then echo "c-$svc"; fi;;
    esac;;
  "compose stop" | "compose start") ;;
  "compose exec")
    if [ "$(state orb-server)" != running ]; then echo "service orb-server is not running" >&2; exit 1; fi
    case "$*" in
      *"rm -f"*) for a in "$@"; do case $a in /var/lib/agent-orb/*) rm -f "$(onvol "$a")";; esac; done;;
      *"node -e"*)
        if [ "\${FAKE_FAIL:-}" = snapshot ]; then echo "Error: the fake snapshot failed" >&2; exit 1; fi
        "$NODE" -e "$(mapped "$last")";;
      *) exit 98;;
    esac;;
  "compose cp") cp "$(onvol "\${1#orb-server:}")" "$2";;
  "docker inspect") case $last in c-*) echo "sha256:img-\${last#c-}";; *) echo "Error: no such object: $last" >&2; exit 1;; esac;;
  "docker run")
    case "$*" in
      *"--entrypoint node"*)
        if [ "\${FAKE_FAIL:-}" = snapshot ]; then echo "Error: the fake snapshot failed" >&2; exit 1; fi
        if [ "\${FAKE_FAIL:-}" = nofile ]; then exit 0; fi   # exits 0 and writes nothing
        "$NODE" -e "$(mapped "$last")";;
      *"--entrypoint sh"*)
        if [ "\${FAKE_FAIL:-}" = copy ]; then echo "Error: the fake copy failed" >&2; exit 1; fi
        sh -c "$(mapped "$last")";;
      *) exit 98;;
    esac;;
  *) echo "fake docker: unexpected $kind $verb" >&2; exit 98;;
esac
`,
    );
    chmodSync(join(bin, 'docker'), 0o755);
    const compose = join(dir, 'docker-compose.yml');
    const env = (extra: Record<string, string> = {}) => ({
      HOME: dir,
      PATH: `${bin}:/usr/bin:/bin`,
      NODE: process.execPath,
      NODE_NO_WARNINGS: '1', // node:sqlite's experimental warning, on the stderr the tests read
      ORB_COMPOSE_FILE: compose,
      ORB_BACKUP_DIR: join(dir, 'bk'),
      ...extra,
    });
    /** The calls so far, without the `compose -f FILE [-p P]` prefix: `run ...` and `inspect ...` are docker's own, `exec`, `cp`, `ps`, `stop`, `start` compose's. */
    const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.trimEnd().replace(/^compose -f \S+( -p \S+)? /, ''));
    return { dir, vol, compose, env, calls, raw: () => readFileSync(log, 'utf8') };
  };
  type Stack = ReturnType<typeof stack>;

  /**
   * A SQLite file in WAL mode with `n` rows, its connection left open, as the server leaves it: the rows are in the -wal file and not in the main file, which a
   * plain copy of the main file would miss.
   */
  const open: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of open.splice(0)) db.close();
  });
  const seed = (path: string, n: number) => {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x INTEGER)');
    for (let i = 0; i < n; i++) db.exec(`INSERT INTO t VALUES (${i})`);
    open.push(db);
    return db;
  };
  const rowsIn = (path: string): number => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return (db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n;
    } finally {
      db.close();
    }
  };
  /** The stack's volume with the two files a started server leaves: history.db with 5 rows and content.db with 3. */
  const started = (s: Stack) => {
    seed(join(s.vol, 'history.db'), 5);
    seed(join(s.vol, 'content.db'), 3);
  };

  /** Index of the first call matching re; fails the test when none does. */
  const at = (calls: string[], re: RegExp): number => {
    const i = calls.findIndex((c) => re.test(c));
    expect(i, `no call matching ${re} in:\n${calls.join('\n')}`).toBeGreaterThanOrEqual(0);
    return i;
  };
  const ascending = (order: number[]) => expect(order).toEqual([...order].sort((a, b) => a - b));
  const noServer = 'the stack has no orb-server container: start it once with docker compose up -d';
  const stopsOrStarts = (calls: string[]) => calls.filter((c) => /^(stop|start) /.test(c));
  /**
   * Every call in the log that is not one of the few a backup or restore may make: compose ps/stop/start/exec/cp,
   * docker inspect of a container, and docker run on the image id of the container whose volumes it takes. `compose run`,
   * `pull`, `build`, `up` and a run on a tag are all outside the list, so none can pass.
   */
  const strays = (raw: string): string[] =>
    raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter(
        (l) =>
          !/^compose -f \S+( -p \S+)? (ps|stop|start|exec|cp) /.test(l) &&
          !/^inspect --format \{\{\.Image\}\} c-\S+$/.test(l) &&
          !(/^run --rm --volumes-from c-(\S+) .*sha256:img-\1 \S/.test(l) && !/ --(pull|build)\b/.test(l)),
      );

  describe('run', () => {
    it('with orb-server running, copies both files out of its container as they stand, stops nothing, and publishes a complete folder', () => {
      const s = stack();
      started(s);
      const r = sh(backup, [], s.env());
      expect(r.status, r.stderr).toBe(0);
      const c = s.calls();
      expect(stopsOrStarts(c)).toEqual([]); // the server keeps running: the backup is VACUUM INTO alone
      const remove = /^exec -T orb-server rm -f \/var\/lib\/agent-orb\/\.backup-history\.db \/var\/lib\/agent-orb\/\.backup-content\.db$/;
      const removals = c.flatMap((x, i) => (remove.test(x) ? [i] : []));
      expect(removals).toHaveLength(2); // before the snapshot, for a stale file, and after the copy
      const snapshot = at(c, /^exec -T -e NODE_NO_WARNINGS=1 orb-server node -e .*VACUUM INTO/); // the flag is compose's, not a node argument
      const history = at(c, /^cp orb-server:\/var\/lib\/agent-orb\/\.backup-history\.db \S+\/\.partial-\d{4}-\d{2}-\d{2}\/history\.db$/);
      const content = at(c, /^cp orb-server:\/var\/lib\/agent-orb\/\.backup-content\.db \S+\/\.partial-\d{4}-\d{2}-\d{2}\/content\.db$/);
      ascending([removals[0]!, snapshot, history, content, removals[1]!]);
      expect(c.some((x) => /^run /.test(x))).toBe(false); // no one-off
      // only the finished folder is left, with both files, whole: the rows that were still in the WAL are in them
      expect(readdirSync(join(s.dir, 'bk'))).toEqual([today()]);
      expect(readdirSync(join(s.dir, 'bk', today())).sort()).toEqual(['content.db', 'history.db']);
      expect(rowsIn(join(s.dir, 'bk', today(), 'history.db'))).toBe(5);
      expect(rowsIn(join(s.dir, 'bk', today(), 'content.db'))).toBe(3);
      expect(readdirSync(s.vol).filter((f) => f.startsWith('.backup'))).toEqual([]); // nothing left in the volume
      expect(r.stdout).toContain(join(s.dir, 'bk', today()));
      expect(r.stdout).toMatch(/history\.db \S+, content\.db \S+/);
    });

    it('a snapshot file left in the volume by a killed run does not stop the next one', () => {
      const s = stack();
      started(s);
      writeFileSync(join(s.vol, '.backup-history.db'), 'stale'); // VACUUM INTO refuses a file that exists
      const r = sh(backup, [], s.env());
      expect(r.status, r.stderr).toBe(0);
      expect(rowsIn(join(s.dir, 'bk', today(), 'history.db'))).toBe(5);
      expect(readdirSync(s.vol).filter((f) => f.startsWith('.backup'))).toEqual([]);
    });

    it('with orb-server stopped, snapshots both files in a one-off of its own container\'s image, volumes and all', () => {
      const s = stack();
      started(s);
      const r = sh(backup, [], s.env({ FAKE_ORB: 'stopped' }));
      expect(r.status, r.stderr).toBe(0);
      const c = s.calls();
      const snapshots = c.filter((x) => x.includes('VACUUM INTO'));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatch(/^run --rm --volumes-from c-orb-server -e NODE_NO_WARNINGS=1 -v \S+\/\.partial-\d{4}-\d{2}-\d{2}:\/backups --entrypoint node sha256:img-orb-server -e /);
      expect(c.some((x) => /^(exec|cp) /.test(x))).toBe(false);
      expect(stopsOrStarts(c)).toEqual([]);
      expect(rowsIn(join(s.dir, 'bk', today(), 'history.db'))).toBe(5);
      expect(rowsIn(join(s.dir, 'bk', today(), 'content.db'))).toBe(3);
    });

    it('passes -p to every compose call only when a project is set, and docker only gets container ids', () => {
      const lines = (project?: string) => {
        const s = stack();
        started(s);
        sh(backup, ['run'], s.env(project ? { ORB_COMPOSE_PROJECT: project } : {}));
        return { all: s.raw().split('\n').filter(Boolean), compose: s.compose };
      };
      const withP = lines('drill');
      const viaCompose = withP.all.filter((l) => l.startsWith('compose '));
      expect(viaCompose.length).toBeGreaterThan(0);
      expect(viaCompose.every((l) => l.startsWith(`compose -f ${withP.compose} -p drill `))).toBe(true);
      expect(withP.all.filter((l) => !l.startsWith('compose ')).every((l) => /^(inspect|run) /.test(l))).toBe(true); // the project is in the ids those carry
      const without = lines();
      expect(without.all.every((l) => !l.startsWith('compose ') || (l.startsWith(`compose -f ${without.compose} `) && !l.includes(' -p ')))).toBe(true);
    });

    it.each([
      ['no file', [], {}],
      ['no file', [], { FAKE_ORB: 'stopped' }],
      ['only history.db', ['history.db'], {}],
      ['only content.db', ['content.db'], { FAKE_ORB: 'stopped' }],
    ])('a volume with %s (the server has not started yet) fails and says so, publishes nothing and prunes nothing', (_name, files, extra) => {
      const s = stack();
      for (const f of files) seed(join(s.vol, f), 1);
      const bk = join(s.dir, 'bk');
      mkdirSync(join(bk, '2020-01-01'), { recursive: true });
      const before = tree(bk);
      const r = sh(backup, ['run'], s.env({ ORB_BACKUP_KEEP: '1', ...extra }));
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/is not in the volume yet/);
      expect(r.stderr).toMatch(/start it once/);
      expect(tree(bk)).toEqual(before); // no partial folder, nothing published or pruned
    });

    it('names the missing container and changes nothing when the stack has no orb-server container', () => {
      const s = stack();
      const bk = join(s.dir, 'bk');
      mkdirSync(join(bk, '2020-01-01'), { recursive: true });
      const before = tree(bk);
      const r = sh(backup, ['run'], s.env({ FAKE_ORB: 'none', ORB_BACKUP_KEEP: '1' }));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(noServer);
      expect(tree(bk)).toEqual(before);
    });

    it.each([
      ['running', {}],
      ['stopped', { FAKE_ORB: 'stopped' }],
    ])('a failed snapshot (orb-server %s) leaves no partial folder, keeps what was there, and still fails', (_state, extra) => {
      const s = stack();
      started(s);
      const bk = join(s.dir, 'bk');
      mkdirSync(join(bk, today()), { recursive: true });
      writeFileSync(join(bk, today(), 'history.db'), 'earlier today');
      mkdirSync(join(bk, '2020-01-01'));
      const before = tree(bk);
      const r = sh(backup, ['run'], s.env({ FAKE_FAIL: 'snapshot', ORB_BACKUP_KEEP: '1', ...extra }));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('the fake snapshot failed');
      expect(tree(bk)).toEqual(before);
    });

    it('a snapshot that exits 0 but wrote no files is not published, and prunes nothing', () => {
      const s = stack();
      started(s);
      const bk = join(s.dir, 'bk');
      mkdirSync(join(bk, '2020-01-01'), { recursive: true });
      const r = sh(backup, ['run'], s.env({ FAKE_ORB: 'stopped', FAKE_FAIL: 'nofile', ORB_BACKUP_KEEP: '1' }));
      expect(r.status).toBe(1);
      expect(readdirSync(bk)).toEqual(['2020-01-01']);
    });

    it('a second run on the same day replaces that day only once the new folder is complete', () => {
      const s = stack();
      started(s);
      const bk = join(s.dir, 'bk');
      mkdirSync(join(bk, today()), { recursive: true });
      writeFileSync(join(bk, today(), 'old.txt'), 'first run');
      const r = sh(backup, ['run'], s.env());
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(bk)).toEqual([today()]); // no .old-* or .partial-* left
      expect(readdirSync(join(bk, today())).sort()).toEqual(['content.db', 'history.db']);
    });

    it('prunes after a run', () => {
      const s = stack();
      started(s);
      const bk = join(s.dir, 'bk');
      for (const d of ['2020-01-01', '2020-01-02', '2020-01-03']) mkdirSync(join(bk, d), { recursive: true });
      const r = sh(backup, ['run'], s.env({ ORB_BACKUP_KEEP: '2' }));
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(bk).sort()).toEqual(['2020-01-03', today()]);
    });
  });

  describe('restore', () => {
    /** A backup folder with the given files, each holding its own name, in the stack's backup directory. */
    const folder = (s: Stack, files: string[]) => {
      const f = join(s.dir, 'bk', '2026-10-24');
      mkdirSync(f, { recursive: true });
      for (const n of files) writeFileSync(join(f, n), n);
      return f;
    };

    it('refuses a folder without both files, and a missing one, before touching anything', () => {
      const s = stack();
      for (const arg of [folder(s, ['content.db']), join(s.dir, 'nope')]) {
        const r = sh(restore, ['--yes', arg], s.env());
        expect(r.status).toBe(1);
      }
      rmSync(join(s.dir, 'bk'), { recursive: true });
      expect(sh(restore, ['--yes', folder(s, ['history.db'])], s.env()).status).toBe(1);
      expect(sh(restore, ['--yes'], s.env()).status).toBe(2); // no folder at all: usage
      expect(s.raw()).toBe('');
    });

    it('says plainly that a v0.2 backup, with its neo4j.dump, cannot be restored by this version', () => {
      const s = stack();
      const r = sh(restore, ['--yes', folder(s, ['neo4j.dump', 'content.db'])], s.env());
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/neo4j\.dump/);
      expect(r.stderr).toMatch(/cannot restore/);
      expect(s.raw()).toBe('');
    });

    it('without --yes it asks, and an empty answer does nothing', () => {
      const s = stack();
      const f = folder(s, ['history.db', 'content.db']);
      const r = sh(restore, [f], s.env(), { input: '' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/cancel/i);
      expect(s.raw()).toBe('');
    });

    it('stops the server, puts both files back, then starts it, from its own container\'s image, and a relative folder reaches docker as an absolute path', () => {
      const s = stack();
      folder(s, ['history.db', 'content.db']);
      writeFileSync(join(s.vol, 'history.db'), 'old history');
      writeFileSync(join(s.vol, 'content.db'), 'old content');
      const r = sh(restore, ['--yes', 'bk/2026-10-24'], s.env(), { cwd: s.dir });
      expect(r.status, r.stderr).toBe(0);
      const c = s.calls();
      const copy = at(c, /^run --rm --volumes-from c-orb-server -v \S+:\/backups --entrypoint sh sha256:img-orb-server -c /);
      ascending([at(c, /^stop orb-server$/), copy, at(c, /^start orb-server$/)]);
      expect(c[copy]).toContain(`-v ${join(s.dir, 'bk', '2026-10-24')}:/backups`);
      expect(readFileSync(join(s.vol, 'history.db'), 'utf8')).toBe('history.db');
      expect(readFileSync(join(s.vol, 'content.db'), 'utf8')).toBe('content.db');
    });

    it('drops each old file\'s -wal and -shm, so they are never replayed onto the restored file, and leaves nothing beside it', () => {
      const s = stack();
      const f = folder(s, ['history.db', 'content.db']);
      for (const n of ['history.db', 'content.db']) for (const ext of ['', '-wal', '-shm']) writeFileSync(join(s.vol, n + ext), `old ${n}${ext}`);
      const r = sh(restore, ['--yes', f], s.env());
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(s.vol).sort()).toEqual(['content.db', 'history.db']);
    });

    it('a failed copy leaves the server stopped, keeps the old files, and says nothing was started again', () => {
      const s = stack();
      writeFileSync(join(s.vol, 'history.db'), 'old history');
      const r = sh(restore, ['--yes', folder(s, ['history.db', 'content.db'])], s.env({ FAKE_FAIL: 'copy' }));
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Nothing was started again/);
      expect(s.calls().some((c) => /^start /.test(c))).toBe(false);
      expect(readFileSync(join(s.vol, 'history.db'), 'utf8')).toBe('old history');
    });

    it('fails, and starts nothing, when the stack has no orb-server container', () => {
      const s = stack();
      const r = sh(restore, ['--yes', folder(s, ['history.db', 'content.db'])], s.env({ FAKE_ORB: 'none' }));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(noServer);
      expect(r.stderr).toMatch(/Nothing was started again/);
      expect(s.calls().some((c) => /^(start|run) /.test(c))).toBe(false);
    });

    it('a backup restored over a volume that has moved on brings back exactly what it held', () => {
      const s = stack();
      started(s); // 5 rows in history.db, 3 in content.db
      expect(sh(backup, ['run'], s.env()).status).toBe(0);
      const dated = join(s.dir, 'bk', today());
      for (const db of open) db.exec('INSERT INTO t VALUES (99), (98)'); // the server went on writing
      const r = sh(restore, ['--yes', dated], s.env());
      expect(r.status, r.stderr).toBe(0);
      expect(rowsIn(join(s.vol, 'history.db'))).toBe(5);
      expect(rowsIn(join(s.vol, 'content.db'))).toBe(3);
    });
  });

  describe('never pulls or builds an image', () => {
    // A `compose run` takes the compose file's current image; the tag it names may not be on this machine. Every path, failures included.
    const backups: [string, Record<string, string>, number][] = [
      ['orb-server running', {}, 0],
      ['orb-server stopped', { FAKE_ORB: 'stopped' }, 0],
      ['no orb-server container', { FAKE_ORB: 'none' }, 1],
      ['the snapshot fails, running', { FAKE_FAIL: 'snapshot' }, 1],
      ['the snapshot fails, stopped', { FAKE_ORB: 'stopped', FAKE_FAIL: 'snapshot' }, 1],
      ['the snapshot writes no file', { FAKE_ORB: 'stopped', FAKE_FAIL: 'nofile' }, 1],
    ];
    it.each(backups)('backup run: %s', (_name, extra, status) => {
      const s = stack();
      started(s);
      const r = sh(backup, ['run'], s.env(extra));
      expect(r.status, r.stderr).toBe(status);
      expect(s.raw()).not.toBe(''); // it asked docker something
      expect(strays(s.raw())).toEqual([]);
    });

    const restores: [string, Record<string, string>, string[], number][] = [
      ['with the text', {}, ['history.db', 'content.db'], 0],
      ['orb-server stopped', { FAKE_ORB: 'stopped' }, ['history.db', 'content.db'], 0],
      ['no orb-server container', { FAKE_ORB: 'none' }, ['history.db', 'content.db'], 1],
      ['the copy fails', { FAKE_FAIL: 'copy' }, ['history.db', 'content.db'], 1],
    ];
    it.each(restores)('restore: %s', (_name, extra, files, status) => {
      const s = stack();
      const f = join(s.dir, 'bk', '2026-10-24');
      mkdirSync(f, { recursive: true });
      for (const n of files) writeFileSync(join(f, n), n);
      const r = sh(restore, ['--yes', f], s.env(extra));
      expect(r.status, r.stderr).toBe(status);
      expect(s.raw()).not.toBe('');
      expect(strays(s.raw())).toEqual([]);
    });

    it('the check itself: it flags a compose run, a pull, a build, an up, and a run on a tag', () => {
      const image = 'run --rm --volumes-from c-orb-server sha256:img-orb-server node -e x';
      expect(strays(`compose -f f.yml ps -aq orb-server\ninspect --format {{.Image}} c-orb-server\n${image}\ncompose -f f.yml exec -T orb-server rm -f x\n`)).toEqual([]);
      const bad = [
        'compose -f f.yml run -T --rm --no-deps orb-server node -e x',
        'compose -f f.yml pull orb-server',
        'compose -f f.yml build orb-server',
        'compose -f f.yml up -d',
        'pull ghcr.io/alfredo1996/agent-orb-server:0.2.0',
        'run --rm --volumes-from c-orb-server ghcr.io/alfredo1996/agent-orb-server:0.2.0 node -e x',
        'run --rm --volumes-from c-orb-server --pull always sha256:img-orb-server node -e x',
        'run --rm --volumes-from c-orb-server sha256:img-other node -e x', // another container's image
      ];
      for (const b of bad) expect(strays(`${b}\n`), b).toEqual([b]);
    });
  });
});

describe('the scripts', () => {
  it.each([backup, restore])('%s is valid bash 3.2 and executable', (script) => {
    expect(spawnSync('/bin/bash', ['-n', script], { encoding: 'utf8' }).status).toBe(0);
    expect(statSync(script).mode & 0o111).not.toBe(0);
  });
});
