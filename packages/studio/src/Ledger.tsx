import { useEffect, useState, type ReactNode } from 'react';
import { useBars } from './bars.ts';
import { duration, modelLabel, plural, tokens, usd } from './format.ts';
import { Figures, PageHeader, PeriodSelect, ProjectSelect, Reading, Seg, useProject } from './kit.tsx';
import { bucketLabel, busiest, FAILED_USUAL, families, fillDays, niceMax, rangeOf, roundedTop, stackSegments, type Bucket, type Family, type Unit } from './ledger-math.ts';
import { totalsFigures, totalsReading, type Range, type Sums, type Totals as TotalsData } from './totals-math.ts';
import { Trends } from './Trends.tsx';
import { Worth } from './Worth.tsx';

// The Ledger (PROJECT.md §8.2), drawn as approved in design/pages.html, from GET /api/ledger. Totals opens with a reading and figures that say what they mean (#102, design/v0.3-readable.html); Trends
// (v0.2 slice 1, design/v0.2-measure.html) is its second view, in Trends.tsx; Worth (v0.3 slice 2, design/v0.3-worth-truth.html) its third, in Worth.tsx.

export type Data = {
  totals: TotalsData;
  series: Bucket[];
  byProject: (Sums & { name: string; sessions: number; agents: number })[];
  byModel: (Sums & { model: string; agents: number })[];
  byRole: (Sums & { role: string; agents: number; types: string[] })[];
  efficiency: { project: string; tokens: number; requests: number; cacheShare: number | null; filesChanged: number; toolCalls: number; failedCalls: number; waitMs: number }[];
  analysis?: { runs: number; cost: number }; // Slice 7: analyses with Claude in the period, billed to the API credits
};

const REFRESH_MS = 60_000;
const pct = (n: number | null, digits = 1) => (n === null ? '—' : `${(n * 100).toFixed(digits)}%`);
const cost = (s: Sums) => (s.cost === null ? '—' : usd(s.cost, s.costPartial));
// ponytail: fixed thresholds for the amber/red hints; make them settings if they turn out wrong for someone.
const TOKENS_PER_FILE_BAD = 500_000;

export function Ledger() {
  const [view, setView] = useState<'totals' | 'trends' | 'worth'>('totals');
  const views = <Seg value={view} onChange={setView} label="Ledger view" options={[['totals', 'Totals'], ['trends', 'Trends'], ['worth', 'Worth']]} />;
  // All three stay mounted, the others hidden: switching keeps each one's range, unit, project and month, and a hidden one loads and polls nothing.
  return (
    <>
      <Totals views={views} hidden={view !== 'totals'} />
      <Trends views={views} hidden={view !== 'trends'} />
      <Worth views={views} hidden={view !== 'worth'} />
    </>
  );
}

