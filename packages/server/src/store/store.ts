import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

// The history store (#81): one SQLite file beside the text store (content-store.ts), the graph's facts as tables (schema.sql).
export type Store = DatabaseSync;
export type Row = Record<string, any>;

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/** `history.db` in the text store's directory: the same folder and volume, its own name. */
export const historyPath = (env: Record<string, string | undefined> = process.env) => join(dirname(env.CONTENT_DB ?? 'content.db'), 'history.db');

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000'); // first: the import is a second process on this file, beside the server's writes, and switching to WAL takes a lock
  db.exec('PRAGMA journal_mode = WAL');
  // Memory must not grow with the file: the page cache is what would, so it is set here, to 8 MB (a negative size is KiB), and not left to the build's default.
  // The gate fails a server whose RSS passes 150 MB on the full import (#81; `pnpm soak` is that check).
  db.exec('PRAGMA cache_size = -8192');
  db.exec(SCHEMA);
  // ponytail: `CREATE TABLE IF NOT EXISTS` leaves a table of an older file as it was, so a column added since is added here, once, and this list is the whole migration.
  // Two processes (the server and the import) may open the file together: the one that loses the race meets "duplicate column name", which is the answer it wanted.
  for (const [table, column] of ADDED) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    } catch (e) {
      if (!/duplicate column name/i.test(String(e))) throw e;
    }
  }
  return db;
}

// Columns added after a file could exist (#103: what a PR was counted from, and when a session linked it); schema.sql has them for a new file.
const ADDED = [['pull_requests', 'counted_lines INTEGER'], ['pull_requests', 'counted_files INTEGER'], ['session_prs', 'ts INTEGER']] as const;

// A statement is prepared once per SQL text and file, so the writer's inline SQL costs one parse for the life of the store. The text store and the analysis
// store, which are other files, go through this too (a route that calls `db.prepare` itself prepares again on every request, #90).
const prepared = new WeakMap<Store, Map<string, StatementSync>>();
export const prepare = (db: Store, sql: string) => {
  let m = prepared.get(db);
  if (!m) prepared.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
};
// Named parameters (`:name`), as plain objects. A JS boolean and undefined bind in neither SQLite nor node:sqlite.
const bind = (params: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(params).map(([k, v]) => [k, (v === undefined ? null : v === true ? 1 : v === false ? 0 : v) as SQLInputValue]));

export const run = (db: Store, sql: string, params: Record<string, unknown> = {}) => prepare(db, sql).run(bind(params));
export const get = (db: Store, sql: string, params: Record<string, unknown> = {}) => prepare(db, sql).get(bind(params)) as Row | undefined;
export const all = (db: Store, sql: string, params: Record<string, unknown> = {}) => prepare(db, sql).all(bind(params)) as Row[];
/**
 * The rows one at a time, for a route that builds its answer as it reads and so never holds the result beside it (#90). The statement is busy until the loop ends:
 * nothing inside the loop may run the same SQL text.
 */
export const each = (db: Store, sql: string, params: Record<string, unknown> = {}) => prepare(db, sql).iterate(bind(params)) as IterableIterator<Row>;
