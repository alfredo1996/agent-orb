import { useEffect, useState } from 'react';
import { ageText, count, issueHref, outsideNote, REFRESH_MS, STAGE_LABEL, Track, type BoardIssue } from './Factory.tsx';
import { modelLabel, usd } from './format.ts';
import { homeSentence, ranked, STATES } from './home-view.ts';
import { Loading, PageHeader, Reading } from './kit.tsx';
import type { Session } from './Live.tsx';
import { agentName, sentence } from './live-cards.ts';
import { doingOn, nowOn } from './now-on.ts';
import { factoryHash, hashWith } from './project-choice.ts';

// Home (v0.5 slice 3, #107; the plan is #64), drawn as approved in design/home-issue.html, the Home board, from GET /api/home: a card per project with a session in the past 30 days, most recent first, with
// the rows in flight worst first, who is on each now (the sessions Live shows, joined by the board's own list of an issue's sessions), and the issues it shares files with. Queued and merged issues are counts,
// so a card stays short. The sentence on top is counted from the rows and the stream, and no model writes it. Read only: a row opens its issue's page, and the card links to the milestone's Map and board.
// Since you last looked (slice 4) is not here yet.

/** A row of GET /api/home: the board's own row for an issue in flight, with the issues it shares files with (`together`: both in flight), a PR's open findings, and its budget when one is set (`mark` is /api/budget's). */
export type HomeRow = BoardIssue & { shares: { issue: number; together: boolean }[]; openFindings?: true; budget?: { usd: number; budget: number; mark: 'at80' | 'at100' | null; partial: boolean } };
export type HomeProject = {
  name: string; last: number; milestone: string | null; counts: { merged: number; flight: number; queued: number; outside: number }; rows: HomeRow[]; readAt: number | null;
  notOnIssue: { count: number; sessions: { id: string; branch: string | null; at: number }[] }; month: string; goal: number | null; spent: number; costPartial: boolean;
};
export type HomeData = { projects: HomeProject[]; quiet: { name: string; last: number }[] };

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; // not toLocaleDateString: ICU spells September "Sept" in some builds
const day = (ms: number) => `${new Date(ms).getDate()} ${MONTHS[new Date(ms).getMonth()]}`;
const modelOf = (tone: string) => (tone === 'other' ? '' : ` · ${tone[0]!.toUpperCase()}${tone.slice(1)}`);

/** The page's link to the project's Factory: the Map or the board, for the milestone the card shows. */
const factoryHref = (p: HomeProject, view: 'board' | 'map') => factoryHash(hashWith('#/factory', { project: p.name }), view, p.milestone === null ? undefined : { project: p.name, milestone: p.milestone }, p.name);

function Row({ row, state, project, sessions, now }: { row: HomeRow; state: keyof typeof STATES; project: HomeProject; sessions: readonly Session[]; now: number }) {
  const s = STATES[state];
  const { who } = nowOn(row, sessions);
  const doing = doingOn(row, sessions, now);
  const hot = row.shares.some((x) => x.together);
  const names = row.shares.map((x) => `#${x.issue}`);
  const spent = row.budget && row.budget.mark ? ` · ${usd(row.budget.usd, row.budget.partial)} of ${usd(row.budget.budget)}` : '';
  const none = row.ready === false && row.reason ? ` ${row.reason}` : row.ready ? ' Ready for your ok.' : '';
  return (
    <div className="brow hm-row" data-issue={row.number}>
      <div className="bissue">
        <a className="open" href={issueHref(project.name, row.number)} aria-label={`Issue #${row.number}: open its page`}><b>{`#${row.number}${row.title ? ` ${row.title}` : ''}`}</b></a>
        <small>{row.pr ? `PR #${row.pr.number}` : 'No PR'}{outsideNote(row, project.milestone)}</small>
        {names.length > 0 && <span className={hot ? 'hm-with together' : 'hm-with'}>Same files as {names.join(', ').replace(/, ([^,]*)$/, ' and $1')}</span>}
      </div>
      <div className="stagecell"><span>{STAGE_LABEL[row.stage]}</span><Track stage={row.stage} bad={row.bad} /></div>
      <div className="hm-now"><span className="lab">Now</span>
        {who && <span className={`model ${who.tone}`}>{who.name}{modelOf(who.tone)}</span>}
        <span className="sub">{doing ?? `No session is on it.${none}`}{spent}</span>
      </div>
      <span className={`state ${s.tone}`}>{s.label}</span>
    </div>
  );
}

