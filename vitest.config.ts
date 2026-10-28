import { defineConfig } from 'vitest/config';

// The mod's Vitest files are *.spec.ts: `claude plugin test` runs every *.test.ts in the plugin folder (its engine tests, packages/mod/tests/).
// One file at a time: the mod's masking tests time a 200 KB input, and the server's backup and serve tests start node and bash. In parallel on a loaded machine
// (this one runs several projects at once) the first fail on their clock and the second on theirs.
export default defineConfig({ test: { include: ['packages/*/test/**/*.{test,spec}.ts'], fileParallelism: false } });
