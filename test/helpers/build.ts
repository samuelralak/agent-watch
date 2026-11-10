import { fileURLToPath } from 'node:url';

/** The hook entry point the test setup built (see `test/setup/build.ts`). */
export const HOOK_ENTRY = fileURLToPath(new URL('../.build/hook/main.js', import.meta.url));
