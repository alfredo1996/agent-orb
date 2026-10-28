import { atom, read, update } from 'claude-code'
import type { EngineInterface as $, Register } from 'claude-code'

import type { OrbAgentRow, OrbEventRow, OrbView } from '../types'
import {
  BATCH, build, capText, changesArgv, checkStalls, commandClass, enqueue, errorClass, errorShape, filesTouched, fingerprintFiles, fingerprintsFrom, fmtTokens, goalNotice, hostName, isExcluded, mask, modelLabel, newOutbox, newTracker,
  normalizeRemote, parseChanges, parseGoal, parsePrs, prNumbersIn, prsArgv, toolContent, type ContentMode, type Goal, type GoalSent,
  familyOf, modelCheck, modelFromFrontmatter, pricierNotice, rejectedIn, roleFromFrontmatter, settle, statusText, takeBatch, tokensOf, usageOf,
  descriptionOf, preloadOf, refsIn, type CatalogAgent, type CatalogSkill, type Ctx, type Ev, type Refs, type Role, type SkillLoad,
} from './core.ts'

// Capture (PROJECT.md §4): every hook passes through at once and only queues an event.
// A 2-second timer flushes the outbox, checks for stalls and redraws the status line and the /orb panel.

const PANE = 'orb'
const TICK_MS = 2_000
const ORPHAN_MS = 60_000 // another session's outbox untouched this long is taken over
const GOAL_MS = 60_000 // v0.2 slice 3: the goal is asked again this often
const view = atom({ plugin: 'agent-orb', key: 'view' } as const, null as OrbView | null)

type Usage = ReturnType<typeof usageOf>
const add = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input, output: a.output + b.output, cache_read: a.cache_read + b.cache_read, cache_creation: a.cache_creation + b.cache_creation,
})
const zero = usageOf(null)
const key = (agentId: string | undefined) => agentId ?? 'main'
const dur = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s` : `${Math.floor(ms / 1000)}s`)
const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 8)
// The engine's clock ($.clock, which a test can move) read as Date.now() plus the skew the last tick saw.
let skew = 0
const stamp = () => Date.now() + skew

// Set by register() from the plugin config; module state, because a function that takes $ must be declared at the top of the file.
let endpoint = 'http://127.0.0.1:4040'
let token = ''
let stallMs = 15 * 60_000
let modelCeiling = 'sonnet' // v0.2 slice 2: haiku | sonnet | opus | off
let contentSetting = 'off'
let excludeList = ''
// off | full | excluded, decided at session start from the setting and the project (§15, 2026-10-20)
let contentMode: ContentMode = 'off'
const text = (s: string | undefined) => (contentMode === 'full' && s ? capText(mask(s)) : undefined)

let ctx: Ctx | undefined
// root: the repository's root, the main working tree's for a worktree (project identity). checkout: the session's own working tree, the one
// whose files it reads (v0.2 slice 3); the same as root outside a worktree.
let root = ''
let checkout = ''
let storeKey = ''
let ctxPercent: number | undefined
let promptId: string | undefined
let dirty = false
let sending = false
let ticks = 0
let lastStatus = ''
// v0.2 slice 3: the last answer to GET /api/goal for this project (none when it has no goal, or nothing answered yet), when it was last asked, and whether a call is out.
let goal: Goal | undefined
let goalAt = 0
let goalBusy = false
const t = newTracker()
const ob = newOutbox()
const recent: OrbEventRow[] = []
const notified = new Set<string>()
const turnOf = new Map<string, string>()
const turnStart = new Map<string, number>()
const agentStart = new Map<string, number>()
const agentUsage = new Map<string, Usage>()
const agentModel = new Map<string, string>()
const parentOf = new Map<string, string>()
// What an agent file says, read once per type: whether a file was found, its orb-role and its model.
type AgentFile = { found: boolean; role?: Role; model?: string }
const agentFiles = new Map<string, AgentFile>()
const skillCalls: string[] = []
// Slice 5: the session's skill and agent names (to match references against), a typed /name waiting for its turn,
// and the newest subagent (a preload fires right after its first turn starts; docs/verified.md, Skills).
let catalogNames: Refs = { skills: [], agents: [] }
let typed: string | undefined
const pendingTyped: SkillLoad[] = []
let newestSub: string | undefined
const taskSubjects = new Map<string, string>() // TaskUpdate's result carries no subject (docs/verified.md)
const prLinked = new Set<number>() // v0.3 slice 2: the PR numbers this session has sent a link for

const agent = (k: string, now = stamp()) => {
  let a = t.agents.get(k)
  if (!a) t.agents.set(k, (a = { key: k, label: k === 'main' ? 'main' : 'agent', inTurn: false, lastTs: now, done: false, tokens: 0 }))
  a.lastTs = now
  return a
}
const label = (k: string) => t.agents.get(k)?.label ?? k

function push($: $, e: Ev, row?: Omit<OrbEventRow, 'time'>) {
  enqueue(ob, e)
  dirty = true
  if (row) recent.unshift({ time: clock(e.ts), ...row }), recent.splice(10)
  if (ob.queue.length >= BATCH) void flush($)
}

async function flush($: $) {
  const batch = sending || !token ? null : takeBatch(ob, stamp())
  if (!batch) return
  sending = true
  let status = 0
  let refused = 0
  try {
    const res = await $.http.fetch(`${endpoint}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: batch }),
    })
    status = res.status
    if (res.ok) refused = rejectedIn(res.text)
  } catch {
    // server down: the batch stays queued and the outbox backs off
  }
  // ponytail: settle() removes the first batch.length events; only a cap overflow during this very send could shift them.
  settle(ob, batch.length, status, stamp(), refused)
  sending = false
  dirty = true
  if (status >= 200 && status < 300 && ob.dropped && ctx) {
    enqueue(ob, build.dropped(ctx, ob.dropped, ob.droppedSince ?? stamp()))
    ob.dropped = 0
    ob.droppedSince = undefined
  }
}

