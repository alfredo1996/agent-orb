import { useEffect, useState, type ReactNode } from 'react';
import { modelOption } from './analysis-format.ts';
import { tokens, usd } from './format.ts';
import { Explain, PageHeader, PeriodSelect, ProjectSelect, Seg, useProject, useReveal } from './kit.tsx';
import { rangeOf } from './ledger-math.ts';
import { Patterns } from './Patterns.tsx';

// Analysis (PROJECT.md §15, 2026-10-21), drawn as approved in design/analysis.html: Claude reads a project's week and
// suggests changes. It runs only when the person presses Confirm after an estimate; past the monthly cap it can't.
// The page is two views (v0.3 slice 3, #45, design/v0.3-worth-truth.html): Patterns, in Patterns.tsx, and Reports, this page as it was.

type Model = { id: string; label: string; costPer1k: { input: number; output: number } };
type Row = { id: string; project: string; from_ts: number | null; to_ts: number | null; session: string | null; model: string; input_tokens: number; output_tokens: number; cost: number; created_at: number };
type Info = { keySet: boolean; defaultModel: string; maxOutput: number; models: Model[]; cap: number; spent: number; reports: Row[] };
type Reads = { sessions: number; agents: number; skillsRan: number; skillsIdle: number; toolCalls: number; failed: number; tokens: number; thinking: { steps: number; withText: number }; content: string };
type Estimate = { id: string; model: string; inputTokens: number; maxOutput: number; costMax: number; spent: number; cap: number; allowed: boolean; after: number; others: { model: string; costAbout: number }[] };
type Report = { summary: string; sections: { title: string; body: string; evidence: string[] }[]; changes: { title: string; why: string; saving: string }[] };
type Period = '7d' | '30d' | 'session';

