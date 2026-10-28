// How Analysis writes a model's price in its select (design/pages.html): "Opus 5.5 · $4 / $20".

/** Dollars per million tokens: whole dollars without cents ($4), anything else with two decimals ($0.10). */
const perMillion = (n: number) => {
  const t = n.toFixed(2);
  return `$${t.endsWith('.00') ? t.slice(0, -3) : t}`;
};

/** The server prices 1k tokens; the select shows a million, input / output. */
export const modelOption = (m: { label: string; costPer1k: { input: number; output: number } }) =>
  `${m.label} · ${perMillion(m.costPer1k.input * 1000)} / ${perMillion(m.costPer1k.output * 1000)}`;
