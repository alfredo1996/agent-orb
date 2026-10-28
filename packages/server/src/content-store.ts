import type { Event } from '@agent-orb/shared';
import { DatabaseSync } from 'node:sqlite';
import { prepare } from './store/store.ts';

// The text store (§15, 2026-10-20). The history store (store/) keeps the topology and the properties the queries use; the captured
// text lives here, one row per node and field, keyed by the ids the history store uses. Purging a project or a
// date range is one DELETE, and the history store never carries the bulk.
// ponytail: no full-text index yet; when search is built, add an FTS5 table over `body` (built into node:sqlite).

export type ContentNode = 'prompt' | 'agent' | 'request' | 'tool';
export type ContentRow = { node: ContentNode; id: string; field: string; body: string; session_id: string; project: string; ts: number };
export type ContentStore = {
  put(rows: ContentRow[]): void;
  /** Every field of each node asked for, keyed `node:id`; nodes without text are absent. */
  get(keys: { node: ContentNode; id: string }[]): Map<string, Record<string, string>>;
  /** How many nodes carry a field, in some projects and a time range, or in one session (Slice 7: thinking with text). */
  count(node: ContentNode, field: string, where: { projects: string[]; from: number; to: number } | { session: string }): number;
  close(): void;
};

export function openContentStore(path: string): ContentStore {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS content (
      node TEXT NOT NULL, id TEXT NOT NULL, field TEXT NOT NULL, body TEXT NOT NULL,
      session_id TEXT NOT NULL, project TEXT NOT NULL, ts INTEGER NOT NULL,
      PRIMARY KEY (node, id, field)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS content_session ON content (session_id);
    CREATE INDEX IF NOT EXISTS content_project_ts ON content (project, ts);
  `);
  const upsert = db.prepare(`
    INSERT INTO content (node, id, field, body, session_id, project, ts) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (node, id, field) DO UPDATE SET body = excluded.body, ts = excluded.ts`);
  const read = db.prepare('SELECT field, body FROM content WHERE node = ? AND id = ?');
  return {
    put(rows) {
      if (!rows.length) return;
      db.exec('BEGIN');
      try {
        for (const r of rows) upsert.run(r.node, r.id, r.field, r.body, r.session_id, r.project, r.ts);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    get(keys) {
      const out = new Map<string, Record<string, string>>();
      for (const k of keys) {
        const fields = read.all(k.node, k.id) as { field: string; body: string }[];
        if (fields.length) out.set(`${k.node}:${k.id}`, Object.fromEntries(fields.map((f) => [f.field, f.body])));
      }
      return out;
    },
    count(node, field, where) {
      const r = 'session' in where
        ? prepare(db, 'SELECT count(*) AS n FROM content WHERE node = ? AND field = ? AND session_id = ?').get(node, field, where.session)
        : prepare(db, `SELECT count(*) AS n FROM content WHERE node = ? AND field = ? AND ts >= ? AND ts < ? AND project IN (${where.projects.map(() => '?').join(',') || "''"})`)
          .get(node, field, where.from, where.to, ...where.projects);
      return Number((r as { n: number }).n);
    },
    close: () => db.close(),
  };
}

// The same ids the history writer gives the nodes (store/writer.ts): Prompt by prompt_id, Agent by session:agent,
// ApiRequest by the turn.step event id, ToolCall by tool_use_id; Project by remote, else host:cwd.
const projectOf = (e: Event) => e.project.git_remote ?? `${e.host}:${e.project.cwd}`;

/** The text in a batch, one row per field; metadata-only events give none. */
export function contentRows(events: Event[]): ContentRow[] {
  const rows: ContentRow[] = [];
  const add = (e: Event, node: ContentNode, id: string, field: string, body: string | undefined) => {
    if (body) rows.push({ node, id, field, body, session_id: e.session_id, project: projectOf(e), ts: e.ts });
  };
  for (const e of events) {
    switch (e.kind) {
      case 'prompt.submit':
        add(e, 'prompt', e.prompt_id ?? e.id, 'text', e.data.text);
        break;
      case 'agent.spawn':
        add(e, 'agent', `${e.session_id}:${e.agent_id}`, 'prompt', e.data.prompt);
        break;
      case 'turn.step':
        add(e, 'request', e.id, 'answer', e.data.answer);
        add(e, 'request', e.id, 'thinking', e.data.thinking);
        break;
      case 'tool.call':
        add(e, 'tool', e.data.tool_use_id, 'input', e.data.input);
        break;
      case 'tool.result':
        add(e, 'tool', e.data.tool_use_id, 'output', e.data.output);
        break;
    }
  }
  return rows;
}
