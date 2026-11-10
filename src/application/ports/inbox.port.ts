import type { SignedMessage } from '../../domain/message.js';

/** A message file taken out of a session's inbox by the hook that will deliver or reject it. */
export interface ClaimedMessage {
  readonly file: string;
  /** Null when the file could not be read as a message. */
  readonly message: SignedMessage | null;
  /** Removes the claimed file: it was delivered. */
  discard(): void;
  /** Sets the claimed file aside as rejected. */
  reject(): void;
  /** Puts the file back in the inbox, to be delivered by a later hook. */
  putBack(): void;
}

/** Where signed messages wait for a session's hooks. */
export interface InboxPort {
  /** Stores the message; returns true when a waiter was listening and the session is being woken. */
  put(message: SignedMessage): boolean;
  /** Claims every waiting message of the session, oldest first. Each is claimed by one caller only. */
  claim(sessionId: string): ClaimedMessage[];
  /** Whether this nonce was already delivered to the session. */
  wasDelivered(sessionId: string, nonce: string): boolean;
  rememberDelivered(sessionId: string, nonce: string): void;
  /** Whether the session runs agentwatch's hooks, so a message can reach it. */
  canReceive(sessionId: string): boolean;
  /** Whether a waiter is listening, so a message would wake the session now. */
  hasWaiter(sessionId: string): boolean;
  /** Returns messages claimed by a hook that died before delivering them. */
  recoverAbandoned(now: number): number;
}
