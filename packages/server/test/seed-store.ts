import { IngestBatch } from '@agent-orb/shared';
import { checkAnswers } from '../src/claims.ts';
import { contentRows, type ContentStore } from '../src/content-store.ts';
import type { Store } from '../src/store/store.ts';
import { writeEvents } from '../src/store/writer.ts';

// What POST /ingest does, for a test that wants a store with events in it and no HTTP: validated like a batch, the server's user, the text to the text store,
// the rest through the SQLite writer (#81: the APIs' tests seed this way, on a temp file).
export function seedStore(db: Store, events: unknown[], content?: ContentStore) {
  const batch = IngestBatch.parse({ events }).events.map(({ team_id: _, ...e }) => ({ ...e, user_id: 'local' }));
  content?.put(contentRows(batch));
  const written = writeEvents(db, batch, 'plugin');
  if (content) checkAnswers(db, content, batch); // the answers the batch ends are checked, as the route does (#44)
  return written;
}
