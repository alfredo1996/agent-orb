import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IssueView, issueReading, type IssueData } from '../src/Issue.tsx';
import { readChoice, readFactory } from '../src/project-choice.ts';

// The issue page (v0.5 slice 2, #106; design/home-issue.html, the Issue and Missing data boards): where an issue stands, its story, and what the sheet had (the four checks, the findings, the cost).
// The studio has no DOM library, so the page is rendered to markup, in UTC.
const plain = (html: string) => html.replace(/<\/?b>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const MIN = 60_000;
const T0 = Date.parse('2026-11-03T09:00:00Z'); // a Tuesday
const NOW = T0 + 3 * 60 * MIN;
const SONNET = 'claude-sonnet-5-5';
const cond = (ok: boolean | null, note: string) => ({ ok, note });
const CHECKS = {
  number: 416, head: 'fix/409-retry', issue: 409, headOid: 'e4f5a6b'.padEnd(40, '1'), ready: false, reason: '1 finding open: 1 minor', dropped: 0,
  conditions: { findings: cond(false, '1 finding open: 1 minor'), gate: cond(null, 'No test run on e4f5a6b'), bots: cond(true, 'No unread bot comment since the last commit'), clean: cond(true, 'CLEAN') },
  findings: [{ id: 'F2', severity: 'minor', file: 'src/b.ts', fate: 'open' as const, title: 'Timeout is not a constant' }, { id: 'F1', severity: 'major', file: 'src/a.ts', fate: 'fixed' as const }],
};
const cost = (usd: number) => ({ number: 409, milestone: 'v2.3 Offline', usd, partial: false, whole: usd, windows: 0, budget: 150, milestoneBudget: 150, source: 'milestone' as const, mark: null });
const NO_STEPS = (over: Record<string, { at: number | null; again?: number[] }> = {}) =>
  (['queued', 'building', 'reviewing', 'fixing', 'gate', 'ready', 'merged'] as const).map((stage) => ({ stage, at: null, again: [], ...over[stage] }));

const FLIGHT: IssueData = {
  project: 'mobile-app', content: 'full', readAt: NOW - 2 * MIN,
  issue: { number: 409, title: 'Retry after an expired token', milestone: 'v2.3 Offline', stage: 'fixing', ready: false, reason: '1 finding open: 1 minor', openedAt: null, pr: { number: 416, head: 'fix/409-retry', merged: false } },
  story: [
    { kind: 'run', at: T0, stage: 'building', session: 's-409', agent: { id: 's-409:main', type: 'main', role: 'main', model: SONNET }, wrote: { paths: ['src/a.ts'], count: 1 }, tests: { runs: 2, failed: 1 }, rounds: [], usd: 1, partial: false },
    { kind: 'pr-open', at: T0 + 10 * MIN, stage: 'building', pr: 416 },
    { kind: 'round', at: T0 + 15 * MIN, stage: 'reviewing', agent: 's-rev:rev', reviewer: true, open: 1, dropped: 0 },
    { kind: 'run', at: T0 + 20 * MIN, stage: 'fixing', session: 's-409', agent: { id: 's-409:fx', type: 'implementer', role: 'developer', model: SONNET }, wrote: { paths: ['src/b.ts'], count: 1 }, tests: { runs: 0, failed: 0 }, rounds: [], usd: 0.5, partial: false },
    { kind: 'run', at: T0 + 25 * 60 * MIN, stage: 'fixing', session: 's-409', agent: { id: 's-409:t', type: 'test-runner', role: null, model: null }, wrote: { paths: [], count: 0 }, tests: { runs: 1, failed: 0 }, rounds: [], usd: 0, partial: false },
  ],
  stages: NO_STEPS({ building: { at: T0 }, reviewing: { at: T0 + 15 * MIN }, fixing: { at: T0 + 20 * MIN } }),
  checks: CHECKS, cost: cost(1.5),
  links: [{ kind: 'file', a: 409, b: 412, files: ['src/net/client.ts'], count: 1, together: true, title: 'Queue uploads while offline', stage: 'ready' }, { kind: 'mention', a: 409, b: 403, title: 'Offline banner', stage: 'merged' }],
  mentions: [{ issue: 999, direction: 'out', title: null, stage: null, known: false }, { issue: 777, direction: 'out', both: true, title: 'Cache sizes', stage: null, known: true }],
  sessions: [{ id: 's-409', branch: 'fix/409-retry', at: T0 + 20 * MIN, startedAt: T0, windowOnly: false, imported: false }],
};
const MERGED: IssueData = {
  ...FLIGHT, issue: { ...FLIGHT.issue, number: 403, title: 'Offline banner', stage: 'merged', ready: null, reason: null, pr: { number: 405, head: 'fix/403-banner', merged: true } },
  story: [FLIGHT.story[0]!, { kind: 'pr-merged', at: T0 + 30 * MIN, stage: 'merged', pr: 405 }], stages: NO_STEPS({ building: { at: T0 }, merged: { at: T0 + 30 * MIN } }), checks: null, links: [], mentions: [],
  sessions: [{ id: 's-403', branch: 'fix/403-banner', at: T0, startedAt: T0, windowOnly: false, imported: false }],
};
const QUEUED: IssueData = {
  ...FLIGHT, issue: { number: 417, title: 'Clear the cache on sign-out', milestone: 'v2.3 Offline', stage: 'queued', ready: null, reason: null, openedAt: null, pr: null },
  story: [], stages: NO_STEPS(), checks: null, cost: null, links: [], mentions: [], sessions: [], readAt: null,
};
const page = (d: IssueData, extra = {}) => renderToStaticMarkup(createElement(IssueView, { data: d, now: NOW, tz: 'UTC', onSave: async () => undefined, ...extra }));
const lines = (html: string) => [...html.matchAll(/<div class="iss-st[\s\S]*?<span class="cost num">[^<]*<\/span><\/div>|<div class="iss-st[\s\S]*?<span class="cost num"\/><\/div>/g)].map((m) => plain(m[0]));

describe('the issue page, in flight', () => {
  it('the crumb, the title, the PR and branch chips and how old the GitHub data is', () => {
    const html = page(FLIGHT);
    expect(plain(html.match(/<nav class="iss-crumb"[\s\S]*?<\/nav>/)![0])).toBe('Factory › mobile-app › v2.3 Offline');
    expect(html).toContain('<h1>#409 Retry after an expired token</h1>');
    expect(plain(html.match(/<div class="iss-chips">[\s\S]*?<\/div>/)![0])).toBe('PR #416 fix/409-retry GitHub data 2 min old');
  });

  it('where it stands: one sentence from the data, and seven steps with when each was reached and Not yet for the rest', () => {
    const html = page(FLIGHT);
    expect(plain(html.match(/<section class="card said"[\s\S]*?<\/section>/)![0])).toBe('Fixing. 3 agent runs in 1 session, $1.50 so far. It can\'t merge yet: 1 finding open: 1 minor. Counted from the data on this page. No model writes this.');
    expect([...html.matchAll(/<li class="([^"]*)"[^>]*><b>(\w+)<\/b><span>([^<]*)<\/span>/g)].map((m) => [m[1], m[2], m[3]])).toEqual([
      ['on', 'Queued', ''], ['on', 'Building', 'Tue 09:00'], ['on', 'Reviewing', 'Tue 09:15'], ['now', 'Fixing', 'Tue 09:20'], ['', 'Gate', 'Not yet'], ['', 'Ready', 'Not yet'], ['', 'Merged', 'Not yet'],
    ]);
  });

  it('a stage that came round again lists its later times', () => {
    const d = { ...FLIGHT, stages: NO_STEPS({ building: { at: T0 }, reviewing: { at: T0 + 15 * MIN, again: [T0 + 28 * 60 * MIN] }, fixing: { at: T0 + 20 * MIN } }) };
    expect(page(d)).toContain('<b>Reviewing</b><span>Tue 09:15, again Wed 13:00</span>');
  });

  it('the story: a line per run, a PR opening and a findings round, with a day divider, the stage reached and the cost', () => {
    const html = page(FLIGHT);
    expect(lines(html)).toEqual([
      '09:00 M main wrote 1 file, ran the tests: 1 of 2 failed → Building src/a.ts · Sonnet 5.5 $1.00',
      '09:10 PR PR #416 opened',
      '09:15 R reviewer reported 1 open finding → Reviewing',
      '09:20 I implementer wrote 1 file → Fixing src/b.ts · Sonnet 5.5 $0.50',
      '10:00 T test-runner ran the tests: passed',
    ]);
    expect([...html.matchAll(/<div class="iss-day">([^<]*)</g)].map((m) => m[1])).toEqual(['Tue 3 Nov', 'Wed 4 Nov']);
  });

  it('a run line opens its session in Live, with the project', () => {
    expect(page(FLIGHT)).toContain('<a class="hm-lnk" href="#/live?session=s-409&amp;project=mobile-app">');
  });

  it('the side: the four checks, the findings, the cost with the issue budget field, the sessions', () => {
    const t = plain(page(FLIGHT));
    expect(t).toContain('Can it merge? ✗ No finding is open 1 finding open: 1 minor');
    expect(t).toContain('? The gate passed on this head No test run on e4f5a6b');
    expect(t).toContain('GitHub data 2 min old · head e4f5a6b');
    expect(t).toContain('Open (1) F2 minor src/b.ts Timeout is not a constant');
    expect(t).toContain('Fixed (1)');
    expect(t).toContain('Cost, estimate');
    expect(page(FLIGHT)).toContain('aria-label="Budget for this issue"');
    expect(t).toContain('fix/409-retry Tue 09:00 to Tue 09:20 Open in Live');
  });

  it('related issues: the file two wrote, in flight together, the mention, one that is on no map, and the link to the milestone\'s map', () => {
    const html = page(FLIGHT);
    const rel = plain(html.match(/<section class="card" aria-label="Related issues">[\s\S]*?<\/section>/)![0]);
    expect(rel).toBe('Related issues by files written, and by mentions #412 Queue uploads while offline Both wrote src/net/client.ts Ready In flight together #403 Offline banner This issue mentions it Merged #999 This issue mentions it, and it is not on the milestone\'s map #777 Cache sizes Each mentions the other, and it is not on the milestone\'s map See them on the milestone\'s map');
    expect(html).not.toContain('href="#/issue?project=mobile-app&amp;issue=999"'); // the plugin never read #999: it has no page to open, so it is text
    expect(html).toContain('href="#/issue?project=mobile-app&amp;issue=777"');
    const href = html.match(/href="([^"]*)">See them on the milestone/)![1]!.replace(/&amp;/g, '&');
    expect(readFactory(href)).toEqual({ view: 'map', milestone: 'v2.3 Offline' }); // the Map this link lands on
    expect(readChoice(href).single).toBe('mobile-app');
  });
});

