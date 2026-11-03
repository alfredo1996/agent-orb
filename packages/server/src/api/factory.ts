import type { Fate } from '@agent-orb/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { findingId, type ContentStore } from '../content-store.ts';
import { all, get, type Store } from '../store/store.ts';

// v0.4 slice 1 (#27, Factory; PROJECT.md §15, 2026-11-03): whether each open PR is ready for the owner's ok, from what the plugin sent.
//   GET /api/factory?project=<name>  the open PRs as last read, each with ready(), its four conditions and its findings (latest fate each), and when GitHub was read
// Ready means ready for the owner's ok: nothing here merges, and nothing reaches the machine.

export type Check = { name: string; state: 'pass' | 'fail' | 'pending' };
export type PrState = { headOid: string; mergeState: string; lastCommitAt?: number; checks: Check[]; bots: { author: string; at: number }[] };
/** A branch's findings, the latest fate each, and how many lines its last report dropped; undefined when no report reached the branch. */
export type Ledger = { findings: { severity: string; fate: Fate }[]; dropped: number } | undefined;
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
 * The gate on the head: GitHub's checks when CI runs (any check at all), otherwise the tester's orb-gate on that commit. A quality gate (Sonar) is a check, so a failing
 * one is a failed check here, which is condition 3's "every quality-gate check passed" too.
 * ponytail: a repo whose only checks are bots' (no CI) reads as CI, and its orb-gate is not asked; split checks by name if that is ever seen.
 */
function gateCond(pr: PrState, gate: { result: 'pass' | 'fail' } | undefined): Cond {
  if (pr.checks.length) {
    const failed = pr.checks.filter((c) => c.state === 'fail').map((c) => c.name);
    if (failed.length) return { ok: false, note: `${andMore(failed)} failed` };
    const running = pr.checks.filter((c) => c.state === 'pending').map((c) => c.name);
    if (running.length) return { ok: null, note: `${andMore(running)} is running` };
    return { ok: true, note: `${plural(pr.checks.length, 'check')} passed` };
  }
  if (!gate) return { ok: null, note: `No gate report on ${short(pr.headOid)}` };
  return gate.result === 'pass' ? { ok: true, note: `orb-gate passed on ${short(pr.headOid)}` } : { ok: false, note: `orb-gate failed on ${short(pr.headOid)}` };
}

function botsCond(pr: PrState): Cond {
  if (!pr.bots.length) return { ok: true, note: 'No bot comment since the last commit' };
  if (pr.lastCommitAt === undefined) return { ok: null, note: 'The last commit\'s time is unknown' };
  const newer = pr.bots.filter((b) => b.at > pr.lastCommitAt!).toSorted((a, b) => b.at - a.at).map((b) => b.author);
  return newer.length ? { ok: false, note: `${andMore(newer)} commented after the last commit` } : { ok: true, note: 'No bot comment since the last commit' };
}

function cleanCond(state: string): Cond {
  if (state === 'CLEAN') return { ok: true, note: 'CLEAN' };
  if (state === 'UNKNOWN') return { ok: null, note: 'GitHub hasn\'t worked out the merge state yet' };
  return { ok: false, note: GLOSS[state] ? `${state}: ${GLOSS[state]}` : state };
}

/**
 * The merge check (#20): ready when, and only when, all four hold. 1. no finding is open; 2. the gate passed on the PR's own head; 3. no bot comment is newer than the
 * last commit; 4. mergeStateStatus is CLEAN (MERGEABLE is not enough: NeoBoard's #2405 read MERGEABLE and UNSTABLE at once). The reason is the first that does not hold.
 */
export function ready(pr: PrState, ledger: Ledger, gate: { result: 'pass' | 'fail' } | undefined): Readiness {
  const conditions = { findings: findingsCond(ledger), gate: gateCond(pr, gate), bots: botsCond(pr), clean: cleanCond(pr.mergeState) };
  const first = Object.values(conditions).find((c) => c.ok !== true);
  return { ready: !first, reason: first?.note ?? null, conditions };
}

const FATE_ORDER: Fate[] = ['open', 'dismissed', 'fixed']; // the sheet's order: what blocks, what you read before merging, what was done
const Query = z.object({ project: z.string().min(1) });

export function factory(app: FastifyInstance, { store, content }: { store: Store; content: ContentStore }) {
  app.get('/api/factory', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'give a project', issues: q.error.issues });
    const { project } = q.data;
    // Every project row with the name, like the goal: a repo seen from two machines is two rows.
    const readAt = get(store, 'SELECT max(prs_read_at) AS at FROM projects WHERE name = :project', { project })?.at ?? null;
    const rows = all(store, 'SELECT o.* FROM open_prs o JOIN projects p ON p.id = o.project_id WHERE p.name = :project', { project });
    const prs = rows.map((r) => {
      const pr: PrState = { headOid: r.head_oid, mergeState: r.merge_state, lastCommitAt: r.last_commit_at ?? undefined, checks: JSON.parse(r.checks), bots: JSON.parse(r.bots) };
      const report = r.head ? get(store, 'SELECT dropped FROM finding_reports WHERE project_id = :p AND branch = :b', { p: r.project_id, b: r.head }) : undefined;
      const list = report ? all(store, 'SELECT id, severity, file, fate FROM findings WHERE project_id = :p AND branch = :b', { p: r.project_id, b: r.head }) : [];
      const gate = get(store, 'SELECT result FROM gates WHERE project_id = :p AND substr(:oid, 1, length(commit_sha)) = commit_sha ORDER BY ts DESC LIMIT 1', { p: r.project_id, oid: r.head_oid });
      const text = content.get(list.map((f) => ({ node: 'finding', id: findingId(r.project_id, r.head, f.id) })));
      const findings = list
        .toSorted((a, b) => FATE_ORDER.indexOf(a.fate) - FATE_ORDER.indexOf(b.fate) || rank(a.severity) - rank(b.severity) || (a.id < b.id ? -1 : 1))
        .map((f) => {
          const t = text.get(`finding:${findingId(r.project_id, r.head, f.id)}`);
          return { id: f.id, severity: f.severity, file: f.file, fate: f.fate, ...(t?.title ? { title: t.title } : {}), ...(f.fate === 'dismissed' && t?.why ? { why: t.why } : {}) };
        });
      const ledger: Ledger = report ? { findings: list as { severity: string; fate: Fate }[], dropped: report.dropped } : undefined;
      return { number: r.number as number, head: (r.head ?? null) as string | null, headOid: r.head_oid as string, ...ready(pr, ledger, gate as { result: 'pass' | 'fail' } | undefined), findings, dropped: report?.dropped ?? 0 };
    });
    // Not ready first (they need you), then the newest PR.
    return { project, readAt, prs: prs.toSorted((a, b) => Number(a.ready) - Number(b.ready) || b.number - a.number) };
  });
}
