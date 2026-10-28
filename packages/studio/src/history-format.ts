// How the history drawer writes tool input and masked text (design/content.html).

/** A JSON object as `key: value` lines, strings unquoted; anything else as given. */
export function prettyInput(s: string) {
  try {
    const o = JSON.parse(s) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return s;
    return Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
  } catch {
    return s;
  }
}

/** The text in pieces, each [REDACTED] its own piece, so the mask can be drawn as a chip. */
export const splitRedacted = (s: string) =>
  s.split(/(\[REDACTED\])/).filter(Boolean).map((text) => ({ text, masked: text === '[REDACTED]' }));

// Live v2: a run of the same tool that succeeded reads as one line (Read ×6 · a.ts · b.ts …).
const ARG = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'path', 'skill', 'description'];
const argOf = (input?: string) => {
  try {
    const o = JSON.parse(input ?? '') as Record<string, unknown>;
    const k = ARG.find((x) => typeof o[x] === 'string' && o[x]);
    if (!k) return undefined;
    const v = String(o[k]);
    return k.endsWith('path') ? v.split('/').pop()! : v;
  } catch {
    return undefined;
  }
};
type ToolItem = { kind: 'tool'; ts: number; tool: string; success?: boolean; input?: string };
export type Run = { kind: 'run'; ts: number; tool: string; count: number; args: string[] };

/** Consecutive successful calls of one tool become one run; a failure, a running call or another item breaks it. */
export function groupRuns<I extends { kind: string; ts: number }>(items: I[]): (I | Run)[] {
  const out: (I | Run)[] = [];
  let run: (I & ToolItem)[] = [];
  const flush = () => {
    if (run.length > 1) out.push({ kind: 'run', ts: run[0]!.ts, tool: run[0]!.tool, count: run.length, args: run.map((r) => argOf(r.input)).filter((x): x is string => !!x) });
    else out.push(...run);
    run = [];
  };
  for (const it of items) {
    const t = it as I & ToolItem;
    if (t.kind === 'tool' && t.success === true && (!run.length || run[0]!.tool === t.tool)) run.push(t);
    else {
      flush();
      if (t.kind === 'tool' && t.success === true) run.push(t);
      else out.push(it);
    }
  }
  flush();
  return out;
}
