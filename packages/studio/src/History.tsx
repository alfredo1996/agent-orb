import { useEffect, useRef, useState, type KeyboardEvent as ReactKey } from 'react';
import { createPortal } from 'react-dom';
import { duration, modelLabel, stateLabel, tokens, usd } from './format.ts';
import { groupRuns, prettyInput, splitRedacted, type Run } from './history-format.ts';
import { agentName, claimReason, type ClaimView } from './live-cards.ts';

// One agent's history (design/pages.html, §15): what it did, what failed and its tasks, from GET /api/history, refreshed
// while it is open. A drawer on the right of the window, a bottom sheet on a phone; Live and the Office draw it over the page with a scrim.

export type Item =
  | { kind: 'task'; ts: number; text?: string; length?: number }
  | { kind: 'prompt'; ts: number; text?: string; length?: number }
  | { kind: 'step'; ts: number; model?: string; tokens?: number; answer?: string; thinking?: string }
  | { kind: 'tool'; ts: number; id: string; tool: string; input?: string; output?: string; output_skipped?: 'env-file'; success?: boolean; error_type?: string; duration_ms?: number }
  // v0.3 slice 4 (#44): a test, build or edit claim in an answer, and whether the agent's own calls back it (`why` and the times only when they do not)
  | { kind: 'claim'; ts: number; claim: ClaimView['kind']; backed: boolean; phrase?: string; why?: ClaimView['why']; file?: string; editTs?: number; runTs?: number };
type Data = { content: 'off' | 'full' | 'excluded'; agent: { id: string; type?: string; role?: string; model?: string }; items: Item[] };
export type Picked = { session: string; agent: string };
type LiveAgent = {
  type: string; role?: string; model?: string; tokens: number; cost: number; state: string; startedAt: number; lastTs: number;
  calls: number; failed: number; tasks: { id: string; subject: string; status: string }[];
};

export type Open = (session: string, agent: string, from: HTMLElement) => void;
export const rowKey = (session: string, agent: string) => `${session}:${agent}`; // the data-row of the control that opens an agent's history

/** Phones get the history as a bottom sheet instead of a side drawer. Keep the query equal to the CSS breakpoint (@container 700px). */
function usePhone() {
  const query = '(max-width: 700px)';
  const [phone, setPhone] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
}

/**
 * What every view that opens an agent's history shares: which agent is picked, the drawer with its scrim, and focus going back to
 * what opened it. `drawer` goes anywhere in the view's JSX; it renders into the body, outside the frame, because the frame's
 * containment would pin a fixed drawer to the frame instead of the window.
 */
export function useHistory(all: Record<string, { project: string; agents: (LiveAgent & { id: string })[] }>, now: number) {
  const [picked, setPicked] = useState<Picked>();
  const opener = useRef<HTMLElement>(null);
  const phone = usePhone();
  const open: Open = (session, agent, from) => {
    opener.current = from;
    setPicked({ session, agent });
  };
  // Focus goes back to what opened the history, or to the agent's row when that control went away (a Needs you line that cleared).
  const close = () => {
    const back = opener.current?.isConnected ? opener.current : picked && document.querySelector<HTMLElement>(`[data-row="${rowKey(picked.session, picked.agent)}"]`);
    setPicked(undefined);
    back?.focus();
  };
  const live = picked && all[picked.session]?.agents.find((a) => a.id === picked.agent);
  const drawer = picked && createPortal(
    <>
      <div className="scrim" onClick={close} aria-hidden="true" />
      <History key={rowKey(picked.session, picked.agent)} picked={picked} project={all[picked.session]?.project} now={now} live={live}
        label={live && stateLabel(live.state)} sheet={phone} onClose={close} />
    </>,
    document.body,
  );
  return { picked, open, drawer };
}

const REFRESH_MS = 5_000;
const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 8);
const ARGS_SHOWN = 4;

const Masked = ({ text }: { text: string }) => (
  <>{splitRedacted(text).map((p, i) => (p.masked ? <span key={i} className="redact">{p.text}</span> : p.text))}</>
);

type Tab = 'did' | 'failed' | 'tasks';

