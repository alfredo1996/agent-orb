import type { FastifyInstance } from 'fastify';
import { all, get, type Row, type Store } from '../store/store.ts';

// v0.4 slice 3 (#29, Factory; PROJECT.md §15, 2026-11-05): what runs on the Mac, by project, with its memory. Nothing here removes anything.
//   GET /api/machine  the latest sample of each host heard from in the last 24 hours (newest first): its free memory, Docker's state, its containers' count and memory, and the containers
//                     grouped and flagged, with the sample's age
// The plugin sends one machine.sample per host about every 10 minutes, whichever session takes it; the writer keeps the latest per host (machine_samples). The grouping and the flags are worked
// out here, on read, against the history as it stands then.

const HOUR = 3_600_000;
const RUN_MAX = 2 * HOUR; // how long before a container was made a test run may have begun and still be the one that made it
const FRESH = 24 * HOUR;

type Box = { name?: string; created_at?: number; state: string; health?: string; memory?: number; compose?: string; working_dir?: string; testcontainers?: { session?: string }; excluded?: true };
type Kind = 'compose' | 'testcontainers' | 'none' | 'excluded';
type Bucket = { kind: Kind; compose: string | null; dir: string | null; boxes: Box[] };
type Project = { id: string; name: string };

// The folders agent-orb knows a project by on this host: the repository roots its sessions reported, and the working trees (git worktrees) their fingerprints were read in. Only a project
// that has a session on the host counts, so another machine's folders of the same name are not matched here. And only a project with a remote: a session started outside any repository
// records its own folder as the project's (a session in the home folder would otherwise claim every stack under it), and a project with no remote is that, or a repository kept to itself.
const FOLDERS = `SELECT p.id AS id, p.name AS name, c.cwd AS cwd FROM project_cwds c JOIN projects p ON p.id = c.project_id
  WHERE p.git_remote IS NOT NULL AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = c.project_id AND s.host = :host)
  UNION
  SELECT p.id AS id, p.name AS name, f.cwd AS cwd FROM fingerprints f JOIN projects p ON p.id = f.project_id
  WHERE p.git_remote IS NOT NULL AND f.cwd IS NOT NULL AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = f.project_id AND s.host = :host)`;
// The test run in flight at `:at`: a Bash call of class test that began in the two hours before it and had not reported a result, or reported one after it; the latest to begin wins.
const RUN_AT = `SELECT p.id AS id, p.name AS name FROM tool_calls c JOIN turns t ON t.id = c.turn_id JOIN agents a ON a.id = t.agent_id JOIN sessions s ON s.id = a.session_id JOIN projects p ON p.id = s.project_id
  WHERE c.command_class = 'test' AND s.host = :host AND c.ts <= :at AND c.ts >= :since AND (c.duration_ms IS NULL OR c.ts + c.duration_ms >= :at)
  ORDER BY c.ts DESC LIMIT 1`;
// The last time anything was seen of a project on this host: a session's start, end, last prompt, request or call, or any event it sent (`seen_at`: a sample, a read of the open PRs). By the
// project's id, not its name: two repositories can share a folder name.
const LAST_EVENT = `SELECT max(max(coalesce(ended_at, 0), coalesce(plugin_last, 0), coalesce(started_at, 0), coalesce(seen_at, 0))) AS at FROM sessions WHERE project_id = :project AND host = :host`;

/**
 * One host's latest sample, its containers grouped and flagged. A group is a compose project (one stack: its name and its `working_dir`; the folder reaches the project that holds it, otherwise it
 * shows under its compose name with no project), a Testcontainers run (its session id; it reaches the project that had a test run in flight when its first container was created, otherwise it is
 * "Testcontainers"), or "No project": everything else, started by hand. A project's last event is the latest of its sessions' on the host. "Left running" is a Testcontainers group with a project
 * whose last event came an hour or more before the sample: containers a test run left behind. A compose stack is started on purpose and stays up (so does the server agent-orb runs in), and a group
 * with no project has nothing to be quiet: neither is ever left running. "Unhealthy" is a container whose health is `unhealthy`, or that keeps restarting (it may have no health check to say so).
 * ponytail: the test run is found by time alone, so two projects' runs going at once give the container to the later one; a run that began more than two hours before its container was made, or one that
 * never reported a result and began just before an unrelated container, is mismatched. The folders are the project's roots and checkouts as agent-orb saw them, so a container started from a folder
 * no session ever ran in is shown by its compose name only. A session that is open and sends nothing for an hour, and is not the one sampling, reads as quiet.
 */
