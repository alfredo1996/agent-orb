import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedOf, hintOf, loadMark, saveMark, sinceClause, sinceOf, stalls, type Change } from '../src/changes-view.ts';
import { HomeView, SinceCard, type HomeData, type HomeProject, type HomeRow, type Since } from '../src/Home.tsx';
import type { Agent, Session } from '../src/Live.tsx';

// Since you last looked (v0.5 slice 4, #108; design/home-issue.html, the Home board's card): the changes since a mark kept in this browser, the stalls the stream shows, and the clause of the sentence on top.
// The studio has no DOM library, so the page is rendered to markup; the projects and issues are the mockup's, invented. Times are built in local time so the clock reads the same in any zone.
const plain = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/ ([.,:])/g, '$1').trim();
const MIN = 60_000;
const at = (h: number, m: number, d = 10) => new Date(2026, 10, d, h, m).getTime(); // 10 Nov 2026, local
const NOW = at(11, 48);

const row = (number: number, over: Partial<HomeRow> = {}): HomeRow => ({
  number, title: `Issue ${number}`, milestone: 'v2.3 Offline', outside: false, stage: 'building', pr: null, ready: null, reason: null, sessions: [], sessionCount: 0, shares: [], ...over,
});
const project = (name: string, rows: HomeRow[]): HomeProject => ({
  name, last: NOW - MIN, milestone: 'v2.3 Offline', content: 'full', counts: { merged: 0, flight: rows.length, queued: 0, outside: 0 }, rows, readAt: NOW - 2 * MIN,
  notOnIssue: { count: 0, sessions: [] }, month: '2026-11', goal: null, spent: 0, costPartial: false,
});
const DATA: HomeData = { projects: [project('mobile-app', [row(415, { sessions: [{ id: 's-415', at: NOW }], sessionCount: 1 })]), project('field-notes', [row(84, { title: 'Export notes as Markdown' })])], quiet: [] };
const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ id, type: id, depth: 1, state: 'working', startedAt: NOW - 30 * MIN, lastTs: NOW - MIN, tasks: [], tokens: 0, cost: 0, skills: [], calls: 0, failed: 0, ...over });
const live = (id: string, projectName: string, agents: Agent[], over: Partial<Session> = {}): Session => ({ id, project: projectName, host: 'mbp', startedAt: NOW - 30 * MIN, lastTs: NOW - MIN, tokens: 0, cost: 0, costPartial: false, agents, ...over });
const stalledAt = (since: number) => live('s-415', 'mobile-app', [agent('implementer', { state: 'stalled', stalledSince: since, tool: { name: 'Bash', id: 't1', since: since - MIN, waiting: false } })]);

const CHANGES: Change[] = [
  { at: at(10, 54), kind: 'merged', project: 'field-notes', issue: 84, title: 'Export notes as Markdown', pr: 88 },
  { at: at(10, 31), kind: 'gate', project: 'mobile-app', issue: 407, title: 'Compress photos before upload', pr: 414, sha: 'c0d1e2f' },
  { at: at(10, 15), kind: 'reviewed-again', project: 'mobile-app', issue: 409, title: 'Retry after an expired token', open: 2 },
  { at: at(9, 58), kind: 'opened', project: 'field-notes', issue: 86, title: 'Export notes as PDF', pr: 91 },
  { at: at(9, 31), kind: 'picked-up', project: 'mobile-app', issue: 415, title: 'Sync conflict dialog', branch: 'fix/415-sync-dialog' },
  { at: at(11, 42), kind: 'ready', project: 'mobile-app', issue: 412, title: 'Queue uploads while offline', pr: 418 },
];
const MARK = at(9, 12);

