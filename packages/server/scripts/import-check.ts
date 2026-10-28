// The import's memory check (#86): a session of 200,000 events (a main file and subagent files) imported by the CLI, as the image runs it, under `time`. It fails if the
// process peaked above 150 MB of RSS, if the import wrote fewer events than the session holds, or if its tables do not hold what was generated. Today's reader, which kept
// a whole session before it wrote a batch, peaks at several times that.
//
//   node packages/server/scripts/import-check.ts                    200,000 events
//   node packages/server/scripts/import-check.ts --events 1000000   a bigger session: the peak must not move with it
//   node packages/server/scripts/import-check.ts --keep             leave the generated logs and the history in place and say where
//
// Needs `time` that reports the peak: /usr/bin/time -l (macOS) or -v (GNU). Alpine's has neither: run it on the host, or install `time`.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

const LIMIT_MB = 150;
const MB = 1_048_576;
const { values } = parseArgs({ options: { events: { type: 'string', default: '200000' }, keep: { type: 'boolean', default: false } } });
const target = Number(values.events);
if (!(target >= 1000)) throw new Error('--events must be at least 1000');

// A round is what Claude Code logs for one tool call: an assistant message (two lines: its text block and its tool_use block, each repeating the usage) and the user
// line that answers it. The import writes three events for it: a step, a call and a result. Every tenth round fails, as a tool does.
const ROUNDS = Math.ceil(target / 3);
const SUBAGENTS = 24;
const SUB_ROUNDS = Math.floor((ROUNDS * 0.3) / SUBAGENTS); // the subagents do 30% of the work, the main agent the rest
const MAIN_ROUNDS = ROUNDS - SUB_ROUNDS * SUBAGENTS;
const PROMPT_EVERY = 100; // rounds per typed prompt, in the main file

const SESSION = 'check-0000-session';
const CWD = '/work/check';
const T0 = Date.parse('2026-10-20T06:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const pad = 'x'.repeat(180); // what a tool prints: only its length is kept

const dir = mkdtempSync(join(tmpdir(), 'orb-import-check-'));
process.on('exit', () => !values.keep && rmSync(dir, { recursive: true, force: true })); // the logs are 110 MB: gone on any exit
const logs = join(dir, 'logs');
const data = join(dir, 'data');
const project = join(logs, '-work-check');
mkdirSync(join(project, SESSION, 'subagents'), { recursive: true });
mkdirSync(data);

const line = (o: object) => JSON.stringify(o) + '\n';
const common = (n: number, ms: number, extra: object = {}) => ({ uuid: `u-${n}`, parentUuid: `u-${n - 1}`, sessionId: SESSION, timestamp: iso(ms), cwd: CWD, version: '2.1.304', gitBranch: 'main', isSidechain: false, ...extra });
const usage = (n: number) => ({ input_tokens: 10 + (n % 7), output_tokens: 100 + (n % 50), cache_read_input_tokens: 5000 + n, cache_creation_input_tokens: n % 3 ? 0 : 200 });

/** One file's lines: `rounds` rounds from `t0`, one second apart, a prompt every PROMPT_EVERY rounds in the main file, the task alone in a subagent's. */
function* file(tag: string, rounds: number, t0: number, agent?: string) {
  const extra = agent ? { agentId: agent, isSidechain: true } : {};
  let n = 0;
  yield line({ type: 'user', ...common(++n, t0, extra), ...(agent ? {} : { promptId: `${tag}-p0` }), message: { role: 'user', content: agent ? 'the task' : 'a prompt' } });
  for (let r = 0; r < rounds; r++) {
    const ms = t0 + (r + 1) * 1000;
    if (!agent && r > 0 && r % PROMPT_EVERY === 0) yield line({ type: 'user', ...common(++n, ms, extra), promptId: `${tag}-p${r}`, message: { role: 'user', content: 'a prompt' } });
    const id = `msg_${tag}_${r}`;
    const message = { id, model: 'claude-opus-5-5', role: 'assistant', usage: usage(r) };
    yield line({ type: 'assistant', ...common(++n, ms, extra), message: { ...message, stop_reason: null, content: [{ type: 'text', text: `step ${r} ${pad}` }] } });
    yield line({ type: 'assistant', ...common(++n, ms + 200, extra), message: { ...message, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${tag}_${r}`, name: 'Bash', input: { command: `echo ${r}` } }] } });
    yield line({ type: 'user', ...common(++n, ms + 700, extra), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${tag}_${r}`, content: `ok ${r} ${pad}`, ...(r % 10 === 9 ? { is_error: true } : {}) }] } });
  }
}
const write = (path: string, lines: Iterable<string>) => {
  const fd = openSync(path, 'w');
  let chunk = '';
  for (const l of lines) {
    chunk += l;
    if (chunk.length > MB) writeSync(fd, chunk), (chunk = '');
  }
  writeSync(fd, chunk);
  closeSync(fd);
};

