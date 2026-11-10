import { Fragment } from 'react';
import { STAGES, STAGE_LABEL, titlesNote, type BoardData, type BoardIssue } from './Factory.tsx';
import { modelLabel } from './format.ts';
import type { Said } from './kit.tsx';
import type { Session } from './Live.tsx';
import { agentName, DELEGATES } from './live-cards.ts';
import { layoutMap } from './map-layout.ts';

// The Map (v0.5 slice 1, #66; the plan is #64), drawn as approved in design/home-issue.html, the Map board: a second view of the Factory board, for the same project and milestone. The board's
// issues are cards, each in the column of its stage, over the lines that tie them, from GET /api/links: solid where a session on each wrote the same file, amber while both are unmerged
// ("in flight together": the second to merge may conflict), dashed where one's text mentions the other. Pressing a card keeps its links and fades the rest, and the list under the map follows.
// On a phone the Map is that list. Nothing here acts on a session or an issue: it is read only.

/** Two issues wrote the same file: `files` are up to three of them, `count` all of them, `together` while neither issue is merged. `a` is the lower number. */
export type FileLink = { kind: 'file'; a: number; b: number; files: string[]; count: number; together: boolean };
/** The text of issue `a` mentions issue `b`. */
export type MentionLink = { kind: 'mention'; a: number; b: number };
export type IssueLink = FileLink | MentionLink;
/** GET /api/links: the links between the issues GET /api/board shows for `milestone`. */
export type LinksData = { project: string; milestone: string | null; links: IssueLink[] };

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const list = (numbers: number[]) => numbers.map((n) => `#${n}`).join(', ').replace(/, (#\d+)$/, ' and $1');
const MARK_WORDS = { bad: 'stalled', wait: 'waits on you', ok: 'ready' };
const hot = (l: IssueLink) => l.kind === 'file' && l.together;

/**
 * Who is on an issue now and the card's mark, from what the page already reads: the sessions Live shows (a running one that reached the issue, by the board's own list) and the board's row.
 * The agent named is the one that needs you, else one that is working (a main agent that only waits on the agents it dispatched comes last). The mark is `bad` when an agent on the issue is
 * stalled, `wait` when one waits for your OK to run a tool (the two that Live's Needs you lists), `ok` when the issue's PR is ready for your ok.
 */
export function nowOn(issue: BoardIssue, sessions: readonly Session[]): { who?: { name: string; tone: string }; mark?: 'bad' | 'wait' | 'ok' } {
  const mine = new Set(issue.sessions.map((s) => s.id));
  const agents = sessions.filter((s) => !s.endedAt && mine.has(s.id)).flatMap((s) => s.agents).filter((a) => a.state !== 'done' && a.state !== 'error');
  const asks = (a: (typeof agents)[number]) => a.state === 'waiting' && a.waitingFor === 'permission';
  const rank = (a: (typeof agents)[number]) => (a.state === 'stalled' ? 0 : asks(a) ? 1 : a.state === 'working' && !(a.tool && DELEGATES.has(a.tool.name)) ? 2 : 3);
  const on = agents.toSorted((a, b) => rank(a) - rank(b) || b.lastTs - a.lastTs)[0];
  const mark = agents.some((a) => a.state === 'stalled') ? 'bad' : agents.some(asks) ? 'wait' : issue.ready ? 'ok' : undefined;
  return { ...(on ? { who: { name: agentName(on.type), tone: modelLabel(on.model).tone || 'other' } } : {}), ...(mark ? { mark } : {}) };
}

/** The links whose two issues are both on the board: an answer read a moment before or after the board's may name one that is not. */
const onBoard = (board: BoardData, links: readonly IssueLink[]) => {
  const shown = new Set(board.issues.map((i) => i.number));
  return links.filter((l) => shown.has(l.a) && shown.has(l.b));
};

/** The sentence on top of the Map, counted from the links: how many pairs in flight wrote the same files, which issues are in more than one, and which of them is ready for your ok. */
export function mapReading(board: BoardData, links: readonly IssueLink[]): Said {
  const all = onBoard(board, links);
  if (!all.length) return ['No issue here touches another: no file two of them wrote, and no mention.'];
  const pairs = all.filter(hot);
  if (!pairs.length) return [{ b: 'No two issues in flight wrote the same file.' }];
  const said: Said = [{ b: `${count(pairs.length, 'pair')} of issues in flight wrote the same files.` }];
  const times = new Map<number, number>();
  for (const l of pairs) for (const n of [l.a, l.b]) times.set(n, (times.get(n) ?? 0) + 1);
  const many = [...times].filter(([, k]) => k > 1).map(([n]) => n).sort((a, b) => a - b);
  const ready = board.issues.filter((i) => i.ready && times.has(i.number)).map((i) => i.number).sort((a, b) => a - b);
  const each = new Set(many.map((n) => times.get(n))).size === 1 ? String(times.get(many[0]!)) : 'more than one';
  const parts = [
    ...(many.length ? [`${list(many)} ${many.length === 1 ? 'is' : 'are each'} in ${each} of them`] : []),
    ...(ready.length ? [`${list(ready)} ${ready.length === 1 ? 'is' : 'are'} ready for your ok`] : []),
  ];
  if (parts.length) said.push(` ${parts.join(', and ')}.`);
  return said;
}

/** One link as a row of the list: the two issues, what ties them, and whether they are in flight together. */
function LinkRow({ link: l, titles }: { link: IssueLink; titles: ReadonlyMap<number, string | undefined> }) {
  const name = (n: number) => <><b>#{n}</b>{titles.get(n) ? ` ${titles.get(n)}` : ''}</>;
  return (
    <div className="mp-link">
      <span>{name(l.a)} <span className="sub">{l.kind === 'file' ? 'and' : 'mentions'}</span> {name(l.b)}</span>
      {l.kind === 'file'
        ? <span className="sub">Both wrote {l.files.map((f, i) => <Fragment key={f}>{i > 0 && ', '}<code>{f}</code></Fragment>)}{l.count > l.files.length && ` and ${l.count - l.files.length} more`}</span>
        : <span className="sub">In #{l.a}'s text</span>}
      {hot(l) ? <span className="flag left">In flight together</span> : <span />}
    </div>
  );
}

/**
 * The Map band. `board` is the page's own read of GET /api/board and `links` its read of GET /api/links for the same milestone (none yet: the cards show and the list waits; `error`: the read
 * failed, and the last answer, if any, stays). `boardError`: the board's own read failed after a good one, and the last good cards stay. `sessions` are the ones Live shows, for the agent on each issue. `picked` is the pressed card, which the page holds; one that has left the board
 * is no longer pressed. `phone`: only the list.
 */
export function MapBand({ board, links, error, boardError, sessions, picked, onPick, phone }: {
  board: BoardData; links?: LinksData; error?: string; boardError?: string; sessions: readonly Session[]; picked?: number; onPick: (issue: number | undefined) => void; phone: boolean;
}) {
  const all = onBoard(board, links?.links ?? []);
  const sel = picked !== undefined && board.issues.some((i) => i.number === picked) ? picked : undefined;
  const touches = (l: IssueLink) => l.a === sel || l.b === sel;
  const dimmed = (l: IssueLink) => (sel !== undefined && !touches(l) ? ' dim' : '');
  const listed = sel === undefined ? all : all.filter(touches);
  const near = new Set(listed.flatMap((l) => [l.a, l.b]));
  const titles = new Map(board.issues.map((i) => [i.number, i.title]));
  const inside = board.issues.filter((i) => !i.outside).length;
  const outside = board.issues.length - inside;
  const note = titlesNote(board);
  const map = phone || !board.issues.length ? undefined : layoutMap(STAGES, board.issues, all, sel);
  return (
    <section className="card map" aria-labelledby="fmap-h">
      <h2 id="fmap-h">Map{board.milestone != null && ` · ${board.milestone}`} {board.issues.length > 0 && (
        <span className="hint">{board.milestone === null ? `${outside} in flight` : `${count(inside, 'issue')}${outside > 0 ? `, plus ${outside} in flight outside it` : ''}`}{links && ` · ${count(all.length, 'link')}`}</span>
      )}</h2>
      {boardError && <p className="nothing" role="alert">The board could not be read: {boardError}</p>}
      {error && <p className="nothing" role="alert">The links could not be read: {error}</p>}
      {!board.issues.length && <p className="nothing">{board.milestone !== null ? `No open issue in ${board.milestone}, and none in flight.` : 'No issue to map: no open issue has a milestone, and none is in flight.'}</p>}
      {map && (
        <>
          {/* The cards are HTML buttons over an SVG layer that draws the lines and the file names, as on Pipeline: a card's text never depends on drawn offsets. */}
          <div className="mp-scroll">
            <div className="mp" style={{ width: map.width, height: map.height }}>
              <svg width={map.width} height={map.height} aria-hidden="true">
                {map.edges.map(({ link: l, d }, i) => <path key={i} className={`mp-e ${hot(l) ? 'hot' : l.kind === 'file' ? 'file' : 'said'}${dimmed(l)}`} d={d} />)}
                {/* the names after every line, each on a patch of the card's own colour, so a line that runs under a name is cut by it and never crosses it out */}
                {map.edges.map(({ link: l, label }, i) => label && (
                  <g key={i}>
                    <rect className={`elbg${dimmed(l)}`} x={(label.anchor === 'middle' ? label.x - label.w / 2 : label.x) - 3} y={label.y - 11} width={label.w + 6} height={15} rx={3} />
                    <text className={`el${dimmed(l)}`} x={label.x} y={label.y} textAnchor={label.anchor}>{label.text}</text>
                  </g>
                ))}
              </svg>
              {STAGES.map((s, c) => <span key={s} className="mp-colt" style={{ left: map.cols[c]!.x }}><span>{STAGE_LABEL[s]}</span><span className="num">{map.cols[c]!.count}</span></span>)}
              {/* in the page in the order they sit, column by column and top to bottom, so Tab follows the eye */}
              {board.issues.filter((i) => map.pos.has(i.number)).toSorted((a, b) => map.pos.get(a.number)!.col - map.pos.get(b.number)!.col || map.pos.get(a.number)!.row - map.pos.get(b.number)!.row).map((i) => {
                const p = map.pos.get(i.number)!;
                const { who, mark } = nowOn(i, sessions);
                const say = mark && MARK_WORDS[mark]; // the mark is a colour: said in words for a screen reader and the tooltip
                const cls = ['mp-node', mark && `t-${mark}`, i.outside && 'out', sel !== undefined && sel !== i.number && !near.has(i.number) && 'dim'].filter(Boolean).join(' ');
                return (
                  <button key={i.number} type="button" className={cls} style={{ left: p.x, top: p.y }} data-issue={i.number} aria-pressed={sel === i.number} title={[i.title, say].filter(Boolean).join(', ') || undefined}
                    onClick={() => onPick(sel === i.number ? undefined : i.number)}>
                    <b>#{i.number}{i.title ? ` ${i.title}` : ''}</b>
                    <small>{who ? <span className={`model ${who.tone}`}>{who.name}</span> : 'No session'}{i.outside && ` · ${i.milestone ?? 'outside'}`}</small>
                    {say && <span className="sr">, {say}</span>}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mp-legend">
            <span><svg width="30" height="8" aria-hidden="true"><path className="mp-e file" d="M2 4H28" /></svg>both wrote a file</span>
            <span><svg width="30" height="8" aria-hidden="true"><path className="mp-e hot" d="M2 4H28" /></svg>and both are still unmerged</span>
            <span><svg width="30" height="8" aria-hidden="true"><path className="mp-e said" d="M2 4H28" /></svg>one mentions the other</span>
            <span><i className="out" />outside this milestone</span>
            <span><i className="bad" />stalled</span>
            <span><i className="wait" />waits on you</span>
            <span><i className="ok" />ready</span>
          </div>
        </>
      )}
      {!links && !error && board.issues.length > 0 && <p className="nothing">Reading the links…</p>}
      {links && board.issues.length > 0 && (
        <>
          <div className="mp-day">{sel === undefined ? `Every link · ${all.length}` : `Links of #${sel} · ${listed.length}`}</div>
          {listed.map((l) => <LinkRow key={`${l.kind}:${l.a}:${l.b}`} link={l} titles={titles} />)}
          {!listed.length && <div className="mp-none">{sel === undefined ? 'No issue here touches another: no file two of them wrote, and no mention.' : `#${sel} has no link to another issue.`}</div>}
        </>
      )}
      {note && <div className="bnote">{note}</div>}
    </section>
  );
}
