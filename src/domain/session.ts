import { type AgentState, createAgent, type ToolCall } from './agent.js';
import { isActive } from './agent-status.policy.js';
import { type ClosingWords, closingWords } from './closing-words.js';
import type { AttentionLevel, DeliveryPath } from './event.js';

/** A live session as the session list reports it. */
export interface SessionListing {
  readonly sessionId: string;
  readonly name?: string;
  readonly cwd?: string;
  readonly kind?: string;
  readonly pid?: number | null;
  readonly shortId?: string;
  readonly startedAt?: number;
  /** `busy`, `idle` or `waiting`. */
  readonly status?: string;
  readonly state?: string;
  /** What it is waiting on the user for, such as a permission prompt. */
  readonly waitingFor?: string;
  readonly version?: string;
}

export interface Attention {
  readonly at: number;
  readonly level: AttentionLevel;
  readonly text: string;
  readonly agentId: string | null;
}

/** A message the user sent from this viewer, and what became of it. */
/** What the main agent said in one turn after a message. */
export interface ReplyPart {
  text: string;
  /** When it first spoke in that turn. */
  readonly at: number;
  /** When that turn ended; null while it is still running. */
  endedAt: number | null;
}

/** A delivered message the main agent is answering: see `reply.ts`. */
export interface Answering {
  readonly message: OutboxMessage;
  /**
   * The background work that was already running when the message was delivered. It is not
   * work on the message, however long it goes on: a development server left running does not
   * mean an answer is still to come.
   */
  readonly runningBefore: ReadonlySet<string>;
}

export interface OutboxMessage {
  readonly nonce: string;
  readonly text: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly aboutAgentId: string | null;
  readonly aboutLabel: string | null;
  /** Sending it reached a waiter, so the session is being woken. */
  readonly woke: boolean;
  status: 'queued' | 'delivered';
  deliveredAt: number | null;
  via: DeliveryPath | null;
  /**
   * What the main agent said after receiving it, oldest first: one part for each turn in which
   * it spoke, for as long as it carried on by itself.
   */
  readonly replies: ReplyPart[];
}

/** An Agent tool call whose subagent is not yet confirmed by the call's result. */
export interface PendingSpawn {
  readonly toolUseId: string;
  readonly parentAgentId: string | null;
  readonly agentType: string;
  readonly description: string;
  readonly prompt: string;
  readonly background: boolean;
  readonly at: number;
  /** The agent provisionally matched to it, until the result confirms or corrects it. */
  agentId: string | null;
}

export interface SessionState {
  readonly sessionId: string;
  /** How many entries each of its agents keeps. */
  readonly timelineCapacity: number;
  name: string;
  cwd: string;
  kind: string;
  pid: number | null;
  shortId: string | null;
  version: string;
  /** When the session list first reported it; fixes its place in the list. */
  listedAt: number | null;
  alive: boolean;
  /** Consecutive successful polls that did not list it. */
  missedPolls: number;
  status: string;
  waitingFor: string;
  endedAt: number | null;
  lastEventAt: number;
  transcriptPath: string | null;
  /** Its hooks are delivering events to this viewer. */
  hooksLive: boolean;
  /** It runs agentwatch's hooks, so a message can reach it. */
  canMessage: boolean;
  readonly main: AgentState;
  readonly agents: Map<string, AgentState>;
  /** Open calls of every agent in the session, to drop the same call reported twice. */
  readonly calls: Map<string, ToolCall>;
  readonly endedCallIds: Set<string>;
  pendingSpawns: PendingSpawn[];
  attention: Attention | null;
  readonly outbox: OutboxMessage[];
  answering: Answering | null;
}

export function createSession(sessionId: string, timelineCapacity: number): SessionState {
  return {
    sessionId,
    timelineCapacity,
    name: sessionId.slice(0, 8),
    cwd: '',
    kind: '',
    pid: null,
    shortId: null,
    version: '',
    listedAt: null,
    alive: false,
    missedPolls: 0,
    status: '',
    waitingFor: '',
    endedAt: null,
    lastEventAt: 0,
    transcriptPath: null,
    hooksLive: false,
    canMessage: false,
    main: createAgent(sessionId, null, timelineCapacity),
    agents: new Map(),
    calls: new Map(),
    endedCallIds: new Set(),
    pendingSpawns: [],
    attention: null,
    outbox: [],
    answering: null,
  };
}

/** Busy or idle comes from the session list and live hooks, never from replayed history. */
export function isBusy(session: SessionState): boolean {
  return session.status ? session.status === 'busy' : session.main.phase === 'working';
}

export function needsUser(session: SessionState): boolean {
  return session.status === 'waiting' || session.attention?.level === 'permission';
}

/**
 * How the main agent ended its last turn, for a session that is idle: its closing line, and
 * whether that line asks the user for something. Claude Code calls a session idle whether it
 * is done or stopped on a question in plain text, so the closing line is what tells the two
 * apart. Unlike `needsUser`, which is a prompt Claude Code is blocked on, this is a reading of
 * what the agent said: it is shown as what was said, never as a fact about what is needed.
 */
export function endedOn(session: SessionState): ClosingWords | null {
  if (!session.alive || isBusy(session) || needsUser(session) || session.main.phase !== 'idle') {
    return null;
  }

  return closingWords(session.main.lastNarration);
}

/** The session's main agent for `null`, or the subagent with that id, created when first seen. */
export function agentOf(session: SessionState, agentId: string | null): AgentState {
  if (agentId === null) {
    return session.main;
  }

  let agent = session.agents.get(agentId);

  if (!agent) {
    agent = createAgent(session.sessionId, agentId, session.timelineCapacity);
    session.agents.set(agentId, agent);
  }

  return agent;
}

/** Subagents worth showing: live ones, and those that ended within `recentMs`. */
export function visibleAgents(session: SessionState, now: number, recentMs: number): AgentState[] {
  return [...session.agents.values()].filter(
    (agent) =>
      agent.firstSeenAt !== null && (isActive(agent) || now - (agent.endedAt ?? 0) < recentMs),
  );
}
