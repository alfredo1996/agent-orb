import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { Explain, Figure, PageHeader, ProjectSelect, Reading, Seg, useProject } from './kit.tsx';
import { monthName } from './trends-math.ts';
import {
  CUT_NAMES, cutText, firstRows, hours, monthKey, monthLong, monthTitle, parseCut, parseHours, parsePlan, parseRate, parseSizesForm, prsHint, SIZE_NAMES, stepMonth,
  sizeRows, worthFigures, worthReading, worthReducer,
  type CutName, type Settings, type Size, type SizeName, type WorthData,
} from './worth-math.ts';

// The Ledger's Worth view (v0.3 slice 2, #42; #103), drawn as approved in design/v0.3-readable.html, from GET /api/worth: your hourly rate and plan price, a reading and
// six figures, and every merged PR with a size. A size is automatic (the PR's lines and files, under cut points you can move) until you tap another: then it is yours, and
// Back to Auto takes it back. The figures that are yours are labelled so; the rest the logs measured.
// A tap shows at once and is saved behind it (worth-math.ts); a refused save puts the old size back and says why.

const REFRESH_MS = 60_000; // as the Ledger's
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** JSON in or out; a refusal throws the server's own words (`{ error }`), as the 400s of /api/worth send them. */
const request = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the server answered ${res.status}`);
  return (await res.json()) as T;
};
const put = <T,>(url: string, body: object) => request<T>(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const SIZE_OPTIONS: [Size | '', string][] = [['S', 'S'], ['M', 'M'], ['L', 'L'], ['XL', 'XL'], ['skip', 'Skip']];
const typed = (n: number | null) => (n === null ? '' : String(n));
type Around = <T,>(save: () => Promise<T>) => Promise<T>;

export function Worth({ views, hidden }: { views: ReactNode; hidden: boolean }) {
  const { project, projects } = useProject(true); // one project: Worth never offers all of them
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [state, dispatch] = useReducer(worthReducer, undefined);
  const [error, setError] = useState<string>();
  // Bumped when a save starts and when it ends. A load that began before a save ended may carry the old figures, so it asks again instead of showing them.
  const saves = useRef(0);
  const around: Around = async (save) => {
    saves.current++;
    try {
      return await save();
    } finally {
      saves.current++;
    }
  };

  // The Ledger keeps this view mounted while another shows: nothing loads until it is.
  useEffect(() => {
    if (!project || hidden) return;
    let live = true;
    const load = async (): Promise<void> => {
      const began = saves.current;
      try {
        const data = await request<WorthData>(`/api/worth?${new URLSearchParams({ project, month, tz: tz() })}`);
        if (!live) return;
        if (began !== saves.current) return load();
        dispatch({ type: 'loaded', project, data });
        setError(undefined);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS); // the month's attention moves while you work
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [project, month, hidden]);

  // What shows is what was loaded for this project and month: a month just stepped to never wears the last one's numbers under its own name.
  const data = state && state.project === project && state.data.month === month ? state.data : undefined;
  const now = new Date();
  const step = (delta: number) => setMonth((m) => stepMonth(m, delta, new Date()) ?? m);

  // Throws the server's words when the save is refused, after putting the old size back. `null` is Back to Auto. A tap on the size a PR already has makes it yours.
  const choose = async (d: WorthData, number: number, size: Size | null) => {
    const p = d.prs.find((x) => x.number === number);
    if (!p || (size === null ? !p.yours : p.yours && p.size === size)) return; // already automatic, or already yours at that size
    const had = p.yours ? p.size : null;
    const act = { type: 'size' as const, project, month: d.month, number };
    dispatch({ ...act, size });
    try {
      await around(() => put('/api/worth/size', { project, number, size }));
    } catch (e) {
      dispatch({ ...act, size: had });
      throw e;
    }
  };

  return (
    <main className="ledger worth" hidden={hidden}>
      <PageHeader title="Ledger" sub="What the agents saved you, and what you paid" views={views} project={<ProjectSelect one />}
        period={
          <span className="monthnav" role="group" aria-label="Period">
            <button type="button" className="btn" aria-label="Previous Month" onClick={() => step(-1)}>‹</button>
            <span className="mlabel">{monthLong(month)}</span>
            <button type="button" className="btn" aria-label="Next Month" disabled={!stepMonth(month, 1, now)} onClick={() => step(1)}>›</button>
          </span>
        } />

      {error && <div className="empty"><b>Worth could not load.</b><span>{error}</span></div>}
      {projects?.length === 0 && <div className="empty"><b>Nothing recorded yet.</b><span>Worth starts when a session runs with the agent-orb plugin.</span></div>}

      {data && (
        <>
          <Numbers settings={data.settings} around={around} onSaved={(settings) => dispatch({ type: 'settings', settings })} />

          <Reading said={worthReading(data, project!, monthTitle(month, now))} />

          <MonthCard data={data} title={monthTitle(month, now)} />

          <Sizing key={`${project}/${month}`} data={data} onChoose={(number, size) => choose(data, number, size)} />
        </>
      )}
    </main>
  );
}

/** The hours by hand, by size: one row each for S, M, L and XL, so a month's total can be traced to the PRs behind it. */
function SizeRows({ data }: { data: WorthData }) {
  return (
    <div className="dist" role="group" aria-label="PRs by size">
      {sizeRows(data).map((r) => (
        <div key={r.size}>
          <span>{r.label}</span>
          <b>{hours(r.hours)}</b>
          <span className="bar" aria-hidden="true"><i style={{ width: `${r.width}%` }} /></span>
          <span>{`${hours(r.each)} each`}</span>
        </div>
      ))}
    </div>
  );
}

/** The month's card: the six figures, the PRs behind them by size, and the formula. */
export function MonthCard({ data, title }: { data: WorthData; title: string }) {
  return (
    <section className="card" aria-label={title}>
      <h2>{title} <span className="hint">a losing month shows negative</span></h2>
      <div className="wbody">
        <div className="figgrid c3">{worthFigures(data).map((f) => <Figure key={f.label} {...f} />)}</div>
        <SizeRows data={data} />
        <pre className="formula">{'value  = (hours by hand − hours of your attention) × your rate\nreturn = value − what you paid'}</pre>
      </div>
    </section>
  );
}

// The owner's rate, plan price, the hours behind each size and the cut points between them. Typed text is kept until saved; until then the saved values show. The two
// forms each have their own Save, so a half-typed rate never rides along with new sizes.
function Numbers({ settings, around, onSaved }: { settings: Settings; around: Around; onSaved: (s: Settings) => void }) {
  const [rate, setRate] = useState<string>(); // undefined: the saved value shows
  const [plan, setPlan] = useState<string>();
  const [editing, setEditing] = useState<Typed>(); // undefined: not editing
  const [numbersError, setNumbersError] = useState<string>(); // the server's words on a save it refused
  const [sizesError, setSizesError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async (body: object, fail: (m: string) => void, done: () => void) => {
    setBusy(true);
    try {
      onSaved(await around(() => put<Settings>('/api/worth/settings', body)));
      done();
    } catch (e) {
      fail((e as Error).message);
    }
    setBusy(false);
  };

  const r = parseRate(rate ?? typed(settings.rate));
  const p = parsePlan(plan ?? typed(settings.plan));
  const numbersProblem = numbersError ?? ('error' in r ? r.error : 'error' in p ? p.error : undefined);
  const saveNumbers = () => {
    if ('error' in r || 'error' in p || busy) return;
    setNumbersError(undefined);
    void save({ rate: r.value, plan: p.value }, setNumbersError, () => { setRate(undefined); setPlan(undefined); });
  };

  const parsed = editing && parseSizesForm(editing.hours, editing.cuts);
  const saveSizes = () => {
    if (!parsed || 'error' in parsed || busy) return;
    setSizesError(undefined);
    void save(parsed, setSizesError, () => setEditing(undefined));
  };
  const stop = () => { setEditing(undefined); setSizesError(undefined); };

  return (
    <section className="card" aria-label="Your numbers">
      <h2>Your numbers <span className="hint">only you know these; they stay on this machine</span></h2>
      <div className="wbody">
        <form className="wform" noValidate onSubmit={(e) => { e.preventDefault(); saveNumbers(); }}>
          <label className="fld">
            <span>Your hourly rate</span>
            <span className="money"><span aria-hidden="true">$</span>
              <input inputMode="decimal" autoComplete="off" placeholder="Not set" value={rate ?? typed(settings.rate)} aria-invalid={'error' in r}
                onChange={(e) => { setRate(e.target.value); setNumbersError(undefined); }} />
            </span>
          </label>
          <label className="fld">
            <span>Your plan, a month</span>
            <span className="money"><span aria-hidden="true">$</span>
              <input inputMode="decimal" autoComplete="off" placeholder="Not set" value={plan ?? typed(settings.plan)} aria-invalid={'error' in p}
                onChange={(e) => { setPlan(e.target.value); setNumbersError(undefined); }} />
            </span>
          </label>
          <button type="submit" className="btn primary" disabled={'error' in r || 'error' in p || busy}>Save</button>
          {numbersProblem && <p className="werr" role="alert">{numbersProblem}</p>}
        </form>

        {editing ? (
          <SizesForm typed={editing} problem={sizesError ?? (parsed && 'error' in parsed ? parsed.error : undefined)} saveDisabled={busy || !parsed || 'error' in parsed}
            onTyped={(t) => { setEditing(t); setSizesError(undefined); }} onSave={saveSizes} onCancel={stop} />
        ) : (
          <div className="sizes">
            <span>Every merged PR is sized from its own diff:</span>
            {SIZE_NAMES.map((k) => <span key={k} className="sz"><b>{k}</b> {hours(settings.sizes[k])}</span>)}
            <button type="button" className="btn" onClick={() => setEditing(typedFrom(settings))}>Edit Sizes</button>
          </div>
        )}
      </div>
    </section>
  );
}

/** Edit Sizes as typed: the hours of each size and the score each of S, M and L is below. */
type Typed = { hours: Record<SizeName, string>; cuts: Record<CutName, string> };
const typedFrom = (s: Settings): Typed => ({
  hours: Object.fromEntries(SIZE_NAMES.map((k) => [k, String(s.sizes[k])])) as Typed['hours'],
  cuts: Object.fromEntries(CUT_NAMES.map((k) => [k, cutText(s.cuts[k])])) as Typed['cuts'],
});

/** The hours behind each size and where each size starts (design/v0.3-readable.html, Worth). Controlled, so the markup can be read without a browser. */
export function SizesForm({ typed: t, problem, saveDisabled, onTyped, onSave, onCancel }: {
  typed: Typed; problem?: string; saveDisabled: boolean; onTyped: (t: Typed) => void; onSave: () => void; onCancel: () => void;
}) {
  return (
    <form className="wform sizesform" noValidate aria-label="Edit Sizes" onSubmit={(e) => { e.preventDefault(); onSave(); }} onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}>
      <div className="cuts" role="group" aria-label="Hours behind each size">
        {SIZE_NAMES.map((k) => (
          <label key={k} className="fld">
            <span>{k}, in hours</span>
            <input inputMode="decimal" autoComplete="off" value={t.hours[k]} aria-invalid={'error' in parseHours(t.hours[k])} onChange={(e) => onTyped({ ...t, hours: { ...t.hours, [k]: e.target.value } })} />
          </label>
        ))}
      </div>
      <div className="cuts" role="group" aria-label="Where each size starts">
        {CUT_NAMES.map((k) => (
          <label key={k} className="fld">
            <span>{k} is below (score)</span>
            <input inputMode="decimal" autoComplete="off" value={t.cuts[k]} aria-invalid={'error' in parseCut(t.cuts[k])} onChange={(e) => onTyped({ ...t, cuts: { ...t.cuts, [k]: e.target.value } })} />
          </label>
        ))}
        <label className="fld"><span>XL is from</span><input value={t.cuts.L} disabled readOnly /></label>
      </div>
      {problem && <p className="werr" role="alert">{problem}</p>}
      <div className="actions">
        <button type="submit" className="btn primary" disabled={saveDisabled}>Save Sizes</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// The month's merged PRs, newest first. Keyed by project and month, so "Show All" and an error never follow the select.
function Sizing({ data, onChoose }: { data: WorthData; onChoose: (number: number, size: Size | null) => Promise<void> }) {
  const [all, setAll] = useState(false);
  const [problem, setProblem] = useState<string>();
  const tap = (number: number, size: Size | null) => {
    setProblem(undefined);
    onChoose(number, size).catch((e: Error) => setProblem(`#${number} was not saved, so it is back as it was: ${e.message}`));
  };
  return <PrCard data={data} all={all} problem={problem} onShowAll={() => setAll(true)} onTap={tap} />;
}