function view(store: Store, r: Row, now: number) {
  const host = r.host as string;
  const boxes = JSON.parse(r.containers) as Box[];
  // A bucket is a stack (compose name and folder: the name is the folder's by default, so two repositories can have a stack of one name), a Testcontainers run, the excluded, or the rest.
  const buckets = new Map<string, Bucket>();
  for (const c of boxes) {
    const [kind, key] = c.excluded ? (['excluded', 'excluded'] as const) : c.compose ? (['compose', `c:${JSON.stringify([c.compose, c.working_dir ?? ''])}`] as const)
      : c.testcontainers ? (['testcontainers', `t:${c.testcontainers.session ?? ''}`] as const) : (['none', 'none'] as const);
    (buckets.get(key) ?? buckets.set(key, { kind, compose: c.compose ?? null, dir: c.working_dir ?? null, boxes: [] }).get(key)!).boxes.push(c);
  }

  const folders = buckets.size ? (all(store, FOLDERS, { host }) as { id: string; name: string; cwd: string }[]) : [];
  const lastOf = new Map<string, number | null>();
  const last = (project: string) => {
    if (!lastOf.has(project)) lastOf.set(project, (get(store, LAST_EVENT, { project, host })?.at as number | null) || null);
    return lastOf.get(project)!;
  };

  const groups = [...buckets].map(([key, b]) => {
    const made = b.boxes.flatMap((c) => c.created_at ?? []);
    const since = made.length ? Math.min(...made) : null;
    let project: Project | null = null;
    if (b.kind === 'compose' && b.dir) {
      const dir = b.dir;
      project = folders.filter((f) => dir === f.cwd || dir.startsWith(`${f.cwd}/`)).toSorted((x, y) => y.cwd.length - x.cwd.length)[0] ?? null;
    } else if (b.kind === 'testcontainers') {
      const at = since ?? r.ts;
      project = (get(store, RUN_AT, { host, at, since: at - RUN_MAX }) as Project | undefined) ?? null;
    }
    const at = b.kind === 'testcontainers' && project ? last(project.id) : null;
    const name = b.kind === 'excluded' ? 'An excluded project' : b.kind === 'none' ? 'No project' : project?.name ?? b.compose ?? 'Testcontainers';
    return {
      id: `${host}:${key}`, kind: b.kind, name, project: project?.name ?? null, compose: b.compose, containers: b.boxes.length, memory: b.boxes.reduce((t, c) => t + (c.memory ?? 0), 0),
      unhealthy: b.boxes.filter((c) => c.health === 'unhealthy' || c.state === 'restarting').length,
      leftRunning: at !== null && at <= r.ts - HOUR, idleMs: at === null ? null : Math.max(0, r.ts - at), since,
    };
  });
  const flagged = (g: (typeof groups)[number]) => g.leftRunning || g.unhealthy > 0;
  groups.sort((a, b) => Number(flagged(b)) - Number(flagged(a)) || b.memory - a.memory || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    host, at: r.ts as number, ageMs: now - r.ts, docker: r.docker as string, memFree: (r.mem_free ?? null) as number | null, memTotal: (r.mem_total ?? null) as number | null,
    containers: boxes.length, memory: boxes.reduce((t, c) => t + (c.memory ?? 0), 0), groups,
  };
}

export function machine(app: FastifyInstance, { store, now = Date.now }: { store: Store; now?: () => number }) {
  app.get('/api/machine', async () => {
    const at = now();
    return { hosts: all(store, 'SELECT host, ts, mem_free, mem_total, docker, containers FROM machine_samples WHERE ts >= :since ORDER BY ts DESC', { since: at - FRESH }).map((r) => view(store, r, at)) };
  });
}