async function persist($: $) {
  if (!dirty || !storeKey) return
  dirty = false
  // ponytail: the whole queue is rewritten each tick; fine for a working day's events, a chunked store if 100k ever lags.
  if (ob.queue.length) await $.store.set(storeKey, { updatedAt: stamp(), events: ob.queue })
  else await $.store.delete(storeKey)
}

async function tick($: $) {
  if (!ctx) return
  const now = await $.clock.now()
  skew = now - Date.now()
  const { started, ended } = checkStalls(t, now, stallMs)
  for (const s of started) {
    push($, build.stall(ctx, 'start', s), { agent: label(s.agent), kind: 'stall.start', detail: `${s.tool ?? 'no events'} · ${Math.round(stallMs / 60_000)}m`, tone: 'bad' })
    if (!notified.has(s.key)) {
      notified.add(s.key)
      void $.ui.notify(`${label(s.agent)}: ${s.tool ?? 'no events'} for ${Math.floor((now - s.since) / 60_000)} min`, { title: 'agent-orb: stalled' })
    }
  }
  for (const s of ended) push($, build.stall(ctx, 'end', s), { agent: label(s.agent), kind: 'stall.end', detail: s.tool ?? 'events again' })

  if (ticks++ % 5 === 0) ctxPercent = (await $.session.usage().catch(() => undefined))?.context?.percent ?? ctxPercent
  if (now - goalAt >= GOAL_MS) void fetchGoal($).catch(() => {}) // off the tick's path: a slow server holds nothing up
  const text = !token ? 'agent-orb: no token (see /orb)' : statusText(t, ctxPercent, now, goal)
  if (text !== lastStatus) $.ui.status((lastStatus = text))

  await flush($)
  await persist($)
  await update($, view, () => panel(now))
}

function panel(now: number): OrbView {
  const total = [...agentUsage.values()].reduce((s, u) => s + tokensOf(u), 0)
  const depth = (k: string): number => (parentOf.has(k) ? 1 + depth(parentOf.get(k)!) : 0)
  const rows: OrbAgentRow[] = [...t.agents.values()].map((a) => {
    const tool = [...t.tools.values()].find((x) => x.agent === a.key)
    const stalled = [...t.stalled.values()].some((s) => s.agent === a.key)
    return {
      label: a.label, depth: depth(a.key), model: modelLabel(agentModel.get(a.key) ?? ''), tool: tool?.tool ?? '—',
      runningFor: tool ? dur(now - tool.since) : '', tokens: fmtTokens(a.tokens),
      state: a.done ? 'done' : stalled ? 'stalled' : tool?.waiting || !a.inTurn ? 'waiting' : a.pricier ? 'pricier model' : 'working',
    }
  })
  // The desktop app has no menu row for a sensitive field, so the panel names the settings key too.
  const warning = !token ? 'No token: set ORB_TOKEN in the plugin config, or in ~/.claude/settings.json at pluginConfigs.agent-orb.options.token. Events wait in the outbox meanwhile.'
    : ob.failures ? `Server unreachable · ${ob.queue.length} events queued`
    : ob.rejected ? `${ob.rejected} events rejected by the server (a bug: please report it)` : undefined
  return {
    project: ctx?.project.name ?? '', branch: ctx?.project.git_branch,
    totals: `${fmtTokens(total)} tok${ctxPercent === undefined ? '' : ` · ctx ${Math.round(ctxPercent)}%`}`,
    agents: rows, events: recent.slice(0, 10), studio: endpoint, warning,
  }
}