let error: ReturnType<typeof vi.spyOn>, warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  expect(error).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
const since = (changes: Change[], mark: number | null, onCaughtUp = () => {}, total = changes.length): Since => ({ changes, total, mark, onCaughtUp });
const page = (s?: Since, sessions: Session[] = []) => renderToStaticMarkup(createElement(HomeView, { data: DATA, sessions, now: NOW, ...(s ? { since: s } : {}) }));
const card = (html: string) => html.match(/<section class="card hm-side".*?<\/section>/s)![0];
const reading = (html: string) => plain(html.match(/<section class="card said".*?<\/section>/s)![0]);

describe('the card', () => {
  it('lists the changes newest first, each with its time, a link to the issue, what happened and the project and detail, and ends with Caught up', () => {
    const html = card(page(since(CHANGES, MARK)));
    expect(plain(html)).toBe(
      'Since you last looked 6 changes since 09:12 today '
      + '11:42 #412 Queue uploads while offline is ready for your ok. mobile-app · PR #418 '
      + '10:54 #84 Export notes as Markdown merged. field-notes · PR #88 '
      + '10:31 #407 Compress photos before upload reached the gate. mobile-app · a test run passed on c0d1e2f '
      + '10:15 #409 Retry after an expired token was reviewed again. mobile-app · 2 findings open '
      + '09:58 #86 Export notes as PDF has a PR. field-notes · PR #91 opened '
      + '09:31 #415 Sync conflict dialog was picked up. mobile-app · a session started on fix/415-sync-dialog '
      + 'Caught up Moves the mark to now. A reload keeps this list.',
    );
    expect(html).toContain('href="#/issue?project=mobile-app&amp;issue=412"');
    expect(html.match(/class="hm-fd( t-\w+)?"/g)).toEqual(['class="hm-fd t-ok"', 'class="hm-fd t-ok"', 'class="hm-fd"', 'class="hm-fd t-wait"', 'class="hm-fd"', 'class="hm-fd"']);
  });

  it('says when the server cut the list: the hint reads "50 of 63", and a stall older than the oldest change shown is left out, not set into a gap', () => {
    expect(hintOf(50, MARK, NOW, 13)).toBe('50 of 63 changes since 09:12 today');
    expect(hintOf(1, MARK, NOW)).toBe('1 change since 09:12 today');
    const rows = feedOf([CHANGES[0]!, CHANGES[1]!], [{ at: at(9, 40), kind: 'stalled', project: 'mobile-app', issue: 415, who: 'implementer', session: 's-1' }, { at: at(10, 45), kind: 'stalled', project: 'mobile-app', issue: 416, who: 'implementer', session: 's-2' }], true);
    expect(rows.map((x) => x.change.at)).toEqual([at(10, 54), at(10, 45), at(10, 31)]);
    expect(plain(card(page(since([CHANGES[0]!], MARK, () => {}, 14)))).startsWith('Since you last looked 1 of 14 changes since 09:12 today')).toBe(true);
  });

  it('a row that is not from today shows its day before the time', () => {
    const html = card(page(since([{ ...CHANGES[0]!, at: at(10, 54, 9) }, CHANGES[1]!], at(9, 12, 8))));
    expect(plain(html)).toContain('9 Nov 10:54 #84');
    expect(html.match(/<small>/g)).toHaveLength(1); // today's row has no day
  });

  it('the heading takes focus when Caught up removes the button, so a keyboard user is not dropped', () => {
    const focus = vi.fn();
    vi.stubGlobal('document', { getElementById: (id: string) => (id === 'since-h' ? { focus } : null) });
    try {
      const tree = SinceCard({ since: since(CHANGES, MARK), projects: DATA.projects, sessions: [], now: NOW });
      const find = (n: unknown): ReactElement | undefined => (Array.isArray(n) ? n.map(find).find(Boolean) : !isValidElement(n) ? undefined : (n as ReactElement<{ children?: unknown }>).type === 'button' ? (n as ReactElement) : find((n as ReactElement<{ children?: unknown }>).props.children));
      (find(tree)!.props as { onClick: () => void }).onClick();
      expect(focus).toHaveBeenCalledTimes(1);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true }); // as Live and Factory move focus: the page stays where it was
    } finally {
      vi.unstubAllGlobals();
    }
    expect(card(page(since(CHANGES, MARK)))).toContain('id="since-h" tabindex="-1"');
  });

  it('names the day when the mark is not today', () => {
    expect(plain(card(page(since(CHANGES, at(9, 12, 9)))))).toContain('6 changes since 09:12 on 9 Nov');
  });

  it('with nothing new it says so, with the mockup\'s line and no Caught up', () => {
    const html = card(page(since([], at(11, 44))));
    expect(plain(html)).toBe('Since you last looked last looked at 11:44 Nothing changed since 11:44. A PR opened or merged, a review, a test run, and a session starting or stalling all show here.');
    expect(html).not.toContain('Caught up');
  });

  it('on a first look it shows the past 24 hours and says so', () => {
    const html = card(page(since(CHANGES.slice(0, 2), null)));
    expect(plain(html)).toContain('Since you last looked the past 24 hours This is the first look from this browser, so it shows the past 24 hours. 10:54 #84');
    expect(plain(html)).toContain('Caught up');
    expect(plain(card(page(since([], null))))).toContain('Nothing changed in the past 24 hours.');
  });

  it('a review with no open finding is not amber, and a gate is not green', () => {
    const html = card(page(since([{ at: at(10, 0), kind: 'reviewed', project: 'mobile-app', issue: 409, open: 0 }], MARK)));
    expect(html).toContain('class="hm-fd"');
    expect(plain(html)).toContain('#409 was reviewed. mobile-app · no finding open');
  });

  it('is not drawn until the server has answered, and the sentence is then the old one', () => {
    expect(page()).not.toContain('Since you last looked');
    expect(reading(page())).toBe('No session is running. Nothing waits on you. Counted from the rows below. No model writes this.');
  });

  it('Caught up calls what moves the mark', () => {
    const moved = vi.fn();
    const tree = SinceCard({ since: since(CHANGES, MARK, moved), projects: DATA.projects, sessions: [], now: NOW });
    const find = (n: unknown): ReactElement | undefined => {
      if (Array.isArray(n)) return n.map(find).find(Boolean);
      if (!isValidElement(n)) return undefined;
      const el = n as ReactElement<{ children?: unknown; onClick?: () => void }>;
      return el.type === 'button' ? el : find(el.props.children);
    };
    const button = find(tree)!;
    expect(button.props).toMatchObject({ children: 'Caught up' });
    (button.props as { onClick: () => void }).onClick();
    expect(moved).toHaveBeenCalledTimes(1);
  });
});

