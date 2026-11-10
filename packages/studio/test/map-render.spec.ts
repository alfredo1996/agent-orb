import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Factory, type BoardData, type BoardIssue } from '../src/Factory.tsx';
import { MapBand, mapReading, nowOn, type IssueLink, type LinksData } from '../src/FactoryMap.tsx';
import { Reading } from '../src/kit.tsx';
import type { Agent, Session } from '../src/Live.tsx';

// The Map (v0.5 slice 1, #66; design/home-issue.html, the Map board): the board's issues, each a card in the column of its stage, over the lines that tie them: solid where two wrote the
// same file, amber while both are unmerged, dashed where one mentions the other. Under it, the links as a list, which is all a phone shows. The studio has no DOM library, so the band is
// rendered to markup; the issues and files are the mockup's, invented.
const plain = (html: string) => html.replace(/<\/?(b|code)>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const NOW = Date.parse('2026-11-05T12:00:00Z');
const MIN = 60_000;

const issue = (number: number, over: Partial<BoardIssue> = {}): BoardIssue => ({
  number, milestone: 'v2.3 Offline', outside: false, stage: 'queued', pr: null, ready: null, reason: null, sessions: [], sessionCount: 0, ...over,
});
const sess = (id: string) => ({ id, at: NOW - 5 * MIN });
const ALL: BoardIssue[] = [
  issue(417, { title: 'Clear the cache on sign-out' }),
  issue(419, { title: 'Retry queue metrics' }),
  issue(415, { title: 'Sync conflict dialog', stage: 'building', sessions: [sess('s-415')], sessionCount: 1 }),
  issue(398, { title: 'Crash on an empty feed', stage: 'reviewing', outside: true, milestone: 'v2.2.1', pr: { number: 411, head: 'fix/398-feed', merged: false }, ready: false, reason: 'No findings reported yet', sessions: [sess('s-398')], sessionCount: 1 }),
  issue(409, { title: 'Retry after an expired token', stage: 'fixing', pr: { number: 416, head: 'fix/409-retry', merged: false }, ready: false, reason: '2 findings open: 1 major, 1 minor', sessions: [sess('s-409')], sessionCount: 1 }),
  issue(407, { title: 'Compress photos before upload', stage: 'gate', pr: { number: 414, head: 'fix/407-photos', merged: false }, ready: false, reason: 'UNSTABLE: a check is not passing', sessions: [sess('s-407')], sessionCount: 1 }),
  issue(412, { title: 'Queue uploads while offline', stage: 'ready', pr: { number: 418, head: 'fix/412-queue', merged: false }, ready: true, sessions: [sess('s-412')], sessionCount: 1 }),
  issue(403, { title: 'Offline banner', stage: 'merged', pr: { number: 405, head: 'fix/403-banner', merged: true }, sessions: [sess('s-403')], sessionCount: 1 }),
];
const board = (over: Partial<BoardData> = {}): BoardData => ({ project: 'mobile-app', milestone: 'v2.3 Offline', content: 'full', milestones: [{ name: 'v2.3 Offline', open: 7 }], issues: ALL, ...over });
const file = (a: number, b: number, files: string[], together = true, count = files.length): IssueLink => ({ kind: 'file', a, b, files, count, together });
const said = (a: number, b: number): IssueLink => ({ kind: 'mention', a, b });
const LINKS: IssueLink[] = [
  file(409, 412, ['src/net/client.ts']), file(398, 409, ['src/auth/store.ts', 'src/auth/token.ts', 'src/auth/refresh.ts'], true, 5), file(407, 412, ['src/upload/queue.ts']),
  file(403, 412, ['src/net/status.ts'], false), said(417, 409), said(409, 403), said(419, 412),
];
const links = (list: IssueLink[] = LINKS): LinksData => ({ project: 'mobile-app', milestone: 'v2.3 Offline', links: list });

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ id, type: id === 'main' ? 'main' : id, depth: id === 'main' ? 0 : 1, state: 'working', startedAt: NOW - 30 * MIN, lastTs: NOW - MIN, tasks: [], tokens: 0, cost: 0, skills: [], calls: 0, failed: 0, ...over });
const live = (id: string, agents: Agent[], over: Partial<Session> = {}): Session => ({ id, project: 'mobile-app', host: 'mbp', startedAt: NOW - 30 * MIN, lastTs: NOW - MIN, tokens: 0, cost: 0, costPartial: false, agents, ...over });
const SESSIONS: Session[] = [
  live('s-415', [agent('main', { model: 'claude-opus-5-5', tool: { name: 'Agent', id: 't1', since: NOW - 20 * MIN, waiting: false } }), agent('implementer', { model: 'claude-sonnet-5-5', state: 'stalled', lastTs: NOW - 22 * MIN })]),
  live('s-398', [agent('main', { model: 'claude-opus-5-5', tool: { name: 'Agent', id: 't2', since: NOW - 5 * MIN, waiting: false }, lastTs: NOW - 5 * MIN }), agent('reviewer', { model: 'claude-opus-5-5' })]),
  live('s-409', [agent('main', { model: 'claude-opus-5-5', tool: { name: 'Agent', id: 't3', since: NOW - 5 * MIN, waiting: false }, lastTs: NOW - 5 * MIN }),
    agent('fixer', { model: 'claude-sonnet-5-5', state: 'waiting', waitingFor: 'permission', tool: { name: 'Bash', id: 't4', since: NOW - 2 * MIN, waiting: true } })]),
  live('s-403', [agent('main')], { endedAt: NOW - 3 * MIN }), // ended: nobody is on #403 now
];

