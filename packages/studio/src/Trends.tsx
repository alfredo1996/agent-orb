import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useBars } from './bars.ts';
import { plural, tokens } from './format.ts';
import { Explain, Figures, PageHeader, PeriodSelect, ProjectSelect, Reading, Say, Seg, useProject, useReveal } from './kit.tsx';
import { busiestOf, niceMax, roundedTop } from './ledger-math.ts';
import {
  PARTS, axisMoney, barSegments, compare, compareSentence, commitLine, fillBuckets, firstFiles, gitFiles, goalTitle, goalView, listLine, listed, markers, money,
  numbered, parseGoalInput, pillWidth, seenLabels, seenOf, spanOf, totalOf, trendFigures, trendLabel, trendsReading, type Change, type Goal, type Marker, type Numbered, type Split, type TBucket,
  type TrendUnit,
} from './trends-math.ts';

// The Ledger's Trends view (v0.2 slice 1), drawn as approved in design/v0.2-measure.html and read again in design/v0.3-readable.html (#102), from GET /api/trends:
// a reading and four figures, then API-equivalent cost per week or day for one project, by who spent or by model, with its changes (the days its agents, skills or
// CLAUDE.md changed, by git or by a plugin's fingerprint at a session start) marked, listed and compared in the row of the one that is open. Under it, the project's
// monthly goal (slice 3, GET and PUT /api/goal).

export type Loaded = { project: string; unit: TrendUnit; from: number; to: number; buckets: TBucket[]; changes: Change[] };

