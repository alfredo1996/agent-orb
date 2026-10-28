// The Office's logic (design/office.html, PROJECT.md §8.4): what each bot is doing and where it sits. Pure, for tests.

export type Activity = 'typing' | 'reading' | 'browsing' | 'thinking' | 'delegating' | 'waiting' | 'stalled' | 'done' | 'error';
type LiveAgent = {
  id: string; parent?: string; depth: number; type: string; model?: string; tokens: number; lastTs: number; startedAt: number;
  state: 'working' | 'waiting' | 'stalled' | 'done' | 'error'; waitingFor?: 'permission' | 'prompt'; tool?: { name: string; since: number };
};
type LiveSession = { id: string; project: string; tokens: number; cost: number; costPartial: boolean; contextPercent?: number; startedAt: number; agents: LiveAgent[] };

const READING = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const DELEGATING = new Set(['Agent', 'Task', 'Workflow']);

/** The live state first (waiting, stalled, done, error), then the tool: the monitor shows code, a page or a globe. */
export function activityOf(a: Pick<LiveAgent, 'state' | 'tool'>): Activity {
  if (a.state !== 'working') return a.state;
  const t = a.tool?.name;
  if (!t) return 'thinking';
  if (READING.has(t)) return 'reading';
  if (t.startsWith('Web') || /browser|chrome/i.test(t)) return 'browsing';
  if (DELEGATING.has(t)) return 'delegating';
  return 'typing'; // Edit, Write, Bash, and any other tool that acts
}

const PER_ROW = 8;
const DESK = 64; // seat pitch, in art pixels
const LEAD_Y = 82;
const ROW_Y = 168;
const ROW_H = 86;
const DONE_STAYS_MS = 60_000; // "done: green check, leaves after a while"

export type Seat = { key: string; session: string; agent: string; x: number; y: number; lead: boolean; model: string; activity: Activity; label: string; caption: string; state: LiveAgent['state'] };
export type Room = { project: string; width: number; height: number; tokens: number; cost: number; costPartial: boolean; contextPercent?: number; seats: Seat[]; lines: { from: string; to: string }[] };

const family = (m?: string) => /opus|sonnet|haiku/.exec(m ?? '')?.[0] ?? 'other';
const short = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };

const toolName = (t: string) => t.replace(/^mcp__.+?__/, ''); // mcp__Claude_Browser__navigate → navigate

/** The line under a desk: the tool and how long it has run, or what the bot waits for. */
const caption = (a: LiveAgent, now: number) =>
  a.state === 'done' || a.state === 'error' ? a.state
  : a.state === 'waiting' ? (a.tool ? `${toolName(a.tool.name)} · permission` : a.waitingFor === 'prompt' ? 'your prompt' : 'waiting')
  : a.tool ? `${toolName(a.tool.name)} ${short(now - a.tool.since)}` : 'thinking';

/** One room per project: each session's main on the top row, every other agent in rows of 8 below. */
export function officeLayout(sessions: LiveSession[], now: number): Room[] {
  const byProject = new Map<string, LiveSession[]>();
  for (const s of [...sessions].sort((a, b) => a.startedAt - b.startedAt)) byProject.set(s.project, [...(byProject.get(s.project) ?? []), s]);
  return [...byProject].map(([project, list]) => {
    const present = (a: LiveAgent) => a.state !== 'done' || now - a.lastTs < DONE_STAYS_MS;
    const leads = list.flatMap((s) => s.agents.filter((a) => a.depth === 0 && present(a)).map((a) => ({ s, a })));
    const others = list.flatMap((s) => s.agents.filter((a) => a.depth > 0 && present(a)).sort((x, y) => x.startedAt - y.startedAt).map((a) => ({ s, a })));
    const cols = Math.min(PER_ROW, Math.max(3, others.length, leads.length)); // 3: a room is never narrower than its header
    const width = cols * DESK + 40;
    const seat = ({ s, a }: { s: LiveSession; a: LiveAgent }, x: number, y: number, lead: boolean): Seat => ({
      key: `${s.id}:${a.id}`, session: s.id, agent: a.id, x, y, lead, model: family(a.model), activity: activityOf(a),
      label: a.depth === 0 ? 'main · orchestrator' : a.type,
      caption: caption(a, now), state: a.state,
    });
    const rowX = (i: number, n: number) => width / 2 - (n * DESK) / 2 + i * DESK + 6;
    const seats = [
      ...leads.map((l, i) => seat(l, rowX(i, leads.length), LEAD_Y, true)),
      ...others.map((o, i) => seat(o, rowX(i % PER_ROW, Math.min(PER_ROW, others.length - Math.floor(i / PER_ROW) * PER_ROW)), ROW_Y + Math.floor(i / PER_ROW) * ROW_H, false)),
    ];
    const rows = Math.max(1, Math.ceil(others.length / PER_ROW));
    const delegating = new Set(seats.filter((x) => x.activity === 'delegating').map((x) => x.key));
    const lines = list.flatMap((s) => s.agents.filter((a) => a.parent && present(a) && a.state !== 'done' && delegating.has(`${s.id}:${a.parent}`))
      .map((a) => ({ from: `${s.id}:${a.parent}`, to: `${s.id}:${a.id}` })));
    const latest = list.at(-1)!;
    return {
      project, width, height: others.length ? ROW_Y + rows * ROW_H - 30 : LEAD_Y + 62, seats, lines,
      tokens: list.reduce((n, s) => n + s.tokens, 0), cost: list.reduce((n, s) => n + s.cost, 0), costPartial: list.some((s) => s.costPartial),
      contextPercent: latest.contextPercent,
    };
  });
}
