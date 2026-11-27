import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BoardCard, costFig, MilestoneSelect, outsideNote, STAGES, titlesNote, type BoardData, type BoardIssue, type IssueCost } from '../src/Factory.tsx';
import { boardGroups, boardRows } from '../src/factory-view.ts';
import type { Agent, Session } from '../src/Live.tsx';

// The Board card (v0.4 slice 6, #32; #90, design/factory.html, "Board, proposed"): the issues in flight as Home's rows grouped by whose move it is, with a cost cell, then the queued and merged ones.
// The data is the mockup's In flight case (mobile-app, v2.3 Offline) and its Quiet case (agent-orb, v0.6 Explain). The studio has no DOM library, so the card is rendered to markup.
const plain = (html: string) => html.replace(/<\/?(b|code)>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const NOW = Date.parse('2026-11-27T12:00:00Z');
const MIN = 60_000;

const issue = (number: number, over: Partial<BoardIssue> = {}): BoardIssue => ({
  number, milestone: 'v2.3 Offline', outside: false, stage: 'queued', pr: null, ready: null, reason: null, sessions: [], sessionCount: 0, ...over,
});
/** An issue's cost as /api/budget gives it, which the page joins to the board by number. */
const ic = (number: number, usd: number, budget: number | null, mark: IssueCost['mark'] = null, partial = false): IssueCost =>
  ({ number, milestone: 'v2.3 Offline', usd, partial, whole: usd, windows: 0, budget, milestoneBudget: budget, source: budget === null ? null : 'milestone', mark });
const sess = (id: string) => ({ id, at: NOW - 5 * MIN });
const agent = (over: Partial<Agent> = {}): Agent => ({ id: 'implementer', type: 'implementer', depth: 1, state: 'working', startedAt: NOW - 30 * MIN, lastTs: NOW - MIN, tasks: [], tokens: 0, cost: 0, skills: [], calls: 0, failed: 0, ...over });
const live = (id: string, agents: Agent[]): Session => ({ id, project: 'mobile-app', host: 'mbp', startedAt: NOW - 30 * MIN, lastTs: NOW - MIN, tokens: 0, cost: 0, costPartial: false, agents });
const ALL: BoardIssue[] = [
  issue(417, { title: 'Clear the cache on sign-out' }),
  issue(419, { title: 'Retry queue metrics' }),
  issue(415, { title: 'Sync conflict dialog', stage: 'building', sessions: [sess('s-415')], sessionCount: 1 }),
  issue(398, { title: 'Crash on an empty feed', stage: 'reviewing', outside: true, milestone: 'v2.2.1', pr: { number: 411, head: 'fix/398-feed', merged: false }, ready: false, reason: 'No findings reported yet', sessions: [sess('s-398')], sessionCount: 1 }),
  issue(409, { title: 'Retry after an expired token', stage: 'fixing', pr: { number: 416, head: 'fix/409-retry', merged: false }, ready: false, reason: '2 findings open: 1 major, 1 minor', sessions: [sess('s-409')], sessionCount: 1 }),
  issue(407, { title: 'Compress photos before upload', stage: 'gate', pr: { number: 414, head: 'fix/407-photos', merged: false }, ready: false, reason: 'UNSTABLE: a check is not passing' }),
  issue(412, { title: 'Queue uploads while offline', stage: 'ready', pr: { number: 418, head: 'fix/412-queue', merged: false }, ready: true }),
  issue(403, { title: 'Offline banner', stage: 'merged', pr: { number: 405, head: 'fix/403-banner', merged: true } }),
];
const SESSIONS = [
  live('s-415', [agent({ state: 'stalled', lastTs: NOW - 22 * MIN })]),
  live('s-409', [agent({ id: 'fixer', type: 'fixer' })]),
  live('s-398', [agent({ id: 'reviewer', type: 'reviewer' })]),
];
const gate = { ok: true, note: '' };
const pr = (number: number, issueNo: number, findings: boolean) => ({ number, head: 'h', issue: issueNo, headOid: 'a'.repeat(40), ready: false, reason: null, dropped: 0, findings: [], conditions: { findings: { ok: findings, note: '' }, gate, bots: gate, clean: gate } });
const PRS = [pr(416, 409, false)];
const data = (over: Partial<BoardData> = {}): BoardData => ({
  project: 'mobile-app', milestone: 'v2.3 Offline', content: 'full', milestones: [{ name: 'v2.2.1', open: 3 }, { name: 'v2.3 Offline', open: 6 }], issues: ALL, ...over,
});
// 417 and 419 have no spend and so no entry, as in /api/budget's list of issues with spend; 398 is in no milestone with a default
const COSTS = new Map([ic(415, 12, 80), ic(398, 9, null), ic(409, 64, 80), ic(407, 96, 80, 'at100'), ic(412, 38, 80), ic(403, 41, 80)].map((c) => [c.number, c]));
const card = (d: BoardData, extra: Partial<Parameters<typeof BoardCard>[0]> = {}, sessions: Session[] = SESSIONS) =>
  renderToStaticMarkup(createElement(BoardCard, {
    data: d, groups: boardGroups(boardRows(d, PRS, COSTS, undefined), sessions), sessions, now: NOW, costs: COSTS, notOnIssue: { usd: 214, partial: false }, onMap: () => {}, ...extra,
  }));
const rows = (html: string) => html.split('<div class="brow').slice(1).map((r) => plain(`<div class="brow${r}`.split('<div class="fx-gh')[0]!.split('<div class="hm-also')[0]!.split('<div class="hm-foot')[0]!));
const rowOf = (html: string, n: number) => '<div class="brow' + html.split('<div class="brow').slice(1).find((r) => r.includes(`data-issue="${n}"`));
const strips = (html: string) => [...html.matchAll(/<div class="fx-gh[^"]*"><b>(.*?)<\/b><span class="num">(\d+)<\/span><span>(.*?)<\/span><\/div>/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);

describe('the Board card, with issues in flight', () => {
  const html = card(data());

  it('three strips in order, each with its dot colour, its count and its line, and the rows grouped under them', () => {
    expect(strips(html)).toEqual([
      'Ready for your ok 1 Every check passes. Merging stays yours.',
      'Blocked 2 Nothing moves these until you look.',
      'Running 2 An agent is on it now.',
    ]);
    expect(html).toMatch(/fx-gh g-ok.*fx-gh g-bad.*fx-gh g-run/s);
    expect(html.match(/data-issue="(\d+)"/g)!.map((m) => Number(m.replace(/\D/g, '')))).toEqual([412, 415, 407, 409, 398]);
  });

  it('a row is Home\'s: name and PR, stage, who is on it and what it is doing, its cost, and its state', () => {
    const r = rows(html);
    expect(r[0]).toBe('#412 Queue uploads while offline PR #418 Ready Now No session is on it. Ready for your ok. Cost, estimate $38.00 of $80.00 Ready');
    expect(r[1]).toBe('#415 Sync conflict dialog Building Now implementer No progress Cost, estimate $12.00 of $80.00 Stalled');
    expect(r[2]).toBe('#407 Compress photos before upload PR #414 Gate Now No session is on it. UNSTABLE: a check is not passing Cost, estimate $96.00 of $80.00 Over budget');
    expect(r[3]).toMatch(/^#409 Retry after an expired token PR #416 Fixing Now fixer .* 2 findings open: 1 major, 1 minor Cost, estimate \$64\.00 of \$80\.00 Open findings$/);
    expect(r[4]).toMatch(/^#398 Crash on an empty feed PR #411 · outside this milestone, v2\.2\.1 Reviewing Now reviewer .* Cost, estimate \$9\.00 Working$/);
    expect(plain(rowOf(html, 412))).toContain('Ready for your ok.');
    expect(plain(rowOf(html, 407))).toContain('UNSTABLE: a check is not passing'); // a PR that is not ready says why in its Now line, as Home's does
  });

  it('every row\'s name is a link to its issue\'s page, with the project in the link', () => {
    const named = card(data({ project: 'my app/v2' }));
    expect(rowOf(named, 409)).toContain('<a class="open" href="#/issue?project=my+app%2Fv2&amp;issue=409" aria-label="Issue #409: open its page">');
    expect(named.match(/<a class="open"/g)).toHaveLength(5);
  });

  it('the cost cell: the figure, "of $budget" and a meter the server\'s mark colours; the mark is not worked out here', () => {
    expect(rowOf(html, 412)).toContain('<div class="fx-cost"><span class="lab">Cost, estimate</span><span><span class="num">$38.00</span><span class="of"> of $80.00</span></span><div class="bar" role="img" aria-label="48% of the budget"><i style="width:48%"></i></div></div>');
    expect(rowOf(html, 407)).toContain('<div class="bar over" role="img" aria-label="120% of the budget"><i style="width:100%"></i></div>');
    const warn = card(data(), { costs: new Map([ic(409, 64, 80, 'at80'), ic(412, 79.6, 100)].map((c) => [c.number, c])) });
    expect(rowOf(warn, 409)).toContain('<div class="bar warn"');
    expect(rowOf(warn, 412)).toContain('<div class="bar" role="img" aria-label="80% of the budget">'); // 79.6% reads 80% and is not yet a warning
    expect(plain(rowOf(html, 398))).toContain('$9.00'); // spent, no budget: the figure alone, no meter
    expect(rowOf(html, 398)).not.toContain('class="bar');
  });

  it('a request with no price makes the figure a floor', () => {
    expect(plain(renderToStaticMarkup(createElement('div', null, costFig(ic(409, 64, null, null, true)))))).toBe('Cost, estimate ≥ $64.00');
  });

  it('a row with no spend has an empty cost cell, and nothing in the markup says what an issue has not got', () => {
    const none = card(data(), { costs: new Map([ic(415, 12, 80)].map((c) => [c.number, c])) });
    expect(rowOf(none, 412)).toContain('<div class="fx-cost"></div>');
    expect(costFig(undefined)).toBeNull();
    expect(costFig(ic(1, 0, 80))).toBeNull();
    for (const h of [html, none, card(data({ issues: ALL.filter((i) => i.stage === 'queued') })), card(data({ issues: [issue(415, { stage: 'building' })] }), {}, [])]) {
      for (const said of ['No PR yet', 'Nothing spent', 'None', 'No budget set']) expect(plain(h), said).not.toContain(said);
    }
  });

  it('an issue with no PR and no branch has no second line saying so', () => {
    const bare = card(data({ issues: [issue(415, { stage: 'building' })] }), {}, []);
    expect(rowOf(bare, 415)).not.toContain('<small>No PR');
    expect(rowOf(bare, 415)).toContain('<small></small>');
  });

  it('the files a row shares with another issue are its second line, from the file links', () => {
    const d = data();
    const links = [{ kind: 'file' as const, a: 409, b: 412, files: ['a.ts'], count: 1, together: true }];
    const html2 = card(d, { groups: boardGroups(boardRows(d, PRS, COSTS, links), SESSIONS) });
    expect(plain(rowOf(html2, 412))).toContain('Same files as #409');
    expect(plain(rowOf(html2, 409))).toContain('Same files as #412');
    expect(plain(rowOf(html, 412))).not.toContain('Same files');
  });

  it('queued and merged issues are one line each, their issues links to their pages', () => {
    expect(html).toContain('<div class="hm-also"><b>Queued</b><a class="hm-lnk" href="#/issue?project=mobile-app&amp;issue=417">#417 Clear the cache on sign-out</a><a class="hm-lnk" href="#/issue?project=mobile-app&amp;issue=419">#419 Retry queue metrics</a></div>');
    expect(html).toContain('<div class="hm-also"><b>Merged</b><a class="hm-lnk" href="#/issue?project=mobile-app&amp;issue=403">#403 Offline banner</a></div>');
    expect(html).not.toContain('class="fx-q"');
  });

  it('the header names the milestone, says how many issues and how many are in flight outside it, and the bar and legend are Home\'s', () => {
    const t = plain(html);
    expect(t).toContain('Board · v2.3 Offline');
    expect(t).toContain('7 issues, plus 1 in flight outside it');
    expect(t).toContain('1 of 7 merged 4 in flight 2 queued 1 more in flight outside it');
    expect(html).toContain('<div class="hm-bar" role="img" aria-label="1 of 7 issues merged, 4 in flight, 2 queued">');
    expect(plain(card(data({ issues: [ALL[0]!] })))).toContain('1 issue');
  });

  it('the note about agent view is behind an i button, which the heading carries as its title; so is what "not on an issue" counts', () => {
    expect(html).toContain('<button type="button" class="info" aria-label="About the board" title="Agent view lists sessions. This lists issues, with what each has spent and how far it is from your ok. A background session is answered in agent view: claude agents.">i</button>');
    expect(plain(html)).not.toContain('Agent view lists sessions'); // not as text of the page
    expect(html).toContain('title="Sessions with no PR, and turns after a session&#x27;s last PR. Cost is an estimate by time windows."');
  });

  it('the foot: this month\'s spend on no issue (a floor when a request had no price), and Open the map', () => {
    expect(plain(html)).toContain('Not on an issue this month $214.00 i Open the map');
    expect(plain(card(data(), { notOnIssue: { usd: 15, partial: true } }))).toContain('Not on an issue this month ≥ $15.00');
    expect(plain(card(data(), { notOnIssue: undefined }))).not.toContain('Not on an issue');
    expect(html).toContain('<button type="button" class="hm-lnk">Open the map</button>');
  });

  it('the stage track has seven segments: those before the stage lit, the stage marked, and a stage that is done shown as good', () => {
    expect(STAGES).toEqual(['queued', 'building', 'reviewing', 'fixing', 'gate', 'ready', 'merged']);
    const track = (n: number) => rowOf(html, n).match(/<span class="trk[^"]*"[^>]*>(.*?)<\/span>/)![0];
    expect(track(409)).toBe('<span class="trk" role="img" aria-label="Stage 4 of 7: Fixing"><i class="on"></i><i class="on"></i><i class="on"></i><i class="now"></i><i class=""></i><i class=""></i><i class=""></i></span>');
    expect(track(412)).toMatch(/^<span class="trk good" role="img" aria-label="Stage 6 of 7: Ready">/);
    expect(track(407)).not.toContain('good'); // Gate is not done
    expect(track(415)).toMatch(/^<span class="trk bad" role="img" aria-label="Stage 2 of 7: Building, stalled">/);
  });
});

describe('the Board card with nothing in flight', () => {
  const quiet = data({ project: 'agent-orb', milestone: 'v0.6 Explain', issues: [90, 122, 3, 2, 1].map((n) => issue(n, { milestone: 'v0.6 Explain', title: `Issue ${n}` })) });
  const html = card(quiet, {}, []);

  it('says so once in a Queued strip, then one line per queued issue: its number and title', () => {
    expect(strips(html)).toEqual(['Queued 5 Nothing is in flight. No session has started on these.']);
    expect([...html.matchAll(/<div class="fx-q"><span class="num">#(\d+)<\/span><span>(.*?)<\/span><\/div>/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual(['90 Issue 90', '122 Issue 122', '3 Issue 3', '2 Issue 2', '1 Issue 1']);
    expect(html).not.toContain('class="brow');
    expect(html).not.toContain('class="bcols'); // no column heads over a list that has no columns
    expect(html).not.toContain('<b>Queued</b><a'); // not also as the line of links
  });

  it('the bar and legend are drawn, and the foot still has the map', () => {
    expect(plain(html)).toContain('0 of 5 merged 0 in flight 5 queued');
    expect(plain(html)).toContain('Open the map');
  });
});

describe('what the card says when it has nothing to show, or could not read', () => {
  it('titles show with Content on full; without, the row is the number, and the card says why once', () => {
    const untitled = ALL.map(({ title: _t, ...i }) => i as BoardIssue);
    const html = card(data({ issues: untitled, content: 'off' }));
    expect(plain(rowOf(html, 412))).toMatch(/^#412 PR #418/);
    expect(plain(html)).toContain('Issue titles show with Content on full.');
    expect(plain(card(data()))).not.toContain('Issue titles show with Content on full.');
  });

  it('with Content on full an issue no read has seen has no title, and the card does not say Content is the reason (R3)', () => {
    expect(plain(card(data({ issues: [issue(417, { title: 'Clear the cache' }), issue(399, { outside: true })], content: 'full' })))).not.toContain('Issue titles show with Content on full');
    expect(titlesNote(data({ issues: [issue(399)], content: 'full' }))).toBeNull();
    expect(titlesNote(data({ issues: [issue(399)], content: null }))).toBe('Issue titles show with Content on full.');
    expect(titlesNote(data({ issues: [issue(417, { title: 'x' })], content: 'off' }))).toBeNull();
  });

  it('an excluded project is not told to turn Content on: it is told it is excluded (R14)', () => {
    const html = card(data({ issues: [issue(399, { outside: true })], content: 'excluded', milestone: null, milestones: [] }));
    expect(plain(html)).toContain('This project is in excludeProjects: issues show by number.');
    expect(plain(html)).not.toContain('Content on full');
    const empty = plain(card(data({ issues: [], content: 'excluded', milestone: null, milestones: [] })));
    expect(empty).toContain('This project is in excludeProjects, so the plugin sends no milestones');
    expect(empty).not.toContain('No open issue has a milestone');
  });

  it('an issue outside the milestone says so, with the milestone it is in, that it is in none when it has none, and nothing about it when no read has seen it (R3)', () => {
    const html = card(data({ issues: [issue(398, { outside: true, milestone: 'v2.2.1', stage: 'building' }), issue(399, { outside: true, milestone: null, stage: 'building' }), issue(397, { outside: true, milestone: undefined, stage: 'building' })] }), {}, []);
    expect(plain(rowOf(html, 398))).toContain('outside this milestone, v2.2.1');
    expect(plain(rowOf(html, 399))).toContain('outside this milestone, in none');
    expect(plain(rowOf(html, 397))).not.toContain('in none');
  });

  it('with no milestone chosen nothing is "outside" or "in none" and the header does not count 0 issues (R14)', () => {
    const only = [issue(398, { outside: true, milestone: null, stage: 'building' }), issue(399, { outside: true, milestone: 'v2.2.1', stage: 'building' })];
    const html = card(data({ milestone: null, milestones: [], issues: only }), {}, []);
    expect(plain(html)).toContain('Board i 2 in flight');
    expect(plain(html)).not.toContain('0 issues');
    expect(plain(html)).not.toContain('outside');
    expect(plain(rowOf(html, 398))).toContain('in flight Building');
    expect(plain(rowOf(html, 399))).toContain('in flight, v2.2.1 Building');
    expect(outsideNote(issue(5), 'v2')).toBe('');
  });

  it('with nothing to follow it says why: no milestone read yet, or nothing open in the chosen one', () => {
    expect(plain(card(data({ milestone: null, milestones: [], issues: [], content: 'off' })))).toContain('No open issue has a milestone');
    expect(plain(card(data({ issues: [] })))).toContain('No open issue in v2.3 Offline, and none in flight.');
  });

  it('when the board could not be read it says so, and still shows what this month spent on no issue, which is the budget read\'s', () => {
    const t = plain(renderToStaticMarkup(createElement(BoardCard, { error: 'The server answered 500.', groups: [], sessions: [], now: NOW, costs: COSTS, notOnIssue: { usd: 214, partial: false }, onMap: () => {} })));
    expect(t).toContain('The board could not be read: The server answered 500.');
    expect(t).toContain('Not on an issue this month $214.00');
  });

  it('it shows the error above the last good rows of the milestone asked for, and an empty board that also failed does not say "none in flight"', () => {
    expect(rows(card(data(), { error: 'The server answered 502.' }))).toHaveLength(5);
    expect(plain(card(data(), { error: 'The server answered 502.' }))).toContain('The board could not be read: The server answered 502.');
    expect(plain(card(data({ issues: [] }), { error: 'x' }))).not.toContain('none in flight');
  });
});

describe('the milestone picker', () => {
  it('lists the project\'s milestones with the chosen one selected; with none it is disabled', () => {
    const html = renderToStaticMarkup(createElement(MilestoneSelect, { milestones: data().milestones, value: 'v2.3 Offline', onChange: () => {} }));
    expect(html).toContain('aria-label="Milestone"');
    expect(html).toMatch(/<option value="v2.2.1">v2.2.1<\/option>/);
    expect(html).toMatch(/<option value="v2.3 Offline" selected="">v2.3 Offline<\/option>/);
    expect(renderToStaticMarkup(createElement(MilestoneSelect, { milestones: [], value: null, onChange: () => {} }))).toContain('disabled=""');
  });
});

describe('the stage track\'s tone (R13)', () => {
  const track = (i: BoardIssue) => rowOf(card(data({ issues: [i] }), {}, []), i.number).match(/<span class="trk[^"]*"[^>]*>/)![0];

  it('a failed gate turns the stage red and says so to a screen reader; a passing one does not', () => {
    expect(track(issue(407, { stage: 'gate', bad: true }))).toBe('<span class="trk bad" role="img" aria-label="Stage 5 of 7: Gate, failed">');
    expect(track(issue(407, { stage: 'gate' }))).toBe('<span class="trk" role="img" aria-label="Stage 5 of 7: Gate">');
  });

  it('ready and merged are green whatever else', () => {
    expect(track(issue(412, { stage: 'ready', bad: true }))).toMatch(/^<span class="trk good"/);
  });
});