describe('the sentence on top gains the clause, counted from the list', () => {
  const one = [CHANGES[0]!, CHANGES[5]!]; // merged, ready
  it('names what merged, became ready and stalled; with the mark, with the mark on another day, and on a first look', () => {
    const s = since(one, MARK);
    expect(reading(page(s, [stalledAt(at(11, 41))]))).toBe(
      '1 session is running, on mobile-app. Since you last looked at 09:12, one issue merged, one became ready and one session stalled. 1 thing waits on you. Counted from the rows below. No model writes this.',
    );
    expect(reading(page(since(one, at(9, 12, 9))))).toContain('Since you last looked at 09:12 on 9 Nov, one issue merged and one became ready. Nothing waits');
    expect(reading(page(since(one, null)))).toContain('In the past 24 hours, one issue merged and one became ready.');
  });
  it('counts issues for merged and ready, and sessions for stalls, and reads right in every combination', () => {
    const m = (issue: number, pr: number): Change => ({ ...CHANGES[0]!, issue, pr, at: at(10, issue) });
    const r = (issue: number): Change => ({ ...CHANGES[5]!, issue, at: at(11, issue) });
    const sessionOf = (id: string, issue = 415): Change => ({ at: at(11, 30), kind: 'stalled', project: 'mobile-app', issue, who: 'implementer', session: id });
    const clause = (list: Change[]) => sinceClause(feedOf(list, []), MARK, NOW);
    expect(clause([r(412)])).toBe('Since you last looked at 09:12, one issue became ready.');
    expect(clause([r(412), r(413)])).toBe('Since you last looked at 09:12, two issues became ready.');
    expect(clause([m(84, 88), m(84, 89)])).toBe('Since you last looked at 09:12, one issue merged.'); // two PRs of one issue
    expect(clause([m(84, 88), r(412)])).toBe('Since you last looked at 09:12, one issue merged and one became ready.');
    expect(clause([m(84, 88), r(412), r(413)])).toBe('Since you last looked at 09:12, one issue merged and two became ready.');
    expect(clause([m(84, 88), m(85, 89), r(412)])).toBe('Since you last looked at 09:12, two issues merged and one became ready.');
    expect(clause([r(412), sessionOf('s-1')])).toBe('Since you last looked at 09:12, one issue became ready and one session stalled.');
    expect(clause([sessionOf('s-1'), { ...sessionOf('s-1'), who: 'reviewer' }])).toBe('Since you last looked at 09:12, one session stalled.'); // two agents of one session
    expect(clause([sessionOf('s-1'), sessionOf('s-2', 416)])).toBe('Since you last looked at 09:12, two sessions stalled.');
    expect(clause([m(84, 88), r(412), sessionOf('s-1')])).toBe('Since you last looked at 09:12, one issue merged, one became ready and one session stalled.');
  });
  it('says when the list was cut: the clause counts only the newest', () => {
    expect(sinceClause(feedOf([CHANGES[0]!], []), MARK, NOW, 13)).toBe('Since you last looked at 09:12, one issue merged. Only the newest 1 of 14 are counted.');
  });
  it('counts what there is: two merged, none ready', () => {
    const rows = feedOf([CHANGES[0]!, { ...CHANGES[0]!, issue: 85, at: at(10, 0) }], []);
    expect(sinceClause(rows, MARK, NOW)).toBe('Since you last looked at 09:12, two issues merged.');
  });
  it('with only other kinds, says how many things changed; with none, says nothing changed', () => {
    expect(sinceClause(feedOf([CHANGES[1]!, CHANGES[3]!], []), MARK, NOW)).toBe('Since you last looked at 09:12, 2 things changed.');
    expect(sinceClause([], at(11, 44), NOW)).toBe('Nothing has changed since you last looked at 11:44.');
    expect(sinceClause([], null, NOW)).toBe('Nothing has changed in the past 24 hours.');
  });
  it('joins the running sessions\' sentence when sessions run', () => {
    const run = [live('s-415', 'mobile-app', [agent('implementer')])];
    expect(reading(page(since(one, MARK), run))).toBe('1 session is running, on mobile-app. Since you last looked at 09:12, one issue merged and one became ready. Nothing waits on you. Counted from the rows below. No model writes this.');
  });
});

