import type { Fate } from '@agent-orb/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { findingId, type ContentStore } from '../content-store.ts';
import { all, get, type Row, type Store } from '../store/store.ts';

// v0.4 slice 1 (#27, Factory; PROJECT.md §15, 2026-11-03): whether each open PR is ready for the owner's ok, from what the plugin sent.
//   GET /api/factory?project=<name>[&remote=<repo>]  the open PRs as last read, each with ready(), its four conditions and its findings (latest fate each), and when GitHub was read;
//                                    with `remote` only that repository's (the merge refusal asks so, #31: two projects can bear one name)
// Ready means ready for the owner's ok: nothing here merges, and nothing reaches the machine.

export type Check = { name: string; state: 'pass' | 'fail' | 'pending'; ci?: true };
export type PrState = { headOid: string; mergeState: string; lastCommitAt?: number; checks: Check[]; bots: { author: string; at: number }[] };
/** A branch's findings, the latest fate each, how many lines its reports dropped, and when its last report came; undefined when no report reached the branch. */
export type Ledger = { findings: { severity: string; fate: Fate }[]; dropped: number; at: number } | undefined;
/** ok: true holds, false is a definite no, null is not known (no report yet, a check running, GitHub still working it out). */
export type Cond = { ok: boolean | null; note: string };
export type Readiness = { ready: boolean; reason: string | null; conditions: { findings: Cond; gate: Cond; bots: Cond; clean: Cond } };

const short = (oid: string) => oid.slice(0, 7);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andMore = (names: string[]) => (names.length > 1 ? `${names[0]} and ${names.length - 1} more` : names[0]!);
const SEVERITY = ['blocker', 'critical', 'major', 'minor', 'nit'];
const rank = (s: string) => (SEVERITY.includes(s) ? SEVERITY.indexOf(s) : SEVERITY.length);
const GLOSS: Record<string, string> = {
  UNSTABLE: 'a check is not passing', BLOCKED: 'a required review or check is missing', BEHIND: 'the branch is behind its base', DIRTY: 'it conflicts with its base',
  DRAFT: 'it is a draft', HAS_HOOKS: 'GitHub reads it as mergeable with hooks, not clean',
};

function findingsCond(l: Ledger): Cond {
  if (!l) return { ok: null, note: 'No findings reported yet' };
  const open = l.findings.filter((f) => f.fate === 'open');
  if (open.length) {
    const by = new Map<string, number>();
    for (const f of open.toSorted((a, b) => rank(a.severity) - rank(b.severity) || (a.severity < b.severity ? -1 : 1))) by.set(f.severity, (by.get(f.severity) ?? 0) + 1);
    return { ok: false, note: `${plural(open.length, 'finding')} open: ${[...by].map(([s, k]) => `${k} ${s}`).join(', ')}` };
  }
  if (l.dropped) return { ok: null, note: `${plural(l.dropped, 'line')} of the last report didn't parse` }; // the line may have been an open finding
  if (!l.findings.length) return { ok: true, note: 'Reported, none found' };
  const count = (fate: Fate) => l.findings.filter((f) => f.fate === fate).length;
  return { ok: true, note: `${count('fixed')} fixed, ${count('dismissed')} dismissed, none open` };
}

/**
 * The gate on the head: GitHub's checks when CI runs, otherwise the last test run the plugin saw on that commit, on a clean tree (#34). CI is a check of a GitHub Actions
 * workflow (`ci`); an app's check (CodeRabbit, Sonar) is no CI, so with only those a test run is still asked. Any check that failed is a no, and a quality gate (Sonar) is a
 * check, which is condition 3's "every quality-gate check passed" too; a test run that failed on this head is a no whatever CI says.
 * ponytail: CI that is not Actions (a StatusContext from another service) is not CI here, so such a repo needs a test run too: the safe way round.
 */
