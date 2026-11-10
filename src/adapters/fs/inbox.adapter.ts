import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ClaimedMessage, InboxPort } from '../../application/ports/inbox.port.js';
import type { SignedMessage } from '../../domain/message.js';
import { SESSION_ID } from '../claude/hook-payload.contract.js';
import type { StatePaths } from './state-paths.js';

const ABANDONED_AFTER_MS = 60_000;

const signedMessageSchema = z
  .object({
    v: z.literal(2),
    session: z.string().regex(SESSION_ID),
    target: z.literal('main'),
    sender: z.enum(['user', 'agent']),
    aboutAgentId: z.string().nullable(),
    aboutLabel: z.string().nullable(),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    createdAt: z.number(),
    expiresAt: z.number(),
    text: z.string(),
    alg: z.string(),
    sig: z.string(),
  })
  .strict()
  .readonly();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A session's inbox is a folder: one file per waiting message, the waiter's wake-up FIFO
 * (`.wake`), the waiter's pid (`.waiter`), and a marker the delivery hook leaves the first time
 * it runs (`.hooks`).
 */
export class FileInbox implements InboxPort {
  constructor(private readonly paths: StatePaths) {}

  put(message: SignedMessage): boolean {
    const dir = this.dir(message.session);

    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // Written whole, then moved into place: a hook never reads half a message.
    const temporary = join(dir, `.${message.nonce}.tmp`);

    writeFileSync(temporary, JSON.stringify(message), { mode: 0o600 });
    renameSync(temporary, join(dir, `${message.createdAt}-${message.nonce}.msg`));

    return this.wake(message.session);
  }

  claim(sessionId: string): ClaimedMessage[] {
    if (!SESSION_ID.test(sessionId)) {
      return [];
    }

    const claimed: ClaimedMessage[] = [];

    for (const name of this.waitingFiles(sessionId)) {
      const message = this.claimOne(sessionId, name);

      if (message) {
        claimed.push(message);
      }
    }

    return claimed;
  }

  wasDelivered(sessionId: string, nonce: string): boolean {
    try {
      return readFileSync(join(this.paths.seen, sessionId), 'utf8').split('\n').includes(nonce);
    } catch {
      return false;
    }
  }

  rememberDelivered(sessionId: string, nonce: string): void {
    mkdirSync(this.paths.seen, { recursive: true, mode: 0o700 });
    appendFileSync(join(this.paths.seen, sessionId), `${nonce}\n`, { mode: 0o600 });
  }

  canReceive(sessionId: string): boolean {
    return existsSync(join(this.dir(sessionId), '.hooks')) || this.hasWaiter(sessionId);
  }

  hasWaiter(sessionId: string): boolean {
    try {
      const pid = Number(readFileSync(join(this.dir(sessionId), '.waiter'), 'utf8'));

      return Number.isInteger(pid) && pid > 0 && isAlive(pid);
    } catch {
      return false;
    }
  }

  recoverAbandoned(now: number): number {
    let recovered = 0;

    for (const sessionId of safeList(this.paths.inbox)) {
      const dir = join(this.paths.inbox, sessionId);

      for (const name of safeList(dir)) {
        const match = /^(.+\.msg)\.claimed-(\d+)$/.exec(name);

        if (!match?.[1]) {
          continue;
        }

        const path = join(dir, name);

        try {
          if (isAlive(Number(match[2])) || now - statSync(path).mtimeMs < ABANDONED_AFTER_MS) {
            continue;
          }

          renameSync(path, join(dir, match[1]));
          recovered++;
        } catch {
          // Taken care of by someone else.
        }
      }
    }

    return recovered;
  }

  /** The names of the session's waiting message files, oldest first. */
  private waitingFiles(sessionId: string): string[] {
    try {
      return readdirSync(this.dir(sessionId))
        .filter((name) => name.endsWith('.msg'))
        .sort();
    } catch {
      return [];
    }
  }

  /** Takes one message file for this process, or returns null when another hook got it first. */
  private claimOne(sessionId: string, name: string): ClaimedMessage | null {
    const original = join(this.dir(sessionId), name);
    const mine = `${original}.claimed-${process.pid}`;

    try {
      renameSync(original, mine); // atomic: of several hooks racing, one gets it
    } catch {
      return null;
    }

    return {
      file: name,
      message: this.read(mine),
      discard: () => remove(mine),
      reject: () => this.setAside(mine, `${sessionId}-${name}`),
      putBack: () => {
        try {
          renameSync(mine, original);
        } catch {
          // Lost: recoverAbandoned will find the claim if it is still there.
        }
      },
    };
  }

  /** Moves a refused file out of the inbox, where the user can look at it. */
  private setAside(file: string, name: string): void {
    mkdirSync(this.paths.rejected, { recursive: true, mode: 0o700 });

    try {
      renameSync(file, join(this.paths.rejected, name));
    } catch {
      remove(file);
    }
  }

  private dir(sessionId: string): string {
    return join(this.paths.inbox, sessionId);
  }

  private read(path: string): SignedMessage | null {
    try {
      const parsed = signedMessageSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));

      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  // Writes one byte to the waiter's FIFO. Opened non-blocking: with no waiter listening the open
  // fails, and the message waits for the session's next delivery hook.
  private wake(sessionId: string): boolean {
    const fifo = join(this.dir(sessionId), '.wake');

    try {
      if (!statSync(fifo).isFIFO()) {
        return false;
      }

      const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);

      try {
        writeSync(fd, '\n');
      } finally {
        closeSync(fd);
      }

      return true;
    } catch {
      return false;
    }
  }
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
