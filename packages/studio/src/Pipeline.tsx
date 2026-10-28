import { Fragment, useEffect, useMemo, useState } from 'react';
import { duration, modelLabel, tokens, usd } from './format.ts';
import { rangeOf } from './ledger-math.ts';
import { edgeLabel, edgePath, edgeWidth, isStall, layoutRoles, NODE, ownSpans, recentFirst, roleText, typeText } from './pipeline-layout.ts';
import { Explain, PageHeader, PeriodSelect, ProjectSelect, Seg, useProject, useReveal } from './kit.tsx';
import { Skills } from './Skills.tsx';

// The Pipeline (PROJECT.md §8.3), drawn as approved in design/pages.html, from /api/pipeline and /api/lanes.

type AgentRow = { id: string; type: string | null; role: string; role_source: string | null; description: string | null; model: string | null; session: string; tokens: number; started_at: number | null; ended_at: number | null };
type Role = { role: string; info: string | null; typeInfo: Record<string, string | null>; agents: number; types: string[]; tokens: number; cost: number; costPartial: boolean; avgMs: number | null; agentList: AgentRow[] };
type Edge = { from: string; to: string; count: number; tokens: number };
type Catalog = { role: string; info: string }[]; // every role with its line, from the server (shared ROLES)
type Data = { roles: Role[]; edges: Edge[]; roleCatalog: Catalog };
export type Lane = { id: string; type: string | null; role: string | null; model: string | null; started_at: number | null; parent: string | null;
  turns: { started_at: number | null; duration_ms: number | null; model: string | null }[]; tools: { ts: number; duration_ms: number | null; tool: string; success: boolean | null }[] };
// `until`: where the time axis ends, sent only for a big session, whose calls too short to draw the server leaves out (api/pipeline.ts, /api/lanes).
export type LaneData = { session: { started_at: number; ended_at: number | null }; lanes: Lane[]; until?: number };
type Scope = 'session' | 'day' | 'week';

