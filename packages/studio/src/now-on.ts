import type { BoardIssue } from './Factory.tsx';
import { modelLabel } from './format.ts';
import type { Agent, Session } from './Live.tsx';
import { agentName, DELEGATES, sentence } from './live-cards.ts';

// Who is on an issue now (v0.5 slice 1, #66; moved here by #107 so the Map and Home read it the same way): worked out in the browser from the sessions Live shows and the board's session ids.

type Issue = Pick<BoardIssue, 'sessions' | 'ready'>;

/** The agents of the running sessions that reached the issue, those still going. */
function activeOn(issue: Issue, sessions: readonly Session[]) {
  const mine = new Set(issue.sessions.map((s) => s.id));
  return sessions.filter((s) => !s.endedAt && mine.has(s.id)).flatMap((s) => s.agents).filter((a) => a.state !== 'done' && a.state !== 'error');
}
const asks = (a: Agent) => a.state === 'waiting' && a.waitingFor === 'permission';
const rank = (a: Agent) => (a.state === 'stalled' ? 0 : asks(a) ? 1 : a.state === 'working' && !(a.tool && DELEGATES.has(a.tool.name)) ? 2 : 3);
const pick = (agents: Agent[]) => agents.toSorted((a, b) => rank(a) - rank(b) || b.lastTs - a.lastTs)[0];

/** The agent on an issue now that is named: the one that needs you, else one that is working; a main agent that only waits on its dispatched agents, or an agent that waits for its next prompt, comes last. */
export const agentOn = (issue: Issue, sessions: readonly Session[]) => pick(activeOn(issue, sessions));

/**
 * Who is on an issue now and the card's mark, from what the page already reads: the sessions Live shows (a running one that reached the issue, by the board's own list) and the board's row.
 * The agent named is the one that needs you, else one that is working (a main agent that only waits on the agents it dispatched comes last). The mark is `bad` when an agent on the issue is
 * stalled, `wait` when one waits for your OK to run a tool (the two that Live's Needs you lists), `ok` when the issue's PR is ready for your ok.
 */
export function nowOn(issue: Issue, sessions: readonly Session[]): { who?: { name: string; tone: string }; mark?: 'bad' | 'wait' | 'ok' } {
  const agents = activeOn(issue, sessions);
  const on = pick(agents);
  const mark = agents.some((a) => a.state === 'stalled') ? 'bad' : agents.some(asks) ? 'wait' : issue.ready ? 'ok' : undefined;
  return { ...(on ? { who: { name: agentName(on.type), tone: modelLabel(on.model).tone || 'other' } } : {}), ...(mark ? { mark } : {}) };
}

/** What that agent is doing, in Live's words for its row: `Needs your OK to run Bash`, `Edit src/a.ts`, `No progress`. None when no agent is on the issue. */
export function doingOn(issue: Issue, sessions: readonly Session[], now: number): string | undefined {
  const on = agentOn(issue, sessions);
  if (!on) return undefined;
  // the children are those of the session the agent is in: every session's main agent is called `main`
  const kids = sessions.find((s) => s.agents.includes(on))?.agents.filter((k) => k.parent === on.id) ?? [];
  const s = sentence(on, kids, now);
  return s.arg ? `${s.verb} ${s.arg}` : s.verb;
}
