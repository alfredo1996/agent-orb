export * from './event.ts';
export * from './classes.ts';
import roles from './roles.json' with { type: 'json' };
import pricing from './pricing.json' with { type: 'json' };
// Issue #8: what each built-in agent type is for; an agent file's own description overrides it.
import types from './types.json' with { type: 'json' };
export { roles, pricing, types };