export function History({ picked, project, live, label, now, sheet, onClose }: {
  picked: Picked; project?: string; live?: LiveAgent; label?: string; now: number; sheet?: boolean; onClose: () => void;
}) {
  const [data, setData] = useState<Data>();
  const [error, setError] = useState<string>();
  const [chosen, setTab] = useState<Tab>('did');
  const drawer = useRef<HTMLElement>(null);
  useEffect(() => {
    let on = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/history?${new URLSearchParams(picked)}`);
        if (!res.ok) throw new Error(res.status === 404 ? 'This agent is not in the graph yet.' : `The server answered ${res.status}.`);
        const body = (await res.json()) as Data;
        if (on) setData(body), setError(undefined);
      } catch (e) {
        if (on) setError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [picked.session, picked.agent]);
  // Focus lands on the drawer, not on Close: a Space that opened it would otherwise end on the button's key-up and shut it again.
  useEffect(() => drawer.current?.focus(), []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [onClose]);

  // aria-modal tells a screen reader the page behind is inert; this keeps Tab from walking into it. The drawer itself counts as
  // "before the first" (focus lands on it), so Shift+Tab from there wraps to the last control as well.
  const trap = (e: ReactKey<HTMLElement>) => {
    if (e.key !== 'Tab') return;
    const box = drawer.current!;
    const els = [...box.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'));
    const first = els[0], last = els[els.length - 1];
    if (!first || !last) return e.preventDefault();
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === box)) last.focus(), e.preventDefault();
    else if (!e.shiftKey && at === last) first.focus(), e.preventDefault();
  };

  const model = modelLabel(live?.model ?? data?.agent.model);
  const items = data?.items ?? [];
  const failed = items.filter((i): i is Extract<Item, { kind: 'tool' | 'claim' }> => (i.kind === 'tool' && i.success === false) || (i.kind === 'claim' && !i.backed));
  const steps = items.filter((i) => i.kind === 'step');
  const noThinking = data?.content === 'full' && steps.length > 0 && !steps.some((s) => s.kind === 'step' && s.thinking);
  const tasks = live?.tasks ?? [];
  const done = tasks.filter((t) => t.status === 'completed').length;
  const tabs: { key: Tab; text: string; n: number | string }[] = [
    { key: 'did', text: 'What it did', n: items.length },
    { key: 'failed', text: 'Failed', n: failed.length },
    ...(tasks.length ? [{ key: 'tasks' as const, text: 'Tasks', n: `${done}/${tasks.length}` }] : []),
  ];
  const tab = tabs.some((t) => t.key === chosen) ? chosen : 'did'; // the tasks can vanish while the tab is open
  const shown = tab === 'did' ? groupRuns(items) : failed;
  const type = agentName(live?.type ?? data?.agent.type ?? picked.agent);
  const role = live?.role ?? data?.agent.role;

  return (
    <aside ref={drawer} tabIndex={-1} className={sheet ? 'drawer sheet' : 'drawer'} role="dialog" aria-modal="true" aria-labelledby="d-name" onKeyDown={trap}>
      <div className="dh">
        <div className="r1">
          <span className={`av ${model.tone || 'other'}`} aria-hidden="true">{type[0]!.toUpperCase()}</span>
          <h3 id="d-name">{type}</h3>
          {live && <span className={`state ${live.state}`}>{label ?? live.state}</span>}
          <button type="button" className="x" aria-label="Close the history" onClick={onClose}>×</button>
        </div>
        <div className="dfacts">
          {role && <span>{role}</span>}
          <span className={`model ${model.tone}`}>{model.text}</span>
          {project && <span>{project}</span>}
          {live ? (
            <>
              <span>started {clock(live.startedAt)}</span>
              <span>{duration((live.state === 'done' ? live.lastTs : now) - live.startedAt)}</span>
              <span>{live.calls} tool call{live.calls === 1 ? '' : 's'}</span>
              <span>{live.failed} failed</span>
              <span className="num">{tokens(live.tokens)} tok</span>
              <span className="num">{usd(live.cost)}</span>
            </>
          ) : <span>session {picked.session.slice(0, 6)}</span>}
        </div>
      </div>

      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} id={`htab-${t.key}`} type="button" role="tab" aria-selected={tab === t.key} aria-controls="hpanel" onClick={() => setTab(t.key)}>{t.text} <span className="n">{t.n}</span></button>
        ))}
      </div>
      <div className="dbody" id="hpanel" role="tabpanel" aria-labelledby={`htab-${tab}`}>
        {error && <p className="dnote">{error}</p>}
        {data?.content === 'off' && (
          <div className="note">
            <b>Content is off.</b>
            <span>This shows tools, timings and tokens, not prompts, answers or thinking, and its claims are not checked. To see them, set <code>content: full</code> in the plugin config, or <code>pluginConfigs.agent-orb.options.content</code> in <code>~/.claude/settings.json</code>. Projects in <code>excludeProjects</code> never send content.</span>
          </div>
        )}
        {data?.content === 'excluded' && <p className="dnote">This project is in excludeProjects: metadata only, and its claims are not checked.</p>}
        {tab === 'did' && noThinking && <p className="dnote">Thinking was not shared by Claude Code in this session (it sends thinking redacted unless thinking summaries are on).</p>}
        {tab === 'failed' && !failed.length && data && <p className="dnote">Nothing failed.</p>}
        {tab === 'tasks' ? (
          <ul className="tasklist">
            {tasks.map((t) => (
              <li key={t.id} className={t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'now' : undefined}>
                <span className="mk">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'}</span><span>{t.subject}</span>
              </li>
            ))}
          </ul>
        ) : (
          <ol className="tl2">
            {[...shown].reverse().map((it, i) => <Entry key={i} it={it} now={now} />)}
          </ol>
        )}
      </div>
    </aside>
  );
}

/** One line of the timeline, newest first: what it was asked, what it thought and answered, each tool or run of tools. */
export function Entry({ it, now }: { it: Item | Run; now: number }) {
  if (it.kind === 'run') {
    const more = it.args.length - ARGS_SHOWN;
    return (
      <li><span className="ts">{clock(it.ts)}</span><div className="w">
        <span className="lbl"><span className="tool">{it.tool} ×{it.count}</span><span className="res ok">✓</span></span>
        {it.args.length > 0 && <span className="arg">{it.args.slice(0, ARGS_SHOWN).join(' · ')}{more > 0 ? ` · +${more}` : ''}</span>}
      </div></li>
    );
  }
  if (it.kind === 'task' || it.kind === 'prompt') {
    return (
      <li><span className="ts">{clock(it.ts)}</span><div className="w">
        <span className="lbl">{it.kind === 'task' ? 'Task' : 'You asked'}</span>
        {it.text ? <div className="prose"><Masked text={it.text} /></div> : <span className="arg">{it.length ?? 0} characters, not captured</span>}
      </div></li>
    );
  }
  if (it.kind === 'step') {
    if (!it.thinking && !it.answer) return null; // a step that only called tools shows as its tools
    return (
      <li><span className="ts">{clock(it.ts)}</span><div className="w">
        {it.thinking && <><span className="lbl">Thinking</span><div className="prose think"><Masked text={it.thinking} /></div></>}
        {it.answer && <><span className="lbl">Answered <span className="d">{modelLabel(it.model).text} · {tokens(it.tokens ?? 0, true)} tok</span></span><div className="prose"><Masked text={it.answer} /></div></>}
      </div></li>
    );
  }
  if (it.kind === 'claim') {
    const view: ClaimView | undefined = it.backed || !it.why ? undefined : { kind: it.claim, phrase: it.phrase ?? '', why: it.why, ts: it.ts, file: it.file, editTs: it.editTs, runTs: it.runTs };
    return (
      <li className={it.backed ? undefined : 'fail'}><span className="ts">{clock(it.ts)}</span><div className="w">
        <span className="lbl"><span className="tool">{it.backed ? 'Claim' : 'Unbacked claim'}</span><span className={it.backed ? 'res ok' : 'res bad'}>{it.backed ? `✓ ${it.claim} claim backed` : `✗ ${it.claim} claim`}</span></span>
        <span className={it.backed ? 'arg' : 'arg err'}>{it.phrase && <>“<Masked text={it.phrase} />”</>}{view && <>: {claimReason(view, true)}</>}</span>
      </div></li>
    );
  }
  const running = it.success === undefined;
  return (
    <li className={it.success === false ? 'fail' : undefined}><span className="ts">{clock(it.ts)}</span><div className="w">
      <span className="lbl">
        <span className="tool">{it.tool}</span>
        {running ? <span className="res run">running {duration(now - it.ts)}</span>
          : <span className={it.success ? 'res ok' : 'res bad'}>{it.success ? '✓' : '✗'} {duration(it.duration_ms ?? 0)}{it.error_type ? ` · ${it.error_type}` : ''}</span>}
      </span>
      {it.input && <pre className="arg"><Masked text={prettyInput(it.input)} /></pre>}
      {it.output && <pre className={it.success === false ? 'arg err' : 'arg'}><Masked text={it.output} /></pre>}
      {it.output_skipped === 'env-file' && <span className="arg">Contents not sent: .env files never leave the machine.</span>}
    </div></li>
  );
}