function Totals({ views, hidden }: { views: ReactNode; hidden: boolean }) {
  const [range, setRange] = useState<Range>('7d');
  const [unit, setUnit] = useState<Unit>('day');
  const { project } = useProject(false); // '' is all projects: Totals is the one view that can show them
  const [data, setData] = useState<Data>();
  const [error, setError] = useState<string>();
  const [span, setSpan] = useState({ from: 0, to: 0 });

  useEffect(() => {
    if (hidden) return;
    let live = true;
    const load = async () => {
      const r = rangeOf(range, new Date());
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const q = new URLSearchParams({ from: String(r.from), to: String(r.to), unit, tz, ...(project ? { project } : {}) });
      try {
        const res = await fetch(`/api/ledger?${q}`);
        if (!res.ok) throw new Error(`the server answered ${res.status}`);
        const body = (await res.json()) as Data;
        if (!live) return;
        setData(body);
        setSpan(r);
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
  }, [range, unit, project, hidden]);

  const t = data?.totals;
  return (
    <main className="ledger" hidden={hidden}>
      <PageHeader title="Ledger" sub="What your agents used, and what it would cost" views={views} project={<ProjectSelect one={false} />}
        period={<PeriodSelect value={range} onChange={setRange} options={[['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']]} />} />

      {error && <div className="empty"><b>The Ledger could not load.</b><span>{error}</span></div>}
      {t && t.tokens === 0 && <div className="empty"><b>No requests in this period.</b><span>Pick a longer range, or run Claude Code with the agent-orb plugin.</span></div>}

      {t && t.tokens > 0 && data && <TotalsBody data={data} range={range} unit={unit} onUnit={setUnit} span={span} />}
    </main>
  );
}

/** Everything under the header once there are requests to show: the reading, the six figures, the chart, the rankings and the efficiency table. */
export function TotalsBody({ data, range, unit, onUnit, span }: { data: Data; range: Range; unit: Unit; onUnit: (u: Unit) => void; span: { from: number; to: number } }) {
  const t = data.totals;
  return (
    <>
      <Reading said={totalsReading(t, range)} />
      <Figures items={totalsFigures(t, data.efficiency, range)} cols={3} label="Totals" />

      <Chart series={unit === 'day' ? fillDays(data.series, span.from, span.to) : data.series} unit={unit} onUnit={onUnit} total={t} />

      <section className="grid3">
        <Ranked title="By project" rows={data.byProject.map((p) => ({ key: p.name, name: <span className="name">{p.name}</span>, sub: `${plural(p.sessions, 'session')} · ${plural(p.agents, 'agent')}`, sums: p }))} />
        <Ranked title="By model" rows={data.byModel.map((m) => {
          const l = modelLabel(m.model);
          return { key: m.model, name: <span className={`model ${l.tone}`}>{l.text}</span>, sub: plural(m.agents, 'agent'), sums: m, tone: l.tone };
        })} />
        <Ranked title="By role" rows={data.byRole.map((r) => ({ key: r.role, name: <span className="name">{r.role}</span>, sub: `${r.types.join(', ')} · ${r.agents}`, sums: r }))} />
      </section>

      <section className="card" aria-label="Efficiency by project">
        <h2>Efficiency by project <span className="hint">lower is better, except Read from cache</span></h2>
        <div className="tw"><table className="eff">
          <thead><tr><th>Project</th><th className="r">Tokens per file changed</th><th className="r">Calls that failed</th><th className="r">Read from cache</th><th className="r d-only">Agents waiting for you</th><th className="r d-only">Requests to the model</th></tr></thead>
          <tbody>
            {data.efficiency.map((e) => {
              const perFile = e.filesChanged ? e.tokens / e.filesChanged : null;
              const failed = e.toolCalls ? e.failedCalls / e.toolCalls : null;
              return (
                <tr key={e.project}>
                  <td className="name">{e.project}</td>
                  <td className={`r num${perFile !== null && perFile >= TOKENS_PER_FILE_BAD ? ' bad' : ''}`}>
                    {perFile === null ? '—' : tokens(perFile)} <span className="muted">· {e.filesChanged} file{e.filesChanged === 1 ? '' : 's'}</span>
                  </td>
                  <td className={`r num${failed !== null && failed >= FAILED_USUAL ? ' warn' : ''}`}>{pct(failed)}</td>
                  <td className="r num">{pct(e.cacheShare)}</td>
                  <td className="r num d-only">{duration(e.waitMs)}</td>
                  <td className="r num d-only">{e.requests.toLocaleString('en')}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </section>

      {!!data.analysis?.runs && (
        <p className="note">
          <b>Analyses with Claude: {data.analysis.runs} run{data.analysis.runs === 1 ? '' : 's'}, {usd(data.analysis.cost)}.</b>
          <span>Real spend on your API credits, not API-equivalent: each one ran only after you confirmed it on the Analysis page.</span>
        </p>
      )}
    </>
  );
}

// By project, by model and by role: one list. The name, a muted line and the bar (on the biggest row's scale) share the first cell,
// which takes what the numbers leave and never wraps, so the narrow three-column grid keeps one line per name.
function Ranked({ title, rows }: { title: string; rows: { key: string; name: ReactNode; sub: string; sums: Sums; tone?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.sums.tokens));
  return (
    <div className="card">
      <h2>{title} <span className="hint">tokens · API-equivalent</span></h2>
      <div className="tw"><table className="rank"><tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="rk" title={r.key}>
              {r.name}<span className="sub2">{r.sub}</span>
              <div className="bar"><i style={{ width: `${(r.sums.tokens / max) * 100}%`, ...(r.tone ? { background: `var(--${r.tone})` } : {}) }} /></div>
            </td>
            <td className="r num">{tokens(r.sums.tokens)}</td>
            <td className="r num">{cost(r.sums)}</td>
          </tr>
        ))}
      </tbody></table></div>
    </div>
  );
}

// Fifths of a 1-2-5 maximum land on round numbers (0, 10M, 20M … 50M).
const TICKS = [0, 0.2, 0.4, 0.6, 0.8, 1];
const COLOR: Record<Family, string> = { haiku: 'var(--haiku)', sonnet: 'var(--sonnet)', opus: 'var(--opus)', other: 'var(--faint)' };
const NAME: Record<Family, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', other: 'Other' };
const TOP_DOWN: Family[] = ['opus', 'sonnet', 'haiku', 'other']; // the legend, the tooltip, the table and the phone's bars (left to right) read as the stack looks
const TIP_ID = 'ledger-tip';
const UNIT_NAME = { day: 'Day', week: 'Week', month: 'Month' } as const;

export function Chart({ series, unit, onUnit, total }: { series: Bucket[]; unit: Unit; onUnit: (u: Unit) => void; total: Sums }) {
  // Drawn at its real width (not a scaled viewBox), so the text keeps its 12 px on a phone. Hover, focus and the keyboard: see useBars.
  const star = busiest(series);
  const { box, tip, W, at, bar, svg } = useBars(series.length, star, (i) => series[i] && { x: barX(i), w: bw, top: y(series[i].tokens) - (i === star ? 20 : 0) });
  const H = W < 500 ? 200 : 240, L = 44, R = 8, B = 24, T = 24; // T leaves room for the busiest bar's total
  const max = niceMax(Math.max(0, ...series.map((b) => b.tokens)));
  const y = (v: number) => H - B - (v / max) * (H - B - T);
  const slot = (W - L - R) / Math.max(1, series.length);
  const bw = Math.min(30, slot * 0.56);
  const barX = (i: number) => L + slot * i + (slot - bw) / 2;
  const label = (key: string) => bucketLabel(key, unit);
  const every = Math.max(1, Math.ceil(series.length / Math.floor((W - L - R) / 64))); // a label every 64 px at most
  const fam = series.map((b) => families(b.byModel));
  const shown = TOP_DOWN.filter((k) => k !== 'other' || fam.some((f) => f.other > 0));
  const h = at === undefined ? undefined : series[at];
  const hf = at === undefined ? undefined : fam[at];

  return (
    <section className="card" aria-label={`Tokens per ${unit}`}>
      <div className="chead">
        <h2>Tokens per {unit}, by model <span className="hint d-only">point at a {unit}, or tab to it, for its split and cost</span></h2>
        <Seg value={unit} onChange={onUnit} label="Group by" options={[['day', 'Day'], ['week', 'Week'], ['month', 'Month']]} />
      </div>
      <ul className="daybars" aria-label={`Tokens per ${unit} by model`}>
        {series.map((b, i) => (
          <li key={b.bucket} className="dayrow">
            <span className="dl">{label(b.bucket)}</span>
            <span className="stk" style={{ width: `${(b.tokens / (series[star]?.tokens || 1)) * 100}%` }}>
              {TOP_DOWN.filter((k) => fam[i]![k] > 0).map((k) => <i key={k} style={{ flex: fam[i]![k], background: COLOR[k] }} />)}
            </span>
            <span className="num">{tokens(b.tokens)}</span>
          </li>
        ))}
      </ul>
      <div className="chartbox">
        <div className="plot" ref={box}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`Stacked bars of tokens per ${unit} by model`} {...svg}>
            <g className="grid">{TICKS.map((f) => <line key={f} x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} />)}</g>
            <g className="axis">
              {TICKS.map((f) => <text key={f} x={L - 8} y={y(max * f) + 4} textAnchor="end">{f ? tokens(max * f).replace('.0', '') : '0'}</text>)}
              {series.map((b, i) => (i % every ? null : <text key={b.bucket} x={L + slot * i + slot / 2} y={H - 6} textAnchor="middle">{label(b.bucket)}</text>))}
            </g>
            {series.map((b, i) => (
              <g key={b.bucket} className="bar" role="img" aria-label={`${label(b.bucket)}: ${tokens(b.tokens)} tokens`} aria-describedby={at === i ? TIP_ID : undefined} {...bar(i)}>
                <rect className="hit" x={L + slot * i} y={T} width={slot} height={H - B - T} fill="transparent" />
                {stackSegments(fam[i]!, y).map((s) => s.top
                  ? <path key={s.fam} d={roundedTop(barX(i), s.y, bw, s.h, Math.min(4, s.h, bw / 2))} fill={COLOR[s.fam]} />
                  : <rect key={s.fam} x={barX(i)} y={s.y} width={bw} height={s.h} fill={COLOR[s.fam]} />)}
                {i === star && <text className="peak" x={barX(i) + bw / 2} y={y(b.tokens) - 8} textAnchor="middle">{tokens(b.tokens)}</text>}
              </g>
            ))}
          </svg>
          {h && hf && (
            <div className="tip" id={TIP_ID} role="tooltip" ref={tip}>
              <b>{label(h.bucket)} · {tokens(h.tokens)} tok</b>
              {shown.map((k) => <span key={k} className="row"><span>{NAME[k]}</span><span>{tokens(hf[k])}</span></span>)}
              <span className="row"><span>API-equivalent</span><span>{h.cost === null ? '—' : usd(h.cost)}</span></span>
            </div>
          )}
        </div>
      </div>
      <div className="legend">{shown.map((k) => <span key={k} className={`model ${k}`}>{NAME[k]}</span>)}</div>
      <details className="tableview">
        <summary>Show as a table</summary>
        <div className="tw"><table>
          <thead><tr><th>{UNIT_NAME[unit]}</th>{shown.map((k) => <th key={k} className="r">{NAME[k]}</th>)}<th className="r">Total</th><th className="r">API-equivalent</th></tr></thead>
          <tbody>
            {series.map((b, i) => (
              <tr key={b.bucket}>
                <td>{label(b.bucket)}</td>
                {shown.map((k) => <td key={k} className="r num">{tokens(fam[i]![k])}</td>)}
                <td className="r num">{tokens(b.tokens)}</td>
                <td className="r num">{b.cost === null ? '—' : usd(b.cost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td><b>Total</b></td>
              {shown.map((k) => <td key={k} className="r num"><b>{tokens(fam.reduce((n, f) => n + f[k], 0))}</b></td>)}
              <td className="r num"><b>{tokens(total.tokens)}</b></td>
              <td className="r num"><b>{cost(total)}</b></td>
            </tr>
          </tfoot>
        </table></div>
      </details>
    </section>
  );
}
