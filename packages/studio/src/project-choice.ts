// The project every view reads (#101, design/v0.3-readable.html, the Header board): chosen once above the views, and kept in the URL hash so a reload keeps it. Pure, for tests.

/**
 * `all`: "All projects" is what was picked last. `single`: the last single project picked ('' until there is one). A view that needs one project shows `single` and never offers
 * "All projects"; the choice of all waits behind it, so Totals brings "All projects" back unless a project was picked on the way.
 */
export type Choice = { all: boolean; single: string };
export const FIRST: Choice = { all: true, single: '' };

/** What a picker gave: '' is "All projects". */
export const choose = (c: Choice, name: string): Choice => (name ? { all: false, single: name } : { ...c, all: true });

/**
 * The project a view shows, '' for all of them. `one`: the view needs a single project. Until the list has loaded the URL's project is trusted; after it, a project the list does
 * not hold gives way to the first one (the most recent).
 */
export function shown(c: Choice, one: boolean, projects?: string[]): string {
  if (!one && c.all) return '';
  if (!projects) return c.single;
  return projects.includes(c.single) ? c.single : (projects[0] ?? '');
}

/** The choice a hash holds: `#/ledger?project=docs-site&all=1`. None is the first one: all projects. */
export function readChoice(hash: string): Choice {
  const q = new URLSearchParams(hash.split('?')[1] ?? '');
  const single = q.get('project') ?? '';
  return { all: !single || q.get('all') === '1', single };
}

/** The session a Live link names (`#/live?session=<id>&project=<name>`, from the Factory board, #32): the card to bring into view. None when the hash names no session. */
export function readSession(hash: string): string | null {
  return new URLSearchParams(hash.split('?')[1] ?? '').get('session') || null;
}

/** The hash's query for a choice; nothing for the first one, so the plain routes stay plain. */
export function choiceQuery(c: Choice): string {
  const q = new URLSearchParams();
  if (c.single) q.set('project', c.single);
  if (c.single && c.all) q.set('all', '1');
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** The issue an issue page's hash names (`#/issue?project=<name>&issue=409`); none when it names no positive whole number. */
export function readIssue(hash: string): number | null {
  const n = Number(new URLSearchParams(hash.split('?')[1] ?? '').get('issue'));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The hash with some parameters of its query set (a value) or removed (undefined), the others kept in their place: the project choice, Factory's view and milestone (#106) and the issue page's
 * issue share one query, and each writes its own without dropping the rest.
 */
export function hashWith(hash: string, set: Record<string, string | undefined>): string {
  const [path = '', query = ''] = hash.split('?');
  const q = new URLSearchParams(query);
  for (const [k, v] of Object.entries(set)) (v === undefined ? q.delete(k) : q.set(k, v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** The hash with the project choice written into it, as `choiceQuery` says it, and every other parameter kept. */
export const withChoice = (hash: string, c: Choice) => hashWith(hash, { project: c.single || undefined, all: c.single && c.all ? '1' : undefined });

/** The hash the App writes back: a route's own gets the project choice (the rest of its query stays), any other hash (Live's, an unknown one) is left as it is. */
export const routedHash = (hash: string, routed: boolean, c: Choice) => (routed ? withChoice(hash, c) : hash);

/** The hash Factory writes back: `view=map` for the Map, and the milestone picked when it was picked in this project; the Board, and the server's own choice, leave both out. */
export const factoryHash = (hash: string, view: 'board' | 'map', chosen: { project: string; milestone: string } | undefined, project: string) =>
  hashWith(hash, { view: view === 'map' ? 'map' : undefined, milestone: chosen?.project === project ? chosen.milestone : undefined });

/** What Factory's hash holds besides the project: `view=map` for the Map (the Board otherwise) and the milestone picked (`milestone=v2.3+Offline`), so a link or a reload lands where it was. */
export function readFactory(hash: string): { view: 'board' | 'map'; milestone?: string } {
  const q = new URLSearchParams(hash.split('?')[1] ?? '');
  return { view: q.get('view') === 'map' ? 'map' : 'board', ...(q.get('milestone') ? { milestone: q.get('milestone')! } : {}) };
}
