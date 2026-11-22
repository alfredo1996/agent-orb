import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeView, type HomeData, type HomeProject, type HomeRow } from '../src/Home.tsx';
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
  name, last: NOW - MIN, milestone: 'v1.1 Export', counts: { merged: 0, flight: 0, queued: 0, outside: 0 }, rows: [], readAt: NOW - 2 * MIN,
  notOnIssue: { count: 0, sessions: [] }, month: '2026-11', goal: null, spent: 0, costPartial: false, ...over,
});
const MOBILE = project('mobile-app', {
  milestone: 'v2.3 Offline', counts: { merged: 1, flight: 5, queued: 2, outside: 1 }, goal: 2500, spent: 1870, readAt: NOW - 2 * MIN,
  notOnIssue: { count: 4, sessions: [{ id: 's-main', branch: 'main', at: NOW - 3 * MIN }, { id: 's-old', branch: 'main', at: NOW - 9 * DAY }] },
  rows: [
    row(412, { stage: 'ready', pr: { number: 418, head: 'fix/412', merged: false }, ready: true, sessions: [], shares: [{ issue: 407, together: true }, { issue: 409, together: true }] }),
    row(398, { stage: 'reviewing', outside: true, milestone: 'v2.2.1', pr: { number: 411, head: 'fix/398', merged: false }, ready: false, reason: 'No findings reported yet', sessions: [sess('s-398')], sessionCount: 1, shares: [{ issue: 409, together: false }] }),
    row(407, { stage: 'gate', pr: { number: 414, head: 'fix/407', merged: false }, ready: false, reason: 'UNSTABLE: a check is not passing', budget: { usd: 96, budget: 80, mark: 'at100', partial: false }, shares: [{ issue: 412, together: true }] }),
    row(411, { stage: 'reviewing', pr: { number: 420, head: 'fix/411', merged: false }, ready: false, reason: '1 finding open: 1 major', openFindings: true }),
    row(409, { stage: 'fixing', pr: { number: 416, head: 'fix/409', merged: false }, ready: false, reason: '2 findings open: 1 major, 1 minor', openFindings: true, sessions: [sess('s-409')], sessionCount: 1, shares: [{ issue: 398, together: false }, { issue: 412, together: true }] }),
    row(415, { stage: 'building', sessions: [sess('s-415')], sessionCount: 1 }),
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
const page = (data: HomeData = DATA, sessions: Session[] = SESSIONS) => renderToStaticMarkup(createElement(HomeView, { data, sessions, now: NOW }));
const card = (html: string, name: string) => html.split('<section class="card board home-card"').slice(1).find((c) => c.includes(`aria-label="${name}"`))!;
const rowsOf = (html: string) => html.split('<div class="brow hm-row" data-issue="').slice(1).map((r) => plain(r.split('</section>')[0]!.split('<div class="hm-also">')[0]!.split('<div class="hm-foot">')[0]!.replace(/^\d+">/, '')));

describe('the sentence on top, counted from the rows and the stream', () => {
  it('says how many sessions run and where, and how many things wait on you: a stalled agent, one that asks for your OK and a PR ready for it', () => {
    expect(plain(page().match(/<section class="card said".*?<\/section>/s)![0])).toBe('5 sessions are running, 4 on mobile-app and 1 on field-notes. 3 things wait on you. Counted from the rows below. No model writes this.');
  });

  it('one session and nothing waiting; and no session at all', () => {
    const one = { projects: [FIELD], quiet: [] };
    expect(plain(renderToStaticMarkup(createElement(HomeView, { data: one, sessions: [SESSIONS[4]!], now: NOW })).match(/<section class="card said".*?<\/section>/s)![0])).toBe('1 session is running, on field-notes. Nothing waits on you. Counted from the rows below. No model writes this.');
    expect(homeSentence(one.projects, [])).toEqual(['No session is running. ', 'Nothing waits on you.']);
  });
});

describe('a project card', () => {
  it('names the project and its milestone, with the bar and its legend counted from the server\'s counts', () => {
    const c = card(page(), 'mobile-app');
    expect(plain(c.match(/<h2.*?<\/h2>/s)![0])).toBe('mobile-app v2.3 Offline GitHub data 2 min old');
    expect([...c.matchAll(/<i class="(m|f|q)"/g)].map((m) => m[1]).join('')).toBe('mfffffqq'); // 1 merged, 5 in flight, 2 queued
    expect(plain(c.match(/<div class="hm-legend">.*?<\/div><\/div>/s)![0])).toBe('1 of 8 merged 5 in flight 2 queued 1 more in flight outside it');
  });

  it('rows are worst first: stalled, waits on you, open findings, over budget, working, ready', () => {
    const c = card(page(), 'mobile-app');
    expect([...c.matchAll(/<span class="state (\w+)">([^<]*)<\/span>/g)].map((m) => m[2])).toEqual(['Stalled', 'Waits on you', 'Open findings', 'Over budget', 'Working', 'Ready']);
    expect([...c.matchAll(/data-issue="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([415, 409, 411, 407, 398, 412]);
  });

  it('each row: its issue and title, its PR or that it is outside the milestone, the files it shares, its stage, who is on it and what it is doing, and its state', () => {
    const rows = rowsOf(card(page(), 'mobile-app'));
    expect(rows).toEqual([
      '#415 Issue 415 No PR Building Now implementer · Sonnet Bash, no answer Stalled',
      '#409 Issue 409 PR #416 Same files as #398 and #412 Fixing Now fixer · Sonnet Needs your OK to run Bash Waits on you',
      '#411 Issue 411 PR #420 Reviewing Now No session is on it. 1 finding open: 1 major Open findings',
      '#407 Issue 407 PR #414 Same files as #412 Gate Now No session is on it. UNSTABLE: a check is not passing · $96.00 of $80.00 Over budget',
      '#398 Issue 398 PR #411 · outside this milestone, v2.2.1 Same files as #409 Reviewing Now reviewer · Opus Thinking… Working',
      '#412 Issue 412 PR #418 Same files as #407 and #409 Ready Now No session is on it. Ready for your ok. Ready',
    ]);
  });

  it('a shared file is amber when both issues are in flight together, and plain when not', () => {
    const c = card(page(), 'mobile-app');
    expect(c).toContain('<span class="hm-with together">Same files as #398 and #412</span>');
    expect(c).toContain('<span class="hm-with">Same files as #409</span>');
  });

  it('a row links to its issue\'s page, with the project', () => {
    expect(card(page(), 'mobile-app')).toContain('<a class="open" href="#/issue?project=mobile-app&amp;issue=409" aria-label="Issue #409: open its page">');
  });

  it('one line for the queued issues and one for the merged, counts only', () => {
    const lines = [...card(page(), 'mobile-app').matchAll(/<div class="hm-also">(.*?)<\/div>/gs)].map((m) => plain(m[1]!));
    expect(lines).toContain('Queued 2 issues');
    expect(lines).toContain('Merged 1 issue');
  });

  it('Not on an issue names the running sessions by agent and branch, then the rest of the past 30 days', () => {
    const lines = [...card(page(), 'mobile-app').matchAll(/<div class="hm-also">(.*?)<\/div>/gs)].map((m) => plain(m[1]!));
    expect(lines).toContain('Not on an issue main · Opus on main, waiting for your next prompt 3 more in the past 30 days');
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
    expect(plain(card(page(), 'billing-db').match(/<span class="asof[^"]*">.*?<\/span>/s)![0])).toBe('GitHub data 48 h old: no session runs here');
    expect(card(page(), 'billing-db')).toContain('<span class="asof stale">');
    expect(card(page(), 'field-notes')).toContain('<span class="asof">GitHub data 2 min old</span>');
  });

  it('a project with nothing read yet says so', () => {
    expect(plain(card(page({ projects: [project('x', { readAt: null })], quiet: [] }, []), 'x').match(/<span class="asof[^"]*">.*?<\/span>/s)![0])).toBe('No GitHub data yet: no session runs here');
  });

  it('a project with nothing in flight says so', () => {
    expect(plain(card(page(), 'billing-db'))).toContain('Nothing is in flight.');
  });

  it('a project with no milestone says so and lists its issues in flight, without a bar', () => {
    const none = project('scratch', { milestone: null, counts: { merged: 0, flight: 0, queued: 0, outside: 1 }, rows: [row(7, { outside: true, milestone: null, sessions: [sess('s-7')] })] });
    const c = card(page({ projects: [none], quiet: [] }, [live('s-7', 'scratch', [agent('implementer')])]), 'scratch');
    expect(plain(c)).toContain('No milestone has open issues.');
    expect(rowsOf(card(page({ projects: [none], quiet: [] }, []), 'scratch'))).toEqual(['#7 Issue 7 No PR · in flight Building Now No session is on it. Idle']);
    expect(c).not.toContain('hm-bar');
  });

  it('an excluded project\'s rows show numbers only', () => {
    const { title: _t, ...bare } = row(86);
    expect(rowsOf(card(page({ projects: [project('x', { rows: [bare] })], quiet: [] }, []), 'x'))[0]).toMatch(/^#86 No PR/);
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

  it('none, no line', () => {
    expect(page({ ...DATA, quiet: [] })).not.toContain('hm-quiet');
  });
});