describe('the issue page, merged and queued', () => {
  it('a merged issue: no checks but where it merged, Gate and Ready not recorded, and Merged reached', () => {
    const html = page(MERGED);
    expect(plain(html.match(/<section class="card said"[\s\S]*?<\/section>/)![0])).toContain('Merged. 1 agent run in 1 session, $1.50 so far. It merged as PR #405.');
    expect([...html.matchAll(/<li class="([^"]*)"[^>]*><b>(\w+)<\/b><span>([^<]*)<\/span>/g)].map((m) => [m[1], m[2], m[3]]).slice(4)).toEqual([['on', 'Gate', 'Not recorded'], ['on', 'Ready', 'Not recorded'], ['now', 'Merged', 'Tue 09:30']]);
    expect(plain(html)).toContain('Can it merge? It merged as PR #405.');
    expect(plain(html)).not.toContain('No finding is open');
    expect(lines(html).at(-1)).toBe('09:30 PR PR #405 merged → Merged');
    expect(html).toContain('<ol class="iss-steps good">');
  });

  it('a queued issue: nothing has happened, with what starts the story, and no PR yet', () => {
    const html = page(QUEUED);
    expect(plain(html.match(/<section class="card said"[\s\S]*?<\/section>/)![0])).toContain('Queued. No session has run on it and it has no PR.');
    expect(plain(html)).toContain('Nothing has happened yet The story starts when a session runs on a branch named for this issue, like fix/417-name, or when a PR says it closes #417.');
    expect(plain(html)).toContain('Can it merge? No PR yet.');
    expect(plain(html)).toContain('Findings No review has reported yet.');
    expect(plain(html)).toContain('Sessions None yet.');
    expect(plain(html)).toContain('Related issues by files written, and by mentions No link to another issue.');
    expect(plain(html)).toContain('No GitHub data yet');
    expect(lines(html)).toEqual([]);
  });
});

describe('what is missing, said in words', () => {
  const words = (d: IssueData) => [...page(d).matchAll(/<p class="miss">([^<]*)<\/p>/g)].map((m) => plain(m[1]!).replace(/&#x27;/g, "'"));

  it('an issue reached only through a PR: the split is by time window', () => {
    const d = { ...FLIGHT, sessions: [{ id: 's-long', branch: 'dev', at: T0, startedAt: T0, windowOnly: true, imported: false }] };
    expect(words(d)).toContain('Reached only through a PR: a session on no issue branch counts here from its turns up to the PR\'s opening, split by time window.');
    expect(plain(page(d))).toContain('dev Tue 09:00 to Tue 09:00 By time window');
    expect(words(FLIGHT).join()).not.toContain('Reached only through a PR');
  });

  it('a session imported from the logs: no files or findings were recorded', () => {
    const d = { ...FLIGHT, sessions: [{ id: 's-imp', branch: 'fix/409-retry', at: T0, startedAt: null, windowOnly: false, imported: true }] };
    expect(words(d)).toContain('Imported from Claude Code\'s logs: files and findings weren\'t recorded.');
  });

  it('agents that report no findings leave the stage at Building; reviews are listed from this version on', () => {
    const d = { ...FLIGHT, issue: { ...FLIGHT.issue, stage: 'building' as const }, story: [FLIGHT.story[0]!] };
    expect(words(d)).toContain('No agent has reported findings, so the stage stays Building: Reviewing is read from a findings report. Reviews are listed from this version on.');
    expect(words(FLIGHT).join()).not.toContain('No agent has reported findings');
  });

  it('an excluded project is numbers only', () => {
    const d = { ...QUEUED, content: 'excluded' as const, issue: { ...QUEUED.issue, title: null } };
    expect(words(d)).toContain('This project is in excludeProjects: issues show by number, with no title.');
    expect(page(d)).toContain('<h1>#417</h1>');
  });
});

describe('the page\'s details (#106)', () => {
  it('a stage that was skipped shows nothing, one ahead Not yet, and Not recorded only for Gate and Ready of a merged issue', () => {
    const stepsOf = (d: IssueData) => [...page(d).matchAll(/<li class="([^"]*)"[^>]*><b>(\w+)<\/b><span>([^<]*)<\/span>/g)].map((m) => [m[2], m[3]]);
    // Building then straight to Gate: no review reported, so Reviewing and Fixing were passed with no time
    const gate = { ...FLIGHT, issue: { ...FLIGHT.issue, stage: 'gate' as const }, stages: NO_STEPS({ building: { at: T0 }, gate: { at: T0 + 5 * MIN } }) };
    expect(stepsOf(gate)).toEqual([['Queued', ''], ['Building', 'Tue 09:00'], ['Reviewing', ''], ['Fixing', ''], ['Gate', 'Tue 09:05'], ['Ready', 'Not yet'], ['Merged', 'Not yet']]);
    const merged = { ...MERGED, stages: NO_STEPS({ building: { at: T0 }, merged: { at: T0 + 30 * MIN } }) };
    expect(stepsOf(merged)).toEqual([['Queued', ''], ['Building', 'Tue 09:00'], ['Reviewing', ''], ['Fixing', ''], ['Gate', 'Not recorded'], ['Ready', 'Not recorded'], ['Merged', 'Tue 09:30']]);
  });

  it('a stage reached more than six days from now says its date too', () => {
    const d = { ...FLIGHT, stages: NO_STEPS({ building: { at: T0 - 8 * 86_400_000 }, reviewing: { at: T0 + 15 * MIN } }) };
    const html = page(d);
    expect(html).toContain('<b>Building</b><span>Mon 26 Oct 09:00</span>');
    expect(html).toContain('<b>Reviewing</b><span>Tue 09:15</span>');
  });

  it('a report by an agent that wrote code, with no run of its own on the issue, is a developer\'s, not a raw id', () => {
    const d = { ...FLIGHT, story: [{ kind: 'round' as const, at: T0, stage: 'reviewing' as const, agent: 's-9:fx-3', reviewer: false, open: 2, dropped: 0 }] };
    expect(lines(page(d))).toEqual(['09:00 D developer reported 2 open findings → Reviewing']);
  });

  it('the headings go h1, h2, h3: the shared sections take the page\'s level', () => {
    const html = page(FLIGHT);
    expect([...html.matchAll(/<h([1-6])[ >]/g)].map((m) => m[1]).filter((v, k, all) => all.indexOf(v) === k).sort()).toEqual(['1', '2', '3']);
    expect(html).toContain('<h2>Can it merge?</h2>');
  });

  it('a session shows when it ran, start to last event', () => {
    expect(plain(page(FLIGHT))).toContain('fix/409-retry Tue 09:00 to Tue 09:20');
  });
});
