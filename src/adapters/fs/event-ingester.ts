import {
  appendFileSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
} from 'node:fs';
import { join } from 'node:path';
import { hookPayloadSchema } from '../claude/hook-payload.contract.js';
import { toSpoolRecord } from '../claude/hook-payload.mapper.js';
import type { IngestLock } from './ingest-lock.js';
import type { StatePaths } from './state-paths.js';

const SPOOL_ROTATE_BYTES = 32 * 1024 * 1024;
const FILES_PER_DRAIN = 2000;
/** Event files older than this when the lock is taken were written for a viewer long gone. */
const LEFTOVER_AFTER_MS = 30_000;
const FORGET_AFTER_MS = 7 * 24 * 3600 * 1000;

export interface EventIngesterOptions {
  /** Called with the session id after new lines were appended to its spool. */
  readonly onSpooled?: (sessionId: string) => void;
}

/**
 * Turns the raw hook payload files the observe hook writes into reduced lines in each session's
 * spool. One viewer at a time does this, the holder of the ingest lock; every viewer reads the
 * spools. A viewer that is not the holder keeps trying, so it takes over when the holder exits.
 */
export class EventIngester {
  private readonly claimedDir: string;
  private watcher: FSWatcher | null = null;
  private drainQueued: NodeJS.Timeout | null = null;

  constructor(
    private readonly paths: StatePaths,
    private readonly lock: IngestLock,
    private readonly options: EventIngesterOptions = {},
  ) {
    this.claimedDir = join(paths.events, `.claimed-${process.pid}`);
  }

  get isCollecting(): boolean {
    return this.lock.isHeld;
  }

  /** Call once a second: takes the lock when it is free, keeps it fresh, and drains. */
  tick(now = Date.now()): void {
    if (!this.lock.isHeld) {
      if (!this.lock.tryAcquire(now)) {
        return;
      }

      this.discardLeftovers(now);
      this.watch();
    } else if (!this.lock.refresh(now)) {
      this.unwatch(); // another viewer took over

      return;
    }

    this.drain();
  }

  stop(): void {
    this.unwatch();

    if (this.drainQueued) {
      clearTimeout(this.drainQueued);
    }

    this.lock.release();
    rmSync(this.claimedDir, { recursive: true, force: true });
  }

  /** Moves waiting event files into their sessions' spools; returns how many it handled. */
  drain(): number {
    if (!this.lock.isHeld) {
      return 0;
    }

    const waiting = this.waitingFiles();

    if (waiting.length === 0) {
      return 0;
    }

    const lines = new Map<string, string[]>();
    let handled = 0;

    mkdirSync(this.claimedDir, { recursive: true, mode: 0o700 });

    for (const file of waiting.slice(0, FILES_PER_DRAIN)) {
      // Claimed by rename: if two viewers ever drain at once, each file still goes to one.
      const claimed = join(this.claimedDir, file.name);

      try {
        renameSync(join(this.paths.events, file.name), claimed);
      } catch {
        continue;
      }

      const record = this.reduce(claimed, file.at);

      unlinkSync(claimed);

      if (!record) {
        continue;
      }

      const forSession = lines.get(record.sessionId) ?? [];

      forSession.push(JSON.stringify(record));
      lines.set(record.sessionId, forSession);
      handled++;
    }

    for (const [sessionId, sessionLines] of lines) {
      this.append(sessionId, sessionLines);
      this.options.onSpooled?.(sessionId);
    }

    if (waiting.length > FILES_PER_DRAIN) {
      this.queueDrain();
    }

    return handled;
  }

  /** Removes spools untouched for a week: their sessions are long gone. */
  forgetOldSpools(now = Date.now()): void {
    for (const name of safeList(this.paths.spool)) {
      const path = join(this.paths.spool, name);

      try {
        if (now - statSync(path).mtimeMs > FORGET_AFTER_MS) {
          unlinkSync(path);
        }
      } catch {
        // Removed by someone else.
      }
    }
  }

  // Event time is the file's modification time: the observe hook writes it, then renames it.
  private waitingFiles(): { name: string; at: number }[] {
    const files: { name: string; at: number; order: bigint }[] = [];

    for (const name of safeList(this.paths.events)) {
      if (!name.endsWith('.json')) {
        continue;
      }

      try {
        const stat = statSync(join(this.paths.events, name), { bigint: true });

        files.push({ name, at: Number(stat.mtimeNs / 1_000_000n), order: stat.mtimeNs });
      } catch {
        // Taken by another drain.
      }
    }

    files.sort((a, b) =>
      a.order < b.order ? -1 : a.order > b.order ? 1 : a.name < b.name ? -1 : 1,
    );

    return files;
  }

  private reduce(path: string, at: number) {
    try {
      const payload = hookPayloadSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));

      return payload.success ? toSpoolRecord(payload.data, at) : null;
    } catch {
      return null; // not JSON: nothing the hook wrote
    }
  }

  private append(sessionId: string, lines: readonly string[]): void {
    const file = join(this.paths.spool, `${sessionId}.ndjson`);

    try {
      if (statSync(file).size > SPOOL_ROTATE_BYTES) {
        renameSync(file, `${file}.1`);
      }
    } catch {
      // A new spool.
    }

    appendFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  }

  private discardLeftovers(now: number): void {
    for (const file of this.waitingFiles()) {
      if (now - file.at < LEFTOVER_AFTER_MS) {
        continue;
      }

      try {
        unlinkSync(join(this.paths.events, file.name));
      } catch {
        // Already gone.
      }
    }
  }

  private watch(): void {
    if (this.watcher) {
      return;
    }

    try {
      this.watcher = watch(this.paths.events, { persistent: false }, () => this.queueDrain());
      this.watcher.on('error', () => {});
    } catch {
      // The tick still drains.
    }
  }

  private unwatch(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private queueDrain(): void {
    if (this.drainQueued) {
      return;
    }

    this.drainQueued = setTimeout(() => {
      this.drainQueued = null;
      this.drain();
    }, 15);
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
