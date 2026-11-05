import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { usd } from './format.ts';
import { trapTab, usePhone } from './History.tsx';
import { PageHeader, ProjectSelect, Reading, useProject, type Said } from './kit.tsx';

// Factory (v0.4 slice 1, #27), drawn as approved in design/v0.4-factory.html, the Factory and Findings boards, from GET /api/factory: each open PR with the first
// reason it isn't ready for your ok, or "Ready for your ok", and its findings in a sheet. Nothing here merges: the merge stays yours.
// Slice 2 (#28) adds each PR's issue cost against its budget (the cost cell, the Budget card and the sheet's field), from GET and PUT /api/budget; every figure is an estimate and
// nothing is ever stopped. The board and the machine bands come with slices 3 and 6.

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
/** Saves a budget (null removes it) and answers the server's words when it refused, or nothing. */
type Save = (target: { milestone: string } | { issue: number }, usd: number | null) => Promise<string | undefined>;

const REFRESH_MS = 30_000; // the plugin reads GitHub every 5 minutes; the page asks more often so a fresh read shows soon after it lands
const STALE_MS = 10 * 60_000; // two reads missed: no session is reading this repo now
const MIN = 60_000;
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

/** What the milestones' defaults are, where to set them, and the month's spend on no issue. The numbers and warnings are the server's. */
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
      <div className="notissue">
        <span>Not on an issue: <b className="num">{usd(data.notOnIssue.usd, data.notOnIssue.partial)}</b> this month</span>
        <span className="sub">Sessions with no PR, and turns after a session's last PR. Cost is an estimate by time windows.</span>
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

/** Each open PR, worst first (the server's order): its state, the first reason it isn't ready or "Ready for your ok", its issue's cost once read, and its dismissed findings to read. */
export function NeedsYou({ prs, costs, onOpen }: { prs: FactoryPr[]; costs?: Map<number, IssueCost>; onOpen: OpenSheet }) {
  return (
    <section className={costs ? 'card needs withcost' : 'card needs'} aria-labelledby="fneeds-h">
      <h2 id="fneeds-h">Needs you</h2>
      {!prs.length && <p className="nothing">Nothing needs you.</p>}
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

export function Factory({ now }: { now: number }) {
  const { project, projects } = useProject(true); // one project: the page reads one repo's PRs
  const [data, setData] = useState<FactoryData>();
  const [budget, setBudget] = useState<BudgetData>();
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<number>();
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
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [project]);

  const shown = data && data.project === project ? data : undefined; // a project just picked never wears the last one's PRs
  const costed = budget && budget.project === project ? budget : undefined;
  const costs = costed && new Map(costed.issues.map((i) => [i.number, i]));
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
      <PageHeader title="Factory" sub="What's blocked, and what's ready for your ok" views={shown ? <Asof readAt={shown.readAt} now={now} /> : <span />} project={<ProjectSelect one />} />
      {error && <div className="empty"><b>Factory could not load.</b><span>{error}</span></div>}
      {projects?.length === 0 && <div className="empty"><b>Nothing recorded yet.</b><span>Factory starts when a session runs with the agent-orb plugin.</span></div>}
      {shown && (
        <>
          <Reading said={factoryReading(shown)} />
          <NeedsYou prs={shown.prs} costs={costs} onOpen={(n, from) => ((opener.current = from), setPicked(n))} />
          {costed && <BudgetCard data={costed} onSave={save} />}
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
