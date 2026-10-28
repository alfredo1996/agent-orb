import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Entry, type Item } from '../src/History.tsx';
import { Live, type Session } from '../src/Live.tsx';
import { claimReason, needs, rowCounts, rowState, sentence, type ClaimView } from '../src/live-cards.ts';

// Unbacked claims in the studio (v0.3 slice 4, #44; design/v0.3-worth-truth.html, the Unbacked claims board): the Live row, Needs you, the history drawer. The views are rendered to
// markup, which runs no effects: what is drawn from data is checked here.
const T = Date.parse('2026-10-27T14:03:00Z');
const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
const read = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

// The mock's reviewer: its last test run came before its last code edit.
const stale: ClaimView = { kind: 'test', phrase: 'all 48 tests pass', why: 'stale', ts: T - 1000, editTs: T - 60_000, runTs: T - 5 * 60_000 };
const agent = (o: object = {}) => ({ id: 'a1', type: 'reviewer', role: 'reviewer', depth: 1, parent: 'main', state: 'done', tokens: 310_000, cost: 0.52, startedAt: T - 8 * 60_000, lastTs: T - 1000, tasks: [], skills: [], calls: 9, failed: 1, model: 'claude-opus-5-5', ...o }) as any;
const session = (agents: any[], o: Partial<Session> = {}): Session =>
  ({ id: 's-1234567', project: 'mobile-app', branch: 'fix/upload-retries', host: 'mbp', startedAt: T - 22 * 60_000, lastTs: T, tokens: 2e6, cost: 2.2, costPartial: false, content: 'full', agents, ...o }) as Session;
const main = (o: object = {}) => agent({ id: 'main', type: 'main', role: 'orchestrator', depth: 0, parent: undefined, state: 'working', tool: { name: 'Agent', id: 't', since: T - 80_000, waiting: false }, ...o });

describe('claimReason', () => {
  it('says what the mock says: no run after the last code edit, at the edit\'s time', () => {
    expect(claimReason(stale)).toBe(`no test ran after its last code edit, at ${hhmm(stale.editTs!)}`);
    expect(claimReason({ ...stale, kind: 'build', why: 'no_run', runTs: undefined })).toBe(`no build ran after its last code edit, at ${hhmm(stale.editTs!)}`);
  });

  it('the drawer\'s long form names the run it did see: the last test run came before the code edit', () => {
    expect(claimReason(stale, true)).toBe(`the last test run (${hhmm(stale.runTs!)}) came before the code edit at ${hhmm(stale.editTs!)}`);
  });

  it('a last run that failed, and an edit with no write to the file named', () => {
    expect(claimReason({ ...stale, why: 'failed', runTs: T - 30_000 })).toBe(`its last test run (${hhmm(T - 30_000)}) failed, after its last code edit at ${hhmm(stale.editTs!)}`);
    expect(claimReason({ ...stale, why: 'failed', editTs: undefined, runTs: T - 30_000 })).toBe(`its last test run (${hhmm(T - 30_000)}) failed`);
    expect(claimReason({ kind: 'edit', phrase: 'I edited `plan.ts`', why: 'no_write', ts: T, file: 'src/lib/plan.ts' })).toBe('it never wrote src/lib/plan.ts');
  });
});

describe('the row and the tally', () => {
  it('a done agent with an unbacked claim reads "unbacked claim", and its row says what it said and why it does not hold', () => {
    const a = agent({ unbacked: [stale] });
    expect(rowState(a)).toBe('claim');
    expect(sentence(a, [], T)).toEqual({ verb: 'Said “all 48 tests pass”', extra: claimReason(stale), tone: 'bad' });
  });

  it('with more than one, the first is said and the rest counted', () => {
    expect(sentence(agent({ unbacked: [stale, { ...stale, kind: 'build', phrase: 'typecheck is clean' }] }), [], T).extra).toBe(`${claimReason(stale)} · 1 more unbacked`);
  });

  it('a main agent that answered and waits for the next prompt has it too; an agent at work, in a stall or in a permission wait keeps its own state', () => {
    expect(rowState(main({ state: 'waiting', waitingFor: 'prompt', tool: undefined, unbacked: [stale] }))).toBe('claim');
    expect(rowState(main({ unbacked: [stale] }))).toBe('working');
    expect(rowState(agent({ state: 'stalled', unbacked: [stale] }))).toBe('stalled');
    expect(rowState(agent({ state: 'waiting', waitingFor: 'permission', unbacked: [stale] }))).toBe('waiting');
  });

  it('is its own count in the tally, and nobody counts twice', () => {
    expect(rowCounts([agent({ unbacked: [stale] }), agent({ id: 'a2' }), main()])).toEqual({ working: 1, model: 0, waiting: 0, stalled: 0, done: 1, claim: 1 });
  });
});

