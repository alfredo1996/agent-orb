import { Fragment, useEffect, useState } from 'react';
import { ageText, count, EXCLUDED_NOTE, issueHref, outsideNote, REFRESH_MS, STAGE_LABEL, titlesNote, Track, type BoardData, type BoardIssue } from './Factory.tsx';
import { ago, DAY, day, modelLabel, usd } from './format.ts';
import { dayOf, feedOf, hintOf, loadMark, saveMark, sinceClause, sinceOf, stalls, timeOf, whenOf, type Change } from './changes-view.ts';
import { homeSentence, ranked, STATES } from './home-view.ts';
import { Loading, PageHeader, Reading } from './kit.tsx';
import type { Session } from './Live.tsx';
import { agentName, sentence } from './live-cards.ts';
import { doingOn, nowOn } from './now-on.ts';
import { factoryHash, hashWith } from './project-choice.ts';

// Home (v0.5 slice 3, #107; the plan is #64), drawn as approved in design/home-issue.html, the Home board, from GET /api/home: a card per project with a session in the past 30 days, most recent first, with
// the rows in flight worst first, who is on each now (the sessions Live shows, joined by the board's own list of an issue's sessions), and the issues it shares files with. Queued and merged issues are counts,
// so a card stays short. The sentence on top is counted from the rows and the stream, and no model writes it. Read only: a row opens its issue's page, and the card links to the milestone's Map and board.
// Since you last looked (slice 4, #108) is the card beside the projects: GET /api/changes since a mark kept in this browser, and the stalls the stream shows, until Caught up moves the mark.

/** A row of GET /api/home: the board's own row for an issue in flight, with the branch of its newest session, the issues it shares files with (`together`: both in flight), a PR's open findings, and its budget when one is set (`mark` is /api/budget's). */
export type HomeRow = BoardIssue & { branch?: string; shares: { issue: number; together: boolean }[]; openFindings?: true; budget?: { usd: number; budget: number; mark: 'at80' | 'at100' | null; partial: boolean } };
export type HomeProject = {
  name: string; last: number; milestone: string | null; content: BoardData['content']; counts: { merged: number; flight: number; queued: number; outside: number }; rows: HomeRow[]; readAt: number | null;
  notOnIssue: { count: number; sessions: { id: string; branch: string | null; at: number }[] }; month: string; goal: number | null; spent: number; costPartial: boolean;
};
export type HomeData = { projects: HomeProject[]; quiet: { name: string; last: number }[] };

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const modelOf = (tone: string) => (tone === 'other' ? '' : ` · ${tone[0]!.toUpperCase()}${tone.slice(1)}`);

/** The page's link to the project's Factory: the Map or the board, for the milestone the card shows. */
const factoryHref = (p: HomeProject, view: 'board' | 'map') => factoryHash(hashWith('#/factory', { project: p.name }), view, p.milestone === null ? undefined : { project: p.name, milestone: p.milestone }, p.name);

