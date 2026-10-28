import { useEffect, useState, type ReactNode } from 'react';
import { plural } from './format.ts';
import { Explain, Figures, PageHeader, PeriodSelect, ProjectSelect, Reading, useProject, withCode } from './kit.tsx';
import { claimsStat, figures, foldedLine, foldRepeats, kindRows, patternsReading, repeatCount, repeatText, type PatternsData } from './patterns-math.ts';

// The Analysis page's first view (v0.3 slice 3, #45), drawn as approved in design/v0.3-worth-truth.html, from GET /api/patterns: what keeps failing
// over a project's whole history, from the classes and shapes the plugin and the import write (so it works with Content off).
// Like Worth it is mounted beside the other view and loads nothing while hidden. It does not poll: it reads a project's whole history, and
// a page you come back to asks again.

const request = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the server answered ${res.status}`);
  return (await res.json()) as T;
};

export function Patterns({ views, hidden }: { views: ReactNode; hidden: boolean }) {
  const { project, projects } = useProject(true); // one project: Patterns never offers all of them
  const [state, setState] = useState<{ project: string; data: PatternsData }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!project || hidden) return;
    let live = true;
    setError(undefined);
    request<PatternsData>(`/api/patterns?${new URLSearchParams({ project })}`)
      .then((data) => live && setState({ project, data }))
      .catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [project, hidden]);

  // What shows is what was loaded for this project: a project just picked never wears the last one's numbers under its own name.
  const data = state?.project === project ? state.data : undefined;
  return (
    <main className="patterns" hidden={hidden}>
      <PageHeader title="Analysis" sub="What keeps failing, and the rule to stop it" views={views} project={<ProjectSelect one />}
        period={<PeriodSelect value="all" onChange={() => {}} options={[['all', 'Whole history']]} />} />
      {projects?.length === 0
        ? <div className="empty"><b>Nothing recorded yet.</b><span>Patterns start when a session runs with the agent-orb plugin.</span></div>
        : <PatternsBody project={project} data={data} error={error} />}
    </main>
  );
}

/** What the page shows for one project: the error, the wait, a project with no failures, or the reading, the figures and the two lists. */
export function PatternsBody({ project, data, error }: { project: string; data?: PatternsData; error?: string }) {
  if (error) return <div className="empty"><b>Patterns could not load.</b><span>{error}</span></div>;
  if (!data) return <div className="empty" role="status"><b>Reading the failures…</b></div>;
  if (!data.failed) {
    return (
      <>
        <div className="empty">
          <b>Nothing has failed in {project}.</b>
          <span>{data.calls ? `${plural(data.calls, 'tool call')}, and none of them failed.` : 'No tool calls are recorded for it yet.'}</span>
        </div>
        {/* a claim is no failed call: a project with none still says whether its claims were checked */}
        <Figures items={[claimsStat(data.claims)]} cols={3} label="Unbacked claims" />
      </>
    );
  }
  const { rows, folded } = foldRepeats(data.repeats);
  const closing = foldedLine(folded);
  return (
    <>
      <Reading said={patternsReading(project, data)} />
      <Figures items={figures(data)} cols={3} label="Failed calls" />

      <section className="card" aria-label="Repeated failures">
        <h2>The same failure, again and again <span className="hint">grouped across sessions; a Try line is a rule worth changing</span></h2>
        {data.repeats.length === 0 && <p className="pempty">Nothing fails the same way three times yet.</p>}
        {rows.length > 0 && <ul className="repeats">
          {rows.map((r) => {
            const t = repeatText(r);
            return (
              <li key={`${r.shape}/${r.tool}`} className="repeat">
                <div>
                  <b>{t.title}</b>
                  {t.what && <p>{withCode(t.what)}</p>}
                  {t.sample && <p><code>{t.sample}</code></p>}
                </div>
                <span className="num">{repeatCount(r)}</span>
                {t.fix && <span className="try">Try: {withCode(t.fix)}</span>}
              </li>
            );
          })}
        </ul>}
        {closing && <p className="pmore">{closing}</p>}
      </section>

      <section className="card" aria-label="Failed calls by kind">
        <h2>Failed calls by kind <span className="hint">the error and command classes from the plugin</span></h2>
        <div className="tw"><table className="kinds">
          <thead><tr><th>Kind</th><th className="r">Calls</th><th aria-label="Share of the biggest kind" /></tr></thead>
          <tbody>
            {kindRows(data.kinds).map((r) => (
              <tr key={r.key} className={r.sub ? 'sub' : undefined}>
                <td>{r.label}</td>
                <td className="r num">{r.count.toLocaleString('en')}</td>
                <td className="bc"><div className="bar" aria-hidden="true"><i style={{ width: `${r.width}%` }} /></div></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <Explain summary="How patterns are found">
          Each failed call gets a short class from the plugin (a path not found, an edit that missed, a command that failed, and the kind of command), so no output text has to
          leave the machine. Repeats are failures of the same shape across sessions, with paths and numbers set aside. With Content on full, the group can also show the failing text.
        </Explain>
      </section>
    </>
  );
}
