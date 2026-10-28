import { describe, expect, it } from 'vitest';
import { Event } from '../../shared/src/index.ts';
import { build, changesArgv, parseChanges, type Ctx } from '../hooks/core.ts';

// v0.2 slice 1: the git history of what a change watches (.claude/agents, .claude/skills, CLAUDE.md), read once at session start.
// The text below is `git log --all --reverse --format=C%x1f%H%x1f%ct%x1f%s --raw --no-abbrev` as git prints it: a header, a blank line,
// a raw line per file (`:<mode> <mode> <old blob> <new blob> <status>\t<path>`), the next header. Oldest first, every ref.
const US = '\x1f';
const sha = (c: string) => c.repeat(40);
const A = sha('a');
const B = sha('b');
const C = sha('c');
const D = sha('d');
const blob = (n: number) => n.toString(16).padStart(40, '0');
const ZERO = blob(0);
const header = (id: string, ts: number, subject: string) => `C${US}${id}${US}${ts}${US}${subject}`;
const modify = (path: string, from: number, to: number) => `:100644 100644 ${blob(from)} ${blob(to)} M\t${path}`;
const add = (path: string, to: number) => `:000000 100644 ${ZERO} ${blob(to)} A\t${path}`;
const remove = (path: string, from: number) => `:100644 000000 ${blob(from)} ${ZERO} D\t${path}`;
const rename = (from: string, to: string, b: number, score = 100) => `:100644 100644 ${blob(b)} ${blob(b)} R${score}\t${from}\t${to}`;
const commit = (id: string, ts: number, subject: string, ...raw: string[]) => [header(id, ts, subject), '', ...raw, ''].join('\n');

// A feature commit B on a branch, then the squash C that carried it to the release branch, days later, then a real change D.
const SKILL = '.claude/skills/code/SKILL.md';
const log = [
  commit(B, 1_792_800_000, 'feat: the agents are routed', modify(SKILL, 1, 2), modify('CLAUDE.md', 3, 4)),
  commit(C, 1_792_900_000, 'chore(release): 0.13.0', modify(SKILL, 1, 2), modify('CLAUDE.md', 3, 4)),
  commit(D, 1_792_950_000, `fix: subject with a ${US} inside`, modify('.claude/agents/a.md', 5, 6)),
].join('\n');

describe('changesArgv', () => {
  it('asks git for 90 days of every ref, oldest first, with the blob ids, over the three watched places', () => {
    expect(changesArgv('/repo')).toEqual([
      'git', '-C', '/repo', 'log', '--all', '--reverse', '--since=90.days', '--format=C%x1f%H%x1f%ct%x1f%s', '--raw', '--no-abbrev', '--', '.claude/agents', '.claude/skills', 'CLAUDE.md',
    ]);
  });
});

