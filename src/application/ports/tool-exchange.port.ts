/** Which tool call is meant: a call belongs to a session, and to one of its agents or the main one. */
export interface ToolCallRef {
  readonly sessionId: string;
  readonly agentId: string | null;
  readonly toolUseId: string;
}

/**
 * What a tool was given and what it gave back, whole. The record agentwatch keeps of a call is
 * one line each way, so that watching costs little; this is the rest, fetched when it is asked
 * for.
 */
export interface ToolExchange {
  /** The input as the agent wrote it: a command, or the call's arguments. */
  readonly input: string;
  /** What came back; null when the call has no result on record (it is running, or was denied). */
  readonly result: string | null;
}

/** Looks one tool call up where its whole text is kept. */
export interface ToolExchangePort {
  /** Null when the call cannot be found: its text is then only what the record has. */
  find(call: ToolCallRef): ToolExchange | null;
}