type Props = Parameters<typeof MapBand>[0];
const band = (over: Partial<Props> = {}) => renderToStaticMarkup(createElement(MapBand, { board: board(), links: links(), sessions: SESSIONS, onPick: () => {}, phone: false, ...over }));
const cards = (html: string) => [...html.matchAll(/<button type="button" class="(mp-node[^"]*)"[^>]*data-issue="(\d+)" aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)]
  .map((m) => ({ cls: m[1]!.split(' ').slice(1).sort().join(' '), n: Number(m[2]), pressed: m[3] === 'true', text: plain(m[4]!) }));
const card = (html: string, n: number) => cards(html).find((c) => c.n === n)!;
const paths = (html: string) => [...html.split('<div class="mp-legend">')[0]!.matchAll(/<path class="mp-e ([^"]*)" d="[^"]+"><\/path>/g)].map((m) => m[1]!); // the map's, not the legend's samples
const rows = (html: string) => html.split('<div class="mp-link">').slice(1).map((r) => plain(`<div>${r.split('</section>')[0]!.split('<div class="mp-none">')[0]}`));
const heading = (html: string) => plain(html.match(/<div class="mp-day">(.*?)<\/div>/)![1]!);

describe('the Map: the cards', () => {
  it('one card per issue of the board, each with its number and title, in the column of its stage: seven headings with how many each holds', () => {
    const html = band();
    expect(cards(html).map((c) => c.n).sort()).toEqual(ALL.map((i) => i.number).sort());
    expect(card(html, 417).text).toBe('#417 Clear the cache on sign-out No session');
    expect([...html.matchAll(/<span class="mp-colt"[^>]*><span>(.*?)<\/span><span class="num">(\d+)<\/span><\/span>/g)].map((m) => `${m[1]} ${m[2]}`))
      .toEqual(['Queued 2', 'Building 1', 'Reviewing 1', 'Fixing 1', 'Gate 1', 'Ready 1', 'Merged 1']);
    const left = (n: number) => Number(html.match(new RegExp(`style="left:(\\d+)px;top:\\d+px"[^>]*data-issue="${n}"`))![1]);
    expect([417, 415, 398, 409, 407, 412, 403].map(left)).toEqual([...[417, 415, 398, 409, 407, 412, 403].map(left)].sort((a, b) => a - b)); // left to right, as the stages go
    expect(left(417)).toBe(left(419)); // two queued issues share a column
    expect(plain(html)).toContain('Map · v2.3 Offline 7 issues, plus 1 in flight outside it · 7 links');
  });

  it('an issue with no link still shows, as a card with no line', () => {
    const html = band();
    expect(card(html, 415).text).toBe('#415 Sync conflict dialog implementer , stalled');
    expect(LINKS.some((l) => l.a === 415 || l.b === 415)).toBe(false);
  });

  it('a card names the agent on the issue now, with its model, from the sessions Live shows: a running session\'s, never an ended one\'s', () => {
    const html = band();
    expect(html).toContain('<span class="model sonnet">implementer</span>');
    expect(card(html, 398).text).toBe('#398 Crash on an empty feed reviewer · v2.2.1');
    expect(card(html, 403).text).toBe('#403 Offline banner No session'); // its session ended
    expect(card(html, 412).text).toBe('#412 Queue uploads while offline No session , ready'); // Live shows no session of it
  });

  it('a card is marked when an agent on it is stalled, when one waits for your OK, and when its PR is ready; an issue outside the milestone is dashed', () => {
    const html = band();
    expect(Object.fromEntries(cards(html).map((c) => [c.n, c.cls]))).toEqual({ 417: '', 419: '', 415: 't-bad', 398: 'out', 409: 't-wait', 407: '', 412: 't-ok', 403: '' });
  });

  it('a mark is said in words too, for a screen reader and the tooltip: hidden text after the agent line and the same words on the title; a card with no mark has none', () => {
    const html = band();
    const words = Object.fromEntries([...html.matchAll(/<button type="button" class="mp-node[^"]*"[^>]*data-issue="(\d+)"[^>]*title="([^"]*)"[^>]*>(.*?)<\/button>/g)]
      .map((m) => [m[1]!, { title: m[2]!, hidden: [...m[3]!.matchAll(/<span class="sr">(.*?)<\/span>/g)].map((x) => x[1]) }]));
    expect(words['415']).toEqual({ title: 'Sync conflict dialog, stalled', hidden: [', stalled'] });
    expect(words['409']).toEqual({ title: 'Retry after an expired token, waits on you', hidden: [', waits on you'] });
    expect(words['412']).toEqual({ title: 'Queue uploads while offline, ready', hidden: [', ready'] });
    expect(words['417']).toEqual({ title: 'Clear the cache on sign-out', hidden: [] });
    expect(html.match(/class="sr"/g)).toHaveLength(3);
  });

  it('the cards are in the page in the order they sit, column by column and top to bottom, whatever order the board lists them in', () => {
    const order = (b: BoardIssue[]) => cards(band({ board: board({ issues: b }) })).map((c) => c.n);
    expect(order(ALL)).toEqual([417, 419, 415, 398, 409, 407, 412, 403]);
    expect(order(ALL.toReversed())).toEqual([417, 419, 415, 398, 409, 407, 412, 403]);
  });

  it('with Content off a card shows its number and no title, as a board row does', () => {
    const html = band({ board: board({ content: 'off', issues: ALL.map(({ title: _, ...i }) => i) }) });
    expect(card(html, 417).text).toBe('#417 No session');
    expect(plain(html)).toContain('Issue titles show with Content on full.');
  });
});

describe('the Map: the lines', () => {
  it('renders a file link as a solid line, an amber one while both are unmerged, and a mention as a dashed one, with the file named on the line', () => {
    const html = band();
    expect(paths(html)).toEqual(['hot', 'hot', 'hot', 'file', 'said', 'said', 'said']);
    expect([...html.matchAll(/<text class="el"[^>]*>(.*?)<\/text>/g)].map((m) => m[1])).toEqual(['net/client.ts', 'auth/store.ts', 'upload/queue.ts', 'net/status.ts']);
    expect(html).toMatch(/<svg width="\d+" height="\d+" aria-hidden="true">/); // the drawing is for the eye: the list under it says the same in words
  });

  it('a link to an issue the board does not show is neither drawn nor listed', () => {
    const html = band({ links: links([...LINKS, file(409, 999, ['src/x.ts']), said(999, 412)]) });
    expect(paths(html)).toHaveLength(7);
    expect(rows(html)).toHaveLength(7);
  });

  it('the legend says what each line and each mark means', () => {
    expect(plain(band().match(/<div class="mp-legend">(.*?)<\/div>/)![1]!)).toBe('both wrote a file and both are still unmerged one mentions the other outside this milestone stalled waits on you ready');
  });
});

describe('the Map: the list of links under it', () => {
  it('every link as a row: the two issues, what ties them, and "In flight together" while both are unmerged', () => {
    const html = band();
    expect(heading(html)).toBe('Every link · 7');
    expect(rows(html)).toEqual([
      '#409 Retry after an expired token and #412 Queue uploads while offline Both wrote src/net/client.ts In flight together',
      '#398 Crash on an empty feed and #409 Retry after an expired token Both wrote src/auth/store.ts, src/auth/token.ts, src/auth/refresh.ts and 2 more In flight together',
      '#407 Compress photos before upload and #412 Queue uploads while offline Both wrote src/upload/queue.ts In flight together',
      '#403 Offline banner and #412 Queue uploads while offline Both wrote src/net/status.ts',
      "#417 Clear the cache on sign-out mentions #409 Retry after an expired token In #417's text",
      "#409 Retry after an expired token mentions #403 Offline banner In #409's text",
      "#419 Retry queue metrics mentions #412 Queue uploads while offline In #419's text",
    ]);
    expect(html).toContain('Both wrote <code>src/net/client.ts</code>'); // a path shows whole, and with Content off too: it is kept as metadata
  });

  it('a pressed card keeps its links and fades the rest, and the list shows only its links', () => {
    const html = band({ picked: 409 });
    expect(cards(html).filter((c) => c.pressed).map((c) => c.n)).toEqual([409]);
    const dim = (n: number) => card(html, n).cls.split(' ').includes('dim');
    expect(Object.fromEntries(ALL.map((i) => [i.number, dim(i.number)]))).toEqual({ 417: false, 419: true, 415: true, 398: false, 409: false, 407: true, 412: false, 403: false });
    expect(paths(html)).toEqual(['hot', 'hot', 'hot dim', 'file dim', 'said', 'said', 'said dim']);
    expect([...html.matchAll(/<text class="(el[^"]*)"[^>]*>(.*?)<\/text>/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual(['el net/client.ts', 'el auth/store.ts', 'el dim upload/queue.ts', 'el dim net/status.ts']);
    expect(heading(html)).toBe('Links of #409 · 4');
    expect(rows(html).map((r) => r.match(/#\d+/g)!.slice(0, 2).join(' '))).toEqual(['#409 #412', '#398 #409', '#417 #409', '#409 #403']);
  });

  it('a pressed card with no link says so, and nothing else is listed', () => {
    const html = band({ picked: 415 });
    expect(heading(html)).toBe('Links of #415 · 0');
    expect(rows(html)).toEqual([]);
    expect(plain(html)).toContain('#415 has no link to another issue.');
    expect(cards(html).filter((c) => !c.pressed).every((c) => c.cls.split(' ').includes('dim'))).toBe(true);
  });

  it('a pressed issue that has left the board is no longer pressed: every link shows again', () => {
    const html = band({ picked: 999 });
    expect(heading(html)).toBe('Every link · 7');
    expect(cards(html).some((c) => c.pressed || c.cls.includes('dim'))).toBe(false);
  });

  it('a board with no link says so; one whose links are not read yet, or could not be read, says that and still shows its cards', () => {
    expect(plain(band({ links: links([]) }))).toContain('Every link · 0 No issue here touches another: no file two of them wrote, and no mention.');
    const waiting = band({ links: undefined });
    expect(cards(waiting)).toHaveLength(ALL.length);
    expect(plain(waiting)).toContain('Reading the links…');
    expect(plain(waiting)).not.toContain('Every link');
    const failed = band({ links: undefined, error: 'The server answered 502.' });
    expect(failed).toContain('<p class="nothing" role="alert">The links could not be read: The server answered 502.</p>');
    expect(cards(failed)).toHaveLength(ALL.length);
    expect(plain(band({ error: 'The server answered 502.' }))).toContain('Every link · 7'); // a failed read after a good one keeps the good one
  });

  it('a board read that fails after a good one says so above the map, and the last good cards stay', () => {
    const html = band({ boardError: 'The server answered 500.' });
    expect(html).toContain('<p class="nothing" role="alert">The board could not be read: The server answered 500.</p>');
    expect(html.indexOf('The board could not be read')).toBeLessThan(html.indexOf('class="mp-scroll"'));
    expect(cards(html)).toHaveLength(ALL.length);
    expect(band()).not.toContain('The board could not be read');
  });

  it('a board with no issue says what the board says, and draws no map', () => {
    const html = band({ board: board({ issues: [] }), links: links([]) });
    expect(plain(html)).toContain('No open issue in v2.3 Offline, and none in flight.');
    expect(html).not.toContain('class="mp"');
  });

  it('at phone width the list shows and the canvas does not: no card, no line, no legend', () => {
    const html = band({ phone: true });
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('mp-node');
    expect(html).not.toContain('mp-legend');
    expect(heading(html)).toBe('Every link · 7');
    expect(rows(html)).toHaveLength(7);
  });
});

describe('the sentence on top of the Map, counted from the links', () => {
  const read = (list: IssueLink[], b = board()) => plain(renderToStaticMarkup(createElement(Reading, { said: mapReading(b, list), by: 'x' }))).replace(/ x$/, '');

  it('counts the pairs in flight that wrote the same files, names the issues in more than one, and says which of them is ready', () => {
    expect(read(LINKS)).toBe('3 pairs of issues in flight wrote the same files. #409 and #412 are each in 2 of them, and #412 is ready for your ok.');
    expect(renderToStaticMarkup(createElement(Reading, { said: mapReading(board(), LINKS) }))).toContain('<b>3 pairs of issues in flight wrote the same files.</b>');
    // three pairs around #412, which is in all of them while #409 is in two
    expect(read([file(409, 412, ['a.ts']), file(407, 412, ['a.ts']), file(398, 412, ['a.ts']), file(398, 409, ['b.ts'])])).toBe('4 pairs of issues in flight wrote the same files. #398, #409 and #412 are each in more than one of them, and #412 is ready for your ok.');
  });

  it('one pair, a pair with nothing ready, none in flight, and a board with no link at all', () => {
    expect(read([file(409, 412, ['a.ts'])])).toBe('1 pair of issues in flight wrote the same files. #412 is ready for your ok.');
    expect(read([file(398, 409, ['a.ts']), file(407, 409, ['a.ts'])])).toBe('2 pairs of issues in flight wrote the same files. #409 is in 2 of them.');
    expect(read([file(398, 409, ['a.ts'])])).toBe('1 pair of issues in flight wrote the same files.');
    expect(read([file(403, 412, ['a.ts'], false), said(417, 409)])).toBe('No two issues in flight wrote the same file.');
    expect(read([])).toBe('No issue here touches another: no file two of them wrote, and no mention.');
  });

  it('a link to an issue the board does not show is not counted', () => {
    expect(read([file(409, 999, ['a.ts'])])).toBe('No issue here touches another: no file two of them wrote, and no mention.');
  });
});

describe('nowOn: who is on an issue, and its mark', () => {
  const on = (i: BoardIssue, s: Session[]) => nowOn(i, s);
  const i409 = ALL.find((i) => i.number === 409)!;

  it('names the agent that needs you before one that works, and a working subagent before the main agent that waits on it', () => {
    expect(on(i409, SESSIONS)).toEqual({ who: { name: 'fixer', tone: 'sonnet' }, mark: 'wait' });
    expect(on(ALL.find((i) => i.number === 398)!, SESSIONS)).toEqual({ who: { name: 'reviewer', tone: 'opus' } });
    expect(on(i409, [live('s-409', [agent('main', { model: 'claude-fable-5-1' })])])).toEqual({ who: { name: 'main', tone: 'other' } });
  });

  it('a stall comes before a wait, and both before ready; a session that ended, or that is not this issue\'s, marks nothing', () => {
    const ready = { ...i409, ready: true };
    expect(on(ready, [])).toEqual({ mark: 'ok' });
    expect(on(ready, SESSIONS).mark).toBe('wait');
    expect(on(ready, [live('s-409', [agent('main', { state: 'stalled' }), agent('fixer', { state: 'waiting', waitingFor: 'permission' })])]).mark).toBe('bad');
    expect(on(i409, [live('s-409', [agent('main', { state: 'stalled' })], { endedAt: NOW })])).toEqual({});
    expect(on(i409, [live('s-other', [agent('main', { state: 'stalled' })])])).toEqual({});
    expect(on(i409, [live('s-409', [agent('main', { state: 'waiting', waitingFor: 'prompt' })])])).toEqual({ who: { name: 'main', tone: 'other' } }); // waiting for the next prompt is no mark, as on Live
    expect(on(i409, [live('s-409', [agent('helper', { state: 'done' })])])).toEqual({}); // a done agent is on nothing
  });
});

describe('the Factory page: the Board and Map switch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens on Board, with Map one tap away', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
    const html = renderToStaticMarkup(createElement(Factory, { now: NOW, live: new Set<string>() }));
    expect([...html.matchAll(/<button type="button" aria-pressed="(true|false)">(Board|Map)<\/button>/g)].map((m) => [m[2], m[1]])).toEqual([['Board', 'true'], ['Map', 'false']]);
    expect(html).toContain('role="group" aria-label="Factory view"');
  });
});
