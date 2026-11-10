import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureStateDirs,
  resolveStatePaths,
  type StatePaths,
} from '../../src/adapters/fs/state-paths.js';

/** Throwaway state, share and Claude Code folders: tests never touch the real ones. */
export function temporaryState(): StatePaths {
  const root = mkdtempSync(join(tmpdir(), 'agentwatch-state-'));

  const paths = resolveStatePaths({
    AGENTWATCH_STATE_DIR: join(root, 'state'),
    AGENTWATCH_LOCK_DIR: join(root, 'lock'),
    AGENTWATCH_SHARE_DIR: join(root, 'share'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
  });

  ensureStateDirs(paths);

  return paths;
}
