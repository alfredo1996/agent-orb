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

// The folders agent-orb knows a project by on this host: the repository roots its sessions reported, and the working trees (git worktrees) their fingerprints were read in. Only a project
// that has a session on the host counts, so another machine's folders of the same name are not matched here.
const FOLDERS = `SELECT p.name AS name, c.cwd AS cwd FROM project_cwds c JOIN projects p ON p.id = c.project_id
  WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = c.project_id AND s.host = :host)
  UNION
  SELECT p.name AS name, f.cwd AS cwd FROM fingerprints f JOIN projects p ON p.id = f.project_id
  WHERE f.cwd IS NOT NULL AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = f.project_id AND s.host = :host)`;
// The test run in flight at `:at`: a Bash call of class test that began in the two hours before it and had not reported a result, or reported one after it; the latest to begin wins.
const RUN_AT = `SELECT p.name AS name FROM tool_calls c JOIN turns t ON t.id = c.turn_id JOIN agents a ON a.id = t.agent_id JOIN sessions s ON s.id = a.session_id JOIN projects p ON p.id = s.project_id
  WHERE c.command_class = 'test' AND s.host = :host AND c.ts <= :at AND c.ts >= :since AND (c.duration_ms IS NULL OR c.ts + c.duration_ms >= :at)
  ORDER BY c.ts DESC LIMIT 1`;
// The last time anything was seen of a project on this host: a session's start, end, or last prompt, request or call.
const LAST_SESSION = `SELECT max(max(coalesce(s.ended_at, 0), coalesce(s.plugin_last, 0), coalesce(s.started_at, 0))) AS at
  FROM sessions s JOIN projects p ON p.id = s.project_id WHERE p.name = :project AND s.host = :host`;
const LAST_READ = 'SELECT max(prs_read_at) AS at FROM projects WHERE name = :project';

/**
 * One host's latest sample, its containers grouped and flagged. A group is a compose project (its `working_dir` in a project's folder reaches that project; otherwise it shows under its compose name
 * with no project), a Testcontainers run (its session id; it reaches the project that had a test run in flight when its first container was created, otherwise it is "Testcontainers"), or
 * "No project": everything else, started by hand. A project's last event is its latest session activity on the host, or the plugin's latest read of its open PRs (a session that is open and quiet
 * still reads them every 5 minutes). "Left running" is a group with a project whose last event came an hour or more before the sample; a group with no project is never left running.
 * ponytail: the test run is found by time alone, so two projects' runs going at once give the container to the later one; a run that began more than two hours before its container was made, or one that
 * never reported a result and began just before an unrelated container, is mismatched. The folders are the project's roots and checkouts as agent-orb saw them, so a container started from a folder
 * no session ever ran in is shown by its compose name only.
 */
function view(store: Store, r: Row, now: number) {
  const host = r.host as string;
  const boxes = JSON.parse(r.containers) as Box[];
  const buckets = new Map<string, Bucket>();
  for (const c of boxes) {
    const [kind, key] = c.excluded ? (['excluded', 'excluded'] as const) : c.compose ? (['compose', `c:${c.compose}`] as const) : c.testcontainers ? (['testcontainers', `t:${c.testcontainers.session ?? ''}`] as const) : (['none', 'none'] as const);
    const b = buckets.get(key) ?? buckets.set(key, { kind, compose: c.compose ?? null, dir: null, boxes: [] }).get(key)!;
    b.dir ??= c.working_dir ?? null;
    b.boxes.push(c);
  }

  const folders = buckets.size ? (all(store, FOLDERS, { host }) as { name: string; cwd: string }[]) : [];
  const lastOf = new Map<string, number | null>();
  const last = (project: string) => {
    if (!lastOf.has(project)) {
      const at = Math.max(get(store, LAST_SESSION, { project, host })?.at ?? 0, get(store, LAST_READ, { project })?.at ?? 0);
      lastOf.set(project, at || null);
    }
    return lastOf.get(project)!;
  };

  const groups = [...buckets.values()].map((b) => {
    let project: string | null = null;
    if (b.kind === 'compose' && b.dir) {
      const dir = b.dir;
      project = folders.filter((f) => dir === f.cwd || dir.startsWith(`${f.cwd}/`)).toSorted((x, y) => y.cwd.length - x.cwd.length)[0]?.name ?? null;
    } else if (b.kind === 'testcontainers') {
      const made = Math.min(...b.boxes.map((c) => c.created_at ?? r.ts));
      project = (get(store, RUN_AT, { host, at: made, since: made - RUN_MAX })?.name as string | undefined) ?? null;
    }
    const at = project === null ? null : last(project);
    const name = b.kind === 'excluded' ? 'An excluded project' : b.kind === 'none' ? 'No project' : project ?? b.compose ?? 'Testcontainers';
    return {
      kind: b.kind, name, project, compose: b.compose, containers: b.boxes.length, memory: b.boxes.reduce((t, c) => t + (c.memory ?? 0), 0),
      unhealthy: b.boxes.filter((c) => c.health === 'unhealthy').length,
      leftRunning: at !== null && at <= r.ts - HOUR, idleMs: at === null ? null : Math.max(0, r.ts - at),
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
