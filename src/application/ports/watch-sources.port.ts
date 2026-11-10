/** A session whose history should be followed. */
export interface FollowedSession {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly startedAt?: number;
  readonly transcriptPath?: string | null;
}

/** History and enrichment for followed sessions (Claude Code's transcripts). */
export interface HistoryPort {
  /** True once the session's history is followed; false while it has no transcript to read. */
  follow(session: FollowedSession): boolean;
  /** From `since` on, the session's live events report tools, prompts and lifecycle. */
  setLiveSince(sessionId: string, since: number): void;
  forget(sessionId: string): void;
  tick(): void;
  rescan(): void;
  /** Problems reading the history, in words for the user. */
  warnings(): string[];
  close(): void;
}

/** Live events from the sessions' hooks. */
export interface LiveEventsPort {
  start(): void;
  tick(): void;
  /** Problems reading live events, in words for the user. */
  warnings(): string[];
  close(): void;
}

/** Collects what the hooks write, when this viewer is the one doing it. */
export interface EventCollectorPort {
  readonly isCollecting: boolean;
  tick(now?: number): void;
  forgetOldSpools(now?: number): void;
  stop(): void;
}
