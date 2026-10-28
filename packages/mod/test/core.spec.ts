import { describe, expect, it } from 'vitest';
import { CAP, enqueue, familyOf, filesTouched, hostName, modelCheck, modelFromFrontmatter, newOutbox, normalizeRemote, pricierNotice, rejectedIn, settle, takeBatch, type Ev } from '../hooks/core.ts';

let n = 0;
const ev = (ts = 1_000): Ev => ({ id: `e${++n}`, ts, kind: 'tool.call', session_id: 's' });

describe('outbox', () => {
  it('hands out at most 200 events, oldest first, and drops them once the server accepts', () => {
    const o = newOutbox();
    for (let i = 0; i < 250; i++) enqueue(o, ev(i + 1));
    const batch = takeBatch(o, 0)!;
    expect(batch).toHaveLength(200);
    expect(batch[0]!.ts).toBe(1);
    settle(o, batch.length, 200, 0);
    expect(o.queue).toHaveLength(50);
    expect(o.queue[0]!.ts).toBe(201);
  });

  it('keeps a batch the server did not take, and backs off before trying again', () => {
    const o = newOutbox();
    enqueue(o, ev());
    settle(o, 1, 500, 10_000);
    expect(o.queue).toHaveLength(1);
    expect(takeBatch(o, 10_001)).toBeNull();
    expect(takeBatch(o, 10_000 + 4_000)).toHaveLength(1);
    settle(o, 1, 0, 20_000); // network error
    expect(takeBatch(o, 20_000 + 4_000)).toBeNull(); // the wait doubles
    expect(takeBatch(o, 20_000 + 8_000)).toHaveLength(1);
  });

  it('never waits more than a minute between tries', () => {
    const o = newOutbox();
    enqueue(o, ev());
    for (let i = 0; i < 20; i++) settle(o, 1, 503, 0);
    expect(takeBatch(o, 60_000)).toHaveLength(1);
  });

  it('drops a batch the server rejects as invalid (400), and counts it', () => {
    const o = newOutbox();
    enqueue(o, ev());
    enqueue(o, ev());
    settle(o, 2, 400, 0);
    expect(o.queue).toHaveLength(0);
    expect(o.rejected).toBe(2);
    expect(takeBatch(o, 0)).toBeNull(); // nothing left, not a backoff
  });

  it('past the cap drops the oldest and counts them from the first drop', () => {
    const o = newOutbox();
    for (let i = 0; i < CAP + 3; i++) enqueue(o, ev(i + 1));
    expect(o.queue).toHaveLength(CAP);
    expect(o.queue[0]!.ts).toBe(4);
    expect(o.dropped).toBe(3);
    expect(o.droppedSince).toBe(CAP + 1);
  });

  // #97: the server takes 1 MB a request. 200 events of full content were about 39 MB, refused (413) and resent for ever.
  const full = (ts: number, text: string): Ev => ({ ...ev(ts), data: { input: text, output: text } });
  const bytes = (batch: Ev[]) => new TextEncoder().encode(JSON.stringify({ events: batch })).length;

  it('keeps a batch of full-content events under the server\'s 1 MB, counting multi-byte text, oldest first', () => {
    const o = newOutbox();
    for (let i = 0; i < 200; i++) enqueue(o, full(i + 1, '€'.repeat(32_768))); // capText's most, 3 bytes a character
    const batch = takeBatch(o, 0)!;
    expect(bytes(batch)).toBeLessThan(1_048_576);
    expect(batch.length).toBeGreaterThan(1);
    expect(batch.map((e) => e.ts)).toEqual(batch.map((_, i) => i + 1));
    settle(o, batch.length, 200, 0);
    expect(o.queue[0]!.ts).toBe(batch.length + 1);
  });

  it('sends an event bigger than the budget on its own, never an empty batch', () => {
    const o = newOutbox();
    enqueue(o, full(1, 'x'.repeat(300_000)));
    enqueue(o, ev(2));
    expect(takeBatch(o, 0)!.map((e) => e.ts)).toEqual([1]);
  });

  it('drops a batch the server refuses as too large (413), and counts it, instead of resending it for ever', () => {
    const o = newOutbox();
    enqueue(o, ev());
    settle(o, 1, 413, 0);
    expect(o.queue).toHaveLength(0);
    expect(o.rejected).toBe(1);
    expect(takeBatch(o, 0)).toBeNull();
  });

  // #114: the server takes a batch's valid events and says how many it refused, in a 200.
  it('a 2xx that refused some events drops the batch and counts the refused ones', () => {
    const o = newOutbox();
    for (let i = 0; i < 3; i++) enqueue(o, ev(i + 1));
    settle(o, 3, 200, 0, 2);
    expect(o.queue).toHaveLength(0);
    expect(o.rejected).toBe(2);
    expect(o.failures).toBe(0);
  });

  it('counts no more refused events than the batch held', () => {
    const o = newOutbox();
    enqueue(o, ev());
    settle(o, 1, 200, 0, 5);
    expect(o.rejected).toBe(1);
  });
});