describe('the stalls from the stream', () => {
  const sessions = (s: number) => [stalledAt(s)];
  const projects = [project('mobile-app', [row(415, { sessions: [{ id: 's-415', at: NOW }], sessionCount: 1 })])];
  it('a stall that began after the mark is a change, from the stall\'s own time; one that began before it is not', () => {
    expect(stalls(projects, sessions(at(11, 26)), MARK)).toEqual([{ at: at(11, 26), kind: 'stalled', project: 'mobile-app', issue: 415, title: 'Issue 415', who: 'implementer', tool: 'Bash', session: 's-415', silentSince: at(11, 26) }]);
    expect(stalls(projects, sessions(at(9, 12)), MARK)).toEqual([]); // at the mark is not after it
    expect(stalls(projects, sessions(at(8, 0)), MARK)).toEqual([]);
  });
  it('a stall is news from when the plugin raised it, not from when the silence began: raised after the mark, silent since before it, it is listed at the raise time with the silence in its line', () => {
    const raised = [live('s-415', 'mobile-app', [agent('implementer', { state: 'stalled', stalledSince: at(9, 0), stalledAt: at(11, 35) })])];
    const [c] = stalls(projects, raised, MARK);
    expect(c).toMatchObject({ at: at(11, 35), kind: 'stalled', issue: 415, who: 'implementer' });
    const html = card(page(since([], MARK), raised));
    expect(plain(html)).toContain('11:35 #415 Issue 415 stalled. mobile-app · the implementer has had no event since 09:00');
    // raised before the mark is not news, however recent the silence
    expect(stalls(projects, [live('s-415', 'mobile-app', [agent('implementer', { state: 'stalled', stalledSince: at(9, 10), stalledAt: at(9, 11) })])], MARK)).toEqual([]);
  });
  it('an agent that is no longer stalled, or in a session that ended, is not listed', () => {
    expect(stalls(projects, [live('s-415', 'mobile-app', [agent('implementer', { stalledSince: at(11, 26) })])], MARK)).toEqual([]);
    expect(stalls(projects, [{ ...stalledAt(at(11, 26)), endedAt: at(11, 40) }], MARK)).toEqual([]);
  });
  it('shows in the card in its place by time, red, with what it was running', () => {
    const html = card(page(since([CHANGES[0]!, CHANGES[3]!], MARK), sessions(at(10, 20))));
    expect(plain(html)).toContain('10:54 #84 Export notes as Markdown merged. field-notes · PR #88 10:20 #415 Issue 415 stalled. mobile-app · the implementer has had no event since 10:20, on Bash 09:58 #86');
    expect(html).toContain('class="hm-fd t-bad"');
  });
});

