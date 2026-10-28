// The image's entry point: `serve` (the default) is what main.ts always did; `import <dir>` is the one-off history import
// (v0.2 slice 1): docker compose -f deploy/docker-compose.yml run --rm orb-server import /import
const [command = 'serve', ...args] = process.argv.slice(2);

if (command === 'serve') {
  await import('./main.ts');
} else if (command === 'import' && args.length === 1) {
  const { runImport } = await import('./import.ts');
  await runImport(args[0]!).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
} else {
  console.error('usage: cli.ts serve | cli.ts import <dir>');
  process.exit(2);
}
