import { Fragment, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { askFor, boardFor, linksFor, linksQuery, pinAfter, type Pin } from './board-view.ts';
import { boardGroups, boardReading, boardRows, GROUPS, type Group } from './factory-view.ts';
import { MapBand, mapReading, type LinksData } from './FactoryMap.tsx';
import { plural, usd } from './format.ts';
import { trapTab, usePhone } from './History.tsx';
import { Progress, Row as HomeRowView } from './Home.tsx';
import { Loading, PageHeader, ProjectSelect, Reading, Seg, useProject, type Said } from './kit.tsx';
import type { Session } from './Live.tsx';
import { factoryHash, readChoice, readFactory } from './project-choice.ts';

// Factory (v0.4 slice 1, #27), drawn as approved in design/v0.4-factory.html, the Factory and Findings boards, from GET /api/factory: each open PR with the first
// reason it isn't ready for your ok, or "Ready for your ok", and its findings in a sheet. Nothing here merges: the merge stays yours.
// Slice 2 (#28) adds each PR's issue cost against its budget (the cost cell, the Budget card and the sheet's field), from GET and PUT /api/budget; every figure is an estimate and
// nothing is ever stopped. Slice 3 (#29) adds the Machine band (the Mac's free memory and its containers by project, from GET /api/machine) and a "Left running" row in Needs you for
// each group the server flags; nothing here removes a container. Slice 6 (#32) adds the Board band between Needs you and the Budget card, from GET /api/board: one milestone at a time, a row
// per issue with its stage on a track of seven, whether its PR is ready, its cost against its budget and its sessions with a link to Live. The board repeats no session's state.
// v0.6 (#90) redraws the Board view as approved in design/factory.html: the Board grouped by whose move it is, in Home's rows, beside short PRs, Machine and Budget cards; Needs you is gone (its ready PRs head the board, its
// not-ready ones say why in their rows, what is left running is on Machine), and the Board reads /api/links too, for the files its rows share.
// v0.5 slice 1 (#66) adds a Board and Map switch: the Map (FactoryMap.tsx) shows the board's issues by stage with the links between them, from GET /api/links, read only while the Map is open.

type Cond = { ok: boolean | null; note: string };
export type FactoryFinding = { id: string; severity: string; file: string; fate: 'open' | 'dismissed' | 'fixed'; title?: string; why?: string };
export type FactoryPr = {
  number: number; head: string | null; issue?: number | null; headOid: string; ready: boolean; reason: string | null; dropped: number;
  conditions: { findings: Cond; gate: Cond; bots: Cond; clean: Cond }; findings: FactoryFinding[];
};
export type FactoryData = { project: string; readAt: number | null; prs: FactoryPr[] };
type OpenSheet = (pr: number, from: HTMLElement) => void;
/** An issue's page (#106): every board row opens it, and so does a PR of Needs you that closes an issue. */
export const issueHref = (project: string, issue: number) => `#/issue?${new URLSearchParams({ project, issue: String(issue) })}`;
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
export type Save = (target: { milestone: string } | { issue: number }, usd: number | null) => Promise<string | undefined>;

/** The page's hash; empty where there is no window (the tests render to markup in Node). */
const hashNow = () => (typeof location === 'undefined' ? '' : location.hash);
export const REFRESH_MS = 30_000; // the plugin reads GitHub every 5 minutes; the page asks more often so a fresh read shows soon after it lands
const STALE_MS = 10 * 60_000; // two reads missed: no session is reading this repo now
const MIN = 60_000;
const MACHINE_STALE_MS = 30 * MIN; // a sample older than this says when it was read: the plugin samples while a session runs
export const short = (oid: string) => oid.slice(0, 7);
export const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const CONDITIONS = [['findings', 'No finding is open'], ['gate', 'The gate passed on this head'], ['bots', 'No bot comment is newer than the last commit'], ['clean', 'Merge state is CLEAN']] as const;

/** The state a PR shows: from the first condition that does not hold, as its reason is. All four holding on data too old to trust (the server's call) is not known. */
export function stateOf(p: FactoryPr): { tone: 'working' | 'stalled' | 'waiting'; label: string } {
  if (p.ready) return { tone: 'working', label: 'Ready' };
  const first = Object.entries(p.conditions).find(([, c]) => c.ok !== true);
  if (!first || first[1].ok === null) return { tone: 'waiting', label: 'Not known' };
  return { tone: 'stalled', label: first[0] === 'findings' ? 'Open findings' : 'Blocked' };
}

export const ageText = (readAt: number, now: number) => {
  const m = Math.max(0, Math.floor((now - readAt) / MIN));
  return `GitHub data ${m < 60 ? `${m} min` : m < 24 * 60 ? `${Math.floor(m / 60)} h` : plural(Math.floor(m / (24 * 60)), 'day')} old`;
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

/**
 * An issue's spend, as the board's cost cell holds it: the figure (a floor when a request had no price), "of $budget" and a meter when it has a budget. The meter's colour is the server's mark, never a
 * percent worked out here. Nothing at all when nothing was spent: an empty cell says nothing of what an issue has not got (#90).
 */
export function costFig(cost?: IssueCost): ReactNode {
  if (!cost || (cost.usd === 0 && !cost.partial)) return null;
  const pct = cost.budget === null ? 0 : Math.round((100 * cost.usd) / cost.budget);
  return (
    <>
      <span className="lab">Cost, estimate</span>
      <span><span className="num">{usd(cost.usd, cost.partial)}</span>{cost.budget !== null && <span className="of"> of {usd(cost.budget)}</span>}</span>
      {cost.budget !== null && <div className={cost.mark === 'at100' ? 'bar over' : cost.mark === 'at80' ? 'bar warn' : 'bar'} role="img" aria-label={`${pct}% of the budget`}><i style={{ width: `${Math.min(pct, 100)}%` }} /></div>}
    </>
  );
}

/** The small `i` beside a heading or a figure: what it says is its title, and its accessible description. */
function Info({ label, text }: { label: string; text: string }) {
  return <button type="button" className="info" aria-label={label} title={text}>i</button>;
}


/** One budget: a dollar amount to save, or to leave empty and save to remove. `value` is what is stored; a refusal shows the server's words. */
export function BudgetField({ label, value, placeholder, onSave }: { label: string; value: number | null; placeholder?: number | null; onSave: (usd: number | null) => Promise<string | undefined> }) {
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


/** The heading a shared section opens with: the sheet's own are h4 (under its h3), the issue page's h2 (under its h1), and a group inside one is the next level down. */
type HeadingLevel = 2 | 3 | 4 | 5;
const heading = (level: HeadingLevel) => `h${level}` as 'h4';

/** The PR sheet's cost: where the issue's money went, and its own budget (which beats the milestone's). */
export function CostSection({ issue, cost, onSave, level = 4 }: { issue: number | null | undefined; cost?: IssueCost; onSave: Save; level?: HeadingLevel }) {
  const H = heading(level);
  if (!issue) return <section className="dsec"><H>Cost, estimate</H><p className="dnote">This PR closes no issue, so its cost is on "not on an issue".</p></section>;
  const c = cost ?? { number: issue, milestone: null, usd: 0, partial: false, whole: 0, windows: 0, budget: null, milestoneBudget: null, source: null, mark: null };
  const dflt = c.milestoneBudget; // known beside the issue's own budget: it is what removing that gives back
  return (
    <section className="dsec">
      <H>Cost, estimate</H>
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

/** Seven segments, one a stage: those before the issue's stage lit, its own marked, green once the issue is ready or merged, red when the test run or a check on its head failed, or (`stalled`, Home's rows) its agent is stalled. */
export function Track({ stage, bad, stalled }: { stage: BoardStage; bad?: true; stalled?: true }) {
  const at = STAGES.indexOf(stage);
  return (
    <span className={stage === 'ready' || stage === 'merged' ? 'trk good' : bad || stalled ? 'trk bad' : 'trk'} role="img" aria-label={`Stage ${at + 1} of ${STAGES.length}: ${STAGE_LABEL[stage]}${bad ? ', failed' : stalled ? ', stalled' : ''}`}>
      {STAGES.map((s, i) => <i key={s} className={i < at ? 'on' : i === at ? 'now' : ''} />)}
    </span>
  );
}

/** Why an issue is on the board though it is not in the chosen milestone: in flight, and which milestone it is in when that is known (null: it has none; absent: no read has seen it). */
export const outsideNote = (i: BoardIssue, chosen: string | null) =>
  !i.outside ? '' : chosen === null ? ` · in flight${i.milestone ? `, ${i.milestone}` : ''}` : ` · outside this milestone${i.milestone === undefined ? '' : `, ${i.milestone ?? 'in none'}`}`;

/** Why no issue carries a title, once: Content is not on full, or the project is excluded and sends none. Nothing with Content on full (an issue no read has seen has none either). */
export const titlesNote = (data: Pick<BoardData, 'issues' | 'content'>) =>
  !data.issues.some((i) => !i.title) || data.content === 'full' ? null : data.content === 'excluded' ? 'This project is in excludeProjects: issues show by number.' : 'Issue titles show with Content on full.';
/** What an excluded project's empty board says: the plugin sends no milestones for it. */
export const EXCLUDED_NOTE = 'This project is in excludeProjects, so the plugin sends no milestones: nothing to follow here but the issues a session is working on.';
/**
 * The Board card (v0.4 slice 6, #32; redrawn for #90 as approved in design/factory.html, "Board, proposed"): one milestone's issues in flight as Home's rows, grouped by whose move it is (`groups`), then
 * the queued and merged ones, a line each. Its cost cell is /api/budget's, joined by issue number (`costs`; until it is read the cells are empty); under it, what this month spent on no issue, which is
 * that read's too and so stays when the board could not be read (`error`, with `data` the last answer for the milestone asked for, if any). A title shows only if the plugin sent it (Content on full).
 */
export function BoardCard({ data, error, groups, sessions, now, costs, notOnIssue, onMap }: {
  data?: BoardData; error?: string; groups: readonly Group[]; sessions: readonly Session[]; now: number; costs?: ReadonlyMap<number, IssueCost>; notOnIssue?: BudgetData['notOnIssue']; onMap: () => void;
}) {
  const inside = data ? data.issues.filter((i) => !i.outside) : [];
  const outside = data ? data.issues.length - inside.length : 0;
  const stage = (s: BoardStage) => (data ? data.issues.filter((i) => i.stage === s) : []);
  const [queued, merged] = [stage('queued'), stage('merged')];
  const flight = groups.length > 0;
  const counts = { merged: inside.filter((i) => i.stage === 'merged').length, queued: inside.filter((i) => i.stage === 'queued').length, flight: inside.filter((i) => i.stage !== 'merged' && i.stage !== 'queued').length, outside };
  const note = data && titlesNote(data);
  const name = (i: BoardIssue) => `#${i.number}${i.title ? ` ${i.title}` : ''}`;
  return (
    <section className="card board fx-board" aria-labelledby="fboard-h">
      <h2 id="fboard-h">
        <span className="fx-title">Board{data?.milestone != null && ` · ${data.milestone}`}<Info label="About the board" text="Agent view lists sessions. This lists issues, with what each has spent and how far it is from your ok. A background session is answered in agent view: claude agents." /></span>
        {data && data.issues.length > 0 && <span className="hint">{data.milestone === null ? `${outside} in flight` : `${count(inside.length, 'issue')}${outside > 0 ? `, plus ${outside} in flight outside it` : ''}`}</span>}
      </h2>
      {error && <p className="nothing" role="alert">The board could not be read: {error}</p>}
      {data && (data.issues.length === 0
        ? (!error && <p className="nothing">{data.milestone !== null ? `No open issue in ${data.milestone}, and none in flight.` : data.content === 'excluded'
          ? EXCLUDED_NOTE
          : 'No open issue has a milestone, so there is nothing to follow yet. The plugin reads the open issues from GitHub while a session runs in this repo, with gh logged in.'}</p>)
        : (
          <>
            {note && <p className="nothing">{note}</p>}
            <Progress counts={counts} />
            {flight && <div className="bcols hm-cols fx-cols" aria-hidden="true"><span>Issue</span><span>Stage</span><span>Now</span><span>Cost, estimate</span><span>State</span></div>}
            {groups.map((g) => (
              <Fragment key={g.id}>
                <div className={`fx-gh g-${GROUPS[g.id].tone}`}><b>{GROUPS[g.id].name}</b><span className="num">{g.rows.length}</span><span>{GROUPS[g.id].hint}</span></div>
                {g.rows.map(({ row, key }) => <HomeRowView key={row.number} row={row} state={key} project={{ name: data.project, milestone: data.milestone }} sessions={sessions} now={now} cost={costs ? costFig(costs.get(row.number)) : null} />)}
              </Fragment>
            ))}
            {!flight && queued.length > 0 && <div className="fx-gh"><b>Queued</b><span className="num">{queued.length}</span><span>Nothing is in flight. No session has started on these.</span></div>}
            {!flight && queued.map((i) => <div key={i.number} className="fx-q"><span className="num">#{i.number}</span><span>{i.title ?? ''}</span></div>)}
            {!flight && queued.length === 0 && <div className="hm-also">Nothing is in flight.</div>}
            {flight && queued.length > 0 && <div className="hm-also"><b>Queued</b>{queued.map((i) => <a key={i.number} className="hm-lnk" href={issueHref(data.project, i.number)}>{name(i)}</a>)}</div>}
            {merged.length > 0 && <div className="hm-also"><b>Merged</b>{merged.map((i) => <a key={i.number} className="hm-lnk" href={issueHref(data.project, i.number)}>{name(i)}</a>)}</div>}
          </>
        ))}
      <div className="hm-foot">
        {notOnIssue ? (
          <span className="hm-spend"><span>Not on an issue this month <b className="num">{usd(notOnIssue.usd, notOnIssue.partial)}</b></span>
            <Info label="What this counts" text="Sessions with no PR, and turns after a session's last PR. Cost is an estimate by time windows." /></span>
        ) : <span />}
        <span className="hm-links"><button type="button" className="hm-lnk" onClick={onMap}>Open the map</button></span>
      </div>
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
 * PRs that close no issue (a bot's update, say), one line each: "PR #n" and its branch (the API gives no title), opening the PR's sheet. When none has findings reported the card says so once and the rows
 * carry no state, rather than "Not known" on every one; the card is not drawn at all when there is no such PR (#90).
 */
export function PrsCard({ prs, onOpen }: { prs: FactoryPr[]; onOpen: OpenSheet }) {
  if (!prs.length) return null;
  const reported = prs.some((p) => p.conditions.findings.ok !== null);
  return (
    <section className="card fx-prs" aria-labelledby="fprs-h">
      <h2 id="fprs-h">PRs on no issue <span className="hint">{prs.length} open</span></h2>
      {prs.map((p) => {
        const s = stateOf(p);
        return (
          <button key={p.number} type="button" className="fx-pr" onClick={(e) => onOpen(p.number, e.currentTarget)}>
            <span><b>PR #{p.number}</b>{p.head && <> <code>{p.head}</code></>}</span>
            {reported && <span className={`state ${s.tone}`}>{s.label}</span>}
          </button>
        );
      })}
      {!reported && <div className="hm-foot pad">No review reports on these, so agent-orb can't say they're ready.</div>}
    </section>
  );
}

/**
 * One Mac's card (v0.4 slice 3, #29; redrawn for #90): its free memory and what its containers use, the groups the server flagged "Left running" (each as a line; they were rows of Needs you), and every group
 * folded. Nothing here removes a container: the clean-up stays yours. With Docker absent or stopped it says so beside the memory; a sample older than 30 minutes says when it was read, since the plugin only
 * samples while a session runs. `named`: the page has more than one Mac, so a line names its own.
 */
export function MachineCard({ host, now, named = false }: { host: MachineHost; now: number; named?: boolean }) {
  const age = now - host.at;
  const stale = age > MACHINE_STALE_MS;
  const left = host.groups.filter((g) => g.leftRunning);
  return (
    <section className="card machine" id={`machine-${host.host}`} tabIndex={-1} aria-labelledby={`fmachine-${host.host}`}>
      <h2 id={`fmachine-${host.host}`}>Machine <span className={stale ? 'hint stale' : 'hint'}>{host.host} · {readAgo(age)}{stale && ': it updates while a session runs'}</span></h2>
      <div className="fx-figs">
        <div className="fx-fig"><span className="k">Free memory</span>{host.memFree === null ? <span className="v">Not read</span> : <span className="v num">{memText(host.memFree)}</span>}{host.memTotal !== null && <span className="d">of {memText(host.memTotal)}</span>}</div>
        {host.docker === 'ok' && <div className="fx-fig"><span className="k">Containers</span><span className="v num">{host.containers}</span><span className="d">use {memText(host.memory)}</span></div>}
      </div>
      {host.docker !== 'ok' && <p className="mdown">Docker isn't running, so no containers to list.</p>}
      {host.docker === 'ok' && !host.groups.length && <p className="nothing">No container is running.</p>}
      {host.docker === 'ok' && host.groups.length > 0 && (
        <>
          {left.length === 0 && <div className="hm-also">Nothing is left running.</div>}
          {left.map((g) => <div key={g.id} className="hm-also"><span className="flag left">Left running</span><span><b>{g.project ?? g.name}</b>: {leftText(g, host.host, host.at, named, now)}</span></div>)}
          <details className="fx-more">
            <summary>Every container · {plural(host.groups.length, 'project')}</summary>
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
            <div className="hm-also">agent-orb lists containers and never removes one: the clean-up stays yours.</div>
          </details>
        </>
      )}
    </section>
  );
}

/**
 * The page's Machine part: one card per Mac. It is the Mac's, not the project's, so it stands whatever Factory's own read did. With no sample in the last 24 hours it says so, and when the server
 * could not answer it says that: an old plugin (it sends none) or an old server (it has no route) is then not taken for an idle Mac. A failed read after a good one keeps the good one.
 */
export function MachineCards({ data, error, now }: { data?: MachineData; error?: string; now: number }) {
  if (data?.hosts.length) return <>{data.hosts.map((h) => <MachineCard key={h.host} host={h} now={now} named={data.hosts.length > 1} />)}</>;
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

/** One budget as a line: its value ("None" with no budget) and a button that opens its field in place, so a page of milestones is not a page of fields. Saving closes it. */
export function BudgetLine({ label, value, onSave, defaultOpen = false }: { label: string; value: number | null; onSave: (usd: number | null) => Promise<string | undefined>; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="fx-bud-wrap">
      <div className="fx-bud"><span>{label}</span>{value === null ? <span className="v none">None</span> : <span className="v num">{usd(value)}</span>}
        <button type="button" className="btn sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{value === null ? 'Set' : 'Change'}</button></div>
      {open && <div id={id} className="fx-bud-edit"><BudgetField label={label} value={value} onSave={async (u) => { const e = await onSave(u); if (!e) setOpen(false); return e; }} /></div>}
    </div>
  );
}

/**
 * What the milestones' defaults are and where to set them (#28; redrawn for #90): the default of the milestone shown (`shown`, null when the board shows none) on one line with a Change button, a note under it
 * (who is over, else that nothing warns), and the other milestones folded. The numbers and warnings are the server's; the month's spend on no issue is on the board.
 */
export function BudgetCard({ data, shown, onSave }: { data: BudgetData; shown: string | null; onSave: Save }) {
  const own = data.issues.filter((i) => i.source === 'issue');
  const over = data.issues.filter((i) => i.mark === 'at100' && i.budget !== null);
  const none = !own.length && data.milestones.every((m) => m.budget === null);
  const others = data.milestones.filter((m) => m.name !== shown);
  const ownNote = own.length > 0 && <div className="hm-also">{own.length === 1 ? 'One issue has its own budget' : `${own.length} issues have their own budget`}: {own.map((i) => `#${i.number}, ${usd(i.budget!)}`).join('; ')}. Set it on the issue's page.</div>;
  const line = (name: string, value: number | null) => <BudgetLine key={name} label={`Default for ${name}`} value={value} onSave={(u) => onSave({ milestone: name }, u)} />;
  return (
    <section className="card budget" aria-labelledby="fbudget-h">
      <h2 id="fbudget-h">Budget per issue <span className="hint">warns at 80% and 100%</span></h2>
      {!data.milestones.length && <div className="hm-also">No open issue has a milestone, so there is no default to set. An issue's own budget is on its page.</div>}
      {shown !== null && line(shown, data.milestones.find((m) => m.name === shown)?.budget ?? null)}
      {over.length > 0 ? <div className="hm-also">{over.map((i) => `#${i.number} is over it, at ${usd(i.usd, i.partial)} of ${usd(i.budget!)}.`).join(' ')}</div>
        : none && <div className="hm-also">No budget is set, so rows show cost only and nothing warns.</div>}
      {others.length > 0 && (
        <details className="fx-more">
          <summary>Other milestones · {others.length}</summary>
          {others.map((m) => line(m.name, m.budget))}
          {ownNote}
        </details>
      )}
      {others.length === 0 && ownNote}
    </section>
  );
}


export function Row({ f }: { f: FactoryFinding }) {
  return (
    <div className="fnd">
      <span className="id">{f.id}</span><span className={`sev ${f.severity}`}>{f.severity}</span><span className="file">{f.file}</span>
      {f.title ? <span className="ttl">{f.title}</span> : <span className="ttl off">Title needs Content on full</span>}
      {f.why && <span className="why2">Why dismissed: {f.why}</span>}
    </div>
  );
}

/** The four conditions of a PR, as the sheet and the issue page (#106) both show them. */
export function ChecksSection({ pr, readAt, now, level = 4 }: { pr: FactoryPr; readAt: number | null; now: number; level?: HeadingLevel }) {
  const H = heading(level);
  return (
    <section className="dsec">
      <H>Can it merge?</H>
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
  );
}

/** A PR's findings: open, dismissed (read these before merging), and fixed, folded. Shared by the sheet and the issue page (#106). */
export function FindingsSection({ pr, level = 4 }: { pr: FactoryPr; level?: HeadingLevel }) {
  const H = heading(level);
  const G = heading((level + 1) as HeadingLevel);
  const of = (fate: FactoryFinding['fate']) => pr.findings.filter((f) => f.fate === fate);
  const [open, dismissed, fixed] = [of('open'), of('dismissed'), of('fixed')];
  const unreported = !pr.findings.length && pr.conditions.findings.ok === null && !pr.dropped;
  return (
    <section className="dsec">
      <H>Findings</H>
      {pr.dropped > 0 && <p className="dnote">{count(pr.dropped, 'line')} of the last report didn't parse: ask the reviewer to report it again, with a finding it has not listed before (a report that only confirms fixes cannot clear it).</p>}
      {unreported && <p className="dnote">No <code>orb-findings</code> block has reached this PR's branch yet, so ready can't be proved.</p>}
      {!pr.findings.length && !unreported && <p className="dnote">Reported, none found.</p>}
      {open.length > 0 && <div className="fgroup"><G>Open ({open.length})</G>{open.map((f) => <Row key={f.id} f={f} />)}</div>}
      {dismissed.length > 0 && <div className="fgroup"><G>Dismissed: read these before merging ({dismissed.length})</G>{dismissed.map((f) => <Row key={f.id} f={f} />)}</div>}
      {fixed.length > 0 && <details className="fgroup"><summary>Fixed ({fixed.length})</summary>{fixed.map((f) => <Row key={f.id} f={f} />)}</details>}
    </section>
  );
}

/** A PR's sheet, for a PR that closes no issue (an issue's PR opens the issue's page, #106): can it merge (the four conditions), then its findings. */
export function PrSheet({ pr, readAt, now, sheet, onClose, cost, onSave }: { pr: FactoryPr; readAt: number | null; now: number; sheet: boolean; onClose: () => void; cost?: IssueCost; onSave?: Save }) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => box.current?.focus(), []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [onClose]);
  const s = stateOf(pr);
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
        <ChecksSection pr={pr} readAt={readAt} now={now} />
        <FindingsSection pr={pr} />
        {onSave && <CostSection issue={pr.issue} cost={cost} onSave={onSave} />}
      </div>
    </aside>
  );
}

const NO_SESSIONS: readonly Session[] = [];

/** `sessions`: the sessions Live shows right now with their agents: who is on each issue now, on the board and on the Map. */
export function Factory({ now, sessions = NO_SESSIONS }: { now: number; sessions?: readonly Session[] }) {
  const { project, projects } = useProject(true); // one project: the page reads one repo's PRs
  const [data, setData] = useState<FactoryData>();
  const [budget, setBudget] = useState<BudgetData>();
  const [board, setBoard] = useState<BoardData>();
  const [boardError, setBoardError] = useState<string>();
  // #106: the milestone picked and the view are in the hash (#/factory?project=..&milestone=..&view=map), read on load and written back when they change, so a reload and a link from the issue page or Home land on the same Map.
  const [chosen, setChosen] = useState<{ project: string; milestone: string } | undefined>(() => {
    const { milestone } = readFactory(hashNow());
    const { single } = readChoice(hashNow());
    return milestone && single ? { project: single, milestone } : undefined; // the milestone picked, for the project it was picked in; none: the server's choice
  });
  const [machine, setMachine] = useState<MachineData>();
  const [machineError, setMachineError] = useState<string>();
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<number>();
  const [view, setView] = useState<'board' | 'map'>(() => readFactory(hashNow()).view);
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

  // The links are a read of their own, for the milestone the board shows, so the two answers are about the same issues: the Map draws them and the board's rows say which issues share files (#90). It reads every written path
  // of the board's sessions, which the board's own read does not; it was the Map's alone, and is now asked every 30 seconds on the board too. A failure leaves the cards and the last links, and says so.
  const mapped = boarded ? boarded.milestone : undefined; // undefined: the board has not answered yet; null: it shows no milestone
  const ask = linksQuery(project, boarded);
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
  const groups = boarded ? boardGroups(boardRows(boarded, shown?.prs ?? [], costs, linked?.links), sessions) : [];
  const reading = (shown && boardReading({ groups, project: project ?? '', milestone: boarded ? boarded.milestone : null, queued: boarded ? boarded.issues.filter((i) => i.stage === 'queued').length : 0, noPr: !shown.prs.length, readAt: shown.readAt })) || (shown ? factoryReading(shown) : []);
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
  useEffect(() => {
    const next = factoryHash(location.hash, view, chosen, project);
    if (next !== location.hash) history.replaceState(null, '', next);
  }, [view, chosen, project]);
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
      {!project && !projects && <Loading>Reading your projects…</Loading>}
      {view === 'map' && (
        <>
          {project && !boarded && !boardError && <Loading>Reading the Map for {project}…</Loading>}
          {boardError && !boarded && <div className="empty"><b>The Map could not load.</b><span>The board could not be read: {boardError}</span></div>}
          {boarded && linked && <Reading said={mapReading(boarded, linked.links)} by="Counted from the links below. No model writes this." />}
          {boarded && <MapBand board={boarded} links={linked} error={linksError} boardError={boardError} sessions={sessions} picked={pressed} onPick={setPressed} phone={phone} />}
        </>
      )}
      {view === 'board' && project && !shown && !error && <Loading>Reading {project}'s PRs and board…</Loading>}
      {view === 'board' && (
        <>
          {shown && <Reading said={reading} by="Counted from the rows below. No model writes this." />}
          <div className={shown ? 'fx-grid' : 'fx-stack'}>
            {shown && (
              <div className="fx-main">
                {!boarded && !boardError && <Loading>Reading the board…</Loading>}
                {(boarded || boardError) && <BoardCard data={boarded} error={boardError} groups={groups} sessions={sessions} now={now} costs={costs} notOnIssue={costed?.notOnIssue} onMap={() => setView('map')} />}
              </div>
            )}
            <div className="fx-stack">
              {shown && <PrsCard prs={shown.prs.filter((p) => !p.issue)} onOpen={(n, from) => ((opener.current = from), setPicked(n))} />}
              <MachineCards data={machine} error={machineError} now={now} />
              {costed && <BudgetCard data={costed} shown={boarded ? boarded.milestone : null} onSave={save} />}
            </div>
          </div>
        </>
      )}
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
