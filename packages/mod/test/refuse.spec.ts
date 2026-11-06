import { describe, expect, it } from 'vitest';
import { backgroundFromFrontmatter, judgeMerge, mergesIn, parseFactory, REFUSE_MS, stopWaits, type Cond, type FactoryMemory, type PrMemory } from '../hooks/core.ts';

// v0.4 slice 5 (#31): the merge refusal. A `gh pr merge` is found by its argv, judged from the plugin's memory of GET /api/factory, and refused only on a definite no from data that is not
// old. The mod answers from what it holds: nothing here runs a process or a fetch.
const NOW = Date.parse('2026-11-06T12:00:00Z');
const MIN = 60_000;
const ok: Cond = { ok: true, note: 'fine' };
const pr = (over: Partial<PrMemory['conditions']> = {}, rest: Partial<PrMemory> = {}): PrMemory => ({
  number: 416, head: 'fix/409-token-retry', headOid: 'e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3',
  conditions: { findings: ok, gate: ok, bots: ok, clean: { ok: true, note: 'CLEAN' }, ...over }, ...rest,
});
const memory = (prs: PrMemory[], age = 3 * MIN): FactoryMemory => ({ readAt: NOW - age, prs });
const at: { remote?: string; branch?: string } = { remote: 'github.com/o/r', branch: 'fix/409-token-retry' };
const judge = (ask: Parameters<typeof judgeMerge>[0], m: FactoryMemory | undefined, where = at) => judgeMerge(ask, where, m, NOW);

describe('mergesIn: only `gh pr merge`, by its argv', () => {
  it('finds the selector, with the flags before or after it', () => {
    expect(mergesIn('gh pr merge 12')).toEqual([{ selector: '12' }]);
    expect(mergesIn('gh pr merge --squash --repo o/r 12')).toEqual([{ selector: '12', repo: 'o/r' }]);
    expect(mergesIn('gh pr merge 12 -R o/r --delete-branch')).toEqual([{ selector: '12', repo: 'o/r' }]);
    expect(mergesIn('gh pr merge 12 --repo=o/r')).toEqual([{ selector: '12', repo: 'o/r' }]);
    expect(mergesIn('gh pr merge -Ro/r 12')).toEqual([{ selector: '12', repo: 'o/r' }]);
    expect(mergesIn('gh pr -R o/r merge 12')).toEqual([{ selector: '12', repo: 'o/r' }]);
    expect(mergesIn('gh pr merge --admin --squash --subject "feat: x" --body "the 12th" 12')).toEqual([{ selector: '12' }]); // a flag's value is not the selector
    expect(mergesIn('gh pr merge --match-head-commit abc123 -t t 12 --auto')).toEqual([{ selector: '12' }]);
  });

  it('takes a PR URL or a branch name as the selector, and none when there is none (the current branch)', () => {
    expect(mergesIn('gh pr merge https://github.com/o/r/pull/12 --squash')).toEqual([{ selector: 'https://github.com/o/r/pull/12' }]);
    expect(mergesIn('gh pr merge fix/409-token-retry')).toEqual([{ selector: 'fix/409-token-retry' }]);
    expect(mergesIn('gh pr merge')).toEqual([{}]);
    expect(mergesIn('gh pr merge --squash --delete-branch')).toEqual([{}]);
  });

  it('finds it in each part of a chain, and after a prefix a shell allows', () => {
    expect(mergesIn('cd x && gh pr merge 12 --squash')).toEqual([{ selector: '12' }]);
    expect(mergesIn('pnpm test || exit 1; gh pr merge 3 | cat')).toEqual([{ selector: '3' }]);
    expect(mergesIn('gh pr merge 3 && gh pr merge 4')).toEqual([{ selector: '3' }, { selector: '4' }]);
    expect(mergesIn('GH_TOKEN=x gh pr merge 5')).toEqual([{ selector: '5' }]);
    expect(mergesIn('sudo /usr/local/bin/gh pr merge 6')).toEqual([{ selector: '6' }]);
    expect(mergesIn('echo ok\ngh pr merge 7')).toEqual([{ selector: '7' }]);
    expect(mergesIn('if true; then gh pr merge 8; fi')).toEqual([{ selector: '8' }]);
  });

  it('does not match what only names it: another subcommand, gh api, a word in a message, an argument', () => {
    for (const c of ['gh pr view 12', 'gh pr list', 'gh pr checks 12', 'gh pr merge-status 12', 'gh api repos/o/r/pulls/12/merge -X PUT', 'gh issue merge 12', 'echo gh pr merge 12',
      'git commit -m "gh pr merge 12"', 'gh pr comment 12 --body "gh pr merge 12"', 'gh pr create --title "gh pr merge"', 'ls merge', 'git merge dev', '', 'gh']) {
      expect(mergesIn(c), c).toEqual([]);
    }
  });
});

