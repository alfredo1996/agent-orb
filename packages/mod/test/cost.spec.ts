import { describe, expect, it } from 'vitest';
import { Event } from '../../shared/src/index.ts';
import { build, issueOf, openIssuesArgv, openPrsArgv, parseOpenIssues, parseOpenPrs, type Ctx } from '../hooks/core.ts';

// v0.4 slice 2 (#28, Factory): what an issue cost. The plugin reads each open PR's opening time and the issue it names, and the open issues' milestones. A PR's body is read
// here and goes no further: only the issue number found in it leaves the machine.
const ctx: Ctx = { host: 'mbp', session_id: 's-1', project: { cwd: '/r', name: 'mobile-app', git_remote: 'github.com/o/mobile-app' } };
const oid = (c: string) => c.padEnd(40, '0');
const gh = (over: Record<string, unknown> = {}) => ({
  number: 416, headRefName: 'chore/router', headRefOid: oid('a'), mergeStateStatus: 'CLEAN', statusCheckRollup: [], comments: [], reviews: [], commits: [],
  createdAt: '2026-11-01T14:10:00Z', body: '', ...over,
});
const read = (...prs: Record<string, unknown>[]) => parseOpenPrs(JSON.stringify(prs))!;

describe('the open-PR read, for cost', () => {
  it('also asks gh for when each PR opened and its body', () => {
    expect(openPrsArgv).toEqual(['gh', 'pr', 'list', '--state', 'open', '--limit', '40', '--json', 'number,headRefName,headRefOid,mergeStateStatus,statusCheckRollup,comments,reviews,commits,createdAt,body']);
  });

  it('a PR carries when it opened and the issue it closes, and nothing of its body: only the number leaves the machine', () => {
    const [pr] = read(gh({ body: 'Plan: rotate the vault key before the cutover.\n\nCloses #409\n\nPrivate note to self.' }));
    expect(pr).toMatchObject({ number: 416, created_at: Date.parse('2026-11-01T14:10:00Z'), issue: 409 });
    const sent = JSON.stringify(build.projectOpenPrs(ctx, [pr!]));
    expect(sent).not.toMatch(/vault|cutover|Private note|Closes|Plan:/);
    expect(Object.keys(pr!).sort()).toEqual(['bots', 'checks', 'created_at', 'head', 'head_oid', 'issue', 'merge_state', 'number']); // no `body` key, whatever its name
  });

  it('the branch number comes first: fix/90-… names #90 even when the body closes another issue', () => {
    expect(read(gh({ headRefName: 'fix/90-token-retry', body: 'Closes #12' }))[0]!.issue).toBe(90);
  });

  it('several Closes: the first in the body is the PR\'s issue', () => {
    expect(read(gh({ body: 'Fixes #31 and also\nCloses #30' }))[0]!.issue).toBe(31);
    expect(read(gh({ body: 'Closes #30, closes #31' }))[0]!.issue).toBe(30);
  });

  it.each(['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved', 'Closes:', 'CLOSES', 'resolves  :  '])('"%s #7" closes #7', (word) => {
    expect(issueOf('chore/router', `${word.trim()} #7`)).toBe(7);
  });

  it.each([
    'Closes owner/repo#7', // another repository's issue
    'closes https://github.com/o/r/issues/7',
    'This closes nothing, see #7',
    'Part of #7',
    'prefix #7', // "fix" inside a word
    'enclosed #7',
    'Closes #0',
    'Closes #12345678901', // eleven digits are no issue number
    '',
  ])('%j closes nothing', (body) => {
    expect(issueOf('chore/router', body)).toBeUndefined();
  });

  it('a PR with no issue anywhere has no `issue` key; one with no usable time has no `created_at`', () => {
    const [pr] = read(gh({ createdAt: 'yesterday' }));
    expect('issue' in pr!).toBe(false);
    expect('created_at' in pr!).toBe(false);
    expect('issue' in read(gh({ body: undefined }))[0]!).toBe(false);
  });

  it('an excluded project sends no branch name, and still the issue number worked out from it', () => {
    const [pr] = parseOpenPrs(JSON.stringify([gh({ headRefName: 'fix/90-token-retry', body: 'Closes #12' })]), false)!;
    expect(pr).toMatchObject({ issue: 90 });
    expect('head' in pr!).toBe(false);
    expect(JSON.stringify(pr)).not.toContain('token-retry');
  });
});

describe('the open issues\' milestones', () => {
  it('asks gh for the open issues\' numbers and milestones only', () => {
    expect(openIssuesArgv).toEqual(['gh', 'issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,milestone']);
  });

  it('keeps a number and its milestone\'s title: never an issue\'s title or body', () => {
    const issues = parseOpenIssues(JSON.stringify([
      { number: 409, title: 'Retry after an expired token', body: 'private text', milestone: { number: 3, title: 'v0.4 Factory', description: 'the plan' } },
      { number: 410, milestone: null },
      { number: 411 },
    ]))!;
    expect(issues).toEqual([{ number: 409, milestone: 'v0.4 Factory' }, { number: 410 }, { number: 411 }]);
    expect(JSON.stringify(issues)).not.toMatch(/Retry after|private text|the plan/);
  });

  it('an excluded project sends numbers only: a milestone\'s title is a name', () => {
    expect(parseOpenIssues(JSON.stringify([{ number: 409, milestone: { title: 'v0.4 Factory' } }]), false)).toEqual([{ number: 409 }]);
  });

  it('what is not gh\'s list sends nothing; entries the schema would refuse are left out; at most 500', () => {
    expect(parseOpenIssues('To get started with GitHub CLI, please run:  gh auth login')).toBeUndefined();
    expect(parseOpenIssues('{"message":"Bad credentials"}')).toBeUndefined();
    expect(parseOpenIssues('[]')).toEqual([]);
    expect(parseOpenIssues(JSON.stringify([{ number: 'x' }, { number: 0 }, { number: 5, milestone: { title: '' } }]))).toEqual([{ number: 5 }]);
    expect(parseOpenIssues(JSON.stringify(Array.from({ length: 700 }, (_, i) => ({ number: i + 1 }))))!.length).toBe(500);
  });
});

describe('project.open_prs with cost fields speaks the server schema', () => {
  it.each([
    build.projectOpenPrs(ctx, read(gh({ body: 'Closes #409' }), gh({ number: 417, headRefName: 'feat/407-compress' })), [{ number: 409, milestone: 'v0.4 Factory' }, { number: 407 }]),
    build.projectOpenPrs(ctx, read(gh())), // no issue read: the key is absent, so the server keeps what it has
    build.projectOpenPrs(ctx, [], []), // an empty list is a read of no open issues
  ])('%#', (e) => {
    const parsed = Event.safeParse(e);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toEqual(e);
  });

  it('no issue read leaves the `issues` key out; an empty one keeps it', () => {
    expect('issues' in (build.projectOpenPrs(ctx, []).data as object)).toBe(false);
    expect((build.projectOpenPrs(ctx, [], []).data as { issues: unknown[] }).issues).toEqual([]);
  });
});