/** The running sessions of the project on no issue, by agent and branch (the server names those of the past 30 days; only a running one is in the stream), then how many more there were. */
function NotOnIssue({ project, sessions, now }: { project: HomeProject; sessions: readonly Session[]; now: number }) {
  const { count: total, sessions: named } = project.notOnIssue;
  if (!total) return null;
  const ids = new Set(named.map((s) => s.id));
  const running = sessions.filter((s) => !s.endedAt && s.project === project.name && ids.has(s.id));
  const more = total - running.length;
  return (
    <div className="hm-also">
      <b>Not on an issue</b>
      {running.map((s) => {
        const main = s.agents.find((a) => a.depth === 0) ?? s.agents[0];
        const tone = modelLabel(main?.model).tone || 'other';
        const verb = main && sentence(main, [], now).verb;
        return <span key={s.id}>{main && <span className={`model ${tone}`}>{agentName(main.type)}{modelOf(tone)}</span>} on <code>{named.find((n) => n.id === s.id)?.branch ?? 'no branch'}</code>{verb && `, ${verb[0]!.toLowerCase()}${verb.slice(1)}`}</span>;
      })}
      {more > 0 && <span>{running.length ? `${more} more` : count(more, 'session')} in the past 30 days</span>}
    </div>
  );
}

function Card({ project: p, sessions, now }: { project: HomeProject; sessions: readonly Session[]; now: number }) {
  const total = p.counts.merged + p.counts.flight + p.counts.queued;
  const bar = [...'m'.repeat(p.counts.merged), ...'f'.repeat(p.counts.flight), ...'q'.repeat(p.counts.queued)];
  const here = sessions.some((s) => !s.endedAt && s.project === p.name); // the plugin is what reads GitHub: with no session running here, the data is as old as the last one
  const age = p.readAt === null ? 'No GitHub data yet' : ageText(p.readAt, now);
  const pct = p.goal ? Math.min(100, Math.round((100 * p.spent) / p.goal)) : 0;
  return (
    <section className="card board home-card" aria-label={p.name}>
      <h2><span>{p.name}{p.milestone !== null && <span className="hm-ms">{p.milestone}</span>}</span>{here ? <span className="asof">{age}</span> : <span className="asof stale">{age}: no session runs here</span>}</h2>
      {p.milestone === null && <p className="nothing">No milestone has open issues.</p>}
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

/** The page for an answer: the sentence, a card per project, the quiet ones folded at the foot. */
export function HomeView({ data, sessions, now }: { data: HomeData; sessions: readonly Session[]; now: number }) {
  return (
    <>
      <Reading said={homeSentence(data.projects, sessions)} by="Counted from the rows below. No model writes this." />
      {!data.projects.length && <div className="empty"><b>No session in the past 30 days.</b><span>Home lists the projects a session ran in, with the issues in flight. It starts when a session runs with the agent-orb plugin.</span></div>}
      {data.projects.map((p) => <Card key={p.name} project={p} sessions={sessions} now={now} />)}
      {data.quiet.length > 0 && (
        <details className="card hm-quiet">
          <summary>{data.quiet.length} quiet {data.quiet.length === 1 ? 'project' : 'projects'}, with no session in the past 30 days</summary>
          {data.quiet.map((q) => <div key={q.name} className="hm-also"><b>{q.name}</b><span>last session on {day(q.last)}</span></div>)}
        </details>
      )}
    </>
  );
}

/** `sessions`: the ones Live shows, for who is on each issue and the running count. Asked for again every 30 seconds, as the Factory board is. */
export function Home({ now, sessions }: { now: number; sessions: readonly Session[] }) {
  const [data, setData] = useState<HomeData>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/home?${new URLSearchParams({ tz: tz() })}`);
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        const body = (await res.json()) as HomeData;
        if (alive) setData(body), setError(undefined);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return (
    <main className="home">
      <PageHeader title="Home" sub="What's going on, across your projects" />
      {error && <div className="empty"><b>Home could not load.</b><span>{error}</span></div>}
      {!data && !error && <Loading>Reading your projects…</Loading>}
      {data && <HomeView data={data} sessions={sessions} now={now} />}
    </main>
  );
}
