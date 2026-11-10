import type { TimelineEntry } from './agent.js';
import { AgentLifecycle } from './agent-lifecycle.js';
import { isActive } from './agent-status.policy.js';
import type { WatchEvent } from './event.js';
import { EventReducer } from './event-reducer.js';
import { Journal, type Rejection, type StoreListener } from './journal.js';
import {
  createSession,
  type OutboxMessage,
  type SessionListing,
  type SessionState,
} from './session.js';
import { applyListing, isGone } from './session-list.policy.js';
import type { Timeline } from './timeline.js';

const SPAWN_MEMORY_MS = 6 * 3600 * 1000;

export type { Rejection, StoreChange, StoreListener } from './journal.js';

export interface StoreOptions {
  readonly feedCapacity?: number;
  readonly agentTimelineCapacity?: number;
}

/**
 * The state of every watched session. Events change it through the reducer; the session list
 * and the viewer add the few facts no event carries. It does no I/O, so it is tested by
 * replaying recorded events.
 */
export class Store {
  readonly sessions = new Map<string, SessionState>();
  private readonly journal: Journal;
  private readonly lifecycle: AgentLifecycle;
  private readonly reducer: EventReducer;
  private readonly agentTimelineCapacity: number;
  private changes = 0;

  constructor(options: StoreOptions = {}) {
    this.journal = new Journal(options.feedCapacity ?? 5000);
    this.lifecycle = new AgentLifecycle(this.journal);
    this.reducer = new EventReducer(this.journal, this.lifecycle);
    this.agentTimelineCapacity = options.agentTimelineCapacity ?? 400;
  }

  /** Every agent's entries in one time-ordered log. */
  get feed(): Timeline<TimelineEntry> {
    return this.journal.feed;
  }

  /** Message files that hooks refused to deliver. */
  get rejections(): readonly Rejection[] {
    return this.journal.rejections;
  }

  /** Increases on every change; views redraw when it moves. */
  get version(): number {
    return this.changes;
  }

  /** Calls `listener` for everything recorded from now on; returns a function that stops it. */
  subscribe(listener: StoreListener): () => void {
    return this.journal.subscribe(listener);
  }

  session(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = createSession(sessionId, this.agentTimelineCapacity);
      this.sessions.set(sessionId, session);
    }

    return session;
  }

  /** Applies one event from a source. */
  apply(event: WatchEvent): void {
    this.reducer.apply(this.session(event.sessionId), event);
    this.changes++;
  }

  /**
   * Applies one poll of the session list. A session missing from one complete list is kept:
   * only repeated absence means it is gone, and then its unfinished agents are interrupted.
   * A list that is not `authoritative` (a fallback) says nothing about sessions it leaves out.
   */
  syncListing(listings: readonly SessionListing[], polledAt: number, authoritative = true): void {
    const listed = new Set<string>();

    for (const listing of listings) {
      listed.add(listing.sessionId);
      applyListing(this.session(listing.sessionId), listing, polledAt);
    }

    if (authoritative) {
      this.noteMissing(listed, polledAt);
    }

    this.changes++;
  }

  /** The session's hooks are delivering events to this viewer. */
  markHooksLive(sessionId: string): void {
    const session = this.session(sessionId);

    if (session.hooksLive) {
      return;
    }

    session.hooksLive = true;
    this.changes++;
  }

  setCanMessage(sessionId: string, canMessage: boolean): void {
    const session = this.sessions.get(sessionId);

    if (!session || session.canMessage === canMessage) {
      return;
    }

    session.canMessage = canMessage;
    this.changes++;
  }

  /** Remembers a message the user sent from this viewer. */
  addOutbox(sessionId: string, message: OutboxMessage): void {
    this.session(sessionId).outbox.push(message);
    this.changes++;
  }

  /** Forgets agents and sessions that ended more than `keepMs` ago. */
  prune(now: number, keepMs: number): void {
    for (const [sessionId, session] of this.sessions) {
      forgetOldAgents(session, now, keepMs);
      session.pendingSpawns = session.pendingSpawns.filter((s) => now - s.at < SPAWN_MEMORY_MS);

      const goneFor = session.endedAt === null ? 0 : now - session.endedAt;

      if (!session.alive && session.agents.size === 0 && goneFor > keepMs) {
        this.sessions.delete(sessionId);
      }
    }

    this.changes++;
  }

  /** Counts a poll against every live session the list left out, and ends the ones now gone. */
  private noteMissing(listed: ReadonlySet<string>, polledAt: number): void {
    for (const session of this.sessions.values()) {
      if (!session.alive || listed.has(session.sessionId)) {
        continue;
      }

      session.missedPolls++;

      if (isGone(session)) {
        this.lifecycle.endSession(session, polledAt);
      }
    }
  }
}

function forgetOldAgents(session: SessionState, now: number, keepMs: number): void {
  for (const [agentId, agent] of session.agents) {
    if (!isActive(agent) && agent.endedAt !== null && now - agent.endedAt > keepMs) {
      session.agents.delete(agentId);
    }
  }
}
