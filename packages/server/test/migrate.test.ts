import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { all, get, openStore } from '../src/store/store.ts';

// The history file the owner runs on was made before #28: `CREATE TABLE IF NOT EXISTS` leaves its tables as they were, so the columns #28 added (a session's branch, a PR's opening
// time and issue), and #29's (a session's last event), come from the list in store.ts. A file that lacked them would fail every write of a session start, and the live history is not a test rig.
const dir = mkdtempSync(join(tmpdir(), 'orb-migrate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const columns = (db: ReturnType<typeof openStore>, table: string) => all(db, `SELECT name FROM pragma_table_info('${table}')`).map((r) => r.name as string);

describe('opening a history file made before #28', () => {
  it('keeps its rows, takes the new columns, and opens again', () => {
    const path = join(dir, 'before.db');
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, host TEXT NOT NULL, project_id TEXT NOT NULL, started_at INTEGER, ended_at INTEGER, model TEXT, claude_version TEXT,
        content TEXT, source TEXT, recorded INTEGER, plugin_first INTEGER, plugin_last INTEGER, dropped_events INTEGER) WITHOUT ROWID;
      CREATE TABLE pull_requests (id TEXT PRIMARY KEY, project_id TEXT, number INTEGER NOT NULL, title TEXT, merged_at INTEGER, additions INTEGER, deletions INTEGER, head TEXT, size TEXT,
        counted_lines INTEGER, counted_files INTEGER) WITHOUT ROWID;
      INSERT INTO sessions (id, user_id, host, project_id, started_at) VALUES ('s-old', 'local', 'mbp', 'p', 1792000000000);
      INSERT INTO pull_requests (id, number, title, merged_at) VALUES ('p:7', 7, 'an old PR', 1792000000000);`);
    old.close();

    const db = openStore(path);
    expect(columns(db, 'sessions')).toEqual(expect.arrayContaining(['branch', 'seen_at'])); // seen_at: #29, the last event of a session
    expect(columns(db, 'pull_requests')).toEqual(expect.arrayContaining(['created_at', 'issue']));
    expect({ ...get(db, "SELECT id, started_at, branch FROM sessions WHERE id = 's-old'") }).toEqual({ id: 's-old', started_at: 1792000000000, branch: null });
    expect({ ...get(db, "SELECT title, merged_at, created_at, issue FROM pull_requests WHERE id = 'p:7'") }).toEqual({ title: 'an old PR', merged_at: 1792000000000, created_at: null, issue: null });
    expect(all(db, "SELECT name FROM sqlite_master WHERE name IN ('open_issues', 'budgets') ORDER BY name").map((r) => r.name)).toEqual(['budgets', 'open_issues']);
    db.close();

    openStore(path).close(); // the second open meets "duplicate column name" and goes on, as a second process opening the file would
  });
});