// task.create on TaskCreate; task.complete when TaskUpdate moves a task to completed or deleted (in_progress feeds no view).
function taskEvent($: $, c: Ctx, w: { agentId?: string; turnId?: string }, tool: string, input: Record<string, unknown>, result: unknown) {
  const out = result as { task?: { id?: string; subject?: string }; statusChange?: { to?: string } } | undefined
  if (tool === 'TaskCreate' && out?.task?.id) {
    taskSubjects.set(out.task.id, out.task.subject ?? '')
    push($, build.task(c, w, 'create', out.task.id, out.task.subject ?? '', 'pending'), { agent: label(key(w.agentId)), kind: 'task.create', detail: out.task.subject ?? '' })
  }
  const to = out?.statusChange?.to
  if (tool === 'TaskUpdate' && typeof input.taskId === 'string' && (to === 'completed' || to === 'deleted')) {
    // ponytail: a task created before the plugin loaded has no remembered subject and is sent with ''.
    const subject = taskSubjects.get(input.taskId) ?? ''
    push($, build.task(c, w, 'complete', input.taskId, subject, to), { agent: label(key(w.agentId)), kind: 'task.complete', detail: `${subject} · ${to}` })
  }
}

async function agentFile($: $, type: string): Promise<AgentFile> {
  const cached = agentFiles.get(type)
  if (cached) return cached
  // ponytail: looks for <type>.md in the project's and the user's .claude/agents; a plugin's agent, or a file
  // named other than its type, falls back to roles.json on the server (§13), and to the model ceiling (v0.2 slice 2).
  const home = await $.env.get('HOME')
  let file: AgentFile = { found: false }
  for (const dir of [`${checkout}/.claude/agents`, home && `${home}/.claude/agents`]) { // the session's own checkout: a worktree's definitions
    const path = dir && `${dir}/${type}.md`
    if (path && (await $.fs.exists(path).catch(() => false))) {
      const text = String(await $.fs.read(path).catch(() => ''))
      file = { found: true, role: roleFromFrontmatter(text), model: modelFromFrontmatter(text) }
      break
    }
  }
  agentFiles.set(type, file)
  return file
}

/**
 * Slice 5: every skill and custom agent the session lists, with their listing tokens, sent once. References come from the
 * files the mod can read (project and user skills and agents); a plugin skill's come with its first load.
 */
async function sendCatalog($: $) {
  const [usage, commands, home] = await Promise.all([
    $.session.usage({ breakdown: 'summary' }).catch(() => undefined),
    $.command.list().catch(() => []),
    $.env.get('HOME').catch(() => undefined),
  ])
  const b = usage?.context?.breakdown
  if (!b || !ctx) return
  const listed = b.skills?.skillFrontmatter ?? []
  catalogNames = { skills: listed.map((s) => s.name), agents: (b.agents ?? []).map((a) => a.agentType) }
  const description = new Map(commands.map((c) => [c.name, c.description]))
  const fileOf = (rel: string, source: string) => (source === 'projectSettings' ? `${checkout}/.claude/${rel}` : source === 'userSettings' && home ? `${home}/.claude/${rel}` : undefined)
  const readFile = async (path?: string) => (path && (await $.fs.exists(path).catch(() => false)) ? String(await $.fs.read(path).catch(() => '')) : undefined)
  const skills = await Promise.all(listed.map(async (s): Promise<CatalogSkill> => {
    const body = await readFile(fileOf(`skills/${s.name}/SKILL.md`, s.source))
    const d = contentMode === 'excluded' ? undefined : description.get(s.name)
    return { name: s.name, source: s.source, tokens: s.tokens, ...(s.pluginName ? { plugin: s.pluginName } : {}), ...(d ? { description: d } : {}),
      ...(body === undefined ? {} : { refs: refsIn(body, catalogNames, s.name) }) }
  }))
  // An agent's mention of another agent is not drawn unless it spawned it (§15, 2026-10-21): skills only.
  const agents = await Promise.all((b.agents ?? []).map(async (a): Promise<CatalogAgent> => {
    const body = await readFile(fileOf(`agents/${a.agentType}.md`, a.source))
    const d = body === undefined || contentMode === 'excluded' ? undefined : descriptionOf(body)
    return { name: a.agentType, source: a.source, tokens: a.tokens, ...(d ? { description: d } : {}),
      ...(body === undefined ? {} : { refs: { skills: refsIn(body, catalogNames).skills, agents: [] }, preload: preloadOf(body) }) }
  }))
  if (ctx) push($, build.skillsCatalog(ctx, skills, agents))
}

