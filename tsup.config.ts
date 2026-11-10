import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'cli/main': 'src/cli/main.ts',
    // Started by Claude Code's hooks when a message is waiting: kept apart so it loads fast.
    'hook/main': 'src/hook/main.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: true,
  // One self-contained build: the hook scripts run it from any directory.
  noExternal: ['zod'],
});
