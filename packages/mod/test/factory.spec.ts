import { describe, expect, it } from 'vitest';
import { Event } from '../../shared/src/index.ts';
import { build, FINDINGS_ASK, isBot, openPrsArgv, parseFindings, parseOpenPrs, type Ctx } from '../hooks/core.ts';

// v0.4 slice 1 (#27, Factory): the `orb-findings` block at the end of an agent's final report, parsed on the machine, and the open PRs read from gh.
// #34: the paragraph the plugin appends to every subagent's prompt, asking for that block.
const ctx: Ctx = { host: 'mbp', session_id: 's-1', project: { cwd: '/r', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' } };

const REPORT = [
  'Reviewed the token refresh. Two problems left.',
  '',
  '```orb-findings',
  'F12 major src/auth/refresh.ts open | Two refreshes can run at once and the second logs the user out',
  'F09 minor src/net/client.ts dismissed | Timeout value is not a constant | Used once, and the rule says no config for a value that never changes',
  'F03 major src/auth/refresh.ts fixed | The token was written before the response was checked',
  'F14 minor src/auth/refresh.spec.ts open',
  '```',
].join('\n');

describe('parseFindings', () => {
  it('reads one finding a line: id, severity, file and fate, and nothing else without a text function (Content off)', () => {
    expect(parseFindings(REPORT)).toEqual({ dropped: 0, findings: [
      { id: 'F12', severity: 'major', file: 'src/auth/refresh.ts', fate: 'open' },
      { id: 'F09', severity: 'minor', file: 'src/net/client.ts', fate: 'dismissed' },
      { id: 'F03', severity: 'major', file: 'src/auth/refresh.ts', fate: 'fixed' },
      { id: 'F14', severity: 'minor', file: 'src/auth/refresh.spec.ts', fate: 'open' },
    ] });
  });

  it('with a text function (Content on full) a title travels, and a reason only for a dismissed finding', () => {
    const r = parseFindings(REPORT.replace('response was checked', 'response was checked | it was a race'), (s) => s);
    expect(r!.findings.map((f) => [f.id, f.title, f.why])).toEqual([
      ['F12', 'Two refreshes can run at once and the second logs the user out', undefined],
      ['F09', 'Timeout value is not a constant', 'Used once, and the rule says no config for a value that never changes'],
      ['F03', 'The token was written before the response was checked', undefined], // a fixed finding's "why" is not a dismissal's reason
      ['F14', undefined, undefined],
    ]);
  });

  it('the text function decides what goes: one that masks, masks; one that answers nothing sends nothing', () => {
    expect(parseFindings(REPORT, (s) => s.replace(/refresh/g, '[X]'))!.findings[0]!.title).toBe('Two [X]es can run at once and the second logs the user out');
    expect(JSON.stringify(parseFindings(REPORT, () => undefined))).not.toMatch(/Two refreshes|Used once/);
  });

  it('a malformed line is dropped and counted, not guessed; blank lines are not lines', () => {
    const r = parseFindings(['```orb-findings', 'F1 major a.ts open', '', 'F2 major a.ts maybe', 'F3 Major a.ts open', 'F4 major open', 'just a sentence', 'F5 minor b.ts fixed', '```'].join('\n'));
    expect(r).toEqual({ dropped: 4, findings: [{ id: 'F1', severity: 'major', file: 'a.ts', fate: 'open' }, { id: 'F5', severity: 'minor', file: 'b.ts', fate: 'fixed' }] });
  });

  it('an empty block is a report of nothing found; no block is no report', () => {
    expect(parseFindings('Nothing to report.\n```orb-findings\n```')).toEqual({ dropped: 0, findings: [] });
    expect(parseFindings('All good, no findings.')).toBeUndefined();
    expect(parseFindings('```orb-gate\npass a1b2c3d\n```')).toBeUndefined();
  });

  it('a block left open runs to the end of the report, and an indented one counts: a missed block would read as no report at all', () => {
    expect(parseFindings('Done.\n```orb-findings\nF20 major a.ts open\nF21 minor b.ts fixed\n')).toEqual({ dropped: 0, findings: [
      { id: 'F20', severity: 'major', file: 'a.ts', fate: 'open' }, { id: 'F21', severity: 'minor', file: 'b.ts', fate: 'fixed' }] });
    expect(parseFindings('1. Report:\n   ```orb-findings\n   F20 major a.ts open\n   ```\n')!.findings).toEqual([{ id: 'F20', severity: 'major', file: 'a.ts', fate: 'open' }]);
    expect(parseFindings('Say `orb-findings` here, but no block')).toBeUndefined();
  });

  it('a file is masked like content, since it is the agent\'s own text', () => {
    expect(parseFindings('```orb-findings\nF1 major https://x:hunter2secret@host/a.ts open\n```')!.findings[0]!.file).toBe('https://x:[REDACTED]@host/a.ts');
  });

  it('an unclosed opener repeated many times stays linear', () => {
    const big = `${'```orb-findings\nnot a finding\n'.repeat(20_000)}`;
    const t = performance.now();
    expect(parseFindings(big)).toEqual({ dropped: 1, findings: [] });
    expect(performance.now() - t).toBeLessThan(1_000);
  });

  it('the fence line may name the PR, #N (owner, 2026-11-03): the report then goes to that PR, whatever branch the checkout is on', () => {
    expect(parseFindings('```orb-findings #416\nF1 major a.ts open\n```')).toEqual({ pr: 416, dropped: 0, findings: [{ id: 'F1', severity: 'major', file: 'a.ts', fate: 'open' }] });
    expect(parseFindings('  ```orb-findings   #416  \r\nF1 major a.ts open\r\n  ```\r\n')!.pr).toBe(416);
    // anything else on the fence line is no number, and the block still counts: a missed block would read as no report
    for (const info of ['416', 'PR 416', '#0', '#4x', '# 416', '#416 #417']) expect(parseFindings(`\`\`\`orb-findings ${info}\nF1 major a.ts open\n\`\`\``), info).toEqual({ dropped: 0, findings: [{ id: 'F1', severity: 'major', file: 'a.ts', fate: 'open' }] });
    expect(parseFindings('```orb-findingsX\nF1 major a.ts open\n```')).toBeUndefined(); // another block's name
  });

  it('the last block counts: a report that quotes an earlier one ends with its own', () => {
    const r = parseFindings('Round 1 said:\n```orb-findings\nF1 major a.ts open\n```\nNow:\n```orb-findings\nF1 major a.ts fixed\n```\n');
    expect(r!.findings).toEqual([{ id: 'F1', severity: 'major', file: 'a.ts', fate: 'fixed' }]);
  });

  it('a title and a reason are cut, 200 and 300 characters', () => {
    const r = parseFindings(`\`\`\`orb-findings\nF1 minor a.ts dismissed | ${'t'.repeat(250)} | ${'w'.repeat(400)}\n\`\`\``, (s) => s);
    expect([r!.findings[0]!.title!.length, r!.findings[0]!.why!.length]).toEqual([200, 300]);
  });
});

describe('the findings paragraph (#34)', () => {
  it('asks for the format parseFindings reads: its own example parses whole, every fate, a dismissal with its reason, and #N on the fence is no number', () => {
    const r = parseFindings(FINDINGS_ASK, (s) => s);
    expect(r).toEqual({ dropped: 0, findings: [
      { id: 'F1', severity: 'major', file: 'src/auth/refresh.ts', fate: 'open', title: expect.any(String) },
      { id: 'F2', severity: 'minor', file: 'src/net/client.ts', fate: 'dismissed', title: expect.any(String), why: expect.any(String) },
      { id: 'F3', severity: 'major', file: 'src/auth/refresh.ts', fate: 'fixed', title: expect.any(String) },
    ] });
  });

  it('is one short paragraph that says when to write the block, to keep a review\'s ids, and what an empty block means', () => {
    expect(FINDINGS_ASK).toMatch(/^\n\n/); // set apart from the caller's task
    expect(FINDINGS_ASK).toMatch(/keep the ids/i);
    expect(FINDINGS_ASK).toMatch(/empty block/i);
    expect(FINDINGS_ASK.length).toBeLessThan(900);
  });

  it('asks only a review or a fix for the block, and tells any other agent to write none (#36)', () => {
    // An Explore lookup that was told "write an empty block if you found nothing" wrote one, and read as a review that found nothing (2026-11-04).
    expect(FINDINGS_ASK).toMatch(/only if your task was to review code or to fix review findings/i);
    expect(FINDINGS_ASK).toMatch(/empty block if your review found nothing/);
    expect(FINDINGS_ASK).not.toMatch(/empty block if you found nothing/);
    expect(FINDINGS_ASK).toMatch(/\n```\nIf your task was anything else[^\n]*, write no block\.$/); // last, after the example, so it is the line read last
  });
});

// `gh pr list --state open --json number,headRefName,headRefOid,mergeStateStatus,statusCheckRollup,comments,reviews,commits` as gh prints it, trimmed to what matters.
// NeoBoard's #2405 read MERGEABLE and UNSTABLE at once (#20): only mergeStateStatus is kept.
const HEAD = 'e4f5a6b'.padEnd(40, '1');
const OPEN = JSON.stringify([
  {
    number: 416, headRefName: 'fix/409-token-retry', headRefOid: HEAD, mergeStateStatus: 'UNSTABLE', mergeable: 'MERGEABLE', title: 'Retry after an expired token', body: 'Closes #409',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'Unit tests', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/1', workflowName: 'CI' },
      { __typename: 'CheckRun', name: 'E2E', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'CheckRun', name: 'Lint', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'Docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', context: 'SonarCloud Code Analysis', state: 'SUCCESS', targetUrl: 'https://sonar' },
      { __typename: 'StatusContext', context: 'coverage', state: 'PENDING' },
    ],
    comments: [
      { author: { login: 'coderabbitai' }, body: 'Walkthrough: the refresh races with logout, see secret-token-in-review', createdAt: '2026-11-01T15:10:51Z' },
      { author: { login: 'coderabbitai' }, body: 'Another note', createdAt: '2026-11-01T15:40:00Z' },
      { author: { login: 'sonarqubecloud' }, body: 'Quality Gate passed', createdAt: '2026-11-01T15:23:10Z' },
      { author: { login: 'owner-person' }, body: 'Looks fine to me, private remark', createdAt: '2026-11-01T16:16:22Z' },
    ],
    reviews: [{ author: { login: 'dependabot[bot]' }, body: 'review text', state: 'COMMENTED', submittedAt: '2026-11-01T15:30:00Z' }, { author: { login: 'owner-person' }, body: 'lgtm', state: 'APPROVED', submittedAt: '2026-11-01T16:00:00Z' }],
    commits: [
      { oid: 'aaaaaaa'.padEnd(40, '0'), committedDate: '2026-11-01T14:00:00Z', messageHeadline: 'first try' },
      { oid: HEAD, committedDate: '2026-11-01T15:04:42Z', messageHeadline: 'fix: the retry' },
    ],
  },
  { number: 405, headRefName: 'feat/403-banner', headRefOid: 'c0d1e2f'.padEnd(40, '2'), mergeStateStatus: 'CLEAN', statusCheckRollup: [], comments: [], reviews: [], commits: [] },
]);

describe('the open-PR read', () => {
  it('asks gh for at most 40 open PRs with the fields ready() needs, and the commits for the head\'s time: 50 passes GitHub\'s 500,000-node limit, and gh fails', () => {
    expect(openPrsArgv).toEqual(['gh', 'pr', 'list', '--state', 'open', '--limit', '40', '--json', 'number,headRefName,headRefOid,mergeStateStatus,statusCheckRollup,comments,reviews,commits']);
  });

  it('keeps numbers, the branch, the head, the merge state, each check\'s name and result, and each bot\'s latest comment time: never a comment\'s text', () => {
    const prs = parseOpenPrs(OPEN)!;
    expect(prs).toEqual([
      {
        number: 416, head: 'fix/409-token-retry', head_oid: HEAD, merge_state: 'UNSTABLE', last_commit_at: Date.parse('2026-11-01T15:04:42Z'),
        checks: [{ name: 'Unit tests', state: 'pass', ci: true }, { name: 'E2E', state: 'pending' }, { name: 'Lint', state: 'fail' }, { name: 'Docs', state: 'pass' }, { name: 'SonarCloud Code Analysis', state: 'pass' }, { name: 'coverage', state: 'pending' }],
        bots: [{ author: 'coderabbitai', at: Date.parse('2026-11-01T15:40:00Z') }, { author: 'sonarqubecloud', at: Date.parse('2026-11-01T15:23:10Z') }, { author: 'dependabot[bot]', at: Date.parse('2026-11-01T15:30:00Z') }],
      },
      { number: 405, head: 'feat/403-banner', head_oid: 'c0d1e2f'.padEnd(40, '2'), merge_state: 'CLEAN', checks: [], bots: [] }, // no commit listed for the head: its time is unknown
    ]);
    const sent = JSON.stringify(build.projectOpenPrs(ctx, prs));
    expect(sent).not.toMatch(/Walkthrough|secret-token|Quality Gate|private remark|lgtm|review text|Closes|first try|fix: the retry|Retry after|owner-person|https:/);
    expect(sent).not.toContain('MERGEABLE"'); // UNSTABLE is what travels
  });

  it('a read fits one request: at most 250,000 characters of JSON, the PRs past it left out (gh lists the newest first)', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      number: 1000 - i, headRefName: `feat/${'b'.repeat(190)}`, headRefOid: 'a'.repeat(40), mergeStateStatus: 'CLEAN', comments: [], reviews: [], commits: [],
      statusCheckRollup: Array.from({ length: 200 }, (_, k) => ({ __typename: 'CheckRun', name: `${'c'.repeat(190)}${k}`, status: 'COMPLETED', conclusion: 'SUCCESS' })),
    }));
    const prs = parseOpenPrs(JSON.stringify(many))!;
    expect(prs.length).toBeGreaterThan(0);
    expect(prs.length).toBeLessThan(40);
    expect(prs.map((p) => p.number)).toEqual(Array.from({ length: prs.length }, (_, i) => 1000 - i));
    expect(JSON.stringify(prs).length).toBeLessThanOrEqual(250_000);
    expect(JSON.stringify(build.projectOpenPrs(ctx, prs)).length).toBeLessThan(1_000_000 / 3); // UTF-8 at most 3 bytes a character: under the server's 1 MB
  });

  it('an excluded project sends no branch names', () => {
    expect(parseOpenPrs(OPEN, false)!.map((p) => 'head' in p)).toEqual([false, false]);
  });

  it('what is not gh\'s list sends nothing; an empty list is a read of no open PRs', () => {
    expect(parseOpenPrs('To get started with GitHub CLI, please run:  gh auth login')).toBeUndefined();
    expect(parseOpenPrs('{"message":"Bad credentials"}')).toBeUndefined();
    expect(parseOpenPrs('[]')).toEqual([]);
    expect(parseOpenPrs(JSON.stringify([{ number: 'x' }, { number: 7, headRefOid: 'not-a-sha' }]))).toEqual([]); // entries the schema would refuse are left out
  });

  it('a bot is a login ending in [bot] or -bot, or one of the review and quality bots gh names bare', () => {
    expect(['coderabbitai', 'sonarqubecloud', 'github-actions', 'renovate[bot]', 'dependabot', 'CodeRabbitAI', 'release-bot', 'gemini-code-assist', 'greptile-apps', 'chatgpt-codex-connector'].map(isBot))
      .toEqual([true, true, true, true, true, true, true, true, true, true]);
    expect(['owner-person', 'robotics-fan', 'talbot', 'alfredo1996'].map(isBot)).toEqual([false, false, false, false]);
  });
});

describe('the three events speak the server schema', () => {
  it.each([
    build.findingsReport(ctx, { agentId: 'a-1', turnId: 't-2' }, 'fix/409-token-retry', parseFindings(REPORT, (s) => s)!),
    build.findingsReport(ctx, { agentId: 'a-1', turnId: 't-2' }, 'fix/409-token-retry', parseFindings(REPORT)!),
    build.findingsReport(ctx, { agentId: 'a-1', turnId: 't-2' }, undefined, parseFindings(REPORT.replace('```orb-findings', '```orb-findings #416'))!), // a detached head, the PR named
    build.gateReport(ctx, { agentId: 'a-2', turnId: 't-3' }, { result: 'pass', commit: 'a1b2c3d' }),
    build.projectOpenPrs(ctx, parseOpenPrs(OPEN)!),
  ])('%#', (e) => {
    const parsed = Event.safeParse(e);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toEqual(e);
  });
});
