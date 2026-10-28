// How the Live view writes numbers, as in the approved mockup (design/live.html).

/** Compact for headers (412k, 86.4k); `precise` gives rows one decimal (198.0k). */
export const tokens = (n: number, precise = false) =>
  n >= 999_950 ? `${(n / 1e6).toFixed(1)}M`
  : n >= 1_000 ? (precise || n < 100_000 ? `${(n / 1_000).toFixed(1)}k` : `${Math.round(n / 1_000)}k`)
  : String(n);

/**
 * Tokens as a person says them, with the unit apart (Live, #101): `4.9 M`, `312 k`, `8.1 B`. A non-breaking space keeps the number with its unit.
 * `words`: the unit spelled out for a sentence (#102): `8.1 billion`.
 */
export const readTokens = (n: number, words = false) => {
  const [v, unit, word] =
    n >= 1e9 ? [(n / 1e9).toFixed(1), 'B', 'billion']
    : n >= 1e6 ? [n >= 1e8 ? String(Math.round(n / 1e6)) : (n / 1e6).toFixed(1), 'M', 'million']
    : n >= 1e3 ? [String(Math.round(n / 1e3)), 'k', 'thousand']
    : [String(n), '', ''];
  return !unit ? v : words ? `${v} ${word}` : `${v}\u00a0${unit}`;
};

/**
 * API-equivalent dollars. Exact zero reads `$0.00`; anything above zero but under a cent reads `<$0.01`, so spent-nothing
 * and spent-a-little differ. A partial total (some tokens had no price, §13) is a floor, `≥ $0.71`; under a cent it stays
 * `≥ $0.00`: "at least less than a cent" says nothing.
 */
export const usd = (n: number, partial = false) =>
  partial ? `≥ $${n.toFixed(2)}` : n === 0 ? '$0.00' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;

/** `1 day`, `0 days`, `5 days`. */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`.replace(/ 0(\ds)$/, ' $1');
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

export const ago = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};

/** `claude-opus-5-5` → Opus 5.5 with its badge colour; anything else as given. */
export const modelLabel = (id?: string) => {
  const m = id && /claude-(opus|sonnet|haiku)-(\d+)-(\d+)/.exec(id);
  if (m) return { text: `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}`, tone: m[1]! };
  return { text: id || '—', tone: '' };
};


/** Both waits (a permission, a prompt) read the same to the person; the row's sentence says which. `model` is the model check's state and `claim` an unbacked claim's (live-cards.ts rowState). */
export const stateLabel = (state: string) => (state === 'waiting' ? 'waiting for you' : state === 'model' ? 'pricier model' : state === 'claim' ? 'unbacked claim' : state);

/** A context window as a meter: the rounded percent to show, how much of the track to fill (never past it), amber from 80%. */
export const contextMeter = (percent?: number) => {
  if (percent === undefined) return undefined;
  const p = Math.round(percent);
  return { percent: p, fill: Math.min(p, 100), near: p >= 80 };
};
