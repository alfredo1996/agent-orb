import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, type Store } from '../store/store.ts';
import { zone } from './ledger.ts';
import { bucketSql, dayOf, localDate } from './local-time.ts';

// GET /api/trends (v0.2 slice 1; design/v0.2-measure.html): API-equivalent cost per week or day in the viewer's zone, split by who
// spent and by model family, with the tokens, the cache, the active days and the prompts that make a per-day and per-prompt figure,
// and the project's changes each compared on the days before and after: one per project and local day, however many commits (`changes` rows,
// from git) landed on it, and (slice 3) however many files a fingerprint found changed: `seen`. The studio divides.

const Query = z.object({
  from: z.coerce.number().int().nonnegative(),
  to: z.coerce.number().int().positive(),
  unit: z.enum(['week', 'day']).default('week'),
  tz: zone.default('UTC'),
  project: z.string().min(1).optional(),
}).refine((q) => q.to > q.from, 'to must be after from');

// Who spent. main is the session's own agent; an agent with a model of its own (a file's, or a built-in type's) is typed; the rest
// have none and ran on the main session's model. ponytail: this list is every agent type known to inherit; an unlisted type counts
// as typed. An agent whose spawn was never seen has no type at all, and counts here too.
const GENERIC_AGENTS = ['general-purpose', 'workflow-subagent'];
const GENERIC_SQL = GENERIC_AGENTS.map((a) => `'${a}'`).join(', '); // constants above, never input
const IS_MAIN = `a.type = 'main'`;
const IS_GENERIC = `(a.type IS NULL OR a.type IN (${GENERIC_SQL}))`;
const IS_TYPED = `(a.type IS NOT NULL AND a.type <> 'main' AND NOT a.type IN (${GENERIC_SQL}))`;
const cost = (when: string) => `sum(CASE WHEN ${when} THEN x.cost_usd ELSE 0 END)`;
const FAMILY = (name: string) => `instr(lower(x.model), '${name}') > 0`;

// Every request with the agent that made it, the session and the project.
const LIVE = 'FROM api_requests x JOIN turns t ON t.id = x.turn_id JOIN agents a ON a.id = t.agent_id JOIN sessions s ON s.id = a.session_id';

type Side = { days: number; cost: number; generic: number; typed: number; opus: number };
type Day = { project: string; day: string; cost: number; generic: number; typed: number; opus: number };
type Commit = { sha: string; ts: number; subject: string | null; files: string[] };
// A file the plugin's fingerprints found changed (or gone) that no commit explains: `deleted` when it went missing.
type Seen = { path: string; scope: string; ts: number; deleted: boolean };
// A row of `changes` as the walk reads it: the arrays parsed, and the local day of its time.
type Entry = { project: string; source: string; sha: string; ts: number; subject: string | null; scope: string; files: string[]; hashes: string[]; day: string };