const SHOWN = 5; // agents the role panel lists before "Show N more"; a role can hold dozens
const label = (role: string) => (role === 'unassigned' ? 'no role' : role);
const agentsOf = (n: number) => `${n} agent${n === 1 ? '' : 's'}`;
const json = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url.split('?')[0]} answered ${res.status}`);
  return res.json() as Promise<T>;
};

export function Pipeline({ now }: { now: number }) {
  const { project } = useProject(true); // one project: the Pipeline never offers all of them
  const [scope, setScope] = useState<Scope>('week');
  const [sessions, setSessions] = useState<{ id: string; started_at: number; tokens: number }[]>([]);
  const [session, setSession] = useState('');
  const [data, setData] = useState<Data>();
  const [lanes, setLanes] = useState<LaneData>();
  const [picked, setPicked] = useState<string>();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0); // bumped after a role fix, to reload
  const [view, setView] = useState<'roles' | 'skills'>('roles'); // Slice 5: the same project and period, by skill

  useEffect(() => {
    setPicked(undefined); // a role of another project is not a role of this one
    if (!project) return;
    json<{ id: string; started_at: number; tokens: number }[]>(`/api/sessions?project=${encodeURIComponent(project)}`)
      .then((list) => { setSessions(list); setSession(list[0]?.id ?? ''); }).catch((e) => setError(e.message));
  }, [project]);

  // The project and period both scopes ask for.
  const query = useMemo(() => {
    if (!project || (scope === 'session' && !session)) return undefined;
    const q = new URLSearchParams({ project });
    if (scope === 'session') q.set('session', session);
    else {
      const r = rangeOf(scope === 'day' ? 'today' : '7d', new Date());
      q.set('from', String(r.from));
      q.set('to', String(r.to));
    }
    return q.toString();
  }, [project, scope, session]);

  useEffect(() => {
    if (!query || view !== 'roles') return;
    json<Data>(`/api/pipeline?${query}`).then((d) => { setData(d); setError(undefined); }).catch((e) => setError(e.message));
    if (scope === 'session') json<typeof lanes>(`/api/lanes?session=${encodeURIComponent(session)}`).then(setLanes).catch(() => setLanes(undefined));
    else setLanes(undefined);
  }, [query, view, version]);

  const fix = async (body: object) => {
    await json('/api/roles', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    setVersion((v) => v + 1);
  };

  const role = data?.roles.find((r) => r.role === picked);
  const pick = (r: string) => setPicked(picked === r ? undefined : r);
  return (
    <main className="pipeline">
      <PageHeader title="Pipeline" sub={view === 'roles' ? 'Who delegates to whom, and what each role costs' : 'Which skills ran, and which never did'}
        views={<Seg value={view} onChange={setView} label="Pipeline view" options={[['roles', 'Roles'], ['skills', 'Skills']]} />} project={<ProjectSelect one />}
        period={<PeriodSelect value={scope} onChange={setScope} options={[['week', 'Last 7 days'], ['day', 'Today'], ['session', 'One session']]} />} />
      {/* below the header, not in it: the header is the same shape whatever the period, and this one is only there for a single session */}
      {scope === 'session' && (
        <label className="sessionpick">Session
          <select value={session} onChange={(e) => setSession(e.target.value)}>
            {sessions.map((s) => <option key={s.id} value={s.id}>{new Date(s.started_at).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} · {tokens(s.tokens)} tok</option>)}
          </select>
        </label>
      )}

      {view === 'skills' ? <Skills query={query} now={now} /> : <>
      {error && <div className="empty"><b>The Pipeline could not load.</b><span>{error}</span></div>}
      {data && !data.roles.length && <div className="empty"><b>No agents in this period.</b><span>Pick a longer period or another project.</span></div>}

      {data && data.roles.length > 0 && (
        <section className="card" aria-label="Org chart by role">
          <h2>Who delegates to whom <span className="hint">{scope === 'session' ? 'this session only' : 'nodes are roles; an edge is as thick as the tokens it handed down; pick a role'}</span></h2>
          <OrgChart data={data} picked={picked} onPick={pick} />
          <div className="rolelist">
            {data.roles.map((r) => (
              <button key={r.role} type="button" className={r.role === 'unassigned' ? 'r unassigned' : 'r'} aria-pressed={picked === r.role} onClick={() => pick(r.role)}>
                <span><b className="nm">{label(r.role)}</b><small>{r.types.join(', ')} · {agentsOf(r.agents)}{r.avgMs !== null ? ` · avg ${duration(r.avgMs)}` : ''}</small></span>
                <span className="rt num">{tokens(r.tokens)}<small>{usd(r.cost, r.costPartial)}</small></span>
              </button>
            ))}
          </div>
        </section>
      )}
      {role && <RolePanel key={role.role} role={role} catalog={data!.roleCatalog} project={project} onFix={fix} onClose={() => setPicked(undefined)} />}

      {scope === 'session' && lanes && <Lanes data={lanes} now={now} />}
      </>}
    </main>
  );
}

function OrgChart({ data, picked, onPick }: { data: Data; picked?: string; onPick: (role: string) => void }) {
  const pos = useMemo(() => layoutRoles(data.roles.map((r) => r.role)), [data]);
  const width = Math.max(1000, ...[...pos.values()].map((p) => p.x + NODE.w / 2 + 20));
  const height = Math.max(...[...pos.values()].map((p) => p.y + NODE.h)) + 24;
  const max = Math.max(0, ...data.edges.map((e) => e.tokens));
  const into = new Map<string, number>(); // edges already ending at each child, so a second label takes the other side
  // The nodes are HTML buttons over an SVG layer that draws the edges and their labels, so a node's text never depends on drawn offsets.
  return (
    <div className="orgscroll">
      <div className="org" style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          {data.edges.map((e) => {
            const from = pos.get(e.from);
            const to = pos.get(e.to);
            if (!from || !to) return null;
            const k = into.get(e.to) ?? 0;
            into.set(e.to, k + 1);
            const at = edgeLabel(from, to, k);
            return (
              <g key={`${e.from}>${e.to}`}>
                <path className={e.to === 'unassigned' ? 'edge dash' : 'edge'} d={edgePath(from, to, pos, true)} strokeWidth={edgeWidth(e.tokens, max)} />
                <text className="elabel" x={at.x} y={at.y} textAnchor={at.anchor}>{tokens(e.tokens)}</text>
              </g>
            );
          })}
        </svg>
        {data.roles.map((r) => {
          const p = pos.get(r.role)!;
          return (
            <button key={r.role} type="button" className={r.role === 'unassigned' ? 'node unassigned' : 'node'} aria-pressed={picked === r.role}
              style={{ left: p.x - NODE.w / 2, top: p.y, width: NODE.w, height: NODE.h }} title={roleText(r.role, r.info)} onClick={() => onPick(r.role)}>
              <span className="av">{r.role === 'unassigned' ? '?' : r.role[0]!.toUpperCase()}</span>
              <b>{label(r.role)}</b>
              <span className="ty">{r.types.join(', ')}</span>
              <span className="nu">
                <span>{agentsOf(r.agents)} · {tokens(r.tokens)} tok</span>
                <span>{usd(r.cost, r.costPartial)}{r.avgMs !== null ? ` · avg ${duration(r.avgMs)}` : ''}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RolePanel({ role, catalog, project, onFix, onClose }: { role: Role; catalog: Catalog; project: string; onFix: (body: object) => Promise<void>; onClose: () => void }) {
  const [all, setAll] = useState(false); // the panel is keyed by its role, so picking another role starts closed again
  const panel = useReveal<HTMLElement>();
  const byType = new Map<string, AgentRow[]>();
  for (const a of role.agentList) byType.set(a.type ?? 'agent', [...(byType.get(a.type ?? 'agent') ?? []), a]);
  const agents = recentFirst(role.agentList);
  const listed = all ? agents : agents.slice(0, SHOWN);
  return (
    <aside ref={panel} className="card panel" aria-label="Agents behind a role">
      <h2>
        <span className="ph-t">{label(role.role)} · {role.types.join(', ')}<span className="hint">{agentsOf(role.agents)} · {tokens(role.tokens)} tok · {usd(role.cost, role.costPartial)}</span></span>
        <button type="button" className="x" aria-label="Close" onClick={onClose}>×</button>
      </h2>
      <div className="pbody">
        <div className="pcol">
          <p className="rinfo">{roleText(role.role, role.info)}</p>
          <ul className="alist">
            {listed.map((a) => {
              const m = modelLabel(a.model ?? undefined);
              return (
                <li key={a.id}>
                  <span><b>{a.type ?? 'agent'}</b> · <span className={`model ${m.tone || 'other'}`}>{m.text}</span></span>
                  <span className="src">{a.role_source ?? 'no role'}</span>
                  <span className="d">{a.description ? `“${a.description}” · ` : ''}session {a.session.slice(0, 6)} · {tokens(a.tokens, true)} tok{a.started_at && a.ended_at ? ` · ${duration(a.ended_at - a.started_at)}` : ''}</span>
                </li>
              );
            })}
          </ul>
          {agents.length > SHOWN && <button type="button" className="link" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show ${agents.length - SHOWN} more`}</button>}
        </div>
        <div className="pcol">
          {[...byType].map(([type, list]) => <TypeFix key={type} type={type} info={role.typeInfo[type]} catalog={catalog} list={list} current={role.role} project={project} onFix={onFix} />)}
        </div>
      </div>
      <Explain summary="Where a role comes from">
        <b>declared</b> (orb-role in the agent file) › <b>map</b> (roles.json) › <b>rule</b> (set here for a type) › <b>manual</b> (set here for one agent, wins over all).
      </Explain>
    </aside>
  );
}

