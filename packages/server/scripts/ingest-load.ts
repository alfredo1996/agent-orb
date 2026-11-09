// The ingest load check (#18): one session grows to 15,000 calls through POST /ingest, in the batches the plugin sends (BATCH = 200 events, hooks/core.ts; the plugin's
// 2-second flush only sends smaller ones sooner). It prints every batch's latency and fails when the last 10 batches' median is over 2x the first batch's: a writer that
// scans a session's rows per event gets slower as the session grows.
//
//   pnpm ingest-load                  15,000 calls (30,000 events, 150 batches)
//   pnpm ingest-load --calls <n>      another size
// It starts the app in-process on a temp SQLite file; it never touches a live server or a backup.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app.ts';
import { openStore } from '../src/store/store.ts';

const BATCH = 200;
const LIMIT = 2;
const TAIL = 10;
const { values } = parseArgs({ options: { calls: { type: 'string', default: '15000' } } });
const CALLS = Number(values.calls);

const SESSION = 'load-session';
let seq = 0;
const t0 = Date.now() - CALLS * 4_000; // the session ran for about CALLS x 4 s, ending now
let clock = t0;
const base = (agent?: string, turn?: string) => ({
  v: 1, id: crypto.randomUUID(), ts: (clock += 1_000), host: 'mbp', user_id: 'local', session_id: SESSION,
  project: { cwd: '/work/load-project', name: 'load-project', git_remote: 'github.com/o/load-project', git_branch: 'main' },
  ...(agent ? { agent_id: agent } : {}), ...(turn ? { turn_id: turn } : {}),
});
const usage = { input: 1200, output: 300, cache_read: 8000, cache_creation: 400 };
const TOOLS = ['Bash', 'Bash', 'Bash', 'Bash', 'Read', 'Read', 'Edit', 'Write', 'Bash', 'ToolSearch'];

// A main agent plus a subagent per 3,000 calls; a turn of 10 calls: turn.start, one step naming its tool_use_ids, a call and its result each, turn.complete.
function* events(): Generator<object> {
  yield { ...base(), kind: 'session.start', data: { model: 'claude-opus-5', source: 'interactive', claude_version: '2.1.0', plugin_version: '0.2.1', content: 'off' } };
  let agent: string | undefined;
  for (let call = 0, turn = 0; call < CALLS; turn++) {
    if (call % 3_000 === 0 && call > 0) {
      agent = `sub-${call}`;
      yield { ...base(agent), parent_agent_id: undefined, kind: 'agent.spawn', data: { tool_use_id: `toolu_spawn_${call}`, agent_type: 'implementer', model: 'claude-sonnet-5-5', prompt_length: 800 } };
    }
    const turnId = `turn-${turn}`;
    const n = Math.min(10, CALLS - call);
    const ids = Array.from({ length: n }, () => `toolu_${seq++}`);
    yield { ...base(agent, turnId), kind: 'turn.start', data: {} };
    yield { ...base(agent, turnId), kind: 'turn.step', data: { model: 'claude-opus-5', usage, stop_reason: 'tool_use', tool_use_ids: ids } };
    for (const [i, id] of ids.entries()) {
      const tool = TOOLS[(call + i) % TOOLS.length]!;
      yield { ...base(agent, turnId), kind: 'tool.call', data: { tool_use_id: id, tool, input_size: 120, ...(tool === 'Bash' ? { command_class: 'other' } : {}) } };
      const ok = (call + i) % 17 !== 0;
      yield { ...base(agent, turnId), kind: 'tool.result', data: { tool_use_id: id, success: ok, ...(ok ? {} : { error_class: 'exit_code', error_shape: 'h:0badc0de' }), duration_ms: 900, output_size: 2_000, files_touched: tool === 'Read' || tool === 'Edit' ? [{ path: `src/f${(call + i) % 200}.ts`, mode: tool === 'Read' ? 'read' : 'write' }] : [] } };
    }
    yield { ...base(agent, turnId), kind: 'turn.complete', data: { duration_ms: 30_000, usage_total: usage, reason: 'answer', answer_length: 400 } };
    call += n;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'orb-ingest-load-'));
const store = openStore(join(dir, 'history.db'));
const app = buildApp({ store, token: 'load' });
const address = await app.listen({ port: 0, host: '127.0.0.1' });

const ms: number[] = [];
let batch: object[] = [];
let sent = 0;
const flush = async () => {
  const start = performance.now();
  const res = await fetch(`${address}/ingest`, { method: 'POST', headers: { authorization: 'Bearer load', 'content-type': 'application/json' }, body: JSON.stringify({ events: batch }) });
  const body = (await res.json()) as { rejected?: number };
  ms.push(performance.now() - start);
  if (res.status !== 200 || body.rejected) throw new Error(`batch ${ms.length}: ${res.status}, ${body.rejected ?? '?'} rejected`);
  sent += batch.length;
  console.log(`batch ${String(ms.length).padStart(3)}  ${String(sent).padStart(6)} events  ${ms.at(-1)!.toFixed(0).padStart(5)} ms`);
  batch = [];
};
for (const e of events()) { batch.push(e); if (batch.length === BATCH) await flush(); }
if (batch.length) await flush();
await app.close();
store.close();
rmSync(dir, { recursive: true, force: true });

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const first = ms[0]!;
const last = median(ms.slice(-TAIL));
console.log(`\n${CALLS} calls, ${sent} events, ${ms.length} batches`);
console.log(`first batch ${first.toFixed(0)} ms, median of the last ${TAIL} ${last.toFixed(0)} ms, ratio ${(last / first).toFixed(2)} (limit ${LIMIT})`);
// The first batch pays for the cold start (prepared statements, the project row), so the steady start is shown too, beside the check.
console.log(`steady start (median of batches 2 to ${TAIL + 1}) ${median(ms.slice(1, TAIL + 1)).toFixed(1)} ms, ratio ${(last / median(ms.slice(1, TAIL + 1))).toFixed(2)}`);
if (last > LIMIT * first) { console.error('FAIL: ingest slowed down as the session grew'); process.exit(1); }
console.log('ok');
