import { describe, expect, it } from 'vitest';
import { Event } from '../../shared/src/index.ts';
import { build, parsePrs, prNumbersIn, prsArgv, type Ctx } from '../hooks/core.ts';

// v0.3 slice 2 (#42, Worth): the merged PRs of the past 90 days, read once at session start with `gh`, and the PR links a tool's output shows.
const ctx: Ctx = { host: 'mbp', session_id: 's-1', project: { cwd: '/r', name: 'r', git_remote: 'github.com/o/r' } };

// `gh pr list --state merged --json number,title,mergedAt,additions,deletions,headRefName` as gh prints it (keys sorted, one line).
const GH = JSON.stringify([
  { additions: 152, deletions: 8, headRefName: 'fix/63-masking', mergedAt: '2026-10-26T08:34:07Z', number: 72, title: 'fix(mod): mask the secret shapes' },
  { additions: 1030, deletions: 24, headRefName: 'feat/43-classes', mergedAt: '2026-10-26T10:56:13Z', number: 73, title: 'feat: v0.3 slice 1' },
  { additions: 130, deletions: 3, headRefName: 'fix/62-host-check', mergedAt: '2026-10-25T09:00:00Z', number: 71, title: 'fix(server): refuse a request' },
]);

describe('prsArgv', () => {
  it('asks gh for the PRs merged since 90 days ago (a UTC date), at most 500, with the six fields and the files (#103)', () => {
    expect(prsArgv(Date.UTC(2026, 9, 26, 12))).toEqual([
      'gh', 'pr', 'list', '--state', 'merged', '--search', 'merged:>=2026-07-28', '--limit', '500', '--json', 'number,title,mergedAt,additions,deletions,headRefName,files',
    ]);
  });

  it('counts the days across a month and a year, not 30-day months', () => {
    expect(prsArgv(Date.UTC(2026, 2, 1))[6]).toBe('merged:>=2025-12-01');
    expect(prsArgv(Date.UTC(2026, 2, 1, 23, 59))[6]).toBe('merged:>=2025-12-01');
  });
});

