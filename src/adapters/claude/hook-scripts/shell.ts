import type { StatePaths } from '../../fs/state-paths.js';

export interface HookScriptInputs {
  readonly paths: StatePaths;
  /** The Node binary the scripts start when a message is waiting. */
  readonly node: string;
  /** The built hook entry point (`dist/hook/main.js`). */
  readonly hookEntry: string;
}

/** Single-quoted for sh. Paths with a quote or a line break are refused rather than escaped. */
export function quoted(path: string): string {
  if (/['\n]/.test(path)) {
    throw new Error(`a path with a quote or a line break cannot be used: ${path}`);
  }

  return `'${path}'`;
}

/**
 * Sets `$node`, or ends the script quietly: with no Node to run, or no build for it to run,
 * a hook does nothing rather than fail Claude Code.
 */
export function findNode({ node, hookEntry }: HookScriptInputs): string {
  return `node=${quoted(node)}

if [ ! -x "$node" ]; then
  node=$(command -v node 2>/dev/null) || exit 0
fi

if [ ! -f ${quoted(hookEntry)} ]; then
  exit 0
fi`;
}

/**
 * The command that runs the hook entry point with `args`. The state folder and the lock folder
 * are named here, so the hook never takes them from an environment something else could set.
 */
export function hookCommand({ paths, hookEntry }: HookScriptInputs, args: string): string {
  const folders = `AGENTWATCH_STATE_DIR=${quoted(paths.stateDir)} AGENTWATCH_LOCK_DIR=${quoted(paths.lockDir)}`;

  return `${folders} "$node" ${quoted(hookEntry)} ${args}`;
}
