import { describe, expect, it } from 'vitest';
import { Event } from '../../shared/src/index.ts';
import { build, issueOf, openIssuesArgv, openIssuesBareArgv, openPrsArgv, parseOpenIssues, parseOpenPrs, type Ctx } from '../hooks/core.ts';

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
  it('asks gh for the open issues\' numbers, milestones, titles and (#66) bodies; and for the same without the bodies, when they are too much for one read', () => {
    expect(openIssuesArgv).toEqual(['gh', 'issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,milestone,title,body']);
    expect(openIssuesBareArgv).toEqual(['gh', 'issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,milestone,title']);
  });

  const LIST = JSON.stringify([
    { number: 409, title: 'Retry after an expired token', body: 'private text', milestone: { number: 3, title: 'v0.4 Factory', description: 'the plan' } },
    { number: 410, milestone: null },
    { number: 411 },
  ]);

  it('keeps a number and its milestone\'s title, and an issue\'s own title only when the Content helper gives it: never a body', () => {
    const issues = parseOpenIssues(LIST)!;
    expect(issues).toEqual([{ number: 409, milestone: 'v0.4 Factory', mentions: [] }, { number: 410 }, { number: 411 }]);
    expect(JSON.stringify(issues)).not.toMatch(/Retry after|private text|the plan/); // Content off: the helper is not passed
    const titled = parseOpenIssues(LIST, true, (s) => s)!;
    expect(titled).toEqual([{ number: 409, milestone: 'v0.4 Factory', title: 'Retry after an expired token', mentions: [] }, { number: 410 }, { number: 411 }]);
    expect(JSON.stringify(titled)).not.toMatch(/private text|the plan/);
    expect(parseOpenIssues(LIST, true, () => undefined)).toEqual(issues); // the helper says nothing leaves (Content is not full): none does
  });

  it('an issue\'s title is cut to 200 characters, and an empty or non-text one is left out', () => {
    const long = JSON.stringify([{ number: 1, title: 'x'.repeat(300) }, { number: 2, title: '' }, { number: 3, title: 42 }]);
    const [a, b, c] = parseOpenIssues(long, true, (s) => s.toUpperCase())!;
    expect(a!.title).toBe('X'.repeat(200));
    expect([b, c]).toEqual([{ number: 2 }, { number: 3 }]);
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

// v0.5 slice 1 (#66, the Map): the issues an issue's text mentions. The body is read here and goes no further: only the numbers leave the machine, for every project.
describe('the issues an issue mentions', () => {
  const one = (number: number, body: unknown, milestones = true) => parseOpenIssues(JSON.stringify([{ number, body }]), milestones)![0]!;

  it('a body gives the numbers it mentions, in order: not another repository\'s, not the issue\'s own, each once', () => {
    expect(one(409, 'Blocked by #12, see owner/repo#13 and #409 itself.\n\nAgain: #12, then #7')).toEqual({ number: 409, mentions: [12, 7] });
  });

  it.each<[string, number[]]>([
    ['#7', [7]], ['(#7)', [7]], ['see #7.', [7]], ['#7 and #8,#9', [7, 8, 9]], ['Closes #7', [7]], ['- [ ] #7\n- [x] #8', [7, 8]], ['#123456789', [123456789]],
    ['o/r#7', []], ['word#7', []], ['under_#7', []], ['https://github.com/o/r/issues/7#8', []], ['docs/#7', []], ['#0', []], ['#07', []], ['# 7', []], ['#7a', []], ['#1234567890', []], ['seven', []], ['', []],
  ])('%j mentions %j', (body, mentions) => {
    expect(one(1, body)).toEqual({ number: 1, mentions }); // a body that names none still carries the empty list: it was read
  });

  it('no word of the body is in the built event, with Content on full too: only the numbers', () => {
    const issues = parseOpenIssues(JSON.stringify([{ number: 409, title: 'Retry', body: 'Rotate the vault key before the cutover, after #12.' }]), true, (s) => s)!;
    expect(issues).toEqual([{ number: 409, title: 'Retry', mentions: [12] }]);
    const e = build.projectOpenPrs(ctx, [], issues);
    expect(JSON.stringify(e)).not.toMatch(/vault|cutover|Rotate|after|body/);
    expect(Event.safeParse(e).data).toEqual(e); // and the server's schema takes the field as it is
  });

  it('at most 20: a 21st mention is cut', () => {
    const body = Array.from({ length: 25 }, (_, i) => `#${i + 1}`).join(' ');
    expect(one(409, body).mentions).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('output with no body, or a body that is not text, gives no mentions key: absent is "not read", and an empty list is "read, names none"', () => {
    expect(parseOpenIssues(JSON.stringify([{ number: 5 }, { number: 6, body: null }, { number: 7, body: 12 }]))).toEqual([{ number: 5 }, { number: 6 }, { number: 7 }]);
    expect(parseOpenIssues(JSON.stringify([{ number: 8, body: '' }]))).toEqual([{ number: 8, mentions: [] }]);
  });

  it('an excluded project sends them too, as it sends the issue\'s number', () => {
    expect(one(409, 'after #12', false)).toEqual({ number: 409, mentions: [12] });
  });

  it('a long body is read in linear time', () => {
    const t = process.cpuUsage();
    expect(one(1, `${'#'.repeat(200_000)}${'x#1 '.repeat(50_000)}#5`).mentions).toEqual([5]);
    expect(process.cpuUsage(t).user / 1000).toBeLessThan(500); // ms of CPU; a quadratic read of 400,000 characters takes minutes
  });
});

describe('project.open_prs with cost fields speaks the server schema', () => {
  it.each([
    build.projectOpenPrs(ctx, read(gh({ body: 'Closes #409' }), gh({ number: 417, headRefName: 'feat/407-compress' })), [{ number: 409, milestone: 'v0.4 Factory' }, { number: 407 }]),
    build.projectOpenPrs(ctx, read(gh())), // no issue read: the key is absent, so the server keeps what it has
    build.projectOpenPrs(ctx, [], []), // an empty list is a read of no open issues
    build.projectOpenPrs(ctx, [], [{ number: 409, milestone: 'v0.4 Factory', title: 'Retry after an expired token' }]), // #32: an issue's title, with Content on full
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