// Calendar arithmetic on 'YYYY-MM-DD' strings: the zone's own dates come from SQL (local-time.ts), so only whole days are added here.
const addDays = (day: string, n: number) => {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const side = (days: Day[], project: string, from: string, to: string): Side | null => {
  const hit = days.filter((d) => d.project === project && d.day >= from && d.day < to); // one row per active day
  return hit.length ? { days: hit.length, cost: sum(hit, 'cost'), generic: sum(hit, 'generic'), typed: sum(hit, 'typed'), opus: sum(hit, 'opus') } : null;
};
const sum = (rows: Day[], key: 'cost' | 'generic' | 'typed' | 'opus') => rows.reduce((t, r) => t + r[key], 0);

export function trends(app: FastifyInstance, { store }: { store: Store }) {
  app.get('/api/trends', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid query', issues: q.error.issues });
    const { from, to, unit, tz, project = null } = q.data;
    const params = project ? { from, to, project } : { from, to };
    const day = localDate(tz, from, to, 'x.ts');
    const bucket = bucketSql(unit, day);

    const spent = all(store, `SELECT ${bucket} AS bucket,
        ${cost(IS_MAIN)} AS main, ${cost(IS_TYPED)} AS typed, ${cost(IS_GENERIC)} AS generic,
        ${cost(FAMILY('opus'))} AS opus, ${cost(FAMILY('sonnet'))} AS sonnet, ${cost(FAMILY('haiku'))} AS haiku,
        ${cost(`NOT (${FAMILY('opus')} OR ${FAMILY('sonnet')} OR ${FAMILY('haiku')})`)} AS other,
        sum(x.input + x.output + x.cache_read + x.cache_creation) AS tokens, sum(x.cache_read) AS cacheRead,
        sum(x.input + x.cache_read + x.cache_creation) AS inputSide,
        count(DISTINCT ${day}) AS activeDays, count(*) FILTER (WHERE x.cost_usd IS NULL) > 0 AS costPartial
      ${LIVE} JOIN projects p ON p.id = s.project_id
      WHERE x.ts >= :from AND x.ts < :to${project ? ' AND p.name = :project' : ''} GROUP BY 1 ORDER BY 1`, params);
    const prompts = all(store, `SELECT ${bucket} AS bucket, count(*) AS prompts
      FROM prompts x JOIN sessions s ON s.id = x.session_id JOIN projects p ON p.id = s.project_id
      WHERE x.ts >= :from AND x.ts < :to${project ? ' AND p.name = :project' : ''} GROUP BY 1`, params);
    // A fingerprint's entry is dropped when git explains it: some commit of the project, in the window or not, made that path that very blob (a deletion is the
    // all-zero blob there, 'deleted' in a fingerprint). Decided here, in the query, so the order things arrive in does not matter and no commit's files are read out.
    const changes = all(store, `SELECT c.project_id AS project, c.source, c.sha, c.ts, c.subject, c.files, c.hashes, c.scope
      FROM changes c JOIN projects p ON p.id = c.project_id
      WHERE c.ts >= :from AND c.ts < :to${project ? ' AND p.name = :project' : ''}
        AND NOT (c.source = 'fingerprint' AND EXISTS (
          SELECT 1 FROM changes g, json_each(g.files) f, json_each(g.hashes) h
          WHERE g.project_id = c.project_id AND g.source = 'git' AND h.key = f.key AND f.value = json_extract(c.files, '$[0]')
            AND CASE WHEN h.value NOT GLOB '*[^0]*' THEN 'deleted' ELSE h.value END = json_extract(c.hashes, '$[0]')))
      ORDER BY c.ts, c.id`, params).map((c): Entry => ({ project: c.project, source: c.source, sha: c.sha, ts: c.ts, subject: c.subject, scope: c.scope,
      files: JSON.parse(c.files), hashes: c.hashes ? JSON.parse(c.hashes) : [], day: dayOf(tz, c.ts) }));

    const buckets = new Map<string, Record<string, any>>();
    const empty = { main: 0, typed: 0, generic: 0, opus: 0, sonnet: 0, haiku: 0, other: 0, tokens: 0, cacheRead: 0, inputSide: 0, activeDays: 0, prompts: 0, costPartial: false };
    for (const b of spent) buckets.set(b.bucket, { ...empty, ...b, costPartial: Boolean(b.costPartial) });
    for (const p of prompts) buckets.set(p.bucket, { ...empty, ...buckets.get(p.bucket), bucket: p.bucket, prompts: p.prompts });

    // A change's days: its local day and the 7 before. Every request from the earliest of those to `to`, one row per project and
    // local day, is enough to total any window. The first bound is in UTC and 15 hours early, past any zone's offset; the rows
    // are then cut by their local date.
    let days: Day[] = [];
    if (changes.length) {
      const first = addDays(changes.map((c) => c.day).sort()[0]!, -7);
      const lo = Date.parse(`${first}T00:00:00Z`) - 15 * 3_600_000;
      days = all(store, `SELECT s.project_id AS project, ${localDate(tz, lo, to, 'x.ts')} AS day, coalesce(sum(x.cost_usd), 0) AS cost,
          ${cost(IS_GENERIC)} AS generic, ${cost(IS_TYPED)} AS typed, ${cost(FAMILY('opus'))} AS opus
        ${LIVE} WHERE x.ts >= :lo AND x.ts < :to AND s.project_id IN (SELECT value FROM json_each(:projects)) GROUP BY 1, 2`,
      { lo, to, projects: JSON.stringify([...new Set(changes.map((c) => c.project))]) }) as Day[];
    }

    // One change per project and local day. The rows come by time, so a group's first row is its first commit or entry and the groups are by time too.
    const groups = new Map<string, { project: string; day: string; ts: number; commits: Commit[]; seen: Seen[] }>();
    for (const { project: p, day, source, sha, ts, subject, files, hashes, scope } of changes) {
      const key = `${p}:${day}`;
      if (!groups.has(key)) groups.set(key, { project: p, day, ts, commits: [], seen: [] });
      const group = groups.get(key)!;
      if (source === 'fingerprint') group.seen.push({ path: files[0]!, scope, ts, deleted: hashes[0] === 'deleted' });
      else group.commits.push({ sha, ts, subject: subject ?? null, files });
    }

    return {
      buckets: [...buckets.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1)),
      changes: [...groups.entries()].map(([id, { project: p, day, ts, commits, seen }]) => ({
        id, day, ts, commits, seen,
        files: [...new Set([...commits.flatMap((c) => c.files), ...seen.map((s) => s.path)])],
        before: side(days, p, addDays(day, -7), day),
        after: side(days, p, day, addDays(day, 7)), // `to` already cuts the rows
      })),
    };
  });
}
