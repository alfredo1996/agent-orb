import { describe, expect, it } from 'vitest';
import { descriptionOf, preloadOf, refsIn } from '../hooks/core.ts';

// Slice 5: the names a skill's or agent's text mentions, matched only against the session's own lists.
const names = { skills: ['pr', 'test', 'code', 'pr-body', 'ponytail:ponytail'], agents: ['implementer', 'test-runner', 'adversarial-reviewer'] };

describe('refsIn', () => {
  it('finds /name, "the name skill", `name` skill and Skill("name"), never itself', () => {
    const text = 'Then run /pr. Use the test skill after. The `pr-body` skill writes it. Skill("ponytail:ponytail"). This is /code.';
    expect(refsIn(text, names, 'code')).toEqual({ skills: ['pr', 'test', 'pr-body', 'ponytail:ponytail'], agents: [] });
  });

  it('ignores paths and words that only contain a name', () => {
    const text = 'See src/lib/pr/x.ts, /pr-bodyx, the /tests folder, a code review, test it, packages/code.';
    expect(refsIn(text, names)).toEqual({ skills: [], agents: [] });
  });

  it('finds agent types as whole names: test-runner is not test, implementer-like is not implementer', () => {
    const text = 'Dispatch implementer, then the test-runner (subagent_type: adversarial-reviewer). An implementer-like helper.';
    expect(refsIn(text, names)).toEqual({ skills: [], agents: ['implementer', 'test-runner', 'adversarial-reviewer'] });
  });

  it('lists each name once, in the order first seen', () => {
    expect(refsIn('/pr and /pr again, then the test skill and /test', names).skills).toEqual(['pr', 'test']);
  });
});

describe('preloadOf', () => {
  it('reads an agent definition\'s skills list, block or inline', () => {
    expect(preloadOf('---\nname: scout\nskills:\n  - beta\n  - "gamma"\nmodel: haiku\n---\nbody')).toEqual(['beta', 'gamma']);
    expect(preloadOf('---\nname: s\nskills: [beta, gamma]\n---\n')).toEqual(['beta', 'gamma']);
    expect(preloadOf('---\nname: s\n---\nskills:\n  - not-frontmatter\n')).toEqual([]);
  });
});

describe('descriptionOf (issue #8)', () => {
  it('reads an agent definition\'s description: plain, quoted, or a folded block', () => {
    expect(descriptionOf('---\nname: scout\ndescription: Lists files and reports\n---\nbody')).toBe('Lists files and reports');
    expect(descriptionOf('---\ndescription: "Quoted: with a colon"\n---\n')).toBe('Quoted: with a colon');
    expect(descriptionOf('---\nname: s\ndescription: >\n  Tries to break\n  the fix.\nmodel: opus\n---\n')).toBe('Tries to break the fix.');
  });
  it('is nothing when the frontmatter has none, or the word is only in the body', () => {
    expect(descriptionOf('---\nname: s\n---\ndescription: not frontmatter')).toBeUndefined();
    expect(descriptionOf('no frontmatter at all')).toBeUndefined();
  });
});
