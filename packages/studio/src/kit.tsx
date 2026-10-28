import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { freshness } from './live-cards.ts';
import { FIRST, shown, type Choice } from './project-choice.ts';

// The page kit (design/library.html, PROJECT.md §15): the pieces every page repeats. Pieces arrive with the first page that uses them.

/**
 * Every page's header, one shape (#101, design/v0.3-readable.html, the Header board). Row 1: the title and a line saying what the view answers (a string is one line, cut with
 * "…" and whole as its title; a node is the page's own and may wrap). Row 2, for a page with views: the switch on the left, the pickers on the right, project then period, in
 * slots of a fixed width. The slots are always there, so the first card starts at the same height on every view.
 */
export function PageHeader({ title, sub, views, project, period }: { title: string; sub?: ReactNode; views?: ReactNode; project?: ReactNode; period?: ReactNode }) {
  return (
    <div className="pagehead">
      <div className="ph-1"><h1>{title}</h1>{sub && (typeof sub === 'string' ? <div className="sub line" title={sub}>{sub}</div> : <div className="sub">{sub}</div>)}</div>
      {views && (
        <div className="ph-2">
          <div className="ph-views">{views}</div>
          <div className="ph-pick"><div className="ph-project">{project}</div><div className="ph-period">{period}</div></div>
        </div>
      )}
    </div>
  );
}

/** What the project picker reads and writes; App.tsx holds it once, above the views. `projects` is undefined until the list has loaded. */
export type Projects = { projects?: string[]; choice: Choice; pick: (name: string) => void };
export const ProjectContext = createContext<Projects>({ choice: FIRST, pick: () => {} });

/** The project a view shows ('' is all of them) and the list to choose from. `one`: the view needs a single project, so it never shows all. */
export function useProject(one: boolean) {
  const { projects, choice } = useContext(ProjectContext);
  return { project: shown(choice, one, projects), projects };
}

/** The header's project slot: the one picker of the page, the same list on every view; "All projects" only where the view can show it. */
export function ProjectSelect({ one }: { one: boolean }) {
  const { projects, choice, pick } = useContext(ProjectContext);
  const value = shown(choice, one, projects);
  const names = projects ?? (value ? [value] : []); // before the list loads, the URL's project is the one option
  return (
    <select aria-label="Project" value={value} disabled={one && !names.length} onChange={(e) => pick(e.target.value)}>
      {!one && <option value="">All projects</option>}
      {names.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>
  );
}

/** The header's period slot as a picker; one option is shown but cannot be changed. */
export function PeriodSelect<V extends string>({ value, onChange, options }: { value: V; onChange: (v: V) => void; options: [V, string][] }) {
  return (
    <select aria-label="Period" value={value} disabled={options.length === 1} onChange={(e) => onChange(e.target.value as V)}>
      {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
    </select>
  );
}

/** The top bar's connection, in words (live-cards.ts `freshness`): the dot says it too, grey when quiet and amber when the stream dropped. */
export function Connection({ isOpen, lastEvent, now, host }: { isOpen: boolean; lastEvent?: number; now: number; host: string }) {
  const f = freshness(isOpen, lastEvent, now);
  return (
    <div className={`conn ${f.tone}`} title="Server-sent events from /stream">
      <span className={`pulse ${f.tone}`} />
      {f.text}
      <span className="addr"> · {host}</span>
    </div>
  );
}

export type Tone = 'working' | 'waiting' | 'model' | 'stalled' | 'claim' | 'done' | 'data';

/** A count per state, each with its word: the dot carries the colour, never alone. */
export function Tally({ items }: { items: [Tone, string][] }) {
  return <span className="tally">{items.map(([tone, text], i) => <span key={i} className={`t-${tone}`}>{text}</span>)}</span>;
}

/**
 * For a panel that opens under a chart: on a phone it lands below the fold, so a tap looks dead. Put the ref on the panel;
 * it is brought up on mount unless all of it is already on screen (key the panel by what it shows, so another pick remounts it).
 * `enabled` false (a panel that is there before anyone picked) leaves the page where it is.
 */
export function useReveal<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!enabled) return;
    const r = ref.current!.getBoundingClientRect();
    if (r.top >= 0 && r.bottom <= window.innerHeight) return;
    ref.current!.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, []);
  return ref;
}

/** A segmented toggle: one option pressed at a time. `label` names the group for a screen reader. */
export function Seg<V extends string>({ value, onChange, options, label }: { value: V; onChange: (v: V) => void; options: [V, string][]; label?: string }) {
  return (
    <span className="seg" role={label ? 'group' : undefined} aria-label={label}>
      {options.map(([v, text]) => <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>{text}</button>)}
    </span>
  );
}

/** "How to read this": closed by default, at the foot of the card it explains; it replaces the fine print under pages. */
export function Explain({ summary, children }: { summary: string; children: ReactNode }) {
  return <details className="explain"><summary>{summary}</summary><div>{children}</div></details>;
}

/** `text` between backticks is code. */
export const withCode = (text: string) => text.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

/**
 * What a figure is made of (#102, design/v0.3-readable.html): a plain label, a readable value, one line on whether it is usual (none when there is nothing to compare it with)
 * and the explanation its ⓘ opens. `bad` reds the value; backticks in `why` are code.
 */
export type FigureData = { label: string; value: string; usual?: string; why: string; bad?: boolean };

/** One figure in the shape every view shares. The ⓘ opens `why` right under the figure, and again closes it; `open` is the state it starts in. */
export function Figure({ label, value, usual, why, bad, open: start = false }: FigureData & { open?: boolean }) {
  const [open, setOpen] = useState(start);
  const id = useId();
  return (
    <div className="fig">
      <span className="k">{label}<button type="button" className="info" aria-expanded={open} aria-controls={id} aria-label={`What ${label} means`} onClick={() => setOpen(!open)}>i</button></span>
      <span className={bad ? 'v neg' : 'v'}>{value}</span>
      {usual && <span className="d">{usual}</span>}
      <p className="why" id={id} hidden={!open}>{withCode(why)}</p>
    </div>
  );
}

/** A view's figures in a card, `cols` to a row. */
export function Figures({ items, cols, label }: { items: FigureData[]; cols: 3 | 4; label: string }) {
  return <section className="card" aria-label={label}><div className={`figgrid c${cols}`}>{items.map((f) => <Figure key={f.label} {...f} />)}</div></section>;
}

/** A sentence written from the numbers: a part in `{ b }` is bold. */
export type Said = (string | { b: string })[];

export function Say({ said }: { said: Said }) {
  return <>{said.map((s, i) => (typeof s === 'string' ? s : <b key={i}>{s.b}</b>))}</>;
}

/** The reading on top of a view (#102): what its figures add up to, in a sentence or two, written from them so it changes with them. */
export function Reading({ said }: { said: Said }) {
  return (
    <section className="card said" aria-label="Reading">
      <div><p><Say said={said} /></p><span className="by">Written from the figures below; it changes with them.</span></div>
    </section>
  );
}
