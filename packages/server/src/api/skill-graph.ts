// Slice 5 (PROJECT.md §8.3, §15 2026-10-21): a project's skills and the agent types they dispatch, as a graph, with
// what each one used. Pure: the route (skills.ts) reads the rows from the history store, this turns them into nodes, edges and usage.
//
// A "did call" edge is drawn inside one turn: a skill load, or an agent spawn, is called by the latest skill loaded
// before it in that turn whose text names it, else by the latest skill loaded before it; a subagent's first skill is
// called by its agent type. A "named" edge is what a skill's or agent's text names (the mod matches it against the
// session's own names). Tokens go to the skill that started the chain: a skill called from inside another counts its
// runs, and its requests stay with its caller, so a skill pays for what it starts and rows overlap.
// ponytail: same-turn attribution; a skill whose instructions carry on into the person's next turn loses that turn.

export type Def = {
  name: string; kind: 'skill' | 'agent'; source: string; plugin?: string; tokens: number; description?: string;
  calls_skills?: string[]; calls_agents?: string[]; preload?: string[];
};
export type Load = { ts: number; skill: string; how?: 'typed' | 'tool' | 'preload'; source?: string };
export type TurnRow = {
  agent: string; type: string; sub: boolean; started_at: number; loads: Load[];
  spawns: { ts: number; type: string; tokens: number; cost: number | null }[];
  requests: { ts: number; tokens: number; cost: number | null }[];
};
export type AgentTypeRow = { type: string; agents: number; tokens: number; cost: number | null };

type How = { you: number; model: number; agent: number; preload: number };
export type Usage = { id: string; name: string; source: string; runs: number; how: How; tokens: number; cost: number; costPartial: boolean; last: number; loads: number[] };
export type Node = {
  id: string; kind: 'skill' | 'agent'; name: string; source?: string; plugin?: string; description?: string; listed?: number; clash: boolean;
  ran: boolean; runs: number; spawns: number; tokens: number; cost: number; costPartial: boolean; byYou: number; byMain: number;
};
export type Edge = { from: string; to: string; did: number; named: boolean; preload: boolean; tokens: number };

// Which definition a name means when two share it, and an older load carries no source: the project's, then the user's.
const RANK = ['projectSettings', 'userSettings', 'plugin', 'built-in', 'syncedSkills', 'mcp', 'policySettings'];
const rank = (s: string) => (RANK.includes(s) ? RANK.indexOf(s) : RANK.length);