function Row({ row, state, project, sessions, now }: { row: HomeRow; state: keyof typeof STATES; project: HomeProject; sessions: readonly Session[]; now: number }) {
  const s = STATES[state];
  const { who } = nowOn(row, sessions);
  const doing = doingOn(row, sessions, now);
  const spent = row.budget && row.budget.mark ? ` · ${usd(row.budget.usd, row.budget.partial)} of ${usd(row.budget.budget)}` : '';
  const why = row.ready === false && row.reason ? row.reason : undefined;
  const text = doing ? `${doing}${why ? ` · ${why}` : ''}` : `No session is on it.${why ? ` ${why}` : row.ready ? ' Ready for your ok.' : ''}`;
  return (
    <div className="brow hm-row" data-issue={row.number}>
      <div className="bissue">
        <a className="open" href={issueHref(project.name, row.number)} aria-label={`Issue #${row.number}: open its page`}><b>{`#${row.number}${row.title ? ` ${row.title}` : ''}`}</b></a>
        <small>{row.pr ? `PR #${row.pr.number}` : (row.branch ?? 'No PR')}{outsideNote(row, project.milestone)}</small>
        {row.shares.length > 0 && <span className="hm-with">Same files as {row.shares.map((x, i) => <Fragment key={x.issue}>{i === 0 ? '' : i === row.shares.length - 1 ? ' and ' : ', '}<span className={x.together ? 'together' : undefined}>#{x.issue}</span></Fragment>)}</span>}
      </div>
      <div className="stagecell"><span>{STAGE_LABEL[row.stage]}</span><Track stage={row.stage} bad={row.bad} {...(state === 'stalled' ? { stalled: true as const } : {})} /></div>
      <div className="hm-now"><span className="lab">Now</span>
        {who && <span className={`model ${who.tone}`}>{who.name}{modelOf(who.tone)}</span>}
        <span className="sub">{text}{spent}</span>
      </div>
      <span className={`state ${s.tone}`}>{s.label}</span>
    </div>
  );
}

/** The sessions of the project on no issue that the server names: a running one (the stream has it) by agent and branch and what it is doing, an ended one by branch and when, then how many more there were in the past 30 days. */
function NotOnIssue({ project, sessions, now }: { project: HomeProject; sessions: readonly Session[]; now: number }) {
  const { count: total, sessions: named } = project.notOnIssue;
  if (!total) return null;
  const more = total - named.length;
  return (
    <div className="hm-also">
      <b>Not on an issue</b>
      {named.map((n) => {
        const s = sessions.find((x) => !x.endedAt && x.project === project.name && x.id === n.id);
        const main = s && (s.agents.find((a) => a.depth === 0) ?? s.agents[0]);
        const tone = modelLabel(main?.model).tone || 'other';
        const verb = main && sentence(main, [], now).verb;
        const branch = n.branch ? <code>{n.branch}</code> : 'no branch';
        return s
          ? <span key={n.id}>{main && <span className={`model ${tone}`}>{agentName(main.type)}{modelOf(tone)}</span>} on {branch}{verb && `, ${verb[0]!.toLowerCase()}${verb.slice(1)}`}</span>
          : <span key={n.id}>on {branch}, {now - n.at < DAY ? ago(now - n.at) : day(n.at, now)}</span>;
      })}
      {more > 0 && <span>{more} more in the past 30 days</span>}
    </div>
  );
}

function Card({ project: p, sessions, now }: { project: HomeProject; sessions: readonly Session[]; now: number }) {
  const total = p.counts.merged + p.counts.flight + p.counts.queued;
  const bar = [...'m'.repeat(p.counts.merged), ...'f'.repeat(p.counts.flight), ...'q'.repeat(p.counts.queued)];
  const here = sessions.some((s) => !s.endedAt && s.project === p.name); // the plugin is what reads GitHub: with no session running here, the data is as old as the last one
  const age = p.readAt === null ? 'No GitHub data yet' : ageText(p.readAt, now);
  // why there is no milestone, or why the issues have no title: the Factory page's words
  const excluded = p.milestone === null && p.content === 'excluded';
  const notes = [excluded ? EXCLUDED_NOTE : p.milestone === null ? 'No milestone has open issues.' : null, excluded ? null : titlesNote({ content: p.content, issues: p.rows })].filter((n) => n !== null);
  const pct = p.goal ? Math.min(100, Math.round((100 * p.spent) / p.goal)) : 0;
  return (
    <section className="card board home-card" aria-label={p.name}>
      <div className="hm-head">
        <h2>{p.name}{p.milestone !== null && <span className="hm-ms">{p.milestone}</span>}</h2>
        {here ? <span className="asof">{age}</span> : <span className="asof stale">{age}: no session runs here</span>}
      </div>
      {notes.map((n) => <p key={n} className="nothing">{n}</p>)}
      {total > 0 && (
        <div className="hm-prog">
          <div className="hm-bar" role="img" aria-label={`${p.counts.merged} of ${total} issues merged, ${p.counts.flight} in flight, ${p.counts.queued} queued`}>{bar.map((k, i) => <i key={i} className={k} />)}</div>
          <div className="hm-legend"><span>{p.counts.merged} of {total} merged</span><span>{p.counts.flight} in flight</span><span>{p.counts.queued} queued</span>{p.counts.outside > 0 && <span className="hm-out">{p.counts.outside} more in flight outside it</span>}</div>
        </div>
      )}
      {p.rows.length ? (
        <>
          <div className="bcols hm-cols" aria-hidden="true"><span>Issue</span><span>Stage</span><span>Now</span><span>State</span></div>
          {ranked(p.rows, sessions).map(({ row, key }) => <Row key={row.number} row={row} state={key} project={p} sessions={sessions} now={now} />)}
        </>
      ) : <div className="hm-also">Nothing is in flight.</div>}
      {p.counts.queued > 0 && <div className="hm-also"><b>Queued</b><span>{count(p.counts.queued, 'issue')}</span></div>}
      {p.counts.merged > 0 && <div className="hm-also"><b>Merged</b><span>{count(p.counts.merged, 'issue')}</span></div>}
      <NotOnIssue project={p} sessions={sessions} now={now} />
      <div className="hm-foot">
        <span className="hm-spend"><span>This month <b className="num">{usd(p.spent, p.costPartial)}</b>{p.goal ? ` of ${usd(p.goal)} goal` : ', no goal set'}</span>{p.goal && <div className="bar" role="img" aria-label={`${pct}% of the goal`}><i style={{ width: `${pct}%` }} /></div>}</span>
        <span className="hm-links"><a className="hm-lnk" href={factoryHref(p, 'map')}>Open the map</a><a className="hm-lnk" href={factoryHref(p, 'board')}>Open the board</a></span>
      </div>
    </section>
  );
}

/** What the card needs: the server's changes since the mark (null: a first look) and how many there were in all (the server cuts its list), and what Caught up does. */
export type Since = { changes: readonly Change[]; total: number; mark: number | null; onCaughtUp: () => void };
const hiddenOf = (since: Since) => Math.max(0, since.total - since.changes.length);
const feedFor = (since: Since, projects: readonly HomeProject[], sessions: readonly Session[], now: number) =>
  feedOf(since.changes, stalls(projects, sessions, sinceOf(since.mark, now)), hiddenOf(since) > 0);

/** Since you last looked, beside the projects: a row per change, newest first, to the issue's page; Caught up moves the mark to when the list shown was asked for. */
export function SinceCard({ since, projects, sessions, now }: { since: Since; projects: readonly HomeProject[]; sessions: readonly Session[]; now: number }) {
  const rows = feedFor(since, projects, sessions, now);
  // Caught up removes its own button, so the heading takes the focus (a keyboard user is not dropped on the page).
  const caught = () => {
    since.onCaughtUp();
    globalThis.document?.getElementById('since-h')?.focus({ preventScroll: true });
  };
  return (
    <section className="card hm-side" aria-label="Since you last looked">
      <div className="hm-head"><h2 id="since-h" tabIndex={-1}>Since you last looked</h2><span className="asof">{hintOf(rows.length, since.mark, now, hiddenOf(since))}</span></div>
      {!rows.length && (
        <div className="hm-none"><b>{since.mark === null ? 'Nothing changed in the past 24 hours.' : `Nothing changed since ${whenOf(since.mark, now)}.`}</b>
          <p>A PR opened or merged, a review, a test run, and a session starting or stalling all show here.</p></div>
      )}
      {rows.length > 0 && since.mark === null && <div className="hm-also">This is the first look from this browser, so it shows the past 24 hours.</div>}
      {rows.map(({ change: c, tone, what, sub, code }, i) => (
        <div key={`${c.kind}-${c.project}-${c.issue}-${c.at}-${i}`} className={tone ? `hm-fd t-${tone}` : 'hm-fd'}>
          <span className="t">{dayOf(c.at, now) && <small>{dayOf(c.at, now)}</small>}{timeOf(c.at)}</span><i className="dot" aria-hidden="true" />
          <div><a href={issueHref(c.project, c.issue)}>{`#${c.issue}${c.title ? ` ${c.title}` : ''}`}</a> {what}<span className="sub">{sub}{code && <> <code>{code}</code></>}</span></div>
        </div>
      ))}
      {rows.length > 0 && <div className="hm-foot pad"><button type="button" className="btn" onClick={caught}>Caught up</button><span>Moves the mark to now. A reload keeps this list.</span></div>}
    </section>
  );
}

/** The page for an answer: the sentence, a card per project with Since you last looked beside them, the quiet ones folded at the foot. `since` is left out until /api/changes has answered. */
export function HomeView({ data, sessions, now, since }: { data: HomeData; sessions: readonly Session[]; now: number; since?: Since }) {
  const clause = since ? sinceClause(feedFor(since, data.projects, sessions, now), since.mark, now, hiddenOf(since)) : undefined;
  const said = homeSentence(data.projects, sessions, clause);
  return (
    <>
      <Reading said={said} by="Counted from the rows below. No model writes this." />
      <div className="hm-grid">
        <div className="hm-stack">
          {!data.projects.length && <div className="empty"><b>No session in the past 30 days.</b><span>Home lists the projects a session ran in, with the issues in flight. It starts when a session runs with the agent-orb plugin.</span></div>}
          {data.projects.map((p) => <Card key={p.name} project={p} sessions={sessions} now={now} />)}
          {data.quiet.length > 0 && (
            <details className="card hm-quiet">
              <summary>{data.quiet.length} quiet {data.quiet.length === 1 ? 'project' : 'projects'}, with no session in the past 30 days</summary>
              {data.quiet.map((q) => <div key={q.name} className="hm-also"><b>{q.name}</b><span>last session on {day(q.last, now)}</span></div>)}
            </details>
          )}
        </div>
        {since && <SinceCard since={since} projects={data.projects} sessions={sessions} now={now} />}
      </div>
    </>
  );
}

export const HomeError = ({ message }: { message: string }) => <div className="empty" role="alert"><b>Home could not load.</b><span>{message}</span></div>;

/**
 * `sessions`: the ones Live shows, for who is on each issue and the running count. The page and the card's changes are asked for together, again every 30 seconds as the Factory board is, and at once when the mark moves.
 * Caught up moves the mark to when the list on show was asked for, never to now: what arrived while it was on the screen is still ahead of the mark.
 */
export function Home({ now, sessions }: { now: number; sessions: readonly Session[] }) {
  const [data, setData] = useState<HomeData>();
  const [error, setError] = useState<string>();
  const [mark, setMark] = useState(() => loadMark());
  const [shown, setShown] = useState<{ changes: Change[]; total: number; askedAt: number }>();
  useEffect(() => {
    let alive = true;
    const loadHome = async () => {
      try {
        const res = await fetch(`/api/home?${new URLSearchParams({ tz: tz() })}`);
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        const body = (await res.json()) as HomeData;
        if (alive) setData(body), setError(undefined);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    // A failed read leaves the card as it was; Home's own error is the page's.
    const loadChanges = async () => {
      const askedAt = Date.now();
      try {
        const res = await fetch(`/api/changes?${new URLSearchParams({ since: String(sinceOf(mark, askedAt)) })}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { changes: Change[]; total: number };
        if (alive) setShown({ changes: body.changes, total: body.total, askedAt });
      } catch {
        // the card keeps what it had
      }
    };
    const load = () => void Promise.all([loadHome(), loadChanges()]);
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [mark]);
  const caughtUp = () => {
    if (!shown) return;
    saveMark(shown.askedAt);
    setShown({ changes: [], total: 0, askedAt: shown.askedAt });
    setMark(shown.askedAt);
  };
  return (
    <main className="home">
      <PageHeader title="Home" sub="What's going on, across your projects" />
      {error && <HomeError message={error} />}
      {!data && !error && <Loading>Reading your projects…</Loading>}
      {data && <HomeView data={data} sessions={sessions} now={now} {...(shown ? { since: { changes: shown.changes, total: shown.total, mark, onCaughtUp: caughtUp } } : {})} />}
    </main>
  );
}
