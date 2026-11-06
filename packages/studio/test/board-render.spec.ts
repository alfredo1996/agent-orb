import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BoardBand, MilestoneSelect, STAGES, outsideNote, titlesNote, type BoardData, type BoardIssue, type IssueCost } from '../src/Factory.tsx';

// The Board band (v0.4 slice 6, #32; design/v0.4-factory.html, the Board): rows are issues. Each shows its stage on a track of seven, whether its PR is ready, its cost against its budget, and
// its sessions with a link to Live. The studio has no DOM library, so the band is rendered to markup.
const plain = (html: string) => html.replace(/<\/?b>/g, '').replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const NOW = Date.parse('2026-11-05T12:00:00Z');
const MIN = 60_000;

const issue = (number: number, over: Partial<BoardIssue> = {}): BoardIssue => ({
  number, milestone: 'v2.3 Offline', outside: false, stage: 'queued', pr: null, ready: null, reason: null, sessions: [], sessionCount: 0, ...over,
});
/** An issue's cost as /api/budget gives it, which the page joins to the board by number. */
const ic = (number: number, usd: number, budget: number | null, mark: IssueCost['mark'] = null, partial = false): IssueCost =>
  ({ number, milestone: 'v2.3 Offline', usd, partial, whole: usd, windows: 0, budget, milestoneBudget: budget, source: budget === null ? null : 'milestone', mark });
const sess = (id: string) => ({ id, at: NOW - 5 * MIN });
const ALL: BoardIssue[] = [
  issue(417, { title: 'Clear the cache on sign-out' }),
  issue(415, { title: 'Sync conflict dialog', stage: 'building', sessions: [sess('s-415')], sessionCount: 1 }),
  issue(398, { title: 'Crash on an empty feed', stage: 'reviewing', outside: true, milestone: 'v2.2.1', pr: { number: 411, head: 'fix/398-feed', merged: false }, ready: false, reason: 'No findings reported yet', sessions: [sess('s-398')], sessionCount: 1 }),
  issue(409, { title: 'Retry after an expired token', stage: 'fixing', pr: { number: 416, head: 'fix/409-retry', merged: false }, ready: false, reason: '2 findings open: 1 major, 1 minor', sessions: [sess('s-409a'), sess('s-409b')], sessionCount: 2 }),
  issue(407, { title: 'Compress photos before upload', stage: 'gate', pr: { number: 414, head: 'fix/407-photos', merged: false }, ready: false, reason: 'UNSTABLE: a check is not passing', sessions: [sess('s-407')], sessionCount: 1 }),
  issue(412, { title: 'Queue uploads while offline', stage: 'ready', pr: { number: 418, head: 'fix/412-queue', merged: false }, ready: true, sessions: [sess('s-412')], sessionCount: 1 }),
  issue(403, { title: 'Offline banner', stage: 'merged', pr: { number: 405, head: 'fix/403-banner', merged: true }, sessions: [sess('s-403')], sessionCount: 1 }),
];
const data = (over: Partial<BoardData> = {}): BoardData => ({
  project: 'mobile-app', milestone: 'v2.3 Offline', content: 'full', milestones: [{ name: 'v2.2.1', open: 3 }, { name: 'v2.3 Offline', open: 6 }], issues: ALL, ...over,
});
// 417 and 419 have no spend and so no entry, as in /api/budget's list of issues with spend; 398 is in no milestone with a default
const COSTS = new Map([ic(415, 64, 150), ic(398, 27, null), ic(409, 132, 150, 'at80'), ic(407, 96, 80, 'at100'), ic(412, 118, 150), ic(403, 41, 150)].map((c) => [c.number, c]));
const band = (d: BoardData, live: string[] = ['s-415', 's-398', 's-409a', 's-409b', 's-407', 's-412'], open: number[] = [411, 416, 414, 418], extra: Partial<Parameters<typeof BoardBand>[0]> = {}) =>
  renderToStaticMarkup(createElement(BoardBand, { data: d, live: new Set(live), openable: new Set(open), cost: COSTS, notOnIssue: { usd: 1240, partial: false }, onOpen: () => {}, ...extra }));
