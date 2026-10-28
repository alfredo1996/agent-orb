import { useEffect, useMemo, useState } from 'react';
import { ago, tokens, usd } from './format.ts';
import { Explain, useReveal } from './kit.tsx';
import { byDay, calledText, layoutSkills, nodeLine, routeEdges, SKILL_NODE } from './skills-layout.ts';

// The Pipeline's Skills scope (PROJECT.md §8.3, §15), drawn as approved in design/pages.html (skills()), from /api/skills.
// The graph is built like the roles' chart: HTML nodes over an SVG layer that draws only the edges and their counts.

type How = { you: number; model: number; agent: number; preload: number };
type Node = {
  id: string; kind: 'skill' | 'agent'; name: string; source?: string; plugin?: string; description?: string; listed?: number; clash: boolean;
  ran: boolean; runs: number; spawns: number; tokens: number; cost: number; costPartial: boolean; byYou: number; byMain: number;
};
type Edge = { from: string; to: string; did: number; named: boolean; preload: boolean; tokens: number };
type Usage = { id: string; name: string; source: string; runs: number; how: How; tokens: number; cost: number; costPartial: boolean; last: number; loads: number[] };
type Idle = { name: string; source: string; plugin?: string; tokens: number; clash: boolean };
type Data = { nodes: Node[]; edges: Edge[]; usage: Usage[]; idle: Idle[] };

const ORIGIN: Record<string, [string, string]> = {
  projectSettings: ['project', 'project'], userSettings: ['user', 'user'], plugin: ['plugin', 'plugin'], 'built-in': ['built-in', 'builtin'],
  syncedSkills: ['synced', 'builtin'], mcp: ['mcp', 'builtin'], policySettings: ['policy', 'builtin'],
};
const origin = (source?: string) => ORIGIN[source ?? ''] ?? ['unknown', 'builtin'];
const slash = (n: Node | Usage) => ('kind' in n && n.kind === 'agent' ? n.name : `/${n.name}`);
const Chip = ({ source, agent }: { source?: string; agent?: boolean }) => <span className={`og-chip ${agent ? 'builtin' : origin(source)[1]}`}>{agent ? 'agent' : origin(source)[0]}</span>;