describe('the mark in this browser', () => {
  const memory = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init));
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m } as unknown as Storage & { m: Map<string, string> };
  };
  it('Caught up writes the time under orb.lookedAt, and a re-render (a new read) keeps it', () => {
    const s = memory();
    expect(loadMark(s, NOW)).toBeNull();
    saveMark(NOW, s);
    expect(s.m.get('orb.lookedAt')).toBe(String(NOW));
    expect(loadMark(s, NOW)).toBe(NOW);
    expect(loadMark(s, NOW)).toBe(NOW);
  });
  it('a first look, or a value that is not a time, asks for the past 24 hours; a mark asks from itself', () => {
    expect(sinceOf(null, NOW)).toBe(NOW - 86_400_000);
    expect(loadMark(memory({ 'orb.lookedAt': 'yesterday' }))).toBeNull();
    expect(loadMark(memory({ 'orb.lookedAt': '0' }))).toBeNull();
    expect(sinceOf(MARK, NOW)).toBe(MARK);
  });
  it('a stored mark that is not a whole number of milliseconds, is too large to be one, or lies in the future is a first look: the server would answer 400, or Caught up could never be reached', () => {
    for (const bad of ['1732400000000.5', '1e300', '9999999999999999', String(NOW + 1), '-5', 'NaN', '']) expect(loadMark(memory({ 'orb.lookedAt': bad }), NOW), bad).toBeNull();
    expect(loadMark(memory({ 'orb.lookedAt': String(NOW) }), NOW)).toBe(NOW);
    expect(loadMark(memory({ 'orb.lookedAt': String(MARK) }), NOW)).toBe(MARK);
  });
  it('a storage that throws, on a read or a write, or that the browser refuses to hand over, is a first look and never breaks the page', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } } as unknown as Storage;
    expect(loadMark(bad)).toBeNull();
    expect(() => saveMark(NOW, bad)).not.toThrow();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
    try {
      expect(loadMark()).toBeNull();
      expect(() => saveMark(NOW)).not.toThrow();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
    expect(hintOf(0, null, NOW)).toBe('the past 24 hours');
  });
});
