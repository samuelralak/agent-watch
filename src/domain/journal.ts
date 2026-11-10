import type { AgentState, TimelineEntry, TimelineEntryBody, ToolCall } from './agent.js';
import type { SessionState } from './session.js';
import { Timeline } from './timeline.js';

/** The same text for the same agent within this window is one thing reported twice. */
const DUPLICATE_WINDOW_MS = 60_000;
const DUPLICATE_MEMORY = 64;
const REJECTION_MEMORY = 100;

/** A message file a session's hook refused to deliver. */
export interface Rejection {
  readonly at: number;
  readonly sessionId: string;
  readonly file: string;
  readonly reason: string;
}

/**
 * What was recorded, after merging what the sources report twice: a new line of history, or the
 * end of a tool call whose line was recorded when it started.
 */
export type StoreChange =
  | { readonly kind: 'recorded'; readonly entry: TimelineEntry }
  | {
      readonly kind: 'call-ended';
      readonly sessionId: string;
      readonly agentId: string | null;
      readonly call: ToolCall;
    };

export type StoreListener = (change: StoreChange) => void;

type TextEntry = Extract<TimelineEntryBody, { text: string }>;

/** Everything that was recorded, in time order, and whoever wants to hear about it. */
export class Journal {
  /** Every agent's entries in one time-ordered log. */
  readonly feed: Timeline<TimelineEntry>;
  readonly rejections: Rejection[] = [];
  private readonly listeners = new Set<StoreListener>();
  private seq = 0;

  constructor(feedCapacity: number) {
    this.feed = new Timeline(feedCapacity);
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  /** Adds a line to the agent's own history and to the feed. */
  record(agent: AgentState, at: number, body: TimelineEntryBody): void {
    const entry = {
      at,
      seq: ++this.seq,
      sessionId: agent.sessionId,
      agentId: agent.agentId,
      ...body,
    } as TimelineEntry;

    agent.timeline.insert(entry);
    this.feed.insert(entry);
    this.notify({ kind: 'recorded', entry });
  }

  /** Records a text entry unless the same one was just recorded: both sources can report it. */
  recordOnce(agent: AgentState, at: number, body: TextEntry): void {
    const key = `${body.kind}\u0000${body.text.replace(/\s+/g, ' ').trim()}`;
    const previous = agent.recentTexts.get(key);

    if (previous !== undefined && Math.abs(at - previous) <= DUPLICATE_WINDOW_MS) {
      return;
    }

    agent.recentTexts.set(key, at);
    forgetOldest(agent.recentTexts, DUPLICATE_MEMORY);
    this.record(agent, at, body);
  }

  /** Says that a call has ended. Its line was recorded when it started. */
  callEnded(session: SessionState, agent: AgentState, call: ToolCall): void {
    this.notify({
      kind: 'call-ended',
      sessionId: session.sessionId,
      agentId: agent.agentId,
      call,
    });
  }

  reject(rejection: Rejection): void {
    this.rejections.push(rejection);

    if (this.rejections.length > REJECTION_MEMORY) {
      this.rejections.shift();
    }
  }

  private notify(change: StoreChange): void {
    for (const listener of this.listeners) {
      listener(change);
    }
  }
}

/** Keeps a map that remembers recent keys from growing past `limit`. */
function forgetOldest(recent: Map<string, number>, limit: number): void {
  if (recent.size <= limit) {
    return;
  }

  const oldest = recent.keys().next().value;

  if (oldest !== undefined) {
    recent.delete(oldest);
  }
}