const REFRESH_MS = 60_000; // as the Ledger's
const COMMAND = 'docker compose -f deploy/docker-compose.yml run --rm -e ORB_HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)" -v ~/.claude/projects:/import:ro orb-server import /import';
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const get = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  return (await res.json()) as T;
};
/** PUT as JSON; a refusal throws the server's own words (`{ error }`), as the goal's 400, 403 and 404 send them. */
const put = async (url: string, body: object) => {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the server answered ${res.status}`);
};

export function Trends({ views, hidden }: { views: ReactNode; hidden: boolean }) {
  const [unit, setUnit] = useState<TrendUnit>('week');
  const [split, setSplit] = useState<Split>('who');
  const { project, projects } = useProject(true); // one project: Trends never offers all of them
  const [data, setData] = useState<Loaded>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!project || hidden) return; // the Ledger keeps this view mounted while Totals shows: nothing loads or polls until it is shown
    let live = true;
    const load = async () => {
      const r = spanOf(unit, new Date());
      try {
        const body = await get<{ buckets: TBucket[]; changes: Change[] }>(`/api/trends?${new URLSearchParams({ project, unit, from: String(r.from), to: String(r.to), tz: tz() })}`);
        if (!live) return;
        setData({ project, unit, ...r, ...body }); // the unit and span ride with the data, so a bar is never drawn on another unit's axis
        setError(undefined);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [project, unit, hidden]);

  return (
    <main className="ledger trends" hidden={hidden}>
      <PageHeader title="Ledger" sub="What a day costs, and what each change did to it" views={views} project={<ProjectSelect one />}
        period={<PeriodSelect value={unit} onChange={setUnit} options={[['week', 'Last 12 weeks'], ['day', 'Last 30 days']]} />} />

      {error && <div className="empty"><b>Trends could not load.</b><span>{error}</span></div>}
      {projects?.length === 0 && <NoHistory />}
      {data && !data.buckets.length && (
        data.unit === 'week' ? <NoHistory project={data.project} /> : <div className="empty"><b>No requests for {data.project} in the last 30 days.</b><span>Week shows the last 12 weeks.</span></div>
      )}

      {data && data.buckets.length > 0 && <TrendsBody data={data} project={project} split={split} onSplit={setSplit} hidden={hidden} />}
    </main>
  );
}

/** Everything under the header once the project has history: the reading, the four figures, the chart with its changes, the monthly goal. */
export function TrendsBody({ data, project, split, onSplit, hidden }: { data: Loaded; project: string; split: Split; onSplit: (s: Split) => void; hidden: boolean }) {
  const series = useMemo(() => fillBuckets(data.buckets, data.unit, data.from, data.to), [data]);
  const changes = useMemo(() => numbered(data.changes), [data]);
  const marks = useMemo(() => markers(changes, data.unit), [changes, data]);
  return (
    <>
      <Reading said={trendsReading(series, data.unit)} />
      <Figures items={trendFigures(series, data.unit)} cols={4} label={data.unit === 'week' ? 'This week against last week' : 'Today against yesterday'} />

      <TrendChart series={series} unit={data.unit} split={split} onSplit={onSplit} marks={marks} changes={changes} />

      <GoalCard key={project} project={project} hidden={hidden} />

      <p className="foot">
        Cost is API-equivalent: what these tokens would cost at API list prices, not what a plan bills.{' '}
        {data.unit === 'week' ? 'The current week runs to today.' : 'Today runs to now.'}
      </p>
    </>
  );
}

const TICKS = [0, 0.2, 0.4, 0.6, 0.8, 1];
const TIP_ID = 'trends-tip';

function TrendChart({ series, unit, split, onSplit, marks, changes }: {
  series: TBucket[]; unit: TrendUnit; split: Split; onSplit: (s: Split) => void; marks: Marker[]; changes: Numbered[];
}) {
  const [all, setAll] = useState(false); // the change list shows 5 until asked for the rest
  const [open, setOpen] = useState<{ id?: string; reveal: boolean }>(); // the change whose before and after is open; none clicked yet: the latest. `reveal`: it was a marker's click, from above the list
  const openId = open ? open.id : changes.at(-1)?.id;
  const toggle = (id: string) => setOpen(openId === id ? { reveal: false } : { id, reveal: false });
  const pickMark = (id: string) => {
    setOpen({ id, reveal: true });
    if (!listed(changes, all).shown.some((c) => c.id === id)) setAll(true); // an older change is behind "Show All"
  };
  const parts = PARTS[split];
  const shown = parts.filter((p) => p.key !== 'other' || series.some((b) => b.other > 0));
  const totals = series.map((b) => totalOf(b, split));
  const labels = series.map((b, i) => money(totals[i]!, b.costPartial));
  const star = busiestOf(totals);
  // Every bar carries its total when the labels fit side by side (12 px mono is 7.2 px a character), else only the busiest.
  const every = (slot: number) => slot >= 7.2 * Math.max(...labels.map((l) => l.length)) + 6;
  const { box, tip, W, at, bar, svg } = useBars(series.length, star, (i) => series[i] && { x: barX(i), w: bw, top: y(totals[i]!) - (labelled(i) ? 20 : 0) });
  const H = 280, L = 56, R = 12, T = 48, B = 30; // T leaves room for the change markers and the busiest bar's total
  const max = niceMax(Math.max(0, ...totals));
  const y = (v: number) => H - B - (v / max) * (H - B - T);
  const slot = (W - L - R) / Math.max(1, series.length);
  const bw = Math.min(44, slot * 0.56);
  const barX = (i: number) => L + slot * i + (slot - bw) / 2;
  const labelled = (i: number) => i === star || every(slot);
  const label = (key: string) => trendLabel(key, unit);
  const name = (key: string) => (unit === 'week' ? `Week of ${label(key)}` : label(key));
  const skip = Math.max(1, Math.ceil(series.length / Math.floor((W - L - R) / 64))); // an axis label every 64 px at most
  const place = new Map(series.map((b, i) => [b.bucket, i]));
  const h = at === undefined ? undefined : series[at];

  return (
    <section className="card" aria-label={`API-equivalent per ${unit}`}>
      <div className="chead">
        <h2>API-equivalent per {unit}</h2>
        <Seg value={split} onChange={onSplit} label="Split by" options={[['who', 'By who spent'], ['model', 'By model']]} />
      </div>
      <ul className="daybars" aria-label={`API-equivalent per ${unit}, ${split === 'who' ? 'by who spent' : 'by model'}`}>
        {series.map((b, i) => (
          <Fragment key={b.bucket}>
            {marks.filter((m) => m.pos.bucket === b.bucket).map((m) => (
              <li key={m.key} className="mkrow"><span className="mkdot">{m.label}</span><span>{m.text}</span></li>
            ))}
            <li className="dayrow">
              <span className="dl">{label(b.bucket)}</span>
              <span className="stk" style={{ width: `${(totals[i]! / (totals[star] || 1)) * 100}%` }}>
                {shown.filter((p) => b[p.key] > 0).map((p) => <i key={p.key} style={{ flex: b[p.key], background: p.color }} />)}
              </span>
              <span className="num">{labels[i]}</span>
            </li>
          </Fragment>
        ))}
      </ul>
      <div className="chartbox">
        <div className="plot" ref={box}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`Stacked bars of API-equivalent cost per ${unit}, ${split === 'who' ? 'by who spent' : 'by model'}, with ${plural(changes.length, 'change')} marked`} {...svg}>
            <g className="grid">{TICKS.map((f) => <line key={f} x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} />)}</g>
            <g className="axis">
              {TICKS.map((f) => <text key={f} x={L - 8} y={y(max * f) + 4} textAnchor="end">{axisMoney(max * f)}</text>)}
              {series.map((b, i) => (i % skip ? null : <text key={b.bucket} x={L + slot * i + slot / 2} y={H - 6} textAnchor="middle">{label(b.bucket)}</text>))}
            </g>
            {marks.map((m) => {
              const i = place.get(m.pos.bucket);
              if (i === undefined) return null;
              const x = L + slot * i + slot * m.pos.frac; // behind the bars and their totals: drawn first
              const pick = () => pickMark(m.pick);
              const w = pillWidth(m.label), px = Math.min(Math.max(x, w / 2 + 1), W - w / 2 - 1); // the pill stays inside the plot; its line stays where the change is
              return (
                <g key={m.key} className="mk" role="button" tabIndex={0} aria-pressed={!!openId && m.ids.includes(openId)} aria-label={m.name}
                  onClick={pick} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}>
                  <line x1={x} x2={x} y1={25} y2={H - B} />
                  <rect x={px - w / 2} y={3} width={w} height={22} rx={11} />
                  <text x={px} y={18} textAnchor="middle">{m.label}</text>
                </g>
              );
            })}
            {series.map((b, i) => (
              <g key={b.bucket} className="bar" role="img" aria-label={`${name(b.bucket)}: ${labels[i]}`} aria-describedby={at === i ? TIP_ID : undefined} {...bar(i)}>
                <rect className="hit" x={L + slot * i} y={T} width={slot} height={H - B - T} fill="transparent" />
                {barSegments(b, split, y).map((s) => s.top
                  ? <path key={s.key} d={roundedTop(barX(i), s.y, bw, s.h, Math.min(4, s.h, bw / 2))} fill={s.color} />
                  : <rect key={s.key} x={barX(i)} y={s.y} width={bw} height={s.h} fill={s.color} />)}
                {labelled(i) && totals[i]! > 0 && <text className="tot" x={barX(i) + bw / 2} y={y(totals[i]!) - 8} textAnchor="middle">{labels[i]}</text>}
              </g>
            ))}
          </svg>
          {h && (
            <div className="tip" id={TIP_ID} role="tooltip" ref={tip}>
              <b>{name(h.bucket)} · {labels[at!]}</b>
              {shown.filter((p) => h[p.key] > 0).map((p) => <span key={p.key} className="row"><span>{p.name}</span><span>{money(h[p.key])}</span></span>)}
              <span className="row"><span>A prompt</span><span>{h.prompts ? money(totals[at!]! / h.prompts) : '—'}</span></span>
            </div>
          )}
        </div>
      </div>
      <div className="legend">{shown.map((p) => <span key={p.key} className="model" style={{ '--m': p.color } as CSSProperties}>{p.long}</span>)}</div>

      {changes.length > 0 && <ChangeList changes={changes} all={all} onAll={() => setAll(true)} open={openId} reveal={open?.reveal} onToggle={toggle} />}

      <details className="tableview">
        <summary>Show as a table</summary>
        <div className="tw"><table>
          <thead><tr>
            <th>{unit === 'week' ? 'Week of' : 'Day'}</th>{shown.map((p) => <th key={p.key} className="r">{p.name}</th>)}<th className="r">Total</th>
            <th className="r d-only">Tokens</th><th className="r d-only">Active days</th><th className="r d-only">Prompts</th>
          </tr></thead>
          <tbody>
            {series.map((b, i) => (
              <tr key={b.bucket}>
                <td>{label(b.bucket)}</td>
                {shown.map((p) => <td key={p.key} className="r num">{money(b[p.key])}</td>)}
                <td className="r num"><b>{labels[i]}</b></td>
                <td className="r num d-only">{tokens(b.tokens)}</td><td className="r num d-only">{b.activeDays}</td><td className="r num d-only">{b.prompts.toLocaleString('en')}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </details>
    </section>
  );
}

/**
 * The changes, newest first, five until all are asked for. The one that is open carries its before and after in its own row, right under it (#102): the panel used to
 * open below the whole list, off screen.
 */
export function ChangeList({ changes, all, onAll, open, reveal = false, onToggle }: {
  changes: Numbered[]; all: boolean; onAll: () => void; open?: string; reveal?: boolean; onToggle: (id: string) => void;
}) {
  const { shown, hidden } = listed(changes, all);
  return (
    <>
      <p className="mkhint">The numbered markers are changes to the project's agents, skills or CLAUDE.md. Open one to see what it did to the cost.</p>
      <ul className="mklist" aria-label="Changes">
        {shown.map((c) => {
          const l = listLine(c), isOpen = open === c.id;
          return (
            <li key={c.id}>
              <button type="button" className="mkbtn" aria-expanded={isOpen} aria-controls={`chg-${c.n}`} onClick={() => onToggle(c.id)}>
                <span className="mkdot">{c.n}</span>
                <span className="mkt"><span className="mkx">{l.head}</span><small>{l.sub}</small></span>
                <span className="act">{isOpen ? 'Hide before and after' : 'Show before and after'}</span>
              </button>
              {isOpen && <ChangeRow change={c} reveal={reveal} />}
            </li>
          );
        })}
      </ul>
      {hidden > 0 && <div className="mkmore"><button type="button" className="btn" onClick={onAll}>Show All {changes.length}</button></div>}
      <Explain summary="How a change is found and compared">
        A change is a day the project's agents, skills or CLAUDE.md changed in git: the plugin sends the last 90 days of those commits, from every branch, each change on the day it first appeared, at each session start.
        Files your sessions saw change that no commit explains, your own CLAUDE.md and rules included, show as seen at a session start, on that session's day.
        Before and after compare up to 7 whole days on each side, per active day, so a quiet weekend doesn't read as a saving.
      </Explain>
    </>
  );
}

// One change opened: a sentence, the days before it against the days after it, the commits of its day, what they touched, and what a fingerprint saw change at a session start.
function ChangeRow({ change, reveal }: { change: Numbered; reveal: boolean }) {
  const ref = useReveal<HTMLDivElement>(reveal);
  const { head, rows } = compare(change);
  const { shown, more } = firstFiles(gitFiles(change));
  const seen = firstFiles(seenOf(change));
  return (
    <div className="cbody" id={`chg-${change.n}`} ref={ref}>
      <p className="sentence"><Say said={compareSentence(change)} /></p>
      <div className="tw"><table className="ba">
        <thead><tr><th aria-label="Per active day" /><th className="r num">{head[0]}</th><th className="r num">{head[1]}</th><th className="r" aria-label="Change" /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td><td className="r num">{r.before}</td><td className="r num">{r.after}</td><td className={`r num${r.down ? ' down' : ''}`}>{r.delta}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="what">
        <h3>What changed</h3>
        {change.commits.length > 0 && (
          <ul className="commits">
            {change.commits.map((c) => {
              const l = commitLine(c);
              return <li key={c.sha}><code>{l.sha}</code><span className={c.subject ? undefined : 'd'}>{l.subject}</span></li>;
            })}
          </ul>
        )}
        {shown.length > 0 && (
          <ul className="files">
            {shown.map((f) => <li key={f}><code>{f}</code></li>)}
            {more > 0 && <li className="d">and {more} more</li>}
          </ul>
        )}
        {seen.shown.length > 0 && (
          <div className="seen">
            <h3>Seen at a session start</h3>
            <ul className="files">
              {seen.shown.map((f) => {
                const labels = seenLabels(f);
                return <li key={f.path}><code>{f.path}</code>{labels.length > 0 && <span className="d"> · {labels.join(' · ')}</span>}</li>;
              })}
              {seen.more > 0 && <li className="d">and {seen.more} more</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// The project's goal for the month, in API-equivalent dollars (GET and PUT /api/goal). The status line warns from 80% and nothing is ever stopped.
// Keyed by project, so a typed amount or an error never follows the select to another one.
function GoalCard({ project, hidden }: { project: string; hidden: boolean }) {
  const [goal, setGoal] = useState<Goal>();
  const [failed, setFailed] = useState<string>(); // the last read's error, shown only while there is no goal to show
  const [draft, setDraft] = useState<string>(); // the amount being typed; undefined when not editing
  const [error, setError] = useState<string>(); // the server's words on a save it refused
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setGoal(await get<Goal>(`/api/goal?${new URLSearchParams({ project, tz: tz() })}`));
      setFailed(undefined);
    } catch (e) {
      setFailed((e as Error).message);
    }
  }, [project]);
  useEffect(() => {
    if (hidden) return; // nothing loads or polls while the Ledger shows Totals
    void load();
    const t = setInterval(load, REFRESH_MS); // the month's spend moves with the day
    return () => clearInterval(t);
  }, [load, hidden]);

  const save = async (usd: number | null) => {
    setBusy(true);
    setError(undefined);
    try {
      await put('/api/goal', { project, usd });
      await load();
      setDraft(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const hint = <span className="hint">{project} · API-equivalent</span>;
  if (!goal) {
    return <section className="card" aria-label="Monthly goal"><h2>Monthly goal {hint}</h2><div className="gbody"><p role={failed ? 'alert' : undefined}>{failed ?? 'Loading the goal…'}</p></div></section>;
  }
  const has = !!goal.goal && goal.goal > 0;
  const v = has ? goalView({ ...goal, goal: goal.goal! }, new Date()) : undefined;
  const typed = draft === undefined ? undefined : parseGoalInput(draft);
  const invalid = typed && 'error' in typed ? typed.error : undefined;
  const problem = error ?? (draft?.trim() ? invalid : undefined); // an empty box just keeps Save off
  const cancel = () => { setDraft(undefined); setError(undefined); };

  return (
    <section className="card" aria-label="Monthly goal">
      <h2>{goalTitle(goal.month, has)} {hint}</h2>
      <div className="gbody">
        {v ? (
          <>
            <span className="big">{v.spent} <span className="of">{v.of}</span></span>
            <div className={v.band === 'data' ? 'bar' : `bar ${v.band}`} role="img" aria-label={v.label}><i style={{ width: `${v.fill}%` }} /><span className="tick" aria-hidden="true" /></div>
            <div className="meta"><span>{v.left}</span><span>at this pace <b>{v.pace}</b> by {v.by}</span><span>the status line warns from 80%</span></div>
          </>
        ) : (
          <p>A monthly goal in API-equivalent dollars for this project; the status line warns from 80%, and nothing is ever stopped.</p>
        )}
        {draft === undefined ? (
          <div><button type="button" className="btn" onClick={() => { setDraft(has ? String(goal.goal) : ''); setError(undefined); }}>{has ? 'Edit Goal' : 'Set Goal'}</button></div>
        ) : (
          <form className="gform" noValidate
            onSubmit={(e) => { e.preventDefault(); if (typed && 'usd' in typed && !busy) void save(typed.usd); }}
            onKeyDown={(e) => { if (e.key === 'Escape') cancel(); }}>
            <span aria-hidden="true">$</span>
            <input aria-label="Goal in dollars" type="number" inputMode="decimal" min="0" step="any" autoFocus value={draft} aria-invalid={!!problem}
              onChange={(e) => { setDraft(e.target.value); setError(undefined); }} />
            <button type="submit" className="btn primary" disabled={!!invalid || busy}>Save Goal</button>
            <button type="button" className="btn" onClick={cancel}>Cancel</button>
            {has && <button type="button" className="btn" disabled={busy} onClick={() => void save(null)}>Remove Goal</button>}
            {problem && <p className="gerr" role="alert">{problem}</p>}
          </form>
        )}
      </div>
    </section>
  );
}

// ponytail: the card names no source and no size: the studio cannot know how much history the logs hold, only that the graph has none.
export function NoHistory({ project }: { project?: string }) {
  return (
    <div className="empty nohist">
      <b>{project ? `No history for ${project} yet` : 'No history yet'}</b>
      <span>Claude Code keeps its own session logs on this Mac. Import them once and Trends starts with the past; the plugin carries on from there.</span>
      <pre className="cmd"><code>{COMMAND}</code></pre>
      <span>
        It reads tokens, models, agent types, timings and which skill ran. Never prompts, answers or tool output, whatever content is set to.
        Safe to run again: every event is keyed, so nothing is counted twice.
      </span>
      <p className="note"><b>These logs don't last.</b><span>Claude Code clears old logs by its <code>cleanupPeriodDays</code> setting, so the history worth importing can shrink. Import early.</span></p>
    </div>
  );
}
