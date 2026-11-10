// Shorter paths for display.
import { homedir } from 'node:os';

const HOME = homedir();
const SCRATCHPAD = /\/(?:private\/)?tmp\/claude-\d+\/[^/\s'"]+\/[^/\s'"]+\/scratchpad/g;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function shortPath(path: string): string {
  return path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path;
}

export function relativeTo(path: string, cwd: string): string {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : shortPath(path);
}

/**
 * A command or message with its paths shortened: a leading `cd <cwd> &&` dropped, paths under
 * `cwd` made relative, session scratchpads and the home folder abbreviated.
 */
export function tidyPaths(text: string, cwd: string): string {
  let out = text;

  if (cwd) {
    out = out.replace(new RegExp(`^cd ${escapeRegExp(cwd)}/? && `), '');
    out = out.split(`${cwd}/`).join('');
  }

  return out.replace(SCRATCHPAD, '$scratch').split(HOME).join('~');
}
