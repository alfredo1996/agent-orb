import { run, type Store } from '../src/store/store.ts';

// A synthetic history for the memory soak (#90) and for the tests that need a big session: rows straight into the store's tables, in one transaction, from a
// seeded generator, so the same shape gives the same rows and the soak runs anywhere without the owner's logs.

/**
 * What the biggest real session holds (read on 2026-10-26): 1,301 agents (the main one and the 1,300 it spawned), about 46,000 calls and their ~2,100 turns,
 * 43,000 requests, sixty days from its first event to the last, and no end: it was still open, so the Pipeline's lanes drew it up to now.
 */
export const BIGGEST = { agents: 1_300, calls: 46_000, turns: 2_100, requests: 43_000, days: 60 };
export type Shape = typeof BIGGEST;

const DAY = 86_400_000;
const rng = (seed: number) => () => { // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// The tools of a real session, by share (Bash is 85% of its calls); a Monitor, a Workflow or an Agent waits for minutes or hours, the rest for seconds.
const TOOLS: [tool: string, share: number][] = [
  ['Bash', 0.85], ['Read', 0.06], ['StructuredOutput', 0.03], ['Monitor', 0.028], ['ToolSearch', 0.005], ['Workflow', 0.003], ['Write', 0.0025], ['Edit', 0.0025], ['Agent', 0.001],
];
const LONG = new Set(['Monitor', 'Workflow', 'Agent']);
const CLASSES = ['test', 'test', 'git', 'git', 'git', 'build', 'other', 'other', 'other', 'other'];
const AGENT_TYPES = ['workflow-subagent', 'workflow-subagent', 'workflow-subagent', 'workflow-subagent', 'implementer', 'adversarial-reviewer', 'Explore', 'general-purpose'];
const ROLES: Record<string, string> = { implementer: 'developer', 'adversarial-reviewer': 'reviewer', Explore: 'researcher', 'general-purpose': 'generalist' };
const MODELS = ['claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-5'];
const FAILURES: [errorClass: string, share: number][] = [['exit_code', 0.8], ['permission', 0.08], ['interrupted', 0.07], ['other', 0.05]];

export type Seeded = { project: string; session: string; agent: string; calls: number };

/**
 * Seeds `store` with one project and its big session (`shape`), plus fourteen small sessions beside it, so the lists and the windows have more than one row.
 * Everything happens before `now` (the big session's last event is minutes before it), and one call is still open, as the biggest real session's was.
 */
export function seedSyntheticSession(store: Store, { shape = BIGGEST, now = Date.now(), project = 'soak' }: { shape?: Partial<Shape>; now?: number; project?: string } = {}): Seeded {
  const big = { ...BIGGEST, ...shape };
  const rand = rng(90);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
  const weighted = <T>(list: readonly [T, number][]) => {
    let at = rand() * list.reduce((n, [, w]) => n + w, 0);
    return (list.find(([, w]) => (at -= w) < 0) ?? list[0]!)[0];
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const lognormal = (median: number, sigma: number) => Math.round(median * Math.exp(sigma * gauss()));
  const between = (a: number, b: number) => a + Math.floor(rand() * (b - a));

  const projectId = `github.com/o/${project}`;
  store.exec('BEGIN IMMEDIATE');
  run(store, 'INSERT INTO projects (id, name, git_remote) VALUES (:id, :name, :id)', { id: projectId, name: project });

  const session = (id: string, started: number, s: Omit<Shape, 'days'>, open: boolean) => {
    run(store, `INSERT INTO sessions (id, user_id, host, project_id, started_at, ended_at, model, source, content) VALUES (:id, 'local', 'mbp', :project, :started, :ended, :model, 'interactive', 'full')`,
      { id, project: projectId, started, ended: open ? null : now - 60_000, model: MODELS[0] });
    const span = now - started - 10 * 60_000; // the last event is ten minutes before now

    // The agents: the main one, then those it spawned (a tenth of them by another subagent), each started somewhere in the session.
    const agents = [`${id}:main`];
    run(store, `INSERT INTO agents (id, session_id, type, role, role_source, model, started_at) VALUES (:id, :session, 'main', 'orchestrator', 'map', :model, :started)`, { id: agents[0], session: id, model: MODELS[0], started });
    for (let i = 1; i <= s.agents; i++) {
      const type = pick(AGENT_TYPES);
      const at = started + Math.floor(rand() * span);
      agents.push(`${id}:a${i}`);
      run(store, `INSERT INTO agents (id, session_id, parent_id, type, role, role_source, description, model, started_at, ended_at) VALUES (:id, :session, :parent, :type, :role, :source, :description, :model, :at, :end)`, {
        id: agents[i], session: id, parent: rand() < 0.1 && i > 1 ? agents[between(1, i)] : agents[0], type, role: ROLES[type] ?? 'unassigned', source: ROLES[type] ? 'map' : null,
        description: rand() < 0.3 ? `task ${i}` : null, model: pick(MODELS), at, end: Math.min(now - 10 * 60_000, at + lognormal(300_000, 1.2)),
      });
    }

    // The turns: a third are the main agent's, the rest go round the others; each starts inside its agent's session and runs minutes.
    const turns: { id: string; at: number; ms: number }[] = [];
    for (let k = 0; k < s.turns; k++) {
      const agent = k < s.turns * 0.3 ? agents[0]! : agents[1 + (k % Math.max(1, s.agents))] ?? agents[0]!;
      const at = started + Math.floor(rand() * span);
      const ms = Math.min(lognormal(300_000, 1.5), now - 10 * 60_000 - at);
      turns.push({ id: `${agent}:t${k}`, at, ms });
      run(store, 'INSERT INTO turns (id, agent_id, started_at, duration_ms) VALUES (:id, :agent, :at, :ms)', { id: turns[k]!.id, agent, at, ms });
    }
    const anyTurn = () => turns[Math.floor(rand() * turns.length)]!;

    for (let i = 0; i < s.requests; i++) {
      const t = anyTurn();
      const input = between(1, 4_000);
      const output = between(50, 3_000);
      run(store, `INSERT INTO api_requests (id, turn_id, ts, model, input, output, cache_read, cache_creation, cost_usd) VALUES (:id, :turn, :ts, :model, :input, :output, :read, :creation, :cost)`, {
        id: `${id}:r${i}`, turn: t.id, ts: t.at + Math.floor(rand() * t.ms), model: pick(MODELS), input, output, read: between(0, 120_000), creation: between(0, 8_000), cost: Math.round((input * 15 + output * 75) / 10) / 100_000,
      });
    }

    // The calls: heavy-tailed, so most are over in seconds and a few hold a lane for hours; ~2.4% fail, a third of those with a shape that recurs.
    for (let i = 0; i < s.calls; i++) {
      const t = anyTurn();
      const tool = weighted(TOOLS);
      const ts = t.at + Math.floor(rand() * t.ms);
      const last = open && i === s.calls - 1; // still waiting: no result yet
      const ms = Math.min(LONG.has(tool) ? between(300_000, 6 * 3_600_000) : lognormal(3_000, 1.6), now - ts);
      const failed = !last && rand() < 0.024;
      const toolUse = `${id}:u${i}`;
      const read = tool === 'Read' || tool === 'Edit' || tool === 'Write';
      run(store, `INSERT INTO tool_calls (tool_use_id, turn_id, tool, ts, input_size, command_class, success, error_type, error_class, error_shape, duration_ms, output_size, waited)
        VALUES (:id, :turn, :tool, :ts, :input_size, :class, :success, :error_type, :error_class, :shape, :ms, :output_size, :waited)`, {
        id: toolUse, turn: t.id, tool, ts, input_size: between(10, 2_000), class: tool === 'Bash' ? pick(CLASSES) : null, success: last ? null : failed ? 0 : 1,
        error_type: failed ? 'Error' : null, error_class: failed ? weighted(FAILURES) : null, shape: failed ? (rand() < 0.33 ? `h:${between(0, 25).toString(16)}` : 'exit_code:1') : null,
        ms: last ? null : ms, output_size: last ? null : between(0, 40_000), waited: !last && rand() < 0.01 ? 1 : 0,
      });
      if (read) run(store, 'INSERT OR IGNORE INTO files_touched (tool_use_id, path, mode, project_id) VALUES (:id, :path, :mode, :project)', {
        id: toolUse, path: `src/${pick(['api', 'store', 'util'])}/file${between(0, 300)}${rand() < 0.2 ? '.test' : ''}.ts`, mode: tool === 'Read' ? 'read' : 'write', project: projectId,
      });
      if (rand() < 0.01) run(store, `INSERT INTO skill_loads (id, session_id, turn_id, tool_use_id, skill, ts, how, source) VALUES (:id, :session, :turn, :tool, :skill, :ts, 'tool', 'projectSettings')`, {
        id: `${id}:s${i}`, session: id, turn: t.id, tool: toolUse, skill: `skill-${between(0, 6)}`, ts,
      });
    }
    for (let i = 0; i < Math.round(s.turns * 1.4); i++) run(store, 'INSERT INTO prompts (id, session_id, agent_id, ts, length) VALUES (:id, :session, :agent, :ts, :length)', {
      id: `${id}:p${i}`, session: id, agent: agents[0], ts: started + Math.floor(rand() * span), length: between(5, 2_000),
    });
    for (let i = 0; i < 6; i++) run(store, 'INSERT OR IGNORE INTO session_skill_defs (session_id, def_id) VALUES (:session, :def)', { session: id, def: `${project}|skill|projectSettings|skill-${i}` });
  };

  for (let i = 0; i < 6; i++) run(store, `INSERT OR IGNORE INTO skill_defs (id, name, kind, source, tokens, description) VALUES (:id, :name, 'skill', 'projectSettings', :tokens, :name)`, { id: `${project}|skill|projectSettings|skill-${i}`, name: `skill-${i}`, tokens: between(100, 3_000) });
  const t0 = now - big.days * DAY;
  session('soak-big', t0, big, true);
  for (let i = 0; i < 14; i++) session(`soak-${i}`, now - (i + 1) * 2 * DAY, { agents: 3, turns: 8, calls: 120, requests: 90 }, false);

  for (let i = 0; i < 300; i++) run(store, `INSERT INTO changes (id, project_id, sha, ts, subject, files, hashes, scope, source) VALUES (:id, :project, :sha, :ts, :subject, :files, NULL, NULL, 'git')`, {
    id: `${projectId}:c${i}`, project: projectId, sha: `c${i}`, ts: between(t0, now), subject: `change ${i}`, files: JSON.stringify([`src/api/file${between(0, 300)}.ts`]),
  });
  for (let i = 1; i <= 40; i++) {
    run(store, 'INSERT INTO pull_requests (id, project_id, number, title, merged_at, additions, deletions, head, size) VALUES (:id, :project, :n, :title, :at, :add, :del, :head, :size)', {
      id: `${projectId}:${i}`, project: projectId, n: i, title: `pr ${i}`, at: between(t0, now), add: between(1, 900), del: between(0, 400), head: `fix/${i}`, size: pick(['S', 'M', 'L', null]),
    });
    run(store, 'INSERT INTO session_prs (session_id, pr_id) VALUES (:session, :pr)', { session: i % 3 === 0 ? 'soak-big' : `soak-${i % 14}`, pr: `${projectId}:${i}` });
  }
  store.exec('COMMIT');
  return { project, session: 'soak-big', agent: 'main', calls: big.calls + 14 * 120 };
}