describe('parseFactory: what the plugin keeps of GET /api/factory', () => {
  const body = (prs: object[], readAt: number | null = NOW - MIN) => JSON.stringify({ project: 'r', readAt, prs });
  const served = { number: 416, head: 'fix/409-token-retry', issue: 409, headOid: 'e'.repeat(40), ready: false, reason: 'x', findings: [{ id: 'F1' }], dropped: 0,
    conditions: { findings: { ok: false, note: '2 findings open: 1 major, 1 minor' }, gate: { ok: null, note: 'No test run on eeeeeee' }, bots: { ok: true, note: 'a' }, clean: { ok: true, note: 'CLEAN' } } };

  it('keeps the number, the branch, the head, the four conditions and when GitHub was read: nothing else', () => {
    expect(parseFactory(body([served]))).toEqual({
      readAt: NOW - MIN,
      prs: [{ number: 416, head: 'fix/409-token-retry', headOid: 'e'.repeat(40), conditions: served.conditions }],
    });
  });

  it('a PR with no branch (an excluded project) keeps null; a repo GitHub has not been read for keeps none', () => {
    expect(parseFactory(body([{ ...served, head: null }]))?.prs[0]?.head).toBeNull();
    expect(parseFactory(body([], null))).toEqual({ readAt: 0, prs: [] });
  });

  it('is nothing for a text that is not the server\'s answer, so the last memory stays; a PR that is malformed is left out, not guessed', () => {
    for (const t of ['', '<html>a proxy answered</html>', '[]', 'null', JSON.stringify({ prs: 'x' }), JSON.stringify({ readAt: 'now', prs: [] }), JSON.stringify({ readAt: 1 })]) expect(parseFactory(t), t).toBeUndefined();
    const half = { ...served, conditions: { ...served.conditions, clean: { ok: 'yes', note: 'x' } } };
    expect(parseFactory(body([half, { ...served, number: 417 }]))?.prs.map((p) => p.number)).toEqual([417]);
    expect(parseFactory(body([{ ...served, number: 0 }, { ...served, headOid: 5 }, { ...served, conditions: { ...served.conditions, bots: undefined } }]))?.prs).toEqual([]);
  });
});

