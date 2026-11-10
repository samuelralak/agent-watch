import { ActivityBuckets } from './activity-buckets.js';
import type { AttentionLevel, DeliveryPath } from './event.js';
import type { MessageSender } from './message.js';
import { type Timed, Timeline } from './timeline.js';

/** One tool call, from its start to whatever ended it. */
export interface ToolCall {
  readonly id: string;
  tool: string;
  /** What the call asks for, in one line. */
  summary: string;
  /** The input as it was written, when one line does not do it justice: a command. */
  detail: string;
  readonly startedAt: number;
  endedAt: number | null;
  /** `unfinished`: closed without a result (denied, or its agent or session went away). */
  outcome: 'running' | 'ok' | 'failed' | 'unfinished';
  durationMs: number | null;
  result: string;
}

/**
 * - `working`: in a run. `idle` is the main agent between turns.
 * - `waiting`: ended a turn while background work it owns is still running; it will wake.
 * - `finished`: reported back. `interrupted`: cut short, by the user or by its session ending.
 */
export type AgentPhase = 'working' | 'idle' | 'waiting' | 'finished' | 'interrupted';

type EntryBody =
  | { readonly kind: 'tool'; readonly call: ToolCall }
  | { readonly kind: 'narration' | 'prompt' | 'message' | 'notice'; readonly text: string }
  | { readonly kind: 'compaction'; readonly trigger: string }
  | { readonly kind: 'started'; readonly agentType: string }
  /** A new run of an agent that had finished. */
  | { readonly kind: 'resumed' }
  | { readonly kind: 'paused'; readonly waitingOn: number }
  | { readonly kind: 'woke'; readonly waitedMs: number }
  | { readonly kind: 'finished'; readonly report: string }
  | { readonly kind: 'interrupted'; readonly by: 'user' | 'session-end' }
  | { readonly kind: 'turn-ended' }
  | { readonly kind: 'attention'; readonly level: AttentionLevel; readonly text: string }
  | {
      readonly kind: 'delivered';
      readonly sender: MessageSender;
      readonly via: DeliveryPath;
      readonly text: string;
    }
  | { readonly kind: 'rejected'; readonly file: string; readonly reason: string };

/** One line of an agent's history. */
export type TimelineEntry = Timed & {
  readonly sessionId: string;
  readonly agentId: string | null;
} & EntryBody;

export type TimelineEntryBody = EntryBody;

export interface AgentTotals {
  readonly tokens?: number;
  readonly durationMs?: number;
  readonly toolUses?: number;
}

/** The main agent of a session (`agentId` null) or one of its subagents. */
export interface AgentState {
  readonly sessionId: string;
  readonly agentId: string | null;
  type: string;
  description: string;
  prompt: string;
  model: string;
  parentAgentId: string | null;
  background: boolean | null;
  /** Its description and prompt are confirmed by the result of the call that spawned it. */
  linked: boolean;
  phase: AgentPhase;
  firstSeenAt: number | null;
  runStartedAt: number | null;
  lastEventAt: number;
  pausedAt: number | null;
  endedAt: number | null;
  readonly openCalls: Map<string, ToolCall>;
  /** Background work this agent started and may be waiting on. */
  readonly backgroundTaskIds: Set<string>;
  callCount: number;
  failureCount: number;
  contextTokens: number;
  totals: AgentTotals | null;
  report: string;
  lastNarration: string;
  lastNarrationAt: number;
  lastCall: ToolCall | null;
  transcriptPath: string | null;
  readonly activity: ActivityBuckets;
  readonly timeline: Timeline<TimelineEntry>;
  /** Recently recorded texts, to drop the same thing reported by both sources. */
  readonly recentTexts: Map<string, number>;
}

export function createAgent(
  sessionId: string,
  agentId: string | null,
  timelineCapacity: number,
): AgentState {
  return {
    sessionId,
    agentId,
    type: agentId === null ? 'main' : 'agent',
    description: '',
    prompt: '',
    model: '',
    parentAgentId: null,
    background: null,
    linked: false,
    phase: agentId === null ? 'idle' : 'working',
    firstSeenAt: null,
    runStartedAt: null,
    lastEventAt: 0,
    pausedAt: null,
    endedAt: null,
    openCalls: new Map(),
    backgroundTaskIds: new Set(),
    callCount: 0,
    failureCount: 0,
    contextTokens: 0,
    totals: null,
    report: '',
    lastNarration: '',
    lastNarrationAt: 0,
    lastCall: null,
    transcriptPath: null,
    activity: new ActivityBuckets(),
    timeline: new Timeline(timelineCapacity),
    recentTexts: new Map(),
  };
}

/** A name for the agent: its task description, or its type and a short id. */
export function agentLabel(agent: AgentState): string {
  if (agent.agentId === null) {
    return 'main';
  }

  return agent.description || `${agent.type} ${agent.agentId.slice(0, 7)}`;
}

/** The call an agent is in now: its most recently started open call. */
export function currentCall(agent: AgentState): ToolCall | null {
  let latest: ToolCall | null = null;

  for (const call of agent.openCalls.values()) {
    if (!latest || call.startedAt > latest.startedAt) {
      latest = call;
    }
  }

  return latest;
}
