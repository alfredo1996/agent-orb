// v0.4 slice 2 (#28, Factory): the issue a branch name names. A session on such a branch counts whole for that issue; the plugin reads a PR's head the same way.
// A number right after the type prefix (`fix/90-…`), or leading a branch with none (GitHub's own `90-fix-thing`), then `-`, `_` or the end.
// R10 (#32): at most five digits (no repository this tool is for has an issue #100000), and not a year and month (`deps/2026-11-03`, `hotfix/2026-11-fix`): a dated branch is no issue #2026.
// ponytail: by shape alone, so a branch named for a tracker key (`ABC-123`) or a version reads as none, and a real issue #2026 on `fix/2026-11-x` is missed. packages/mod/hooks/core.ts has a
// copy, since the plugin imports nothing from shared; packages/mod/test/contract.spec.ts holds both to one table.
const BRANCH_ISSUE = /^(?:[^/]+\/)*(?!(?:19|20)\d{2}-(?:0[1-9]|1[0-2])(?!\d))([1-9]\d{0,4})(?:[-_]|$)/;

export const branchIssue = (branch: string | null | undefined): number | null => {
  const m = branch ? BRANCH_ISSUE.exec(branch) : null;
  return m ? Number(m[1]) : null;
};