const body = (html: string) => html.split('<div class="notissue"')[0]!; // the rows, without the lines under them
const rows = (html: string) => body(html).split('<div class="brow').slice(1).map((r) => plain(`<div class="brow${r}`));
const rowOf = (html: string, n: number) => '<div class="brow' + body(html).split('<div class="brow').slice(1).find((r) => r.includes(`data-issue="${n}"`));

describe('the Board band', () => {
  it('one row per issue with one at each stage: its name, its stage, whether the PR is ready, its cost, its sessions', () => {
    expect(rows(band(data()))).toEqual([
      '#417 Clear the cache on sign-out No PR Queued Ready No PR yet Cost, estimate Nothing spent Sessions None',
      '#415 Sync conflict dialog No PR Building Ready No PR yet Cost, estimate $64.00 of $150.00 43% of the budget Sessions Live',
      '#398 Crash on an empty feed PR #411 · outside this milestone, v2.2.1 Reviewing Ready No findings reported yet Cost, estimate $27.00 No budget set Sessions Live',
      '#409 Retry after an expired token PR #416 Fixing Ready 2 findings open: 1 major, 1 minor Cost, estimate $132.00 of $150.00 88% of the budget: nearly spent Sessions Live s-409a Live s-409b',
      '#407 Compress photos before upload PR #414 Gate Ready UNSTABLE: a check is not passing Cost, estimate $96.00 of $80.00 120% of the budget: reached, nothing is stopped Sessions Live',
      '#412 Queue uploads while offline PR #418 Ready Ready Ready for your ok Cost, estimate $118.00 of $150.00 79% of the budget Sessions Live',
      '#403 Offline banner PR #405, merged Merged Ready Merged Cost, estimate $41.00 of $150.00 27% of the budget Sessions 1 earlier',
    ]);
  });

  it('the stage track has seven segments: those before the stage lit, the stage marked, and a stage that is done shown as good', () => {
    const html = band(data());
    expect(STAGES).toEqual(['queued', 'building', 'reviewing', 'fixing', 'gate', 'ready', 'merged']);
    const track = (n: number) => rowOf(html, n).match(/<span class="trk[^"]*"[^>]*>(.*?)<\/span>/)![0];
    expect(track(409)).toBe('<span class="trk" role="img" aria-label="Stage 4 of 7: Fixing"><i class="on"></i><i class="on"></i><i class="on"></i><i class="now"></i><i class=""></i><i class=""></i><i class=""></i></span>');
    expect(track(417)).toContain('<i class="now"></i><i class=""></i>'); // the first: nothing before it
    expect(track(412)).toMatch(/^<span class="trk good" role="img" aria-label="Stage 6 of 7: Ready">/);
    expect(track(403)).toMatch(/^<span class="trk good" role="img" aria-label="Stage 7 of 7: Merged">/);
    expect(track(407)).not.toContain('good'); // Gate is not done
  });

  it('each session Live shows is a link to it, with the project kept in the link; one that is not in Live is counted, not linked', () => {
    const html = band(data(), ['s-409a']);
    const r409 = rowOf(html, 409);
    expect(r409).toContain('<a href="#/live?session=s-409a&amp;project=mobile-app">Live</a>');
    expect(r409).not.toContain('s-409b&'); // the second is not in Live: no link
    expect(plain(r409)).toContain('Sessions Live 1 earlier');
    expect(rowOf(html, 415)).not.toContain('<a href'); // none of its sessions is in Live
    expect(plain(rowOf(html, 415))).toContain('Sessions 1 earlier');
  });

  it('the sessions the row lists are the newest; those it does not list are counted too', () => {
    const html = band(data({ issues: [issue(5, { sessions: [sess('s-new')], sessionCount: 14 })] }), ['s-new']);
    expect(plain(rowOf(html, 5))).toContain('Sessions Live 13 earlier');
  });

  it('more than one session in Live: each link says which, by the start of the session\'s id', () => {
    const html = band(data(), ['s-409a', 's-409b']);
    expect(rowOf(html, 409)).toContain('>Live s-409a</a>');
    expect(rowOf(html, 409)).toContain('>Live s-409b</a>');
    expect(rowOf(band(data({ issues: [issue(5, { sessions: [sess('3f9a1c77-aaaa-bbbb-cccc-000000000000')], sessionCount: 1 })] }), ['3f9a1c77-aaaa-bbbb-cccc-000000000000']), 5)).toContain('>Live</a>');
    const two = band(data({ issues: [issue(5, { sessions: [sess('3f9a1c77-aaaa'), sess('b81d2e55-bbbb')], sessionCount: 2 })] }), ['3f9a1c77-aaaa', 'b81d2e55-bbbb']);
    expect(two).toContain('>Live 3f9a1c</a>');
    expect(two).toContain('>Live b81d2e</a>');
  });

  it('a project name with a space or a slash travels in the link whole', () => {
    const html = renderToStaticMarkup(createElement(BoardBand, { data: data({ project: 'my app/v2', issues: [ALL[1]!] }), live: new Set(['s-415']), openable: new Set<number>(), onOpen: () => {} }));
    expect(html).toContain('href="#/live?session=s-415&amp;project=my%20app%2Fv2"');
  });

  // R6: the plugin cannot tell a background session (a real `claude --bg` one is recorded as interactive), so no row marks one; the band says once where they are answered
  it('no row says "agent view": every session links to Live, and the footer names where a background one is answered', () => {
    const html = band(data());
    for (const r of rows(html)) expect(r).not.toContain('agent view');
    expect(html).not.toContain('Background session');
    expect(plain(html)).toContain('Agent view lists sessions. This lists issues, with what each has spent and how far it is from your ok.');
    expect(html).toContain('<code>claude agents</code>');
    expect(html.match(/Agent view lists sessions/g)).toHaveLength(1);
  });

  it('the board does not repeat a session\'s state: no working, waiting or stalled word, and no cost of the session', () => {
    const t = plain(band(data()));
    expect(t).not.toMatch(/\b(working|waiting|stalled|idle)\b/i);
  });

  it('readiness: slice 1\'s reason when the PR is not ready, "Ready for your ok" when it is, "No PR yet" with none, and the merge for a merged one', () => {
    const html = band(data());
    expect(rowOf(html, 409)).toContain('<span class="why no">2 findings open: 1 major, 1 minor</span>');
    expect(rowOf(html, 412)).toContain('<span class="why yes">Ready for your ok</span>');
    expect(rowOf(html, 415)).toContain('<span class="why none">No PR yet</span>');
    expect(rowOf(html, 403)).toContain('<span class="why none">Merged</span>');
  });

  it('cost is slice 2\'s cell: the figure, a bar the server\'s mark colours, and nothing worked out here', () => {
    const html = band(data());
    expect(rowOf(html, 409)).toContain('class="bar warn"');
    expect(rowOf(html, 407)).toContain('class="bar over"');
    expect(rowOf(html, 412)).toContain('class="bar"');
    expect(rowOf(html, 398)).not.toContain('class="bar');
    expect(plain(rowOf(html, 398))).toContain('$27.00 No budget set');
    const partial = band(data({ issues: [issue(5)] }), [], [], { cost: new Map([[5, ic(5, 12, 150, null, true)]]) });
    expect(plain(partial)).toContain('≥ $12.00 of $150.00');
  });

  it('until the budget has been read the cost cells and the "not on an issue" line are left out, rather than saying "nothing spent" for what is not known', () => {
    const html = band(data(), undefined, undefined, { cost: undefined, notOnIssue: undefined });
    expect(plain(html)).not.toContain('Cost, estimate Nothing spent');
    expect(plain(body(html))).not.toMatch(/\$\d|Nothing spent|No budget/);
    expect(plain(html)).not.toContain('Not on an issue');
    expect(plain(rowOf(html, 409))).toContain('Fixing Ready 2 findings open: 1 major, 1 minor Sessions Live s-409a Live s-409b'); // the rest of the row stands
  });

  it('an issue with an open PR opens the PR\'s sheet; one with none, or a merged one, is only text', () => {
    const html = band(data(), undefined, [405, 411, 416, 414, 418]); // 405 is held too, as a number: only an open PR has a sheet
    expect(rowOf(html, 409)).toContain('<button type="button" class="open"');
    expect(rowOf(html, 415)).not.toContain('<button');
    expect(rowOf(html, 403)).not.toContain('<button');
    expect(rowOf(band(data(), undefined, []), 409)).not.toContain('<button'); // the PR is not among the open ones the page holds
  });

  it('the header says how many issues, and how many are in flight outside the milestone; the milestone is named', () => {
    const t = plain(band(data()));
    expect(t).toContain('Board · v2.3 Offline 6 issues, plus 1 in flight outside it');
    expect(plain(band(data({ issues: ALL.filter((i) => !i.outside) })))).toContain('Board · v2.3 Offline 6 issues');
    expect(plain(band(data({ issues: ALL.filter((i) => !i.outside) })))).not.toContain('in flight');
    expect(plain(band(data({ issues: [ALL[0]!] })))).toContain('1 issue');
  });

  it('"not on an issue" is the line slice 2 computes: this month\'s, a floor when a request had no price', () => {
    expect(plain(band(data()))).toContain('Not on an issue: $1240.00 this month');
    expect(plain(band(data(), undefined, undefined, { notOnIssue: { usd: 15, partial: true } }))).toContain('Not on an issue: ≥ $15.00 this month');
    expect(plain(band(data()))).toContain("Sessions with no PR, and turns after a session's last PR. Cost is an estimate by time windows.");
  });

  it('titles show with Content on full; without, the row is the number, and the band says why once', () => {
    const untitled = ALL.map(({ title: _t, ...i }) => i as BoardIssue);
    const html = band(data({ issues: untitled, content: 'off' }));
    expect(plain(rowOf(html, 417))).toMatch(/^#417 No PR/);
    expect(plain(html)).toContain('Issue titles show with Content on full.');
    expect(plain(band(data()))).not.toContain('Issue titles show with Content on full.');
    expect(plain(rowOf(band(data()), 417))).toMatch(/^#417 Clear the cache on sign-out/);
  });

  it('with Content on full an issue no read has seen has no title, and the band does not say Content is the reason (R3)', () => {
    const html = band(data({ issues: [issue(417, { title: 'Clear the cache' }), issue(399, { outside: true })], content: 'full' }));
    expect(plain(html)).not.toContain('Issue titles show with Content on full');
    expect(titlesNote(data({ issues: [issue(399)], content: 'full' }))).toBeNull();
    expect(titlesNote(data({ issues: [issue(399)], content: null }))).toBe('Issue titles show with Content on full.'); // no session has said: the likely reason
    expect(titlesNote(data({ issues: [issue(417, { title: 'x' })], content: 'off' }))).toBeNull(); // every row is titled: nothing to explain
  });

  it('an excluded project is not told to turn Content on: it is told it is excluded (R14)', () => {
    const html = band(data({ issues: [issue(399, { outside: true })], content: 'excluded', milestone: null, milestones: [] }));
    expect(plain(html)).toContain('This project is in excludeProjects: issues show by number.');
    expect(plain(html)).not.toContain('Content on full');
    const empty = plain(band(data({ issues: [], content: 'excluded', milestone: null, milestones: [] })));
    expect(empty).toContain('This project is in excludeProjects, so the plugin sends no milestones');
    expect(empty).not.toContain('No open issue has a milestone');
  });

  it('an issue outside the milestone says so, with the milestone it is in, that it is in none when it has none, and nothing about it when no read has seen it (R3)', () => {
    const html = band(data({ issues: [issue(398, { outside: true, milestone: 'v2.2.1', stage: 'building' }), issue(399, { outside: true, milestone: null, stage: 'building' }), issue(397, { outside: true, milestone: undefined, stage: 'building' })] }));
    expect(plain(rowOf(html, 398))).toContain('outside this milestone, v2.2.1');
    expect(plain(rowOf(html, 399))).toContain('outside this milestone, in none');
    expect(plain(rowOf(html, 397))).toMatch(/outside this milestone Building/);
    expect(plain(rowOf(html, 397))).not.toContain('in none');
  });

  it('with no milestone chosen nothing is "outside" or "in none" and the header does not count 0 issues (R14)', () => {
    const only = [issue(398, { outside: true, milestone: null, stage: 'building' }), issue(399, { outside: true, milestone: 'v2.2.1', stage: 'building' })];
    const html = band(data({ milestone: null, milestones: [], issues: only }));
    expect(plain(html)).toContain('Board 2 in flight');
    expect(plain(html)).not.toContain('0 issues');
    expect(plain(html)).not.toContain('outside');
    expect(plain(html)).not.toContain('in none');
    expect(plain(rowOf(html, 398))).toContain('No PR · in flight Building');
    expect(plain(rowOf(html, 399))).toContain('No PR · in flight, v2.2.1 Building');
    expect(outsideNote(issue(5), 'v2')).toBe(''); // an issue inside the milestone says nothing
  });

  it('a merged row is greyed; the others are not', () => {
    const html = band(data());
    expect(rowOf(html, 403)).toMatch(/^<div class="brow merged"/);
    expect(rowOf(html, 409)).toMatch(/^<div class="brow"/);
  });

  it('with nothing to follow it says why: no milestone read yet, or nothing open in the chosen one', () => {
    expect(plain(band(data({ milestone: null, milestones: [], issues: [], content: 'off' })))).toContain('No open issue has a milestone');
    expect(plain(band(data({ issues: [] })))).toContain('No open issue in v2.3 Offline, and none in flight.');
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

describe('the Board band when the board could not be read (R8)', () => {
  const noBoard = (error: string, extra: Partial<Parameters<typeof BoardBand>[0]> = {}) => renderToStaticMarkup(createElement(BoardBand, { error, live: new Set<string>(), openable: new Set<number>(), cost: COSTS, notOnIssue: { usd: 1240, partial: false }, onOpen: () => {}, ...extra }));

  it('says so, and still shows what this month spent on no issue, which is the budget read\'s and not the board\'s', () => {
    const t = plain(noBoard('The server answered 500.'));
    expect(t).toContain('The board could not be read: The server answered 500.');
    expect(t).toContain('Not on an issue: $1240.00 this month');
    expect(plain(noBoard('x', { notOnIssue: undefined }))).not.toContain('Not on an issue'); // the budget read failed too, or has not come yet
  });

  it('shows the error above the last good rows of the milestone asked for, rather than hiding it', () => {
    const html = renderToStaticMarkup(createElement(BoardBand, { data: data(), error: 'The server answered 502.', live: new Set<string>(), openable: new Set<number>(), cost: COSTS, onOpen: () => {} }));
    expect(plain(html)).toContain('The board could not be read: The server answered 502.');
    expect(rows(html)).toHaveLength(ALL.length);
  });

  it('an empty board that also failed says the error, not "none in flight"', () => {
    const html = renderToStaticMarkup(createElement(BoardBand, { data: data({ issues: [] }), error: 'x', live: new Set<string>(), openable: new Set<number>(), onOpen: () => {} }));
    expect(plain(html)).not.toContain('none in flight');
  });
});

describe('the stage track\'s tone (R13)', () => {
  const track = (i: BoardIssue) => rowOf(band(data({ issues: [i] })), i.number).match(/<span class="trk[^"]*"[^>]*>/)![0];

  it('a failed gate turns the stage red and says so to a screen reader; a passing one does not', () => {
    expect(track(issue(407, { stage: 'gate', bad: true }))).toBe('<span class="trk bad" role="img" aria-label="Stage 5 of 7: Gate, failed">');
    expect(track(issue(407, { stage: 'gate' }))).toBe('<span class="trk" role="img" aria-label="Stage 5 of 7: Gate">');
  });

  it('ready and merged are green whatever else', () => {
    expect(track(issue(412, { stage: 'ready', bad: true }))).toMatch(/^<span class="trk good"/);
  });
});
