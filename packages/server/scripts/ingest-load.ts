// The ingest load check (#18): one session grows to 15,000 main-agent calls through POST /ingest, in batches of 200 events (BATCH, hooks/core.ts; the plugin's 2-second flush only
// sends smaller ones sooner). A throwaway session of 5 batches runs first, so the statements, the page cache and the JIT are warm; then the long session is measured against its
// own first batch. It prints every batch's latency and fails when the median of the last 10 batches is over 2x that first batch: a writer that scans a session's, an agent's or
// a turn's rows per event gets slower as the session grows.
//
//   pnpm ingest-load                     15,000 main calls, Content off
//   pnpm ingest-load --calls <n>         another size (an integer, at least 2000)
//   pnpm ingest-load --content full      texts too: tool input and output, answers with edit claims (some backed by their turn, some not), prompts
//   pnpm ingest-load --stream            with one /stream client open, in a child process (every ingest builds the live view for it)
//
// What it guarantees: ingest at the end of a session is no more than 2x as slow as at its start, for a session shaped like the plugin's (one turn.step per API request, a
// subagent about every 35 calls, single-turn, ending in agent.complete and findings.report). What it does not: a scan that is cheap per row can still hide under 2x at this
// size (the limit is relative, not an absolute budget), and the shape is synthetic. The events come from the plugin's own `build.*`; their timestamps are set here.
// It starts the app in-process on a temp SQLite file; it never touches a live server or a backup. Not in CI: timing on a busy runner flakes.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { build, type Ctx, type Ev } from '../../mod/hooks/core.ts';
import { buildApp } from '../src/app.ts';
import { openStore } from '../src/store/store.ts';

const BATCH = 200;
const LIMIT = 2;
const TAIL = 10;
const WARM_BATCHES = 5;
const MIN_CALLS = 2_000; // below this the last-10 window overlaps the first batch and the check passes trivially
const SUB_EVERY = 35; // a subagent per this many main calls (the biggest real history: 46,000 calls, 1,301 agents)
const SUB_CALLS = 5;
const MAIN_TURN = 17; // main calls per turn

const { values } = parseArgs({ options: { calls: { type: 'string', default: '15000' }, content: { type: 'string', default: 'off' }, stream: { type: 'boolean', default: false } } });
const CALLS = Number(values.calls);
const FULL = values.content === 'full';
if (!Number.isInteger(CALLS) || CALLS < MIN_CALLS || !['off', 'full'].includes(values.content!)) {
  console.error(`usage: pnpm ingest-load [--calls <integer, at least ${MIN_CALLS}>] [--content off|full] [--stream]`);
  process.exit(2);
}

const usage = { input: 1200, output: 300, cache_read: 8000, cache_creation: 400 };
const TOOLS = ['Bash', 'Bash', 'Bash', 'Read', 'Read', 'Edit', 'Write', 'Bash', 'ToolSearch'];
const text = <T>(v: T): T | undefined => (FULL ? v : undefined);

let clock = Date.now() - CALLS * 4_000;
let seq = 0;
const ev = (e: Ev): Ev => ({ ...e, ts: (clock += 1_000) }); // build.* stamp Date.now(); a session needs a clock that moves

