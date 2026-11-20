import { useCallback, useEffect, useState } from 'react';
import { Asof, ChecksSection, CostSection, count, FindingsSection, issueHref, REFRESH_MS, STAGE_LABEL, STAGES, type BoardStage, type FactoryPr, type IssueCost, type Save } from './Factory.tsx';
import { usd, modelLabel } from './format.ts';
import { Loading, Reading, useProject, type Said } from './kit.tsx';

// The issue page (v0.5 slice 2, #106; design/home-issue.html, the Issue and Missing data boards), from GET /api/issue: where one issue stands, in a sentence counted from its data and on a track of seven
// stages with when each was reached; its story, one line per agent run, oldest first; and what the PR sheet had (the four checks, the findings, the cost and its budget). Read only: nothing here
// starts or stops a session. The server works every figure out on read, so a page is as old as its read (it asks again as Factory does).

export type StoryLine = { at: number; stage: BoardStage } & (
  | { kind: 'run'; session: string; agent: { id: string; type: string | null; role: string | null; model: string | null }; wrote: { paths: string[]; count: number }; tests: { runs: number; failed: number };
      rounds: { at: number; open: number; dropped: number; reviewer: boolean }[]; usd: number; partial: boolean }
  | { kind: 'pr-open'; pr: number }
  | { kind: 'pr-merged'; pr: number }
  | { kind: 'round'; agent: string; reviewer: boolean; open: number; dropped: number }
);
export type IssueData = {
  project: string; content: 'off' | 'full' | 'excluded' | null; readAt: number | null;
  issue: { number: number; title: string | null; milestone: string | null; stage: BoardStage; bad?: true; ready: boolean | null; reason: string | null; openedAt: number | null; pr: { number: number; head: string | null; merged: boolean } | null };
  story: StoryLine[]; stages: { stage: BoardStage; at: number | null; again: number[] }[];
  /** The open PR as /api/factory gives it; none when the issue has no open PR. */
  checks: FactoryPr | null; cost: IssueCost | null;
  links: ({ kind: 'file'; a: number; b: number; files: string[]; count: number; together: boolean; title: string | null } | { kind: 'mention'; a: number; b: number; both?: true; title: string | null })[];
  mentions: { issue: number; direction: 'out' | 'in'; title: string | null }[];
  sessions: { id: string; branch: string | null; at: number; windowOnly: boolean; imported: boolean }[];
};

// Times as the page says them, in the viewer's zone (`tz` undefined) or the one a test gives. Parts, not a locale's whole format, so Node's ICU cannot change the words.
const parts = (at: number, tz?: string) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((p) => [p.type, p.value])) as Record<string, string>;
const clock = (at: number, tz?: string) => { const p = parts(at, tz); return `${p.hour}:${p.minute}`; };
const dayOf = (at: number, tz?: string) => { const p = parts(at, tz); return `${p.weekday} ${p.day} ${p.month}`; };
const when = (at: number, tz?: string) => { const p = parts(at, tz); return `${p.weekday} ${p.hour}:${p.minute}`; };

/** The sentence at the top, counted from the page's own data: the stage, how many runs and sessions, what it cost, and where the PR stands. No model writes it. */
export function issueReading(d: IssueData): Said {
  const { issue: i } = d;
  if (i.stage === 'queued') return [{ b: 'Queued.' }, ' No session has run on it and it has no PR.'];
  const runs = d.story.filter((l) => l.kind === 'run').length;
  const said: Said = [{ b: `${STAGE_LABEL[i.stage]}.` }, ` ${count(runs, 'agent run')} in ${count(d.sessions.length, 'session')}, ${usd(d.cost?.usd ?? 0, d.cost?.partial)} so far.`];
  if (i.pr?.merged) said.push(` It merged as PR #${i.pr.number}.`);
  else if (d.checks) said.push(d.checks.ready ? ' It is ready for your ok.' : ` It can't merge yet: ${d.checks.reason ?? 'not known'}.`);
  else said.push(' It has no PR yet.');
  return said;
}

/** What a run did, in a few words: the files it wrote, its test runs and their result, a findings report. */
function didWhat(l: Extract<StoryLine, { kind: 'run' }>): string {
  const bits: string[] = [];
  if (l.wrote.count) bits.push(`wrote ${count(l.wrote.count, 'file')}`);
  const { runs, failed } = l.tests;
  if (runs) bits.push(`ran the tests: ${failed === 0 ? (runs === 1 ? 'passed' : `all ${runs} passed`) : failed === runs ? (runs === 1 ? 'failed' : `all ${runs} failed`) : `${failed} of ${runs} failed`}`);
  for (const r of l.rounds) bits.push(r.open ? `reported ${count(r.open, 'open finding')}` : 'reported, none open');
  return bits.join(', ') || 'ran';
}