export function Skills({ query, now }: { query?: string; now: number }) {
  const [data, setData] = useState<Data>();
  const [error, setError] = useState<string>();
  const [picked, setPicked] = useState<string>();
  const [sort, setSort] = useState<'runs' | 'tokens'>('runs');

  useEffect(() => {
    if (!query) return;
    let on = true;
    fetch(`/api/skills?${query}`)
      .then(async (res) => (res.ok ? (res.json() as Promise<Data>) : Promise.reject(new Error(`/api/skills answered ${res.status}`))))
      .then((d) => on && (setData(d), setError(undefined)))
      .catch((e: Error) => on && setError(e.message));
    return () => { on = false; };
  }, [query]);

  if (error) return <div className="empty"><b>The skills could not load.</b><span>{error}</span></div>;
  if (!data) return null;
  if (!data.usage.length && !data.idle.length) {
    return <div className="empty"><b>No skills recorded in this period.</b><span>Sessions started with this version of the plugin list their skills and record each one they load.</span></div>;
  }
  const node = data.nodes.find((n) => n.id === picked);
  const pick = (id: string) => setPicked(picked === id ? undefined : id);
  return (
    <>
      {data.usage.length > 0 && (
        <section className="card" aria-label="What calls what">
          <h2>What calls what <span className="hint">solid: it called, as thick as the times · dashed: named in its text, never called here · pick a node</span></h2>
          <Graph data={data} picked={picked} onPick={pick} />
          <PhoneList data={data} picked={picked} onPick={pick} />
          <Explain summary="How to read this graph">
            Where the edges come from: <b>named</b> = the skill's or agent's text names another skill (<span className="mono">/name</span>, “the name skill”) or an
            agent type from the session's own list; <b>did call</b> = a Skill call or an agent spawn in the same turn, after the skill loaded. A mention between
            two agents isn't drawn unless one spawned the other. A spawn or a skill call goes to the skill whose text names it, else to the latest one. Tokens go to the skill that
            started the chain: the rest of its turn and the agents it dispatched.
          </Explain>
        </section>
      )}
      {node && <Panel key={node.id} node={node} data={data} onClose={() => setPicked(undefined)} />}
      {data.usage.length > 0 && <UsageCard usage={data.usage} sort={sort} onSort={setSort} now={now} onPick={setPicked} />}
      {data.idle.length > 0 && (
        <section className="card" aria-label="Skills that never ran">
          <h2>Listed but never ran <span className="hint">{data.idle.length} skill{data.idle.length === 1 ? '' : 's'} · {tokens(data.idle.reduce((s, i) => s + i.tokens, 0))} tokens of listing in every session</span></h2>
          <div className="idle">
            {data.idle.map((i) => (
              <span key={`${i.source}:${i.name}`} className={i.clash ? 'c clash' : 'c'}>
                <span className="mono">{i.name}</span><span className="how">{origin(i.source)[0]} · {i.tokens} tok{i.clash ? ' · another skill has this name' : ''}</span>
              </span>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Graph({ data, picked, onPick }: { data: Data; picked?: string; onPick: (id: string) => void }) {
  // Ran first, the busiest on top; what only a text names last.
  const nodes = useMemo(() => [...data.nodes].sort((a, b) => Number(b.ran) - Number(a.ran) || b.tokens - a.tokens), [data]);
  const l = useMemo(() => layoutSkills(nodes, data.edges), [nodes, data]);
  const routes = useMemo(() => routeEdges(data.edges, l.pos), [data, l]);
  const maxDid = Math.max(1, ...data.edges.map((e) => e.did));
  const heading = (c: number) => {
    const kinds = new Set(nodes.filter((n) => l.pos.get(n.id)!.col === c).map((n) => n.kind));
    return c === 0 ? 'Run first' : kinds.size > 1 ? 'Skills and agents' : kinds.has('agent') ? 'Agents dispatched' : 'Skills they call';
  };
  return (
    <div className="skgwrap">
      <div className="skgscroll">
        <div className="skg" style={{ width: l.width, height: l.height }}>
          <svg width={l.width} height={l.height} aria-hidden="true">
            {routes.map((e) => (
              <g key={`${e.from}>${e.to}`}>
                <path className={e.did ? 'e' : 'e named'} d={e.d} strokeWidth={e.did ? 1.5 + (3.5 * e.did) / maxDid : undefined} />
                {e.did > 0 && <text className="el" x={e.lx} y={e.ly} textAnchor={e.lx > (l.pos.get(e.to)?.x ?? 0) ? 'start' : 'end'}>{e.did}×</text>}
              </g>
            ))}
          </svg>
          {l.cols.map((x, c) => <span key={c} className="colt" style={{ left: x }}>{heading(c)}</span>)}
          {nodes.map((n) => {
            const p = l.pos.get(n.id)!;
            return (
              <button key={n.id} type="button" className={`sknode ${n.kind}${n.ran ? '' : ' ghost'}`} aria-pressed={picked === n.id}
                style={{ left: p.x, top: p.y, width: SKILL_NODE.w, height: SKILL_NODE.h }} title={n.description ? `${n.name}: ${n.description}` : undefined} onClick={() => onPick(n.id)}>
                <span className="t"><b>{slash(n)}</b>{n.clash && <span className="dup" title="Another skill has this name">2×</span>}</span>
                <small>{nodeLine(n, origin(n.source)[0])}</small>
              </button>
            );
          })}
        </div>
      </div>
      <div className="legend">
        <span className="model skill">skill</span><span className="model agent">agent type</span>
        {data.nodes.some((n) => n.clash) && <span><span className="dup">2×</span> two skills share the name</span>}
      </div>
    </div>
  );
}

// On a phone the graph gives way to this list: each ran skill with its line and what it called, then every agent type (ghosts too), each opening its panel.
function PhoneList({ data, picked, onPick }: { data: Data; picked?: string; onPick: (id: string) => void }) {
  const name = (id: string) => data.nodes.find((n) => n.id === id)?.name ?? id;
  const list = [
    ...data.nodes.filter((n) => n.kind === 'skill' && n.ran).sort((a, b) => b.runs - a.runs || b.tokens - a.tokens),
    ...data.nodes.filter((n) => n.kind === 'agent').sort((a, b) => b.spawns - a.spawns || b.tokens - a.tokens),
  ];
  return (
    <div className="rolelist sklist" aria-label="Skills, agents and what they call">
      {list.map((n) => {
        const called = calledText(data.edges.filter((e) => e.from === n.id), name);
        return (
          <button key={n.id} type="button" className={n.kind === 'agent' ? 'r agent' : 'r'} aria-pressed={picked === n.id} onClick={() => onPick(n.id)}>
            <span>
              <b className="nm">{slash(n)}</b>{n.clash && <span className="dup">2×</span>}
              <small>{nodeLine(n, origin(n.source)[0])}</small>
              {called && <small>{called}</small>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Panel({ node, data, onClose }: { node: Node; data: Data; onClose: () => void }) {
  const panel = useReveal<HTMLElement>(); // the panel is keyed by its node, so picking another one brings it up again
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const out = data.edges.filter((e) => e.from === node.id).sort((a, b) => b.did - a.did);
  const into = data.edges.filter((e) => e.to === node.id).sort((a, b) => b.did - a.did);
  const agent = node.kind === 'agent';
  const runs = agent ? node.spawns : node.runs;
  const kind = (id: string) => (byId.get(id)?.kind === 'agent' ? 'agent' : `${origin(byId.get(id)?.source)[0]} skill`);
  return (
    <aside ref={panel} className="card panel" aria-label="The picked skill or agent">
      <h2>
        <span className="ph-t">
          <span>{slash(node)} <Chip source={node.source} agent={agent} /></span>
          <span className="hint">
            {agent ? `spawned ${node.spawns}×` : `ran ${node.runs}×`} · {tokens(node.tokens)} tok{agent ? '' : ' with what it dispatched'} · {usd(node.cost, node.costPartial)} API-eq.
            {node.listed ? ` · its listing costs ${node.listed} tok in every session` : ''}
          </span>
        </span>
        <button type="button" className="x" aria-label="Close" onClick={onClose}>×</button>
      </h2>
      <div className="pbody">
        {node.description && <p className="rinfo">“{node.description}”</p>}
        <div className="pcol">
          <h3>It called</h3>
          <ul className="alist">
            {out.map((e) => (
              <li key={e.to}>
                <span><b>{byId.get(e.to)?.name ?? e.to}</b> · <span className={e.did ? 'num' : 'num never'}>{e.did}×</span></span>
                <span className="src">{kind(e.to)}</span>
                <span className="d">
                  {e.did ? `${e.tokens ? `${tokens(e.tokens)} tok · ` : ''}${e.preload ? 'preloaded · ' : ''}${e.named ? 'named in its text' : 'not named in its text'}`
                    : `named in its text, not ${byId.get(e.to)?.kind === 'agent' ? 'spawned' : 'called'} in ${runs} run${runs === 1 ? '' : 's'}`}
                </span>
              </li>
            ))}
            {!out.length && <li className="d">It called nothing, and its text names nothing.</li>}
          </ul>
        </div>
        <div className="pcol">
          <h3>Called by</h3>
          <ul className="alist">
            {node.byYou > 0 && <li><span><b>you</b>, typing /{node.name} · <span className="num">{node.byYou}×</span></span></li>}
            {node.byMain > 0 && <li><span><b>the main agent</b>, on its own · <span className="num">{node.byMain}×</span></span></li>}
            {into.map((e) => (
              <li key={e.from}>
                <span><b>{byId.get(e.from)?.name ?? e.from}</b> · <span className={e.did ? 'num' : 'num never'}>{e.did}×</span></span>
                <span className="src">{kind(e.from)}</span>
                {!e.did && <span className="d">names it in its text, never called it</span>}
              </li>
            ))}
            {!node.byYou && !node.byMain && !into.length && <li className="d">Nothing here called it.</li>}
          </ul>
        </div>
      </div>
    </aside>
  );
}

function UsageCard({ usage, sort, onSort, now, onPick }: { usage: Usage[]; sort: 'runs' | 'tokens'; onSort: (s: 'runs' | 'tokens') => void; now: number; onPick: (id: string) => void }) {
  const rows = [...usage].sort((a, b) => (sort === 'runs' ? b.runs - a.runs || b.tokens - a.tokens : b.tokens - a.tokens || b.runs - a.runs));
  const most = usage[0]!;
  const least = usage.at(-1)!;
  const per = (u: Usage) => u.tokens / u.runs;
  const maxRuns = Math.max(...usage.map((u) => u.runs));
  const spark = (loads: number[]) => {
    const days = byDay(loads, now);
    const m = Math.max(1, ...days);
    return (
      <svg className="spark" width="70" height="18" viewBox="0 0 70 18" role="img" aria-label={`${days.reduce((s, d) => s + d, 0)} runs in the last 7 days`}>
        {days.map((d, i) => <rect key={i} x={i * 10} y={18 - Math.max(1, Math.round((d / m) * 16))} width="7" height={Math.max(1, Math.round((d / m) * 16))} opacity={d ? 0.9 : 0.3} />)}
      </svg>
    );
  };
  return (
    <section className="card usage" aria-label="Skill usage">
      <h2>
        Skill usage
        <span className="seg">{(['runs', 'tokens'] as const).map((s) => <button key={s} type="button" aria-pressed={sort === s} onClick={() => onSort(s)}>By {s}</button>)}</span>
      </h2>
      <div className="sum">
        <span>Most used: <b>/{most.name}</b>, {most.runs} run{most.runs === 1 ? '' : 's'}, <b>{tokens(most.tokens)} tok</b> ({tokens(Math.round(per(most)))} a run)</span>
        {least !== most && <span>Least used that ran: <b>/{least.name}</b>, {least.runs} run{least.runs === 1 ? '' : 's'}, <b>{tokens(least.tokens)} tok</b> ({tokens(Math.round(per(least)))} a run)</span>}
        {least !== most && per(least) > 0 && per(most) > 0 && per(most) !== per(least) && (() => {
          const [dear, cheap] = per(most) > per(least) ? [most, least] : [least, most];
          return <span><b>/{dear.name}</b> costs <b>{(per(dear) / per(cheap)).toFixed(1)}×</b> as much per run as <b>/{cheap.name}</b></span>;
        })()}
      </div>
      <div className="tw"><table>
        <thead><tr><th>Skill</th><th>Runs</th><th className="d-only">Started by</th><th className="r">Tokens</th><th className="r d-only">Per run</th><th className="r end">API-eq.</th><th className="r d-only">Last used</th><th className="d-only">Last 7 days</th></tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id} tabIndex={0} onClick={() => onPick(u.id)} onKeyDown={(e) => e.key === 'Enter' && onPick(u.id)}>
              <td className="sn"><span className="mono">/{u.name}</span><span className="sub">{origin(u.source)[0]}</span></td>
              <td><div className="runs"><span className="num">{u.runs}</span><div className="bar"><i style={{ width: `${(u.runs / maxRuns) * 100}%` }} /></div></div></td>
              <td className="d-only">{(['you', 'model', 'agent', 'preload'] as const).filter((k) => u.how[k]).map((k) => `${k} ${u.how[k]}`).join(' · ')}</td>
              <td className="r num">{tokens(u.tokens)}</td>
              <td className="r num d-only">{tokens(Math.round(per(u)))}</td>
              <td className="r num end">{usd(u.cost, u.costPartial)}</td>
              <td className="r d-only">{ago(now - u.last)}</td>
              <td className="d-only">{spark(u.loads)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <Explain summary="How to read the tokens">
        A skill's tokens include what it started: the skills it called and the agents it dispatched. The rows overlap, so they add up to more than the period's total.
      </Explain>
    </section>
  );
}