describe('parsePrs', () => {
  it('reads each PR: number, title, merge time in ms, lines and branch, newest merge first', () => {
    expect(parsePrs(GH)).toEqual([
      { number: 73, title: 'feat: v0.3 slice 1', merged_at: Date.parse('2026-10-26T10:56:13Z'), additions: 1030, deletions: 24, head: 'feat/43-classes' },
      { number: 72, title: 'fix(mod): mask the secret shapes', merged_at: Date.parse('2026-10-26T08:34:07Z'), additions: 152, deletions: 8, head: 'fix/63-masking' },
      { number: 71, title: 'fix(server): refuse a request', merged_at: Date.parse('2026-10-25T09:00:00Z'), additions: 130, deletions: 3, head: 'fix/62-host-check' },
    ]);
  });

  it('an excluded project sends neither a title nor a branch: those are text from the project', () => {
    const prs = parsePrs(GH, false);
    expect(prs.map((p) => p.number)).toEqual([73, 72, 71]);
    for (const p of prs) expect(Object.keys(p).sort()).toEqual(['additions', 'deletions', 'merged_at', 'number']);
    expect(JSON.stringify(prs)).not.toMatch(/masking|slice 1|refuse/);
  });

  it('no gh, a failing gh, a login prompt or anything that is not a list gives no PRs and no error', () => {
    for (const out of ['', 'dev\n', 'gh: command not found', 'To get started with GitHub CLI, please run:  gh auth login', '{}', 'null', '"x"', '42', '[', '{"message":"Bad credentials"}']) {
      expect(parsePrs(out), out).toEqual([]);
    }
  });

  it('skips an entry that is not a merged PR and keeps the rest', () => {
    const bad = [null, 7, 'x', [], {}, { number: 0, mergedAt: '2026-10-26T08:00:00Z' }, { number: -4, mergedAt: '2026-10-26T08:00:00Z' }, { number: 1.5, mergedAt: '2026-10-26T08:00:00Z' },
      { number: '9', mergedAt: '2026-10-26T08:00:00Z' }, { number: 9 }, { number: 9, mergedAt: null }, { number: 9, mergedAt: 'yesterday' }, { number: 9, mergedAt: '1970-01-01T00:00:00Z' }];
    const good = { number: 5, mergedAt: '2026-10-20T08:00:00Z', additions: 3, deletions: 1, headRefName: 'b', title: 't' };
    expect(parsePrs(JSON.stringify([...bad, good])).map((p) => p.number)).toEqual([5]);
  });

  it('what the schema would refuse is repaired or left out, so one odd PR never drops a whole batch: lines that are not counts read 0, an empty title or branch is left out, long ones are cut', () => {
    const odd = { number: 8, mergedAt: '2026-10-20T08:00:00Z', additions: -3, deletions: 'many', headRefName: '', title: '' };
    expect(parsePrs(JSON.stringify([odd]))).toEqual([{ number: 8, merged_at: Date.parse('2026-10-20T08:00:00Z'), additions: 0, deletions: 0 }]);
    const long = { ...odd, number: 9, additions: 1.7, title: 't'.repeat(900), headRefName: 'h'.repeat(900) };
    const [p] = parsePrs(JSON.stringify([long]));
    expect(p!.additions).toBe(0);
    expect(p!.title).toHaveLength(200);
    expect(p!.head).toHaveLength(200);
  });

  it('keeps the newest 500, and the JSON of the event inside the budget the server\'s 1 MB request allows, the oldest going first', () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ number: i + 1, mergedAt: new Date(1_790_000_000_000 + i * 60_000).toISOString(), additions: 1, deletions: 1, headRefName: 'b', title: 't' }));
    const prs = parsePrs(JSON.stringify(many));
    expect(prs).toHaveLength(500);
    expect(prs[0]!.number).toBe(600);
    expect(prs.at(-1)!.number).toBe(101);
    const fat = Array.from({ length: 500 }, (_, i) => ({ number: i + 1, mergedAt: new Date(1_790_000_000_000 + i * 60_000).toISOString(), additions: 1, deletions: 1, headRefName: '"'.repeat(200), title: '"'.repeat(200) })); // every quote doubles in JSON
    const kept = parsePrs(JSON.stringify(fat));
    expect(kept.length).toBeLessThan(500);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(250_000);
    expect(kept[0]!.number).toBe(500); // the newest stay
  });

  it('its output passes the shared schema unchanged', () => {
    const e = build.projectPrs(ctx, parsePrs(GH));
    const parsed = Event.safeParse(e);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toEqual(e);
  });
});

// #103 (Worth sizes): a PR's size is worked out from the lines and files that remain once lockfiles, images, build output and generated files are set aside.
// gh lists a PR's files as { path, additions, deletions }, at most 100 of them; only the two counts leave the machine, never a path.
const file = (path: string, additions: number, deletions = 0) => ({ path, additions, deletions });
const withFiles = (files: unknown, over: object = {}) => JSON.stringify([{ additions: 999, deletions: 99, headRefName: 'feat/x', mergedAt: '2026-10-26T08:34:07Z', number: 90, title: 'feat: x', files, ...over }]);

