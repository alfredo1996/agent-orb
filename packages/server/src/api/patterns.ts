import { firstLine } from '@agent-orb/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContentStore } from '../content-store.ts';
import { all, get, type Store } from '../store/store.ts';

// Failure patterns (v0.3 slice 3, #45; PROJECT.md §6; §15, 2026-10-25): what keeps failing, over a project's whole history.
//   GET /api/patterns?project=<name>
//   { calls, failed,
//     kinds:   [{ errorClass, count, commands?: [{ commandClass, count }] }],          failed calls by kind; commands for exit_code only; both by count
//     repeats: [{ shape, tool, errorClass, commandClass | null, count, sessions, lastAt, sample: string | null }],
//     testsEditedAfterFailure: { count, sessions },
//     claims:  { sessions, checked, test|build|edit: { total, unbacked } } }                                          v0.3 slice 4 (#44): see below
// The classes, shapes and files come from the history store, which the plugin and the import fill with Content off; only `sample` reads the text store.
// `claims` (v0.3 slice 4, #44) are the test, build and edit claims in the project's final answers and reports, checked against each agent's own calls when the answer
// ended (claims.ts): `total` of a kind and how many are `unbacked`. They exist only for sessions with Content on full: `checked` is how many of the project's `sessions`
// were, so a project where it is 0 reads "not checked", never "clean". A grouped read of the claims table: it never touches the text store.
// By project name, every project row with it (a repo seen from two machines is two rows), as the goal and Worth read it.
// Everything is grouped in SQL (GROUP BY, and window functions for "the most frequent" and "the newest N of a group"): the rows that come back are the
// answer's own, never the project's calls or failures.

const Query = z.object({ project: z.string().min(1) });

const REPEAT_MIN = 3; // a failure that happened this often, with the same shape, is a repeat
const REPEATS = 10; // and the top this many go to the studio
const SAMPLE_CANDIDATES = 50; // a sample is looked for among a group's newest calls, this many
const SAMPLE_LENGTH = 120;
// ponytail: the path heuristic. A test file is in a directory called test, tests, __tests__ or e2e, or has .test. or .spec. in its name. A repo that keeps
// its tests elsewhere (spec/, a *_test.go beside the code) is missed; make it a setting if one ever matters. In plain SQL, as SQLite has no regex: the
// basename is the path minus its longest prefix that ends in '/'.
const TEST_PATH = (col: string) => {
  const base = `replace(${col}, rtrim(${col}, replace(${col}, '/', '')), '')`;
  const dir = (d: string) => `instr('/' || ${col}, '/${d}/') > 0`;
  return `(${['test', 'tests', '__tests__', 'e2e'].map(dir).join(' OR ')} OR instr(${base}, '.test.') > 0 OR instr(${base}, '.spec.') > 0)`;
};

// Every tool call of the project's sessions, the agent that made it and its session.
const CHAIN = 'JOIN turns t ON t.id = x.turn_id JOIN agents a ON a.id = t.agent_id JOIN sessions s ON s.id = a.session_id JOIN projects p ON p.id = s.project_id';
const CALLS = `FROM tool_calls x ${CHAIN} WHERE p.name = :project`;
const FAILED = `${CALLS} AND x.success = 0`;

// The most frequent value of a column in each group, the first by name among equals (a window over the counts); none when the group has no value.
const mostly = (col: string) =>
  `m_${col} AS (SELECT gkey, v FROM (SELECT gkey, ${col} AS v, row_number() OVER (PARTITION BY gkey ORDER BY count(*) DESC, ${col}) AS rn
     FROM f WHERE ${col} IS NOT NULL AND gkey IN (SELECT gkey FROM g) GROUP BY gkey, ${col}) WHERE rn = 1)`;

// A named shape is one failure whatever the tool; a hash already holds its tool, so the tool is only the key's second half, for a collision.
// g is the top groups; the top groups' newest calls (ids) are their sample's candidates.
const REPEATS_SQL = `
  WITH f AS (
    SELECT x.error_shape AS shape, x.tool AS tool, coalesce(x.error_class, 'other') AS errorClass, x.command_class AS commandClass, s.id AS session, x.ts AS ts, x.tool_use_id AS id,
           CASE WHEN substr(x.error_shape, 1, 2) = 'h:' THEN x.error_shape || char(10) || coalesce(x.tool, '') ELSE x.error_shape END AS gkey
    ${FAILED} AND x.error_shape IS NOT NULL),
  g AS (
    SELECT gkey, min(shape) AS shape, count(*) AS count, count(DISTINCT session) AS sessions, max(ts) AS lastAt FROM f
    GROUP BY gkey HAVING count(*) >= ${REPEAT_MIN} ORDER BY count DESC, sessions DESC, lastAt DESC, shape LIMIT ${REPEATS}),
  ${(['tool', 'errorClass', 'commandClass'] as const).map(mostly).join(',\n  ')},
  newest AS (
    SELECT gkey, id, row_number() OVER (PARTITION BY gkey ORDER BY ts DESC, id) AS rn FROM f WHERE gkey IN (SELECT gkey FROM g))
  SELECT g.shape AS shape, m_tool.v AS tool, m_errorClass.v AS errorClass, m_commandClass.v AS commandClass, g.count AS count, g.sessions AS sessions, g.lastAt AS lastAt,
         (SELECT json_group_array(id ORDER BY rn) FROM newest WHERE newest.gkey = g.gkey AND rn <= ${SAMPLE_CANDIDATES}) AS candidates
  FROM g JOIN m_tool USING (gkey) JOIN m_errorClass USING (gkey) LEFT JOIN m_commandClass USING (gkey)
  ORDER BY g.count DESC, g.sessions DESC, g.lastAt DESC, g.shape`;

