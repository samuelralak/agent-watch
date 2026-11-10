import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { asRecord } from '../../util/record.js';

const BACKUP_MARK = '.agentwatch-backup-';
const BACKUPS_KEPT = 3;

export class SettingsUnreadableError extends Error {
  constructor(path: string, cause: string) {
    super(`${path} could not be read as settings (${cause}); it was left untouched`);
    this.name = 'SettingsUnreadableError';
  }
}

export interface ReadSettings {
  readonly settings: Readonly<Record<string, unknown>>;
  /** The file's text as read, or null when there is no file yet. */
  readonly raw: string | null;
}

/**
 * Claude Code's user settings file. Read strictly (a file that is not a JSON object is never
 * rewritten) and written carefully: through a symlink to the real file, atomically, with the
 * file's mode and indentation kept, and a backup of what was there.
 */
export class ClaudeSettingsFile {
  constructor(readonly path: string) {}

  read(): ReadSettings {
    let raw: string;

    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { settings: {}, raw: null };
      }

      throw new SettingsUnreadableError(this.path, (error as Error).message);
    }

    if (!raw.trim()) {
      return { settings: {}, raw };
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new SettingsUnreadableError(this.path, (error as Error).message);
    }

    const settings = asRecord(parsed);

    if (!settings) {
      throw new SettingsUnreadableError(this.path, 'it is not a JSON object');
    }

    return { settings, raw };
  }

  /** Replaces the file's contents; returns the path of the backup, or null for a new file. */
  write(settings: Readonly<Record<string, unknown>>, previous: ReadSettings): string | null {
    // A settings file managed by a dotfiles tool is a symlink: write the file it points to.
    const target = this.realPath();
    const backup = previous.raw === null ? null : this.backUp(target, previous.raw);
    let mode = 0o600;

    try {
      mode = statSync(target).mode & 0o777;
    } catch {
      // A new file.
    }

    mkdirSync(dirname(target), { recursive: true });

    const temporary = `${target}.agentwatch-${process.pid}.tmp`;

    writeFileSync(temporary, `${JSON.stringify(settings, null, indentOf(previous.raw))}\n`, {
      mode,
    });

    renameSync(temporary, target);

    return backup;
  }

  private realPath(): string {
    try {
      return realpathSync(this.path);
    } catch {
      return this.path;
    }
  }

  private backUp(target: string, raw: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${target}${BACKUP_MARK}${stamp}`;

    writeFileSync(backup, raw, { mode: 0o600 });

    const prefix = `${basename(target)}${BACKUP_MARK}`;

    const older = readdirSync(dirname(target))
      .filter((name) => name.startsWith(prefix))
      .sort()
      .slice(0, -BACKUPS_KEPT);

    for (const name of older) {
      try {
        unlinkSync(join(dirname(target), name));
      } catch {
        // Already gone.
      }
    }

    return backup;
  }
}

/** The indentation a JSON file uses, so rewriting it does not reformat it. */
function indentOf(raw: string | null): string | number {
  const match = raw ? /^\{\r?\n([ \t]+)"/.exec(raw) : null;

  return match?.[1] ?? 2;
}
