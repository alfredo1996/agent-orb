import { useEffect, useRef, useState } from 'react';
import { ago, contextMeter, duration, modelLabel, plural, readTokens, stateLabel, usd } from './format.ts';
import { rowKey, useHistory, type Open, type Picked } from './History.tsx';
import { Explain, PageHeader } from './kit.tsx';
import { agentName, liveSentence, loadStops, needKey, needs, pricierSub, progress, rowState, runFor, saveStops, sentence, skillHow, startedLabel, stopClick, stopKey, stopMode, tree, type CardAgent, type Need, type StopMode } from './live-cards.ts';

// The Live view (PROJECT.md §8.1), drawn as approved in design/pages.html (the v3 rows, §15), fed by /stream.

export type Agent = CardAgent & {
  parent?: string; role?: string; description?: string; model?: string; tokens: number; cost: number;
  skills: string[]; asked?: string; calls: number; failed: number;
};
export type Session = {
  id: string; project: string; branch?: string; host: string; startedAt: number; lastTs: number; endedAt?: number;
  tokens: number; cost: number; costPartial: boolean; contextPercent?: number; agents: Agent[];
  content?: 'off' | 'full' | 'excluded'; stoppedAt?: number; stoppedAborted?: boolean; skills?: { skill: string; count: number; by: { who: string; count: number }[] }[];
};

/**
 * What the hook below does at each render of the list: the card a Factory board link named (`#/live?session=<id>`, #32) is brought into view and focused, once. A session Live does not show, because
 * it ended more than ten minutes ago, is given up on as soon as the list has loaded without it; before that (the stream has not spoken) the wish stays.
 */
export function focusWanted(want: { current: string | null | undefined }, listed: number, doc: Pick<Document, 'getElementById'>, reducedMotion: boolean) {
  if (!want.current) return;
  const card = doc.getElementById(`session-${want.current}`);
  if (!card && !listed) return; // the stream has not spoken yet
  want.current = null;
  card?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  card?.focus({ preventScroll: true });
}

/** The session a link named (the app reads it out of the hash and passes it as `wanted`), taken as the view opens: not one that a later render is handed. */
function useWantedSession(list: Session[], wanted: string | null) {
  const want = useRef<string | null | undefined>(undefined);
  if (want.current === undefined) want.current = wanted;
  useEffect(() => focusWanted(want, list.length, document, matchMedia('(prefers-reduced-motion: reduce)').matches), [list]);
}

export function Live({ list, all, now, wanted = null }: { list: Session[]; all: Record<string, Session>; now: number; wanted?: string | null }) {
  const { picked, open, drawer } = useHistory(all, now);
  useWantedSession(list, wanted);
  return (
    <main className="live">
      <PageHeader title="Live" sub={<span>{liveSentence(list)}</span>} />

      <NeedsYou list={list} now={now} onOpen={open} />

      {!list.length && (
        <div className="empty">
          <b>Nothing to show yet.</b>
          <span>Start Claude Code with the agent-orb plugin: its agents appear here within a couple of seconds.</span>
        </div>
      )}

      {list.map((s) => <SessionCard key={s.id} s={s} now={now} picked={picked} onOpen={open} />)}

      {drawer}

      {list.length > 0 && (
        <section className="card">
          <Explain summary="How to read Live">
            Each row says what the agent is doing now and how far its tasks are; click one for everything it did, what failed and what is left.
            Cost is <b>API-equivalent</b>: what these tokens would cost at API list prices (<span className="mono">pricing.json</span>), not what a plan bills.
          </Explain>
          <Explain summary="How claims are checked">
            With Content on full, an agent&apos;s final answer is read for test, build and edit claims, and each is checked against that agent&apos;s own calls: a passing test or build run after its
            last edit to code or tests, a write to the file it names. A claim that fails shows here as <b>unbacked claim</b>, with the reason. Without Content on full a session reads &ldquo;claims not
            checked&rdquo;, never clean.
          </Explain>
          <Explain summary="How the model check works">
            An agent is flagged when it runs on a pricier model than it should: its agent file's <code>model:</code>, or, for an agent with no file of its own
            (general-purpose, workflow agents, <code>model: inherit</code>), the ceiling you set, Sonnet unless you change it in the plugin's settings.
            The main session is never flagged. It shows here, in the status line and as one notification, and stays in the Ledger.
          </Explain>
        </section>
      )}
    </main>
  );
}

