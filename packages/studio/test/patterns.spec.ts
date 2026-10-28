import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NAMED_SHAPES } from '../../shared/src/index.ts';
import { Analysis } from '../src/Analysis.tsx';
import { PatternsBody } from '../src/Patterns.tsx';
import type { PatternsData, Repeat } from '../src/patterns-math.ts';
import { figs } from './figs.ts';

// The Analysis page: Patterns (v0.3 slice 3, #45, design/v0.3-worth-truth.html) and the switch to Reports. The page is rendered to markup, which runs no effects:
// what is drawn from data is checked here, and the fetching around it is the thin part of Patterns.tsx.

const repeat = (over: Partial<Repeat>): Repeat => ({ shape: 'h:00000000', tool: 'Bash', errorClass: 'exit_code', commandClass: null, count: 3, sessions: 1, lastAt: 0, sample: null, ...over });
// mobile-app over 10 weeks, as the mock draws it: the kinds add up to the failed calls, the commands to the exit codes.
const data = (over: Partial<PatternsData> = {}): PatternsData => ({
  calls: 46473, failed: 1136,
  kinds: [
    { errorClass: 'exit_code', count: 925, commands: [['other', 637], ['test', 90], ['gh', 61], ['git', 53], ['docker', 38], ['build', 35], ['lint', 9], ['install', 2]].map(([commandClass, count]) => ({ commandClass: commandClass as string, count: count as number })) },
    { errorClass: 'not_found', count: 62 }, { errorClass: 'timeout', count: 53 }, { errorClass: 'refused', count: 35 }, { errorClass: 'no_match', count: 22 },
    { errorClass: 'read_first', count: 7 }, { errorClass: 'invalid_input', count: 4 }, { errorClass: 'unknown_command', count: 4 }, { errorClass: 'other', count: 24 },
  ],
  repeats: [], testsEditedAfterFailure: { count: 19, sessions: 6 },
  // v0.3 slice 4 (#44): mobile-app's 106 test claims, none unbacked, in every one of its sessions with Content on full
  claims: { sessions: 15, checked: 15, test: { total: 106, unbacked: 0 }, build: { total: 0, unbacked: 0 }, edit: { total: 0, unbacked: 0 } },
  ...over,
});
const board = (d: PatternsData) => renderToStaticMarkup(createElement(PatternsBody, { project: 'mobile-app', data: d }));
/** What a person reads: tags gone, entities decoded, white space collapsed. */
const read = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const rows = (html: string) => [...html.matchAll(/<li class="repeat">.*?<\/li>/gs)].map((m) => m[0]);