describe('rejectedIn: how many events a 2xx reply says were refused (#114)', () => {
  it.each([
    ['a count', '{"accepted":1,"duplicates":0,"rejected":2}', 2],
    ['none refused', '{"accepted":3,"duplicates":0,"rejected":0}', 0],
    ['an older server, no field', '{"accepted":3,"duplicates":0}', 0],
    ['an empty object', '{}', 0],
    ['not JSON', '<html>a proxy answered</html>', 0],
    ['a negative count', '{"rejected":-1}', 0],
    ['a fraction', '{"rejected":1.5}', 0],
    ['a string', '{"rejected":"2"}', 0],
    ['JSON null', 'null', 0],
  ])('%s', (_name, text, n) => {
    expect(rejectedIn(text)).toBe(n);
  });
});

describe('normalizeRemote', () => {
  it.each([
    ['https://github.com/alfredo1996/agent-orb.git', 'github.com/alfredo1996/agent-orb'],
    ['https://user:ghp_secret@github.com/alfredo1996/agent-orb', 'github.com/alfredo1996/agent-orb'],
    ['git@github.com:alfredo1996/agent-orb.git', 'github.com/alfredo1996/agent-orb'],
    ['ssh://git@gitlab.example.com:2222/team/repo.git', 'gitlab.example.com/team/repo'],
  ])('%s → %s', (url, want) => {
    expect(normalizeRemote(url)).toBe(want);
  });

  it('leaves no credentials behind', () => {
    expect(normalizeRemote('https://x-access-token:abc123@github.com/o/r')).not.toMatch(/abc123|x-access-token/);
  });

  it('is undefined without a remote', () => {
    expect(normalizeRemote(null)).toBeUndefined();
  });
});

describe('filesTouched', () => {
  const root = '/repo';
  it('reads for Read, writes for Edit/Write/NotebookEdit, project-relative', () => {
    expect(filesTouched('Read', { file_path: '/repo/src/a.ts' }, root)).toEqual([{ path: 'src/a.ts', mode: 'read' }]);
    expect(filesTouched('Edit', { file_path: '/repo/src/a.ts' }, root)).toEqual([{ path: 'src/a.ts', mode: 'write' }]);
    expect(filesTouched('Write', { file_path: '/repo/b.md' }, root)).toEqual([{ path: 'b.md', mode: 'write' }]);
    expect(filesTouched('NotebookEdit', { notebook_path: '/repo/n.ipynb' }, root)).toEqual([{ path: 'n.ipynb', mode: 'write' }]);
  });

  it('keeps nothing outside the project, and nothing for other tools', () => {
    expect(filesTouched('Read', { file_path: '/Users/me/.ssh/id_rsa' }, root)).toEqual([]);
    expect(filesTouched('Read', { file_path: '/repository/x' }, root)).toEqual([]);
    expect(filesTouched('Bash', { command: 'cat /repo/a' }, root)).toEqual([]);
  });
});

import { checkStalls, newTracker, statusText, type Tracker } from '../hooks/core.ts';

const MIN = 60_000;
const tracker = (): Tracker => {
  const t = newTracker();
  t.agents.set('main', { key: 'main', label: 'main', inTurn: true, lastTs: 0, done: false, tokens: 412_000 });
  t.agents.set('a1', { key: 'a1', label: 'Explore', inTurn: true, lastTs: 0, done: false, tokens: 31_400 });
  return t;
};

