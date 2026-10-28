import { describe, expect, it } from 'vitest';
import { prettyInput, splitRedacted } from '../src/history-format.ts';

describe('history formats (design/content.html)', () => {
  it('shows a tool input as key: value lines, strings unquoted', () => {
    expect(prettyInput('{"pattern":"sprite|kenney","path":"design/","head_limit":20}')).toBe('pattern: sprite|kenney\npath: design/\nhead_limit: 20');
  });
  it('keeps nested values as JSON and anything unparsable as given', () => {
    expect(prettyInput('{"edits":[{"a":1}]}')).toBe('edits: [{"a":1}]');
    expect(prettyInput('not json {')).toBe('not json {');
    expect(prettyInput('[1,2]')).toBe('[1,2]');
  });
  it('splits text around every [REDACTED] so the mask can be drawn', () => {
    expect(splitRedacted('Bearer [REDACTED] and [REDACTED].')).toEqual([
      { text: 'Bearer ', masked: false }, { text: '[REDACTED]', masked: true }, { text: ' and ', masked: false },
      { text: '[REDACTED]', masked: true }, { text: '.', masked: false },
    ]);
    expect(splitRedacted('plain')).toEqual([{ text: 'plain', masked: false }]);
  });
});

describe('groupRuns (Live v2)', () => {
  it('folds a run of the same tool that succeeded into one line; a failure or another kind breaks the run', async () => {
    const { groupRuns } = await import('../src/history-format.ts');
    const tool = (ts: number, name: string, success: boolean | undefined, input?: string) => ({ kind: 'tool' as const, ts, id: `t${ts}`, tool: name, success, input });
    const items = [tool(1, 'Read', true, '{"file_path":"a.ts"}'), tool(2, 'Read', true, '{"file_path":"b.ts"}'), tool(3, 'Read', false, '{"file_path":"c.ts"}'),
      { kind: 'step' as const, ts: 4, answer: 'ok' }, tool(5, 'Edit', true), tool(6, 'Edit', true), tool(7, 'Edit', undefined)];
    expect(groupRuns(items).map((i: any) => (i.kind === 'run' ? `${i.tool}×${i.count}:${i.args.join(',')}` : `${i.kind}${i.tool ? `:${i.tool}` : ''}`)))
      .toEqual(['Read×2:a.ts,b.ts', 'tool:Read', 'step', 'Edit×2:', 'tool:Edit']);
  });
});
