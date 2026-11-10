import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { askFor, boardFor, linksFor, linksQuery, pinAfter, type Pin } from './board-view.ts';
import { MapBand, mapReading, type LinksData } from './FactoryMap.tsx';
import { usd } from './format.ts';
import { trapTab, usePhone } from './History.tsx';
import { PageHeader, ProjectSelect, Reading, Seg, useProject, type Said } from './kit.tsx';
import type { Session } from './Live.tsx';

// Factory (v0.4 slice 1, #27), drawn as approved in design/v0.4-factory.html, the Factory and Findings boards, from GET /api/factory: each open PR with the first
// reason it isn't ready for your ok, or "Ready for your ok", and its findings in a sheet. Nothing here merges: the merge stays yours.
// Slice 2 (#28) adds each PR's issue cost against its budget (the cost cell, the Budget card and the sheet's field), from GET and PUT /api/budget; every figure is an estimate and
// nothing is ever stopped. Slice 3 (#29) adds the Machine band (the Mac's free memory and its containers by project, from GET /api/machine) and a "Left running" row in Needs you for
// each group the server flags; nothing here removes a container. Slice 6 (#32) adds the Board band between Needs you and the Budget card, from GET /api/board: one milestone at a time, a row
// per issue with its stage on a track of seven, whether its PR is ready, its cost against its budget and its sessions with a link to Live. The board repeats no session's state.
// v0.5 slice 1 (#66) adds a Board and Map switch: the Map (FactoryMap.tsx) shows the board's issues by stage with the links between them, from GET /api/links, read only while the Map is open.

type Cond = { ok: boolean | null; note: string };
export type FactoryFinding = { id: string; severity: string; file: string; fate: 'open' | 'dismissed' | 'fixed'; title?: string; why?: string };
export type FactoryPr = {
  number: number; head: string | null; issue?: number | null; headOid: string; ready: boolean; reason: string | null; dropped: number;
  conditions: { findings: Cond; gate: Cond; bots: Cond; clean: Cond }; findings: FactoryFinding[];
};
export type FactoryData = { project: string; readAt: number | null; prs: FactoryPr[] };
type OpenSheet = (pr: number, from: HTMLElement) => void;
/** An issue's cost, estimated by time windows, with its budget (the issue's own, else its milestone's) and whether it has reached 80% (`at80`) or the budget (`at100`). */
export type IssueCost = {
  number: number; milestone: string | null; usd: number; partial: boolean; whole: number; windows: number; budget: number | null; milestoneBudget: number | null; source: 'issue' | 'milestone' | null; mark: 'at80' | 'at100' | null;
};
export type BudgetData = { project: string; month: string; issues: IssueCost[]; notOnIssue: { usd: number; partial: boolean }; milestones: { name: string; budget: number | null }[] };
/** The stages of an issue, in order (the server works one out from what the agents did): the board's track has a segment for each. */
export const STAGES = ['queued', 'building', 'reviewing', 'fixing', 'gate', 'ready', 'merged'] as const;
export type BoardStage = (typeof STAGES)[number];
/** One issue of GET /api/board. `pr` is its newest open PR, else its merged one; `ready` and `reason` are that open PR's (slice 1); `sessions` are the newest that reached it, `sessionCount` all of them. Its cost is /api/budget's. */
export type BoardIssue = {
  number: number; title?: string; milestone?: string | null; outside: boolean; stage: BoardStage; bad?: true; pr: { number: number; head: string | null; merged: boolean } | null; ready: boolean | null; reason: string | null;
  sessions: { id: string; at: number }[]; sessionCount: number;
};
/** `content` is the Content mode of the project's newest session that recorded one: what the page says about titles. A `milestone` absent on an issue means no read of the open issues has seen it; null, that it has none. */
export type BoardData = { project: string; milestone: string | null; content: 'off' | 'full' | 'excluded' | null; milestones: { name: string; open: number }[]; issues: BoardIssue[] };
/** A group of containers on the Mac, as GET /api/machine groups and flags them (v0.4 slice 3, #29). `project` is the agent-orb project it belongs to, when it reaches one; `id` is the group's own
 * (a host's, so it keys a row); `since` is when its oldest container was made. */
export type MachineGroup = {
  id: string; kind: 'compose' | 'testcontainers' | 'none' | 'excluded'; name: string; project: string | null; compose: string | null; containers: number; memory: number;
  unhealthy: number; leftRunning: boolean; idleMs: number | null; since: number | null;
};
export type MachineHost = { host: string; at: number; ageMs: number; docker: 'ok' | 'absent' | 'stopped'; memFree: number | null; memTotal: number | null; containers: number; memory: number; groups: MachineGroup[] };
export type MachineData = { hosts: MachineHost[] };
/** Saves a budget (null removes it) and answers the server's words when it refused, or nothing. */
type Save = (target: { milestone: string } | { issue: number }, usd: number | null) => Promise<string | undefined>;

const REFRESH_MS = 30_000; // the plugin reads GitHub every 5 minutes; the page asks more often so a fresh read shows soon after it lands
const STALE_MS = 10 * 60_000; // two reads missed: no session is reading this repo now
const MIN = 60_000;
const MACHINE_STALE_MS = 30 * MIN; // a sample older than this says when it was read: the plugin samples while a session runs
const short = (oid: string) => oid.slice(0, 7);
const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const CONDITIONS = [['findings', 'No finding is open'], ['gate', 'The gate passed on this head'], ['bots', 'No bot comment is newer than the last commit'], ['clean', 'Merge state is CLEAN']] as const;

