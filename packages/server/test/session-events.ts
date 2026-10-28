import type { Event } from '@agent-orb/shared';
import { openSession, type Meta, type Where } from '../src/transcripts.ts';

// The import reads a session as a stream (transcripts.ts, #86); the mapping's tests want its events in an array, as the old reader gave them: sorted by ts, which is
// what the writer does to each batch it is given.
export type Lines = { kind: 'main' | 'sub'; lines: string[]; seen: Set<string> };

/** One file's lines as the log holds them. `seen` is the run's: the files of one session share it. */
export const digest = async (lines: object[], kind: 'main' | 'sub', seen = new Set<string>()): Promise<Lines> => ({ kind, lines: lines.map((l) => JSON.stringify(l)), seen });

/** A session, read whole: its events (stable-sorted by ts), what the reader counted, and the cwd it filed the session under. */
export async function readSession(sessionId: string, main: Lines, subs: { digest: Lines; meta: Meta; fileAgentId: string }[], at: { host: string; project: Where['project'] }) {
  const events: Event[] = [];
  let cwd: string | undefined;
  const session = openSession(sessionId, at.host, (c) => ((cwd = c), at.project), (e) => events.push(e), main.seen);
  await session.read('main', main.lines);
  for (const s of subs) await session.read('sub', s.digest.lines, s.meta, s.fileAgentId);
  const done = session.end();
  return { events: events.sort((a, b) => a.ts - b.ts), duplicates: done.duplicates, cwd };
}

export const sessionEvents = async (...args: Parameters<typeof readSession>) => (await readSession(...args)).events;
