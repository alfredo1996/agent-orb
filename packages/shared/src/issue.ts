// v0.4 slice 2 (#28, Factory): the issue a branch name names. A session on such a branch counts whole for that issue; the plugin reads a PR's head the same way.
// A number right after the type prefix (`fix/90-…`), or leading a branch with none (GitHub's own `90-fix-thing`), then `-`, `_` or the end.
// ponytail: by shape alone, so `hotfix/2026-11-fix` reads as #2026, and a branch named for a tracker key (`ABC-123`) or a version reads as none. packages/mod/hooks/core.ts has a
// copy, since the plugin imports nothing from shared; packages/mod/test/contract.spec.ts holds both to one table.
const BRANCH_ISSUE = /^(?:[^/]+\/)*([1-9]\d{0,8})(?:[-_]|$)/;

export const branchIssue = (branch: string | null | undefined): number | null => {
  const m = branch ? BRANCH_ISSUE.exec(branch) : null;
  return m ? Number(m[1]) : null;
};
