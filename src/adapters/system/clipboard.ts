import { spawnSync } from 'node:child_process';

/** Copies `text` to the system clipboard. Returns false where there is no way to. */
export function copyToClipboard(text: string): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }

  return spawnSync('pbcopy', { input: text, timeout: 2000 }).status === 0;
}