/** The PR card: each row says whose size it is, one tap on another size makes it yours, Back to Auto takes it back. `null` in `onTap` is Back to Auto. */
export function PrCard({ data, all, problem, onShowAll, onTap }: {
  data: WorthData; all: boolean; problem?: string; onShowAll: () => void; onTap: (number: number, size: Size | null) => void;
}) {
  const { rows, hidden } = firstRows(data.prs, all);
  const { cuts } = data.settings;
  return (
    <section className="card" aria-label="Merged PRs">
      <h2>Merged PRs, sized <span className="hint">{prsHint(data)}</span></h2>
      {problem && <p className="werr pad" role="alert">{problem}</p>}
      {rows.length === 0 && (
        <p className="wempty">No merged PRs in {monthName(data.month)}. The plugin lists them with your own <code>gh</code> at each session start, for the last 90 days.</p>
      )}
      <ul className="prs">
        {rows.map((r) => (
          <li key={r.number} className="pr">
            <span className="n">{r.id}</span>
            <span className="t"><b className={r.hidden ? 'dim' : undefined}>{r.title}</b><small>{r.meta}</small></span>
            <span className="pz">
              <span className={`szchip${r.yours ? ' mine' : ''}`} title={r.why}>{r.chip}</span>
              {r.yours && <button type="button" className="back" aria-label={`Back to Auto for ${r.id}`} onClick={() => onTap(r.number, null)}>Back to Auto</button>}
              <Seg value={r.size ?? ''} onChange={(s) => s && onTap(r.number, s)} label={`Size of ${r.id}`} options={SIZE_OPTIONS} />
            </span>
          </li>
        ))}
      </ul>
      {rows.length > 0 && (
        <p className="rowsnote">
          Each PR's cost, agents and sessions are its share of the session that opened it: the slice between the previous PR link and its own. PRs linked minutes apart get thin slices.
        </p>
      )}
      {hidden > 0 && <div className="more"><button type="button" className="btn" onClick={onShowAll}>Show All {data.prs.length}</button></div>}
      <Explain summary="How a size is chosen">
        Score = changed lines × (1 + log₂ of the files changed), counting only files that are not lockfiles, generated files, images or build output. S is below {cutText(cuts.S)}, M below{' '}
        {cutText(cuts.M)}, L below {cutText(cuts.L)}, XL from there. Release merges (<code>chore(release)…</code>, <code>chore: merge …</code>, <code>Merge …</code>) {`are left out: ${data.releaseMerges} in ${monthName(data.month)}.`} Tap another size on a
        row and it becomes yours; Back to Auto takes it back. A PR the plugin has not counted yet (an older plugin, or <code>gh</code> listed no files) is not sized until a session sends the
        counts. A session that served several PRs is split by its PR links in time: each PR gets the session's cost and agents from the previous link up to its own, so the rows add up to at
        most the session. Self-estimates run optimistic: in METR's 2025 trial, developers were 19% slower with AI and believed they were 20% faster.
      </Explain>
    </section>
  );
}