/** The cases where the page has less than it would, said in words (the mockup's Missing data board). */
export function missingNotes(d: IssueData): string[] {
  const notes: string[] = [];
  if (d.sessions.some((s) => s.windowOnly)) notes.push('Reached only through a PR: a session on no issue branch counts here from its turns up to the PR\'s opening, split by time window.');
  if (d.sessions.some((s) => s.imported)) notes.push('Imported from Claude Code\'s logs: files and findings weren\'t recorded.');
  const reported = d.story.some((l) => l.kind === 'round' || (l.kind === 'run' && l.rounds.length));
  if (!reported && d.issue.stage === 'building' && d.story.some((l) => l.kind === 'run')) notes.push('No agent has reported findings, so the stage stays Building: Reviewing is read from a findings report. Reviews are listed from this version on.');
  else if (!reported && d.issue.stage !== 'queued' && d.issue.stage !== 'building') notes.push('Reviews are listed from this version on: earlier ones of this issue are not in the story.');
  if (d.content === 'excluded') notes.push('This project is in excludeProjects: issues show by number, with no title.');
  return notes;
}

const liveHref = (session: string, project: string) => `#/live?session=${encodeURIComponent(session)}&project=${encodeURIComponent(project)}`;
const mapHref = (project: string, milestone: string) => `#/factory?${new URLSearchParams({ project, milestone, view: 'map' })}`;
const initial = (who: string) => who[0]!.toUpperCase();

