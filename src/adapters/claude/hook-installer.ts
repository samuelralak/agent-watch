import { existsSync, unlinkSync } from 'node:fs';
import { ensureStateDirs, type StatePaths } from '../fs/state-paths.js';
import {
  hasAgentwatchHooks,
  withAgentwatchHooks,
  withoutAgentwatchHooks,
} from './hook-registration.js';
import {
  type HookScripts,
  hookScripts,
  scriptsAreCurrent,
  writeHookScripts,
} from './hook-scripts.js';
import { ClaudeSettingsFile } from './settings-file.adapter.js';

export interface HookInstallerOptions {
  readonly paths: StatePaths;
  readonly node: string;
  readonly hookEntry: string;
}

export interface InstallResult {
  /** False when the hooks were already in the settings exactly as they would be written. */
  readonly settingsChanged: boolean;
  readonly backup: string | null;
}

export interface HooksStatus {
  readonly installed: boolean;
  readonly scriptsCurrent: boolean;
  /** Why the scripts cannot run, if they cannot. */
  readonly problem: string | null;
}

/**
 * Installs agentwatch's hooks into Claude Code's user settings, so every session loads them with
 * no change to how Claude Code is started.
 */
export class HookInstaller {
  private readonly paths: StatePaths;
  private readonly scripts: HookScripts;
  private readonly settings: ClaudeSettingsFile;
  private readonly hookEntry: string;

  constructor(options: HookInstallerOptions) {
    this.paths = options.paths;
    this.hookEntry = options.hookEntry;
    this.scripts = hookScripts(options);
    this.settings = new ClaudeSettingsFile(options.paths.claudeSettings);
  }

  /** Reads the settings first: a file that cannot be read stops the install before anything is written. */
  install(): InstallResult {
    const previous = this.settings.read();
    const next = withAgentwatchHooks(previous.settings, this.paths);

    ensureStateDirs(this.paths);
    writeHookScripts(this.paths, this.scripts);

    if (JSON.stringify(next) === JSON.stringify(previous.settings)) {
      return { settingsChanged: false, backup: null };
    }

    return { settingsChanged: true, backup: this.settings.write(next, previous) };
  }

  /** Rewrites the scripts only. Claude Code's settings point at their paths, which do not change. */
  refreshScripts(): boolean {
    if (scriptsAreCurrent(this.paths, this.scripts)) {
      return false;
    }

    ensureStateDirs(this.paths);
    writeHookScripts(this.paths, this.scripts);

    return true;
  }

  /**
   * Takes the hooks out of the settings, then removes the scripts. In that order: scripts the
   * settings still point at must not be deleted, or every hook in every session would fail.
   */
  uninstall(): InstallResult {
    const previous = this.settings.read();
    const next = withoutAgentwatchHooks(previous.settings, this.paths);
    const settingsChanged = JSON.stringify(next) !== JSON.stringify(previous.settings);
    const backup = settingsChanged ? this.settings.write(next, previous) : null;

    for (const script of [
      this.paths.observeScript,
      this.paths.deliverScript,
      this.paths.waitScript,
    ]) {
      try {
        unlinkSync(script);
      } catch {
        // Not there.
      }
    }

    return { settingsChanged, backup };
  }

  status(): HooksStatus {
    let installed = false;

    try {
      installed = hasAgentwatchHooks(this.settings.read().settings, this.paths);
    } catch {
      // Unreadable settings: reported as not installed; install says why.
    }

    const problem = existsSync(this.hookEntry)
      ? null
      : `${this.hookEntry} is missing: run \`npm run build\``;

    return { installed, scriptsCurrent: scriptsAreCurrent(this.paths, this.scripts), problem };
  }
}
