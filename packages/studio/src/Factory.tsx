import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { trapTab, usePhone } from './History.tsx';
import { PageHeader, ProjectSelect, Reading, useProject, type Said } from './kit.tsx';

// Factory (v0.4 slice 1, #27), drawn as approved in design/v0.4-factory.html, the Factory and Findings boards, from GET /api/factory: each open PR with the first
// reason it isn't ready for your ok, or "Ready for your ok", and its findings in a sheet. Nothing here merges: the merge stays yours.
// The board, the budget and the machine bands come with slices 2, 3 and 6.

type Cond = { ok: boolean | null; note: string };
export type FactoryFinding = { id: string; severity: string; file: string; fate: 'open' | 'dismissed' | 'fixed'; title?: string; why?: string };
export type FactoryPr = {
  number: number; head: string | null; headOid: string; ready: boolean; reason: string | null; dropped: number;
  conditions: { findings: Cond; gate: Cond; bots: Cond; clean: Cond }; findings: FactoryFinding[];
};
export type FactoryData = { project: string; readAt: number | null; prs: FactoryPr[] };
type OpenSheet = (pr: number, from: HTMLElement) => void;

const REFRESH_MS = 30_000; // the plugin reads GitHub every 5 minutes; the page asks more often so a fresh read shows soon after it lands
const STALE_MS = 10 * 60_000; // two reads missed: no session is reading this repo now
const MIN = 60_000;
const short = (oid: string) => oid.slice(0, 7);
const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const CONDITIONS = [['findings', 'No finding is open'], ['gate', 'The gate passed on this head'], ['bots', 'No bot comment is newer than the last commit'], ['clean', 'Merge state is CLEAN']] as const;

/** The state a PR shows: from the first condition that does not hold, as its reason is. */
function stateOf(p: FactoryPr): { tone: 'working' | 'stalled' | 'waiting'; label: string } {
  if (p.ready) return { tone: 'working', label: 'Ready' };
  const [key, c] = Object.entries(p.conditions).find(([, c]) => c.ok !== true)!;
  if (c.ok === null) return { tone: 'waiting', label: 'Not known' };
  return { tone: 'stalled', label: key === 'findings' ? 'Open findings' : 'Blocked' };
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

/** Each open PR, worst first (the server's order): its state, the first reason it isn't ready or "Ready for your ok", and its dismissed findings to read. */
export function NeedsYou({ prs, onOpen }: { prs: FactoryPr[]; onOpen: OpenSheet }) {
  return (
    <section className="card needs" aria-labelledby="fneeds-h">
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
export function PrSheet({ pr, readAt, now, sheet, onClose }: { pr: FactoryPr; readAt: number | null; now: number; sheet: boolean; onClose: () => void }) {
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
      </div>
    </aside>
  );
}

export function Factory({ now }: { now: number }) {
  const { project, projects } = useProject(true); // one project: the page reads one repo's PRs
  const [data, setData] = useState<FactoryData>();
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
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [project]);

  const shown = data && data.project === project ? data : undefined; // a project just picked never wears the last one's PRs
  const pr = shown?.prs.find((p) => p.number === picked);
  const close = () => {
    setPicked(undefined);
    opener.current?.focus();
  };
  return (
    <main className="factory">
      <PageHeader title="Factory" sub="What's blocked, and what's ready for your ok" views={shown ? <Asof readAt={shown.readAt} now={now} /> : <span />} project={<ProjectSelect one />} />
      {error && <div className="empty"><b>Factory could not load.</b><span>{error}</span></div>}
      {projects?.length === 0 && <div className="empty"><b>Nothing recorded yet.</b><span>Factory starts when a session runs with the agent-orb plugin.</span></div>}
      {shown && (
        <>
          <Reading said={factoryReading(shown)} />
          <NeedsYou prs={shown.prs} onOpen={(n, from) => ((opener.current = from), setPicked(n))} />
        </>
      )}
      {pr && createPortal(
        <>
          <div className="scrim" onClick={close} aria-hidden="true" />
          <PrSheet key={pr.number} pr={pr} readAt={shown!.readAt} now={now} sheet={phone} onClose={close} />
        </>,
        document.body,
      )}
    </main>
  );
}