/**
 * Every agent waiting for you or stalled, oldest first, then a session the studio just stopped (v0.4 slice 5, #31), then every one whose last answer holds an unbacked claim (v0.3 slice 4), then every one on a pricier
 * model (v0.2 slice 2), whichever session it is in. A stalled row has a Stop turn button: it asks in place, shows Stopping once sent, and the row becomes Stopped when the session's event arrives.
 * A click belongs to one stall (the session, the agent and when its stall began), so a later stall of the same agent starts from the button again. A Stopping row is kept for the tab (a reload keeps it) and lapses
 * after the ten minutes the server holds a stop.
 */
function NeedsYou({ list, now, onOpen }: { list: Session[]; now: number; onOpen: Open }) {
  const need = needs(list, now);
  const [stops, setStops] = useState(() => loadStops(now));
  useEffect(() => saveStops(stops), [stops]);
  if (!need.length) return null;
  const stopped = need.filter((n) => n.tone === 'stopped').length; // a stopped session is not an agent
  const hint = [need.length > stopped && plural(need.length - stopped, 'agent'), stopped > 0 && `${stopped} stopped`].filter(Boolean).join(' · ');
  return (
    <section className="card needs" aria-labelledby="needs-h">
      <h2 id="needs-h">Needs you <span className="hint">{hint}</span></h2>
      {need.map((n) => {
        const s = list.find((x) => x.id === n.session);
        const key = stopKey(n);
        const mine = stops[key];
        const ask = { session: n.session, agent: n.agent, since: n.since ?? 0 };
        const onStop = (to: 'ask' | 'confirm' | 'sent') => stopClick(to, ask, (next) => setStops((all) => ({ ...all, [key]: next })), Date.now);
        return <NeedRow key={needKey(n)} n={n} project={s?.project} branch={s?.branch} now={now} mode={stopMode(mine, now)} sentAt={mine?.at} onOpen={onOpen} onStop={onStop} />;
      })}
    </section>
  );
}

type NeedRowProps = { n: Need; project?: string; branch?: string; now: number; mode: StopMode; sentAt?: number; onOpen: Open; onStop: (to: 'ask' | 'confirm' | 'sent') => void };

