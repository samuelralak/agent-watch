import { rmSync } from 'node:fs';
import type { HookInstaller } from '../adapters/claude/hook-installer.js';
import type { StatePaths } from '../adapters/fs/state-paths.js';
import type { HooksAction } from './options.js';

export interface HooksCommandDeps {
  readonly installer: HookInstaller;
  readonly paths: StatePaths;
  readonly write: (line: string) => void;
}

export interface HooksCommandOptions {
  /** With `uninstall`: also delete agentwatch's own state. */
  readonly purge: boolean;
}

type Action = (deps: HooksCommandDeps, options: HooksCommandOptions) => number;

/**
 * `agentwatch hooks <action>`. Returns the process exit code. A settings file that cannot be
 * read makes the installer throw before it writes anything; the caller reports that.
 */
export function runHooksCommand(
  action: HooksAction,
  options: HooksCommandOptions,
  deps: HooksCommandDeps,
): number {
  return ACTIONS[action](deps, options);
}

const ACTIONS: Readonly<Record<HooksAction, Action>> = { install, update, uninstall, status };

function install({ installer, paths, write }: HooksCommandDeps): number {
  const problem = installer.status().problem;

  if (problem) {
    write(`Not installed: ${problem}.`);

    return 1;
  }

  const result = installer.install();
  const state = result.settingsChanged ? 'now' : 'already';

  write(`agentwatch's hooks are ${state} in ${paths.claudeSettings}.`);
  write('Every Claude Code session loads them. Nothing about how you start Claude Code changes.');

  if (result.backup) {
    write(`  backup of your previous settings: ${result.backup}`);
  }

  write('Undo with: agentwatch hooks uninstall');

  return 0;
}

function update({ installer, paths, write }: HooksCommandDeps): number {
  const problem = installer.status().problem;

  if (problem) {
    write(`Not updated: ${problem}.`);

    return 1;
  }

  if (installer.refreshScripts()) {
    write(`Updated the hook scripts in ${paths.shareDir}.`);
    write('Your Claude Code settings were not touched.');
  } else {
    write('The hook scripts are already current.');
  }

  return 0;
}

function uninstall(
  { installer, paths, write }: HooksCommandDeps,
  options: HooksCommandOptions,
): number {
  const result = installer.uninstall();

  if (result.settingsChanged) {
    write(`Removed agentwatch's hooks from ${paths.claudeSettings} and deleted its hook scripts.`);
  } else {
    write(`agentwatch's hooks were not in ${paths.claudeSettings}; its hook scripts are deleted.`);
  }

  if (result.backup) {
    write(`  backup of your previous settings: ${result.backup}`);
  }

  if (options.purge) {
    rmSync(paths.stateDir, { recursive: true, force: true });
    write(`Deleted agentwatch's state: ${paths.stateDir}`);
  }

  return 0;
}

function status({ installer, paths, write }: HooksCommandDeps): number {
  const { installed, scriptsCurrent, problem } = installer.status();

  write(`hooks in ${paths.claudeSettings}: ${installed ? 'installed' : 'not installed'}`);

  if (installed) {
    write(`hook scripts in ${paths.shareDir}: ${scriptsCurrent ? 'current' : 'out of date'}`);
  }

  if (problem) {
    write(`problem: ${problem}`);
  }

  if (!installed) {
    write('Install with: agentwatch hooks install');
  } else if (!scriptsCurrent) {
    write('Bring them up to date with: agentwatch hooks update');
  }

  return installed && scriptsCurrent && !problem ? 0 : 1;
}
