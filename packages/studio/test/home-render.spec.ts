import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeError, HomeView, type HomeData, type HomeProject, type HomeRow } from '../src/Home.tsx';
import { homeSentence } from '../src/home-view.ts';
import type { Agent, Session } from '../src/Live.tsx';

// Home (v0.5 slice 3, #107; design/home-issue.html, the Home board): a card per project with a session in the past 30 days, the rows in flight worst first, and one sentence counted from them.
// The studio has no DOM library, so the page is rendered to markup; the projects and issues are the mockup's, invented.
const plain = (html: string) => html.replace(/<\/?(b|code)>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-10T12:00:00Z');

const row = (number: number, over: Partial<HomeRow> = {}): HomeRow => ({
  number, title: `Issue ${number}`, milestone: 'v2.3 Offline', outside: false, stage: 'building', pr: null, ready: null, reason: null, sessions: [], sessionCount: 0, shares: [], ...over,
});
const sess = (id: string) => ({ id, at: NOW - 5 * MIN });
const project = (name: string, over: Partial<HomeProject> = {}): HomeProject => ({
  name, last: NOW - MIN, milestone: 'v1.1 Export', content: 'full', counts: { merged: 0, flight: 0, queued: 0, outside: 0 }, rows: [], readAt: NOW - 2 * MIN,
  notOnIssue: { count: 0, sessions: [] }, month: '2026-11', goal: null, spent: 0, costPartial: false, ...over,
});
const MOBILE = project('mobile-app', {
  milestone: 'v2.3 Offline', counts: { merged: 1, flight: 5, queued: 2, outside: 1 }, goal: 2500, spent: 1870, readAt: NOW - 2 * MIN,
  notOnIssue: { count: 4, sessions: [{ id: 's-main', branch: 'main', at: NOW - 3 * MIN }, { id: 's-old', branch: 'chore/deps', at: NOW - 9 * DAY }] },
  rows: [
    row(412, { stage: 'ready', pr: { number: 418, head: 'fix/412', merged: false }, ready: true, sessions: [], shares: [{ issue: 407, together: true }, { issue: 409, together: true }] }),
    row(398, { stage: 'reviewing', outside: true, milestone: 'v2.2.1', pr: { number: 411, head: 'fix/398', merged: false }, ready: false, reason: 'No findings reported yet', sessions: [sess('s-398')], sessionCount: 1, shares: [{ issue: 409, together: false }] }),
    row(407, { stage: 'gate', pr: { number: 414, head: 'fix/407', merged: false }, ready: false, reason: 'UNSTABLE: a check is not passing', budget: { usd: 96, budget: 80, mark: 'at100', partial: false }, shares: [{ issue: 412, together: true }] }),
    row(411, { stage: 'reviewing', pr: { number: 420, head: 'fix/411', merged: false }, ready: false, reason: '1 finding open: 1 major', openFindings: true }),
    row(409, { stage: 'fixing', pr: { number: 416, head: 'fix/409', merged: false }, ready: false, reason: '2 findings open: 1 major, 1 minor', openFindings: true, sessions: [sess('s-409')], sessionCount: 1, shares: [{ issue: 398, together: false }, { issue: 412, together: true }] }),
    row(415, { stage: 'building', branch: 'fix/415-sync-dialog', sessions: [sess('s-415')], sessionCount: 1 }),
  ],
});
const FIELD = project('field-notes', { counts: { merged: 1, flight: 1, queued: 3, outside: 0 }, month: '2026-11', spent: 412, rows: [row(86, { milestone: 'v1.1 Export', pr: { number: 91, head: 'feat/86', merged: false }, sessions: [sess('s-86')], sessionCount: 1 })] });
const BILLING = project('billing-db', { milestone: 'v0.9 Invoices', counts: { merged: 2, flight: 0, queued: 4, outside: 0 }, readAt: NOW - 2 * DAY, goal: 300, spent: 96 });
const DATA: HomeData = { projects: [MOBILE, FIELD, BILLING], quiet: [{ name: 'docs-site', last: Date.parse('2026-10-03T12:00:00Z') }, { name: 'infra-scripts', last: Date.parse('2026-09-21T12:00:00Z') }] };

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({ id, type: id, depth: 1, state: 'working', startedAt: NOW - 30 * MIN, lastTs: NOW - MIN, tasks: [], tokens: 0, cost: 0, skills: [], calls: 0, failed: 0, ...over });
const live = (id: string, projectName: string, agents: Agent[], over: Partial<Session> = {}): Session => ({ id, project: projectName, host: 'mbp', startedAt: NOW - 30 * MIN, lastTs: NOW - MIN, tokens: 0, cost: 0, costPartial: false, agents, ...over });
const SESSIONS: Session[] = [
  live('s-415', 'mobile-app', [agent('implementer', { model: 'claude-sonnet-5-5', state: 'stalled', lastTs: NOW - 22 * MIN, tool: { name: 'Bash', id: 't1', since: NOW - 22 * MIN, waiting: false } })]),
  live('s-409', 'mobile-app', [agent('fixer', { model: 'claude-sonnet-5-5', state: 'waiting', waitingFor: 'permission', tool: { name: 'Bash', id: 't2', since: NOW - 2 * MIN, waiting: true } })]),
  live('s-398', 'mobile-app', [agent('reviewer', { model: 'claude-opus-5-5' })]),
  live('s-main', 'mobile-app', [agent('main', { model: 'claude-opus-5-5', depth: 0, state: 'waiting', waitingFor: 'prompt' })]),
  live('s-86', 'field-notes', [agent('implementer', { model: 'claude-sonnet-5-5' })]),
  live('s-403', 'mobile-app', [agent('main')], { endedAt: NOW - 3 * MIN }), // ended: not running
];

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
const homeError = (message: string) => renderToStaticMarkup(createElement(HomeError, { message }));
const page = (data: HomeData = DATA, sessions: Session[] = SESSIONS) => renderToStaticMarkup(createElement(HomeView, { data, sessions, now: NOW }));
const card = (html: string, name: string) => html.split('<section class="card board home-card"').slice(1).find((c) => c.includes(`aria-label="${name}"`))!;
const rowsOf = (html: string) => html.split('<div class="brow hm-row" data-issue="').slice(1).map((r) => plain(r.split('</section>')[0]!.split('<div class="hm-also">')[0]!.split('<div class="hm-foot">')[0]!.replace(/^\d+">/, '')));

describe('the sentence on top, counted from the rows and the stream', () => {
  const sentence = (data: HomeData, sessions: Session[]) => plain(page(data, sessions).match(/<section class="card said".*?<\/section>/s)![0]);

  it('says how many sessions run and where, and how many things wait on you: every row that is not just working or idle, and a session on no issue that is stalled or waits for you', () => {
    // 415 stalled, 409 waits for your OK, 411 open findings, 407 over budget, 412 ready, and the session on main waiting for its next prompt; 398 is only working
    expect(sentence(DATA, SESSIONS)).toBe('5 sessions are running, 4 on mobile-app and 1 on field-notes. 6 things wait on you. Counted from the rows below. No model writes this.');
  });

  it("the mockup's own case reads five: a stalled one, open findings with an agent editing, over budget, a ready PR and a session on main waiting for its next prompt", () => {
    const rows = ['415', '409', '407', '412', '398'].map((n) => MOBILE.rows.find((r) => r.number === Number(n))!);
    const data = { projects: [{ ...MOBILE, rows }, FIELD], quiet: [] };
    const sessions = SESSIONS.map((x) => (x.id === 's-409' ? live('s-409', 'mobile-app', [agent('fixer', { model: 'claude-sonnet-5-5' })]) : x));
    expect(sentence(data, sessions)).toBe('5 sessions are running, 4 on mobile-app and 1 on field-notes. 5 things wait on you. Counted from the rows below. No model writes this.');
  });

  it('counts the rows and the sessions on no issue the server names, and not a stalled agent of a session that is on no row and is not named', () => {
    const ghost = live('s-ghost', 'field-notes', [agent('implementer', { state: 'stalled', lastTs: NOW - 40 * MIN })]);
    expect(sentence(DATA, [...SESSIONS, ghost])).toBe('6 sessions are running, 4 on mobile-app and 2 on field-notes. 6 things wait on you. Counted from the rows below. No model writes this.');
  });

  it('one session and nothing waiting; and no session at all', () => {
    const one = { projects: [FIELD], quiet: [] };
    expect(sentence(one, [SESSIONS[4]!])).toBe('1 session is running, on field-notes. Nothing waits on you. Counted from the rows below. No model writes this.');
    expect(homeSentence(one.projects, [])).toEqual(['No session is running. ', 'Nothing waits on you.']);
  });

  it('one thing waits, said in the singular', () => {
    expect(homeSentence([{ ...MOBILE, rows: [MOBILE.rows[5]!] }], [SESSIONS[0]!])).toEqual([{ b: '1 session is running' }, ', on mobile-app. 1 thing waits on you.']);
  });
});

describe('a project card', () => {
  it('names the project and its milestone, with the bar and its legend counted from the server\'s counts', () => {
    const c = card(page(), 'mobile-app');
    expect(plain(c.match(/<h2.*?<\/h2>/s)![0])).toBe('mobile-app v2.3 Offline');
    expect(plain(c.match(/<span class="asof[^"]*">.*?<\/span>/s)![0])).toBe('GitHub data 2 min old');
    expect([...c.matchAll(/<i class="(m|f|q)"/g)].map((m) => m[1]).join('')).toBe('mfffffqq'); // 1 merged, 5 in flight, 2 queued
    expect(plain(c.match(/<div class="hm-legend">.*?<\/div><\/div>/s)![0])).toBe('1 of 8 merged 5 in flight 2 queued 1 more in flight outside it');
  });

  it('rows are worst first, as the mockup orders them: stalled, waits on you, open findings, over budget, ready, working', () => {
    const c = card(page(), 'mobile-app');
    expect([...c.matchAll(/<span class="state (\w+)">([^<]*)<\/span>/g)].map((m) => m[2])).toEqual(['Stalled', 'Waits on you', 'Open findings', 'Over budget', 'Ready', 'Working']);
    expect([...c.matchAll(/data-issue="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([415, 409, 411, 407, 412, 398]);
  });

  it('each row: its issue and title, its PR or that it is outside the milestone, the files it shares, its stage, who is on it and what it is doing, and its state', () => {
    const rows = rowsOf(card(page(), 'mobile-app'));
    expect(rows).toEqual([
      '#415 Issue 415 fix/415-sync-dialog Building Now implementer · Sonnet Bash, no answer Stalled',
      '#409 Issue 409 PR #416 Same files as #398 and #412 Fixing Now fixer · Sonnet Needs your OK to run Bash · 2 findings open: 1 major, 1 minor Waits on you',
      '#411 Issue 411 PR #420 Reviewing Now No session is on it. 1 finding open: 1 major Open findings',
      '#407 Issue 407 PR #414 Same files as #412 Gate Now No session is on it. UNSTABLE: a check is not passing · $96.00 of $80.00 Over budget',
      '#412 Issue 412 PR #418 Same files as #407 and #409 Ready Now No session is on it. Ready for your ok. Ready',
      '#398 Issue 398 PR #411 · outside this milestone, v2.2.1 Same files as #409 Reviewing Now reviewer · Opus Thinking… · No findings reported yet Working',
    ]);
  });

  it('a shared file is amber for the partner that is in flight together with the row, and plain for one that is not', () => {
    const c = card(page(), 'mobile-app');
    expect(c).toContain('<span class="hm-with">Same files as <span>#398</span> and <span class="together">#412</span></span>');
    expect(c).toContain('<span class="hm-with">Same files as <span>#409</span></span>');
    expect(c).toContain('<span class="hm-with">Same files as <span class="together">#407</span> and <span class="together">#409</span></span>');
  });

  it("a stalled row's track is red, and says stalled; another row's is not", () => {
    const rows = card(page(), 'mobile-app').split('<div class="brow hm-row"').slice(1);
    expect(rows[0]).toContain('<span class="trk bad" role="img" aria-label="Stage 2 of 7: Building, stalled">');
    expect(rows[1]).toContain('<span class="trk" role="img" aria-label="Stage 4 of 7: Fixing">');
  });

  it('an agent that waits for the next prompt is not Working, and one between steps is not either', () => {
    const wait = (over: Partial<Agent>) => [live('s-415', 'mobile-app', [agent('implementer', { model: 'claude-sonnet-5-5', state: 'waiting', ...over })])];
    const data = { projects: [project('mobile-app', { rows: [row(415, { sessions: [sess('s-415')], sessionCount: 1 })] })], quiet: [] };
    const state = (sessions: Session[]) => card(page(data, sessions), 'mobile-app').match(/<span class="state (\w+)">([^<]*)<\/span>/)!.slice(1);
    expect(state(wait({ waitingFor: 'prompt' }))).toEqual(['waiting', 'Waits on you']);
    expect(state(wait({}))).toEqual(['done', 'Idle']);
    expect(state([live('s-415', 'mobile-app', [agent('implementer')])])).toEqual(['working', 'Working']);
  });

  it("a delegating agent is not described by another session's agents: the agents of two sessions are both called main", () => {
    const delegating = (id: string, kids: Agent[], project = 'mobile-app') => live(id, project, [agent('main', { id: 'main', depth: 0, tool: { name: 'Task', id: `t-${id}`, since: NOW - MIN, waiting: false } }), ...kids]);
    const kid = (id: string) => agent(id, { parent: 'main' });
    const data = { projects: [project('mobile-app', { rows: [row(415, { sessions: [sess('s-415')], sessionCount: 1 })] })], quiet: [] };
    const sessions = [delegating('s-415', [agent('done-kid', { parent: 'main', state: 'done' })]), delegating('s-other', [kid('a'), kid('b'), kid('c')])];
    const c = card(page(data, sessions), 'mobile-app');
    expect(plain(c)).toContain('Dispatching an agent');
    expect(plain(c)).not.toContain('Waiting on the');
  });

  it('a row links to its issue\'s page, with the project', () => {
    expect(card(page(), 'mobile-app')).toContain('<a class="open" href="#/issue?project=mobile-app&amp;issue=409" aria-label="Issue #409: open its page">');
  });

  it('one line for the queued issues and one for the merged, counts only', () => {
    const lines = [...card(page(), 'mobile-app').matchAll(/<div class="hm-also">(.*?)<\/div>/gs)].map((m) => plain(m[1]!));
    expect(lines).toContain('Queued 2 issues');
    expect(lines).toContain('Merged 1 issue');
  });

  it('Not on an issue names the running sessions by agent and branch and the ended ones by branch and day, then how many more of the past 30 days', () => {
    const lines = [...card(page(), 'mobile-app').matchAll(/<div class="hm-also">(.*?)<\/div>/gs)].map((m) => plain(m[1]!));
    expect(lines).toContain('Not on an issue main · Opus on main, waiting for your next prompt on chore/deps, 1 Nov 2 more in the past 30 days');
  });

  it('with no session running, Not on an issue still gives the branches, and a session of another year says the year', () => {
    const none = project('scratch', { notOnIssue: { count: 3, sessions: [{ id: 'a', branch: 'main', at: NOW - 20 * MIN }, { id: 'b', branch: null, at: Date.parse('2025-12-30T12:00:00Z') }] } });
    expect(plain(card(page({ projects: [none], quiet: [] }, []), 'scratch').match(/<div class="hm-also"><b>Not on an issue.*?<\/div>/s)![0])).toBe('Not on an issue on main, 20m ago on no branch, 30 Dec 2025 1 more in the past 30 days');
  });

  it('this month against the goal, or no goal set', () => {
    expect(plain(card(page(), 'mobile-app').match(/<span class="hm-spend"><span>.*?<\/span>/s)![0])).toBe('This month $1870.00 of $2500.00 goal');
    expect(plain(card(page(), 'field-notes').match(/<span class="hm-spend"><span>.*?<\/span>/s)![0])).toBe('This month $412.00, no goal set');
  });

  it('links to the milestone\'s Map and its board, with the project and the milestone', () => {
    const c = card(page(), 'mobile-app');
    expect(c).toContain('<a class="hm-lnk" href="#/factory?project=mobile-app&amp;view=map&amp;milestone=v2.3+Offline">Open the map</a>');
    expect(c).toContain('<a class="hm-lnk" href="#/factory?project=mobile-app&amp;milestone=v2.3+Offline">Open the board</a>');
  });
});

describe('what is missing, said in words', () => {
  it('a project with no running session says how old its GitHub data is, and one with a session running does not say so', () => {
    expect(plain(card(page(), 'billing-db').match(/<span class="asof[^"]*">.*?<\/span>/s)![0])).toBe('GitHub data 2 days old: no session runs here');
    expect(card(page(), 'billing-db')).toContain('<span class="asof stale">');
    expect(card(page(), 'field-notes')).toContain('<span class="asof">GitHub data 2 min old</span>');
  });

  it('a project with nothing read yet says so', () => {
    expect(plain(card(page({ projects: [project('x', { readAt: null })], quiet: [] }, []), 'x').match(/<span class="asof[^"]*">.*?<\/span>/s)![0])).toBe('No GitHub data yet: no session runs here');
  });

  it('a project with nothing in flight says so', () => {
    expect(plain(card(page(), 'billing-db'))).toContain('Nothing is in flight.');
  });

  it('data a day old says days, and under a day says hours', () => {
    const age = (ms: number) => plain(card(page({ projects: [project('x', { readAt: NOW - ms })], quiet: [] }, [live('s', 'x', [agent('a')])]), 'x').match(/<span class="asof[^"]*">.*?<\/span>/s)![0]);
    expect(age(23 * 60 * MIN)).toBe('GitHub data 23 h old');
    expect(age(24 * 60 * MIN)).toBe('GitHub data 1 day old');
    expect(age(3 * DAY + 5 * 60 * MIN)).toBe('GitHub data 3 days old');
  });

  it('the note on how old the data is is not part of the heading', () => {
    expect(plain(card(page(), 'billing-db').match(/<h2.*?<\/h2>/s)![0])).toBe('billing-db v0.9 Invoices');
  });

  it('a project with no milestone says so and lists its issues in flight, without a bar', () => {
    const none = project('scratch', { milestone: null, counts: { merged: 0, flight: 0, queued: 0, outside: 1 }, rows: [row(7, { outside: true, milestone: null, sessions: [sess('s-7')] })] });
    const c = card(page({ projects: [none], quiet: [] }, [live('s-7', 'scratch', [agent('implementer')])]), 'scratch');
    expect(plain(c)).toContain('No milestone has open issues.');
    expect(rowsOf(card(page({ projects: [none], quiet: [] }, []), 'scratch'))).toEqual(['#7 Issue 7 No PR · in flight Building Now No session is on it. Idle']);
    expect(c).not.toContain('hm-bar');
  });

  it('an excluded project says why it has no milestone and no titles, in Factory\'s words, and not that no milestone has open issues', () => {
    const { title: _t, ...bare } = row(86, { outside: true, milestone: undefined });
    const x = project('x', { milestone: null, content: 'excluded', counts: { merged: 0, flight: 0, queued: 0, outside: 1 }, rows: [bare] });
    const c = card(page({ projects: [x], quiet: [] }, []), 'x');
    expect(plain(c)).toContain('This project is in excludeProjects, so the plugin sends no milestones: nothing to follow here but the issues a session is working on.');
    expect(plain(c)).not.toContain('No milestone has open issues');
    expect(rowsOf(c)[0]).toMatch(/^#86 No PR/);
  });

  it('a project whose Content is not on full says why its issues have no title', () => {
    const { title: _t, ...bare } = row(86);
    const off = project('x', { content: 'off', counts: { merged: 0, flight: 1, queued: 0, outside: 0 }, rows: [bare] });
    expect(plain(card(page({ projects: [off], quiet: [] }, []), 'x'))).toContain('Issue titles show with Content on full.');
    expect(plain(card(page({ projects: [project('y', { rows: [row(86)] })], quiet: [] }, []), 'y'))).not.toContain('Content on full');
  });

  it('the error is an alert', () => {
    // Home itself fetches; its error block is rendered by it, so the markup is read from the source of truth: the component with no data
    expect(homeError('The server answered 500.')).toContain('role="alert"');
  });
});

describe('quiet projects', () => {
  it('fold into one line at the foot, each with its last session', () => {
    const html = page();
    const quiet = html.match(/<details class="card hm-quiet">.*?<\/details>/s)![0];
    expect(plain(quiet)).toBe('2 quiet projects, with no session in the past 30 days docs-site last session on 3 Oct infra-scripts last session on 21 Sep');
    expect(html.endsWith('</details>')).toBe(true); // the last thing on the page
    expect(html.lastIndexOf('hm-quiet')).toBeGreaterThan(html.lastIndexOf('home-card'));
  });

  it('a last session of another year says the year', () => {
    const html = page({ ...DATA, quiet: [{ name: 'old-site', last: Date.parse('2025-12-30T12:00:00Z') }] });
    expect(plain(html.match(/<details class="card hm-quiet">.*?<\/details>/s)![0])).toBe('1 quiet project, with no session in the past 30 days old-site last session on 30 Dec 2025');
  });

  it('none, no line', () => {
    expect(page({ ...DATA, quiet: [] })).not.toContain('hm-quiet');
  });
});