describe('parseChanges', () => {
  it('reads each commit: sha, time in ms, subject and its files, oldest first as git prints them', () => {
    expect(parseChanges(log).map((c) => c.sha)).toEqual([B, D]);
    expect(parseChanges(log)[0]).toEqual({ sha: B, ts: 1_792_800_000_000, subject: 'feat: the agents are routed', files: [SKILL, 'CLAUDE.md'], blobs: [blob(2), blob(4)] });
    expect(parseChanges(log)[1]).toEqual({ sha: D, ts: 1_792_950_000_000, subject: `fix: subject with a ${US} inside`, files: ['.claude/agents/a.md'], blobs: [blob(6)] });
  });

  it('a squash commit that repeats a feature commit\'s blobs is dropped: the change is dated at the feature commit', () => {
    const commits = parseChanges(log);
    expect(commits.map((c) => c.subject)).not.toContain('chore(release): 0.13.0');
    expect(commits[0]!.ts).toBe(1_792_800_000_000);
  });

  it('a commit with one new file and one repeated file keeps only the new one', () => {
    const text = [
      commit(A, 1_792_000_000, 'feat: first', modify(SKILL, 1, 2)),
      commit(B, 1_792_100_000, 'chore(release): both', modify(SKILL, 1, 2), modify('CLAUDE.md', 3, 4)),
    ].join('\n');
    expect(parseChanges(text).map((c) => [c.sha, c.files])).toEqual([[A, [SKILL]], [B, ['CLAUDE.md']]]);
  });

  it('the same path at another version is a new change, and the same version at another path is too', () => {
    const text = [
      commit(A, 1_792_000_000, 'one', modify('CLAUDE.md', 1, 2)),
      commit(B, 1_792_100_000, 'two', modify('CLAUDE.md', 2, 3), modify(SKILL, 1, 2)),
    ].join('\n');
    expect(parseChanges(text).map((c) => [c.sha, c.files])).toEqual([[A, ['CLAUDE.md']], [B, ['CLAUDE.md', SKILL]]]);
  });

  it('a revert is a change: a file going back to an earlier version counts, and a copy of the revert after it does not', () => {
    const text = [
      commit(A, 1_792_000_000, 'one', modify('CLAUDE.md', 1, 2)),
      commit(B, 1_792_100_000, 'two', modify('CLAUDE.md', 2, 3)),
      commit(C, 1_792_200_000, 'revert', modify('CLAUDE.md', 3, 2)), // back to a version seen before, but it differs from the file's last one
      commit(D, 1_792_300_000, 'release copy of the revert', modify('CLAUDE.md', 3, 2)), // the file already is at 2: a repeat
    ].join('\n');
    expect(parseChanges(text).map((c) => [c.sha, c.files])).toEqual([[A, ['CLAUDE.md']], [B, ['CLAUDE.md']], [C, ['CLAUDE.md']]]);
  });

  it('a file deleted, added back and deleted again: the second deletion counts', () => {
    const text = [
      commit(A, 1_792_000_000, 'add', add('.claude/agents/a.md', 1)),
      commit(B, 1_792_100_000, 'delete', remove('.claude/agents/a.md', 1)),
      commit(C, 1_792_200_000, 'add back', add('.claude/agents/a.md', 1)),
      commit(D, 1_792_300_000, 'delete again', remove('.claude/agents/a.md', 1)),
    ].join('\n');
    expect(parseChanges(text).map((c) => [c.sha, c.files])).toEqual([[A, ['.claude/agents/a.md']], [B, ['.claude/agents/a.md']], [C, ['.claude/agents/a.md']], [D, ['.claude/agents/a.md']]]);
  });

  it('a file added, renamed (the new name counts) and deleted (a second deletion of it is a repeat)', () => {
    const text = [
      commit(A, 1_792_000_000, 'add', add('.claude/agents/old.md', 1)),
      commit(B, 1_792_100_000, 'rename', rename('.claude/agents/old.md', '.claude/agents/new.md', 1), rename('.claude/agents/x.md', '.claude/agents/y.md', 7, 87)),
      commit(C, 1_792_200_000, 'delete', remove('.claude/agents/new.md', 1)),
      commit(D, 1_792_300_000, 'delete again, as a squash does', remove('.claude/agents/new.md', 1), remove('.claude/agents/other.md', 8)),
    ].join('\n');
    expect(parseChanges(text).map((c) => [c.sha, c.files])).toEqual([
      [A, ['.claude/agents/old.md']],
      [B, ['.claude/agents/new.md', '.claude/agents/y.md']],
      [C, ['.claude/agents/new.md']],
      [D, ['.claude/agents/other.md']],
    ]);
  });

  it('blobs: each file\'s new blob, parallel to files (v0.2 slice 3); a deletion is the all-zero blob, a rename carries the blob under its new name', () => {
    const text = [
      commit(A, 1_792_000_000, 'add and change', add('.claude/agents/a.md', 7), modify('CLAUDE.md', 1, 2)),
      commit(B, 1_792_100_000, 'rename and delete', rename('.claude/agents/a.md', '.claude/agents/b.md', 7), remove('CLAUDE.md', 2)),
    ].join('\n');
    expect(parseChanges(text).map((c) => [c.files, c.blobs])).toEqual([
      [['.claude/agents/a.md', 'CLAUDE.md'], [blob(7), blob(2)]],
      [['.claude/agents/b.md', 'CLAUDE.md'], [blob(7), ZERO]],
    ]);
  });

  it('blobs stay parallel to files when a repeated file is dropped from a commit, and when files are capped at 50', () => {
    const text = [
      commit(A, 1_792_000_000, 'first', modify(SKILL, 1, 2)),
      commit(B, 1_792_100_000, 'release copy plus one new file', modify(SKILL, 1, 2), modify('CLAUDE.md', 3, 4)),
    ].join('\n');
    expect(parseChanges(text).map((c) => [c.files, c.blobs])).toEqual([[[SKILL], [blob(2)]], [['CLAUDE.md'], [blob(4)]]]);
    const many = Array.from({ length: 60 }, (_, i) => modify(`.claude/skills/s${i}/SKILL.md`, i, i + 100));
    const [one] = parseChanges(commit(A, 1_792_836_417, 's', ...many));
    expect(one!.blobs).toEqual(Array.from({ length: 50 }, (_, i) => blob(i + 100)));
  });

  it('leaves the subject out for an excluded project, and keeps everything else', () => {
    const commits = parseChanges(log, false);
    expect(commits.map((c) => c.sha)).toEqual([B, D]);
    expect(commits.map((c) => c.files)).toEqual([[SKILL, 'CLAUDE.md'], ['.claude/agents/a.md']]);
    expect(commits.every((c) => !('subject' in c))).toBe(true);
    expect(JSON.stringify(commits)).not.toMatch(/routed|release|inside/);
  });

  it('nothing, or output that is not a log, gives no commits', () => {
    expect(parseChanges('')).toEqual([]);
    expect(parseChanges('\n\n')).toEqual([]);
    expect(parseChanges('fatal: not a git repository\n')).toEqual([]);
    expect(parseChanges(`${header(A, 1_792_836_417, 'x').replace(String(1_792_836_417), 'not-a-time')}\n\n${modify('CLAUDE.md', 1, 2)}\n`)).toEqual([]);
    expect(parseChanges(`${header(A, 0, 'x')}\n\n${modify('CLAUDE.md', 1, 2)}\n`)).toEqual([]); // ts must be positive
    expect(parseChanges(`${header(A, 1_792_836_417, 'a merge touching nothing listed')}\n\n`)).toEqual([]); // no file lines, no change
    expect(parseChanges(`${modify('CLAUDE.md', 1, 2)}\n`)).toEqual([]); // a file line before any header belongs to no commit
  });

  it('caps a subject at 200 characters and a commit at 50 files', () => {
    const many = Array.from({ length: 60 }, (_, i) => modify(`.claude/skills/s${i}/SKILL.md`, i, i + 100));
    const [one] = parseChanges(commit(A, 1_792_836_417, 's'.repeat(900), ...many));
    expect(one!.subject).toHaveLength(200);
    expect(one!.files).toEqual(many.slice(0, 50).map((_, i) => `.claude/skills/s${i}/SKILL.md`));
  });

  it('caps the list at 500 commits, dropping the oldest', () => {
    const lots = Array.from({ length: 600 }, (_, i) => commit(blob(i + 1), 1_792_000_000 + i, `c${i}`, modify('CLAUDE.md', i, i + 1))).join('\n');
    const commits = parseChanges(lots);
    expect(commits).toHaveLength(500);
    expect(commits[0]!.sha).toBe(blob(101)); // the 100 oldest are gone
    expect(commits.at(-1)!.sha).toBe(blob(600)); // the newest stays last
  });

  it('stops before the event outgrows what the server takes in one request (1 MB), dropping the oldest', () => {
    const path = (i: number, j: number) => `.claude/skills/${'x'.repeat(80)}-${i}-${j}/SKILL.md`;
    const fat = Array.from({ length: 300 }, (_, i) => commit(blob(i + 1), 1_792_000_000 + i, 'c', ...Array.from({ length: 50 }, (_, j) => modify(path(i, j), i * 100 + j + 1, i * 100 + j + 2)))).join('\n');
    const commits = parseChanges(fat);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.length).toBeLessThan(300);
    expect(commits.at(-1)!.sha).toBe(blob(300));
    expect(commits[0]!.sha).not.toBe(blob(1));
    expect(JSON.stringify({ commits }).length).toBeLessThanOrEqual(300_000);
  });

  it('a 64-character object name (a SHA-256 repository) is cut to the 40 the schema takes', () => {
    const [c] = parseChanges(`${header('d'.repeat(64), 1_792_836_417, 'x')}\n\n:100644 100644 ${'1'.repeat(64)} ${'2'.repeat(64)} M\tCLAUDE.md\n`);
    expect(c!.sha).toBe('d'.repeat(40));
    expect(c!.files).toEqual(['CLAUDE.md']);
  });
});

describe('build.projectChanges', () => {
  const ctx: Ctx = { host: 'mbp', session_id: 's-1', project: { cwd: '/r', name: 'r', git_remote: 'github.com/o/r' } };

  it('passes the shared schema unchanged, with and without subjects', () => {
    for (const subjects of [true, false]) {
      const e = build.projectChanges(ctx, parseChanges(log, subjects));
      const parsed = Event.safeParse(e);
      expect(parsed.error).toBeUndefined();
      expect(parsed.data).toEqual(e);
    }
  });
});
