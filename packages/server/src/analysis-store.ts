import { DatabaseSync } from 'node:sqlite';
import { prepare } from './store/store.ts';

// Slice 7: the analyses run and the monthly cap, in the text store's file (a report is text, §15 2026-10-20).
// v0.3 slice 2 (#42): beside the cap, the owner's numbers for Worth, which stay on this machine.

export type ReportRow = {
  id: string; project: string; from_ts: number | null; to_ts: number | null; session: string | null; model: string;
  input_tokens: number; output_tokens: number; cost: number; created_at: number; report: string;
};
/** Worth: the owner's hourly rate and what the plan costs a month (null until set), the hours behind each PR size, and the score each size starts below (#103). */
export type Sizes = { S: number; M: number; L: number; XL: number };
/** A PR is S below `S`, M below `M`, L below `L`, and XL from there: lines x (1 + log2 files), as design/v0.3-readable.html decides. */
export type Cuts = { S: number; M: number; L: number };
export type WorthSettings = { rate: number | null; plan: number | null; sizes: Sizes; cuts: Cuts };
export const DEFAULT_SIZES: Sizes = { S: 0.5, M: 2, L: 6, XL: 16 }; // §15, 2026-10-25
export const DEFAULT_CUTS: Cuts = { S: 300, M: 1500, L: 6000 }; // §15, 2026-10-27

export type AnalysisStore = {
  add(r: ReportRow): void;
  list(limit?: number): Omit<ReportRow, 'report'>[];
  get(id: string): ReportRow | undefined;
  /** What runs cost since `ts`, and how many there were: the month's spend against the cap, the Ledger's line. */
  spent(since: number, until?: number, project?: string): { runs: number; cost: number };
  cap(): number;
  setCap(usd: number): void;
  worth(): WorthSettings;
  /** Changes what the patch names and keeps the rest (`null` clears a rate or a plan; a size not named keeps its hours); answers the settings now. */
  setWorth(patch: { rate?: number | null; plan?: number | null; sizes?: Partial<Sizes>; cuts?: Partial<Cuts> }): WorthSettings;
  close(): void;
};

export const DEFAULT_CAP = 20; // USD a month (§15, 2026-10-21)

export function openAnalysisStore(path: string): AnalysisStore {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS analysis_reports (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, from_ts INTEGER, to_ts INTEGER, session TEXT, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost REAL NOT NULL, created_at INTEGER NOT NULL, report TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS analysis_created ON analysis_reports (created_at);
    CREATE TABLE IF NOT EXISTS analysis_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insert = db.prepare(`INSERT INTO analysis_reports (id, project, from_ts, to_ts, session, model, input_tokens, output_tokens, cost, created_at, report)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const head = 'id, project, from_ts, to_ts, session, model, input_tokens, output_tokens, cost, created_at';
  // One row, as JSON: the rate and the plan, four sizes and three cut points that change together and are read together.
  const readWorth = (): WorthSettings => {
    const r = prepare(db, "SELECT value FROM analysis_settings WHERE key = 'worth'").get() as { value: string } | undefined;
    const saved = r ? (JSON.parse(r.value) as Partial<WorthSettings>) : {};
    return { rate: saved.rate ?? null, plan: saved.plan ?? null, sizes: { ...DEFAULT_SIZES, ...saved.sizes }, cuts: { ...DEFAULT_CUTS, ...saved.cuts } };
  };
  return {
    add: (r) => void insert.run(r.id, r.project, r.from_ts, r.to_ts, r.session, r.model, r.input_tokens, r.output_tokens, r.cost, r.created_at, r.report),
    list: (limit = 50) => prepare(db, `SELECT ${head} FROM analysis_reports ORDER BY created_at DESC LIMIT ?`).all(limit) as Omit<ReportRow, 'report'>[],
    get: (id) => prepare(db, 'SELECT * FROM analysis_reports WHERE id = ?').get(id) as ReportRow | undefined,
    spent(since, until = Number.MAX_SAFE_INTEGER, project) {
      const r = prepare(db, `SELECT count(*) AS runs, coalesce(sum(cost), 0) AS cost FROM analysis_reports
        WHERE created_at >= ? AND created_at < ? AND (? IS NULL OR project = ?)`).get(since, until, project ?? null, project ?? null) as { runs: number; cost: number };
      return { runs: Number(r.runs), cost: Number(r.cost) };
    },
    cap() {
      const r = prepare(db, "SELECT value FROM analysis_settings WHERE key = 'cap'").get() as { value: string } | undefined;
      return r ? Number(r.value) : DEFAULT_CAP;
    },
    setCap: (usd) => void prepare(db, "INSERT INTO analysis_settings (key, value) VALUES ('cap', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(usd)),
    worth: readWorth,
    setWorth(patch) {
      const now = readWorth();
      const next: WorthSettings = {
        rate: patch.rate === undefined ? now.rate : patch.rate, plan: patch.plan === undefined ? now.plan : patch.plan, sizes: { ...now.sizes, ...patch.sizes }, cuts: { ...now.cuts, ...patch.cuts },
      };
      prepare(db, "INSERT INTO analysis_settings (key, value) VALUES ('worth', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
      return next;
    },
    close: () => db.close(),
  };
}
