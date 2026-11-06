import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { all, openStore, run } from '../src/store/store.ts';

// #29: the soak seeds a 200-container machine sample so /api/machine has something to group, but only in its synthetic store. `--db` names a file that may be a real history, and a seed there
// would replace its host's latest sample (R15 of the review).
const dir = mkdtempSync(join(tmpdir(), 'orb-soakdb-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the soak on a file named by --db', () => {
  it('leaves the file\'s own machine sample as it was, and still reads every route', () => {
    const path = join(dir, 'history.db');
    const db = openStore(path);
    run(db, "INSERT INTO projects (id, name) VALUES ('p', 'mobile-app')");
    run(db, "INSERT INTO sessions (id, user_id, host, project_id, started_at) VALUES ('s', 'local', 'mbp', 'p', 1792000000000)");
    run(db, "INSERT INTO agents (id, session_id, started_at) VALUES ('s:main', 's', 1792000000000)");
    run(db, "INSERT INTO machine_samples (host, ts, mem_free, mem_total, docker, containers) VALUES ('mbp', 1792000100000, 5, 6, 'ok', '[{\"state\":\"running\",\"name\":\"real-redis\"}]')");
    db.close();

    const soak = join(import.meta.dirname, '..', 'scripts', 'soak.ts');
    const r = spawnSync(process.execPath, [soak, '--db', path, '--rounds', '5', '--route', '0'], { encoding: 'utf8', timeout: 60_000 });
    expect(r.stderr).not.toMatch(/Error/);
    expect(r.stdout).toContain('1 route x 5 rounds');

    const after = openStore(path);
    expect(all(after, 'SELECT host, ts, mem_free, containers FROM machine_samples').map((x) => ({ ...x }))).toEqual([{ host: 'mbp', ts: 1792000100000, mem_free: 5, containers: '[{"state":"running","name":"real-redis"}]' }]);
    after.close();
  }, 60_000); // a child process that starts a server and reads a route five times
});