/** The state a PR shows: from the first condition that does not hold, as its reason is. All four holding on data too old to trust (the server's call) is not known. */
function stateOf(p: FactoryPr): { tone: 'working' | 'stalled' | 'waiting'; label: string } {
  if (p.ready) return { tone: 'working', label: 'Ready' };
  const first = Object.entries(p.conditions).find(([, c]) => c.ok !== true);
  if (!first || first[1].ok === null) return { tone: 'waiting', label: 'Not known' };
  return { tone: 'stalled', label: first[0] === 'findings' ? 'Open findings' : 'Blocked' };
}

export const ageText = (readAt: number, now: number) => {
  const m = Math.max(0, Math.floor((now - readAt) / MIN));
  return `GitHub data ${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h`} old`;
};

/** How old the open-PR read is. The plugin is what reads GitHub, so old data means no session runs in this repo. */
export function Asof({ readAt, now }: { readAt: number | null; now: number }) {
  if (readAt === null) return <span className="asof stale">No GitHub data yet: the plugin reads it while a session runs in this repo, with gh logged in</span>;
  const stale = now - readAt > STALE_MS;
  return <span className={stale ? 'asof stale' : 'asof'}>{ageText(readAt, now)}{stale && ': it updates while a session runs in this repo'}</span>;
}

/** The reading on top: what the band below adds up to. */
export function factoryReading(d: FactoryData): Said {
  if (!d.prs.length) return [d.readAt === null ? 'Nothing read from GitHub for ' : 'No open PR in ', { b: d.project }, '.'];
  const ready = d.prs.filter((p) => p.ready).length;
  const open = d.prs.filter((p) => p.conditions.findings.ok === false).length;
  const said: Said = [{ b: count(ready, 'PR') }, ` ${ready === 1 ? 'is' : 'are'} ready for your ok`];
  if (ready < d.prs.length) said.push(', ', { b: String(d.prs.length - ready) }, ` ${d.prs.length - ready === 1 ? "isn't" : "aren't"}`);
  if (open) said.push(': ', { b: count(open, 'PR') }, ` with open findings`);
  said.push('.');
  return said;
}

/** What a budget field holds, as the server wants it (above 0, at most 1,000,000), or nothing at all, which removes the budget; else what is wrong with it. */
export function budgetInput(text: string): { usd: number | null } | { error: string } {
  if (!text.trim()) return { usd: null };
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return { error: 'Give a number of dollars above 0, or leave it empty to remove the budget' };
  return n > 1_000_000 ? { error: 'A budget is at most $1,000,000' } : { usd: n };
}

/** An issue's cost against its budget: the figure (a floor when a request had no price), a bar, and how far it is. The bar's colour is the server's mark, never a percent worked out here. */
export function CostCell({ issue, cost }: { issue: number | null | undefined; cost?: IssueCost }) {
  const lab = <span className="lab">Cost, estimate</span>;
  if (!issue) return <div className="costcell">{lab}<span className="why none">No issue</span></div>;
  if (!cost || (cost.usd === 0 && !cost.partial)) return <div className="costcell">{lab}<span className="why none">Nothing spent</span></div>;
  if (cost.budget === null) return <div className="costcell">{lab}<span className="num">{usd(cost.usd, cost.partial)}</span><small>No budget set</small></div>;
  const pct = Math.round((100 * cost.usd) / cost.budget);
  const note = cost.mark === 'at100' ? `${pct}% of the budget: reached, nothing is stopped` : cost.mark === 'at80' ? `${pct}% of the budget: nearly spent` : `${pct}% of the budget`;
  return (
    <div className="costcell">
      {lab}<span className="num">{usd(cost.usd, cost.partial)} of {usd(cost.budget)}</span>
      <div className={cost.mark === 'at100' ? 'bar over' : cost.mark === 'at80' ? 'bar warn' : 'bar'} role="img" aria-label={`${pct}% of the budget`}><i style={{ width: `${Math.min(pct, 100)}%` }} /></div>
      <small>{note}</small>
    </div>
  );
}

/** One budget: a dollar amount to save, or to leave empty and save to remove. `value` is what is stored; a refusal shows the server's words. */
function BudgetField({ label, value, placeholder, onSave }: { label: string; value: number | null; placeholder?: number | null; onSave: (usd: number | null) => Promise<string | undefined> }) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]); // what the server holds, after a save or a fresh read
  const typed = budgetInput(draft);
  const problem = error ?? ('error' in typed ? typed.error : undefined);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if ('error' in typed || busy) return;
    setBusy(true);
    setError(await onSave(typed.usd));
    setBusy(false);
  };
  return (
    <form className="bfield" noValidate onSubmit={submit}>
      <span className="blab">{label}</span>
      <span className="bin">
        <span aria-hidden="true">$</span>
        <input aria-label={label} type="number" inputMode="decimal" min="0" step="any" placeholder={placeholder ? String(placeholder) : 'None'} value={draft} aria-invalid={!!problem}
          onChange={(e) => { setDraft(e.target.value); setError(undefined); }} />
        <button type="submit" className="btn primary" disabled={busy || 'error' in typed || typed.usd === value}>Save</button>
      </span>
      {problem && <p className="gerr" role="alert">{problem}</p>}
    </form>
  );
}

/** What the milestones' defaults are and where to set them. The numbers and warnings are the server's; the month's spend on no issue is on the board (#32). */
export function BudgetCard({ data, onSave }: { data: BudgetData; onSave: Save }) {
  const own = data.issues.filter((i) => i.source === 'issue');
  const none = !own.length && data.milestones.every((m) => m.budget === null);
  return (
    <section className="card budget" aria-labelledby="fbudget-h">
      <h2 id="fbudget-h">Budget per issue <span className="hint">warns at 80% and 100%, never stops anything</span></h2>
      <div className="bbody">
        {!data.milestones.length && <p className="dnote">No open issue has a milestone, so there is no default to set. An issue's own budget is on its PR's sheet.</p>}
        {data.milestones.map((m) => <BudgetField key={m.name} label={`Default for ${m.name}`} value={m.budget} onSave={(u) => onSave({ milestone: m.name }, u)} />)}
        {none && <span className="sub">No budget is set, so rows show cost only and nothing warns.</span>}
        {own.length > 0 && (
          <span className="sub">{own.length === 1 ? 'One issue has its own budget' : `${own.length} issues have their own budget`}: {own.map((i) => `#${i.number}, ${usd(i.budget!)}`).join('; ')}. Set it on the PR's sheet.</span>
        )}
      </div>
    </section>
  );
}