describe('Needs you', () => {
  const list = (agents: any[]) => needs([{ id: 's-1', agents }] as any);

  it('lists the agent with what it said and why, since its answer', () => {
    expect(list([main(), agent({ unbacked: [stale] })])).toEqual([
      { session: 's-1', agent: 'a1', type: 'reviewer', tone: 'claim', since: stale.ts, claim: { phrase: 'all 48 tests pass', reason: claimReason(stale) } },
    ]);
  });

  it('comes after what blocks you and before the pricier models', () => {
    const blocked = agent({ id: 'b', type: 'Explore', state: 'waiting', waitingFor: 'permission', tool: { name: 'Bash', id: 't', since: T, waiting: true } });
    const pricier = agent({ id: 'p', state: 'working', pricier: { allowed: 'sonnet', source: 'file' } });
    expect(list([pricier, agent({ id: 'c', unbacked: [stale] }), blocked]).map((n) => [n.agent, n.tone])).toEqual([['b', 'wait'], ['c', 'claim'], ['p', 'model']]);
  });

  it('nothing for a backed answer, or for an agent at work again', () => {
    expect(list([agent(), main({ unbacked: [stale] })])).toEqual([]);
  });
});

describe('Live, drawn', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  afterEach(() => vi.unstubAllGlobals());
  const live = (s: Session) => renderToStaticMarkup(createElement(Live, { list: [s], all: { [s.id]: s }, now: T }));

  it('the mock\'s board: the reviewer\'s row is red with its claim and reason, Needs you says it in a line, the sentence on top counts it', () => {
    const html = live(session([main(), agent({ id: 'impl', type: 'implementer', role: 'developer', model: 'claude-sonnet-5-5' }), agent({ unbacked: [stale] })]));
    expect(read(html)).toContain('1 session is running: 1 is working. Nothing is stalled. 1 agent has an unbacked claim.');
    const need = /<div class="need">.*?<\/div>/s.exec(html)![0];
    expect(need).toContain('<span class="state claim">unbacked claim</span>');
    expect(read(need)).toContain(`reviewer in mobile-app said all 48 tests pass; no test ran after its last code edit, at ${hhmm(stale.editTs!)}`);
    expect(read(need)).toContain('1s'); // since its answer
    const row = html.split('<div class="agent').find((r) => r.includes('is-claim'))!;
    expect(row).toContain('<span class="state claim">unbacked claim</span>');
    expect(read(row)).toContain(`Said “all 48 tests pass” no test ran after its last code edit, at ${hhmm(stale.editTs!)}`);
    expect(html.match(/is-claim/g)).toHaveLength(1); // only the reviewer's row
  });

  it('a board with no unbacked claim has no claim in its tally and no claim line in Needs you', () => {
    const html = live(session([main(), agent()]));
    expect(html).not.toContain('t-claim');
    expect(html).not.toContain('state claim');
    expect(html).not.toContain('class="card needs"');
  });

  it('a session without Content on full says its claims were not checked, never that they are clean', () => {
    const chip = />claims not checked<\/span>/;
    for (const content of ['off', 'excluded', undefined] as const) expect(live(session([main()], { content }))).toMatch(chip);
    expect(live(session([main()], { content: 'full' }))).not.toMatch(chip);
    const board = live(session([main()], { content: 'off' }));
    expect(read(board.slice(0, board.indexOf('How to read Live')))).not.toMatch(/\bclean\b|0 unbacked/); // the explanations below say "never clean"; the board does not say it
  });
});

describe('the history drawer\'s claim', () => {
  const entry = (it: Item) => renderToStaticMarkup(createElement('ol', null, createElement(Entry, { it, now: T })));
  const claim = (o: Partial<Extract<Item, { kind: 'claim' }>> = {}): Item => ({ kind: 'claim', ts: stale.ts, claim: 'test', backed: false, phrase: 'all 48 tests pass', why: 'stale', editTs: stale.editTs, runTs: stale.runTs, ...o });

  it('an unbacked one is a red line with the words it used and the run it saw against the edit', () => {
    const html = entry(claim());
    expect(html).toContain('<li class="fail">');
    expect(read(html)).toContain(`Unbacked claim ✗ test claim “all 48 tests pass”: the last test run (${hhmm(stale.runTs!)}) came before the code edit at ${hhmm(stale.editTs!)}`);
    expect(html).toContain('class="res bad"');
  });

  it('a backed one is a green line', () => {
    const html = entry(claim({ backed: true, why: undefined, editTs: undefined, runTs: undefined }));
    expect(html).not.toContain('class="fail"');
    expect(read(html)).toMatch(/Claim ✓ test claim backed “all 48 tests pass” $/); // nothing more to say
  });

  it('an edit claim names the file it never wrote', () => {
    expect(read(entry(claim({ claim: 'edit', why: 'no_write', file: 'src/lib/plan.ts', phrase: 'Fixed the totals in `src/lib/plan.ts`', editTs: undefined, runTs: undefined })))).toContain(
      '✗ edit claim “Fixed the totals in `src/lib/plan.ts`”: it never wrote src/lib/plan.ts');
  });
});
