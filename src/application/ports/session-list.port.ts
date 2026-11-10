import type { SessionListing } from '../../domain/session.js';

export interface SessionListResult {
  readonly sessions: readonly SessionListing[];
  /**
   * True when the list is complete, so a session missing from it may be gone. A partial list
   * (read from a fallback) adds and updates sessions but says nothing about the others.
   */
  readonly authoritative: boolean;
  /** What went wrong, in words for the user, when the list is not authoritative. */
  readonly problem?: string;
}

/** Which Claude Code sessions are running. */
export interface SessionListPort {
  list(): Promise<SessionListResult>;
  /** Calls `listener` when the list may have changed; returns a function that stops it. */
  onChange(listener: () => void): () => void;
}
