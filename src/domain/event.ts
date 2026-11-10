import type { MessageSender } from './message.js';

/** Where an event was observed. Hooks are live and precise; transcripts give history. */
export type EventOrigin = 'hook' | 'transcript';

/** How a message reached the main agent. */
export type DeliveryPath = 'tool' | 'turn-end' | 'wake';

export type AttentionLevel = 'permission' | 'error' | 'info';

/** What an Agent tool call asked for. */
export interface SpawnRequest {
  readonly agentType: string;
  readonly description: string;
  readonly prompt: string;
  readonly background: boolean;
}

/** What an Agent tool call returned: the subagent it started. */
export interface SpawnResult {
  readonly agentId: string;
  readonly agentType?: string;
  readonly model?: string;
  /** True when the call returned because the subagent finished (a foreground spawn). */
  readonly completed: boolean;
  readonly totalTokens?: number;
  readonly totalDurationMs?: number;
  readonly toolUseCount?: number;
}

interface EventBase {
  /** When it happened, in epoch milliseconds. */
  readonly at: number;
  readonly sessionId: string;
  /** The subagent it concerns, or null for the session's main agent. */
  readonly agentId: string | null;
  readonly origin: EventOrigin;
}

type EventBody =
  | { readonly kind: 'session.started'; readonly cwd?: string; readonly transcriptPath?: string }
  | { readonly kind: 'session.ended'; readonly reason?: string }
  | { readonly kind: 'prompt.submitted'; readonly text: string }
  | {
      readonly kind: 'tool.started';
      readonly toolUseId: string;
      readonly tool: string;
      readonly summary: string;
      /** The call's input as it was written, when it has a form worth keeping: a command. */
      readonly detail?: string;
      readonly spawn?: SpawnRequest;
      /** The agent's report to its caller, when this call is how the report is handed back. */
      readonly report?: string;
    }
  | {
      readonly kind: 'tool.ended';
      readonly toolUseId: string;
      readonly tool: string;
      readonly ok: boolean;
      readonly durationMs?: number;
      readonly result: string;
      readonly spawned?: SpawnResult;
      /** Set when the call left work running in the background (a shell, a monitor). */
      readonly backgroundTaskId?: string;
    }
  | {
      readonly kind: 'agent.started';
      readonly agentType?: string;
      readonly description?: string;
      readonly prompt?: string;
      readonly model?: string;
      readonly parentAgentId?: string;
    }
  | {
      /**
       * The agent ended a turn. That is a pause, not a finish, while background work it owns is
       * still running; `runningTaskIds` lists every background task running in the session.
       * Absent, the source knows the agent finished for good.
       */
      readonly kind: 'agent.stopped';
      readonly agentType?: string;
      readonly report?: string;
      readonly transcriptPath?: string;
      readonly runningTaskIds?: readonly string[];
      /** The run was cut short and reported nothing back: who or what cut it. */
      readonly interruptedBy?: 'user' | 'session-end';
    }
  | {
      readonly kind: 'turn.ended';
      readonly text?: string;
      readonly runningTaskIds?: readonly string[];
    }
  | { readonly kind: 'background.ended'; readonly taskId: string }
  | { readonly kind: 'narration'; readonly text: string }
  | { readonly kind: 'message.received'; readonly text: string }
  | { readonly kind: 'notice'; readonly text: string }
  | { readonly kind: 'usage'; readonly contextTokens: number }
  | { readonly kind: 'attention'; readonly level: AttentionLevel; readonly text: string }
  | { readonly kind: 'compaction'; readonly trigger: string }
  | {
      readonly kind: 'message.delivered';
      readonly nonce: string;
      /** Who the message says it is from. Only `user` was typed by the user. */
      readonly sender: MessageSender;
      readonly via: DeliveryPath;
      readonly text: string;
    }
  | { readonly kind: 'message.rejected'; readonly file: string; readonly reason: string };

/**
 * What a source reports about a session. Hooks and transcripts map their own formats to these;
 * the store is the only consumer.
 */
export type WatchEvent = EventBase & EventBody;

export type WatchEventKind = WatchEvent['kind'];

/** The event of one kind, with that kind's own fields. */
export type EventOf<K extends WatchEventKind> = Extract<WatchEvent, { readonly kind: K }>;