/**
 * A skill's prompt was expanded: by a Skill call (inside it), by the person typing /name (before main's next turn), or
 * as a preload into a subagent (right after its first turn starts). The event carries no agentId (docs/verified.md).
 */
function loadSkill($: $, e: { skill: string; text: string; frontmatter: Readonly<Record<string, unknown>>; source: string; pluginName?: string }) {
  const c = ctx!
  const d = e.frontmatter?.description
  const s: SkillLoad = {
    skill: e.skill, how: 'tool', plugin: e.pluginName, source: e.source,
    description: contentMode !== 'excluded' && typeof d === 'string' ? d : undefined,
    refs: catalogNames.skills.length ? refsIn(e.text, catalogNames, e.skill) : undefined,
  }
  const callId = skillCalls.at(-1)
  if (callId) {
    const k = t.tools.get(callId)?.agent ?? 'main'
    push($, build.skillLoad(c, { agentId: k === 'main' ? undefined : k, turnId: turnOf.get(k) }, { ...s, toolUseId: callId }),
      { agent: label(k), kind: 'skill.load', detail: e.skill })
  } else if (typed === e.skill) {
    typed = undefined
    pendingTyped.push({ ...s, how: 'typed' }) // sent with main's next turn.start
  } else {
    const k = newestSub ?? 'main'
    push($, build.skillLoad(c, { agentId: k === 'main' ? undefined : k, turnId: turnOf.get(k) }, { ...s, how: 'preload' }),
      { agent: label(k), kind: 'skill.load', detail: `${e.skill} · preload` })
  }
}

/**
 * v0.2 slice 1: the past of what a change watches, from git: the commits of the last 90 days, on any branch, that first brought a version
 * of the project's agents, skills or CLAUDE.md, sent as one event. Every session sends the same ones again and the server keeps one Change per commit.
 * An excluded project sends no subjects.
 */
async function sendChanges($: $, excluded: boolean) {
  const r = await $.process.run(changesArgv(root))
  const commits = r.exitCode === 0 ? parseChanges(r.stdout, !excluded) : []
  if (commits.length && ctx) push($, build.projectChanges(ctx, commits))
}

/**
 * v0.2 slice 3: what a change watches, as the files are now: the project's agents, skills and CLAUDE.md and the owner's CLAUDE.md and rules, a path
 * and a git blob id each, hashed by one `git hash-object` call. The server compares them with the last session's. An excluded project sends them too:
 * a path and a hash are not content. Sent at session start only; nothing when there are no files, or git fails.
 */
async function sendFingerprint($: $, home: string) {
  const files = await fingerprintFiles(checkout, home || undefined, { list: (dir) => $.fs.list(dir), exists: (path) => $.fs.exists(path) })
  if (!files.length) return
  const r = await $.process.run(['git', 'hash-object', '--stdin-paths'], { cwd: checkout, stdin: `${files.map((f) => f.abs).join('\n')}\n`, timeoutMs: 20_000 })
  const hashed = r.exitCode === 0 ? fingerprintsFrom(files, r.stdout) : []
  if (hashed.length && ctx) push($, build.projectFingerprint(ctx, hashed))
}

