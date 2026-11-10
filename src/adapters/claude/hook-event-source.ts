import { type FSWatcher, readdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { WatchEvent } from '../../domain/event.js';
import { asRecord } from '../../util/record.js';
import { Tail } from '../fs/tail.js';
import { spoolRecordSchema } from './spool-record.contract.js';
import { type ReceiptVerifier, toWatchEvents } from './spool-record.mapper.js';

export interface HookEventSourceOptions {
  readonly spoolDir: string;
  readonly emit: (event: WatchEvent) => void;
  readonly verifyReceipt: ReceiptVerifier;
  /** Called once per session, with the time of its first live hook event. */
  readonly onLive: (sessionId: string, since: number) => void;
  readonly now?: () => number;
}

/** How long after a line this version cannot read the warning about it stays up. */
const UNREADABLE_WARNING_MS = 30_000;

/**
 * Live events from agentwatch's hooks, read from the session spools.
 *
 * Hooks record only while a viewer is open, so a spool can have gaps. Only what is appended
 * after this viewer started is read; history comes from the transcripts.
 */
export class HookEventSource {
  private readonly tails = new Map<string, Tail>();
  private readonly live = new Set<string>();
  private watcher: FSWatcher | null = null;
  private unreadableAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;

  constructor(private readonly options: HookEventSourceOptions) {
    this.now = options.now ?? Date.now;
  }

  isLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  start(): void {
    // Spools that already exist may have gaps: only what is appended from now on is read.
    for (const sessionId of this.spooledSessions()) {
      const tail = new Tail(join(this.options.spoolDir, `${sessionId}.ndjson`));

      tail.seekToEnd();
      this.tails.set(sessionId, tail);
    }

    try {
      this.watcher = watch(this.options.spoolDir, { persistent: false }, (_event, name) => {
        const sessionId = name ? /^(.+)\.ndjson$/.exec(String(name))?.[1] : undefined;

        if (sessionId) {
          this.pump(sessionId);
        }
      });

      this.watcher.on('error', () => {});
    } catch {
      // The tick still reads.
    }
  }

  /** Reads what was appended to one session's spool. */
  pump(sessionId: string): void {
    let tail = this.tails.get(sessionId);

    if (!tail) {
      // Created after this viewer started: all of it is live.
      tail = new Tail(join(this.options.spoolDir, `${sessionId}.ndjson`));
      this.tails.set(sessionId, tail);
    }

    for (;;) {
      const values = tail.read(8 * 1024 * 1024);

      if (values.length === 0) {
        return;
      }

      for (const value of values) {
        const record = spoolRecordSchema.safeParse(value);

        if (!record.success) {
          // A record of another shape: whoever collects events runs a different version.
          if (asRecord(value)) {
            this.unreadableAt = this.now();
          }

          continue;
        }

        if (record.data.sessionId !== sessionId) {
          continue;
        }

        if (!this.live.has(sessionId)) {
          this.live.add(sessionId);
          this.options.onLive(sessionId, record.data.at);
        }

        for (const event of toWatchEvents(record.data, this.options.verifyReceipt)) {
          this.options.emit(event);
        }
      }
    }
  }

  /** Reads every spool, including ones created since the last call (a missed watch event). */
  tick(): void {
    for (const sessionId of this.spooledSessions()) {
      this.pump(sessionId);
    }
  }

  /** Problems reading live events, in words for the user. */
  warnings(): string[] {
    if (this.now() - this.unreadableAt >= UNREADABLE_WARNING_MS) {
      return [];
    }

    return [
      'another version of agentwatch is recording live events in a form this one cannot read; close the older agentwatch window and this one takes over',
    ];
  }

  private spooledSessions(): string[] {
    try {
      return readdirSync(this.options.spoolDir).flatMap(
        (name) => /^(.+)\.ndjson$/.exec(name)?.[1] ?? [],
      );
    } catch {
      return []; // no spool yet
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