describe('parsePrs: the counted lines and files (#103)', () => {
  it('counts only the source files: a lockfile, an image and build output are set aside, and the PR\'s own totals are not what is counted', () => {
    const [p] = parsePrs(withFiles([
      file('pnpm-lock.yaml', 4000, 3000), file('assets/logo.png', 0, 0), file('dist/app.js', 800, 100), file('src/a.ts', 100, 20), file('src/b.ts', 30, 0), file('README.md', 5, 5),
    ]));
    expect(p).toMatchObject({ number: 90, additions: 999, deletions: 99, counted_lines: 160, counted_files: 3 });
  });

  it('the event carries the two counts and no path', () => {
    const e = build.projectPrs(ctx, parsePrs(withFiles([file('pnpm-lock.yaml', 10), file('src/secret/plan.ts', 7, 1), file('dist/app.js', 3)])));
    expect(Event.safeParse(e).error).toBeUndefined();
    const sent = (e.data as { prs: Record<string, unknown>[] }).prs[0]!;
    expect(sent).toMatchObject({ counted_lines: 8, counted_files: 1 });
    expect(JSON.stringify(e)).not.toMatch(/pnpm-lock|secret|plan\.ts|dist|app\.js/);
    expect(Object.keys(sent).sort()).toEqual(['additions', 'counted_files', 'counted_lines', 'deletions', 'head', 'merged_at', 'number', 'title']);
  });

  it('an excluded project sends the counts too: they are numbers, and still no title, branch or path', () => {
    const [p] = parsePrs(withFiles([file('src/a.ts', 3, 1), file('go.sum', 90)]), false);
    expect(Object.keys(p!).sort()).toEqual(['additions', 'counted_files', 'counted_lines', 'deletions', 'merged_at', 'number']);
    expect(p).toMatchObject({ counted_lines: 4, counted_files: 1 });
  });

  it('what is set aside is decided by the path alone, by this one list', () => {
    const set = [
      'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb', 'bun.lock', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', 'apps/web/pnpm-lock.yaml',
      'logo.png', 'a/b.JPG', 'photo.jpeg', 'x.gif', 'x.webp', 'x.avif', 'favicon.ico', 'icons/menu.svg',
      'dist/app.js', 'packages/x/dist/index.js', 'build/out.js', 'ios/build/App.o', 'coverage/lcov.info',
      'public/app.min.js', 'public/app.min.css', 'public/app.js.map',
      'src/api.generated.ts', 'src/__generated__/types.ts', 'src/__snapshots__/a.test.ts.snap',
    ];
    const kept = ['src/a.ts', 'README.md', 'src/rebuild/a.ts', 'src/distance.ts', 'src/builder.ts', 'src/coverage.ts', 'docs/lock-order.md', 'src/lockfile.ts', 'src/minify.ts', 'src/map.ts', 'src/maps/a.ts', 'src/imagemap.svg.ts', 'src/go.summary.ts', 'design/mock.html'];
    const [p] = parsePrs(withFiles([...set, ...kept].map((path) => file(path, 1))));
    expect(p).toMatchObject({ counted_files: kept.length, counted_lines: kept.length });
  });

  it('a PR whose files are all set aside counts nothing: 0 lines in 0 files, which is not the same as not knowing', () => {
    const [p] = parsePrs(withFiles([file('yarn.lock', 50), file('x.png', 0)]));
    expect(p).toMatchObject({ counted_lines: 0, counted_files: 0 });
  });

  it('a file with no lines (a rename, a binary) still counts as a file', () => {
    expect(parsePrs(withFiles([file('src/moved.ts', 0, 0), file('src/a.ts', 2)]))[0]).toMatchObject({ counted_lines: 2, counted_files: 2 });
  });

  it('no files from gh, or files that cannot be read, send no counts, so the server keeps the PR "not sized" rather than guess', () => {
    expect(parsePrs(JSON.stringify([{ number: 1, mergedAt: '2026-10-26T08:34:07Z', additions: 5, deletions: 1 }]))[0]).not.toHaveProperty('counted_lines');
    expect(parsePrs(withFiles(null))[0]).not.toHaveProperty('counted_files');
    expect(parsePrs(withFiles('x'))[0]).not.toHaveProperty('counted_files');
    expect(parsePrs(withFiles([]))[0]).not.toHaveProperty('counted_lines'); // 999 + 99 lines changed, yet no file listed: gh did not say which
    expect(parsePrs(withFiles([], { additions: 0, deletions: 0 }))[0]).toMatchObject({ counted_lines: 0, counted_files: 0 }); // nothing changed, nothing to list
  });

  it('an entry that is not a file is passed over, and a count that is not a count reads 0, so the schema never refuses the batch', () => {
    const [p] = parsePrs(withFiles([null, 7, 'x', {}, { path: 5 }, { path: 'src/a.ts', additions: -4, deletions: 'many' }, { path: 'src/b.ts', additions: 1.5, deletions: 2 }, file('src/c.ts', 3)]));
    expect(p).toMatchObject({ counted_files: 3, counted_lines: 5 }); // a.ts 0, b.ts 0 + 2, c.ts 3
    expect(Event.safeParse(build.projectPrs(ctx, [p!])).error).toBeUndefined();
  });

  it('gh lists at most 100 files a PR: a PR with more counts the 100 it was given, a floor, which a PR that large clears by far', () => {
    const [p] = parsePrs(withFiles(Array.from({ length: 100 }, (_, i) => file(`src/f${i}.ts`, 10, 0)), { additions: 34_187, deletions: 6 }));
    expect(p).toMatchObject({ counted_lines: 1000, counted_files: 100, additions: 34_187 });
  });

  it('its output passes the shared schema unchanged, counts included (the schema drops a key it does not name, so the parse must give back the same event)', () => {
    const e = build.projectPrs(ctx, parsePrs(withFiles([file('src/a.ts', 3, 1), file('yarn.lock', 90)])));
    const parsed = Event.safeParse(e);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toEqual(e);
  });

  it('500 PRs of 100 files each stay inside the event\'s budget: the counts are two numbers, never the files', () => {
    const files = Array.from({ length: 100 }, (_, i) => file(`packages/some/deep/path/src/module-${i}.ts`, 3, 1));
    const list = Array.from({ length: 500 }, (_, i) => ({ number: i + 1, mergedAt: new Date(1_790_000_000_000 + i * 60_000).toISOString(), additions: 400, deletions: 100, headRefName: 'feat/x', title: 'feat: x', files }));
    const kept = parsePrs(JSON.stringify(list));
    expect(kept).toHaveLength(500);
    expect(JSON.stringify(build.projectPrs(ctx, kept)).length).toBeLessThan(250_000);
  });
});

