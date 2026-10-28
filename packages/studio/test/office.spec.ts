import { describe, expect, it } from 'vitest';
import { activityOf, officeLayout } from '../src/office.ts';

// The Office (design/office.html, PROJECT.md §8.4): what each bot is doing, and where it sits.
// Loose fixtures: only the fields each test is about.
const layout = (sessions: object[], now: number): any[] => officeLayout(sessions as never, now);
const agent = (o: object): any => ({ id: 'main', depth: 0, type: 'main', tokens: 0, cost: 0, lastTs: 0, startedAt: 0, state: 'working', ...o });
const tool = (name: string) => ({ name, id: 't', since: 0, waiting: false });

describe('activityOf', () => {
  it.each([
    ['Edit', 'typing'], ['Write', 'typing'], ['Bash', 'typing'], ['NotebookEdit', 'typing'],
    ['Read', 'reading'], ['Grep', 'reading'], ['Glob', 'reading'],
    ['WebFetch', 'browsing'], ['WebSearch', 'browsing'], ['mcp__Claude_Browser__navigate', 'browsing'],
    ['Agent', 'delegating'], ['Task', 'delegating'], ['Workflow', 'delegating'],
    ['mcp__neo4j__query', 'typing'],
  ])('a working agent running %s is %s', (name, want) => {
    expect(activityOf(agent({ tool: tool(name) }))).toBe(want);
  });

  it('working with no tool is thinking; the live state wins over the tool', () => {
    expect(activityOf(agent({}))).toBe('thinking');
    expect(activityOf(agent({ state: 'waiting', tool: tool('Bash') }))).toBe('waiting');
    expect(activityOf(agent({ state: 'stalled', tool: tool('WebFetch') }))).toBe('stalled');
    expect(activityOf(agent({ state: 'done' }))).toBe('done');
    expect(activityOf(agent({ state: 'error' }))).toBe('error');
  });
});

const s = (id: string, project: string, agents: object[], o: object = {}) =>
  ({ id, project, host: 'mbp', startedAt: 0, lastTs: 0, tokens: 100, cost: 0.5, costPartial: false, contextPercent: 40, agents, ...o });

describe('officeLayout', () => {
  const kids = (n: number) => Array.from({ length: n }, (_, i) => agent({ id: `a${i}`, depth: 1, parent: 'main', type: 'Explore', model: 'claude-haiku-5-5', startedAt: i + 1 }));

  it('one room per project; each session main gets a lead desk on top, its agents below', () => {
    const rooms = layout([s('s1', 'agent-orb', [agent({ model: 'claude-opus-5-5' }), ...kids(2)]), s('s2', 'mobile-app', [agent({})])], 0);
    expect(rooms.map((r: any) => [r.project, r.seats.length])).toEqual([['agent-orb', 3], ['mobile-app', 1]]);
    const [lead, ...rest] = rooms[0].seats;
    expect(lead).toMatchObject({ lead: true, model: 'opus', label: 'main · orchestrator' });
    for (const seat of rest) expect(seat.y).toBeGreaterThan(lead.y);
  });

  it('two sessions of one project share the room, each main on the lead row; totals add up', () => {
    const [room] = layout([s('s1', 'p', [agent({})]), s('s2', 'p', [agent({})], { tokens: 50, cost: 0.25 })], 0);
    expect(room.seats.filter((x: any) => x.lead)).toHaveLength(2);
    expect(new Set(room.seats.map((x: any) => x.y)).size).toBe(1);
    expect(room).toMatchObject({ tokens: 150, cost: 0.75 });
  });

  it('wraps the agents at 8 a row and widens nothing past it; the room grows downwards', () => {
    const [room] = layout([s('s1', 'p', [agent({}), ...kids(11)])], 0);
    const rows = new Set(room.seats.filter((x: any) => !x.lead).map((x: any) => x.y));
    expect(rows.size).toBe(2);
    expect(room.width).toBeLessThanOrEqual(8 * 64 + 40);
    expect(room.height).toBeGreaterThan(layout([s('s1', 'p', [agent({}), ...kids(3)])], 0)[0].height);
  });

  it('a delegating parent draws a line to each child still at work', () => {
    const [room] = layout([s('s1', 'p', [agent({ tool: tool('Agent') }), agent({ id: 'a0', depth: 1, parent: 'main', state: 'working' }),
      agent({ id: 'a1', depth: 1, parent: 'main', state: 'done', lastTs: 0 })])], 30_000);
    expect(room.lines.map((l: any) => [l.from, l.to])).toEqual([['s1:main', 's1:a0']]);
  });

  it('a done bot stays a minute, then leaves', () => {
    const done = agent({ id: 'a0', depth: 1, parent: 'main', state: 'done', lastTs: 0 });
    expect(layout([s('s1', 'p', [agent({}), done])], 59_000)[0].seats).toHaveLength(2);
    expect(layout([s('s1', 'p', [agent({}), done])], 61_000)[0].seats).toHaveLength(1);
  });
});

describe('desk captions', () => {
  const cap = (o: object, now = 0) => layout([s('s1', 'p', [agent(o)])], now)[0].seats[0].caption;
  it('shows the tool and its age, or what the bot waits for', () => {
    expect(cap({ tool: tool('Bash') }, 42_000)).toBe('Bash 42s');
    expect(cap({ tool: tool('Agent') }, 4 * 60_000 + 30_000)).toBe('Agent 4m');
    expect(cap({})).toBe('thinking');
    expect(cap({ state: 'waiting', tool: { ...tool('Bash'), waiting: true } })).toBe('Bash · permission');
    expect(cap({ state: 'waiting', waitingFor: 'prompt' })).toBe('your prompt');
    expect(cap({ state: 'error' })).toBe('error');
    expect(cap({ state: 'waiting', tool: { ...tool('mcp__Claude_Browser__browser_batch'), waiting: true } })).toBe('browser_batch · permission');
  });
});
