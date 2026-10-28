import { contextMeter, stateLabel, tokens, usd } from './format.ts';
import { rowKey, useHistory, type Open, type Picked } from './History.tsx';
import { Explain, PageHeader, Tally } from './kit.tsx';
import type { Session } from './Live.tsx';
import { officeLayout, type Room, type Seat } from './office.ts';

// The Office (PROJECT.md §8.4), drawn as approved in design/office.html: pixel bots drawn in code, coloured by model.

// The bot, 12×12: k ink, a antenna (its colour is the state), c the model's colour, w white, e an eye.
const BOT = [
  '....kk......', '....ak......', '..kkkkkkkk..', '.kcccccccck.', '.kcwwccwwck.', '.kcweccweck.',
  '.kcccccccck.', '.kcckkkkcck.', '.kcccccccck.', '..kkkkkkkk..', '.kcccccccck.', 'kcccccccccck',
];
const FILL: Record<string, string> = { k: 'var(--px-ink)', a: 'var(--ant)', c: 'currentColor', w: '#ffffff', e: 'var(--px-ink)' };
const CLASS: Record<string, string | undefined> = { a: 'ant', e: 'eye' };

// A bubble's glyph is drawn in pixels like the bot: SVG text at this size would be under 12px on screen.
const BUBBLE: Partial<Record<Seat['activity'], { glyph: string[]; fill: string; ink: string }>> = {
  thinking: { glyph: ['##.##.##', '##.##.##'], fill: 'var(--px-bubble)', ink: 'var(--px-ink)' },
  waiting: { glyph: ['.###.', '#...#', '....#', '..##.', '..#..', '.....', '..#..'], fill: 'var(--wait-line)', ink: '#ffffff' },
  stalled: { glyph: ['##', '##', '##', '##', '..', '##'], fill: 'var(--bad-line)', ink: '#ffffff' },
  done: { glyph: ['......#', '.....##', '#...##.', '##.##..', '.###...', '..#....'], fill: 'var(--ok)', ink: '#ffffff' },
  error: { glyph: ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'], fill: 'var(--bad-line)', ink: '#ffffff' },
};
const colour = (model: string) => (model === 'other' ? 'var(--faint)' : `var(--${model})`);

export function Office({ sessions, all, now }: { sessions: Session[]; all: Record<string, Session>; now: number }) {
  const { picked, open, drawer } = useHistory(all, now);
  const rooms = officeLayout(sessions, now).filter((r) => r.seats.length);
  const seats = rooms.flatMap((r) => r.seats);
  const count = (state: Seat['state']) => seats.filter((s) => s.state === state).length;
  return (
    <main className="office">
      <PageHeader title="Your floor" sub={<Tally items={[
        ['working', `${rooms.length} room${rooms.length === 1 ? '' : 's'} busy`],
        ['data', `${seats.length} bot${seats.length === 1 ? '' : 's'}`],
        ['stalled', `${count('stalled')} stalled`],
        ['waiting', `${count('waiting')} waiting for you`],
      ]} />} />
      {!rooms.length && (
        <div className="empty">
          <b>The floor is empty.</b>
          <span>Start Claude Code with the agent-orb plugin: each project gets a room, each agent a desk.</span>
        </div>
      )}
      <Defs />
      <div className="rooms">
        {rooms.map((r) => <RoomCard key={r.project} room={r} picked={picked} onOpen={open} />)}
      </div>
      {drawer}
      {rooms.length > 0 && (
        <section className="card">
          <Explain summary="How to read the office">
            <span className="key">
              <span><b>Colour</b> = model: <span style={{ color: 'var(--opus)' }}>■</span> Opus <span style={{ color: 'var(--sonnet)' }}>■</span> Sonnet <span style={{ color: 'var(--haiku)' }}>■</span> Haiku</span>
              <span><b>Screen</b>: code = typing (Edit, Write, Bash) · page = reading (Read, Grep, Glob) · globe = browsing (Web*)</span>
              <span><b>Bubble</b>: … thinking · ? waiting for you · ! stalled · ✓ done (leaves soon) · × error</span>
              <span><b>Dotted line</b>: a delegation, from the parent's desk to the new bot</span>
              <span><b>Cost</b> is API-equivalent: what a room's tokens would cost at API list prices, not what a plan bills.</span>
            </span>
          </Explain>
        </section>
      )}
    </main>
  );
}

/** The sprite and the floor tile, once per page; every room's scene points at them. */
const Defs = () => (
  <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
    <defs>
      <symbol id="orb-bot" viewBox="0 0 12 12" overflow="visible">
        {BOT.flatMap((row, y) => [...row].map((ch, x) => ch !== '.' && (
          <rect key={`${x},${y}`} x={x} y={y} width="1" height="1" fill={FILL[ch]} className={CLASS[ch]} />
        )))}
      </symbol>
      <pattern id="orb-floor" width="12" height="12" patternUnits="userSpaceOnUse">
        <rect width="12" height="12" fill="var(--px-floor)" /><rect width="6" height="6" fill="var(--px-floor2)" /><rect x="6" y="6" width="6" height="6" fill="var(--px-floor2)" />
      </pattern>
    </defs>
  </svg>
);

/** Where a seat's parts sit, from its desk's top-left corner (x, y): the mockup's measurements. */
const geometry = (s: Seat) => {
  const size = s.lead ? 30 : 24;
  const bx = s.x + 6;
  const by = s.y - size + 1;
  const deskW = size + 22;
  return { size, bx, by, deskW, cx: s.x + deskW / 2, mx: s.x + size + 5, my: s.y - 12 };
};

function RoomCard({ room, picked, onOpen }: { room: Room; picked?: Picked; onOpen: Open }) {
  const { width: w, height: h } = room;
  const at = new Map(room.seats.map((s) => [s.key, geometry(s)]));
  const ctx = contextMeter(room.contextPercent);
  return (
    <section className="card room" aria-label={`Room ${room.project}`}>
      <div className="roomh">
        <h2>{room.project}</h2>
        <span className="nums">
          <span><b>{tokens(room.tokens)}</b> tok</span>
          <span><b>{usd(room.cost, room.costPartial)}</b></span>
          <span className="ctx">
            context
            <span className={ctx?.near ? 'bar warn' : 'bar'} aria-hidden="true"><i style={{ width: `${ctx?.fill ?? 0}%` }} /></span>
            <b>{ctx ? `${ctx.percent}%` : '—'}</b>
            {ctx?.near && <span className="near">near the limit</span>}
          </span>
        </span>
      </div>
      <svg className="scene" viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" role="img"
        aria-label={`The ${room.project} room: ${room.seats.length} bot${room.seats.length === 1 ? '' : 's'} at desks`}>
        <rect width={w} height={h} fill="url(#orb-floor)" />
        <rect width={w} height="24" fill="var(--px-wall)" /><rect y="24" width={w} height="3" fill="var(--px-wall2)" />
        <rect x={w - 48} y="5" width="30" height="14" fill="var(--px-window)" /><rect x={w - 33.5} y="5" width="1.5" height="14" fill="var(--px-wall2)" />
        <rect x="8" y={h - 22} width="8" height="9" fill="var(--px-pot)" /><rect x="5" y={h - 34} width="14" height="12" fill="var(--px-plant)" /><rect x="9" y={h - 38} width="6" height="5" fill="var(--px-plant)" />
        <rect x={w - 18} y={h - 36} width="11" height="22" fill="var(--px-cooler)" /><rect x={w - 16} y={h - 42} width="7" height="7" fill="var(--px-water)" />
        {room.lines.map((l) => {
          const a = at.get(l.from), b = at.get(l.to);
          if (!a || !b) return null;
          const [x1, y1, x2, y2] = [a.cx - 11, a.by + a.size + 13, b.bx + b.size / 2, b.by + 1];
          return <path key={l.to} className="deleg" d={`M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`}
            fill="none" stroke="var(--accent)" strokeWidth="1.2" strokeDasharray="3 3" />;
        })}
        {room.seats.map((s) => <Desk key={s.key} s={s} />)}
      </svg>
      <ul className="roster">
        {room.seats.map((s) => {
          const name = s.lead ? 'main' : s.label;
          return (
            <li key={s.key}>
              <button type="button" className="rrow" data-row={rowKey(s.session, s.agent)} aria-expanded={picked?.session === s.session && picked.agent === s.agent}
                aria-label={`${name}, ${stateLabel(s.state)}. ${s.caption}. Open its history`} onClick={(e) => onOpen(s.session, s.agent, e.currentTarget)}>
                <span className={`av ${s.model}`} aria-hidden="true">{name[0]!.toUpperCase()}</span>
                <span className="w"><b>{name}</b><small>{s.caption}</small></span>
                <span className={`state ${s.state}`}>{stateLabel(s.state)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Desk({ s }: { s: Seat }) {
  const { size, bx, by, deskW, mx, my } = geometry(s);
  const hands = s.activity === 'typing' || s.activity === 'browsing' || s.activity === 'delegating';
  return (
    <g className={`seat ${s.activity}`}>
      <title>{`${s.label}: ${s.caption}`}</title>
      <g className={`bot ${s.activity}`} style={{ color: colour(s.model) }}>
        <use href="#orb-bot" x={bx} y={by} width={size} height={size} />
        {hands && <g className="hands"><rect x={bx + 4} y={s.y + 1} width="5" height="2" fill="var(--px-ink)" /><rect x={bx + size - 9} y={s.y + 1} width="5" height="2" fill="var(--px-ink)" /></g>}
      </g>
      <rect x={s.x} y={s.y} width={deskW} height="8" fill="var(--px-desk)" />
      <rect x={s.x} y={s.y + 8} width={deskW} height="3" fill="var(--px-desk2)" />
      <rect x={s.x + 2} y={s.y + 11} width="3" height="7" fill="var(--px-desk2)" />
      <rect x={s.x + deskW - 5} y={s.y + 11} width="3" height="7" fill="var(--px-desk2)" />
      <rect x={mx} y={my} width="15" height="11" fill="var(--px-ink)" />
      <rect x={mx + 1} y={my + 1} width="13" height="8" fill="var(--px-screen)" />
      <rect x={mx + 6} y={my + 11} width="3" height="1" fill="var(--px-ink)" />
      <Screen activity={s.activity} mx={mx} my={my} />
      <Bubble activity={s.activity} x={bx + size - 4} y={by - 13} />
    </g>
  );
}

/** The speech bubble over a bot (x, y: its top-left corner, 14×11 with a tail), its glyph centred in pixels. */
function Bubble({ activity, x, y }: { activity: Seat['activity']; x: number; y: number }) {
  const b = BUBBLE[activity];
  if (!b) return null;
  const gx = x + Math.floor((14 - b.glyph[0]!.length) / 2), gy = y + Math.floor((11 - b.glyph.length) / 2);
  return (
    <g className={`bubble ${activity === 'thinking' ? 'think' : activity}`}>
      <rect x={x} y={y} width="14" height="11" rx="3" fill={b.fill} />
      <rect x={x + 3} y={y + 11} width="3" height="3" fill={b.fill} />
      <g className="glyph" fill={b.ink}>
        {b.glyph.flatMap((row, j) => [...row].map((ch, i) => ch === '#' && <rect key={`${i},${j}`} x={gx + i} y={gy + j} width="1" height="1" />))}
      </g>
    </g>
  );
}

/** The monitor: code while typing, a page while reading, a globe while browsing; dark otherwise. */
function Screen({ activity, mx, my }: { activity: Seat['activity']; mx: number; my: number }) {
  if (activity === 'typing' || activity === 'delegating') {
    return <g className="scr code">{[8, 5, 10].map((w, i) => <rect key={i} className="line" x={mx + 2} y={my + 2 + i * 2} width={w} height="1" fill="var(--px-code)" />)}</g>;
  }
  if (activity === 'reading') {
    return <g><rect x={mx + 4} y={my + 2} width="7" height="6" fill="#ffffff" />{[0, 1, 2].map((i) => <rect key={i} x={mx + 5} y={my + 3 + i * 1.6} width="5" height="0.8" fill="#99aaaa" />)}</g>;
  }
  if (activity === 'browsing') {
    return <g><circle cx={mx + 7.5} cy={my + 5} r="3" fill="none" stroke="var(--px-code)" strokeWidth="0.8" /><line x1={mx + 4.5} y1={my + 5} x2={mx + 10.5} y2={my + 5} stroke="var(--px-code)" strokeWidth="0.7" /></g>;
  }
  return null;
}