describe('checkStalls', () => {
  it('flags a tool past the threshold once, and ends the stall when the tool returns', () => {
    const t = tracker();
    t.agents.get('main')!.inTurn = false; // main waits at the prompt while a1 works
    t.tools.set('toolu_1', { id: 'toolu_1', tool: 'WebFetch', agent: 'a1', since: 0, waiting: false });
    expect(checkStalls(t, 14 * MIN, 15 * MIN).started).toEqual([]);
    const first = checkStalls(t, 15 * MIN, 15 * MIN);
    expect(first.started).toEqual([{ key: 'toolu_1', agent: 'a1', tool_use_id: 'toolu_1', tool: 'WebFetch', since: 0 }]);
    expect(checkStalls(t, 16 * MIN, 15 * MIN).started).toEqual([]); // not again
    t.tools.delete('toolu_1');
    t.agents.get('a1')!.lastTs = 16 * MIN;
    expect(checkStalls(t, 16 * MIN, 15 * MIN).ended.map((s) => s.key)).toEqual(['toolu_1']);
  });

  it('never flags a tool waiting at the permission prompt', () => {
    const t = tracker();
    t.agents.get('main')!.inTurn = false; // main waits at the prompt while a1 works
    t.tools.set('toolu_2', { id: 'toolu_2', tool: 'Bash', agent: 'a1', since: 0, waiting: true });
    expect(checkStalls(t, 60 * MIN, 15 * MIN).started).toEqual([]);
  });

  it('never flags an agent that is not mid-turn (it waits for your prompt)', () => {
    const t = tracker();
    t.agents.get('main')!.inTurn = false;
    t.agents.get('a1')!.done = true;
    expect(checkStalls(t, 60 * MIN, 15 * MIN).started).toEqual([]);
  });

  it('flags an agent silent mid-turn with no tool running, and ends it on its next event', () => {
    const t = tracker();
    t.agents.get('main')!.lastTs = 20 * MIN;
    const { started } = checkStalls(t, 20 * MIN, 15 * MIN);
    expect(started).toEqual([{ key: 'agent:a1', agent: 'a1', since: 0 }]);
    t.agents.get('a1')!.lastTs = 21 * MIN;
    expect(checkStalls(t, 21 * MIN, 15 * MIN).ended.map((s) => s.key)).toEqual(['agent:a1']);
  });

  it('an agent with a tool still inside the threshold is not silent', () => {
    const t = tracker();
    t.agents.get('main')!.lastTs = 20 * MIN;
    t.tools.set('toolu_3', { id: 'toolu_3', tool: 'Bash', agent: 'a1', since: 10 * MIN, waiting: false });
    expect(checkStalls(t, 20 * MIN, 15 * MIN).started).toEqual([]);
  });
});

describe('statusText', () => {
  it('counts the active agents, the session tokens and the context', () => {
    expect(statusText(tracker(), 61, 0)).toBe('👥 2 · 443k tok · ctx 61%');
  });

  it('names the oldest stall instead', () => {
    const t = tracker();
    t.tools.set('toolu_1', { id: 'toolu_1', tool: 'WebFetch', agent: 'a1', since: 0, waiting: false });
    checkStalls(t, 16 * MIN, 15 * MIN);
    expect(statusText(t, 61, 16 * MIN)).toBe('⚠ Explore: WebFetch 16m');
  });
});

describe('statusText, a pricier model (v0.2 slice 2)', () => {
  const implementer = { who: 'implementer', used: 'opus', allowed: 'sonnet', source: 'file' } as const;
  const workflow = { who: 'workflow agent', used: 'opus', allowed: 'sonnet', source: 'ceiling' } as const;

  it('names a pricier agent, and says whose limit it broke: its file or the ceiling', () => {
    const t = tracker();
    t.agents.get('a1')!.pricier = implementer;
    expect(statusText(t, 61, 6 * MIN)).toBe('⚠ implementer on Opus, file says Sonnet');
    t.agents.get('a1')!.pricier = workflow;
    expect(statusText(t, 61, 6 * MIN)).toBe('⚠ workflow agent on Opus, ceiling Sonnet');
  });

  it('names the oldest still-running one when several are pricier', () => {
    const t = tracker();
    t.agents.get('a1')!.pricier = implementer; // a1 appeared first
    t.agents.set('a2', { key: 'a2', label: 'general-purpose', inTurn: true, lastTs: 0, done: false, tokens: 0, pricier: workflow });
    expect(statusText(t, 61, 6 * MIN)).toBe('⚠ implementer on Opus, file says Sonnet');
    t.agents.get('a1')!.done = true; // a done agent no longer counts
    expect(statusText(t, 61, 6 * MIN)).toBe('⚠ workflow agent on Opus, ceiling Sonnet');
    t.agents.get('a2')!.done = true;
    expect(statusText(t, 61, 6 * MIN)).toBe('👥 1 · 443k tok · ctx 61%'); // done agents' tokens still count
  });

  it('a stall still comes first', () => {
    const t = tracker();
    t.agents.get('a1')!.pricier = implementer;
    t.tools.set('toolu_1', { id: 'toolu_1', tool: 'WebFetch', agent: 'a1', since: 0, waiting: false });
    checkStalls(t, 16 * MIN, 15 * MIN);
    expect(statusText(t, 61, 16 * MIN)).toBe('⚠ Explore: WebFetch 16m');
  });
});

