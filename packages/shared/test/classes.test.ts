import { describe, expect, it } from 'vitest';
import { COMMAND_CLASSES, ERROR_CLASSES, Event, NAMED_SHAPES, commandClass, errorClass, errorShape, filesTouched, firstLine } from '../src/index.ts';
import { COMMANDS, ERRORS, OTHER_SHAPE, SAME_SHAPE, SHAPES } from './class-tables.ts';

// v0.3 slice 1 (#43): the short classes that let a failed call and a Bash call be told apart without any of their text leaving the machine.
// The tables are in class-tables.ts; a mod copy of both classifiers is held to the same rows by packages/mod/test/contract.spec.ts.

describe('commandClass', () => {
  for (const [cls, command] of COMMANDS) {
    it(`${cls}: ${JSON.stringify(command.slice(0, 90))}`, () => {
      expect(commandClass(command)).toBe(cls);
    });
  }

  it('answers only with a class the schema accepts', () => {
    for (const [, command] of COMMANDS) expect(COMMAND_CLASSES).toContain(commandClass(command));
  });

  it('is linear: a long script and a long line classify at once', () => {
    const script = `${'echo line\n'.repeat(20_000)}pnpm test`;
    const t0 = Date.now();
    expect(commandClass(script)).toBe('test');
    expect(commandClass('a'.repeat(200_000))).toBe('other');
    expect(commandClass(`"${'x &&'.repeat(50_000)}`)).toBe('other'); // an unterminated quote
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('errorClass', () => {
  for (const [cls, tool, text, denied] of ERRORS) {
    it(`${cls}: ${tool}${denied ? ' (denied)' : ''} ${JSON.stringify(text.slice(0, 70))}`, () => {
      expect(errorClass(tool, text, denied)).toBe(cls);
    });
  }

  it('answers only with a class the schema accepts', () => {
    for (const [, tool, text, denied] of ERRORS) expect(ERROR_CLASSES).toContain(errorClass(tool, text, denied));
  });

  it('reads only the start of the text, however long it is', () => {
    const t0 = Date.now();
    expect(errorClass('Bash', `Exit code 1\n${'x'.repeat(5_000_000)}`)).toBe('exit_code');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('a failing test run is an exit_code, whatever the command says it was', () => {
    const text = 'Exit code 1\n FAIL  packages/server/test/ingest.test.ts\n  Error: ENOENT: no such file or directory, open \'x\'';
    expect(commandClass('pnpm -C /x test')).toBe('test');
    expect(errorClass('Bash', text)).toBe('exit_code');
  });
});

describe('errorShape (v0.3 slice 3, #45)', () => {
  for (const [expected, tool, text, command] of SHAPES) {
    it(`${expected ?? 'no shape'}: ${tool} ${JSON.stringify(text.slice(0, 70))}`, () => {
      expect(errorShape(tool, text, command)).toBe(expected);
    });
  }

  it('the table has a row for every named pattern, and no more than the ones it lists', () => {
    expect(NAMED_SHAPES).toEqual(['sleep_blocked', 'hook_blocked', 'wrong_tool_name', 'gh_projects_classic', 'classifier_denied', 'user_rejected', 'safety_check', 'deny_rule', 'outside_worktree']);
    for (const id of NAMED_SHAPES) expect(SHAPES.filter(([shape]) => shape === id).length).toBeGreaterThan(0);
  });

  it.each(SAME_SHAPE.map(([a, b]) => [a[2].slice(0, 50), a, b] as const))('one shape, whatever the path, number, quote or spacing: %j', (_label, a, b) => {
    const shape = errorShape(a[1], a[2], a[3]);
    expect(shape).toMatch(/^h:[0-9a-f]{8}$/);
    expect(errorShape(b[1], b[2], b[3])).toBe(shape);
  });

  it.each(OTHER_SHAPE.map(([a, b]) => [a[2].slice(0, 50), a, b] as const))('two shapes: %j', (_label, a, b) => {
    expect(errorShape(a[1], a[2], a[3])).toMatch(/^h:[0-9a-f]{8}$/);
    expect(errorShape(b[1], b[2], b[3])).not.toBe(errorShape(a[1], a[2], a[3]));
  });

  it('answers only a shape the schema accepts, and keeps no word of the text', () => {
    for (const [, tool, text, command] of SHAPES) {
      const shape = errorShape(tool, text, command);
      if (shape !== undefined) expect(shape).toMatch(/^(?:[a-z_]+|h:[0-9a-f]{8})$/);
    }
  });

  it('the line a shape is made of: the first that is not empty, an exit code or tags alone, with its tags dropped', () => {
    expect(firstLine('Exit code 1\n\n  <tool_use_error>  \nFAIL x\nmore')).toBe('FAIL x');
    expect(firstLine('<tool_use_error>String to replace not found</tool_use_error>')).toBe('String to replace not found');
    expect(firstLine('Exit code 1')).toBeUndefined();
    expect(firstLine('Exit code 1 and more')).toBe('Exit code 1 and more'); // an exit code line is the whole line
    expect(firstLine(`${'\n'.repeat(1000)}late`)).toBeUndefined(); // only the start is read
  });

  it('reads only the start of the text, and is linear on a long line of word characters', () => {
    const t0 = Date.now();
    expect(errorShape('Bash', `Exit code 1\n${'x'.repeat(5_000_000)}`, 'other')).toMatch(/^h:/);
    expect(errorShape('Bash', 'a'.repeat(1000))).toMatch(/^h:/); // the path pattern backtracks on a word with no slash
    expect(errorShape('Bash', `${'a/'.repeat(500)}`)).toMatch(/^h:/);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('the schema takes the classes', () => {
  const base = { v: 1, id: '00000000-0000-4000-8000-000000000001', ts: 1, host: 'h', user_id: 'u', session_id: 's', project: { cwd: '/r', name: 'r' } };

  it('a tool.call may carry a command_class and a tool.result an error_class, and every class is accepted', () => {
    for (const command_class of COMMAND_CLASSES) {
      const e = Event.parse({ ...base, kind: 'tool.call', data: { tool_use_id: 't', tool: 'Bash', input_size: 3, command_class } });
      expect(e.kind === 'tool.call' && e.data.command_class).toBe(command_class);
    }
    for (const error_class of ERROR_CLASSES) {
      const e = Event.parse({ ...base, kind: 'tool.result', data: { tool_use_id: 't', success: false, duration_ms: 1, output_size: 0, files_touched: [], error_class } });
      expect(e.kind === 'tool.result' && e.data.error_class).toBe(error_class);
    }
  });

  it('a failed tool.result may carry an error_shape: a named one or an h: and 8 hex digits, and nothing else (v0.3 slice 3)', () => {
    const result = (error_shape: unknown) => Event.safeParse({ ...base, kind: 'tool.result', data: { tool_use_id: 't', success: false, duration_ms: 1, output_size: 0, files_touched: [], error_class: 'refused', error_shape } });
    for (const ok of ['sleep_blocked', 'wrong_tool_name', 'h:a0038b0f', 'h:00000000']) {
      const e = result(ok);
      expect(e.success && e.data.kind === 'tool.result' && e.data.data.error_shape).toBe(ok);
    }
    for (const bad of ['', 'Sleep_Blocked', 'sleep-blocked', 'h:a0038b0', 'h:a0038b0f1', 'h:A0038B0F', 'h:g0038b0f', 'H:a0038b0f', 'sleep blocked', 'h:']) expect(result(bad).success).toBe(false);
    expect(Event.safeParse({ ...base, kind: 'tool.result', data: { tool_use_id: 't', success: true, duration_ms: 1, output_size: 0, files_touched: [] } }).success).toBe(true); // optional
  });

  it('both are optional, and a class outside the lists is refused (a 400 for the batch, not a free-text column)', () => {
    expect(Event.safeParse({ ...base, kind: 'tool.call', data: { tool_use_id: 't', tool: 'Read', input_size: 3 } }).success).toBe(true);
    expect(Event.safeParse({ ...base, kind: 'tool.call', data: { tool_use_id: 't', tool: 'Bash', input_size: 3, command_class: 'make' } }).success).toBe(false);
    expect(Event.safeParse({ ...base, kind: 'tool.result', data: { tool_use_id: 't', success: false, duration_ms: 1, output_size: 0, files_touched: [], error_class: 'oops' } }).success).toBe(false);
  });
});

describe('filesTouched', () => {
  const root = '/Users/a/mobile-app';
  it.each([
    ['Read', { file_path: `${root}/src/a.ts` }, [{ path: 'src/a.ts', mode: 'read' }]],
    ['Edit', { file_path: `${root}/src/a.ts`, old_string: 'x' }, [{ path: 'src/a.ts', mode: 'write' }]],
    ['Write', { file_path: `${root}/README.md` }, [{ path: 'README.md', mode: 'write' }]],
    ['MultiEdit', { file_path: `${root}/src/b.ts` }, [{ path: 'src/b.ts', mode: 'write' }]],
    ['NotebookEdit', { notebook_path: `${root}/nb.ipynb` }, [{ path: 'nb.ipynb', mode: 'write' }]],
    ['Read', { file_path: '/Users/a/other/a.ts' }, []], // outside the project
    ['Read', { file_path: `${root}-2/a.ts` }, []], // a sibling that shares the prefix
    ['Read', { file_path: 'src/a.ts' }, []], // not absolute
    ['Read', {}, []],
    ['Grep', { path: `${root}/src` }, []], // not a file tool
    ['Bash', { command: `cat ${root}/src/a.ts` }, []],
  ] as const)('%s %j', (tool, input, expected) => {
    expect(filesTouched(tool, input, root)).toEqual(expected);
  });
});