describe('prNumbersIn', () => {
  const remote = 'github.com/alfredo1996/agent-orb';
  it('finds the PR numbers this repository\'s pull URLs name, once each, in the order they appear', () => {
    const text = 'Creating pull request for feat/x into dev in alfredo1996/agent-orb\n\nhttps://github.com/alfredo1996/agent-orb/pull/74\nsee also https://github.com/alfredo1996/agent-orb/pull/70/files and again /pull/74 https://github.com/alfredo1996/agent-orb/pull/74#issuecomment-1';
    expect(prNumbersIn(text, remote)).toEqual([74, 70]);
  });

  it('a URL of another repository, another host, a branch-compare page or a lookalike is not this repository\'s PR', () => {
    for (const url of [
      'https://github.com/alfredo1996/mobile-app/pull/74', 'https://github.com/other/agent-orb/pull/74', 'https://gitlab.com/alfredo1996/agent-orb/pull/74',
      'https://github.com/alfredo1996/agent-orb/pull/new/feat/x', 'https://github.com/alfredo1996/agent-orb-fork/pull/74', 'https://github.com/xalfredo1996/agent-orb/pull/74',
      'https://github.com/alfredo1996/agent-orb/pulls', 'https://github.com/alfredo1996/agent-orb/pull/', 'https://github.com/alfredo1996/agent-orb/pull/0',
      'https://github.com/alfredo1996/agent-orb/pull/1234567890123',
    ]) expect(prNumbersIn(`opened ${url}`, remote), url).toEqual([]);
  });

  it('the owner and repository are matched without regard to case, and a dot in the remote is a dot', () => {
    expect(prNumbersIn('https://GitHub.com/Alfredo1996/Agent-Orb/pull/5', remote)).toEqual([5]);
    expect(prNumbersIn('https://github.com/o/r.js/pull/5', 'github.com/o/r.js')).toEqual([5]);
    expect(prNumbersIn('https://github.com/o/rxjs/pull/5', 'github.com/o/r.js')).toEqual([]);
  });

  it('a project with no remote links nothing, and neither does a text with no URL', () => {
    expect(prNumbersIn('https://github.com/alfredo1996/agent-orb/pull/74', undefined)).toEqual([]);
    expect(prNumbersIn('', remote)).toEqual([]);
    expect(prNumbersIn('pull/74 and #74', remote)).toEqual([]);
  });

  it('stays fast on a megabyte of near misses', () => {
    const text = 'https://github.com/alfredo1996/agent-orb/pull/'.repeat(25_000) + 'x'.repeat(100_000);
    const t0 = performance.now();
    expect(prNumbersIn(text, remote)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('the two builders', () => {
  it('session.pr carries the number and nothing of the URL, and is the session\'s, not an agent\'s', () => {
    const e = build.sessionPr(ctx, 74);
    expect(e.kind).toBe('session.pr');
    expect(e.data).toEqual({ number: 74 });
    expect(e).not.toHaveProperty('agent_id');
    expect(e).not.toHaveProperty('turn_id');
    expect(Event.safeParse(e).error).toBeUndefined();
  });
});