function gateCond(pr: PrState, gate: { result: 'pass' | 'fail' } | undefined): Cond {
  const failed = pr.checks.filter((c) => c.state === 'fail').map((c) => c.name);
  if (failed.length) return { ok: false, note: `${andMore(failed)} failed` };
  if (gate?.result === 'fail') return { ok: false, note: `Test run failed on ${short(pr.headOid)}` };
  const running = pr.checks.filter((c) => c.state === 'pending').map((c) => c.name);
  if (running.length) return { ok: null, note: `${andMore(running)} is running` };
  if (pr.checks.some((c) => c.ci)) return { ok: true, note: `${plural(pr.checks.length, 'check')} passed` };
  return gate ? { ok: true, note: `Test run passed on ${short(pr.headOid)}` } : { ok: null, note: `No test run on ${short(pr.headOid)}` };
}

// Sonar is judged by its check, not its comment (owner, 2026-11-03, #27): it comments after it analyses each push, and its quality gate is a check, which condition 2 reads.
// ponytail: by name, as the plugin finds bots; another quality bot that comments on every push would block until it is named here.
const QUALITY_BOTS = new Set(['sonarqubecloud', 'sonarcloud']);

/**
 * Condition 3: no bot comment newer than the last commit that nobody read. A review bot's comment (CodeRabbit) counts only until a findings report on the branch comes
 * after it: every review finding goes to the fixer, so that report is the fixer having read it (owner, 2026-11-03, #27).
 */
function botsCond(pr: PrState, ledger: Ledger): Cond {
  const unread = pr.bots.filter((b) => !QUALITY_BOTS.has(b.author.toLowerCase()) && !(ledger && ledger.at > b.at));
  if (!unread.length) return { ok: true, note: 'No unread bot comment since the last commit' };
  if (pr.lastCommitAt === undefined) return { ok: null, note: 'The last commit\'s time is unknown' };
  const newer = unread.filter((b) => b.at > pr.lastCommitAt!).toSorted((a, b) => b.at - a.at).map((b) => b.author);
  return newer.length ? { ok: false, note: `${andMore(newer)} commented after the last commit, and no findings report since` } : { ok: true, note: 'No unread bot comment since the last commit' };
}

function cleanCond(state: string): Cond {
  if (state === 'CLEAN') return { ok: true, note: 'CLEAN' };
  if (state === 'UNKNOWN') return { ok: null, note: 'GitHub hasn\'t worked out the merge state yet' };
  return { ok: false, note: GLOSS[state] ? `${state}: ${GLOSS[state]}` : state };
}

/**
 * The merge check (#20): ready when, and only when, all four hold. 1. no finding is open; 2. the gate passed on the PR's own head; 3. no bot comment is newer than the
 * last commit, unless a findings report came after it (Sonar is judged by its check); 4. mergeStateStatus is CLEAN (MERGEABLE is not enough: NeoBoard's #2405 read MERGEABLE and UNSTABLE at once). The reason is the first that does not hold.
 */
export function ready(pr: PrState, ledger: Ledger, gate: { result: 'pass' | 'fail' } | undefined): Readiness {
  const conditions = { findings: findingsCond(ledger), gate: gateCond(pr, gate), bots: botsCond(pr, ledger), clean: cleanCond(pr.mergeState) };
  const first = Object.values(conditions).find((c) => c.ok !== true);
  return { ready: !first, reason: first?.note ?? null, conditions };
}

const FATE_ORDER: Fate[] = ['open', 'dismissed', 'fixed']; // the sheet's order: what blocks, what you read before merging, what was done
const Query = z.object({ project: z.string().min(1), remote: z.string().min(1).optional() });
const STALE_MS = 10 * 60_000; // two reads missed (the plugin reads every 5 minutes): no session reads this repo now, and the merge refusal (#31) stops trusting it too