function TypeFix({ type, info, catalog, list, current, project, onFix }: { type: string; info?: string | null; catalog: Catalog; list: AgentRow[]; current: string; project: string; onFix: (body: object) => Promise<void> }) {
  const [role, setRole] = useState<string>(catalog.some((c) => c.role === current) ? current : 'developer');
  const [everyOne, setEveryOne] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const save = async () => {
    setBusy(true);
    setMsg(undefined);
    try {
      if (everyOne) await onFix({ scope: 'type', project, agent_type: type, role });
      else for (const a of list) await onFix({ scope: 'agent', agent_id: a.id, role });
      setMsg({ ok: true, text: 'Saved.' });
    } catch (e) {
      setMsg({ ok: false, text: `Not saved: ${(e as Error).message}.` });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={current === 'unassigned' ? 'fix warn' : 'fix'}>
      <span className="tinfo"><b>{type}</b>: {typeText(info)}</span>
      <label className="field">Role for {type} <select aria-label={`Role for ${type}`} value={role} onChange={(e) => setRole(e.target.value)}>{catalog.map((c) => <option key={c.role} value={c.role} title={c.info}>{c.role}</option>)}</select></label>
      <span className="tinfo dim">{roleText(role, catalog.find((c) => c.role === role)?.info)}</span>
      <label className="chk"><input type="checkbox" checked={everyOne} onChange={(e) => setEveryOne(e.target.checked)} /> For every {type} agent in {project}, now and later</label>
      <div className="row"><button type="button" className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save role'}</button>{msg && <span role="status" className={msg.ok ? 'msg' : 'msg bad'}>{msg.text}</span>}</div>
    </div>
  );
}

export function Lanes({ data, now }: { data: LaneData; now: number }) {
  const ends = data.lanes.flatMap((l) => [
    ...l.turns.map((t) => (t.started_at ?? 0) + (t.duration_ms ?? Math.max(0, now - (t.started_at ?? now)))),
    ...l.tools.map((t) => t.ts + (t.duration_ms ?? Math.max(0, now - t.ts))),
  ]);
  const t0 = data.session.started_at;
  const t1 = Math.max(t0 + 10_000, data.session.ended_at ?? 0, data.until ?? 0, ...ends);
  const pct = (ts: number) => Math.min(100, Math.max(0, ((ts - t0) / (t1 - t0)) * 100));
  const fam = (m: string | null) => /opus|sonnet|haiku/.exec(m ?? '')?.[0] ?? 'other';
  const minMs = (t1 - t0) / 1000; // a wait narrower than about a pixel earns no bar of its own, and does not cut the turn
  // Five ticks, none on the right edge, so a label never leaves the card; a phone shows every other one.
  const ticks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * (i + 1)) / 6);
  // Seconds on the axis when the whole session fits in a few minutes, else minutes.
  const clock = (ts: number) => new Date(ts).toTimeString().slice(0, t1 - t0 < 5 * 60_000 ? 8 : 5);
  const bar = (key: string, a: number, b: number, kind: string, tone: string, title?: string) => (
    <span key={key} className={['lbar', kind, tone].filter(Boolean).join(' ')} style={{ left: `${pct(a)}%`, width: `${pct(b) - pct(a)}%` }} title={title} />
  );
  return (
    <section className="card" aria-label="One session over time">
      <h2>What ran when <span className="hint">one lane per agent; a solid bar is its own turns, a thin bar is waiting on a tool or an agent</span></h2>
      <div className="lanes" role="group" aria-label="Swimlane timeline, one lane per agent">
        {data.lanes.map((l) => {
          const spawnAt = l.started_at ?? l.turns[0]?.started_at ?? t0;
          const tone = fam(l.model ?? l.turns.find((t) => t.model)?.model ?? null);
          const waits = l.tools.map((t) => ({ at: t.ts, ms: t.duration_ms ?? Math.max(0, now - t.ts), tool: t.tool })).filter((w) => w.ms >= minMs);
          const stalled = waits.filter((w) => isStall(w.tool, w.ms)).sort((x, y) => y.ms - x.ms)[0];
          const spans = waits.map((w): [number, number] => [w.at, w.at + w.ms]);
          return (
            <Fragment key={l.id}>
              <div className="lh">
                <span className={`av ${tone}`}>{(l.type ?? 'agent')[0]!.toUpperCase()}</span>
                <span className="nm"><b>{l.type ?? 'agent'}</b>{stalled ? <small className="bad">stalled · {stalled.tool} {duration(stalled.ms).replace(' ', '\u00a0')}</small> : <small>{label(l.role ?? 'unassigned')}</small>}</span>
              </div>
              <div className="lt" aria-hidden="true">
                {l.turns.flatMap((t, i) => {
                  const a = t.started_at ?? spawnAt;
                  const b = a + (t.duration_ms ?? Math.max(0, now - a));
                  return ownSpans(a, b, spans).map(([x, y], k) => bar(`t${i}.${k}`, x, y, '', fam(t.model ?? l.model)));
                })}
                {waits.map((w, i) => bar(`w${i}`, w.at, w.at + w.ms, isStall(w.tool, w.ms) ? 'stall' : 'wait', tone, `${w.tool} ${duration(w.ms)}`))}
              </div>
            </Fragment>
          );
        })}
        <div className="ax" aria-hidden="true">{ticks.map((t, i) => <span key={t} className={i % 2 ? 'skip' : undefined} style={{ left: `${pct(t)}%` }}>{clock(t)}</span>)}</div>
      </div>
      <div className="legend"><span className="model opus">Opus</span><span className="model sonnet">Sonnet</span><span className="model haiku">Haiku</span><span className="model stalled">stalled</span></div>
    </section>
  );
}