/**
 * v0.3 slice 2 (#42, Worth): the PRs merged in the past 90 days, from `gh` in the session's checkout, sent as one event; the server keeps one
 * PullRequest per number. No gh, a gh that is not logged in or that fails, or a list that is not gh's sends nothing, quietly. An excluded
 * project sends no titles or branches.
 * ponytail: asked at every session start, as the git log is; if a cron of headless sessions ever meets GitHub's rate limit, remember the
 * last ask per project in `$.store` and skip within the hour. gh picks the repository itself (its default remote), so a fork checkout whose
 * default is the upstream lists the upstream's PRs under the fork's project; pass `-R <git_remote>` if that is ever seen.
 */
async function sendPrs($: $, excluded: boolean) {
  const r = await $.process.run(prsArgv(await $.clock.now()), { cwd: checkout, timeoutMs: 60_000 })
  const prs = r.exitCode === 0 ? parsePrs(r.stdout, !excluded) : []
  if (prs.length && ctx) push($, build.projectPrs(ctx, prs))
}

const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC' // ponytail: a runtime without Intl reads the month in UTC, an hour or two off at a month's edge
  }
}

/**
 * v0.2 slice 3 (PROJECT.md §15, 2026-10-24): asks the server for this project's goal and the month's spend, at session start and then every minute from
 * the tick, never on a hook's path. A failure, or an answer that is not the server's, changes nothing: the last answer stays. A new state (80%, past
 * 100%) sends its one notification, remembered per project and month in the store so another session does not repeat it.
 * ponytail: the old month's answer stays until the next one comes, so with the server down across a month's end its line stays.
 */
async function fetchGoal($: $) {
  if (!ctx || !token || goalBusy) return
  goalBusy = true
  try {
    goalAt = await $.clock.now()
    const res = await $.http.fetch(`${endpoint}/api/goal?${new URLSearchParams({ project: ctx.project.name, tz: timeZone() })}`)
    const answer = res.ok ? parseGoal(ctx.project.name, res.text) : undefined
    if (!answer) return
    goal = answer.goal ?? undefined
    if (!goal) return
    const key = `goal:${goal.project}:${goal.month}`
    const saved = await $.store.get(key)
    const { text, sent } = goalNotice(goal, saved && typeof saved === 'object' ? (saved as GoalSent) : {})
    if (!text) return
    await $.store.set(key, sent)
    void $.ui.notify(text, { title: 'agent-orb: goal' }).catch(() => {})
  } finally {
    goalBusy = false
  }
}

async function start($: $, interactive: boolean, cwd: string) {
  const [sessionId, version, repo, model, host] = await Promise.all([
    $.session.id(), $.session.version(), $.session.repo().catch(() => null), $.session.model(),
    $.process.run(['uname', '-s']).then((r: { stdout: string }) => r.stdout.trim().toLowerCase(), () => '').then((platform: string) => hostName((argv) => $.process.run(argv), platform)),
  ])
  root = repo?.root ?? cwd
  // `session.repo().root` is the main working tree's for a worktree (docs/verified.md), so the session's own tree is git's top level at its cwd.
  // ponytail: a folder that git and the engine spell differently (a symlink) reads as a worktree, and a tool path in the engine's spelling is
  // left out of files_touched. Compare real paths if that is ever seen.
  checkout = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel']).then((r: { exitCode: number; stdout: string }) => (r.exitCode === 0 ? r.stdout.trim() : '')).catch(() => '') || root
  const branch = await $.process.run(['git', '-C', checkout, 'branch', '--show-current']).then((r: { stdout: string }) => r.stdout.trim()).catch(() => '')
  ctx = {
    host: host || 'unknown-host',
    session_id: sessionId,
    project: {
      cwd: root, name: repo?.name ?? root.split('/').pop() ?? root,
      ...(normalizeRemote(repo?.remote) ? { git_remote: normalizeRemote(repo?.remote) } : {}),
      ...(branch ? { git_branch: branch } : {}),
      ...(checkout !== root ? { checkout } : {}),
    },
  }
  agentModel.set('main', model)

  // Take over this session's queue (a hot reload) and any other session's left untouched (a crash, a quit).
  storeKey = `outbox:${sessionId}`
  const now = stamp()
  for (const k of await $.store.keys()) {
    if (!k.startsWith('outbox:')) continue
    const saved = (await $.store.get(k)) as { updatedAt: number; events: Ev[] } | undefined
    if (!saved || (k !== storeKey && now - saved.updatedAt < ORPHAN_MS)) continue
    for (const e of saved.events) enqueue(ob, e)
    if (k !== storeKey) await $.store.delete(k)
  }

  const home = (await $.env.get('HOME')) ?? ''
  const list = excludeList.replace(/(^|,)\s*~(?=\/|,|$)/g, `$1${home}`)
  const excluded = isExcluded(ctx.project, list)
  contentMode = contentSetting !== 'full' ? 'off' : excluded ? 'excluded' : 'full'
  push($, build.sessionStart(ctx, model, version.version, interactive, contentMode))
  void flush($) // §12 A: a new session shows in Live at once, not at the next tick
  void sendCatalog($).catch(() => {}) // off the hook's path: it reads a file per project and user skill
  void sendChanges($, excluded).catch(() => {}) // off the hook's path too: a git log over a big history can take a while
  void sendFingerprint($, home).catch(() => {}) // and this one lists the watched folders and hashes every file in them
  void sendPrs($, excluded).catch(() => {}) // and gh is a network call
  void fetchGoal($).catch(() => {}) // the goal is asked now, not at the first tick
  if (interactive) await $.command.register({ name: 'orb', description: 'agent-orb: active agents, tokens and the last events' })
}

