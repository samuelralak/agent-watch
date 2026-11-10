import type { ClosingWords } from '../../domain/closing-words.js';
import type { Store } from '../../domain/store.js';

/** A session that has ended, as far as the edges of its record tell. */
export interface PastSession {
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string;
  /** When it was last written to. */
  readonly endedAt: number;
  /** How many subagents it started. */
  readonly agentCount: number;
  /** How its main agent ended its last turn; null when it said nothing. */
  readonly closing: ClosingWords | null;
}

/** The sessions that are over: which there are, and what each of them did. */
export interface SessionHistoryPort {
  /** Every past session there is a record of on this machine, newest first. */
  list(): PastSession[];
  /** The session's activity as it stood when it ended, in a store that holds only it. */
  open(session: PastSession): Store;
}