/** One session: a main agent with `calls` calls, and a subagent per SUB_EVERY of them. Same event kinds, in the same order, as register.tsx sends. */
function* events(session: string, calls: number): Generator<Ev> {
  const c: Ctx = { host: 'mbp', session_id: session, project: { cwd: '/work/load-project', name: 'load-project', git_remote: 'github.com/o/load-project', git_branch: 'main' } };
  let lastEdit: string | undefined;
  const step = (agentId: string | undefined, turnId: string, answer?: string, stop = 'tool_use') => ev(build.turnStep(c, { agentId, turnId }, 'claude-opus-5', usage as never, stop, answer ? { answer } : {}));
  const call = function* (agentId: string | undefined, turnId: string, i: number): Generator<Ev> {
    const id = `toolu_${seq++}`;
    const tool = TOOLS[i % TOOLS.length]!;
    const w = { agentId, turnId };
    const path = `src/f${i % 200}.ts`;
    yield step(agentId, turnId); // one turn.step per API request, tool_use_ids [] as the plugin sends
    yield ev(build.toolCall(c, w, id, tool, 120, text('{"command":"pnpm test"}'), tool === 'Bash' ? 'other' : undefined));
    const ok = i % 17 !== 0;
    yield ev(build.toolResult(c, w, {
      toolUseId: id, success: ok, ...(ok ? {} : { errorClass: 'exit_code' as never, errorShape: 'h:0badc0de' }), durationMs: 900, outputSize: 2_000, output: text('ok'),
      files: tool === 'Read' || tool === 'Edit' ? [{ path, mode: tool === 'Read' ? 'read' : 'write' }] as never : [],
    }));
    if (tool === 'Edit') lastEdit = path;
  };
  yield ev(build.sessionStart(c, 'claude-opus-5', '2.1.0', true, FULL ? 'full' : 'off'));
  let n = 0, t = 0, subs = 0;
  while (n < calls) {
    const turn = `turn-${t++}`;
    const prompt = crypto.randomUUID();
    lastEdit = undefined;
    yield ev(build.prompt(c, 40, prompt, text('go on')));
    yield ev(build.turnStart(c, { turnId: turn }, prompt));
    for (let k = 0; k < MAIN_TURN && n < calls; k++, n++) {
      if (n > 0 && n % SUB_EVERY === 0) { // main's Agent call, then the subagent: one turn, its end, its findings
        const spawn = `toolu_${seq++}`, child = `a${subs++}`, sub = `sub-turn-${child}`;
        yield step(undefined, turn);
        yield ev(build.toolCall(c, { turnId: turn }, spawn, 'Agent', 800));
        yield ev(build.agentSpawn(c, { agentId: child, toolUseId: spawn, type: 'adversarial-reviewer', description: 'review the change', model: 'claude-sonnet-5-5', promptLength: 800 }));
        yield ev(build.turnStart(c, { agentId: child, turnId: sub }));
        for (let j = 0; j < SUB_CALLS; j++) yield* call(child, sub, j + 1);
        yield step(child, sub, text(subs % 2 ? 'All 48 tests pass. I updated `src/ghost.ts`.' : 'No problems found.'), 'end_turn');
        yield ev(build.turnComplete(c, { agentId: child, turnId: sub }, 30_000, usage as never, 'answer', 400));
        yield ev(build.agentComplete(c, child, 60_000, usage as never, 400));
        yield ev(build.findingsReport(c, { agentId: child, turnId: sub }, 'feat/x', { findings: [{ id: 'R1', severity: 'minor', file: 'a.ts', fate: 'open' }] as never, dropped: 0 }));
        yield ev(build.toolResult(c, { turnId: turn }, { toolUseId: spawn, success: true, durationMs: 60_000, outputSize: 400, files: [] }));
      }
      yield* call(undefined, turn, n);
    }
    // The turn's answer: odd turns claim a write this turn made (backed), even turns one it did not (unbacked: the claims check looks for it in earlier turns).
    const claim = t % 2 && lastEdit ? `I updated \`${lastEdit}\` and typecheck is clean.` : 'I updated `src/ghost.ts` and typecheck is clean.';
    yield step(undefined, turn, text(claim), 'end_turn');
    yield ev(build.turnComplete(c, { turnId: turn }, 30_000, usage as never, 'answer', 400));
  }
}

const dir = mkdtempSync(join(tmpdir(), 'orb-ingest-load-'));
let failed = false;
let reader: ReturnType<typeof spawn> | undefined;
const store = openStore(join(dir, 'history.db'));
const app = buildApp({ store, token: 'load' });
try {
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  if (values.stream) { // a client in its own process, so its reading does not share this event loop; it says "up" at the first byte, then discards the rest
    reader = spawn(process.execPath, ['-e', "fetch(process.argv[1]+'/stream').then(async r=>{let up=false;for await(const c of r.body){if(!up){up=true;console.log('up')}}})", address], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((ok, no) => { reader!.stdout!.once('data', () => ok()); reader!.once('exit', () => no(new Error('the /stream client exited'))); });
  }

  let batch: Ev[] = [];
  const send = async () => {
    const start = performance.now();
    const res = await fetch(`${address}/ingest`, { method: 'POST', headers: { authorization: 'Bearer load', 'content-type': 'application/json' }, body: JSON.stringify({ events: batch }) });
    const body = (await res.json()) as { rejected?: number };
    const took = performance.now() - start;
    if (res.status !== 200 || body.rejected) throw new Error(`${res.status}, ${body.rejected ?? '?'} rejected`);
    batch = [];
    return took;
  };

  // Warm-up: a throwaway session, so the long one's first batch is not the cold start.
  let warm = 0;
  for (const e of events('warm-session', CALLS)) { batch.push(e); if (batch.length === BATCH) { await send(); if (++warm === WARM_BATCHES) break; } }
  batch = [];

  const ms: number[] = [];
  let sent = 0;
  const flush = async () => {
    const size = batch.length;
    ms.push(await send());
    sent += size;
    console.log(`batch ${String(ms.length).padStart(3)}  ${String(sent).padStart(6)} events  ${ms.at(-1)!.toFixed(0).padStart(5)} ms`);
  };
  for (const e of events('load-session', CALLS)) { batch.push(e); if (batch.length === BATCH) await flush(); }
  if (batch.length) await flush();

  const count = (t: string) => Number((store.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const first = ms[0]!;
  const last = median(ms.slice(-TAIL));
  console.log(`\n${CALLS} main calls (${count('tool_calls')} calls in all, ${count('agents')} agents, ${count('claims')} claims), ${sent} events, ${ms.length} batches, content ${values.content}, stream ${values.stream ? 'open' : 'none'}`);
  console.log(`first batch ${first.toFixed(1)} ms, median of the last ${TAIL} ${last.toFixed(1)} ms, ratio ${(last / first).toFixed(2)} (limit ${LIMIT})`);
  if (last > LIMIT * first) { console.error('FAIL: ingest slowed down as the session grew'); failed = true; } else console.log('ok');
} catch (e) {
  console.error(`FAIL: ${(e as Error).message}`);
  failed = true;
} finally {
  reader?.kill();
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