const json = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${url.split('?')[0]} answered ${res.status}`);
  return body as T;
};
const post = <T,>(url: string, body: object, method = 'POST') => json<T>(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const day = (ts: number) => new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const when = (r: Row) => (r.session ? `session ${r.session.slice(0, 6)}` : r.from_ts && r.to_ts ? `${day(r.from_ts)}–${day(r.to_ts)}` : '');

type View = 'patterns' | 'reports';

export function Analysis({ initial = 'patterns' }: { initial?: View }) {
  const [view, setView] = useState<View>(initial);
  const [reportsOpened, setReportsOpened] = useState(initial === 'reports');
  const views = <Seg value={view} onChange={(v) => { setView(v); if (v === 'reports') setReportsOpened(true); }} label="Analysis view" options={[['patterns', 'Patterns'], ['reports', 'Reports']]} />;
  // Both stay mounted once shown, the other hidden, so Reports keeps its estimate and its open report. Reports is mounted when first picked: it loads on mount, and
  // Patterns is the page you open on.
  return (
    <>
      <Patterns views={views} hidden={view !== 'patterns'} />
      {reportsOpened && <Reports views={views} hidden={view !== 'reports'} />}
    </>
  );
}

function Reports({ views, hidden }: { views: ReactNode; hidden: boolean }) {
  const [info, setInfo] = useState<Info>();
  const [sessions, setSessions] = useState<{ id: string; started_at: number; tokens: number }[]>([]);
  const { project } = useProject(true); // one project: a report reads a single project's week
  const [period, setPeriod] = useState<Period>('7d');
  const [session, setSession] = useState('');
  const [model, setModel] = useState('');
  const [reads, setReads] = useState<Reads>();
  const [estimate, setEstimate] = useState<Estimate>();
  const [busy, setBusy] = useState<'estimate' | 'run'>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<{ row: Row; report: Report | null }>();
  const [capDraft, setCapDraft] = useState<string>();

  const refresh = () => json<Info>('/api/analysis').then((i) => { setInfo(i); setModel((m) => m || i.defaultModel); }).catch((e) => setError(e.message));
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (project) json<typeof sessions>(`/api/sessions?project=${encodeURIComponent(project)}`).then((l) => { setSessions(l); setSession(l[0]?.id ?? ''); }).catch(() => {});
  }, [project]);

  // The scope both reads and the estimate use; a change of scope or model makes an estimate stale.
  const scope = (): Record<string, string | number> | undefined => {
    if (!project || (period === 'session' && !session)) return undefined;
    if (period === 'session') return { project, session };
    const r = rangeOf(period, new Date());
    return { project, from: r.from, to: r.to };
  };
  const key = JSON.stringify([project, period, session]);
  useEffect(() => {
    setEstimate(undefined);
    const s = scope();
    if (!s) return;
    json<Reads>(`/api/analysis/reads?${new URLSearchParams(Object.entries(s).map(([k, v]) => [k, String(v)]))}`).then(setReads).catch(() => setReads(undefined));
  }, [key]);
  useEffect(() => setEstimate(undefined), [model]);

  const doEstimate = async () => {
    const s = scope();
    if (!s) return;
    setBusy('estimate'), setError(undefined);
    try { setEstimate(await post<Estimate>('/api/analysis/estimate', { ...s, model })); } catch (e) { setError((e as Error).message); }
    setBusy(undefined);
  };
  const doRun = async () => {
    if (!estimate) return;
    setBusy('run'), setError(undefined);
    try {
      const r = await post<Row & { report: Report | null }>('/api/analysis/run', { estimate: estimate.id });
      const { report, ...row } = r;
      setOpen({ row, report });
      setEstimate(undefined);
      await refresh();
    } catch (e) { setError((e as Error).message); setEstimate(undefined); await refresh(); }
    setBusy(undefined);
  };
  const openReport = async (row: Row) => {
    const r = await json<Row & { report: Report | { refused: true } | { unparsed: string } }>(`/api/analysis/reports/${row.id}`).catch(() => undefined);
    setOpen({ row, report: r && 'sections' in r.report ? r.report : null });
  };
  const saveCap = async () => {
    const usdValue = Number(capDraft);
    try { await post('/api/analysis/cap', { usd: usdValue }, 'PUT'); setCapDraft(undefined); setEstimate(undefined); await refresh(); } catch (e) { setError((e as Error).message); }
  };

  const label = (id: string) => info?.models.find((m) => m.id === id)?.label ?? id;
  const capShare = (n: number) => (info ? `${Math.min(100, (n / info.cap) * 100)}%` : '0%');
  const noKey = info !== undefined && !info.keySet;
  const reason = noKey ? 'Add an API key to estimate' : reads && !reads.sessions ? 'No sessions in this period.' : "Counts the input with the API's token counter; nothing is generated.";
  return (
    <main className="analysis" hidden={hidden}>
      <PageHeader title="Analysis" sub="Claude reads a week and suggests what to change" views={views} project={<ProjectSelect one />}
        period={<PeriodSelect value={period} onChange={setPeriod} options={[['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['session', 'One session']]} />} />
      {error && <div className="note bad"><b>{error}</b></div>}

      <div className="an">
        <section className="card" aria-label="New analysis">
          <h2>New analysis <span className="hint">nothing is sent until you confirm</span></h2>
          <div className="pad">
            <div className="fields">
              <label>Model<select value={model} onChange={(e) => setModel(e.target.value)}>
                {info?.models.map((m) => <option key={m.id} value={m.id}>{modelOption(m)}</option>)}
              </select></label>
              {period === 'session' && (
                <label className="wide">Session<select value={session} onChange={(e) => setSession(e.target.value)}>
                  {sessions.map((s) => <option key={s.id} value={s.id}>{new Date(s.started_at).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {tokens(s.tokens)} tok</option>)}
                </select></label>
              )}
            </div>
            {!reads && project && <span className="aside">Reading what a run would read…</span>}
            {reads && (
              <div className="reads" aria-label="What it reads">
                <span><b>{reads.sessions}</b> sessions</span><span><b>{reads.agents}</b> agents</span>
                <span><b>{reads.skillsRan}</b> skills that ran · <b>{reads.skillsIdle}</b> that never did</span>
                <span><b>{reads.toolCalls.toLocaleString('en')}</b> tool calls · <b>{reads.failed}</b> failed</span>
                <span><b>{tokens(reads.tokens)}</b> tokens by model</span>
                <span className={reads.thinking.withText ? '' : 'off'}>thinking: {reads.thinking.withText ? <><b>{reads.thinking.withText}</b> of {reads.thinking.steps} steps carry text</> : 'not captured'}</span>
                <span className={reads.content === 'off' ? 'off' : ''}>prompts and answers: <b>content {reads.content}</b></span>
              </div>
            )}
            {!estimate && (
              <div className="actions">
                <button type="button" className="btn primary" disabled={!info?.keySet || !reads?.sessions || busy === 'estimate'} onClick={doEstimate}>
                  {busy === 'estimate' ? 'Counting…' : 'Estimate'}
                </button>
                <span className="aside">{reason}</span>
              </div>
            )}
            {noKey && (
              <div className="note warn" role="note">
                <span className="i" aria-hidden="true">!</span>
                <p><b>No API key.</b> Add <code>ANTHROPIC_API_KEY</code> to <code>deploy/.env</code> and restart the server. Until then nothing can be sent.</p>
              </div>
            )}
            {estimate && info && (
              <div className="est" aria-label="The estimate">
                <div className="big">
                  <div className="kpi"><span className="label">Input, counted</span><span className="value">{estimate.inputTokens.toLocaleString('en')}</span></div>
                  <div className="kpi"><span className="label">Output, at most</span><span className="value">{estimate.maxOutput.toLocaleString('en')}</span></div>
                  <div className="kpi"><span className="label">Cost, at most</span><span className="value">{usd(estimate.costMax)}</span></div>
                </div>
                <p className="alt">
                  {estimate.others.map((o, i) => <span key={o.model}>{i ? ' · ' : 'Same input on '}<b>{label(o.model)}</b>: about <b>{usd(o.costAbout)}</b></span>)}. Prices per million tokens, input / output.
                </p>
                <div className="meter">
                  <span>This month <b>{usd(estimate.spent)}</b> of your <b>{usd(estimate.cap)}</b> cap · after this run, at most <b>{usd(estimate.after)}</b></span>
                  <div className="bar" aria-hidden="true"><i style={{ width: capShare(estimate.spent) }} /><i className={estimate.allowed ? 'next' : 'next over'} style={{ width: capShare(estimate.costMax) }} /></div>
                </div>
                <div className="actions">
                  <button type="button" className="btn primary" disabled={!estimate.allowed || busy === 'run'} onClick={doRun}>
                    {busy === 'run' ? 'Claude is reading… (one request)' : `Confirm and run · at most ${usd(estimate.costMax)}`}
                  </button>
                  <button type="button" className="btn" disabled={busy === 'run'} onClick={() => setEstimate(undefined)}>Cancel</button>
                  {estimate.allowed ? <span className="aside">Nothing has been sent to Claude yet.</span>
                    : <span className="aside over">Past your monthly cap: raise it below, or wait for next month.</span>}
                </div>
              </div>
            )}
            <div className="capline">
              <span className="cap">
                Monthly cap {capDraft === undefined ? <><b className="num">{info ? usd(info.cap) : '—'}</b><button type="button" className="link" onClick={() => setCapDraft(String(info?.cap ?? 20))}>Change</button></>
                  : <><input aria-label="Monthly cap in dollars" type="number" min="1" max="1000" step="1" value={capDraft} onChange={(e) => setCapDraft(e.target.value)} />
                    <button type="button" className="link" aria-label="Save the monthly cap" onClick={saveCap}>Save</button>
                    <button type="button" className="link" aria-label="Cancel changing the monthly cap" onClick={() => setCapDraft(undefined)}>Cancel</button></>}
              </span>
              <span>This month <b className="num">{info ? usd(info.spent) : '—'}</b> · every run is a line in the Ledger</span>
            </div>
          </div>
        </section>

        <section className="card" aria-label="Reports">
          <h2>Reports <span className="hint">{info?.reports.length ?? 0} so far</span></h2>
          {!info?.reports.length && <p className="empty2">No analysis yet. The first one appears here once you confirm it.</p>}
          <ul className="reports">
            {info?.reports.map((r) => (
              <li key={r.id}>
                <button type="button" aria-current={open?.row.id === r.id ? 'true' : undefined} onClick={() => void openReport(r)}>
                  <span><b>{r.project}</b> · {when(r)} · {label(r.model)}</span><span className="c">{usd(r.cost)}</span>
                  <span className="d">{new Date(r.created_at).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {tokens(r.input_tokens)} in · {tokens(r.output_tokens)} out</span>
                </button>
              </li>
            ))}
          </ul>
          {open && <OpenReport key={open.row.id} report={open.report} />}
        </section>
      </div>
      <section className="card">
        <Explain summary="When an analysis runs">
          An analysis never starts on its own: no schedule, no trigger, no retry. Estimate uses the API's token counter, which generates nothing; Confirm makes one request and stops at the output limit.
          Past the monthly cap, Confirm is disabled. At most means every output token used, at list prices, and thinking counts as output.
          The key is read from <code>ANTHROPIC_API_KEY</code> in <code>deploy/.env</code> by the server; the studio never shows it.
        </Explain>
      </section>
    </main>
  );
}

/** A stored report under the list: the summary, its sections with the evidence, the changes to try. Keyed by its row, so another pick brings it up again. */
function OpenReport({ report }: { report: Report | null }) {
  const panel = useReveal<HTMLElement>();
  return (
    <article ref={panel} className="report" aria-label="The open report">
      {!report ? <p>This run returned no report (Claude declined, or the answer could not be read). It was billed, so it counts against the cap.</p> : <>
        <p>{report.summary}</p>
        {report.sections.map((s, i) => (
          <div key={`${i}:${s.title}`}>
            <h3>{s.title}</h3><p>{s.body}</p>
            {s.evidence.length > 0 && <div className="ev">{s.evidence.map((e) => <span key={e}>{e}</span>)}</div>}
          </div>
        ))}
        <div>
          <h3>Changes to try</h3>
          <ul className="todo">{report.changes.map((c) => <li key={c.title}><span className="bx" /><span>{c.title}</span><span className="save">{c.saving}</span><span className="why">{c.why}</span></li>)}</ul>
        </div>
      </>}
    </article>
  );
}
