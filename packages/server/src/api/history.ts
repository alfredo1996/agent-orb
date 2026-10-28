import { capText } from '@agent-orb/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContentStore } from '../content-store.ts';
import { all, get, type Row, type Store } from '../store/store.ts';

// GET /api/history?session=…&agent=main|<id>: one agent's timeline for the studio's drawer (§15, 2026-10-20).
// What it was asked or tasked with, each step's thinking and answer, each tool with its input and output, by time.
// The history store gives the items and their metadata; the text store (content-store.ts) fills in their text by the same ids.
// With content off the same items come back with their text fields empty: tools, timings and tokens still show. A claim item (v0.3 slice 4) is one test, build or edit
// claim in an answer, checked against the agent's own calls; a session with content off has none, and the studio says they were not checked.

const Query = z.object({ session: z.string().min(1), agent: z.string().min(1) });
const LAST = 100; // the newest items; an agent's full record stays in the store
const TEXT = 8_000; // per field in this response; the store keeps up to 32 KB
const short = (s: unknown) => (typeof s === 'string' ? capText(s, TEXT) : undefined);

export function history(app: FastifyInstance, { store, content }: { store: Store; content: ContentStore }) {
  app.get('/api/history', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'session and agent are required' });
    const { session } = q.data;
    const key = `${session}:${q.data.agent}`;
    const row = get(store, `SELECT s.content AS content, a.id, a.type, a.role, a.model, a.description, a.started_at
      FROM sessions s JOIN agents a ON a.session_id = s.id WHERE s.id = :session AND a.id = :key`, { session, key });
    if (!row) return reply.code(404).send({ error: 'no such agent in this session' });

    // The newest LAST of each kind are the newest LAST in all: each query takes only those, oldest first.
    const newest = (select: string, from: string, p: Record<string, unknown> = { key }) => all(store, `SELECT * FROM (SELECT ${select} ${from} ORDER BY x.ts DESC LIMIT ${LAST}) ORDER BY ts`, p);
    const prompts = newest('x.id AS id, x.ts AS ts, x.length AS length', 'FROM prompts x WHERE x.session_id = :session AND x.agent_id = :key', { session, key });
    const steps = newest(`x.id AS id, x.ts AS ts, x.model AS model, x.input + x.output + x.cache_read + x.cache_creation AS tokens`,
      'FROM turns t JOIN api_requests x ON x.turn_id = t.id WHERE t.agent_id = :key');
    const tools = newest('x.tool_use_id AS id, x.ts AS ts, x.tool AS tool, x.output_skipped AS output_skipped, x.success AS success, x.error_type AS error_type, x.duration_ms AS duration_ms',
      'FROM turns t JOIN tool_calls x ON x.turn_id = t.id WHERE t.agent_id = :key').map((c): Row => ({ ...c, success: c.success === null ? null : c.success === 1 }));

    // v0.3 slice 4 (#44): the claims its answers made, with the facts the check found (claims.ts); the words are cut from the answer in the text store, where `at` and `len` point.
    const claims = all(store, `SELECT kind AS claim, file, backed, why, edit_ts AS editTs, run_ts AS runTs, request_id AS request, at, len, ts FROM claims WHERE agent_id = :key ORDER BY ts DESC, n DESC LIMIT ${LAST}`, { key });

    const drop = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
    const { content: mode, ...agent } = row;
    const text = content.get([
      { node: 'agent', id: agent.id },
      ...prompts.map((p) => ({ node: 'prompt' as const, id: p.id })),
      ...steps.map((r) => ({ node: 'request' as const, id: r.id })),
      ...claims.map((c) => ({ node: 'request' as const, id: c.request })),
      ...tools.map((c) => ({ node: 'tool' as const, id: c.id })),
    ]);
    const of = (node: string, id: string) => text.get(`${node}:${id}`) ?? {};
    const task = of('agent', agent.id).prompt;
    const items = [
      ...(task ? [{ kind: 'task', ts: agent.started_at, text: short(task) }] : []),
      ...prompts.map(({ id, ...p }) => ({ kind: 'prompt', ...p, text: short(of('prompt', id).text) })),
      ...steps.map(({ id, ...r }) => ({ kind: 'step', ...r, answer: short(of('request', id).answer), thinking: short(of('request', id).thinking) })),
      ...tools.map((c) => ({ kind: 'tool', ...c, input: short(of('tool', c.id).input), output: short(of('tool', c.id).output) })),
      ...claims.map(({ request, at, len, backed, ...c }) => ({ kind: 'claim', ...c, backed: backed === 1, phrase: of('request', request).answer?.slice(at, at + len) })),
    ]
      .map(drop)
      .sort((x: any, y: any) => (x.ts ?? 0) - (y.ts ?? 0))
      .slice(-LAST);
    return { content: mode ?? 'off', agent: drop(agent), items };
  });
}
