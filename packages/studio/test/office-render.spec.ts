import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Office } from '../src/Office.tsx';

// The Office screen, rendered to markup (#16): the header tally, a room's figures and roster, the empty floor. Invented project; no DOM library.
const NOW = 1_800_000_000_000;
const read = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const agent = (o: object): any => ({ id: 'main', depth: 0, type: 'main', tokens: 0, lastTs: NOW, startedAt: NOW - 60_000, state: 'working', tasks: [], ...o });
const session = (id: string, project: string, agents: object[], o: object = {}): any =>
  ({ id, project, host: 'laptop', startedAt: NOW - 60_000, lastTs: NOW, tokens: 412_000, cost: 3.5, costPartial: false, contextPercent: 85, agents, ...o });
const render = (sessions: any[]) => renderToStaticMarkup(createElement(Office, { sessions, all: Object.fromEntries(sessions.map((s) => [s.id, s])), now: NOW }));

let error: ReturnType<typeof vi.spyOn>, warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  expect(error).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the Office screen', () => {
  const busy = [session('s1', 'garden-app', [
    agent({ model: 'claude-opus-5-5', tool: { name: 'Bash', id: 't', since: NOW - 42_000, waiting: false } }),
    agent({ id: 'a1', depth: 1, parent: 'main', type: 'reviewer', model: 'claude-sonnet-5-5', state: 'waiting', waitingFor: 'prompt' }),
    agent({ id: 'a2', depth: 1, parent: 'main', type: 'Explore', model: 'claude-haiku-5-5', state: 'stalled' }),
    agent({ id: 'a3', depth: 1, parent: 'main', type: 'tester', model: 'claude-haiku-5-5', state: 'stalled' }),
  ])];

  it('says what the floor holds: rooms, bots, stalled and waiting counts', () => {
    const text = read(render(busy));
    expect(text).toContain('Your floor');
    expect(text).toContain('1 room busy');
    expect(text).toContain('4 bots');
    expect(text).toContain('2 stalled');
    expect(text).toContain('1 waiting for you');
  });

  it('a room shows its project, tokens, API-equivalent cost and a context meter near the limit', () => {
    const html = render(busy);
    expect(html).toContain('aria-label="Room garden-app"');
    expect(read(html)).toContain('412k tok');
    expect(read(html)).toContain('$3.50');
    expect(read(html)).toContain('85% near the limit');
    expect(html).toContain('class="bar warn"');
    expect(html).toContain('style="width:85%"');
  });

  it('the roster names each bot with its state, its caption and what pressing it does', () => {
    const html = render(busy);
    expect(html).toContain('aria-label="main, working. Bash 42s. Open its history"');
    expect(html).toContain('aria-label="reviewer, waiting for you. your prompt. Open its history"');
    expect(html).toContain('aria-label="Explore, stalled. thinking. Open its history"');
    expect(html).toContain('data-row="s1:a1"');
    expect(html).toContain('class="av sonnet"');
    expect(html).toContain('<title>reviewer: your prompt</title>');
  });

  it('the scene says how many bots sit at desks, singular for one', () => {
    expect(render(busy)).toContain('aria-label="The garden-app room: 4 bots at desks"');
    const one = render([session('s2', 'solo', [agent({})], { contextPercent: undefined })]);
    expect(one).toContain('aria-label="The solo room: 1 bot at desks"');
    expect(read(one)).toContain('1 room busy');
    expect(read(one)).toContain('context — ');
    expect(one).not.toContain('near the limit');
  });

  it('an empty floor says so and offers no legend', () => {
    const html = render([]);
    expect(read(html)).toContain('The floor is empty. Start Claude Code with the agent-orb plugin');
    expect(read(html)).toContain('0 rooms busy');
    expect(read(html)).toContain('0 bots');
    expect(html).not.toContain('How to read the office');
  });

  it('with a room, the legend explains the colours', () => {
    expect(read(render(busy))).toContain('How to read the office');
  });
});
