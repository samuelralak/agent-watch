import { readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';

/** A holder that has not refreshed the lock for this long is taken to be gone. */
const STALE_AFTER_MS = 10_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The lock that says which viewer collects hook events. The observe hook records only while the
 * pid in it is alive, so a viewer that exits must let go, and another open viewer must take over.
 *
 * The holder refreshes the file's time every second. A lock whose pid is dead, or whose time is
 * stale (a pid reused by an unrelated process), can be taken over. Takeover replaces the file by
 * rename and then reads it back, so of several viewers racing for it exactly one keeps it.
 */
export class IngestLock {
  private held = false;

  constructor(
    private readonly path: string,
    private readonly pid = process.pid,
  ) {}

  get isHeld(): boolean {
    return this.held;
  }

  /** Takes the lock if it is free, stale, or already ours. */
  tryAcquire(now = Date.now()): boolean {
    if (this.held) {
      return this.stillOurs();
    }

    try {
      writeFileSync(this.path, `${this.pid}\n`, { flag: 'wx', mode: 0o600 });
      this.held = true;

      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return false;
      }
    }

    const holder = this.holder();

    if (
      holder !== null &&
      holder.pid !== this.pid &&
      isAlive(holder.pid) &&
      now - holder.refreshedAt < STALE_AFTER_MS
    ) {
      return false;
    }

    // Free to take: write our own file and move it into place, then check we won.
    const mine = `${this.path}.${this.pid}`;

    try {
      writeFileSync(mine, `${this.pid}\n`, { mode: 0o600 });
      renameSync(mine, this.path);
    } catch {
      return false;
    }

    this.held = this.holder()?.pid === this.pid;

    return this.held;
  }

  /** Keeps the lock fresh; returns false, and lets go, if another viewer took it. */
  refresh(now = Date.now()): boolean {
    if (!this.held) {
      return false;
    }

    if (!this.stillOurs()) {
      return false;
    }

    try {
      utimesSync(this.path, now / 1000, now / 1000);
    } catch {
      // The next refresh tries again.
    }

    return true;
  }

  release(): void {
    if (!this.held) {
      return;
    }

    this.held = false;

    try {
      if (this.holder()?.pid === this.pid) {
        unlinkSync(this.path);
      }
    } catch {
      // Already gone.
    }
  }

  private stillOurs(): boolean {
    this.held = this.holder()?.pid === this.pid;

    return this.held;
  }

  private holder(): { pid: number; refreshedAt: number } | null {
    try {
      const pid = Number(readFileSync(this.path, 'utf8'));

      if (!Number.isInteger(pid) || pid <= 0) {
        return null;
      }

      return { pid, refreshedAt: statSync(this.path).mtimeMs };
    } catch {
      return null;
    }
  }
}