/** The PR sheet's cost: where the issue's money went, and its own budget (which beats the milestone's). */
function CostSection({ issue, cost, onSave }: { issue: number | null | undefined; cost?: IssueCost; onSave: Save }) {
  if (!issue) return <section className="dsec"><h4>Cost, estimate</h4><p className="dnote">This PR closes no issue, so its cost is on "not on an issue".</p></section>;
  const c = cost ?? { number: issue, milestone: null, usd: 0, partial: false, whole: 0, windows: 0, budget: null, milestoneBudget: null, source: null, mark: null };
  const dflt = c.milestoneBudget; // known beside the issue's own budget: it is what removing that gives back
  return (
    <section className="dsec">
      <h4>Cost, estimate</h4>
      <div className="ledger2">
        {c.whole > 0 && <div><span className="sub">On the issue's branch, whole</span><span className="num">{usd(c.whole)}</span></div>}
        {c.windows > 0 && <div><span className="sub">Turns before a PR opened, in a longer session</span><span className="num">{usd(c.windows)}</span></div>}
        {c.usd === 0 && !c.partial && <span className="sub">Nothing spent yet</span>}
        {c.partial && <span className="sub">At least this much: a request on a model with no price adds nothing.</span>}
      </div>
      <BudgetField label="Budget for this issue" value={c.source === 'issue' ? c.budget : null} placeholder={dflt} onSave={(u) => onSave({ issue }, u)} />
      <span className="sub">{dflt !== null ? `Milestone default: ${usd(dflt)}` : 'No milestone default'}</span>
    </section>
  );
}

export const STAGE_LABEL: Record<BoardStage, string> = { queued: 'Queued', building: 'Building', reviewing: 'Reviewing', fixing: 'Fixing', gate: 'Gate', ready: 'Ready', merged: 'Merged' };

/** Seven segments, one a stage: those before the issue's stage lit, its own marked, green once the issue is ready or merged, red when the test run or a check on its head failed. */
function Track({ stage, bad }: { stage: BoardStage; bad?: true }) {
  const at = STAGES.indexOf(stage);
  return (
    <span className={stage === 'ready' || stage === 'merged' ? 'trk good' : bad ? 'trk bad' : 'trk'} role="img" aria-label={`Stage ${at + 1} of ${STAGES.length}: ${STAGE_LABEL[stage]}${bad ? ', failed' : ''}`}>
      {STAGES.map((s, i) => <i key={s} className={i < at ? 'on' : i === at ? 'now' : ''} />)}
    </span>
  );
}

/**
 * The issue's sessions: a link to Live for each one Live shows (a session that ended more than ten minutes ago is not there, so it is counted, not linked). The link carries the project so the page
 * you come back to is the one you left. The state of a session is Live's, never repeated here; and no session is marked as a background one, since the plugin cannot tell (a real `claude --bg`
 * session is recorded as interactive, #32): the band's footer says where those are.
 */
function SessionsCell({ issue, live, project }: { issue: BoardIssue; live: ReadonlySet<string>; project: string }) {
  const here = issue.sessions.filter((s) => live.has(s.id));
  const earlier = issue.sessionCount - here.length;
  return (
    <div>
      <span className="lab">Sessions</span>
      <div className="links">
        {here.map((s) => <a key={s.id} href={`#/live?session=${encodeURIComponent(s.id)}&project=${encodeURIComponent(project)}`}>{here.length > 1 ? `Live ${s.id.slice(0, 6)}` : 'Live'}</a>)}
        {earlier > 0 && <span className="none">{earlier} earlier</span>}
        {issue.sessionCount === 0 && <span className="none">None</span>}
      </div>
    </div>
  );
}

/** Why an issue is on the board though it is not in the chosen milestone: in flight, and which milestone it is in when that is known (null: it has none; absent: no read has seen it). */
export const outsideNote = (i: BoardIssue, chosen: string | null) =>
  !i.outside ? '' : chosen === null ? ` · in flight${i.milestone ? `, ${i.milestone}` : ''}` : ` · outside this milestone${i.milestone === undefined ? '' : `, ${i.milestone ?? 'in none'}`}`;

function BoardRow({ issue: i, chosen, project, live, openable, cost, onOpen }: { issue: BoardIssue; chosen: string | null; project: string; live: ReadonlySet<string>; openable: ReadonlySet<number>; cost?: ReadonlyMap<number, IssueCost>; onOpen: OpenSheet }) {
  const name = <b>{`#${i.number}${i.title ? ` ${i.title}` : ''}`}</b>;
  const open = i.pr && !i.pr.merged && openable.has(i.pr.number) ? i.pr.number : undefined; // an open PR the page holds: its sheet has the four checks, the findings and the budget
  const ready = i.pr?.merged ? <span className="why none">Merged</span> : !i.pr ? <span className="why none">No PR yet</span>
    : i.ready ? <span className="why yes">Ready for your ok</span> : <span className="why no">{i.reason ?? 'Not ready'}</span>;
  return (
    <div className={i.stage === 'merged' ? 'brow merged' : 'brow'} data-issue={i.number}>
      <div className="bissue">
        {open !== undefined
          ? <button type="button" className="open" aria-label={`Issue #${i.number}: see the checks of PR #${open}`} onClick={(e) => onOpen(open, e.currentTarget)}>{name}</button>
          : name}
        <small>{i.pr ? `PR #${i.pr.number}${i.pr.merged ? ', merged' : ''}` : 'No PR'}{outsideNote(i, chosen)}</small>
      </div>
      <div className="stagecell"><span>{STAGE_LABEL[i.stage]}</span><Track stage={i.stage} bad={i.bad} /></div>
      <div><span className="lab">Ready</span>{ready}</div>
      {cost ? <CostCell issue={i.number} cost={cost.get(i.number)} /> : <div />}
      <SessionsCell issue={i} live={live} project={project} />
    </div>
  );
}

/** What this month spent on no issue (slice 2's line, from the page's /api/budget read): under the board's rows, and under its error when the board could not be read. */
function NotOnIssue({ data }: { data: BudgetData['notOnIssue'] }) {
  return (
    <div className="notissue">
      <span>Not on an issue: <b className="num">{usd(data.usd, data.partial)}</b> this month</span>
      <span className="sub">Sessions with no PR, and turns after a session's last PR. Cost is an estimate by time windows.</span>
    </div>
  );
}

/** Why no issue carries a title, once: Content is not on full, or the project is excluded and sends none. Nothing with Content on full (an issue no read has seen has none either). */
export const titlesNote = (data: BoardData) =>
  !data.issues.some((i) => !i.title) || data.content === 'full' ? null : data.content === 'excluded' ? 'This project is in excludeProjects: issues show by number.' : 'Issue titles show with Content on full.';

/**
 * The Board band (v0.4 slice 6, #32): one milestone's open issues, its closed ones whose PR merged, and any issue a session reached this week outside it whose PR has not merged, each with the stage the
 * server worked out from what the agents did, whether its PR is ready, its cost against its budget and its sessions. The cost is /api/budget's, read once for the page and joined by issue number (`cost`; until it
 * is read the cells are empty rather than "nothing spent"); under the rows, what this month spent on no issue, which is that read's too and so stays when the board could not be read (`error`, with `data` the
 * last answer for the milestone asked for, if any). A title shows only if the plugin sent it (Content on full).
 */
export function BoardBand({ data, error, live, openable, cost, notOnIssue, onOpen }: { data?: BoardData; error?: string; live: ReadonlySet<string>; openable: ReadonlySet<number>; cost?: ReadonlyMap<number, IssueCost>; notOnIssue?: BudgetData['notOnIssue']; onOpen: OpenSheet }) {
  const inside = data ? data.issues.filter((i) => !i.outside).length : 0;
  const outside = data ? data.issues.length - inside : 0;
  const note = data && titlesNote(data);
  return (
    <section className="card board" aria-labelledby="fboard-h">
      <h2 id="fboard-h">Board{data?.milestone != null && ` · ${data.milestone}`} {data && data.issues.length > 0 && <span className="hint">{data.milestone === null ? `${outside} in flight` : `${count(inside, 'issue')}${outside > 0 ? `, plus ${outside} in flight outside it` : ''}`}</span>}</h2>
      {error && <p className="nothing" role="alert">The board could not be read: {error}</p>}
      {data && (data.issues.length === 0
        ? (!error && <p className="nothing">{data.milestone !== null ? `No open issue in ${data.milestone}, and none in flight.` : data.content === 'excluded'
          ? 'This project is in excludeProjects, so the plugin sends no milestones: nothing to follow here but the issues a session is working on.'
          : 'No open issue has a milestone, so there is nothing to follow yet. The plugin reads the open issues from GitHub while a session runs in this repo, with gh logged in.'}</p>)
        : (
          <>
            <div className="bcols" aria-hidden="true"><span>Issue</span><span>Stage</span><span>Ready</span><span>Cost, estimate</span><span>Sessions</span></div>
            {data.issues.map((i) => <BoardRow key={i.number} issue={i} chosen={data.milestone} project={data.project} live={live} openable={openable} cost={cost} onOpen={onOpen} />)}
          </>
        ))}
      {notOnIssue && <NotOnIssue data={notOnIssue} />}
      {note && <div className="bnote">{note}</div>}
      <div className="bnote">Agent view lists sessions. This lists issues, with what each has spent and how far it is from your ok. A background session is answered in agent view: <code>claude agents</code>.</div>
    </section>
  );
}

/** The header's milestone slot: the milestones with an open issue, the one shown selected. A milestone asked for that has none (every issue of it closed) is still listed, as the one shown. */
export function MilestoneSelect({ milestones, value, onChange }: { milestones: { name: string; open: number }[]; value: string | null; onChange: (name: string) => void }) {
  return (
    <select aria-label="Milestone" value={value ?? ''} disabled={!milestones.length} onChange={(e) => onChange(e.target.value)}>
      {value !== null && !milestones.some((m) => m.name === value) && <option value={value}>{value}</option>}
      {milestones.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
    </select>
  );
}

const GIB = 1024 ** 3;
/** Bytes as the Mac says them, in 1024s: `6.2 GB`, `36 GB`, `92 MB`. */
export const memText = (bytes: number) =>
  bytes >= GIB ? `${bytes >= 9.95 * GIB ? Math.round(bytes / GIB) : (bytes / GIB).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${Math.round(bytes / 1024)} KB`;
/** How long a project went without an event, as the row says it: `45 min`, `2 h`, `3 days`. */
export const idleText = (ms: number) => {
  const m = Math.floor(ms / MIN);
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} days`;
};
const readAgo = (ms: number) => (ms < MIN ? 'read just now' : `read ${idleText(ms)} ago`);

/** A group the server flagged "Left running", with the Mac it is on, when that Mac's sample was read, and whether the page has more than one Mac (so the row names it). */
export type Left = { group: MachineGroup; host: string; at: number; named: boolean };
/** The groups the server flagged "Left running", across the hosts: each is a row in Needs you. The server flags only containers a test run left behind, and never a group with no project; an unhealthy one is flagged in the band alone. */
export const leftRunning = (data?: MachineData): Left[] => {
  const hosts = data?.hosts ?? [];
  return hosts.flatMap((h) => h.groups.filter((g) => g.leftRunning).map((group) => ({ group, host: h.host, at: h.at, named: hosts.length > 1 })));
};

const bandId = (host: string) => `machine-${host}`;
const seeMachine = (host: string) => {
  const band = document.getElementById(bandId(host));
  band?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  band?.focus({ preventScroll: true });
};

/** Each open PR, worst first (the server's order): its state, the first reason it isn't ready or "Ready for your ok", its issue's cost once read, and its dismissed findings to read. */
export function NeedsYou({ prs, costs, onOpen, left = [], now = Date.now() }: { prs: FactoryPr[]; costs?: Map<number, IssueCost>; onOpen: OpenSheet; left?: Left[]; now?: number }) {
  return (
    <section className={costs ? 'card needs withcost' : 'card needs'} aria-labelledby="fneeds-h">
      <h2 id="fneeds-h">Needs you</h2>
      {!prs.length && !left.length && <p className="nothing">Nothing needs you.</p>}
      {prs.map((p) => {
        const s = stateOf(p);
        const open = p.findings.filter((f) => f.fate === 'open').length;
        const dismissed = p.findings.filter((f) => f.fate === 'dismissed').length;
        return (
          <div key={p.number} className="need">
            <span className={`state ${s.tone}`}>{s.label}</span>
            <span className="what">
              <b>PR #{p.number}</b>{p.head && <> <code>{p.head}</code></>}
              <span className="sub">{p.reason ?? 'Ready for your ok'}{dismissed > 0 && ` · ${dismissed} dismissed: read ${dismissed === 1 ? 'it' : 'them'} before merging`}</span>
            </span>
            {costs && <CostCell issue={p.issue} cost={p.issue ? costs.get(p.issue) : undefined} />}
            <span className="since num">{open ? `${open} open` : short(p.headOid)}</span>
            <button type="button" className={p.ready ? 'btn primary' : 'btn'} onClick={(e) => onOpen(p.number, e.currentTarget)}>{open ? 'See findings' : 'See checks'}</button>
          </div>
        );
      })}
      {left.map(({ group: g, host, at, named }) => (
        <div key={g.id} className="need">
          <span className="state waiting">Left running</span>
          <span className="what">
            <b>{g.name}: {count(g.containers, 'container')}</b>
            <span className="sub">{leftText(g, host, at, named, now)}</span>
          </span>
          {costs && <span />}
          <span className="since num">{memText(g.memory)}</span>
          <button type="button" className="btn" onClick={() => seeMachine(host)}>See machine</button>
        </div>
      ))}
    </section>
  );
}

/** Under a "Left running" row's name: when its run began, how long its project has been quiet (at the sample), which Mac when there are several, and how old the sample is once it is not fresh. */
const leftText = (g: MachineGroup, host: string, at: number, named: boolean, now: number) => {
  const parts = [g.since === null ? 'No session' : `Run started ${idleText(now - g.since)} ago, no session`];
  parts[0] += ` in that project for ${idleText(g.idleMs ?? 0)}`;
  if (named) parts.push(`on ${host}`);
  if (now - at > MACHINE_STALE_MS) parts.push(readAgo(now - at));
  return parts.join(', ');
};

/** What a group is, under its name: how it was started and, for a Testcontainers run, when; and how long its project has been quiet when it is left running. */
const howText = (g: MachineGroup, now: number) => {
  if (g.kind === 'testcontainers') {
    return ['Testcontainers', ...(g.since === null ? [] : [`started ${idleText(now - g.since)} ago`]), ...(g.project ? [] : ['no test run was going when it started']),
      ...(g.leftRunning ? [`no session for ${idleText(g.idleMs ?? 0)}`] : [])].join(', ');
  }
  return g.kind === 'compose' ? (g.project ? (g.compose === g.project ? 'compose' : `compose ${g.compose}`) : 'compose, not an agent-orb project')
    : g.kind === 'excluded' ? 'names left out, as the project is excluded' : 'started by hand';
};

/**
 * One Mac's band (v0.4 slice 3, #29): its free memory, what its containers use, and one row per group of containers with its flags. Nothing here removes a container: the clean-up stays
 * yours. With Docker absent or stopped it says so beside the memory; a sample older than 30 minutes says when it was read, since the plugin only samples while a session runs.
 */
export function MachineBand({ host, now }: { host: MachineHost; now: number }) {
  const age = now - host.at;
  const stale = age > MACHINE_STALE_MS;
  return (
    <section className="card machine" id={bandId(host.host)} tabIndex={-1} aria-labelledby={`fmachine-${host.host}`}>
      <h2 id={`fmachine-${host.host}`}>Machine <span className={stale ? 'hint stale' : 'hint'}>{host.host} · {readAgo(age)}{stale && ': it updates while a session runs'}</span></h2>
      <div className="mstats">
        <div className="mstat"><span className="k">Free memory</span>{host.memFree === null ? <span className="v">Not read</span> : <span className="v">{memText(host.memFree)}</span>}{host.memTotal !== null && <span className="d">of {memText(host.memTotal)}</span>}</div>
        {host.docker === 'ok' ? (
          <>
            <div className="mstat"><span className="k">Containers</span><span className="v">{host.containers}</span><span className="d">running</span></div>
            <div className="mstat"><span className="k">They use</span><span className="v">{memText(host.memory)}</span><span className="d">by <code>docker stats</code></span></div>
          </>
        ) : <p className="mdown">Docker isn't running, so no containers to list.</p>}
      </div>
      {host.docker === 'ok' && !host.groups.length && <p className="nothing">No container is running.</p>}
      {host.groups.length > 0 && (
        <>
          <div className="mrow head"><span>Project</span><span className="r">Containers</span><span className="r">Memory</span></div>
          {host.groups.map((g) => (
            <div key={g.id} className="mrow">
              <span className="nm">
                {g.name}
                {g.leftRunning && <span className="flag left">Left running</span>}
                {g.unhealthy > 0 && <span className="flag sick">{g.unhealthy > 1 ? `${g.unhealthy} unhealthy` : 'Unhealthy'}</span>}
                <span className="sub">{howText(g, now)}</span>
              </span>
              <span className="r num">{g.containers}</span>
              <span className="r num">{memText(g.memory)}</span>
            </div>
          ))}
          <div className="mfoot">agent-orb lists containers and never removes one: the clean-up stays yours.</div>
        </>
      )}
    </section>
  );
}

/**
 * The page's Machine part: one band per Mac. It is the Mac's, not the project's, so it stands whatever Factory's own read did. With no sample in the last 24 hours it says so, and when the server
 * could not answer it says that: an old plugin (it sends none) or an old server (it has no route) is then not taken for an idle Mac. A failed read after a good one keeps the good one.
 */
export function MachineBands({ data, error, now }: { data?: MachineData; error?: string; now: number }) {
  if (data?.hosts.length) return <>{data.hosts.map((h) => <MachineBand key={h.host} host={h} now={now} />)}</>;
  if (!data && !error) return null;
  return (
    <section className="card machine" aria-labelledby="fmachine-none">
      <h2 id="fmachine-none">Machine</h2>
      <p className="nothing">
        {data ? 'Not sampled yet. The plugin samples this Mac while a session runs, and none has for 24 hours. An older plugin or server takes none: update both.' : `The machine could not be read: ${error}`}
      </p>
    </section>
  );
}

function Row({ f }: { f: FactoryFinding }) {
  return (
    <div className="fnd">
      <span className="id">{f.id}</span><span className={`sev ${f.severity}`}>{f.severity}</span><span className="file">{f.file}</span>
      {f.title ? <span className="ttl">{f.title}</span> : <span className="ttl off">Title needs Content on full</span>}
      {f.why && <span className="why2">Why dismissed: {f.why}</span>}
    </div>
  );
}

/** One PR's sheet: can it merge (the four conditions), then its findings: open, dismissed (read these before merging), and fixed, folded. */
export function PrSheet({ pr, readAt, now, sheet, onClose, cost, onSave }: { pr: FactoryPr; readAt: number | null; now: number; sheet: boolean; onClose: () => void; cost?: IssueCost; onSave?: Save }) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => box.current?.focus(), []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [onClose]);
  const s = stateOf(pr);
  const of = (fate: FactoryFinding['fate']) => pr.findings.filter((f) => f.fate === fate);
  const [open, dismissed, fixed] = [of('open'), of('dismissed'), of('fixed')];
  const unreported = !pr.findings.length && pr.conditions.findings.ok === null && !pr.dropped;
  return (
    <aside ref={box} tabIndex={-1} className={sheet ? 'drawer sheet factory-sheet' : 'drawer factory-sheet'} role="dialog" aria-modal="true" aria-labelledby="f-name" onKeyDown={(e) => trapTab(box.current!, e)}>
      <div className="dh">
        <div className="r1">
          <h3 id="f-name">PR #{pr.number}</h3>
          <span className={`state ${s.tone}`}>{s.label}</span>
          <button type="button" className="x" aria-label="Close the PR" onClick={onClose}>×</button>
        </div>
        {pr.head && <div className="dfacts"><code>{pr.head}</code></div>}
      </div>
      <div className="dbody">
        <section className="dsec">
          <h4>Can it merge?</h4>
          <ul className="cond">
            {CONDITIONS.map(([k, name]) => {
              const c = pr.conditions[k];
              return (
                <li key={k} className={c.ok === true ? 'ok' : c.ok === false ? 'no' : 'unk'}>
                  <span className="mk" aria-hidden="true">{c.ok === true ? '✓' : c.ok === false ? '✗' : '?'}</span>
                  <span>{name}<small>{c.note}</small></span>
                </li>
              );
            })}
          </ul>
          <span className="sub">{readAt === null ? 'No GitHub data yet' : ageText(readAt, now)} · head {short(pr.headOid)}</span>
        </section>
        <section className="dsec">
          <h4>Findings</h4>
          {pr.dropped > 0 && <p className="dnote">{count(pr.dropped, 'line')} of the last report didn't parse: ask the reviewer to report it again.</p>}
          {unreported && <p className="dnote">No <code>orb-findings</code> block has reached this PR's branch yet, so ready can't be proved.</p>}
          {!pr.findings.length && !unreported && <p className="dnote">Reported, none found.</p>}
          {open.length > 0 && <div className="fgroup"><h5>Open ({open.length})</h5>{open.map((f) => <Row key={f.id} f={f} />)}</div>}
          {dismissed.length > 0 && <div className="fgroup"><h5>Dismissed: read these before merging ({dismissed.length})</h5>{dismissed.map((f) => <Row key={f.id} f={f} />)}</div>}
          {fixed.length > 0 && <details className="fgroup"><summary>Fixed ({fixed.length})</summary>{fixed.map((f) => <Row key={f.id} f={f} />)}</details>}
        </section>
        {onSave && <CostSection issue={pr.issue} cost={cost} onSave={onSave} />}
      </div>
    </aside>
  );
}

const NO_SESSIONS: readonly Session[] = [];

/** `live`: the sessions Live shows right now, which the board's links can reach. `sessions`: the same sessions with their agents, for the Map's "who is on it now". */
export function Factory({ now, live, sessions = NO_SESSIONS }: { now: number; live: ReadonlySet<string>; sessions?: readonly Session[] }) {
  const { project, projects } = useProject(true); // one project: the page reads one repo's PRs
  const [data, setData] = useState<FactoryData>();
  const [budget, setBudget] = useState<BudgetData>();
  const [board, setBoard] = useState<BoardData>();
  const [boardError, setBoardError] = useState<string>();
  const [chosen, setChosen] = useState<{ project: string; milestone: string }>(); // the milestone picked, for the project it was picked in; none: the server's choice
  const [machine, setMachine] = useState<MachineData>();
  const [machineError, setMachineError] = useState<string>();
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<number>();
  const [view, setView] = useState<'board' | 'map'>('board'); // ponytail: kept in the page, so a reload opens on Board. In the hash when another page links to a milestone's Map (#64, Home).
  const [links, setLinks] = useState<LinksData>();
  const [linksError, setLinksError] = useState<string>();
  const [pressed, setPressed] = useState<number>(); // the Map's pressed card
  const opener = useRef<HTMLElement>(null);
  const phone = usePhone();

  useEffect(() => {
    if (!project) return;
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/factory?${new URLSearchParams({ project })}`);
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        const body = (await res.json()) as FactoryData;
        if (live) setData(body), setError(undefined);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
      try { // the cost is a second read: a failure leaves the PRs showing, with no cost cell
        const res = await fetch(`/api/budget?${new URLSearchParams({ project, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })}`);
        if (res.ok && live) setBudget((await res.json()) as BudgetData);
      } catch { /* the next read tries again */ }
      try { // and the machine a third: it is the Mac's, not the project's, so a failure leaves the rest as it was, and says so
        const res = await fetch('/api/machine');
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        const body = (await res.json()) as MachineData;
        if (live) setMachine(body), setMachineError(undefined);
      } catch (e) {
        if (live) setMachineError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [project]);

  // The board is its own read: the milestone changes it alone, and a failure leaves the rest of the page as it was. The milestone asked for is the one picked, else the one the server chose
  // the first time (kept: its default is worked out afresh at every read and could move to another milestone while you watch; a reload chooses again).
  const milestone = chosen?.project === project ? chosen.milestone : undefined;
  const pin = useRef<Pin>(undefined);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    const load = async () => {
      try {
        const ask = askFor(milestone, pin.current, project);
        const res = await fetch(`/api/board?${new URLSearchParams({ project, ...(ask ? { milestone: ask } : {}) })}`);
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        const body = (await res.json()) as BoardData;
        if (alive) {
          pin.current = pinAfter(ask, body, project, pin.current);
          setBoard(body), setBoardError(undefined);
        }
      } catch (e) {
        if (alive) setBoardError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [project, milestone]);

  const shown = data && data.project === project ? data : undefined; // a project just picked never wears the last one's PRs
  const last = board && board.project === project ? board : undefined; // the last answer for this project, whichever milestone it was for: the picker keeps its list from it
  const boarded = boardFor(last, askFor(milestone, pin.current, project)); // and the rows only for the milestone asked for
  const costed = budget && budget.project === project ? budget : undefined;
  const costs = costed && new Map(costed.issues.map((i) => [i.number, i]));

  // The Map's links are a third read, asked for only while the Map is open (it reads every written path of the board's sessions, which the board's own read every 30 seconds does not):
  // for the milestone the board shows, so the two answers are about the same issues. A failure leaves the cards and the last links, and says so.
  const mapped = boarded ? boarded.milestone : undefined; // undefined: the board has not answered yet; null: it shows no milestone
  const ask = linksQuery(view, project, boarded);
  useEffect(() => {
    if (!ask) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/links?${ask}`);
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        const body = (await res.json()) as LinksData;
        if (alive) setLinks(body), setLinksError(undefined);
      } catch (e) {
        if (alive) setLinksError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [ask]);
  useEffect(() => (setPressed(undefined), setLinksError(undefined)), [project, mapped]); // a card of another milestone is not pressed in this one, and its error is not this one's
  const linked = linksFor(links, project, boarded);
  const save: Save = async (target, amount) => {
    try {
      const res = await fetch('/api/budget', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, ...target, usd: amount }) });
      if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The server answered ${res.status}.`;
      const again = await fetch(`/api/budget?${new URLSearchParams({ project, tz: Intl.DateTimeFormat().resolvedOptions().timeZone })}`);
      if (again.ok) setBudget((await again.json()) as BudgetData);
    } catch (e) {
      return (e as Error).message;
    }
    return undefined;
  };
  const pr = shown?.prs.find((p) => p.number === picked);
  const close = () => {
    setPicked(undefined);
    opener.current?.focus();
  };
  useEffect(() => {
    if (picked !== undefined && shown && !pr) close(); // the PR left with a fresh read (merged, closed): focus goes back, not to the body
  }, [shown, picked]);
  return (
    <main className="factory">
      <PageHeader title="Factory" sub={view === 'map' ? "How this milestone's issues touch each other" : "What's blocked, what's ready, and what's left running"}
        views={<><Seg value={view} onChange={setView} label="Factory view" options={[['board', 'Board'], ['map', 'Map']]} />{shown && <Asof readAt={shown.readAt} now={now} />}</>} project={<ProjectSelect one />}
        period={<MilestoneSelect milestones={last?.milestones ?? []} value={milestone ?? last?.milestone ?? null} onChange={(m) => setChosen({ project, milestone: m })} />} />
      {error && <div className="empty"><b>Factory could not load.</b><span>{error}</span></div>}
      {projects?.length === 0 && <div className="empty"><b>Nothing recorded yet.</b><span>Factory starts when a session runs with the agent-orb plugin.</span></div>}
      {view === 'map' && (
        <>
          {boardError && !boarded && <div className="empty"><b>The Map could not load.</b><span>The board could not be read: {boardError}</span></div>}
          {boarded && linked && <Reading said={mapReading(boarded, linked.links)} by="Counted from the links below. No model writes this." />}
          {boarded && <MapBand board={boarded} links={linked} error={linksError} boardError={boardError} sessions={sessions} picked={pressed} onPick={setPressed} phone={phone} />}
        </>
      )}
      {view === 'board' && shown && (
        <>
          <Reading said={factoryReading(shown)} />
          <NeedsYou prs={shown.prs} costs={costs} left={leftRunning(machine)} now={now} onOpen={(n, from) => ((opener.current = from), setPicked(n))} />
          {(boarded || boardError) && <BoardBand data={boarded} error={boardError} live={live} openable={new Set(shown.prs.map((p) => p.number))} cost={costs} notOnIssue={costed?.notOnIssue} onOpen={(n, from) => ((opener.current = from), setPicked(n))} />}
          {costed && <BudgetCard data={costed} onSave={save} />}
        </>
      )}
      {view === 'board' && <MachineBands data={machine} error={machineError} now={now} />}
      {pr && createPortal(
        <>
          <div className="scrim" onClick={close} aria-hidden="true" />
          <PrSheet key={pr.number} pr={pr} readAt={shown!.readAt} now={now} sheet={phone} onClose={close} cost={pr.issue && costs ? costs.get(pr.issue) : undefined} onSave={costed ? save : undefined} />
        </>,
        document.body,
      )}
    </main>
  );
}