describe('judgeMerge: a definite no refuses, anything unknown lets through and says so, ready says nothing', () => {
  const DEFINITE: [string, Partial<PrMemory['conditions']>, string][] = [
    ['an open finding', { findings: { ok: false, note: '2 findings open: 1 major, 1 minor' } }, '2 findings open: 1 major, 1 minor'],
    ['a failed check', { gate: { ok: false, note: 'Unit tests failed' } }, 'Unit tests failed'],
    ['a bot comment newer than the last commit', { bots: { ok: false, note: 'coderabbitai commented after the last commit, and no findings report since' } }, 'coderabbitai commented after the last commit, and no findings report since'],
    ['a merge state that is not clean', { clean: { ok: false, note: 'UNSTABLE: a check is not passing' } }, 'UNSTABLE: a check is not passing'],
  ];

  it.each(DEFINITE)('refuses on %s, with the reason, how old the data is and the head', (_name, conditions, note) => {
    const v = judge({ selector: '416' }, memory([pr(conditions)]));
    expect(v).toEqual({ deny: [
      "agent-orb refused this merge: PR #416 isn't ready.",
      `- ${note}`,
      'GitHub data 3 min old, head e4f5a6b.',
      'To merge anyway, you run it yourself in a terminal.',
    ].join('\n') });
  });

  it('names every condition that is a no, not only the first', () => {
    const v = judge({ selector: '416' }, memory([pr({ findings: { ok: false, note: 'A' }, clean: { ok: false, note: 'B' }, gate: { ok: null, note: 'C' } })]));
    expect((v as { deny: string }).deny).toContain('- A\n- B\n');
    expect((v as { deny: string }).deny).not.toContain('C'); // what is merely unknown is not a reason to refuse
  });

  const UNKNOWN: [string, Partial<PrMemory['conditions']>, string][] = [
    ['no test run seen on the head', { gate: { ok: null, note: 'No test run on e4f5a6b' } }, 'no test run on e4f5a6b'],
    ['a repo with no findings block', { findings: { ok: null, note: 'No findings reported yet' } }, 'no findings reported yet'],
    ['the last commit\'s time unknown', { bots: { ok: null, note: "The last commit's time is unknown" } }, "the last commit's time is unknown"],
    ['a merge state GitHub has not worked out', { clean: { ok: null, note: "GitHub hasn't worked out the merge state yet" } }, "GitHub hasn't worked out the merge state yet"],
  ];

  it.each(UNKNOWN)('lets it through and says so on %s', (_name, conditions, why) => {
    expect(judge({ selector: '416' }, memory([pr(conditions)]))).toEqual({ say: `agent-orb can't say PR #416 is ready: ${why}. The merge goes ahead.` });
  });

  it('says every unknown, not only the first', () => {
    expect(judge({ selector: '416' }, memory([pr({ findings: { ok: null, note: 'No findings reported yet' }, gate: { ok: null, note: 'No test run on e4f5a6b' } })]))).toEqual({
      say: "agent-orb can't say PR #416 is ready: no findings reported yet; no test run on e4f5a6b. The merge goes ahead." });
  });

  it('a no beats an unknown: one condition false and another unknown still refuses', () => {
    expect(judge({ selector: '416' }, memory([pr({ gate: { ok: null, note: 'No test run' }, clean: { ok: false, note: 'DIRTY: it conflicts with its base' } })]))).toHaveProperty('deny');
  });

  it('a PR that is ready lets through without a word', () => {
    expect(judge({ selector: '416' }, memory([pr()]))).toBeUndefined();
  });

  it('data of exactly 10 minutes still refuses; a millisecond older lets through and says how old it is', () => {
    const no = pr({ findings: { ok: false, note: 'open' } });
    expect(judge({ selector: '416' }, { readAt: NOW - REFUSE_MS, prs: [no] })).toHaveProperty('deny');
    expect(judge({ selector: '416' }, { readAt: NOW - REFUSE_MS - 1, prs: [no] })).toEqual({ say: "agent-orb can't say PR #416 is ready: its GitHub data is 10 min old. The merge goes ahead." });
    expect(judge({ selector: '416' }, memory([no], 14 * MIN))).toEqual({ say: "agent-orb can't say PR #416 is ready: its GitHub data is 14 min old. The merge goes ahead." });
  });

  it('old data of a PR that was ready lets through and says so too: old is not approved', () => {
    expect(judge({ selector: '416' }, memory([pr()], 11 * MIN))).toHaveProperty('say');
  });

  it('data from the last minute reads "under a minute", not "0 min"', () => {
    expect((judge({ selector: '416' }, memory([pr({ clean: { ok: false, note: 'DIRTY' } })], 20_000)) as { deny: string }).deny).toContain('GitHub data under a minute old,');
  });

  it('a PR the plugin has never read, or no memory at all, lets through and says so', () => {
    expect(judge({ selector: '12' }, memory([pr()]))).toEqual({ say: "agent-orb can't say PR #12 is ready: the plugin has not read it. The merge goes ahead." });
    expect(judge({ selector: '12' }, undefined)).toEqual({ say: "agent-orb can't say PR #12 is ready: the plugin has not read it. The merge goes ahead." });
    expect(judge({ selector: 'feat/ghost' }, memory([pr()]))).toEqual({ say: "agent-orb can't say the PR on feat/ghost is ready: the plugin has not read it. The merge goes ahead." });
  });

  describe('which PR', () => {
    const other = pr({ clean: { ok: false, note: 'DIRTY' } }, { number: 417, head: 'feat/other', headOid: 'f'.repeat(40) });
    const m = memory([pr(), other]);

    it('a number, a PR URL and a branch name each find the PR they name', () => {
      expect(judge({ selector: '416' }, m)).toBeUndefined();
      expect(judge({ selector: '#417' }, m)).toHaveProperty('deny');
      expect(judge({ selector: 'https://github.com/o/r/pull/417' }, m)).toHaveProperty('deny');
      expect(judge({ selector: 'https://github.com/o/r/pull/416/files' }, m)).toBeUndefined();
      expect(judge({ selector: 'feat/other' }, m)).toHaveProperty('deny');
      expect(judge({ selector: 'fix/409-token-retry' }, m)).toBeUndefined();
    });

    it('with no selector it is the session\'s current branch, and with no branch there is nothing to say it for', () => {
      expect(judge({}, m, { remote: 'github.com/o/r', branch: 'feat/other' })).toHaveProperty('deny');
      expect(judge({}, m, { remote: 'github.com/o/r', branch: 'fix/409-token-retry' })).toBeUndefined();
      expect(judge({}, m, { remote: 'github.com/o/r', branch: 'dev' })).toEqual({ say: "agent-orb can't say the PR on dev is ready: the plugin has not read it. The merge goes ahead." });
      expect(judge({}, m, { remote: 'github.com/o/r', branch: undefined })).toEqual({ say: "agent-orb can't say which PR this is: no branch to name it. The merge goes ahead." });
    });

    it('a repository other than the project\'s lets through and says so, whatever the memory holds', () => {
      const say = (ask: Parameters<typeof judgeMerge>[0], where = at) => (judge(ask, memory([pr({ clean: { ok: false, note: 'DIRTY' } })]), where) as { say: string }).say;
      expect(say({ selector: '416', repo: 'o/elsewhere' })).toBe("agent-orb can't say PR #416 is ready: it is in o/elsewhere, and the plugin reads github.com/o/r only. The merge goes ahead.");
      expect(say({ selector: 'https://github.com/o/elsewhere/pull/416' })).toContain('it is in github.com/o/elsewhere');
      expect(say({ selector: '416', repo: 'o/r' }, { remote: undefined, branch: 'dev' })).toContain('this project has no remote to compare it with');
    });

    it('the project\'s own repository, spelled any way gh takes it, is the same repository', () => {
      for (const repo of ['o/r', 'O/R', 'github.com/o/r', 'https://github.com/o/r', 'https://github.com/o/r.git', 'git@github.com:o/r.git']) {
        expect(judge({ selector: '417', repo }, m), repo).toHaveProperty('deny');
      }
    });
  });
});

describe('the stop poll and the background flag', () => {
  it('stopWaits is true only for the server\'s { stop: true }', () => {
    expect(stopWaits('{"session":"s-1","stop":true}')).toBe(true);
    for (const t of ['{"stop":false}', '{"stop":"true"}', '{}', 'null', '[]', '', '<html>a proxy answered</html>']) expect(stopWaits(t), t).toBe(false);
  });

  it('background is read from the agent file\'s frontmatter only', () => {
    expect(backgroundFromFrontmatter('---\nname: scout\nbackground: true\n---\nbody')).toBe(true);
    expect(backgroundFromFrontmatter('---\nname: scout\nbackground: "true" # always\n---\nbody')).toBe(true);
    for (const t of ['---\nname: scout\nbackground: false\n---', '---\nname: scout\n---\nbackground: true', 'background: true', '---\nname: scout\nbackgrounded: true\n---']) expect(backgroundFromFrontmatter(t), t).toBeUndefined();
  });
});