describe('the model check (v0.2 slice 2)', () => {
  it('modelFromFrontmatter reads model: as written, from the frontmatter only', () => {
    expect(modelFromFrontmatter('---\nname: implementer\nmodel: sonnet\n---\nbody\nmodel: opus')).toBe('sonnet');
    expect(modelFromFrontmatter('---\nmodel: "claude-opus-4-8[1m]"\n---\n')).toBe('claude-opus-4-8[1m]');
    expect(modelFromFrontmatter("---\r\nmodel: 'haiku'\r\n---\r\n")).toBe('haiku');
    expect(modelFromFrontmatter('---\nmodel: inherit # follow the session\n---\n')).toBe('inherit');
    expect(modelFromFrontmatter('---\nname: scout\nskills:\n  - beta\n---\nmodel: opus')).toBeUndefined();
    expect(modelFromFrontmatter('no frontmatter\nmodel: opus')).toBeUndefined();
    expect(modelFromFrontmatter('---\nmodel:\n---\n')).toBeUndefined();
    expect(modelFromFrontmatter('---\nmetamodel: opus\n  model: opus\n---\n')).toBeUndefined(); // another key, and a nested one
  });

  it.each([
    ['opus', 'opus'], ['sonnet', 'sonnet'], ['haiku', 'haiku'], ['claude-sonnet-5-5', 'sonnet'], ['claude-opus-4-8[1m]', 'opus'],
    ['claude-haiku-5-5-20260901', 'haiku'], ['opus[1m]', 'opus'], ['Opus', 'opus'], ['claude-fable-5', 'fable'], ['mythos', 'mythos'],
    ['claude-3-5-sonnet-20241022', 'sonnet'], ['inherit', undefined], ['gpt-x', undefined], ['', undefined], [undefined, undefined],
  ])('familyOf(%s) is %s', (model, family) => {
    expect(familyOf(model)).toBe(family);
  });

  const check = (model: string, declared: string | undefined, ceiling = 'sonnet') => modelCheck({ model, declared, ceiling });

  it('a file\'s model is the limit: a pricier family is flagged, the same or a cheaper one is not', () => {
    expect(check('claude-opus-5-5', 'sonnet')).toEqual({ allowed: 'sonnet', source: 'file' });
    expect(check('claude-sonnet-5-5', 'haiku')).toEqual({ allowed: 'haiku', source: 'file' });
    expect(check('claude-sonnet-5-5', 'sonnet')).toBeUndefined();
    expect(check('claude-haiku-5-5', 'sonnet')).toBeUndefined();
    expect(check('claude-opus-5-5', 'claude-opus-4-8[1m]')).toBeUndefined(); // a full id and a version difference: the family rules
  });

  it('a file\'s limit holds whatever the ceiling says: a file that allows Opus is not held to Sonnet', () => {
    expect(check('claude-opus-5-5', 'opus')).toBeUndefined();
    expect(check('claude-opus-5-5', 'sonnet', 'opus')).toEqual({ allowed: 'sonnet', source: 'file' });
  });

  it('no file model, or inherit, is held to the ceiling', () => {
    expect(check('claude-opus-5-5', undefined)).toEqual({ allowed: 'sonnet', source: 'ceiling' });
    expect(check('claude-opus-5-5', 'inherit')).toEqual({ allowed: 'sonnet', source: 'ceiling' });
    expect(check('claude-opus-5-5', 'inherit', 'haiku')).toEqual({ allowed: 'haiku', source: 'ceiling' });
    expect(check('claude-opus-5-5', undefined, 'opus')).toBeUndefined();
    expect(check('claude-sonnet-5-5', undefined)).toBeUndefined();
    expect(check('claude-haiku-5-5', undefined)).toBeUndefined();
  });

  it('a ceiling of off checks nothing for such agents, but a file\'s model is still checked', () => {
    expect(check('claude-opus-5-5', undefined, 'off')).toBeUndefined();
    expect(check('claude-opus-5-5', 'inherit', 'off')).toBeUndefined();
    expect(check('claude-opus-5-5', 'sonnet', 'off')).toEqual({ allowed: 'sonnet', source: 'file' });
  });

  it('an unknown family is not checked: not the model that ran, not a declared one, not a mistyped ceiling', () => {
    expect(check('some-other-model', undefined)).toBeUndefined();
    expect(check('claude-opus-5-5', 'my-tuned-model')).toBeUndefined();
    expect(check('claude-opus-5-5', undefined, 'sonet')).toBeUndefined();
  });

  it('fable and mythos rank above opus, and equal to each other', () => {
    expect(check('claude-fable-5', undefined, 'opus')).toEqual({ allowed: 'opus', source: 'ceiling' });
    expect(check('mythos', 'opus')).toEqual({ allowed: 'opus', source: 'file' });
    expect(check('mythos', 'fable')).toBeUndefined();
    expect(check('fable', 'mythos')).toBeUndefined();
  });

  it('the notification says whose limit was broken; a workflow agent with no file is "a workflow agent"', () => {
    expect(pricierNotice({ who: 'implementer', used: 'opus', allowed: 'sonnet', source: 'file' })).toBe('implementer runs on Opus; its file says Sonnet');
    expect(pricierNotice({ who: 'workflow agent', used: 'opus', allowed: 'sonnet', source: 'ceiling' })).toBe('a workflow agent runs on Opus; agents with no file are held to Sonnet');
    expect(pricierNotice({ who: 'general-purpose', used: 'opus', allowed: 'haiku', source: 'ceiling' })).toBe('general-purpose runs on Opus; agents with no file are held to Haiku');
  });
});

