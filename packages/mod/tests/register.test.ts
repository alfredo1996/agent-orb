import { expect, mock, test } from 'claude-code/testing'

// Engine tests (`claude plugin test packages/mod`): the test's hooks stand for the engine beneath the mod.
// PROJECT.md §14, mod row.

const T0 = Date.now()
const MIN = 60_000
const usage = { input_tokens: 2, output_tokens: 218, cache_read_input_tokens: 12_540, cache_creation_input_tokens: 22_227, model: 'claude-haiku-5-5' }

type Answer = { status: number; text?: string } | 'hang'
function world(on: any, answer: (n: number) => Answer = () => ({ status: 200 }), withStep = true, stored: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, stored)
  mock.env(on, { HOME: '/home/none' })
  const posts: any[][] = []
  const statuses: (string | undefined)[] = []
  const notes: string[] = []
  const titles: (string | undefined)[] = []
  const files: Record<string, string> = {
    '/repo/.claude/agents/implementer.md': '---\nname: implementer\norb-role: developer\n---\nDo it.',
    '/repo/.claude/skills/alpha/SKILL.md': '---\nname: alpha\n---\nRun /beta, then dispatch scout. Not /lib.',
    '/repo/.claude/skills/beta/SKILL.md': 'Say beta.',
    '/repo/.claude/agents/scout.md': '---\nname: scout\ndescription: Lists files and reports\nskills:\n  - beta\n---\nUse the beta skill, then ask alpha-tester nothing.',
  }
  // Slice 5: the skills and agents the session lists (docs/verified.md, Skills).
  const breakdown = {
    skills: { totalSkills: 3, includedSkills: 3, tokens: 72, skillFrontmatter: [
      { name: 'alpha', source: 'projectSettings', tokens: 19 }, { name: 'beta', source: 'projectSettings', tokens: 13 },
      { name: 'tool:helper', source: 'plugin', pluginName: 'tool', tokens: 40 },
    ] },
    agents: [{ agentType: 'scout', source: 'projectSettings', tokens: 15 }],
  }
  on('command.list', () => ({ value: [{ name: 'alpha', description: 'Runs beta', source: 'user' }, { name: 'help', description: 'Help', source: 'builtin' }] }))
  on('session.id', () => ({ value: 's-1' }))
  on('session.version', () => ({ value: { version: '2.1.299', base: '2.1.299', builtAt: '' } }))
  const repo = { remote: 'git@github.com:o/r.git' as string | null } // v0.3 slice 2: a test may take the remote away
  on('session.repo', () => ({ value: { root: '/repo', remote: repo.remote, internal: false, name: 'r' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', (_$: any, e: any) => ({ value: { startedAt: T0, context: { window: 1_000_000, percent: 12, ...(e?.breakdown ? { breakdown } : {}) }, rateLimits: [] } }))
  // v0.2 slice 1: `git log --all --reverse --raw` over the watched places answers `git.log` (a test sets it before the session starts), or never answers.
  const git = { log: '', exitCode: 0, hang: false, calls: [] as string[][] }
  // v0.2 slice 3: `git -C <cwd> rev-parse --show-toplevel` answers the session's own working tree (a test points it at a worktree), and
  // `git -C <dir> branch --show-current` answers per directory (the main checkout and a worktree are on different branches).
  const tree = { toplevel: '/repo', exitCode: 0, branches: {} as Record<string, string>, calls: [] as string[][] }
  // v0.2 slice 3: `git hash-object --stdin-paths` answers one blob id per path on stdin (a stand-in for git's: a function of the file's text).
  const hash = { calls: [] as { argv: readonly string[]; cwd?: string; stdin?: string }[], exitCode: 0, hang: false }
  // v0.3 slice 2 (#42): `gh pr list --state merged ...` answers `gh.out` (a test sets it before the session starts), exits with `gh.exitCode`, never
  // answers (`hang`), or is not installed (`missing`: the call rejects).
  const gh = { out: '', exitCode: 0, hang: false, missing: false, calls: [] as { argv: readonly string[]; cwd?: string }[] }
  // #107: `uname -s` names the platform and `scutil --get LocalHostName` the Mac's own name; `hostname -s` ('mbp') is the network's. Linux by default,
  // so a test that wants a Mac sets `os` before the session starts. `scutilExit` non-zero makes scutil fail as it does when no LocalHostName is set.
  const machine = { os: 'Linux', localHostName: 'Alfredos-MacBook-Pro-4', scutilExit: 0, calls: [] as string[][] }
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'uname' || e.argv[0] === 'scutil') {
      machine.calls.push(e.argv)
      const out = e.argv[0] === 'uname' ? `${machine.os}\n` : machine.scutilExit ? '' : `${machine.localHostName}\n`
      return { value: { exitCode: e.argv[0] === 'uname' ? 0 : machine.scutilExit, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'gh') {
      gh.calls.push({ argv: e.argv, cwd: e.init?.cwd })
      if (gh.hang) return new Promise(() => {})
      if (gh.missing) return { deny: 'spawn gh ENOENT' }
      return { value: { exitCode: gh.exitCode, stdout: gh.out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const isLog = e.argv[0] === 'git' && e.argv[3] === 'log'
    if (isLog) git.calls.push(e.argv)
    if (isLog && git.hang) return new Promise(() => {})
    if (e.argv[0] === 'git' && e.argv[1] === 'hash-object') {
      hash.calls.push({ argv: e.argv, cwd: e.init?.cwd, stdin: e.init?.stdin })
      if (hash.hang) return new Promise(() => {})
      const paths = String(e.init?.stdin ?? '').split('\n').filter(Boolean)
      const stdout = hash.exitCode ? 'fatal: could not open\n' : paths.map((path) => blobOf(files[path] ?? '')).join('\n') + (paths.length ? '\n' : '')
      return { value: { exitCode: hash.exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'git' && e.argv[3] === 'rev-parse') {
      tree.calls.push(e.argv)
      return { value: { exitCode: tree.exitCode, stdout: tree.exitCode ? 'fatal: not a git repository\n' : `${tree.toplevel}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const isBranch = e.argv[0] === 'git' && e.argv[3] === 'branch'
    const stdout = isLog ? git.log : e.argv[0] === 'hostname' ? 'mbp\n' : `${isBranch ? tree.branches[e.argv[2]] ?? 'dev' : 'dev'}\n`
    return { value: { exitCode: isLog ? git.exitCode : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  // The folders `files` implies, as the engine lists them; a folder with nothing in it does not exist, and listing it rejects.
  on('fs.list', (_$: any, e: any) => {
    const entries = new Map<string, 'file' | 'dir'>()
    for (const f of Object.keys(files)) if (f.startsWith(`${e.path}/`)) entries.set(f.slice(e.path.length + 1).split('/')[0]!, f.slice(e.path.length + 1).includes('/') ? 'dir' : 'file')
    if (!entries.size) return { deny: `ENOENT: ${e.path}` }
    return { value: [...entries].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path] ?? '' }))
  on('ui.status', (_$: any, e: any) => (statuses.push(e.text), { value: undefined }))
  on('ui.notify', (_$: any, e: any) => (notes.push(e.text), titles.push(e.title), { value: { isSent: true, channel: 'test' } }))
  // v0.2 slice 3: GET /api/goal answers what `goal` says; a test sets it before or while the session runs.
  const goal = { goal: null as number | null, spent: 0, month: '2026-10', status: 200, mode: 'ok' as 'ok' | 'throw' | 'hang' | 'garbage', calls: [] as string[] }
  on('http.fetch', (_$: any, e: any) => {
    if (String(e.url).includes('/api/goal')) {
      goal.calls.push(e.url)
      if (goal.mode === 'hang') return new Promise(() => {})
      if (goal.mode === 'throw') throw new Error('connection refused')
      const text = goal.mode === 'garbage' ? '<html>a proxy answered</html>' : JSON.stringify({ project: 'r', month: goal.month, goal: goal.goal, spent: goal.spent, costPartial: false })
      return { value: { status: goal.status, ok: goal.status < 300, headers: {}, text } }
    }
    posts.push(JSON.parse(e.init.body).events)
    const a = answer(posts.length)
    return a === 'hang' ? new Promise(() => {}) : { value: { status: a.status, ok: a.status < 300, headers: {}, text: a.text ?? '{}' } }
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  if (withStep) on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage }
  })
  // v0.2 slice 2: what the engine answers to a spawn, a test sets it (the model the agent resolved to, and its id) before spawning.
  const engine = { model: 'claude-sonnet-5-5', agentId: 'a-child' }
  on('agent.spawn', () => ({ model: engine.model, agentId: engine.agentId }))
  const sent = () => posts.flat()
  return { clock, posts, sent, statuses, notes, titles, git, files, engine, hash, goal, tree, gh, repo, machine }
}

// A stand-in for a git blob id: 40 hex characters that are a function of the text.
const blobOf = (text: string) => {
  let h = 5381
  for (const ch of text) h = (h * 33 + ch.charCodeAt(0)) >>> 0
  return h.toString(16).padStart(8, '0').repeat(5)
}

const boot = async ($: any) => {
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.turn.start({ text: 'go', turnId: 't-1' })
}
const opts = { options: { token: 'tok', stallMinutes: 15 } }

test('a model request becomes a turn.step event with all four token counts', opts, async ($: any, on: any) => {
  const w = world(on)
  await boot($)
  const stream = $.turn.step({ turnId: 't-1', index: 0, model: 'claude-haiku-5-5', messageCount: 3 })
  for await (const _ of stream) { /* drain */ }
  await w.clock.advance(2_000)
  const step = w.sent().find((e) => e.kind === 'turn.step')
  expect(step.data.usage).toEqual({ input: 2, output: 218, cache_read: 12_540, cache_creation: 22_227 })
  expect(step.turn_id).toBe('t-1')
  expect(step).not.toHaveProperty('agent_id')
  expect(w.sent().find((e) => e.kind === 'session.start').project).toEqual({ cwd: '/repo', name: 'r', git_remote: 'github.com/o/r', git_branch: 'dev' })
})

// #107: on a Mac `hostname -s` is the network's name while no HostName is set (Host-009 on the owner's home network), so one Mac was several hosts.
test('#107: on a Mac the session is filed under its LocalHostName, not the network\'s name for it', opts, async ($: any, on: any) => {
  const w = world(on)
  w.machine.os = 'Darwin'
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  expect(w.sent().find((e) => e.kind === 'session.start').host).toBe('Alfredos-MacBook-Pro-4')
  expect(w.machine.calls).toContainEqual(['scutil', '--get', 'LocalHostName'])
})

test('#107: a Mac with no LocalHostName, or any other system, keeps `hostname -s`', opts, async ($: any, on: any) => {
  const w = world(on)
  w.machine.os = 'Darwin'
  w.machine.scutilExit = 1
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  expect(w.sent().find((e) => e.kind === 'session.start').host).toBe('mbp')
})

test('#107: on Linux the session is filed under `hostname -s` and scutil is never run', opts, async ($: any, on: any) => {
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  expect(w.sent().find((e) => e.kind === 'session.start').host).toBe('mbp')
  expect(w.machine.calls.filter((c) => c[0] === 'scutil')).toEqual([])
})

test('criterion A: session.start and agent.spawn are sent at once, not at the next 2-second tick', opts, async ($: any, on: any) => {
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await w.clock.settle() // no time passes
  expect(w.sent().map((e) => e.kind)).toContain('session.start')
  await $.agent.spawn({ tool_use_id: 'toolu_a', prompt: 'p', description: 'd', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
  await w.clock.settle()
  expect(w.sent().map((e) => e.kind)).toContain('agent.spawn')
})

test('a spawn links the child to its parent, with the resolved model and the declared role', opts, async ($: any, on: any) => {
  const w = world(on)
  await boot($)
  await $.agent.spawn({ tool_use_id: 'toolu_a', prompt: 'build it', description: 'Build it', subagentType: 'implementer', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
  await w.clock.advance(2_000)
  const spawn = w.sent().find((e) => e.kind === 'agent.spawn')
  expect(spawn.agent_id).toBe('a-child')
  expect(spawn).not.toHaveProperty('parent_agent_id') // main spawned it
  expect(spawn.data).toEqual({ tool_use_id: 'toolu_a', agent_type: 'implementer', description: 'Build it', model: 'claude-sonnet-5-5', prompt_length: 8, declared_role: 'developer' })
})

test('a tool running past the threshold raises stall.start, the status line and a notification; its result ends it', { ...opts, timeoutMs: 15_000 }, async ($: any, on: any) => {
  let release!: () => void
  on('tool.call', () => new Promise((resolve) => { release = () => resolve({ result: 'ok', text: 'ok' }) }))
  const w = world(on)
  await boot($)
  const call = $.tool.call({ tool: 'WebFetch', tool_use_id: 'toolu_w', url: 'https://x' })
  await w.clock.advance(14 * MIN)
  expect(w.sent().some((e) => e.kind === 'stall.start')).toBe(false)
  await w.clock.advance(2 * MIN)
  expect(w.sent().filter((e) => e.kind === 'stall.start').map((e) => e.data)).toEqual([{ tool_use_id: 'toolu_w', tool: 'WebFetch', since: expect.any(Number) }])
  expect(w.statuses.at(-1)).toMatch(/^⚠ main: WebFetch 1[56]m$/)
  expect(w.notes).toHaveLength(1)
  release()
  await call
  await w.clock.advance(2_000)
  expect(w.sent().filter((e) => e.kind === 'stall.end').map((e) => e.data.tool_use_id)).toEqual(['toolu_w'])
  expect(w.statuses.at(-1)).toMatch(/^👥 1 · /)
})

// A tool.check verdict `ask` goes to the mode's decider: a dialog, the auto-mode classifier, a host. Only the dialog is a
// person, and only it raises classic.PermissionRequest (docs/verified.md, 2026-10-21). Never answered on purpose in the
// tests below; the kit rejects the pending tool.call at teardown, which is expected.
const callBash = ($: any, id: string, agentId?: string) =>
  $.tool.call({ tool: 'Bash', tool_use_id: id, command: 'rm -rf build', ...(agentId ? { agentId } : {}) }).catch(() => {})
const request = ($: any, agent_id?: string) =>
  $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, ...(agent_id ? { agent_id } : {}) })
const dialog = (on: any) => on('classic.PermissionRequest', () => ({})) // no settings hook decides: the dialog shows
const waiting = (w: { sent: () => any[] }) => w.sent().filter((e) => e.kind === 'tool.waiting')

test('a tool held at the permission dialog is flagged waiting and never raises a stall', { ...opts, timeoutMs: 15_000 }, async ($: any, on: any) => {
  dialog(on)
  on('tool.call', () => new Promise(() => {})) // the person never answers
  const w = world(on)
  await boot($)
  callBash($, 'toolu_b')
  await w.clock.settle()
  await request($)
  await w.clock.advance(16 * MIN) // past the 15-minute threshold
  expect(waiting(w).map((e) => e.data)).toEqual([{ tool_use_id: 'toolu_b', tool: 'Bash' }])
  expect(w.sent().some((e) => e.kind === 'stall.start')).toBe(false)
  expect(w.notes).toEqual([])
})

// From 2.1.308 an ask a hook makes is a person's: the engine raises classic.PermissionRequest for it, and a test cannot play
// core's own ask that the auto-mode classifier settles. A request hook beneath stands for that: a tool.check `ask` is
// asked of nobody here, run on 2.1.304 and 2.1.308 (docs/verified.md).
test('an ask nobody is asked about is no wait: a tool.check ask alone flags nothing, and a hung tool still raises its stall', { ...opts, timeoutMs: 15_000 }, async ($: any, on: any) => {
  on('tool.check', () => ({ decision: 'ask' }))
  on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }))
  on('tool.call', () => new Promise(() => {}))
  const w = world(on)
  await boot($)
  callBash($, 'toolu_b')
  await w.clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'toolu_b' })
  await w.clock.advance(16 * MIN)
  expect(waiting(w)).toEqual([])
  expect(w.sent().filter((e) => e.kind === 'stall.start').map((e) => e.data.tool_use_id)).toEqual(['toolu_b'])
})

test('a settings hook that answers the request means no person is asked', { ...opts, timeoutMs: 15_000 }, async ($: any, on: any) => {
  on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } })) // the settings hooks beneath
  on('tool.call', () => new Promise(() => {}))
  const w = world(on)
  await boot($)
  callBash($, 'toolu_b')
  await w.clock.settle()
  await request($)
  await w.clock.advance(2_000)
  expect(waiting(w)).toEqual([])
})

test('a request flags the tool of its own agent, not a same-named tool of another', { ...opts, timeoutMs: 15_000 }, async ($: any, on: any) => {
  dialog(on)
  on('tool.call', () => new Promise(() => {}))
  const w = world(on)
  await boot($)
  callBash($, 'toolu_main')
  callBash($, 'toolu_sub', 'a-child')
  await w.clock.settle()
  await request($, 'a-child')
  await w.clock.advance(2_000)
  const [flagged, ...rest] = waiting(w)
  expect(rest).toEqual([])
  expect(flagged.data.tool_use_id).toBe('toolu_sub')
  expect(flagged.agent_id).toBe('a-child')
})

test('two dialogs for one agent flag two different tools, and a request for a tool nobody called flags nothing', { ...opts, timeoutMs: 15_000 }, async ($: any, on: any) => {
  dialog(on)
  on('tool.call', () => new Promise(() => {}))
  const w = world(on)
  await boot($)
  callBash($, 'toolu_1')
  callBash($, 'toolu_2')
  await w.clock.settle()
  await request($)
  await request($)
  await request($) // no third tool in flight
  await w.clock.advance(2_000)
  expect(waiting(w).map((e) => e.data.tool_use_id)).toEqual(['toolu_1', 'toolu_2'])
})

test('events the server does not take stay queued and are sent again; once taken they are gone', opts, async ($: any, on: any) => {
  const w = world(on, (n) => ({ status: n <= 2 ? 503 : 200 }))
  await boot($)
  await w.clock.advance(2_000) // first try: 503
  const first = w.posts[0]!.map((e: any) => e.id)
  await w.clock.advance(60_000) // backoff passes, second try 503, third 200
  expect(w.posts.length).toBeGreaterThanOrEqual(3)
  expect(w.posts[2]!.map((e: any) => e.id).slice(0, first.length)).toEqual(first) // the same events, in order
  const after = w.posts.length
  await w.clock.advance(10_000)
  expect(w.posts.length).toBe(after) // nothing left to send
})

// #114: the server takes a batch's valid events and names how many it refused in a 200; /orb counts them, as it counts a 400's.
test('a batch the server takes with some events refused is gone, and /orb says how many were refused', opts, async ($: any, on: any) => {
  // The first batch of two or more is answered "all but one refused": a count the batch's size alone could not give.
  let refused = 0
  let at = 0
  const w: any = world(on, (n) => {
    const batch = w.posts[n - 1]
    if (refused || batch.length < 2) return { status: 200 }
    refused = batch.length - 1
    at = n
    return { status: 200, text: JSON.stringify({ accepted: 1, duplicates: 0, rejected: refused }) }
  })
  await boot($)
  await w.clock.advance(2_000)
  expect(refused).toBeGreaterThan(0)
  const ui = await $.ui.mount({ plugin: 'agent-orb', surface: 'terminal', component: 'Pane', requestId: 'orb',
    props: { title: 'agent-orb', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  await w.clock.advance(2_000)
  expect((await ui.find({ type: 'Text', text: /rejected by the server/ }))!.text).toBe(`${refused} events rejected by the server (a bug: please report it)`)
  const taken = w.posts[at - 1].map((e: any) => e.id)
  expect(w.posts.slice(at).flat().map((e: any) => e.id).filter((id: string) => taken.includes(id))).toEqual([]) // taken: none is sent again
})

test('a hook never waits for the network: a tool returns while the server hangs', opts, async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  const w = world(on, () => 'hang')
  await boot($)
  await w.clock.advance(2_000) // a flush is now stuck on the server
  const r = await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r', file_path: '/repo/a.ts' })
  expect(r.text).toBe('ok')
})

test('the Task tools become task.create and, on completed or deleted, task.complete with the remembered subject', opts, async ($: any, on: any) => {
  on('tool.call', (_$: any, e: any) =>
    e.tool === 'TaskCreate' ? { result: { task: { id: '7', subject: 'Write the writer' } }, text: 'Task #7 created' }
    : { result: { success: true, taskId: e.taskId, updatedFields: ['status'], statusChange: { from: 'x', to: e.status } }, text: 'ok' })
  const w = world(on)
  await boot($)
  await $.tool.call({ tool: 'TaskCreate', tool_use_id: 'toolu_c', subject: 'Write the writer', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', tool_use_id: 'toolu_u1', taskId: '7', status: 'in_progress' })
  await $.tool.call({ tool: 'TaskUpdate', tool_use_id: 'toolu_u2', taskId: '7', status: 'completed' })
  await w.clock.advance(2_000)
  const tasks = w.sent().filter((e) => e.kind.startsWith('task.'))
  expect(tasks.map((e) => [e.kind, e.data])).toEqual([
    ['task.create', { task_id: '7', subject: 'Write the writer', status: 'pending' }],
    ['task.complete', { task_id: '7', subject: 'Write the writer', status: 'completed' }],
  ])
})

// ── Content capture (§15, 2026-10-20) ──
const TEXT_KEYS = ['text', 'prompt', 'answer', 'thinking', 'input', 'output']
const textIn = (events: any[]) => events.flatMap((e) => TEXT_KEYS.filter((k) => k in (e.data ?? {})).map((k) => `${e.kind}.${k}`))

async function busySession($: any, on: any, w: ReturnType<typeof world>) {
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('tool.call', (_$: any, e: any) => ({ result: 'r', text: e.tool === 'Read' ? 'NEO4J_PASSWORD=hunter2' : 'done ORB_TOKEN=abc123' }))
  await boot($)
  await $.prompt.submit({ text: 'fix the writer, token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', wait: false, origin: { kind: 'cli' } })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_b', command: 'echo ORB_TOKEN=abc123' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_env', file_path: '/repo/deploy/.env' })
  for await (const _ of $.turn.step({ turnId: 't-1', index: 0, model: 'claude-haiku-5-5', messageCount: 3 })) { /* drain */ }
  await $.agent.spawn({ tool_use_id: 'toolu_a', prompt: 'Find the docs', description: 'Find', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: false, fork: false })
  await w.clock.advance(2_000)
}

test('content off (the default): no text leaves the machine', opts, async ($: any, on: any) => {
  const w = world(on)
  await busySession($, on, w)
  expect(textIn(w.sent())).toEqual([])
  expect(w.sent().find((e) => e.kind === 'session.start').data.content).toBe('off')
})

test('content full: prompts, tool input and output, answers and task prompts go, masked; a .env read sends no output', { options: { token: 'tok', content: 'full' } }, async ($: any, on: any) => {
  const w = world(on)
  await busySession($, on, w)
  const sent = w.sent()
  const one = (kind: string, pred: (e: any) => boolean = () => true) => sent.find((e) => e.kind === kind && pred(e))
  expect(one('session.start').data.content).toBe('full')
  expect(one('prompt.submit').data.text).toBe('fix the writer, token [REDACTED]')
  expect(one('tool.call', (e) => e.data.tool === 'Bash').data.input).toBe('{"command":"echo ORB_TOKEN=[REDACTED]"}')
  expect(one('tool.result', (e) => e.data.tool_use_id === 'toolu_b').data.output).toBe('done ORB_TOKEN=[REDACTED]')
  const env = one('tool.result', (e) => e.data.tool_use_id === 'toolu_env').data
  expect(env.output_skipped).toBe('env-file')
  expect(env).not.toHaveProperty('output')
  expect(JSON.stringify(sent)).not.toMatch(/hunter2|abc123|ghp_aBc/)
  expect(one('agent.spawn').data.prompt).toBe('Find the docs')
  expect(one('turn.step').data).not.toHaveProperty('thinking') // the world's step streams no thinking text
})

test('an excluded project sends metadata only, and says so', { options: { token: 'tok', content: 'full', excludeProjects: 'other, o/r' } }, async ($: any, on: any) => {
  const w = world(on)
  await busySession($, on, w)
  expect(w.sent().find((e) => e.kind === 'session.start').data.content).toBe('excluded')
  expect(textIn(w.sent())).toEqual([])
})

test('thinking that arrives with text is sent with the step; the answer too', { options: { token: 'tok', content: 'full' } }, async ($: any, on: any) => {
  on('turn.step', async function* (_$: any, e: any) {
    yield { kind: 'thinking', index: 0, text: 'Check the outbox ' }
    yield { kind: 'thinking', index: 0, text: 'cap first.' }
    yield { kind: 'text', index: 1, text: 'Done.' }
    return { turnId: e.turnId, index: e.index, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage }
  })
  const w = world(on, undefined, false)
  await boot($)
  for await (const _ of $.turn.step({ turnId: 't-1', index: 0, model: 'claude-haiku-5-5', messageCount: 3 })) { /* drain */ }
  await w.clock.advance(2_000)
  const step = w.sent().find((e) => e.kind === 'turn.step')
  expect(step.data.thinking).toBe('Check the outbox cap first.')
  expect(step.data.answer).toBe('Done.')
})


test('Slice 5: the session lists its skills and agents once, with the names their files mention', opts, async ($: any, on: any) => {
  const w = world(on)
  await boot($)
  await w.clock.advance(2_000)
  const catalog = w.sent().filter((e) => e.kind === 'skills.catalog')
  expect(catalog).toHaveLength(1)
  expect(catalog[0].data.skills).toEqual([
    { name: 'alpha', source: 'projectSettings', tokens: 19, description: 'Runs beta', refs: { skills: ['beta'], agents: ['scout'] } },
    { name: 'beta', source: 'projectSettings', tokens: 13, refs: { skills: [], agents: [] } },
    { name: 'tool:helper', source: 'plugin', plugin: 'tool', tokens: 40 }, // no file the mod can read: its refs come when it runs
  ])
  expect(catalog[0].data.agents).toEqual([{ name: 'scout', source: 'projectSettings', tokens: 15, description: 'Lists files and reports', refs: { skills: ['beta'], agents: [] }, preload: ['beta'] }])
})

test('Slice 5: a typed /alpha goes with the next main turn, a Skill call with its own turn, a preload with the new subagent', opts, async ($: any, on: any) => {
  let release!: () => void
  on('tool.call', (_$: any, e: any) => e.tool === 'Skill' ? new Promise((resolve) => { release = () => resolve({ result: 'ok', text: 'ok' }) }) : { result: 'ok', text: 'ok' })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('skill.prompt', (_$: any, e: any) => ({ text: e.text }))
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await w.clock.settle() // the catalogue is in, so references can be matched
  const alpha = { skill: 'alpha', text: 'Run /beta, then dispatch scout.', frontmatter: { name: 'alpha', description: 'Runs beta' }, source: 'projectSettings', path: '/repo/.claude/skills/alpha/SKILL.md' }
  await $.prompt.submit({ text: '/alpha', wait: false, origin: { kind: 'cli' }, command: { name: 'alpha', args: '' } })
  await $.skill.prompt(alpha)
  await w.clock.settle()
  expect(w.sent().some((e) => e.kind === 'skill.load')).toBe(false) // it waits for the turn it starts
  await $.turn.start({ text: '/alpha', turnId: 't-2' })
  const call = $.tool.call({ tool: 'Skill', tool_use_id: 'toolu_s', skill: 'beta' })
  await w.clock.settle()
  await $.skill.prompt({ skill: 'beta', text: 'Say beta.', frontmatter: {}, source: 'projectSettings' })
  release()
  await call
  await $.agent.spawn({ tool_use_id: 'toolu_a', prompt: 'look', description: 'scout', subagentType: 'scout', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: false, fork: false })
  await $.turn.start({ text: 'look', turnId: 't-3', agentId: 'a-child' })
  await $.skill.prompt({ skill: 'beta', text: 'Say beta.', frontmatter: {}, source: 'projectSettings' })
  await w.clock.advance(2_000)
  const loads = w.sent().filter((e) => e.kind === 'skill.load').map((e) => ({ turn: e.turn_id, agent: e.agent_id, ...e.data }))
  expect(loads).toEqual([
    { turn: 't-2', agent: undefined, skill: 'alpha', how: 'typed', source: 'projectSettings', description: 'Runs beta', refs: { skills: ['beta'], agents: ['scout'] } },
    { turn: 't-2', agent: undefined, skill: 'beta', how: 'tool', tool_use_id: 'toolu_s', source: 'projectSettings', refs: { skills: [], agents: [] } },
    { turn: 't-3', agent: 'a-child', skill: 'beta', how: 'preload', source: 'projectSettings', refs: { skills: [], agents: [] } },
  ])
})

// ── v0.2 slice 1: the past of what a change watches, from git ──
const US = '\x1f'
const blob = (c: string) => c.repeat(40)
const raw = (from: string, to: string, path: string) => `:100644 100644 ${blob(from)} ${blob(to)} M\t${path}`
// `git log --all --reverse --raw` as git prints it: oldest first, and the last commit is a squash that repeats the first one's blobs.
const gitLog = [
  `C${US}${'b'.repeat(40)}${US}1792800000${US}feat: the agents arrive`, '', raw('1', '2', '.claude/agents/implementer.md'), '',
  `C${US}${'a'.repeat(40)}${US}1792836417${US}feat: the agents are routed`, '', raw('3', '4', '.claude/skills/code/SKILL.md'), raw('5', '6', 'CLAUDE.md'), '',
  `C${US}${'c'.repeat(40)}${US}1792900000${US}chore(release): 0.13.0`, '', raw('1', '2', '.claude/agents/implementer.md'), raw('5', '6', 'CLAUDE.md'), '',
].join('\n')
const changesSent = (w: ReturnType<typeof world>) => w.sent().filter((e) => e.kind === 'project.changes')

test('v0.2 slice 1: session start sends the project\'s last 90 days of agent, skill and CLAUDE.md changes from every ref, once', opts, async ($: any, on: any) => {
  const w = world(on)
  w.git.log = gitLog
  await boot($)
  await w.clock.advance(2_000)
  expect(w.git.calls).toEqual([['git', '-C', '/repo', 'log', '--all', '--reverse', '--since=90.days', '--format=C%x1f%H%x1f%ct%x1f%s', '--raw', '--no-abbrev', '--', '.claude/agents', '.claude/skills', 'CLAUDE.md']])
  // the release squash repeats versions already seen, so only the two commits that first carried them are sent
  // v0.2 slice 3: each file's new blob rides along, parallel to files
  expect(changesSent(w).map((e) => e.data)).toEqual([{ commits: [
    { sha: 'b'.repeat(40), ts: 1_792_800_000_000, subject: 'feat: the agents arrive', files: ['.claude/agents/implementer.md'], blobs: ['2'.repeat(40)] },
    { sha: 'a'.repeat(40), ts: 1_792_836_417_000, subject: 'feat: the agents are routed', files: ['.claude/skills/code/SKILL.md', 'CLAUDE.md'], blobs: ['4'.repeat(40), '6'.repeat(40)] },
  ] }])
  expect(changesSent(w)[0].project).toEqual({ cwd: '/repo', name: 'r', git_remote: 'github.com/o/r', git_branch: 'dev' })
})

test('v0.2 slice 1: no commits in the log sends no project.changes', opts, async ($: any, on: any) => {
  const w = world(on)
  await boot($) // an empty log
  await w.clock.advance(2_000)
  expect(changesSent(w)).toEqual([])
  expect(w.git.calls).toHaveLength(1)
})

test('v0.2 slice 1: a git that exits non-zero is no history, not an error', opts, async ($: any, on: any) => {
  const w = world(on)
  w.git.log = 'fatal: not a git repository\n'
  w.git.exitCode = 128
  await boot($)
  await w.clock.advance(2_000)
  expect(changesSent(w)).toEqual([])
  expect(w.sent().map((e) => e.kind)).toContain('session.start')
})

test('v0.2 slice 1: an excluded project sends its commits without subjects, whatever content is set to', { options: { token: 'tok', excludeProjects: 'other, o/r' } }, async ($: any, on: any) => {
  const w = world(on)
  w.git.log = gitLog
  await boot($)
  await w.clock.advance(2_000)
  const [changes] = changesSent(w)
  expect(changes.data.commits.map((c: any) => [c.sha.slice(0, 7), c.files])).toEqual([['bbbbbbb', ['.claude/agents/implementer.md']], ['aaaaaaa', ['.claude/skills/code/SKILL.md', 'CLAUDE.md']]])
  expect(JSON.stringify(w.sent())).not.toMatch(/agents are routed|agents arrive/)
})

test('v0.2 slice 1: a project that is not excluded keeps its subjects when content is off', { options: { token: 'tok', excludeProjects: 'other' } }, async ($: any, on: any) => {
  const w = world(on)
  w.git.log = gitLog
  await boot($)
  await w.clock.advance(2_000)
  expect(changesSent(w)[0].data.commits.map((c: any) => c.subject)).toEqual(['feat: the agents arrive', 'feat: the agents are routed'])
})

test('v0.2 slice 1: a git that never answers does not hold up the session', opts, async ($: any, on: any) => {
  const w = world(on)
  w.git.hang = true
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false }) // resolves although git hangs
  await w.clock.settle()
  expect(w.sent().map((e) => e.kind)).toContain('session.start')
  expect(changesSent(w)).toEqual([])
})


// ── v0.2 slice 2: the model check ──
const spawnArgs = (extra: object = {}) => ({
  tool_use_id: 'toolu_a', prompt: 'build it', description: 'Build it', subagentType: 'implementer', provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5', background: false, fork: false, ...extra,
})
const spawned = (w: ReturnType<typeof world>) => w.sent().filter((e) => e.kind === 'agent.spawn')
const IMPLEMENTER = (model: string) => `---\nname: implementer\norb-role: developer\nmodel: ${model}\n---\nDo it.`

test('model check: a file\'s model beaten by what the agent runs on is flagged in the event, once in a notification, and in the status line', opts, async ($: any, on: any) => {
  const w = world(on)
  w.files['/repo/.claude/agents/implementer.md'] = IMPLEMENTER('sonnet')
  w.engine.model = 'claude-opus-5-5' // the spawn's model override beat the file
  await boot($)
  await $.agent.spawn(spawnArgs({ model: 'opus' }))
  await w.clock.advance(2_000)
  expect(spawned(w).map((e) => e.data)).toEqual([{
    tool_use_id: 'toolu_a', agent_type: 'implementer', description: 'Build it', model: 'claude-opus-5-5', prompt_length: 8,
    declared_role: 'developer', declared_model: 'sonnet', model_check: { allowed: 'sonnet', source: 'file' },
  }])
  expect(w.notes).toEqual(['implementer runs on Opus; its file says Sonnet'])
  expect(w.titles).toEqual(['agent-orb: pricier model'])
  expect(w.statuses.at(-1)).toBe('⚠ implementer on Opus, file says Sonnet')
  await w.clock.advance(30_000)
  expect(w.notes).toHaveLength(1) // once, not at every tick
  expect(w.statuses.at(-1)).toBe('⚠ implementer on Opus, file says Sonnet')
})

test('model check: no file is held to the ceiling, Sonnet by default; a workflow agent with no file has no name', opts, async ($: any, on: any) => {
  const w = world(on)
  w.engine.model = 'claude-opus-5-5'
  await boot($)
  await $.agent.spawn(spawnArgs({ subagentType: 'general-purpose' }))
  await w.clock.advance(2_000)
  expect(spawned(w)[0].data).toMatchObject({ agent_type: 'general-purpose', model: 'claude-opus-5-5', model_check: { allowed: 'sonnet', source: 'ceiling' } })
  expect(spawned(w)[0].data).not.toHaveProperty('declared_model')
  expect(w.notes).toEqual(['general-purpose runs on Opus; agents with no file are held to Sonnet'])
  expect(w.statuses.at(-1)).toBe('⚠ general-purpose on Opus, ceiling Sonnet')

  w.engine.agentId = 'a-wf'
  await $.agent.spawn(spawnArgs({ tool_use_id: 'toolu_wf', subagentType: 'workflow-subagent', workflow: { runId: 'wf_1', agentIndex: 1 } }))
  await w.clock.advance(2_000)
  expect(w.notes[1]).toBe('a workflow agent runs on Opus; agents with no file are held to Sonnet')
  expect(w.notes).toHaveLength(2)
  expect(w.titles).toEqual(['agent-orb: pricier model', 'agent-orb: pricier model'])
  expect(w.statuses.at(-1)).toBe('⚠ general-purpose on Opus, ceiling Sonnet') // the oldest still running comes first
})

test('model check: a flagged agent that is resumed is not announced again', opts, async ($: any, on: any) => {
  const w = world(on)
  w.engine.model = 'claude-opus-5-5'
  await boot($)
  await $.agent.spawn(spawnArgs({ subagentType: 'general-purpose' }))
  await $.agent.spawn(spawnArgs({ subagentType: 'general-purpose', resume: { agentId: 'a-child' } }))
  await w.clock.advance(2_000)
  expect(spawned(w)).toHaveLength(2) // the plugin sends a spawn event per call, as it always did
  expect(w.notes).toHaveLength(1)
})

test('model check: a workflow agent whose type has a file is named by its type', opts, async ($: any, on: any) => {
  const w = world(on)
  w.files['/repo/.claude/agents/implementer.md'] = IMPLEMENTER('haiku')
  w.engine.model = 'claude-sonnet-5-5'
  await boot($)
  await $.agent.spawn(spawnArgs({ workflow: { runId: 'wf_1', agentIndex: 1 } }))
  await w.clock.settle()
  expect(w.notes).toEqual(['implementer runs on Sonnet; its file says Haiku'])
})

test('model check: a file with model: inherit is held to the ceiling, and its declared model goes as written', opts, async ($: any, on: any) => {
  const w = world(on)
  w.files['/repo/.claude/agents/planner.md'] = '---\nname: planner\nmodel: inherit\n---\nPlan.'
  w.engine.model = 'claude-opus-5-5'
  await boot($)
  await $.agent.spawn(spawnArgs({ subagentType: 'planner' }))
  await w.clock.advance(2_000)
  expect(spawned(w)[0].data).toMatchObject({ declared_model: 'inherit', model_check: { allowed: 'sonnet', source: 'ceiling' } })
  expect(w.notes).toEqual(['planner runs on Opus; agents with no file are held to Sonnet'])
})

test('model check: a file without model: is held to the ceiling too', opts, async ($: any, on: any) => {
  const w = world(on)
  w.engine.model = 'claude-opus-5-5'
  await boot($)
  await $.agent.spawn(spawnArgs()) // the world's implementer.md has an orb-role and no model
  await w.clock.advance(2_000)
  expect(spawned(w)[0].data).toMatchObject({ declared_role: 'developer', model_check: { allowed: 'sonnet', source: 'ceiling' } })
  expect(spawned(w)[0].data).not.toHaveProperty('declared_model')
})

test('model check: an agent within its limit is not flagged', opts, async ($: any, on: any) => {
  const w = world(on)
  w.files['/repo/.claude/agents/implementer.md'] = IMPLEMENTER('sonnet')
  await boot($)
  await $.agent.spawn(spawnArgs()) // the world resolves to Sonnet
  w.engine.agentId = 'a-wf'
  w.engine.model = 'claude-haiku-5-5'
  await $.agent.spawn(spawnArgs({ tool_use_id: 'toolu_g', subagentType: 'general-purpose' })) // cheaper than the ceiling
  await w.clock.advance(2_000)
  for (const spawn of spawned(w)) {
    expect(spawn.data).not.toHaveProperty('model_check')
    expect(spawn.data).not.toHaveProperty('declared_model')
  }
  expect(w.notes).toEqual([])
  expect(w.statuses.at(-1)).toMatch(/^👥 3 · /)
})

test('model check: a fork inherits whatever its parent runs on, so it is never flagged', opts, async ($: any, on: any) => {
  const w = world(on)
  w.engine.model = 'claude-opus-5-5'
  await boot($)
  await $.agent.spawn(spawnArgs({ subagentType: 'fork', fork: true }))
  await w.clock.advance(2_000)
  expect(spawned(w)).toHaveLength(1)
  expect(spawned(w)[0].data).not.toHaveProperty('model_check')
  expect(w.notes).toEqual([])
  expect(w.statuses.at(-1)).toMatch(/^👥 2 · /)
})

test('model check: the main session is never flagged, whatever it runs on', opts, async ($: any, on: any) => {
  const w = world(on) // main runs on Opus 5.5: above the Sonnet ceiling
  await boot($)
  for await (const _ of $.turn.step({ turnId: 't-1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })) { /* drain */ }
  await w.clock.advance(2_000)
  expect(JSON.stringify(w.sent())).not.toContain('model_check')
  expect(w.notes).toEqual([])
  expect(w.statuses.at(-1)).toMatch(/^👥 1 · /)
})

test('model check: a ceiling of off leaves agents with no file alone, but a file\'s model is still checked', { options: { token: 'tok', modelCeiling: 'off' } }, async ($: any, on: any) => {
  const w = world(on)
  w.files['/repo/.claude/agents/implementer.md'] = IMPLEMENTER('sonnet')
  w.engine.model = 'claude-opus-5-5'
  await boot($)
  await $.agent.spawn(spawnArgs({ subagentType: 'general-purpose' }))
  await w.clock.advance(2_000)
  expect(spawned(w)[0].data).not.toHaveProperty('model_check')
  expect(w.notes).toEqual([])
  w.engine.agentId = 'a-impl'
  await $.agent.spawn(spawnArgs({ tool_use_id: 'toolu_i' }))
  await w.clock.advance(2_000)
  expect(spawned(w)[1].data).toMatchObject({ model_check: { allowed: 'sonnet', source: 'file' } })
  expect(w.notes).toEqual(['implementer runs on Opus; its file says Sonnet'])
})

test('model check: the ceiling is the owner\'s to set', { options: { token: 'tok', modelCeiling: 'opus' } }, async ($: any, on: any) => {
  const w = world(on)
  w.engine.model = 'claude-opus-5-5'
  await boot($)
  await $.agent.spawn(spawnArgs({ subagentType: 'general-purpose' }))
  await w.clock.advance(2_000)
  expect(spawned(w)[0].data).not.toHaveProperty('model_check')
  expect(w.notes).toEqual([])
})

test('model check: a stall still comes first in the status line, and the pricier model returns when it ends', { ...opts, timeoutMs: 15_000 }, async ($: any, on: any) => {
  let release!: () => void
  on('tool.call', () => new Promise((resolve) => { release = () => resolve({ result: 'ok', text: 'ok' }) }))
  const w = world(on)
  w.files['/repo/.claude/agents/implementer.md'] = IMPLEMENTER('sonnet')
  w.engine.model = 'claude-opus-5-5'
  await boot($)
  await $.agent.spawn(spawnArgs())
  await w.clock.advance(2_000)
  expect(w.statuses.at(-1)).toBe('⚠ implementer on Opus, file says Sonnet')
  const call = $.tool.call({ tool: 'WebFetch', tool_use_id: 'toolu_w', url: 'https://x' }) // main's
  await w.clock.advance(16 * MIN)
  expect(w.statuses.at(-1)).toMatch(/^⚠ main: WebFetch 1[56]m$/)
  release()
  await call
  await w.clock.advance(2_000)
  expect(w.statuses.at(-1)).toBe('⚠ implementer on Opus, file says Sonnet')
})

test('model check: the agent\'s end clears it from the status line', opts, async ($: any, on: any) => {
  on('turn.complete', () => ({ text: 'done' }))
  const w = world(on)
  w.files['/repo/.claude/agents/implementer.md'] = IMPLEMENTER('sonnet')
  w.engine.model = 'claude-opus-5-5'
  await boot($)
  await $.agent.spawn(spawnArgs())
  await $.turn.start({ text: 'build it', turnId: 't-2', agentId: 'a-child' })
  await w.clock.advance(2_000)
  expect(w.statuses.at(-1)).toBe('⚠ implementer on Opus, file says Sonnet')
  await $.turn.complete({ turnId: 't-2', agentId: 'a-child', answer: 'done', durationMs: 1_000, isAborted: false, reason: 'answer' })
  await w.clock.advance(2_000)
  expect(w.statuses.at(-1)).toMatch(/^👥 1 · /)
})

test('model check: the /orb panel says "pricier model" in yellow once the agent works, after done, stalled and waiting', { ...opts, timeoutMs: 20_000 }, async ($: any, on: any) => {
  let release!: () => void
  on('tool.call', () => new Promise((resolve) => { release = () => resolve({ result: 'ok', text: 'ok' }) }))
  on('turn.complete', () => ({ text: 'done' }))
  const w = world(on)
  w.files['/repo/.claude/agents/implementer.md'] = IMPLEMENTER('sonnet')
  w.engine.model = 'claude-opus-5-5'
  await boot($)
  await $.agent.spawn(spawnArgs())
  await w.clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'agent-orb', surface: 'terminal', component: 'Pane', requestId: 'orb',
    props: { title: 'agent-orb', isFocused: false, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} } })
  const row = async () => (await ui.find({ type: 'Text', text: /implementer/ }))!
  const at = async (ms: number) => (await w.clock.advance(ms), row())
  expect((await row()).text).toMatch(/waiting$/) // spawned, no turn yet: it waits, and waiting comes before pricier

  await $.turn.start({ text: 'build it', turnId: 't-2', agentId: 'a-child' })
  const working = await at(2_000)
  expect(working.text).toMatch(/Opus 5\.5 .* pricier model$/)
  expect(working.props.color).toBe('yellow')

  const call = $.tool.call({ tool: 'WebFetch', tool_use_id: 'toolu_w', url: 'https://x', agentId: 'a-child' })
  const stalled = await at(16 * MIN)
  expect(stalled.text).toMatch(/⚠ stalled$/) // a stall comes before pricier
  expect(stalled.props.color).toBe('red')
  release()
  await call

  await $.turn.complete({ turnId: 't-2', agentId: 'a-child', answer: 'done', durationMs: 1_000, isAborted: false, reason: 'answer' })
  expect((await at(2_000)).text).toMatch(/done$/) // done comes before everything
})

// ── v0.2 slice 3: fingerprints of what a change watches ──
const fingerprints = (w: ReturnType<typeof world>) => w.sent().filter((e) => e.kind === 'project.fingerprint')

test('v0.2 slice 3: session start sends the project\'s agents, skills and CLAUDE.md and the owner\'s CLAUDE.md and rules, hashed by one git call', opts, async ($: any, on: any) => {
  const w = world(on)
  w.files['/repo/CLAUDE.md'] = 'project rules'
  w.files['/repo/.claude/skills/alpha/refs/deep.md'] = 'a reference'
  w.files['/repo/.claude/settings.json'] = '{}' // not watched
  w.files['/home/none/.claude/CLAUDE.md'] = 'owner rules'
  w.files['/home/none/.claude/rules/git.md'] = 'git rules'
  w.files['/home/none/.claude/rules/old/scope.md'] = 'nested: not watched'
  await boot($)
  await w.clock.advance(2_000)
  const at = (path: string, scope: string) => ({ path, scope, hash: blobOf(w.files[scope === 'user' ? path.replace('~', '/home/none') : `/repo/${path}`]!) })
  expect(fingerprints(w)).toHaveLength(1)
  expect(fingerprints(w)[0].data.files).toEqual([
    at('.claude/agents/implementer.md', 'project'), at('.claude/agents/scout.md', 'project'),
    at('.claude/skills/alpha/SKILL.md', 'project'), at('.claude/skills/alpha/refs/deep.md', 'project'), at('.claude/skills/beta/SKILL.md', 'project'),
    at('CLAUDE.md', 'project'), at('~/.claude/CLAUDE.md', 'user'), at('~/.claude/rules/git.md', 'user'),
  ])
  expect(fingerprints(w)[0].project).toEqual({ cwd: '/repo', name: 'r', git_remote: 'github.com/o/r', git_branch: 'dev' })
  // one call for all of them: absolute paths on stdin, one per line, run in the project
  expect(w.hash.calls).toEqual([{
    argv: ['git', 'hash-object', '--stdin-paths'], cwd: '/repo',
    stdin: ['/repo/.claude/agents/implementer.md', '/repo/.claude/agents/scout.md', '/repo/.claude/skills/alpha/SKILL.md', '/repo/.claude/skills/alpha/refs/deep.md',
      '/repo/.claude/skills/beta/SKILL.md', '/repo/CLAUDE.md', '/home/none/.claude/CLAUDE.md', '/home/none/.claude/rules/git.md'].join('\n') + '\n',
  }])
  expect(JSON.stringify(w.sent())).not.toMatch(/project rules|owner rules|git rules|a reference/) // a path and a hash, never the file
})

test('v0.2 slice 3: no watched file anywhere sends nothing, and the session starts all the same', opts, async ($: any, on: any) => {
  const w = world(on)
  for (const k of Object.keys(w.files)) delete w.files[k] // no .claude folder, no CLAUDE.md, no rules
  await boot($)
  await w.clock.advance(2_000)
  expect(fingerprints(w)).toEqual([])
  expect(w.hash.calls).toEqual([]) // nothing to hash
  expect(w.sent().map((e) => e.kind)).toContain('session.start')
})

test('v0.2 slice 3: a missing folder is fine: only the files there are sent', opts, async ($: any, on: any) => {
  const w = world(on)
  for (const k of Object.keys(w.files)) delete w.files[k]
  w.files['/repo/CLAUDE.md'] = 'only this'
  await boot($)
  await w.clock.advance(2_000)
  expect(fingerprints(w)[0].data.files).toEqual([{ path: 'CLAUDE.md', scope: 'project', hash: blobOf('only this') }])
})

test('v0.2 slice 3: an excluded project still sends its fingerprints, whatever content is set to: a path and a hash are not content', { options: { token: 'tok', content: 'full', excludeProjects: 'other, o/r' } }, async ($: any, on: any) => {
  const w = world(on)
  await boot($)
  await w.clock.advance(2_000)
  expect(w.sent().find((e) => e.kind === 'session.start').data.content).toBe('excluded')
  expect(fingerprints(w)).toHaveLength(1)
  expect(fingerprints(w)[0].data.files.map((f: any) => f.path)).toContain('.claude/agents/implementer.md')
  expect(JSON.stringify(fingerprints(w))).not.toMatch(/Do it\.|Say beta/)
})

test('v0.2 slice 3: a git that fails sends no fingerprint, and does not hold up anything else', opts, async ($: any, on: any) => {
  const w = world(on)
  w.hash.exitCode = 128
  await boot($)
  await w.clock.advance(2_000)
  expect(fingerprints(w)).toEqual([])
  expect(w.hash.calls).toHaveLength(1)
  expect(w.sent().map((e) => e.kind)).toContain('session.start')
})

test('v0.2 slice 3: a git that never answers does not hold up the session', opts, async ($: any, on: any) => {
  const w = world(on)
  w.hash.hang = true
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false }) // resolves although the hash call hangs
  await w.clock.settle()
  expect(w.sent().map((e) => e.kind)).toContain('session.start')
  expect(fingerprints(w)).toEqual([])
})

// ── v0.2 slice 3: a worktree session reports its own checkout ──
// `$.session.repo().root` is the main working tree's for a worktree (docs/verified.md), so the branch, the fingerprints and the paths
// have to come from `git rev-parse --show-toplevel` run in the session's cwd.
const WT = '/repo/.claude/worktrees/w'
const inWorktree = (w: ReturnType<typeof world>) => {
  w.tree.toplevel = WT
  w.tree.branches = { '/repo': 'release/0.15', [WT]: 'feat/x' } // the main checkout is on another branch
  w.files['/repo/CLAUDE.md'] = 'the main tree\'s rules'
  w.files[`${WT}/CLAUDE.md`] = 'the worktree\'s rules'
  w.files[`${WT}/.claude/agents/implementer.md`] = '---\nname: implementer\norb-role: developer\n---\nthe worktree\'s version'
}
const startIn = ($: any, cwd: string) => $.session.start({ cwd, surface: null, isInteractive: false })

test('v0.2 slice 3: a worktree session sends its checkout, and cwd stays the repository root', opts, async ($: any, on: any) => {
  const w = world(on)
  inWorktree(w)
  await startIn($, WT)
  await w.clock.advance(2_000)
  const expected = { cwd: '/repo', name: 'r', git_remote: 'github.com/o/r', git_branch: 'feat/x', checkout: WT }
  expect(w.sent().length).toBeGreaterThan(0)
  for (const e of w.sent()) expect(e.project).toEqual(expected) // every kind, the fingerprint and the changes too
  expect(w.tree.calls).toEqual([['git', '-C', WT, 'rev-parse', '--show-toplevel']])
})

test('v0.2 slice 3: a worktree session fingerprints the worktree\'s files, not the main tree\'s', opts, async ($: any, on: any) => {
  const w = world(on)
  inWorktree(w)
  await startIn($, WT)
  await w.clock.advance(2_000)
  expect(fingerprints(w)).toHaveLength(1)
  expect(fingerprints(w)[0].data.files).toEqual([
    { path: '.claude/agents/implementer.md', scope: 'project', hash: blobOf(w.files[`${WT}/.claude/agents/implementer.md`]!) },
    { path: 'CLAUDE.md', scope: 'project', hash: blobOf('the worktree\'s rules') },
  ])
  expect(w.hash.calls).toEqual([{ argv: ['git', 'hash-object', '--stdin-paths'], cwd: WT, stdin: `${WT}/.claude/agents/implementer.md\n${WT}/CLAUDE.md\n` }])
})

test('v0.2 slice 3: a file in a worktree is the same project path as in the main tree; the history still reads every ref from the root', opts, async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  const w = world(on)
  inWorktree(w)
  await startIn($, WT)
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r', file_path: `${WT}/src/a.ts` })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'toolu_e', file_path: `${WT}/CLAUDE.md` })
  await w.clock.advance(2_000)
  const touched = w.sent().filter((e) => e.kind === 'tool.result').map((e) => e.data.files_touched)
  expect(touched).toEqual([[{ path: 'src/a.ts', mode: 'read' }], [{ path: 'CLAUDE.md', mode: 'write' }]]) // not .claude/worktrees/w/src/a.ts
  expect(w.git.calls.map((c) => c.slice(0, 3))).toEqual([['git', '-C', '/repo']]) // `git log --all` reads every ref: the root's is as good as the worktree's
})

test('v0.2 slice 3: a main-tree session sends no checkout, and its files, paths and branch are as before', opts, async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  const w = world(on)
  w.files['/repo/CLAUDE.md'] = 'project rules'
  await startIn($, '/repo/src') // a subfolder of the main tree: its top level is the root
  await $.turn.start({ text: 'go', turnId: 't-1' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r', file_path: '/repo/src/a.ts' })
  await w.clock.advance(2_000)
  for (const e of w.sent()) expect(e.project).toEqual({ cwd: '/repo', name: 'r', git_remote: 'github.com/o/r', git_branch: 'dev' }) // no `checkout` key at all
  expect(w.tree.calls).toEqual([['git', '-C', '/repo/src', 'rev-parse', '--show-toplevel']])
  expect(fingerprints(w)[0].data.files.map((f: any) => f.path)).toContain('CLAUDE.md')
  expect(w.hash.calls[0]!.cwd).toBe('/repo')
  expect(w.sent().find((e) => e.kind === 'tool.result').data.files_touched).toEqual([{ path: 'src/a.ts', mode: 'read' }])
})

test('v0.2 slice 3: a git that cannot name the top level falls back to the root, and nothing else changes', opts, async ($: any, on: any) => {
  const w = world(on)
  w.tree.exitCode = 128
  await startIn($, '/repo')
  await w.clock.advance(2_000)
  for (const e of w.sent()) expect(e.project).toEqual({ cwd: '/repo', name: 'r', git_remote: 'github.com/o/r', git_branch: 'dev' })
  expect(fingerprints(w)).toHaveLength(1)
})

// ── v0.2 slice 3: the monthly goal ──
const lineOf = (w: ReturnType<typeof world>) => w.statuses.at(-1)

test('v0.2 slice 3: from 80% of the goal the normal line ends with the month and a rounded percentage', opts, async ($: any, on: any) => {
  const w = world(on)
  w.goal.goal = 2500
  w.goal.spent = 1999
  await boot($)
  await w.clock.advance(2_000)
  expect(lineOf(w)).toBe('👥 1 · 0 tok · ctx 12%') // 79.96%: nothing yet
  w.goal.spent = 2029
  await w.clock.advance(60_000)
  expect(lineOf(w)).toBe('👥 1 · 0 tok · ctx 12% · Oct 81%')
  expect(w.statuses.some((s) => s === '👥 1 · 0 tok · ctx 12%')).toBe(true)
})

test('v0.2 slice 3: past the goal the line says so, in whole dollars, until the month changes or the goal does', opts, async ($: any, on: any) => {
  const w = world(on)
  w.goal.goal = 2500
  w.goal.spent = 2540.4
  await boot($)
  await w.clock.advance(2_000)
  expect(lineOf(w)).toBe('⚠ r over its October goal: $2,540 of $2,500')
  w.goal.goal = 3000 // the goal raised: back to the normal line, with its percentage
  await w.clock.advance(60_000)
  expect(lineOf(w)).toBe('👥 1 · 0 tok · ctx 12% · Oct 85%')
  w.goal.goal = null // cleared
  await w.clock.advance(60_000)
  expect(lineOf(w)).toBe('👥 1 · 0 tok · ctx 12%')
})

test('v0.2 slice 3: past the goal ranks after a stall and after a pricier model', { ...opts, timeoutMs: 20_000 }, async ($: any, on: any) => {
  let release!: () => void
  on('tool.call', () => new Promise((resolve) => { release = () => resolve({ result: 'ok', text: 'ok' }) }))
  on('turn.complete', () => ({ text: 'done' }))
  const w = world(on)
  w.files['/repo/.claude/agents/implementer.md'] = IMPLEMENTER('sonnet')
  w.engine.model = 'claude-opus-5-5'
  w.goal.goal = 2500
  w.goal.spent = 2540
  await boot($)
  await $.agent.spawn(spawnArgs())
  await w.clock.advance(2_000)
  expect(lineOf(w)).toBe('⚠ implementer on Opus, file says Sonnet') // a pricier model before the goal
  const call = $.tool.call({ tool: 'WebFetch', tool_use_id: 'toolu_w', url: 'https://x' })
  await w.clock.advance(16 * MIN)
  expect(lineOf(w)).toMatch(/^⚠ main: WebFetch 1[56]m$/) // a stall before both
  release()
  await call
  await w.clock.advance(2_000)
  expect(lineOf(w)).toBe('⚠ implementer on Opus, file says Sonnet')
  await $.turn.start({ text: 'build it', turnId: 't-2', agentId: 'a-child' })
  await $.turn.complete({ turnId: 't-2', agentId: 'a-child', answer: 'done', durationMs: 1_000, isAborted: false, reason: 'answer' })
  await w.clock.advance(2_000)
  expect(lineOf(w)).toBe('⚠ r over its October goal: $2,540 of $2,500') // the goal, once nothing else is wrong
})

test('v0.2 slice 3: one notification at 80% and one past 100%, each once, titled agent-orb: goal', opts, async ($: any, on: any) => {
  const w = world(on)
  w.goal.goal = 2500
  w.goal.spent = 1500
  await boot($)
  await w.clock.advance(2_000)
  expect(w.notes).toEqual([])
  w.goal.spent = 2029
  await w.clock.advance(60_000)
  expect(w.notes).toEqual(['r is at 81% of its October goal ($2,029 of $2,500)'])
  await w.clock.advance(3 * MIN) // the same answer again and again: no repeat (and under the 15 minutes of a stall)
  w.goal.spent = 2300
  await w.clock.advance(3 * MIN) // still between 80% and 100%
  expect(w.notes).toHaveLength(1)
  w.goal.spent = 2540
  await w.clock.advance(60_000)
  expect(w.notes).toEqual(['r is at 81% of its October goal ($2,029 of $2,500)', 'r is over its October goal: $2,540 of $2,500'])
  await w.clock.advance(3 * MIN)
  expect(w.notes).toHaveLength(2)
  expect(w.titles).toEqual(['agent-orb: goal', 'agent-orb: goal'])
})

test('v0.2 slice 3: a second session in the same month repeats neither notification: what was sent is in the store', opts, async ($: any, on: any) => {
  const w = world(on, undefined, true, { 'goal:r:2026-10': { at80: true, over: true }, 'goal:r:2026-09': { at80: true } })
  w.goal.goal = 2500
  w.goal.spent = 2540
  await boot($)
  await w.clock.advance(2_000)
  expect(lineOf(w)).toBe('⚠ r over its October goal: $2,540 of $2,500') // the line shows it all the same
  expect(w.notes).toEqual([])
})

test('v0.2 slice 3: a session that finds 80% sent and the goal passed since sends only the second', opts, async ($: any, on: any) => {
  const w = world(on, undefined, true, { 'goal:r:2026-10': { at80: true }, 'goal:other:2026-10': { at80: true, over: true }, 'goal:r:2026-09': { at80: true, over: true } })
  w.goal.goal = 2500
  w.goal.spent = 2540 // another project's, and another month's, flags are not this one's
  await boot($)
  await w.clock.advance(2_000)
  expect(w.notes).toEqual(['r is over its October goal: $2,540 of $2,500'])
})

test('v0.2 slice 3: first seen already past the goal sends the over notice only, and what it stores covers both', opts, async ($: any, on: any) => {
  const w = world(on)
  w.goal.goal = 2500
  w.goal.spent = 2540
  await boot($)
  await w.clock.advance(5 * MIN)
  expect(w.notes).toEqual(['r is over its October goal: $2,540 of $2,500'])
})

test('v0.2 slice 3: no goal set changes nothing: no suffix, no notification, however much was spent', opts, async ($: any, on: any) => {
  const w = world(on)
  w.goal.goal = null
  w.goal.spent = 99_999
  await boot($)
  await w.clock.advance(5 * MIN)
  expect(lineOf(w)).toBe('👥 1 · 0 tok · ctx 12%')
  expect(w.statuses.every((s) => !/goal|Oct/.test(s ?? ''))).toBe(true)
  expect(w.notes).toEqual([])
})

test('v0.2 slice 3: a fetch that fails changes nothing: not at the start, and not after a good answer, whose line and notices stay', opts, async ($: any, on: any) => {
  const w = world(on)
  w.goal.goal = 2500
  w.goal.spent = 2029
  w.goal.status = 500
  await boot($)
  await w.clock.advance(2_000)
  expect(lineOf(w)).toBe('👥 1 · 0 tok · ctx 12%') // a server error from the start: the plain line
  expect(w.notes).toEqual([])
  w.goal.status = 200
  await w.clock.advance(60_000)
  expect(lineOf(w)).toBe('👥 1 · 0 tok · ctx 12% · Oct 81%')
  expect(w.notes).toHaveLength(1)
  for (const failure of [() => { w.goal.status = 503 }, () => { w.goal.status = 200; w.goal.mode = 'throw' }, () => { w.goal.mode = 'garbage' }]) {
    failure()
    w.goal.spent = 2540 // what the server would say if it answered
    await w.clock.advance(2 * MIN)
    expect(lineOf(w)).toBe('👥 1 · 0 tok · ctx 12% · Oct 81%') // the last answer stays
    expect(w.notes).toHaveLength(1)
  }
  w.goal.mode = 'ok'
  await w.clock.advance(60_000)
  expect(lineOf(w)).toBe('⚠ r over its October goal: $2,540 of $2,500') // and it recovers
  expect(w.notes).toHaveLength(2)
})

test('v0.2 slice 3: the goal is asked at session start and then every 60 seconds, for this project and the runtime\'s time zone', opts, async ($: any, on: any) => {
  const w = world(on)
  await boot($)
  await w.clock.settle()
  expect(w.goal.calls).toHaveLength(1) // at session start, not at the first tick
  await w.clock.advance(59_000)
  expect(w.goal.calls).toHaveLength(1)
  await w.clock.advance(2_000)
  expect(w.goal.calls).toHaveLength(2)
  await w.clock.advance(125_000)
  expect(w.goal.calls).toHaveLength(4) // 61 s, 120 s, 180 s
  const url = new URL(w.goal.calls[0]!)
  expect(`${url.origin}${url.pathname}`).toBe('http://127.0.0.1:4040/api/goal')
  expect(url.searchParams.get('project')).toBe('r')
  expect(url.searchParams.get('tz')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  expect(url.search.slice(1).split('&').map((kv) => kv.split('=')[0]).sort()).toEqual(['project', 'tz']) // nothing else is sent
})

test('v0.2 slice 3: a goal server that never answers holds up nothing, and is not asked again meanwhile', opts, async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  const w = world(on)
  w.goal.mode = 'hang'
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false }) // resolves although the goal call hangs
  await $.turn.start({ text: 'go', turnId: 't-1' })
  const r = await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r', file_path: '/repo/a.ts' })
  expect(r.text).toBe('ok')
  await w.clock.advance(10 * MIN)
  expect(w.goal.calls).toHaveLength(1)
  expect(w.sent().map((e) => e.kind)).toContain('session.start') // the outbox still flushes
})

test('v0.2 slice 3: with no token the plugin does no network at all, the goal included', { options: { stallMinutes: 15 } }, async ($: any, on: any) => {
  const w = world(on)
  w.goal.goal = 2500
  w.goal.spent = 2540
  await boot($)
  await w.clock.advance(2 * MIN)
  expect(w.goal.calls).toEqual([])
  expect(lineOf(w)).toBe('agent-orb: no token (see /orb)')
})

test('v0.2 slice 3: a worktree session reads its own agent files: the model check and the role come from the worktree\'s definition', opts, async ($: any, on: any) => {
  const w = world(on)
  inWorktree(w)
  w.files['/repo/.claude/agents/implementer.md'] = IMPLEMENTER('sonnet') // the main tree's definition
  w.files[`${WT}/.claude/agents/implementer.md`] = '---\nname: implementer\norb-role: reviewer\nmodel: opus\n---\nthe worktree\'s version'
  w.engine.model = 'claude-opus-5-5'
  await startIn($, WT)
  await $.agent.spawn(spawnArgs({ model: 'opus' }))
  await w.clock.advance(2_000)
  const [spawn] = spawned(w)
  expect(spawn.data.declared_role).toBe('reviewer') // the worktree's, not the main tree's developer
  expect(spawn.data.model_check).toBeUndefined() // the worktree's file allows Opus; the main tree's Sonnet would flag it
  expect(w.notes).toEqual([])
})

// ── v0.3 slice 1 (#43): the error class of a failed result and the command class of a Bash call ──
const FAILING_RUN = 'Exit code 1\n FAIL  packages/server/test/ingest.test.ts > ingest > writes\nAssertionError: SECRETWORD expected 34, got 35'
async function classedSession($: any, on: any, w: ReturnType<typeof world>) {
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'Bash' && e.command === 'pnpm -C /repo test') return { result: 'r', isError: true, text: FAILING_RUN }
    if (e.tool === 'Bash' && e.command === 'cd /repo && gh pr view 7') return { result: 'r', isError: true, text: 'Exit code 127\n(eval):1: command not found: gh' }
    if (e.tool === 'Bash') return { result: 'ok', text: 'On branch dev' }
    if (e.tool === 'Read') return { result: 'r', isError: true, text: 'File does not exist. Note: your current working directory is /repo.' }
    if (e.tool === 'Edit' && e.old_string === 'gone') return { result: 'r', isError: true, text: '<tool_use_error>String to replace not found in file.\nString: SECRETWORD gone</tool_use_error>' }
    return { deny: 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: SECRETWORD' }
  })
  await boot($)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_t', command: 'pnpm -C /repo test' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_g', command: 'git status' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_h', command: 'cd /repo && gh pr view 7' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_r', file_path: '/repo/nope.ts' })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'toolu_e', file_path: '/repo/a.ts', old_string: 'gone', new_string: 'x' })
  await $.tool.call({ tool: 'Write', tool_use_id: 'toolu_w', file_path: '/repo/b.ts', content: 'x' })
  await w.clock.advance(2_000)
}
const classes = (w: ReturnType<typeof world>) => ({
  calls: Object.fromEntries(w.sent().filter((e) => e.kind === 'tool.call').map((e) => [e.data.tool_use_id, e.data.command_class])),
  results: Object.fromEntries(w.sent().filter((e) => e.kind === 'tool.result').map((e) => [e.data.tool_use_id, e.data.error_class])),
})
const CLASSED = {
  calls: { toolu_t: 'test', toolu_g: 'git', toolu_h: 'gh', toolu_r: undefined, toolu_e: undefined, toolu_w: undefined },
  results: { toolu_t: 'exit_code', toolu_g: undefined, toolu_h: 'unknown_command', toolu_r: 'not_found', toolu_e: 'no_match', toolu_w: 'refused' },
}

test('v0.3 slice 1: a failing Bash test run sends command_class test and error_class exit_code, and with Content off no output text goes', opts, async ($: any, on: any) => {
  const w = world(on)
  await classedSession($, on, w)
  expect(classes(w)).toEqual(CLASSED)
  const failed = w.sent().find((e) => e.kind === 'tool.result' && e.data.tool_use_id === 'toolu_t').data
  expect(failed).toMatchObject({ success: false, error_type: 'error', error_class: 'exit_code', output_size: FAILING_RUN.length, files_touched: [] })
  expect(failed).not.toHaveProperty('output')
  for (const e of w.sent().filter((e) => e.kind === 'tool.call' && e.data.tool !== 'Bash')) expect(e.data).not.toHaveProperty('command_class') // Bash calls only
  expect(textIn(w.sent())).toEqual([])
  expect(JSON.stringify(w.sent())).not.toMatch(/SECRETWORD|AssertionError|ingest\.test|FAIL/)
})

test('v0.3 slice 1: the classes are the same with Content on full, and a successful call has no error_class', { options: { token: 'tok', content: 'full' } }, async ($: any, on: any) => {
  const w = world(on)
  await classedSession($, on, w)
  expect(classes(w)).toEqual(CLASSED)
  expect(w.sent().find((e) => e.kind === 'tool.result' && e.data.tool_use_id === 'toolu_t').data.output).toContain('AssertionError') // content is its own setting
  expect(w.sent().find((e) => e.kind === 'tool.result' && e.data.tool_use_id === 'toolu_g').data).not.toHaveProperty('error_class')
})

// ── v0.3 slice 3 (#45): the shape of a failure, a name or a hash, never its text ──
const SLEEPING = '<tool_use_error>Blocked: sleep 30 followed by: tail -f /private/tmp/SECRETWORD/b1.output. To wait for a condition, use Monitor with an until-loop.</tool_use_error>'
async function shapedSession($: any, on: any, w: ReturnType<typeof world>) {
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'Bash' && e.command === 'sleep 30 && tail -f /private/tmp/SECRETWORD/b1.output') return { result: 'r', isError: true, text: SLEEPING }
    if (e.tool === 'Bash' && e.command === 'pnpm -C /repo test') return { result: 'r', isError: true, text: FAILING_RUN }
    if (e.tool === 'Bash' && e.command === 'false') return { result: 'r', isError: true, text: 'Exit code 1' }
    if (e.tool === 'Bash') return { result: 'ok', text: 'On branch dev' }
    return { deny: 'PreToolUse:Write hook error: [bash .claude/hooks/check-branch.sh]: BLOCKED: SECRETWORD on main' }
  })
  await boot($)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_s', command: 'sleep 30 && tail -f /private/tmp/SECRETWORD/b1.output' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_t', command: 'pnpm -C /repo test' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_f', command: 'false' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_g', command: 'git status' })
  await $.tool.call({ tool: 'Write', tool_use_id: 'toolu_w', file_path: '/repo/b.ts', content: 'x' })
  await w.clock.advance(2_000)
}
const shapes = (w: ReturnType<typeof world>) => Object.fromEntries(w.sent().filter((e) => e.kind === 'tool.result').map((e) => [e.data.tool_use_id, e.data.error_shape]))
const SHAPED = { toolu_s: 'sleep_blocked', toolu_t: 'h:a0038b0f', toolu_f: undefined, toolu_g: undefined, toolu_w: 'hook_blocked' }

test('v0.3 slice 3: a "Blocked: sleep 30 followed by" result sends error_shape sleep_blocked, a failing test run a hash, a bare exit code none; with Content off no text goes', opts, async ($: any, on: any) => {
  const w = world(on)
  await shapedSession($, on, w)
  expect(shapes(w)).toEqual(SHAPED)
  expect(w.sent().find((e) => e.kind === 'tool.result' && e.data.tool_use_id === 'toolu_s').data).toMatchObject({ success: false, error_class: 'refused', error_shape: 'sleep_blocked', output_size: SLEEPING.length })
  expect(w.sent().find((e) => e.kind === 'tool.result' && e.data.tool_use_id === 'toolu_f').data).not.toHaveProperty('error_shape')
  expect(w.sent().find((e) => e.kind === 'tool.result' && e.data.tool_use_id === 'toolu_g').data).not.toHaveProperty('error_shape')
  expect(textIn(w.sent())).toEqual([])
  expect(JSON.stringify(w.sent())).not.toMatch(/SECRETWORD|tail|AssertionError|ingest\.test|Monitor/)
})

test('v0.3 slice 3: the shapes are the same with Content on full, which sends the output as its own setting', { options: { token: 'tok', content: 'full' } }, async ($: any, on: any) => {
  const w = world(on)
  await shapedSession($, on, w)
  expect(shapes(w)).toEqual(SHAPED)
  expect(w.sent().find((e) => e.kind === 'tool.result' && e.data.tool_use_id === 'toolu_s').data.output).toContain('Blocked: sleep 30 followed by')
})

// ── v0.3 slice 2 (#42, Worth): the merged PRs, and the PR links a tool's output shows ──
// `gh pr list --state merged --json number,title,mergedAt,additions,deletions,headRefName,files` as gh prints it (#103: the files, of which only two counts are sent).
// PR 73 changed a lockfile, an image and build output beside two source files: 24 lines in 2 files count. PR 72 changed one source file.
const GH_LIST = JSON.stringify([
  { additions: 152, deletions: 8, headRefName: 'fix/63-masking', mergedAt: '2026-10-26T08:34:07Z', number: 72, title: 'fix(mod): mask the secret shapes',
    files: [{ path: 'packages/mod/hooks/core.ts', additions: 152, deletions: 8 }] },
  { additions: 1030, deletions: 24, headRefName: 'feat/43-classes', mergedAt: '2026-10-26T10:56:13Z', number: 73, title: 'feat: v0.3 slice 1',
    files: [
      { path: 'pnpm-lock.yaml', additions: 800, deletions: 200 }, { path: 'assets/secret-screen.png', additions: 0, deletions: 0 }, { path: 'dist/app.js', additions: 9, deletions: 1 },
      { path: 'packages/mod/hooks/core.ts', additions: 20, deletions: 4 }, { path: 'packages/shared/src/event.ts', additions: 0, deletions: 0 },
    ] },
])
const prsSent = (w: ReturnType<typeof world>) => w.sent().filter((e) => e.kind === 'project.prs')
const GH_ARGV = ['gh', 'pr', 'list', '--state', 'merged', '--search', expect.stringMatching(/^merged:>=\d{4}-\d{2}-\d{2}$/), '--limit', '500', '--json', 'number,title,mergedAt,additions,deletions,headRefName,files']

test('v0.3 slice 2: session start asks gh in the checkout for the PRs merged in the past 90 days and sends them as one project.prs, once', opts, async ($: any, on: any) => {
  const w = world(on)
  w.gh.out = GH_LIST
  await boot($)
  await w.clock.advance(2_000)
  await w.clock.advance(2_000)
  expect(w.gh.calls).toEqual([{ argv: GH_ARGV, cwd: '/repo' }])
  expect(prsSent(w).map((e) => e.data)).toEqual([{ prs: [
    { number: 73, title: 'feat: v0.3 slice 1', merged_at: Date.parse('2026-10-26T10:56:13Z'), additions: 1030, deletions: 24, head: 'feat/43-classes', counted_lines: 24, counted_files: 2 },
    { number: 72, title: 'fix(mod): mask the secret shapes', merged_at: Date.parse('2026-10-26T08:34:07Z'), additions: 152, deletions: 8, head: 'fix/63-masking', counted_lines: 160, counted_files: 1 },
  ] }])
  expect(prsSent(w)[0].project).toEqual({ cwd: '/repo', name: 'r', git_remote: 'github.com/o/r', git_branch: 'dev' })
})

test('v0.3 slice 2 (#103): the files reach the server as two counts only: no path, whatever Content is set to', opts, async ($: any, on: any) => {
  const w = world(on)
  w.gh.out = GH_LIST
  await boot($)
  await w.clock.advance(2_000)
  const sent = JSON.stringify(prsSent(w))
  for (const path of ['pnpm-lock', 'secret-screen', 'dist/', 'core.ts', 'event.ts', '"files"']) expect(sent, path).not.toContain(path)
  expect(sent).toContain('"counted_lines":24,"counted_files":2')
})

test('v0.3 slice 2: the date asked for is 90 days before the engine\'s clock', opts, async ($: any, on: any) => {
  const w = world(on)
  await boot($)
  await w.clock.advance(2_000)
  const since = String(w.gh.calls[0]!.argv[6]).slice('merged:>='.length)
  expect(Date.parse(since)).toBeGreaterThanOrEqual(T0 - 90 * 86_400_000 - 86_400_000)
  expect(Date.parse(since)).toBeLessThanOrEqual(T0 - 90 * 86_400_000)
})

test('v0.3 slice 2: a worktree session asks gh in its own checkout', opts, async ($: any, on: any) => {
  const w = world(on)
  inWorktree(w)
  w.gh.out = GH_LIST
  await startIn($, WT)
  await w.clock.advance(2_000)
  expect(w.gh.calls.map((c) => c.cwd)).toEqual([WT])
  expect(prsSent(w)).toHaveLength(1)
})

test('v0.3 slice 2: a list with no PR sends nothing', opts, async ($: any, on: any) => {
  const w = world(on)
  w.gh.out = '[]'
  await boot($)
  await w.clock.advance(2_000)
  expect(w.gh.calls).toHaveLength(1)
  expect(prsSent(w)).toEqual([])
})

for (const [label, set] of [
  ['that is not installed', (g: ReturnType<typeof world>['gh']) => { g.missing = true }],
  ['that exits 1', (g: ReturnType<typeof world>['gh']) => { g.exitCode = 1; g.out = 'HTTP 401: Bad credentials' }],
  ['that asks to log in', (g: ReturnType<typeof world>['gh']) => { g.exitCode = 4; g.out = 'To get started with GitHub CLI, please run:  gh auth login' }],
  ['that prints a list but exits 1', (g: ReturnType<typeof world>['gh']) => { g.exitCode = 1; g.out = GH_LIST }],
  ['that prints what is not JSON', (g: ReturnType<typeof world>['gh']) => { g.out = 'dev\n' }],
] as const) {
  test(`v0.3 slice 2: a gh ${label} sends nothing, says nothing, and the session starts all the same`, opts, async ($: any, on: any) => {
    const w = world(on)
    set(w.gh)
    await boot($)
    await w.clock.advance(2_000)
    expect(w.gh.calls).toHaveLength(1)
    expect(prsSent(w)).toEqual([])
    expect(w.sent().map((e) => e.kind)).toContain('session.start')
    expect(w.notes).toEqual([])
  })
}

test('v0.3 slice 2: a gh that never answers does not hold up the session', opts, async ($: any, on: any) => {
  const w = world(on)
  w.gh.hang = true
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false }) // resolves although gh hangs
  await w.clock.settle()
  expect(w.sent().map((e) => e.kind)).toContain('session.start')
  expect(prsSent(w)).toEqual([])
})

test('v0.3 slice 2: an excluded project sends its PRs without titles or branches, whatever content is set to', { options: { token: 'tok', content: 'full', excludeProjects: 'other, o/r' } }, async ($: any, on: any) => {
  const w = world(on)
  w.gh.out = GH_LIST
  await boot($)
  await w.clock.advance(2_000)
  expect(prsSent(w).map((e) => e.data)).toEqual([{ prs: [
    { number: 73, merged_at: Date.parse('2026-10-26T10:56:13Z'), additions: 1030, deletions: 24, counted_lines: 24, counted_files: 2 }, // the counts are numbers, so they are sent
    { number: 72, merged_at: Date.parse('2026-10-26T08:34:07Z'), additions: 152, deletions: 8, counted_lines: 160, counted_files: 1 },
  ] }])
  expect(JSON.stringify(w.sent())).not.toMatch(/masking|slice 1|classes|core\.ts|pnpm-lock/)
})

test('v0.3 slice 2: a project that is not excluded keeps its titles when content is off', { options: { token: 'tok', excludeProjects: 'other' } }, async ($: any, on: any) => {
  const w = world(on)
  w.gh.out = GH_LIST
  await boot($)
  await w.clock.advance(2_000)
  expect(prsSent(w)[0].data.prs.map((p: any) => p.title)).toEqual(['feat: v0.3 slice 1', 'fix(mod): mask the secret shapes'])
})

test('v0.3 slice 2: with no token the PRs are read and queued, and nothing goes to the network', { options: { stallMinutes: 15 } }, async ($: any, on: any) => {
  const w = world(on)
  w.gh.out = GH_LIST
  await boot($)
  await w.clock.advance(2_000)
  expect(w.gh.calls).toHaveLength(1) // gh is local; the outbox keeps the event until a token is set
  expect(w.posts).toEqual([])
})

// A PR link in what a command printed: `gh pr create` ends with the URL.
const PR_URL = (n: number, repo = 'o/r') => `https://github.com/${repo}/pull/${n}`
const linksSent = (w: ReturnType<typeof world>) => w.sent().filter((e) => e.kind === 'session.pr')
function printing(on: any, byId: Record<string, { text: string; isError?: boolean }>) {
  on('tool.call', (_$: any, e: any) => {
    const out = byId[e.tool_use_id]
    return out?.isError ? { result: 'r', isError: true, text: out.text } : { result: 'ok', text: out?.text ?? '' }
  })
}

test('v0.3 slice 2: a Bash call that prints this repository\'s PR URL sends session.pr with the number, once per number', opts, async ($: any, on: any) => {
  printing(on, {
    toolu_1: { text: `Creating pull request for feat/x into dev in o/r\n\n${PR_URL(74)}\n` },
    toolu_2: { text: `title: x\nurl: ${PR_URL(74)}\nsee also ${PR_URL(70)}/files` }, // 74 again, and a second PR
    toolu_3: { text: PR_URL(74) },
  })
  const w = world(on)
  await boot($)
  for (const id of ['toolu_1', 'toolu_2', 'toolu_3']) await $.tool.call({ tool: 'Bash', tool_use_id: id, command: 'gh pr create' })
  await w.clock.advance(2_000)
  expect(linksSent(w).map((e) => e.data)).toEqual([{ number: 74 }, { number: 70 }])
  expect(linksSent(w)[0].project).toEqual({ cwd: '/repo', name: 'r', git_remote: 'github.com/o/r', git_branch: 'dev' })
})

test('v0.3 slice 2: only the number leaves the machine: not the URL, not a word of the output, with Content on full either', { options: { token: 'tok', content: 'full' } }, async ($: any, on: any) => {
  printing(on, { toolu_1: { text: `SECRETWORD ${PR_URL(74)} SECRETWORD` } })
  const w = world(on)
  await boot($)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_1', command: 'gh pr create' })
  await w.clock.advance(2_000)
  expect(linksSent(w).map((e) => e.data)).toEqual([{ number: 74 }])
  expect(linksSent(w)[0]).not.toHaveProperty('agent_id')
  expect(linksSent(w)[0]).not.toHaveProperty('turn_id')
  expect(JSON.stringify(linksSent(w))).not.toMatch(/github\.com\/o\/r\/pull|SECRETWORD/)
})

test('v0.3 slice 2: a PR another repository owns, or one a file or a web page merely mentions, is not this session\'s', opts, async ($: any, on: any) => {
  printing(on, {
    toolu_other: { text: PR_URL(5, 'someone/else') },
    toolu_read: { text: `## Changelog\n- ${PR_URL(1)}\n- ${PR_URL(2)}` },
    toolu_grep: { text: `CHANGELOG.md:3: ${PR_URL(3)}` },
    toolu_web: { text: `<a href="${PR_URL(4)}">PR</a>` },
    toolu_none: { text: 'On branch dev' },
  })
  const w = world(on)
  await boot($)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_other', command: 'gh pr view https://github.com/someone/else/pull/5' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'toolu_read', file_path: '/repo/CHANGELOG.md' })
  await $.tool.call({ tool: 'Grep', tool_use_id: 'toolu_grep', pattern: 'pull' })
  await $.tool.call({ tool: 'WebFetch', tool_use_id: 'toolu_web', url: 'https://x' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_none', command: 'git status' })
  await w.clock.advance(2_000)
  expect(linksSent(w)).toEqual([])
})

test('v0.3 slice 2: an MCP tool\'s output counts, a subagent\'s Bash call counts, and a call that failed after printing the URL still does', opts, async ($: any, on: any) => {
  printing(on, {
    toolu_mcp: { text: JSON.stringify({ html_url: PR_URL(80) }) },
    toolu_sub: { text: PR_URL(81) },
    toolu_failed: { text: `GraphQL: Pull request ${PR_URL(82)} is not mergeable`, isError: true },
  })
  const w = world(on)
  await boot($)
  await $.tool.call({ tool: 'mcp__github__create_pull_request', tool_use_id: 'toolu_mcp' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_sub', command: 'gh pr create', agentId: 'a-sub' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_failed', command: 'gh pr merge 82' })
  await w.clock.advance(2_000)
  expect(linksSent(w).map((e) => e.data.number)).toEqual([80, 81, 82])
  for (const e of linksSent(w)) expect(e).not.toHaveProperty('agent_id') // the session\'s link, whoever ran the command
})

test('v0.3 slice 2: a project with no remote links nothing', opts, async ($: any, on: any) => {
  printing(on, { toolu_1: { text: PR_URL(74) } })
  const w = world(on)
  w.repo.remote = null
  await boot($)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_1', command: 'gh pr create' })
  await w.clock.advance(2_000)
  expect(linksSent(w)).toEqual([])
})