export const register: Register = (on, options) => {
  endpoint = String(options.endpoint ?? endpoint).replace(/\/+$/, '')
  token = String(options.token ?? '')
  stallMs = Math.max(1, Number(options.stallMinutes ?? 15)) * 60_000
  modelCeiling = String(options.modelCeiling ?? 'sonnet')
  contentSetting = String(options.content ?? 'off')
  excludeList = String(options.excludeProjects ?? '')

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await start($, e.isInteractive, e.cwd).catch((err: Error) => $.ui.log(`agent-orb could not start: ${err.message}`))
    $.clock.every(TICK_MS, () => void tick($).catch(() => {}))
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (ctx) push($, build.sessionEnd(ctx, e.reason))
    dirty = true
    await persist($).catch(() => {})
    void flush($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    // A subagent's report delivered to main arrives as a prompt too (origin task-notification): not a person's prompt.
    if (ctx && !e.isMeta && !String(e.origin?.kind ?? '').includes('notification')) {
      promptId = crypto.randomUUID()
      typed = e.command?.name
      push($, build.prompt(ctx, e.text.length, promptId, text(e.text)), { agent: 'main', kind: 'prompt.submit', detail: `${e.text.length} chars` })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (ctx) {
      const k = key(e.agentId)
      const a = agent(k)
      a.inTurn = true
      a.done = false
      turnOf.set(k, e.turnId)
      turnStart.set(k, stamp())
      if (!agentStart.has(k)) agentStart.set(k, stamp())
      push($, build.turnStart(ctx, { agentId: e.agentId, turnId: e.turnId }, k === 'main' ? promptId : undefined))
      if (k === 'main') for (const s of pendingTyped.splice(0)) push($, build.skillLoad(ctx, { turnId: e.turnId }, s), { agent: 'main', kind: 'skill.load', detail: `/${s.skill}` })
      else newestSub = k
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    // With content on, read the stream to keep the thinking; Claude Code may send it empty (docs/verified.md).
    let thinking = ''
    let r
    if (contentMode === 'full') {
      const stream = next(e)
      for await (const chunk of stream) {
        if (chunk.kind === 'thinking') thinking += chunk.text
        yield chunk
      }
      r = await stream.result
    } else r = yield* next(e)
    if (ctx && r.usage) {
      const k = key(e.agentId)
      const u = usageOf(r.usage)
      agentUsage.set(k, add(agentUsage.get(k) ?? zero, u))
      agentModel.set(k, r.usage.model ?? e.model)
      agent(k).tokens += tokensOf(u)
      push($, build.turnStep(ctx, { agentId: e.agentId, turnId: e.turnId }, r.usage.model ?? e.model, r.usage, r.stopReason, { answer: text(r.answer), thinking: text(thinking) }),
        { agent: label(k), kind: 'turn.step', detail: `${modelLabel(r.usage.model ?? e.model)} · ${fmtTokens(tokensOf(u))} tok` })
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (ctx) {
      const k = key(e.agentId)
      const a = agent(k)
      a.inTurn = false
      if (k === 'main') ctxPercent = (await $.session.usage().catch(() => undefined))?.context?.percent ?? ctxPercent
      push($, build.turnComplete(ctx, { agentId: e.agentId, turnId: e.turnId }, e.durationMs, e.usage, e.reason, e.answer.length, k === 'main' ? ctxPercent : undefined))
      // A subagent's run ends with its turn: a background agent's Agent tool call returned long before (docs/verified.md).
      if (e.agentId) {
        a.done = true
        push($, build.agentComplete(ctx, e.agentId, stamp() - (agentStart.get(k) ?? stamp()), agentUsage.get(k) ?? zero, e.answer.length),
          { agent: a.label, kind: 'agent.complete', detail: `${fmtTokens(a.tokens)} tok · ${dur(stamp() - (agentStart.get(k) ?? stamp()))}`, tone: 'dim' })
      }
    }
    return r
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (ctx && r.agentId) {
      const c = ctx
      const child = r.agentId
      const a = agent(child)
      a.label = e.subagentType
      agentModel.set(child, r.model)
      if (e.parentAgentId) parentOf.set(child, e.parentAgentId)
      else parentOf.set(child, 'main')
      const fields = {
        agentId: child, parentAgentId: e.parentAgentId, toolUseId: e.tool_use_id, type: e.subagentType,
        description: e.description, model: r.model, promptLength: e.prompt.length, prompt: text(e.prompt),
      }
      // The frontmatter read happens off the hook's path, so the spawn is never held up by it.
      void agentFile($, e.subagentType).catch((): AgentFile => ({ found: false })).then((file) => {
        // v0.2 slice 2: a fork always inherits its parent's model (the engine ignores one given for it), so it is never checked.
        const flag = e.fork ? undefined : modelCheck({ model: r.model, declared: file.model, ceiling: modelCeiling })
        const used = familyOf(r.model)
        if (flag && used) {
          a.pricier = { who: e.workflow && !file.found ? 'workflow agent' : e.subagentType, used, allowed: flag.allowed, source: flag.source }
          if (!notified.has(`pricier:${child}`)) {
            notified.add(`pricier:${child}`)
            void $.ui.notify(pricierNotice(a.pricier), { title: 'agent-orb: pricier model' }).catch(() => {})
          }
        }
        push($, build.agentSpawn(c, { ...fields, declaredRole: file.role, ...(flag && { declaredModel: file.model, modelCheck: flag }) }),
          { agent: label(key(e.parentAgentId)), kind: 'agent.spawn', detail: `${e.subagentType} · ${modelLabel(r.model)}` })
        void flush($) // a new agent shows at once too
      }).catch(() => {})
    }
    return r
  }).catch(($, e, next) => next(e))

  // A tool.check verdict `ask` is not a person: the mode may settle it with the auto-mode classifier or a host. The dialog
  // is classic.PermissionRequest (docs/verified.md); it carries no tool_use_id, so the agent's next in-flight call of that tool
  // is the one. ponytail: two identical tools asked at once may swap ids, both wait anyway; the flag lasts until the tool's
  // result, the engine has no event for the answer, so a long tool shows waiting for its whole run.
  on('classic.PermissionRequest', async ($, e, next) => {
    const r = await next(e)
    const k = key(e.agent_id)
    const tool = [...t.tools.values()].find((x) => x.agent === k && x.tool === e.tool_name && !x.waiting)
    if (ctx && !r.decision && tool) { // a settings hook that decided (allow or deny) asked nobody
      tool.waiting = true
      push($, build.toolWaiting(ctx, { agentId: e.agent_id, turnId: turnOf.get(k) }, tool.id, tool.tool),
        { agent: label(k), kind: 'tool.waiting', detail: `${tool.tool} · awaiting permission`, tone: 'wait' })
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (!ctx) return next(e)
    const c = ctx
    const k = key(e.agentId)
    const w = { agentId: e.agentId, turnId: turnOf.get(k) }
    const { tool, tool_use_id: id, agentId: _a, requestMeta: _m, ...input } = e as typeof e & Record<string, unknown>
    const since = stamp()
    agent(k, since)
    t.tools.set(id, { id, tool: String(tool), agent: k, since, waiting: false })
    if (tool === 'Skill') skillCalls.push(id)
    const content = contentMode === 'full' ? toolContent(String(tool), input, undefined) : undefined
    // v0.3 slice 1: the classes are worked out here, from the command and the result's text; only the class is sent, whatever Content is set to.
    const command = tool === 'Bash' && typeof input.command === 'string' ? commandClass(input.command) : undefined
    push($, build.toolCall(c, w, id, String(tool), JSON.stringify(input).length, content?.input, command), { agent: label(k), kind: 'tool.call', detail: String(tool) })
    try {
      const r = await next(e)
      const success = r.deny === undefined && r.isError !== true
      const out = contentMode === 'full' ? toolContent(String(tool), input, r.text ?? r.deny ?? '') : undefined
      push($, build.toolResult(c, w, {
        output: out?.output, outputSkipped: out?.output_skipped,
        toolUseId: id, success, errorType: r.deny !== undefined ? 'denied' : r.isError ? 'error' : undefined,
        errorClass: success ? undefined : errorClass(String(tool), r.deny ?? r.text ?? '', r.deny !== undefined),
        errorShape: success ? undefined : errorShape(String(tool), r.deny ?? r.text ?? '', command), // v0.3 slice 3 (#45): a short name or hash of the failure, never its text
        durationMs: stamp() - since, outputSize: (r.text ?? '').length, files: success ? filesTouched(String(tool), input, checkout) : [],
      }), { agent: label(k), kind: 'tool.result', detail: `${tool} ${success ? '✓' : '✗'} · ${dur(stamp() - since)}`, tone: success ? undefined : 'bad' })
      if (success) taskEvent($, c, w, String(tool), input, r.result)
      // v0.3 slice 2 (#42): a PR of this repository that a command printed (`gh pr create` ends with its URL) is this session's: only the number is sent.
      // Bash and MCP output only: a file or a page the session read can mention any PR, and reading it did not open them.
      if ((tool === 'Bash' || String(tool).startsWith('mcp__')) && r.text) {
        for (const n of prNumbersIn(r.text, c.project.git_remote)) {
          if (prLinked.has(n)) continue
          prLinked.add(n)
          push($, build.sessionPr(c, n), { agent: label(k), kind: 'session.pr', detail: `#${n}` })
        }
      }
      return r
    } finally {
      t.tools.delete(id)
      agent(k)
      if (tool === 'Skill') skillCalls.splice(skillCalls.indexOf(id), 1)
    }
  }).catch(($, e, next) => next(e))

  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    if (ctx) loadSkill($, e)
    return r
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    if (!ctx || e.agentId) return next(e)
    const before = (await $.session.usage().catch(() => undefined))?.context?.tokens ?? 0
    const r = await next(e)
    const after = (await $.session.usage().catch(() => undefined))?.context?.tokens ?? 0
    push($, build.sessionCompact(ctx, before, after), { agent: 'main', kind: 'session.compact', detail: `${fmtTokens(before)} → ${fmtTokens(after)}` })
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'orb' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'agent-orb', closeOnEscape: true })
    return { text: 'agent-orb panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const v = await read($, view)
    if (!v) return <Text dimColor>agent-orb is starting…</Text>
    const tone = (x?: string) => (x === 'bad' || x === 'stalled' ? 'red' : x === 'wait' || x === 'waiting' || x === 'pricier model' ? 'yellow' : undefined)
    return (
      <Box flexDirection="column">
        <Text><Text bold>{v.project}</Text>{v.branch ? ` · ${v.branch}` : ''} · {v.totals}</Text>
        {v.warning && <Text color="red">{v.warning}</Text>}
        <Text dimColor>ACTIVE AGENTS ({v.agents.filter((a) => a.state !== 'done').length})</Text>
        {v.agents.map((a) => (
          <Text color={tone(a.state)} dimColor={a.state === 'done'}>
            {`${'  '.repeat(Math.max(0, a.depth - 1))}${a.depth ? '└ ' : ''}${a.label}`.padEnd(18)} {a.model.padEnd(10)} {a.tool.padEnd(10)} {a.runningFor.padEnd(7)} {a.tokens.padStart(6)} {a.state === 'stalled' ? '⚠ stalled' : a.state}
          </Text>
        ))}
        <Text dimColor>LAST 10 EVENTS</Text>
        {v.events.map((x) => (
          <Text color={tone(x.tone)} dimColor={x.tone === 'dim'}>{x.time} {x.agent.padEnd(16)} {x.kind.padEnd(15)} {x.detail}</Text>
        ))}
        <Text dimColor>STUDIO</Text>
        <Text color="blue">{v.studio}</Text>
      </Box>
    )
  })
}
