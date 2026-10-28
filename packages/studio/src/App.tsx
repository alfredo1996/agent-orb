import { useEffect, useState } from 'react';
import { Analysis } from './Analysis.tsx';
import { Connection, ProjectContext } from './kit.tsx';
import { Ledger } from './Ledger.tsx';
import { Live, type Session } from './Live.tsx';
import { lastEventOf, shown } from './live-cards.ts';
import { Office } from './Office.tsx';
import { Pipeline } from './Pipeline.tsx';
import { choiceQuery, choose, readChoice } from './project-choice.ts';

// The studio's frame and routes, and the one /stream every view shares.

const SHOW_ENDED_MS = 10 * 60_000;

function useStream() {
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [isOpen, setIsOpen] = useState(false);
  useEffect(() => {
    const source = new EventSource('/stream'); // reconnects by itself
    source.onopen = () => setIsOpen(true);
    source.onerror = () => setIsOpen(false);
    source.addEventListener('snapshot', (m) => {
      const { sessions: list } = JSON.parse(m.data) as { sessions: Session[] };
      setSessions(Object.fromEntries(list.map((s) => [s.id, s])));
    });
    source.addEventListener('session', (m) => {
      const s = JSON.parse(m.data) as Session;
      setSessions((all) => ({ ...all, [s.id]: s }));
    });
    return () => source.close();
  }, []);
  return { sessions, isOpen };
}

const ROUTES = { '#/ledger': 'ledger', '#/pipeline': 'pipeline', '#/office': 'office', '#/analysis': 'analysis' } as const;
type View = 'live' | (typeof ROUTES)[keyof typeof ROUTES];

/**
 * Hash routes (#/ledger): the server serves the studio at / only. What follows a `?` is the project choice every view reads (#101), held once here: the hash is written back
 * with it, so a reload or a link keeps it and a click on a menu link (which drops it) loses nothing, and a hash that arrives with one (a pasted link, Back) is adopted.
 */
function useRoute() {
  const route = () => ({ view: (ROUTES[location.hash.split('?')[0] as keyof typeof ROUTES] ?? 'live') as View, hash: location.hash });
  const [{ view, hash }, setRoute] = useState(route);
  const [choice, setChoice] = useState(() => readChoice(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(route());
      if (location.hash.includes('?')) setChoice(readChoice(location.hash));
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    document.title = `agent-orb · ${view[0]!.toUpperCase()}${view.slice(1)}`;
  }, [view]);
  useEffect(() => {
    const path = location.hash.split('?')[0]!;
    const next = path in ROUTES ? path + choiceQuery(choice) : path;
    if (next !== location.hash) history.replaceState(null, '', next);
  }, [hash, choice]);
  return { view, choice, pick: (name: string) => setChoice((c) => choose(c, name)) };
}

/** The projects to choose from, the most recent first; asked for again when the page changes. */
function useProjectList(view: View) {
  const [projects, setProjects] = useState<string[]>();
  useEffect(() => {
    let live = true;
    fetch('/api/projects')
      .then((r) => (r.ok ? (r.json() as Promise<{ name: string }[]>) : Promise.reject(new Error(String(r.status)))))
      .then((list) => live && setProjects(list.map((p) => p.name)))
      .catch(() => {}); // the pickers keep what they had; the views say their own errors
    return () => { live = false; };
  }, [view]);
  return projects;
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function App() {
  const { sessions, isOpen } = useStream();
  const now = useNow();
  const { view, choice, pick } = useRoute();
  const projects = useProjectList(view);
  const lastEvent = lastEventOf(Object.values(sessions)); // the connection says Quiet from the newest event, not from the last time the stream spoke
  const list = Object.values(sessions)
    .filter((s) => !s.endedAt || now - s.endedAt < SHOW_ENDED_MS)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((s) => ({ ...s, agents: s.agents.filter((a) => shown(a, now)) }));
  const running = list.filter((s) => !s.endedAt);
  // Phones get the views behind a Menu button; it closes when the view changes or on Escape.
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [view]);
  useEffect(() => {
    if (!menu) return;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [menu]);

  return (
    <div className="frame">
      <header className="topbar">
        <div className="brand"><span className="orb" aria-hidden="true" />agent-orb</div>
        <nav aria-label="Views" id="views" className={menu ? 'open' : undefined}>
          <a href="#/" aria-current={view === 'live' ? 'page' : undefined}>Live{running.length > 0 && <span className="count" aria-label={`${running.length} running`}>{running.length}</span>}</a>
          <a href="#/ledger" aria-current={view === 'ledger' ? 'page' : undefined}>Ledger</a>
          <a href="#/pipeline" aria-current={view === 'pipeline' ? 'page' : undefined}>Pipeline</a>
          <a href="#/office" aria-current={view === 'office' ? 'page' : undefined}>Office</a>
          <a href="#/analysis" aria-current={view === 'analysis' ? 'page' : undefined}>Analysis</a>
        </nav>
        <Connection isOpen={isOpen} lastEvent={lastEvent} now={now} host={location.host} />
        <button type="button" className="btn menu" aria-expanded={menu} aria-controls="views" onClick={() => setMenu(!menu)}>Menu</button>
      </header>

      <ProjectContext.Provider value={{ projects, choice, pick }}>
        {view === 'ledger' ? <Ledger /> : view === 'pipeline' ? <Pipeline now={now} /> : view === 'office' ? <Office sessions={running} all={sessions} now={now} /> : view === 'analysis' ? <Analysis /> : <Live list={list} all={sessions} now={now} />}
      </ProjectContext.Provider>
    </div>
  );
}