export function skillGraph(defs: Def[], turns: TurnRow[], types: AgentTypeRow[]) {
  const skills = defs.filter((d) => d.kind === 'skill');
  const agentDefs = new Map(defs.filter((d) => d.kind === 'agent').map((d) => [d.name, d]));
  const byName = new Map<string, Def[]>();
  for (const d of skills) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
  const clash = (name: string) => new Set(byName.get(name)?.map((d) => d.source)).size > 1;
  const resolve = (name: string, source?: string): Def =>
    byName.get(name)?.find((d) => d.source === source)
    ?? [...(byName.get(name) ?? [])].sort((a, b) => rank(a.source) - rank(b.source))[0]
    ?? { name, kind: 'skill', source: source ?? 'unknown', tokens: 0 };
  const skillId = (d: Def) => `skill:${d.source}:${d.name}`;

  const nodes = new Map<string, Node>();
  const node = (id: string, kind: 'skill' | 'agent', name: string, d?: Def): Node => {
    let n = nodes.get(id);
    if (!n) {
      nodes.set(id, n = {
        id, kind, name, clash: kind === 'skill' && clash(name), ran: false, runs: 0, spawns: 0, tokens: 0, cost: 0, costPartial: false, byYou: 0, byMain: 0,
        ...(d && { source: d.source, listed: d.tokens, ...(d.plugin && { plugin: d.plugin }), ...(d.description && { description: d.description }) }),
      });
    }
    return n;
  };
  const skillNode = (d: Def) => {
    const n = node(skillId(d), 'skill', d.name, byName.get(d.name)?.includes(d) ? d : undefined);
    n.source ??= d.source;
    return n;
  };
  const agentNode = (type: string) => node(`agent:${type}`, 'agent', type, agentDefs.get(type));

  const edges = new Map<string, Edge>();
  const edge = (from: string, to: string) => {
    const k = `${from}>${to}`;
    let e = edges.get(k);
    if (!e) edges.set(k, e = { from, to, did: 0, named: false, preload: false, tokens: 0 });
    return e;
  };

  const usage = new Map<string, Usage>();
  const use = (n: Node): Usage => {
    let u = usage.get(n.id);
    if (!u) usage.set(n.id, u = { id: n.id, name: n.name, source: n.source ?? 'unknown', runs: 0, how: { you: 0, model: 0, agent: 0, preload: 0 }, tokens: 0, cost: 0, costPartial: false, last: 0, loads: [] });
    return u;
  };
  const spend = (u: Usage, tokens: number, cost: number | null) => {
    u.tokens += tokens;
    if (cost === null) u.costPartial = true;
    else u.cost += cost;
  };

  for (const t of turns) {
    const owners: { ts: number; u: Usage }[] = [];
    const loaded: { n: Node; d: Def }[] = [];
    // The latest skill loaded so far in this turn whose text names the target, else the latest one (a real run, 2026-10-21:
    // alpha typed, beta called from it, then the scout alpha names; the spawn is alpha's, not beta's).
    const callerFor = (kind: 'skill' | 'agent', name: string) =>
      [...loaded].reverse().find((x) => (kind === 'skill' ? x.d.calls_skills : x.d.calls_agents)?.includes(name)) ?? loaded.at(-1);
    const events = [...t.loads.map((l) => ({ ts: l.ts, l })), ...t.spawns.map((s) => ({ ts: s.ts, s }))]
      .sort((a, b) => a.ts - b.ts || ('l' in a ? -1 : 1));
    for (const ev of events) {
      if ('l' in ev) {
        const l = ev.l;
        const d = resolve(l.skill, l.source);
        const n = skillNode(d);
        n.ran = true;
        n.runs++;
        const u = use(n);
        u.runs++;
        u.last = Math.max(u.last, l.ts);
        u.loads.push(l.ts);
        u.how[l.how === 'typed' ? 'you' : l.how === 'preload' ? 'preload' : t.sub ? 'agent' : 'model']++;
        const bySkill = callerFor('skill', l.skill)?.n;
        const caller = bySkill ?? (t.sub ? agentNode(t.type) : undefined);
        if (caller) {
          caller.ran = true;
          const e = edge(caller.id, n.id);
          e.did++;
          if (l.how === 'preload') e.preload = true;
        } else if (l.how === 'typed') n.byYou++;
        else n.byMain++;
        if (!bySkill) owners.push({ ts: l.ts, u }); // it starts a chain: the requests after it are its own
        loaded.push({ n, d });
      } else {
        const by = callerFor('agent', ev.s.type)?.n;
        if (!by) continue;
        const s = ev.s;
        const a = agentNode(s.type);
        a.ran = true;
        const e = edge(by.id, a.id);
        e.did++;
        e.tokens += s.tokens;
        spend(use(by), s.tokens, s.cost);
      }
    }
    // Each request belongs to the latest chain-starting skill loaded before it in this turn; requests before it, to none.
    for (const r of t.requests) {
      const owner = owners.filter((o) => o.ts <= r.ts).at(-1);
      if (owner) spend(owner.u, r.tokens, r.cost);
    }
  }

  for (const ty of types) {
    const n = nodes.get(`agent:${ty.type}`);
    if (!n) continue;
    n.spawns = ty.agents;
    n.tokens = ty.tokens;
    n.cost = ty.cost ?? 0;
    n.costPartial = ty.cost === null;
  }
  for (const u of usage.values()) {
    const n = nodes.get(u.id)!;
    n.tokens = u.tokens;
    n.cost = u.cost;
    n.costPartial = u.costPartial;
  }

  // Named edges, from what ran: a skill's or agent's text names another skill or an agent type (or preloads a skill).
  for (const n of [...nodes.values()].filter((x) => x.ran)) {
    const d = n.kind === 'skill' ? resolve(n.name, n.source) : agentDefs.get(n.name);
    if (!d) continue;
    for (const s of new Set([...(d.calls_skills ?? []), ...(d.preload ?? [])])) edge(n.id, skillNode(resolve(s)).id).named = true;
    for (const a of d.calls_agents ?? []) edge(n.id, agentNode(a).id).named = true;
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    usage: [...usage.values()].sort((a, b) => b.runs - a.runs || b.tokens - a.tokens),
    // What the Skill tool lists in every session without it ever running: its listing tokens are the cost.
    idle: skills.filter((d) => !usage.has(skillId(d))).sort((a, b) => b.tokens - a.tokens)
      .map((d) => ({ name: d.name, source: d.source, ...(d.plugin && { plugin: d.plugin }), tokens: d.tokens, clash: clash(d.name) })),
  };
}