/** One row of Needs you. A pure function of its props (the clicks are `onStop`'s), so a test can read the buttons off what it returns. */
export function NeedRow({ n, project, branch, now, mode, sentAt, onOpen, onStop }: NeedRowProps) {
  const wait = n.tone === 'wait';
  const stopped = n.tone === 'stopped';
  const stall = n.tone === 'bad';
  const state = n.tone === 'model' ? 'model' : n.tone === 'claim' ? 'claim' : stopped ? 'stopped' : wait ? 'waiting' : 'stalled';
  const stoppable = stall && !n.background && n.since !== undefined; // a background agent is not in the main turn that Stop ends
  const retry = stoppable && (mode === 'ask' || mode === 'failed' || mode === 'gone' || mode === 'lapsed');
  const where = <b>{project}{branch && ` · ${branch}`}</b>; // the mockup's title for the session's rows
  const doing = n.arg ?? n.tool;
  const since = stopped ? 'now' : stoppable && mode === 'sent' && sentAt !== undefined ? duration(now - sentAt) : n.since !== undefined ? duration(now - n.since) : undefined; // Stopping counts from the click
  return (
    <div className="need">
      <span className={`state ${state}`}>{stateLabel(state)}</span>
      <span className="what">
        {stopped ? <>
          {where}
          <span className="sub">{!n.aborted ? 'The stall had ended before the stop arrived; nothing was stopped.' : n.ended ? 'Stopped from the studio. The session has ended.' : 'Stopped from the studio. The session is open and idle.'}</span>
        </>
        : n.claim ? <><b>{agentName(n.type)}</b> in <b>{project}</b> said {n.claim.phrase}; {n.claim.reason}</>
        : n.pricier ? <>{n.pricier.generic && 'A '}<b>{n.pricier.subject}</b> in <b>{project}</b> {n.pricier.tail}</>
        : stall ? <>
          {where}
          {n.background ? <span className="sub">A background agent can&apos;t be stopped from here. Use agent view.</span>
            : stoppable && mode === 'sent' ? <span className="sub">Stop sent, waiting for the session to pick it up</span>
            : <span className="sub">{agentName(n.type)} on {doing ? <code>{doing}</code> : 'its last step'}</span>}
          {stoppable && mode === 'failed' && <span className="sub">The stop did not reach the server. Try again.</span>}
          {stoppable && mode === 'gone' && <span className="sub">The server has no record of this session. Reload the page, or stop it at its terminal.</span>}
          {stoppable && mode === 'lapsed' && <span className="sub">The session did not pick the stop up. Try again.</span>}
        </> : <>
          <b>{agentName(n.type)}</b> in <b>{project}</b> wants to run <span className="num">{n.tool ?? 'a tool'}</span>{n.arg && <> <code>{n.arg}</code></>}
        </>}
      </span>
      <span className="since num">{since}</span>
      <span className="acts">
        {!stopped && <button type="button" className="btn" aria-label={`Open the history of ${agentName(n.type)}`} onClick={(e) => onOpen(n.session, n.agent, e.currentTarget)}>Open</button>}
        {stoppable && mode === 'sent' && <button type="button" className="btn" disabled>Stopping</button>}
        {retry && <button type="button" className="btn" onClick={() => onStop('confirm')}>Stop turn</button>}
      </span>
      {stoppable && mode === 'confirm' && (
        <div className="confirm" role="group" aria-label="Stop this session's turn?">
          <b>Stop this session&apos;s turn?</b>
          <span>Its running tools stop and the session stays open. It reaches the session within a minute.</span>
          <div className="acts">
            <button type="button" className="btn danger" onClick={() => onStop('sent')}>Stop turn</button>
            <button type="button" className="btn" onClick={() => onStop('ask')}>Keep waiting</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionCard({ s, now, picked, onOpen }: { s: Session; now: number; picked?: Picked; onOpen: Open }) {
  return (
    <section className="card sess" id={`session-${s.id}`} tabIndex={-1} aria-label={`Session ${s.project}`}>
      <div className="shead">
        <div className="who">
          <div className="l1">
            <h2>{s.project}</h2>
            {s.branch && <span className="chip">{s.branch}</span>}
            {s.content === 'excluded' && <span className="chip off">content excluded</span>}
            {s.content !== 'full' && <span className="chip off" title="A claim is checked against the agent's calls only when its answer was captured: Content on full">claims not checked</span>}
          </div>
          <span className="meta">{s.host} · session {s.id.slice(0, 6)} · started {startedLabel(s.startedAt, now)} · {s.endedAt ? `ended ${ago(now - s.endedAt)}` : `running ${runFor(now - s.startedAt)}`}</span>
        </div>
        <div className="figs">
          <span><b>{readTokens(s.tokens)}</b> tokens so far · <b>{usd(s.cost, s.costPartial)}</b> at API prices</span>
          <Context percent={s.contextPercent} />
        </div>
      </div>
      {!!s.skills?.length && (
        <div className="skills"><span>Skills</span>
          {s.skills.map((k) => <span key={k.skill} className="chip skill"><b>/{k.skill}</b><i>{skillHow(k.by)}</i></span>)}
        </div>
      )}
      <div className="cols" aria-hidden="true">
        <span>Agent</span><span>Doing now</span><span>Model</span><span className="r">Tokens</span><span className="r">API cost</span><span className="r">State</span>
      </div>
      {/* ponytail: one indent level; Claude Code's subagents do not nest, a deeper one reads as a sibling under its own parent */}
      {tree(s.agents).map(({ agent: a, level, more }) => (
        <AgentRow key={a.id} a={a} kids={s.agents.filter((k) => k.parent === a.id)} level={level} more={more} now={now}
          rowId={rowKey(s.id, a.id)} selected={picked?.session === s.id && picked.agent === a.id} onOpen={(from) => onOpen(s.id, a.id, from)} />
      ))}
    </section>
  );
}

/** The session's context window, in words: unknown until the first turn ends, then `Context 41% full` and a meter that turns amber from 80%. */
function Context({ percent }: { percent?: number }) {
  const meter = contextMeter(percent);
  if (!meter) return <span>Context: known after the first turn</span>;
  return (
    <span className={meter.near ? 'ctxline near' : 'ctxline'}>
      Context <b>{meter.percent}% full</b>{meter.near && ' · near the limit'}
      <span className={meter.near ? 'bar warn' : 'bar'} role="img" aria-label={`Context ${meter.percent}% full`}><i style={{ width: `${meter.fill}%` }} /></span>
    </span>
  );
}

type RowProps = { a: Agent; kids: Agent[]; level: number; more: boolean; now: number; rowId: string; selected: boolean; onOpen: (from: HTMLElement) => void };

function AgentRow({ a, kids, level, more, now, rowId, selected, onOpen }: RowProps) {
  const model = modelLabel(a.model);
  const s = sentence(a, kids, now);
  const p = progress(a.tasks);
  const state = rowState(a);
  const name = agentName(a.type);
  const why = pricierSub(a);
  const quote = a.id === 'main' ? a.asked && (['you asked', a.asked] as const) : a.description && (['task', a.description] as const);
  return (
    <div className={`agent d${Math.min(level, 1)}${more ? ' more' : ''} is-${state}`} role="button" tabIndex={0} data-row={rowId} aria-expanded={selected}
      aria-label={`${name}, ${stateLabel(state)}. ${s.verb}. Open its history`}
      onClick={(e) => onOpen(e.currentTarget)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(e.currentTarget))}>
      <span className="name">
        <span className={`av ${model.tone || 'other'}`} aria-hidden="true">{name[0]!.toUpperCase()}</span>
        <span><b>{name}</b>{a.role && <small>{a.role}</small>}</span>
      </span>
      <span className="doing">
        <span className="what">{s.verb}{s.arg && <> <code>{s.arg}</code></>}</span>
        <span className="sub">
          {s.extra && <span>{s.extra}</span>}
          {why && <span>{why}</span>}
          {a.tool && s.since !== undefined && <span>{a.tool.name} <span className="num">{duration(now - s.since)}</span></span>}
          {p && (
            <span className="mini">tasks <span className="num">{p.done} of {p.total}</span>
              <span className="bar ok" aria-hidden="true"><i style={{ width: `${(p.done / p.total) * 100}%` }} /></span>
            </span>
          )}
          {quote && <span className="quote" title={quote[1]}>{quote[0]} <span className="num">{quote[1]}</span></span>}
        </span>
      </span>
      <span className="m"><span className={`model ${model.tone}`} title={a.model}>{model.text}</span></span>
      <span className="tok r num">{readTokens(a.tokens)}</span>
      <span className="cost r num">{usd(a.cost)}</span>
      <span className="facts"><span className={`model ${model.tone}`}>{model.text}</span><span className="num">{readTokens(a.tokens)} tok</span><span className="num">{usd(a.cost)}</span></span>
      <span className={`state ${state}`}>{stateLabel(state)}</span>
    </div>
  );
}
