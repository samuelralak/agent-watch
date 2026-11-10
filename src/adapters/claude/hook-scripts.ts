import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { StatePaths } from '../fs/state-paths.js';
import { deliverScript } from './hook-scripts/deliver.script.js';
import { observeScript } from './hook-scripts/observe.script.js';
import type { HookScriptInputs } from './hook-scripts/shell.js';
import { waitScript } from './hook-scripts/wait.script.js';

export type { HookScriptInputs } from './hook-scripts/shell.js';

export interface HookScripts {
  readonly observe: string;
  readonly deliver: string;
  readonly wait: string;
}

/**
 * The Node binary to bake into the scripts. A versioned path (Homebrew's Cellar, nvm) stops
 * existing on the next upgrade, so when a `node` on PATH is the same binary, its stable path is
 * used instead.
 */
export function stableNodePath(execPath: string, pathVariable = process.env.PATH ?? ''): string {
  let real: string;

  try {
    real = realpathSync(execPath);
  } catch {
    return execPath;
  }

  for (const dir of pathVariable.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, 'node');

    try {
      if (realpathSync(candidate) === real) {
        return candidate;
      }
    } catch {
      // Not in this directory.
    }
  }

  return execPath;
}

/**
 * The three POSIX sh scripts Claude Code runs as hooks. They share these rules: never fail
 * (exit 0 unless waking a session), never start Node unless a message is waiting, and never
 * rely on a redirection that could abort the shell.
 */
export function hookScripts(inputs: HookScriptInputs): HookScripts {
  return {
    observe: observeScript(inputs.paths),
    deliver: deliverScript(inputs),
    wait: waitScript(inputs),
  };
}

function currentContent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Whether the scripts on disk are exactly `scripts`. */
export function scriptsAreCurrent(paths: StatePaths, scripts: HookScripts): boolean {
  return (
    currentContent(paths.observeScript) === scripts.observe &&
    currentContent(paths.deliverScript) === scripts.deliver &&
    currentContent(paths.waitScript) === scripts.wait
  );
}

/**
 * Writes the scripts. Each is written whole and moved into place: a hook that runs during an
 * update executes the old script or the new one, never a torn file.
 */
export function writeHookScripts(paths: StatePaths, scripts: HookScripts): void {
  const files: readonly (readonly [string, string])[] = [
    [paths.observeScript, scripts.observe],
    [paths.deliverScript, scripts.deliver],
    [paths.waitScript, scripts.wait],
  ];

  for (const [path, body] of files) {
    if (currentContent(path) === body) {
      continue;
    }

    mkdirSync(dirname(path), { recursive: true });

    const temporary = `${path}.${process.pid}.tmp`;

    writeFileSync(temporary, body, { mode: 0o755 });
    chmodSync(temporary, 0o755);
    renameSync(temporary, path);
  }
}
