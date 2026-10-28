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

/** The hash's query for a choice; nothing for the first one, so the plain routes stay plain. */
export function choiceQuery(c: Choice): string {
  const q = new URLSearchParams();
  if (c.single) q.set('project', c.single);
  if (c.single && c.all) q.set('all', '1');
  const s = q.toString();
  return s ? `?${s}` : '';
}