describe('the figures', () => {
  const shape = (d: PatternsData) => figs(board(d)).map((f) => [f.label, f.value, f.usual]);

  it('five of them, from the counts, in the figure shape: the failed calls with their share, the two kinds worth fixing, the test files changed after a failure, the unbacked claims', () => {
    expect(shape(data())).toEqual([
      ['Calls that failed', '1,136', 'of 46,473 tool calls (2.4%). Usual: under 4% is normal.'],
      ["Paths that weren't there", '62', 'Rare: 1 in 750 calls.'],
      ['Edits that missed', '22', 'Rare: 1 in 2,112 calls.'],
      ['Test files changed right after a failing run', '19', 'In 6 sessions. Worth a look, not a worry.'],
      ['Unbacked claims', '0', 'of 106 test claims'],
    ]);
    expect(figs(board(data())).some((f) => f.bad)).toBe(false); // nothing unbacked: no red
  });

  it('each one carries its explanation, closed, behind an ⓘ that names it', () => {
    const html = board(data());
    const all = figs(html);
    expect(all.every((f) => f.why.length > 40 && !f.open)).toBe(true);
    expect(html).toContain('aria-label="What Edits that missed means"');
    expect(all.find((f) => f.label === 'Edits that missed')!.why).toBe('An agent tried to replace text that was not in the file, usually because the file had changed since it last read it.');
  });

  it('a failure rate from 4% on is not usual, and says so', () => {
    expect(figs(board(data({ failed: 2000, calls: 46473 })))[0]!.usual).toBe('of 46,473 tool calls (4.3%). More than usual: under 4% is normal.');
    expect(figs(board(data({ failed: 1859, calls: 46473 })))[0]!.usual).toContain('(4.0%). More than usual'); // 4% itself is not under it
  });

  it('a kind is rare under 1 call in 100, and not rare from there; one that never happened reads 0 and says none', () => {
    const kinds = [{ errorClass: 'not_found', count: 600 }, { errorClass: 'no_match', count: 0 }];
    const [, paths, edits] = figs(board(data({ failed: 600, calls: 60_000, kinds })));
    expect(paths!.usual).toBe('Not rare: 1 in 100 calls.'); // 1 in 100 is 1%, which is not under it
    expect([edits!.value, edits!.usual]).toEqual(['0', 'None in 60,000 calls.']);
    expect(figs(board(data({ failed: 59, calls: 60_000, kinds: [{ errorClass: 'not_found', count: 59 }] })))[1]!.usual).toBe('Rare: 1 in 1,017 calls.');
  });

  it('a share too small to show one decimal says so, and tests changed in no session say none', () => {
    const [failed, , , tests] = figs(board(data({ failed: 2, calls: 100_000, kinds: [{ errorClass: 'timeout', count: 2 }], testsEditedAfterFailure: { count: 0, sessions: 0 } })));
    expect(failed!.usual).toBe('of 100,000 tool calls (<0.1%). Usual: under 4% is normal.');
    expect([tests!.value, tests!.usual]).toEqual(['0', 'None.']);
  });

  it('opens with a reading, written from the figures: the failure rate on its own, then the repeats', () => {
    const html = board(data({ repeats: [repeat({ shape: 'sleep_blocked', count: 155, sessions: 4 })] }));
    expect(html.indexOf('aria-label="Reading"')).toBeLessThan(html.indexOf('class="fig"')); // on top of the figures
    expect(read(/<section class="card said"[^>]*>.*?<\/section>/s.exec(html)![0])).toBe(
      " 2.4% of mobile-app's tool calls failed, which on its own is normal. The repeats below are worth your time: each happens again and again, and a Try line is a rule you can change. Written from the figures below; it changes with them. ");
  });

  it('the reading changes with the figures: a rate from 4% is more than usual, and with no repeat to read there is no line about them', () => {
    const text = read(/<section class="card said"[^>]*>.*?<\/section>/s.exec(board(data({ failed: 5000, calls: 46473 })))![0]);
    expect(text).toContain("10.8% of mobile-app's tool calls failed, which on its own is more than usual.");
    expect(text).not.toContain('The repeats below');
  });

  it('the figures are the only place the old tiles were: no kpi, no stats6', () => {
    expect(board(data())).not.toMatch(/class="(kpi|stats6)/);
  });
});

describe('the unbacked claims figure (#44)', () => {
  const claims = (over: Partial<PatternsData['claims']>) => data({ claims: { ...data().claims, ...over } });
  const card = (d: PatternsData) => figs(board(d)).find((f) => f.label === 'Unbacked claims')!;

  it('N of M test claims, N in red when it is above 0', () => {
    expect(card(claims({ test: { total: 106, unbacked: 3 } }))).toMatchObject({ value: '3', usual: 'of 106 test claims', bad: true });
    expect(card(claims({ test: { total: 1, unbacked: 0 } })).usual).toBe('of 1 test claim'); // the singular
  });

  it('the builds and the edits are beside it when there are any; an unbacked one of those makes the number red too', () => {
    const c = card(claims({ test: { total: 60, unbacked: 0 }, build: { total: 28, unbacked: 1 }, edit: { total: 2, unbacked: 0 } }));
    expect(c).toMatchObject({ value: '0', usual: 'of 60 test claims · builds 1 of 28 · edits 0 of 2', bad: true });
  });

  it('some sessions checked and some not says how many: the count is of those, not of all', () => {
    expect(card(claims({ sessions: 15, checked: 4 })).usual).toContain('of 106 test claims · 4 of 15 sessions checked');
  });

  it('a project with no session on Content full reads "not checked", never 0', () => {
    expect(card(claims({ sessions: 15, checked: 0, test: { total: 0, unbacked: 0 } }))).toMatchObject({ value: 'not checked', usual: 'Content is not on full in any session', bad: false });
  });

  it('is there for a project with no failed call too, and says whether its claims were checked', () => {
    const html = renderToStaticMarkup(createElement(PatternsBody, { project: 'mobile-app', data: data({ failed: 0, calls: 812, kinds: [], claims: { ...data().claims, test: { total: 5, unbacked: 2 } } }) }));
    expect(read(html)).toContain('Nothing has failed in mobile-app.');
    expect(figs(html).map((f) => [f.label, f.value, f.usual])).toEqual([['Unbacked claims', '2', 'of 5 test claims']]);
  });

  it('says how claims are checked in its own ⓘ, where the page used to say it at the bottom', () => {
    expect(card(data()).why).toContain("an agent's final answer and every subagent's report are read for test, build and edit claims");
  });
});

describe('the repeats', () => {
  it('a named shape has its title, what happened, how often and a Try line', () => {
    const html = board(data({ repeats: [repeat({ shape: 'sleep_blocked', errorClass: 'refused', count: 155, sessions: 4 })] }));
    const [row] = rows(html);
    expect(read(row!)).toBe(' Waiting with sleep, blocked Agents waited with sleep , then read a log or a status; Claude Code blocks it. 155 · 4 sessions Try: Tell agents to run long jobs in the background and wait for the notification. ');
    expect(row).toContain('<code>sleep</code>'); // the backticked words are code
  });

  it('one session is not "1 sessions"', () => {
    expect(read(rows(board(data({ repeats: [repeat({ shape: 'hook_blocked', count: 63, sessions: 1 })] })))[0]!)).toContain('63 · 1 session ');
  });

  it('every shape the plugin names has a title and a Try line of its own', () => {
    const rs = rows(board(data({ repeats: NAMED_SHAPES.map((shape) => repeat({ shape })) })));
    expect(NAMED_SHAPES).toHaveLength(9);
    expect(rs).toHaveLength(9);
    expect(new Set(rs.map((r) => /<b>(.*?)<\/b>/.exec(r)![1])).size).toBe(9);
    expect(new Set(rs.map((r) => /class="try">(.*?)<\/span>/.exec(r)![1])).size).toBe(9);
  });

  it('outside_worktree: "Refused inside a worktree", what happened and what to try', () => {
    expect(read(rows(board(data({ repeats: [repeat({ shape: 'outside_worktree', errorClass: 'refused', count: 50, sessions: 1 })] })))[0]!)).toBe(
      " Refused inside a worktree An agent isolated in a worktree ran a command Claude Code couldn't verify stays inside it, most often a chained or computed git call. 50 · 1 session Try: Tell agents to run commands from the worktree itself, as plain separate commands. ",
    );
  });

  it('a hash shape has the tool and the kind, the sample under it in code style, and no Try line', () => {
    const html = board(data({ repeats: [repeat({ shape: 'h:3fa91c20', commandClass: 'test', count: 12, sessions: 2, sample: 'FAIL src/lib/plan.test.ts' })] }));
    const [row] = rows(html);
    expect(read(row!)).toBe(' Bash: a test run failed FAIL src/lib/plan.test.ts 12 · 2 sessions ');
    expect(row).toContain('<code>FAIL src/lib/plan.test.ts</code>');
    expect(html).not.toContain('Try:');
  });

  it('says the kind in words: the command class for an exit code, the class itself for the rest', () => {
    const text = (r: Partial<Repeat>) => read(rows(board(data({ repeats: [repeat({ sample: 'x', ...r })] })))[0]!);
    expect(text({ tool: 'Read', errorClass: 'not_found' })).toBe(' Read: a path that doesn\'t exist x 3 · 1 session ');
    expect(text({ commandClass: 'build' })).toContain('Bash: a build failed');
    expect(text({ commandClass: 'install' })).toContain('Bash: an install failed');
    expect(text({ commandClass: null })).toContain('Bash: a command failed');
    expect(text({ tool: 'Edit', errorClass: 'no_match' })).toContain("Edit: an edit whose text wasn't in the file");
  });

  it('a shape this studio does not know is a hash shape, and a shape named like an object\'s own property is not a named one', () => {
    for (const shape of ['brand_new_shape', 'constructor', 'toString']) {
      const html = board(data({ repeats: [repeat({ shape, tool: 'WebFetch', errorClass: 'timeout', sample: 'x' })] }));
      expect(read(rows(html)[0]!)).toBe(' WebFetch: a timeout x 3 · 1 session ');
      expect(html).not.toContain('Try:');
    }
  });

  it('a Try line only on the named ones, in a mixed list', () => {
    const html = board(data({ repeats: [repeat({ shape: 'sleep_blocked', count: 9 }), repeat({ shape: 'h:1', count: 5, sample: 'FAIL x' }), repeat({ shape: 'gh_projects_classic', count: 3 })] }));
    expect(rows(html).map((r) => r.includes('class="try"'))).toEqual([true, false, true]);
    expect(html.match(/Try:/g)).toHaveLength(2);
  });

  // The same failure that has no name and no first line to show says nothing a person can act on ("Bash: a command failed", twice): it is one line, not a row.
  it('unnamed repeats with no sample are one closing line and no rows, with how often each repeats, most first', () => {
    const html = board(data({ repeats: [38, 16, 12, 11, 11].map((count, i) => repeat({ shape: `h:${i}`, count })) }));
    expect(rows(html)).toHaveLength(0);
    expect(read(html)).toContain('5 more failures repeat with no name (38, 16, 12, 11 and 11 times). With Content on full, their first line shows here.');
    expect(html.match(/with no name/g)).toHaveLength(1);
    expect(read(html)).not.toContain('Nothing fails the same way'); // they do: the line says so
    expect(read(html)).not.toContain('Bash: a command failed');
    expect(read(board(data({ repeats: [repeat({ shape: 'h:1', count: 38 }), repeat({ shape: 'h:2', count: 16 })] })))).toContain('2 more failures repeat with no name (38 and 16 times). With Content on full, their first line shows here.');
  });

  it('one of them is in the singular', () => {
    expect(read(board(data({ repeats: [repeat({ shape: 'h:1', count: 1234 })] })))).toContain('1 more failure repeats with no name (1,234 times). With Content on full, its first line shows here.');
  });

  it('an unnamed repeat with a sample keeps its row, and only the others fold; a named one keeps its row with or without a sample', () => {
    const html = board(data({ repeats: [
      repeat({ shape: 'h:1', count: 38 }), repeat({ shape: 'h:2', count: 16, sample: 'FAIL src/lib/plan.test.ts' }), repeat({ shape: 'sleep_blocked', count: 12 }), repeat({ shape: 'h:3', count: 5 }),
    ] }));
    expect(rows(html).map((r) => read(r).trim().split(' ').slice(0, 2).join(' '))).toEqual(['Bash: a', 'Waiting with']);
    expect(rows(html)[0]).toContain('<code>FAIL src/lib/plan.test.ts</code>');
    expect(read(html)).toContain('2 more failures repeat with no name (38 and 5 times).');
  });

  it('no closing line when every repeat has a row', () => {
    expect(board(data({ repeats: [repeat({ shape: 'sleep_blocked' }), repeat({ shape: 'h:1', sample: 'x' })] }))).not.toContain('with no name');
    expect(board(data())).not.toContain('with no name');
  });

  it('none says so, in plain words', () => {
    expect(read(board(data()))).toContain('Nothing fails the same way three times yet.');
    expect(rows(board(data()))).toHaveLength(0);
  });
});

describe('the kinds', () => {
  const table = (d: PatternsData) => [...board(d).matchAll(/<tr( class="sub")?><td>(.*?)<\/td><td class="r num">(.*?)<\/td><td class="bc"><div class="bar" aria-hidden="true"><i style="width:(.*?)%"/g)]
    .map((m) => [m[2]!.replace(/&#x27;/g, "'"), m[3]!, !!m[1], Number(m[4])] as const);

  it('one row per kind with the mock\'s labels, the exit code\'s commands indented under it', () => {
    expect(table(data()).map(([label, count, sub]) => [label, count, sub])).toEqual([
      ['A command failed', '925', false], ['other commands', '637', true], ['tests', '90', true], ['gh', '61', true], ['git', '53', true], ['docker', '38', true], ['builds', '35', true], ['lint', '9', true], ['installs', '2', true],
      ["A path that doesn't exist", '62', false], ['A timeout', '53', false], ['Refused (permission, a hook or the classifier)', '35', false],
      ["An edit whose text wasn't in the file", '22', false], ['Written before it was read', '7', false], ['Invalid input', '4', false], ["A command that doesn't exist", '4', false], ['Other', '24', false],
    ]);
  });

  it('the bars are on the biggest kind\'s scale, and a tiny one is still a sliver', () => {
    const widths = Object.fromEntries(table(data()).map(([label, , , w]) => [label, w]));
    expect(widths['A command failed']).toBe(100);
    expect(widths['tests']).toBeCloseTo((90 / 925) * 100, 6);
    expect(widths['installs']).toBe(2); // 0.2% would not show
  });

  it('a kind or command this studio does not know is shown by its own name', () => {
    const rs = table(data({ kinds: [{ errorClass: 'exit_code', count: 3, commands: [{ commandClass: 'terraform', count: 3 }] }, { errorClass: 'quota', count: 1 }] }));
    expect(rs.map(([label]) => label)).toEqual(['A command failed', 'terraform', 'quota']);
  });

  it('a kind with commands is the only one to have sub-rows', () => {
    expect(table(data()).filter(([, , sub]) => sub)).toHaveLength(8);
  });
});

describe('the states', () => {
  const body = (props: { data?: PatternsData; error?: string }) => read(renderToStaticMarkup(createElement(PatternsBody, { project: 'mobile-app', ...props })));

  it('loading says so, and shows no numbers', () => {
    expect(body({})).toBe(' Reading the failures… ');
  });

  it('an error says so, with the server\'s words, and not the numbers it had', () => {
    const text = body({ error: 'no such project', data: data() });
    expect(text).toBe(' Patterns could not load. no such project ');
  });

  it('a project with no failures says so, and has no failure figures or tables of zeros: only whether its claims were checked', () => {
    const none = { count: 0, sessions: 0 };
    const page = (d: PatternsData) => renderToStaticMarkup(createElement(PatternsBody, { project: 'mobile-app', data: d }));
    const html = page(data({ failed: 0, calls: 812, kinds: [], testsEditedAfterFailure: none }));
    expect(read(html.slice(0, html.indexOf('<section')))).toBe(' Nothing has failed in mobile-app. 812 tool calls, and none of them failed. ');
    expect(figs(html).map((f) => [f.label, f.value])).toEqual([['Unbacked claims', '0']]);
    const unchecked = page(data({ failed: 0, calls: 0, kinds: [], claims: { ...data().claims, checked: 0 } }));
    expect(read(unchecked.slice(0, unchecked.indexOf('<section')))).toBe(' Nothing has failed in mobile-app. No tool calls are recorded for it yet. ');
    expect(figs(unchecked).map((f) => [f.value, f.usual])).toEqual([['not checked', 'Content is not on full in any session']]);
  });

  it('with failures it explains how patterns are found, under the table; how claims are checked is in the claims figure now', () => {
    const text = body({ data: data() });
    expect(text).toContain('How patterns are found');
    expect(text).not.toContain('How claims are checked');
  });
});

describe('the Analysis switch', () => {
  const page = (initial?: 'patterns' | 'reports') => renderToStaticMarkup(createElement(Analysis, { initial }));
  const mains = (html: string) => [...html.matchAll(/<main class="(\w+)"( hidden="")?>/g)].map((m) => [m[1], !!m[2]]);
  const pressed = (html: string) => [...html.matchAll(/<button type="button" aria-pressed="(true|false)">(.*?)<\/button>/g)].map((m) => [m[2], m[1] === 'true']);

  it('opens on Patterns, with Reports not loaded yet', () => {
    const html = page();
    expect(mains(html)).toEqual([['patterns', false]]);
    expect(pressed(html)).toEqual([['Patterns', true], ['Reports', false]]);
    expect(html).toContain('aria-label="Analysis view"');
  });

  it('shows Reports: its own header and sub, with the period in the header, New analysis and Reports cards, the cap line and the explainer; Patterns is kept, hidden', () => {
    const html = page('reports');
    expect(mains(html)).toEqual([['patterns', true], ['analysis', false]]);
    expect(pressed(html).slice(-2)).toEqual([['Patterns', false], ['Reports', true]]);
    const text = read(html.slice(html.indexOf('<main class="analysis"')));
    for (const part of [
      'Analysis Claude reads a week and suggests what to change', 'Last 7 days Last 30 days One session',
      'New analysis nothing is sent until you confirm', 'Model', 'Estimate', 'Monthly cap', 'every run is a line in the Ledger',
      'Reports 0 so far', 'No analysis yet. The first one appears here once you confirm it.', 'When an analysis runs',
    ]) expect(text).toContain(part);
  });

  it('puts the switch in the header of both views', () => {
    expect(page('reports').match(/aria-label="Analysis view"/g)).toHaveLength(2);
  });
});