write(join(project, `${SESSION}.jsonl`), file('main', MAIN_ROUNDS, T0));
for (let a = 0; a < SUBAGENTS; a++) {
  const id = `a${String(a).padStart(2, '0')}`;
  write(join(project, SESSION, 'subagents', `agent-${id}.jsonl`), file(id, SUB_ROUNDS, T0 + 60_000 + a * 7000, id));
  writeFileSync(join(project, SESSION, 'subagents', `agent-${id}.meta.json`), JSON.stringify({ agentType: 'Explore', description: `agent ${id}`, toolUseId: `toolu_spawn_${id}` }));
}
const messages = MAIN_ROUNDS + SUB_ROUNDS * SUBAGENTS;
const failed = Math.floor(MAIN_ROUNDS / 10) + SUBAGENTS * Math.floor(SUB_ROUNDS / 10);

console.log(`${messages.toLocaleString('en')} rounds (${(messages * 3).toLocaleString('en')} events and a few hundred more): ${MAIN_ROUNDS.toLocaleString('en')} in the main file, ${SUB_ROUNDS.toLocaleString('en')} in each of ${SUBAGENTS} subagents`);

const cli = new URL('../src/cli.ts', import.meta.url).pathname;
const timed = process.platform === 'darwin' ? ['-l'] : ['-v'];
const run = spawnSync('/usr/bin/time', [...timed, process.execPath, cli, 'import', logs], {
  env: { ...process.env, CONTENT_DB: join(data, 'content.db'), ORB_HOST: 'check' }, encoding: 'utf8', maxBuffer: 64 * MB,
});
const peak = (() => {
  const mac = /^\s*(\d+)\s+maximum resident set size/m.exec(run.stderr);
  if (mac) return Number(mac[1]);
  const gnu = /Maximum resident set size \(kbytes\): (\d+)/.exec(run.stderr);
  return gnu ? Number(gnu[1]) * 1024 : NaN;
})();
const accepted = Number(/^([\d,]+) events new/m.exec(run.stdout)?.[1]?.replaceAll(',', ''));

const store = new DatabaseSync(join(data, 'history.db'), { readOnly: true });
const count = (sql: string) => Number((store.prepare(sql).get() as { n: number }).n);
const tables = { requests: count('SELECT count(*) AS n FROM api_requests'), calls: count('SELECT count(*) AS n FROM tool_calls'), failed: count('SELECT count(*) AS n FROM tool_calls WHERE success = 0'), agents: count('SELECT count(*) AS n FROM agents') };
store.close();

const failures = [
  ...(run.status !== 0 ? [`the import exited ${run.status}: ${run.stderr.split('\n').slice(0, 5).join(' | ')}`] : []),
  ...(Number.isNaN(peak) ? ['no peak in the output of /usr/bin/time: this check needs `time -l` (macOS) or `time -v` (GNU)'] : peak > LIMIT_MB * MB ? [`peak RSS ${Math.round(peak / MB)} MB: over ${LIMIT_MB} MB`] : []),
  ...(!(accepted >= target) ? [`${accepted} events written: the session holds ${target.toLocaleString('en')} and more`] : []),
  ...(tables.requests !== messages ? [`${tables.requests} requests in the history, ${messages} generated`] : []),
  ...(tables.calls !== messages ? [`${tables.calls} calls in the history, ${messages} generated`] : []),
  ...(tables.agents !== SUBAGENTS + 1 ? [`${tables.agents} agents in the history, ${SUBAGENTS + 1} generated`] : []),
  ...(tables.failed !== failed ? [`${tables.failed} failed calls in the history, ${failed} generated`] : []),
];
console.log(`import: ${accepted.toLocaleString('en')} events written, peak RSS ${Math.round(peak / MB)} MB (limit ${LIMIT_MB} MB), ${tables.requests.toLocaleString('en')} requests, ${tables.calls.toLocaleString('en')} calls, ${tables.agents} agents`);
console.log(failures.length ? `FAIL\n${failures.map((f) => `  ${f}`).join('\n')}` : `PASS: ${accepted.toLocaleString('en')} events from one session, peak RSS ${Math.round(peak / MB)} MB`);

if (values.keep) console.log(`kept: ${dir}`);
process.exitCode = failures.length ? 1 : 0;