export function factory(app: FastifyInstance, { store, content, now = Date.now }: { store: Store; content: ContentStore; now?: () => number }) {
  app.get('/api/factory', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a project', issues: q.error.issues });
    const { project } = q.data;
    const remote = q.data.remote ?? null;
    // Every project row with the name, like the goal (a repo seen from two machines is two rows when it has no remote); with a remote, that repository's rows alone.
    const readAt = get(store, 'SELECT max(prs_read_at) AS at FROM projects WHERE name = :project AND (:remote IS NULL OR git_remote = :remote)', { project, remote })?.at ?? null;
    // #28: the issue each PR closes is on its pull_requests row (the open-PR read put it there), which the cost on the page is matched to.
    const rows = all(store, `SELECT o.*, pr.issue AS issue FROM open_prs o JOIN projects p ON p.id = o.project_id
      LEFT JOIN pull_requests pr ON pr.id = o.project_id || ':' || o.number WHERE p.name = :project AND (:remote IS NULL OR p.git_remote = :remote)`, { project, remote });
    const prs = rows.map((r) => {
      const pr: PrState = { headOid: r.head_oid, mergeState: r.merge_state, lastCommitAt: r.last_commit_at ?? undefined, checks: JSON.parse(r.checks), bots: JSON.parse(r.bots) };
      // A PR's findings are the reports that named it (```orb-findings #416) and those made on its head branch, the latest fate of each id winning across both. Its
      // dropped count is the named reports' when there are any: those are the ones written for this PR.
      const refs = { p: r.project_id, pr: `pr:${r.number}`, b: r.head ?? `pr:${r.number}` };
      const reports = all(store, 'SELECT ref, dropped, ts FROM finding_reports WHERE project_id = :p AND ref IN (:pr, :b)', refs);
      const named = reports.find((x) => x.ref === refs.pr);
      const report = reports.length ? { dropped: (named ?? reports[0]!).dropped as number, ts: Math.max(...reports.map((x) => x.ts as number)) } : undefined;
      const latest = new Map<string, Row>();
      for (const f of all(store, 'SELECT ref, id, severity, file, fate, ts FROM findings WHERE project_id = :p AND ref IN (:pr, :b)', refs)) {
        if (!(latest.get(f.id)?.ts >= f.ts)) latest.set(f.id, f);
      }
      const list = [...latest.values()];
      const gate = get(store, 'SELECT result FROM gates WHERE project_id = :p AND substr(:oid, 1, length(commit_sha)) = commit_sha ORDER BY ts DESC LIMIT 1', { p: r.project_id, oid: r.head_oid });
      // A title may have come with either ref's report (a branch round with Content on, then a numbered one): the latest ref's first. A reason only with the latest fate.
      const text = content.get(list.flatMap((f) => [refs.pr, refs.b].map((ref) => ({ node: 'finding' as const, id: findingId(r.project_id, ref, f.id) }))));
      const findings = list
        .toSorted((a, b) => FATE_ORDER.indexOf(a.fate) - FATE_ORDER.indexOf(b.fate) || rank(a.severity) - rank(b.severity) || (a.id < b.id ? -1 : 1))
        .map((f) => {
          const t = text.get(`finding:${findingId(r.project_id, f.ref, f.id)}`);
          const title = t?.title ?? text.get(`finding:${findingId(r.project_id, f.ref === refs.pr ? refs.b : refs.pr, f.id)}`)?.title;
          return { id: f.id, severity: f.severity, file: f.file, fate: f.fate, ...(title ? { title } : {}), ...(f.fate === 'dismissed' && t?.why ? { why: t.why } : {}) };
        });
      const ledger: Ledger = report ? { findings: list as { severity: string; fate: Fate }[], dropped: report.dropped, at: report.ts } : undefined;
      let verdict = ready(pr, ledger, gate as { result: 'pass' | 'fail' } | undefined);
      // Old data is never "ready": a PR can have moved since. Its conditions still show as they were read.
      if (verdict.ready && readAt !== null && now() - readAt > STALE_MS) verdict = { ...verdict, ready: false, reason: `Was ready when GitHub was last read, ${Math.floor((now() - readAt) / 60_000)} min ago` };
      return { number: r.number as number, head: (r.head ?? null) as string | null, issue: (r.issue ?? null) as number | null, headOid: r.head_oid as string, ...verdict, findings, dropped: report?.dropped ?? 0 };
    });
    // Not ready first (they need you), then the newest PR.
    return { project, readAt, prs: prs.toSorted((a, b) => Number(a.ready) - Number(b.ready) || b.number - a.number) };
  });
}
