import { describe, expect, it } from 'vitest';
import { branchIssue } from '../src/index.ts';
import { BRANCH_ISSUES } from './class-tables.ts';

// #28 (Factory, issue cost): a session on an issue branch counts whole for that issue. The plugin has a copy, held to the same rows by packages/mod/test/contract.spec.ts.
describe('branchIssue', () => {
  it.each(BRANCH_ISSUES.map(([b, n]) => [b, n] as const))('%j names %j', (branch, issue) => {
    expect(branchIssue(branch)).toBe(issue);
  });
});