// #107: the Mac's own name (LocalHostName), not whatever the network's DNS calls it (`hostname -s` while no HostName is set).
describe('hostName', () => {
  type Answer = { exitCode: number; stdout: string } | 'cannot start';
  const machine = (answers: Record<string, Answer>) => {
    const calls: string[] = [];
    const run = async (argv: readonly string[]) => {
      calls.push(argv.join(' '));
      const a = answers[argv.join(' ')] ?? 'cannot start';
      if (a === 'cannot start') throw new Error(`spawn ${argv[0]} ENOENT`);
      return a;
    };
    return { run, calls };
  };
  const SCUTIL = 'scutil --get LocalHostName';
  const HOSTNAME = 'hostname -s';

  it('on macOS is scutil\'s LocalHostName, trimmed, whatever `hostname -s` says on this network', async () => {
    const m = machine({ [SCUTIL]: { exitCode: 0, stdout: 'Alfredos-MacBook-Pro-4\n' }, [HOSTNAME]: { exitCode: 0, stdout: 'Host-009\n' } });
    expect(await hostName(m.run, 'darwin')).toBe('Alfredos-MacBook-Pro-4');
    expect(m.calls).toEqual([SCUTIL]);
  });

  it('on macOS falls back to `hostname -s` when scutil exits non-zero, prints nothing, or cannot start', async () => {
    for (const scutil of [{ exitCode: 1, stdout: 'LocalHostName: not set\n' }, { exitCode: 0, stdout: '\n' }, 'cannot start'] as Answer[]) {
      const m = machine({ [SCUTIL]: scutil, [HOSTNAME]: { exitCode: 0, stdout: 'mbp\n' } });
      expect(await hostName(m.run, 'darwin')).toBe('mbp');
      expect(m.calls).toEqual([SCUTIL, HOSTNAME]);
    }
  });

  it('off macOS is `hostname -s`, and scutil is never run', async () => {
    for (const platform of ['linux', '']) {
      const m = machine({ [SCUTIL]: { exitCode: 0, stdout: 'Not-A-Linux-Name\n' }, [HOSTNAME]: { exitCode: 0, stdout: 'nas\n' } });
      expect(await hostName(m.run, platform)).toBe('nas');
      expect(m.calls).toEqual([HOSTNAME]);
    }
  });

  it('is empty when no command answers, so the caller\'s fallback name stands', async () => {
    expect(await hostName(machine({}).run, 'darwin')).toBe('');
    expect(await hostName(machine({ [HOSTNAME]: { exitCode: 1, stdout: '' } }).run, 'linux')).toBe('');
  });
});
