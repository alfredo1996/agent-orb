import type { Event } from '@agent-orb/shared';
import { describe, expect, it } from 'vitest';
import { contentRows, openContentStore } from '../src/content-store.ts';

// The text store (§15, 2026-10-20): captured text lives in SQLite, keyed by the graph's own ids.
const T = 1_792_600_000_000;
let n = 0;
const base = { v: 1, host: 'mbp', user_id: 'x', session_id: 's1', project: { cwd: '/r', name: 'agent-orb', git_remote: 'github.com/o/agent-orb' } };
const ev = (kind: string, data: object, extra: object = {}) =>
  ({ ...base, id: `00000000-0000-4000-b000-${String(++n).padStart(12, '0')}`, ts: T + n, kind, data, ...extra }) as Event;
const usage = { input: 1, output: 1, cache_read: 0, cache_creation: 0 };

describe('contentRows: which text goes where, by the ids the graph uses', () => {
  it('maps each content field to its graph node', () => {
    const step = ev('turn.step', { model: 'm', usage, stop_reason: 'end_turn', tool_use_ids: [], answer: 'Done.', thinking: 'Hmm.' }, { turn_id: 't' });
    const rows = contentRows([
      ev('prompt.submit', { length: 3, text: 'fix' }, { prompt_id: 'p1' }),
      ev('agent.spawn', { tool_use_id: 'ta', agent_type: 'Explore', model: 'm', prompt_length: 4, prompt: 'Find' }, { agent_id: 'a1' }),
      step,
      ev('tool.call', { tool_use_id: 'tc', tool: 'Bash', input_size: 2, input: '{}' }),
      ev('tool.result', { tool_use_id: 'tc', success: true, duration_ms: 1, output_size: 2, files_touched: [], output: 'ok' }),
      ev('tool.result', { tool_use_id: 'te', success: true, duration_ms: 1, output_size: 2, files_touched: [], output_skipped: 'env-file' }),
      ev('session.start', { model: 'm', source: 's', claude_version: 'v', plugin_version: 'p', content: 'full' }),
    ]);
    expect(rows.map((r) => [r.node, r.id, r.field, r.body])).toEqual([
      ['prompt', 'p1', 'text', 'fix'],
      ['agent', 's1:a1', 'prompt', 'Find'],
      ['request', step.id, 'answer', 'Done.'],
      ['request', step.id, 'thinking', 'Hmm.'],
      ['tool', 'tc', 'input', '{}'],
      ['tool', 'tc', 'output', 'ok'],
    ]);
    expect(rows[0]).toMatchObject({ session_id: 's1', project: 'github.com/o/agent-orb' });
  });

  it('a metadata-only event gives no rows', () => {
    expect(contentRows([ev('tool.call', { tool_use_id: 'x', tool: 'Read', input_size: 9 })])).toEqual([]);
  });
});

describe('openContentStore', () => {
  const row = (id: string, field: string, body: string) => ({ node: 'tool' as const, id, field, body, session_id: 's1', project: 'p', ts: T });

  it('stores and reads back by node and id, all fields of one node together', () => {
    const store = openContentStore(':memory:');
    store.put([row('tc', 'input', '{"command":"ls"}'), row('tc', 'output', 'a\nb'), row('other', 'input', 'x')]);
    const got = store.get([{ node: 'tool', id: 'tc' }, { node: 'tool', id: 'missing' }]);
    expect(got.get('tool:tc')).toEqual({ input: '{"command":"ls"}', output: 'a\nb' });
    expect(got.has('tool:missing')).toBe(false);
    store.close();
  });

  it('a repeated row replaces the text, never duplicates it (retries are safe)', () => {
    const store = openContentStore(':memory:');
    store.put([row('tc', 'output', 'first')]);
    store.put([row('tc', 'output', 'first'), row('tc', 'output', 'second')]);
    expect(store.get([{ node: 'tool', id: 'tc' }]).get('tool:tc')).toEqual({ output: 'second' });
    store.close();
  });

  it('keeps its data in a file across opens', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const file = join(mkdtempSync(join(tmpdir(), 'orb-content-')), 'content.db');
    const a = openContentStore(file);
    a.put([row('tc', 'input', 'kept')]);
    a.close();
    const b = openContentStore(file);
    expect(b.get([{ node: 'tool', id: 'tc' }]).get('tool:tc')).toEqual({ input: 'kept' });
    b.close();
  });
});
