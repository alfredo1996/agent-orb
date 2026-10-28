import { describe, expect, it } from 'vitest';
import { Event } from '../../shared/src/index.ts';
import { build, fingerprintFiles, fingerprintsFrom, type Ctx, type FpFile, type FpFs } from '../hooks/core.ts';

// v0.2 slice 3 (PROJECT.md §15, 2026-10-24): what a change watches, listed at session start and hashed with one `git hash-object`.
// An in-memory file tree stands for `$.fs`: a directory lists its entries as the engine does, and a missing one rejects.
const tree = (files: string[], other: string[] = []): FpFs & { listed: string[] } => {
  const listed: string[] = [];
  return {
    listed,
    exists: async (path) => files.includes(path),
    list: async (dir) => {
      listed.push(dir);
      const prefix = `${dir}/`;
      const entries = new Map<string, 'file' | 'dir' | 'other'>();
      for (const f of files) if (f.startsWith(prefix)) entries.set(f.slice(prefix.length).split('/')[0]!, f.slice(prefix.length).includes('/') ? 'dir' : 'file');
      for (const f of other) if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) entries.set(f.slice(prefix.length), 'other');
      if (!entries.size) throw new Error(`ENOENT: ${dir}`);
      return [...entries].map(([name, kind]) => ({ name, kind })).reverse(); // not sorted: the listing must sort
    },
  };
};
const ROOT = '/repo';
const HOME = '/home/me';
const at = (files: FpFile[]) => files.map((f) => [f.scope, f.path]);

describe('fingerprintFiles', () => {
  it('lists every file under .claude/agents and .claude/skills (recursive) and CLAUDE.md, project-relative, sorted', async () => {
    const fs = tree([
      `${ROOT}/CLAUDE.md`, `${ROOT}/.claude/agents/scout.md`, `${ROOT}/.claude/agents/implementer.md`,
      `${ROOT}/.claude/skills/code/SKILL.md`, `${ROOT}/.claude/skills/code/refs/deep/notes.md`, `${ROOT}/.claude/skills/pr/SKILL.md`,
      `${ROOT}/.claude/settings.json`, `${ROOT}/src/index.ts`, // not watched
    ]);
    const files = await fingerprintFiles(ROOT, undefined, fs);
    expect(at(files)).toEqual([
      ['project', '.claude/agents/implementer.md'], ['project', '.claude/agents/scout.md'],
      ['project', '.claude/skills/code/SKILL.md'], ['project', '.claude/skills/code/refs/deep/notes.md'], ['project', '.claude/skills/pr/SKILL.md'],
      ['project', 'CLAUDE.md'],
    ]);
    expect(files.map((f) => f.abs)).toEqual(files.map((f) => `${ROOT}/${f.path}`)); // the absolute path goes to git
  });

  it('lists the owner\'s ~/.claude/CLAUDE.md and ~/.claude/rules/*.md, written ~/.claude/..., scope user', async () => {
    const fs = tree([
      `${HOME}/.claude/CLAUDE.md`, `${HOME}/.claude/rules/git.md`, `${HOME}/.claude/rules/communication.md`,
      `${HOME}/.claude/rules/notes.txt`, `${HOME}/.claude/rules/old/scope.md`, `${HOME}/.claude/settings.json`, `${HOME}/.claude/agents/x.md`, // not watched
    ]);
    const files = await fingerprintFiles(ROOT, HOME, fs);
    expect(at(files)).toEqual([['user', '~/.claude/CLAUDE.md'], ['user', '~/.claude/rules/communication.md'], ['user', '~/.claude/rules/git.md']]);
    expect(files.map((f) => f.abs)).toEqual([`${HOME}/.claude/CLAUDE.md`, `${HOME}/.claude/rules/communication.md`, `${HOME}/.claude/rules/git.md`]);
  });

  it('the project comes first, then the owner\'s files', async () => {
    const files = await fingerprintFiles(ROOT, HOME, tree([`${HOME}/.claude/CLAUDE.md`, `${ROOT}/CLAUDE.md`]));
    expect(at(files)).toEqual([['project', 'CLAUDE.md'], ['user', '~/.claude/CLAUDE.md']]);
  });

  it('a missing folder is fine, and so is no file at all; no home leaves the owner\'s files out', async () => {
    expect(await fingerprintFiles(ROOT, HOME, tree([]))).toEqual([]);
    expect(at(await fingerprintFiles(ROOT, HOME, tree([`${ROOT}/CLAUDE.md`])))).toEqual([['project', 'CLAUDE.md']]);
    expect(at(await fingerprintFiles(ROOT, HOME, tree([`${ROOT}/.claude/skills/a/SKILL.md`])))).toEqual([['project', '.claude/skills/a/SKILL.md']]);
    expect(at(await fingerprintFiles(ROOT, undefined, tree([`${HOME}/.claude/CLAUDE.md`, `${ROOT}/CLAUDE.md`])))).toEqual([['project', 'CLAUDE.md']]);
  });

  it('a folder that cannot be listed does not sink the others', async () => {
    const fs = tree([`${ROOT}/.claude/agents/a.md`, `${ROOT}/.claude/skills/s/SKILL.md`]);
    const list = fs.list;
    fs.list = async (dir) => (dir.endsWith('/agents') ? Promise.reject(new Error('EACCES')) : list(dir));
    expect(at(await fingerprintFiles(ROOT, HOME, fs))).toEqual([['project', '.claude/skills/s/SKILL.md']]);
  });

  it('skips hidden files (.DS_Store changes whenever Finder looks), node_modules, symbolic links, and names git cannot take one per line', async () => {
    const fs = tree([
      `${ROOT}/.claude/skills/a/SKILL.md`, `${ROOT}/.claude/skills/a/.DS_Store`, `${ROOT}/.claude/skills/a/.hidden/x.md`,
      `${ROOT}/.claude/skills/a/node_modules/dep/index.js`, `${ROOT}/.claude/agents/odd\nname.md`,
      `${HOME}/.claude/rules/.DS_Store`, `${HOME}/.claude/rules/keep.md`,
    ], [`${ROOT}/.claude/agents/linked.md`, `${ROOT}/.claude/skills/linkdir`]);
    expect(at(await fingerprintFiles(ROOT, HOME, fs))).toEqual([['project', '.claude/skills/a/SKILL.md'], ['user', '~/.claude/rules/keep.md']]);
  });

  it('skips a path over 300 characters (a path travels in the event, and the event must fit one request)', async () => {
    const long = `.claude/skills/${'x'.repeat(290)}/SKILL.md`;
    expect(at(await fingerprintFiles(ROOT, undefined, tree([`${ROOT}/${long}`, `${ROOT}/.claude/skills/ok/SKILL.md`])))).toEqual([['project', '.claude/skills/ok/SKILL.md']]);
  });

  it('keeps at most 500 files under agents and skills (the first 500 by path), and 100 of the owner\'s rules', async () => {
    const skills = Array.from({ length: 600 }, (_, i) => `${ROOT}/.claude/skills/s${String(i).padStart(3, '0')}/SKILL.md`);
    const rules = Array.from({ length: 150 }, (_, i) => `${HOME}/.claude/rules/r${String(i).padStart(3, '0')}.md`);
    const files = await fingerprintFiles(ROOT, HOME, tree([...skills, ...rules, `${ROOT}/CLAUDE.md`, `${HOME}/.claude/CLAUDE.md`]));
    const project = files.filter((f) => f.scope === 'project');
    expect(project).toHaveLength(501); // 500 and CLAUDE.md
    expect(project[0]!.path).toBe('.claude/skills/s000/SKILL.md');
    expect(project[499]!.path).toBe('.claude/skills/s499/SKILL.md');
    expect(project[500]!.path).toBe('CLAUDE.md');
    expect(files.filter((f) => f.scope === 'user')).toHaveLength(101); // CLAUDE.md and 100 rules
    expect(files.length).toBeLessThanOrEqual(1000); // what the schema takes
  });
});