// A write counts when the last test run of the same agent before it failed by running and exiting non-zero: a run refused or never started did not fail a test.
// The writes are found from the files (a few hundred of a project's thousands of calls), then walked up to the project to be checked; CROSS JOIN keeps that order,
// which the planner, with no statistics, would turn around to walk every call of the project first. One row per call, whatever the files it wrote.
// ponytail: order is by when a call started, so a test file written in the same message as the run counts; and a write at the very millisecond of a run
// is before it.
const TESTS_SQL = `
  WITH writes AS (
    SELECT DISTINCT t.agent_id AS agent, s.id AS session, x.tool_use_id AS id, x.ts AS ts
    FROM files_touched f CROSS JOIN tool_calls x ON x.tool_use_id = f.tool_use_id CROSS JOIN turns t ON t.id = x.turn_id CROSS JOIN agents a ON a.id = t.agent_id
      CROSS JOIN sessions s ON s.id = a.session_id CROSS JOIN projects p ON p.id = s.project_id
    WHERE f.mode = 'write' AND ${TEST_PATH('f.path')} AND p.name = :project)
  SELECT count(*) AS count, count(DISTINCT session) AS sessions FROM writes w
  WHERE (SELECT CASE WHEN r.success = 0 AND r.error_class = 'exit_code' THEN 1 ELSE 0 END FROM turns rt JOIN tool_calls r ON r.turn_id = rt.id
         WHERE rt.agent_id = w.agent AND r.command_class = 'test' AND r.ts < w.ts ORDER BY r.ts DESC LIMIT 1) = 1`;

export function patterns(app: FastifyInstance, { store, content }: { store: Store; content: ContentStore }) {
  app.get('/api/patterns', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a project', issues: q.error.issues });
    const params = { project: q.data.project };
    if (!get(store, 'SELECT 1 AS x FROM projects WHERE name = :project', params)) return reply.code(404).send({ error: 'no such project' });

    const total = all(store, `SELECT count(*) AS calls, count(*) FILTER (WHERE x.success = 0) AS failed ${CALLS}`, params)[0]!;
    // A failed call from before the classes (slice 1) has none: it reads `other`, so the kinds add up to `failed`.
    const kinds = all(store, `SELECT coalesce(x.error_class, 'other') AS errorClass, count(*) AS count ${FAILED} GROUP BY 1 ORDER BY 2 DESC, 1`, params);
    // The Bash calls that ran and exited non-zero, by the kind of command; no class: not known to be anything else.
    const commands = all(store, `SELECT coalesce(x.command_class, 'other') AS commandClass, count(*) AS count ${FAILED} AND coalesce(x.error_class, 'other') = 'exit_code' GROUP BY 1 ORDER BY 2 DESC, 1`, params);
    const repeats = all(store, REPEATS_SQL, params).map(({ candidates, ...repeat }) => ({ ...repeat, sample: sampleOf(content, JSON.parse(candidates)) }));
    const tests = all(store, TESTS_SQL, params)[0]!;
    const byKind = Object.fromEntries(
      all(store, `SELECT c.kind AS kind, count(*) AS total, count(*) FILTER (WHERE c.backed = 0) AS unbacked FROM claims c JOIN sessions s ON s.id = c.session_id
                  JOIN projects p ON p.id = s.project_id WHERE p.name = :project GROUP BY c.kind`, params).map((r) => [r.kind, { total: r.total, unbacked: r.unbacked }]));
    const seen = all(store, `SELECT count(*) AS sessions, count(*) FILTER (WHERE s.content = 'full') AS checked FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.name = :project`, params)[0]!;

    return {
      calls: total.calls,
      failed: total.failed,
      kinds: kinds.map((k) => (k.errorClass === 'exit_code' ? { ...k, commands } : k)),
      repeats,
      testsEditedAfterFailure: { count: tests.count, sessions: tests.sessions },
      claims: { sessions: seen.sessions, checked: seen.checked, ...Object.fromEntries((['test', 'build', 'edit'] as const).map((k) => [k, byKind[k] ?? { total: 0, unbacked: 0 }])) },
    };
  });
}

/** The first meaningful line of the newest of a group's calls whose output the text store holds (Content on full, masked already), cut to 120 characters. `ids` are newest first. */
function sampleOf(content: ContentStore, ids: string[]): string | null {
  const text = content.get(ids.map((id) => ({ node: 'tool' as const, id })));
  for (const id of ids) {
    const line = firstLine(text.get(`tool:${id}`)?.output ?? '');
    if (line) return line.slice(0, SAMPLE_LENGTH);
  }
  return null;
}