function Line({ l, prev, d, tz }: { l: StoryLine; prev: BoardStage; d: IssueData; tz?: string }) {
  const to = l.stage !== prev ? <span className="iss-to" aria-label={`moved to ${STAGE_LABEL[l.stage]}`}>→ {STAGE_LABEL[l.stage]}</span> : null;
  if (l.kind === 'pr-open' || l.kind === 'pr-merged') {
    return (
      <div className="iss-st"><span className="t">{clock(l.at, tz)}</span><span className="av other" aria-hidden="true">PR</span>
        <div><span><b>PR #{l.pr} {l.kind === 'pr-open' ? 'opened' : 'merged'}</b></span>{to}</div><span className="cost num" /></div>
    );
  }
  if (l.kind === 'round') {
    const who = l.reviewer ? 'reviewer' : l.agent.split(':')[1] ?? l.agent;
    return (
      <div className="iss-st"><span className="t">{clock(l.at, tz)}</span><span className="av other" aria-hidden="true">{initial(who)}</span>
        <div><span><b>{who}</b> {l.open ? `reported ${count(l.open, 'open finding')}` : 'reported, none open'}</span>{to}</div><span className="cost num" /></div>
    );
  }
  const who = l.agent.type === 'main' ? 'main' : l.agent.type ?? l.agent.id.split(':')[1] ?? l.agent.id;
  const model = l.agent.model ? modelLabel(l.agent.model) : undefined;
  const session = d.sessions.find((s) => s.id === l.session);
  const shown = l.wrote.paths.slice(0, 3);
  const sub = [
    ...(shown.length ? [<span key="p">{shown.map((p, k) => <span key={p}>{k > 0 && ', '}<code>{p}</code></span>)}{l.wrote.count > shown.length && ` and ${l.wrote.count - shown.length} more`}</span>] : []),
    ...(model ? [<span key="m">{model.text}</span>] : []),
    ...(session?.windowOnly ? [<span key="w">counted by time window</span>] : []),
    ...(session?.imported ? [<span key="i">imported: files and findings weren't recorded</span>] : []),
  ];
  return (
    <div className="iss-st"><span className="t">{clock(l.at, tz)}</span><span className={`av ${model?.tone || 'other'}`} aria-hidden="true">{initial(who)}</span>
      <div>
        <span><a className="hm-lnk" href={liveHref(l.session, d.project)}><b>{who}</b> {didWhat(l)}</a></span>{to}
        {sub.length > 0 && <span className="sub">{sub.flatMap((s, k) => (k ? [' · ', s] : [s]))}</span>}
      </div>
      <span className="cost num">{l.usd > 0 || l.partial ? usd(l.usd, l.partial) : ''}</span></div>
  );
}

/** The seven stages, each with when it was first reached and when it came round again; `Not yet` for one ahead, `Not recorded` for one passed that the store keeps no time for (Gate and Ready, once merged). */
function Steps({ d, tz }: { d: IssueData; tz?: string }) {
  const now = STAGES.indexOf(d.issue.stage);
  const note = (s: IssueData['stages'][number], k: number) =>
    s.at !== null ? `${when(s.at, tz)}${s.again.map((t, j) => `${j === 0 ? ', again ' : ', '}${when(t, tz)}`).join('')}` : k === 0 ? '' : k > now ? 'Not yet' : 'Not recorded';
  const gateTimes = d.stages.some((s) => (s.stage === 'gate' || s.stage === 'ready') && s.at !== null);
  return (
    <section className="card" aria-label="Stages">
      <ol className={now >= 5 ? 'iss-steps good' : 'iss-steps'}>
        {d.stages.map((s, k) => <li key={s.stage} className={k < now ? 'on' : k === now ? 'now' : ''} {...(k === now ? { 'aria-current': 'step' as const } : {})}><b>{STAGE_LABEL[s.stage]}</b><span>{note(s, k)}</span></li>)}
      </ol>
      {gateTimes && <p className="sub iss-note">Gate and Ready show when their last condition was met: earlier heads of the PR, and earlier readiness, aren't kept.</p>}
    </section>
  );
}

function Related({ d }: { d: IssueData }) {
  const n = d.issue.number;
  const link = (issue: number, title: string | null) => <a className="hm-lnk" href={issueHref(d.project, issue)}><b>{`#${issue}${title ? ` ${title}` : ''}`}</b></a>;
  return (
    <section className="card" aria-label="Related issues">
      <h2>Related issues</h2>
      {d.links.map((l) => {
        const other = l.a === n ? l.b : l.a;
        return (
          <div key={`${l.kind}${other}`} className="iss-rel">
            <div>{link(other, l.title)}<span className="sub">{l.kind === 'file'
              ? <>Both wrote {l.files.map((f, k) => <span key={f}>{k > 0 && ', '}<code>{f}</code></span>)}{l.count > l.files.length && ` and ${l.count - l.files.length} more`}</>
              : l.both ? 'Each mentions the other' : l.a === n ? 'This issue mentions it' : 'It mentions this issue'}</span></div>
            <div className="side">{l.kind === 'file' && l.together && <span className="flag left">In flight together</span>}</div>
          </div>
        );
      })}
      {d.mentions.map((m) => (
        <div key={`m${m.issue}`} className="iss-rel">
          <div>{link(m.issue, m.title)}<span className="sub">{m.direction === 'out' ? 'This issue mentions it' : 'It mentions this issue'}, and it is not on the milestone's map</span></div><div className="side" />
        </div>
      ))}
      {!d.links.length && !d.mentions.length && <div className="iss-none">No link to another issue.</div>}
      {d.issue.milestone && <div className="hm-also"><a className="hm-lnk" href={mapHref(d.project, d.issue.milestone)}>See them on the milestone's map</a></div>}
    </section>
  );
}

/** The page. `tz`: the zone the times are said in (the viewer's when none; a test gives one). `onSave`: the issue's own budget, as the sheet saved it. */
export function IssueView({ data: d, now, tz, onSave }: { data: IssueData; now: number; tz?: string; onSave: Save }) {
  const { issue: i } = d;
  const branch = i.pr?.head ?? d.sessions.find((s) => !s.windowOnly)?.branch ?? null;
  const notes = missingNotes(d);
  const days = new Set<string>();
  return (
    <main className="factory issue">
      <div className="iss-head">
        <nav className="iss-crumb" aria-label="Where this is">
          <a href={`#/factory?${new URLSearchParams({ project: d.project })}`}>Factory</a><span aria-hidden="true">›</span><span>{d.project}</span>
          {i.milestone && <><span aria-hidden="true">›</span><a href={`#/factory?${new URLSearchParams({ project: d.project, milestone: i.milestone })}`}>{i.milestone}</a></>}
        </nav>
        <div className="pagehead"><div className="ph-1"><h1>{`#${i.number}${i.title ? ` ${i.title}` : ''}`}</h1></div></div>
        <div className="iss-chips">
          {i.pr ? <span className="chip"><span className="mono">PR #{i.pr.number}</span></span> : <span className="chip">No PR</span>}
          {branch && <span className="chip branch">{branch}</span>}
          <Asof readAt={d.readAt} now={now} />
        </div>
      </div>
      <Reading said={issueReading(d)} by="Counted from the data on this page. No model writes this." />
      <Steps d={d} tz={tz} />
      <div className="iss-grid">
        <section className="card" aria-label="The story">
          <h2>The story <span className="hint">one line per agent run, oldest first</span></h2>
          {d.story.length === 0
            ? <div className="iss-none"><b>Nothing has happened yet</b><p>The story starts when a session runs on a branch named for this issue, like fix/{i.number}-name, or when a PR says it closes #{i.number}.</p></div>
            : d.story.map((l, k) => {
              const day = dayOf(l.at, tz);
              const divider = !days.has(day) && days.add(day);
              return <div key={k} className="iss-line">{divider && <div className="iss-day">{day}</div>}<Line l={l} prev={k ? d.story[k - 1]!.stage : 'queued'} d={d} tz={tz} /></div>;
            })}
          {notes.length > 0 && <div className="iss-none">{notes.map((t) => <p key={t} className="miss">{t}</p>)}</div>}
        </section>
        <div className="stack">
          <section className="card factory-sheet" aria-label="Can it merge?">
            {d.checks ? <ChecksSection pr={d.checks} readAt={d.readAt} now={now} />
              : <section className="dsec"><h4>Can it merge?</h4><p className="dnote">{i.pr?.merged ? `It merged as PR #${i.pr.number}.` : 'No PR yet.'}</p></section>}
          </section>
          <Related d={d} />
          <section className="card factory-sheet" aria-label="Findings">
            {d.checks ? <FindingsSection pr={d.checks} />
              : <section className="dsec"><h4>Findings</h4><p className="dnote">{i.pr?.merged ? 'The PR merged: its findings are listed while it is open.' : 'No review has reported yet.'}</p></section>}
          </section>
          <section className="card factory-sheet" aria-label="Cost"><CostSection issue={i.number} cost={d.cost ?? undefined} onSave={onSave} /></section>
          <section className="card" aria-label="Sessions">
            <h2>Sessions</h2>
            {d.sessions.map((s) => (
              <div key={s.id} className="iss-rel">
                <div><code className="chip branch">{s.branch ?? 'no branch'}</code><span className="sub">Last event {when(s.at, tz)}</span>{s.windowOnly && <span className="sub">By time window</span>}{s.imported && <span className="sub">Imported</span>}</div>
                <div className="side"><a className="hm-lnk" href={liveHref(s.id, d.project)}>Open in Live</a></div>
              </div>
            ))}
            {!d.sessions.length && <div className="iss-none">None yet.</div>}
          </section>
        </div>
      </div>
    </main>
  );
}

/** The page's own read: asks again every 30 seconds, as Factory does, and after a budget is saved. */
export function Issue({ now, issue }: { now: number; issue: number | null }) {
  const { project } = useProject(true);
  const [data, setData] = useState<IssueData>();
  const [error, setError] = useState<string>();
  const load = useCallback(async (alive: () => boolean) => {
    if (!project || !issue) return;
    try {
      const res = await fetch(`/api/issue?${new URLSearchParams({ project, issue: String(issue), tz: Intl.DateTimeFormat().resolvedOptions().timeZone })}`);
      if (res.status === 404) throw new Error(`${project} has no issue #${issue}: no read of its issues, no PR and no session names it.`);
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      const body = (await res.json()) as IssueData;
      if (alive()) setData(body), setError(undefined);
    } catch (e) {
      if (alive()) setError((e as Error).message);
    }
  }, [project, issue]);
  useEffect(() => {
    let alive = true;
    void load(() => alive);
    const t = setInterval(() => void load(() => alive), REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, [load]);
  const save: Save = async (target, amount) => {
    try {
      const res = await fetch('/api/budget', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, ...target, usd: amount }) });
      if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The server answered ${res.status}.`;
      await load(() => true);
    } catch (e) {
      return (e as Error).message;
    }
    return undefined;
  };
  const mine = data && data.project === project && data.issue.number === issue ? data : undefined; // another issue's page never wears this one's story
  if (!issue) return <main className="factory issue"><div className="empty"><b>No issue named.</b><span>Open one from a row of the Factory board.</span></div></main>;
  if (mine) return <IssueView data={mine} now={now} onSave={save} />;
  return (
    <main className="factory issue">
      {error ? <div className="empty"><b>The issue could not load.</b><span>{error}</span></div> : <Loading>Reading #{issue}…</Loading>}
    </main>
  );
}