describe('fingerprintsFrom', () => {
  const files: FpFile[] = [
    { abs: '/repo/CLAUDE.md', path: 'CLAUDE.md', scope: 'project' },
    { abs: '/home/me/.claude/CLAUDE.md', path: '~/.claude/CLAUDE.md', scope: 'user' },
  ];
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(64);

  it('pairs the blob ids git printed, one per line, with the files in the order they were sent', () => {
    expect(fingerprintsFrom(files, `${a}\n${b}\n`)).toEqual([
      { path: 'CLAUDE.md', hash: a, scope: 'project' }, { path: '~/.claude/CLAUDE.md', hash: b, scope: 'user' },
    ]);
    expect(fingerprintsFrom(files, `${a}\r\n${b}\r\n`)).toHaveLength(2);
  });

  it('sends nothing when the output cannot be trusted line for line: too few, too many, or not blob ids', () => {
    expect(fingerprintsFrom(files, `${a}\n`)).toEqual([]);
    expect(fingerprintsFrom(files, `${a}\n${b}\n${a}\n`)).toEqual([]);
    expect(fingerprintsFrom(files, `${a}\nfatal: cannot open\n`)).toEqual([]);
    expect(fingerprintsFrom(files, `${a}\n${'A'.repeat(40)}\n`)).toEqual([]);
    expect(fingerprintsFrom(files, '')).toEqual([]);
    expect(fingerprintsFrom([], '')).toEqual([]);
  });
});

describe('build.projectFingerprint', () => {
  const ctx: Ctx = { host: 'mbp', session_id: 's-1', project: { cwd: '/r', name: 'r', git_remote: 'github.com/o/r' } };

  it('passes the shared schema unchanged', () => {
    const e = build.projectFingerprint(ctx, [{ path: 'CLAUDE.md', hash: 'a'.repeat(40), scope: 'project' }, { path: '~/.claude/rules/git.md', hash: 'b'.repeat(40), scope: 'user' }]);
    const parsed = Event.safeParse(e);
    expect(parsed.error).toBeUndefined();
    expect(parsed.data).toEqual(e);
  });
});
