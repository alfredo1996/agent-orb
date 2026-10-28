import type { Event } from '@agent-orb/shared';
import { closeSync, openSync, readSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { costUsd } from './cost.ts';
import { all, get, historyPath, openStore, run, type Store } from './store/store.ts';
import { writeEvents } from './store/writer.ts';
import { openSession, projectPath, type Meta, type Where } from './transcripts.ts';

// `import <dir>` (v0.2 slice 1, PROJECT.md §15 2026-10-24): Claude Code's own logs → the history store, by usage and metadata only.
// <dir> is a copy or a read-only mount of ~/.claude/projects: <project-dir>/<sessionId>.jsonl for the main conversation and, per
// session, <sessionId>/subagents/agent-<id>.jsonl (and subagents/workflows/<run>/agent-<id>.jsonl) with a sibling .meta.json.
// Everything else in it is ignored. Every event id is derived from the session and the line, so a second run accepts nothing.
// A session the plugin recorded while it ran keeps the plugin's record for that stretch; the logs fill in before and after (see `plugin` below).
// The stretch is the first to the last prompt, request or call the plugin itself wrote (the store keeps it, store/writer.ts), not what the store holds of the
// session: a session the import read first and the plugin resumed later is filled in up to the plugin's first event, so a re-import updates the imported part (#79).

const BATCH = 500; // §5: the writer's batch
const PROGRESS_EVERY = 25;
const MARGIN_MS = 60_000; // the plugin's stretch is widened by this each side: a log line and the plugin's event for one request are not at one millisecond

export type ProjectStats = { imported: number; filled: number; requests: number; cost: number; partial: boolean }; // filled: sessions the plugin recorded, the logs added around its stretch
export type Summary = {
  found: number; // main session files under the folder
  projects: Map<string, ProjectStats>;
  accepted: number;
  duplicates: number;
  empty: number; // sessions with no line to import
  repeated: number; // lines of messages or prompts another session of the run had counted (a resumed session's copy)
  ms: number;
};
type Options = { host?: string; log?: (line: string) => void; collect?: () => void }; // collect: asked for every 2 MB of log read and after each batch written, to take a garbage collection if it is time (see `tame`)
type Known = { id: string; name: string; git_remote?: string; cwds: string[] };
type Session = { id: string; main: string; mtime: number; subagents: string };

// A file's lines, one at a time (#86), through one buffer for the whole run: the unfinished last line moves to its front, and it doubles only for a line longer than
// itself (the longest in the big corpus is 1.1 MB). readline over a stream made a Buffer per chunk and a string per line that the collector let pile up (305 MB of
// RSS reading and dropping 1.3 GB). A line is cut at a newline byte, which is never inside a multi-byte character, so each one is decoded whole.
// The generators of one reader share its buffer: read one file to its end before the next. `collect` is called each time CHECK_EVERY bytes of lines have been read.
const CHECK_EVERY = 2 * 1024 * 1024;
export function lineReader(collect?: () => void) {
  let buf = Buffer.allocUnsafe(256 * 1024);
  let read = 0;
  return function* (path: string) {
    const fd = openSync(path, 'r');
    try {
      let start = 0;
      let end = 0;
      for (;;) {
        if (end === buf.length) {
          if (start === 0) {
            const bigger = Buffer.allocUnsafe(buf.length * 2);
            buf.copy(bigger, 0, 0, end);
            buf = bigger;
          } else {
            buf.copy(buf, 0, start, end);
            end -= start;
            start = 0;
          }
        }
        const got = readSync(fd, buf, end, buf.length - end, null);
        if (!got) break;
        const from = end;
        end += got;
        for (let nl = buf.indexOf(10, from); nl !== -1 && nl < end; nl = buf.indexOf(10, start)) {
          const length = nl - start;
          yield buf.toString('utf8', start, nl);
          start = nl + 1;
          if (collect && (read += length) >= CHECK_EVERY) {
            collect();
            read = 0;
          }
        }
      }
      if (start < end) yield buf.toString('utf8', start, end);
    } finally {
      closeSync(fd);
    }
  };
}

/** Every main file under <dir>/<project-dir>/, oldest first: the original of a resumed session is read before its copy. */
async function discover(dir: string): Promise<Session[]> {
  const found: Session[] = [];
  for (const project of await readdir(dir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const base = join(dir, project.name);
    for (const f of await readdir(base, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const id = f.name.slice(0, -'.jsonl'.length);
      found.push({ id, main: join(base, f.name), mtime: (await stat(join(base, f.name))).mtimeMs, subagents: join(base, id, 'subagents') });
    }
  }
  return found.sort((a, b) => a.mtime - b.mtime || a.id.localeCompare(b.id));
}

/** A session's subagent files: subagents/agent-<id>.jsonl and subagents/workflows/<run>/agent-<id>.jsonl, nothing else. */
async function subagentFiles(dir: string): Promise<{ path: string; agentId: string }[]> {
  const all = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return all.flatMap((rel) => {
    const parts = rel.split('/');
    const m = /^agent-(.+)\.jsonl$/.exec(parts.at(-1) ?? '');
    return m && (parts.length === 1 || (parts.length === 3 && parts[0] === 'workflows')) ? [{ path: join(dir, rel), agentId: m[1]! }] : [];
  }).sort((a, b) => a.path.localeCompare(b.path));
}

/** A subagent's agentType, description and toolUseId, from its sibling .meta.json; nothing if it is missing or not JSON. */
async function metaOf(jsonl: string): Promise<Meta> {
  try {
    const m = JSON.parse(await readFile(jsonl.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    const s = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
    return { agentType: s(m.agentType), description: s(m.description), toolUseId: s(m.toolUseId) };
  } catch {
    return {};
  }
}

function hostOf(db: Store, given?: string): string {
  if (given) return given;
  const hosts = all(db, 'SELECT DISTINCT host FROM sessions ORDER BY host').map((r) => r.host as string);
  if (hosts.length === 1) return hosts[0]!;
  throw new Error(hosts.length
    ? `The history has ${hosts.length} hosts (${hosts.join(', ')}); say which one these logs are from with ORB_HOST.`
    : 'The history has no host yet; set ORB_HOST to this machine\'s name (scutil --get LocalHostName on macOS, hostname -s elsewhere) so the sessions are filed under it.');
}

/**
 * The project of a session, from the first cwd it saw (a worktree cut back to its repository):
 * 1. a project whose cwds has the path; 2. else the one project named like the path's folder; 3. else a new one, with no remote.
 * A matched project sends its remote, so the writer files the session under it.
 * ponytail: a project with no remote is found by its id (host:cwd), so a match by name on another path files the session under a
 * second project of that name. Plugin sessions carry the remote and the cwd, and the writer then merges the two (re-home).
 */
function resolve(known: Known[], host: string, path: string): Where['project'] {
  const name = basename(path);
  const named = known.filter((p) => p.name === name);
  const hit = known.find((p) => p.cwds.includes(path)) ?? (named.length === 1 ? named[0] : undefined);
  if (hit) {
    if (!hit.cwds.includes(path)) hit.cwds.push(path);
    return { cwd: path, name: hit.name, ...(hit.git_remote ? { git_remote: hit.git_remote } : {}) };
  }
  known.push({ id: `${host}:${path}`, name, cwds: [path] });
  return { cwd: path, name };
}

export async function importDir(db: Store, dir: string, { host: given, log = () => {}, collect }: Options = {}): Promise<Summary> {
  const t0 = Date.now();
  const host = hostOf(db, given);
  const cwds = new Map<string, string[]>();
  for (const r of all(db, 'SELECT project_id, cwd FROM project_cwds ORDER BY cwd')) cwds.set(r.project_id, [...(cwds.get(r.project_id) ?? []), r.cwd]);
  const known: Known[] = all(db, 'SELECT id, name, git_remote FROM projects ORDER BY id')
    .map((r) => ({ id: r.id, name: r.name, ...(r.git_remote ? { git_remote: r.git_remote } : {}), cwds: cwds.get(r.id) ?? [] }));
  // The sessions the plugin saw itself, with the stretch it wrote: its first to its last prompt, request or call. A session the plugin has sent a start for or
  // events of, whoever wrote the rest. A session with nothing but its start has no stretch (lo is null): the logs fill all of it.
  const plugin = new Map(all(db, `
    SELECT s.id, p.name AS project, s.plugin_first AS lo, s.plugin_last AS hi FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
    WHERE s.recorded = 1 OR s.plugin_first IS NOT NULL`)
    .map((r) => [r.id as string, { project: (r.project as string | null) ?? '(unknown)', lo: r.lo as number | null, hi: r.hi as number | null }]));

  const sessions = await discover(dir);
  const summary: Summary = { found: sessions.length, projects: new Map(), accepted: 0, duplicates: 0, empty: 0, repeated: 0, ms: 0 };
  const of = (name: string) => {
    let s = summary.projects.get(name);
    if (!s) summary.projects.set(name, (s = { imported: 0, filled: 0, requests: 0, cost: 0, partial: false }));
    return s;
  };

  const lines = lineReader(collect);
  // The ids this run has counted (a resumed session's file copies lines of an older one), in a temporary table and not a Set: a Set costs 140 bytes an id, so the peak grew
  // with the history (19 MB for 133,000 messages), where a table costs the page cache, and a row takes 5 µs. It lives in the connection's temp file and goes with it.
  db.exec('CREATE TEMP TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY) WITHOUT ROWID');
  db.exec('PRAGMA temp.cache_size = -256');
  db.exec('DELETE FROM temp.seen');
  const seen = { has: (id: string) => get(db, 'SELECT 1 AS x FROM temp.seen WHERE id = :id', { id }) !== undefined, add: (id: string) => run(db, 'INSERT OR IGNORE INTO temp.seen (id) VALUES (:id)', { id }) };
  let n = 0;
  for (const session of sessions) {
    if (++n % PROGRESS_EVERY === 0) log(`… ${n} of ${sessions.length} sessions`);
    // The plugin's record wins while it ran: only what is outside its stretch is sent, and the session.start (the writer sets nothing it has).
    // A PR link (v0.3 slice 2) is sent whatever its time: it is one upsert, so the plugin's own and Claude Code's say the same thing once, and an older plugin sent none.
    // ponytail: the events go under the project resolved from the logs' cwd; a plugin session whose cwd resolves to another project than the
    // plugin filed it under stays on the project it was first filed under (a session has one). Plugin sessions carry the remote and their cwd is in the project's cwds, so it matches.
    const rec = plugin.get(session.id);
    let stats: ProjectStats | undefined;
    const batch: Event[] = [];
    const flush = () => {
      if (!batch.length) return;
      const r = writeEvents(db, batch, 'import');
      summary.accepted += r.accepted;
      summary.duplicates += r.duplicates;
      batch.length = 0;
      collect?.(); // writing a batch is most of what the process allocates
    };
    // A batch of 500 is written as soon as it is built (#86): the session's events never wait for the rest of it.
    const sink = (e: Event) => {
      if (!stats) {
        stats = of(rec?.project ?? e.project.name);
        if (rec) stats.filled++;
        else stats.imported++;
      }
      if (rec?.lo != null && e.kind !== 'session.start' && e.kind !== 'session.pr' && e.ts >= rec.lo - MARGIN_MS && e.ts <= rec.hi! + MARGIN_MS) return;
      if (e.kind === 'turn.step') {
        stats.requests++;
        const cost = costUsd(e.data.model, e.data.usage);
        if (cost === null) stats.partial = true;
        else stats.cost += cost;
      }
      batch.push(e);
      if (batch.length >= BATCH) flush();
    };
    const read = openSession(session.id, host, (cwd) => resolve(known, host, projectPath(cwd)), sink, seen); // the session's first cwd, asked once, when it is read
    await read.read('main', lines(session.main));
    for (const f of await subagentFiles(session.subagents)) await read.read('sub', lines(f.path), await metaOf(f.path), f.agentId);
    const done = read.end();
    flush();
    summary.repeated += done.duplicates;
    if (!done.events) summary.empty++; // no line to import, or no cwd to file it under
  }
  summary.ms = Date.now() - t0;
  return summary;
}

const int = (n: number) => n.toLocaleString('en-US');
const usd = (s: Pick<ProjectStats, 'cost' | 'partial'>) => `${s.partial ? '≥ ' : ''}$${s.cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One line per project (sessions imported and filled in around the plugin's record, API requests, API-equivalent cost), then the totals and the time taken. */
export function report(s: Summary): string[] {
  const rows = [...s.projects].sort((a, b) => b[1].cost - a[1].cost || a[0].localeCompare(b[0]));
  const total = rows.reduce((t, [, p]) => ({
    imported: t.imported + p.imported, filled: t.filled + p.filled, requests: t.requests + p.requests, cost: t.cost + p.cost, partial: t.partial || p.partial,
  }), { imported: 0, filled: 0, requests: 0, cost: 0, partial: false });
  const width = Math.max(5, ...rows.map(([name]) => name.length));
  const line = (name: string, p: ProjectStats) =>
    `${name.padEnd(width)}  ${int(p.imported).padStart(6)} imported  ${int(p.filled).padStart(6)} filled  ${int(p.requests).padStart(9)} requests  ${usd(p).padStart(12)}`;
  return [
    ...rows.map(([name, p]) => line(name, p)),
    line('total', total),
    `${int(s.accepted)} events new, ${int(s.duplicates)} already there · ${(s.ms / 1000).toFixed(1)} s`,
    ...(total.filled ? [`${int(total.filled)} sessions filled in around the plugin's own record: the logs added only what it had not seen.`] : []),
    ...(s.found === 0 ? ['No session logs found: expected <project folder>/<session id>.jsonl under the folder. Is ~/.claude/projects mounted at /import?'] : []),
    ...(s.empty ? [`${int(s.empty)} sessions had nothing to import.`] : []),
    ...(s.repeated ? [`${int(s.repeated)} lines repeated in resumed sessions were counted once.`] : []),
    ...(total.partial ? ['≥: some requests ran on a model with no price in pricing.json, so the cost is a lower bound.'] : []),
    'Cost is API-equivalent: what the tokens would cost at list prices, not what a plan bills.',
  ];
}

/**
 * Holds the one-off import process to the 150 MB it is asked for (#86). V8 sizes itself for speed, and two of its habits cost this process 200 MB on the big corpus.
 * Its young generation doubles up to 64 MB in the first busy second; `--semi-space-growth-factor=1` keeps it at its first size (327 MB of RSS become 143 to 171). And what a
 * line leaves behind, promoted to the old generation, is freed only by a full collection, which V8 puts off until the heap has grown by 20 MB or more, and the pages it then
 * keeps: so the reader offers a collection every 2 MB of log and the writer after each batch, and this takes it when the heap holds 8 MB more than after the last one
 * (114 to 127 MiB; 37 collections, 77 ms in all, for the whole 1.3 GB, on a live heap of 12 MB).
 * ponytail: runtime V8 flags "may do nothing", by Node's own word; this is the import's process, which ends when it does. The server's memory is #85's gate.
 */
function tame() {
  v8.setFlagsFromString('--semi-space-growth-factor=1');
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  const used = () => v8.getHeapStatistics().used_heap_size;
  let live = used();
  return () => {
    if (used() < live + 8 * 1024 * 1024) return;
    gc();
    live = used();
  };
}

/** The CLI's side: the history store from the environment (beside the text store), the import, the report. Safe beside a running server: SQLite takes turns. */
export async function runImport(dir: string, env: Record<string, string | undefined> = process.env) {
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new Error(`${dir} is not a folder: mount your Claude Code logs there (-v ~/.claude/projects:/import:ro).`);
  const collect = tame();
  const db = openStore(historyPath(env));
  // The import writes and reads nothing back, so the page caches buy it little: 1 MB for the history (the server keeps its 8) and a quarter for the ids, and a WAL kept to
  // 800 KB, took the peak from 134 to 125 MB on a generated session, in 9 s instead of 8.
  db.exec('PRAGMA cache_size = -1024');
  db.exec('PRAGMA wal_autocheckpoint = 200');
  try {
    const summary = await importDir(db, dir, { host: env.ORB_HOST, log: (l) => console.error(l), collect });
    for (const l of report(summary)) console.log(l);
  } finally {
    db.close();
  }
}
