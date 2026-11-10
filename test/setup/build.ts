import { build } from 'tsup';
import config from '../../tsup.config.js';

/**
 * Builds the two entry points once before the tests, with the project's own build settings,
 * into a folder of its own: the generated hook scripts and the command line are tested against
 * what really ships, and `dist` (which installed hooks may be running) is left alone.
 */
export default async function setup(): Promise<void> {
  await build({
    ...config,
    entry: { 'cli/main': 'src/cli/main.ts', 'hook/main': 'src/hook/main.ts' },
    outDir: 'test/.build',
    sourcemap: false,
    silent: true,
    config: false,
  });
}
