import type { AgentState, ToolCall } from './agent.js';
import { isActive } from './agent-status.policy.js';
import type { Journal } from './journal.js';
import type { SessionState } from './session.js';

/** Activity this long after an agent ended means it was continued: a new run. */
const RESUME_GRACE_MS = 2000;
const ENDED_CALL_MEMORY = 4096;

/**
 * How an agent moves between working, waiting, finished and interrupted, and what becomes of
 * its open tool calls when it does.
 */
export class AgentLifecycle {
  constructor(private readonly journal: Journal) {}

  /**
   * Notes that the agent did something at `at`. Only `active` events (prompts, tool calls,
   * starts) change its phase: late narration from a transcript must not wake a paused agent.
   */
  touch(agent: AgentState, at: number, active: boolean): void {
    if (active && agent.agentId !== null) {
      this.backToWork(agent, at);
    }

    agent.firstSeenAt ??= at;
    agent.runStartedAt ??= at;
    agent.lastEventAt = Math.max(agent.lastEventAt, at);
    agent.activity.add(at);
  }

  startCall(session: SessionState, agent: AgentState, call: ToolCall): void {
    agent.openCalls.set(call.id, call);
    session.calls.set(call.id, call);
    agent.callCount++;
    agent.lastCall = call;
  }

  /** The call has ended, with a result or without one. */
  endCall(session: SessionState, agent: AgentState, call: ToolCall): void {
    agent.openCalls.delete(call.id);
    session.calls.delete(call.id);

    if (session.endedCallIds.size >= ENDED_CALL_MEMORY) {
      session.endedCallIds.clear();
    }

    session.endedCallIds.add(call.id);
    this.journal.callEnded(session, agent, call);
  }

  /** Closes calls that will never report an end: denied, or cut short. */
  closeOpenCalls(session: SessionState, agent: AgentState, at: number): void {
    for (const call of [...agent.openCalls.values()]) {
      call.endedAt = at;
      call.outcome = 'unfinished';
      call.durationMs = at - call.startedAt;
      this.endCall(session, agent, call);
    }
  }

  /**
   * The agent ended a turn. With background work of its own still running that is a pause;
   * otherwise it has finished. `running` lists every background task running in the session.
   */
  pauseOrFinish(
    session: SessionState,
    agent: AgentState,
    at: number,
    running: readonly string[] | undefined,
  ): void {
    this.closeOpenCalls(session, agent, at);

    const waitingOn = new Set((running ?? []).filter((id) => agent.backgroundTaskIds.has(id)));

    if (waitingOn.size === 0) {
      this.finish(session, agent, at);

      return;
    }

    agent.backgroundTaskIds.clear();

    for (const id of waitingOn) {
      agent.backgroundTaskIds.add(id);
    }

    if (agent.phase !== 'waiting') {
      agent.phase = 'waiting';
      agent.pausedAt = at;
      this.journal.record(agent, at, { kind: 'paused', waitingOn: waitingOn.size });
    }
  }

  finish(session: SessionState, agent: AgentState, at: number): void {
    if (agent.phase === 'finished') {
      return;
    }

    this.closeOpenCalls(session, agent, at);
    agent.phase = 'finished';
    agent.pausedAt = null;
    agent.endedAt = Math.max(at, agent.endedAt ?? 0);
    release(session, agent);
    this.journal.record(agent, at, { kind: 'finished', report: agent.report });
  }

  /** The agent's run was cut short: by the user, or because its session went away. */
  interrupt(
    session: SessionState,
    agent: AgentState,
    at: number,
    by: 'user' | 'session-end',
  ): void {
    if (!isActive(agent)) {
      return;
    }

    this.closeOpenCalls(session, agent, at);
    agent.phase = 'interrupted';
    agent.pausedAt = null;
    agent.endedAt = at;
    release(session, agent);
    this.journal.record(agent, at, { kind: 'interrupted', by });
  }

  /** The session ended or is gone: nothing in it is running any more. */
  endSession(session: SessionState, at: number): void {
    session.alive = false;
    session.endedAt ??= at;
    session.status = '';
    session.waitingFor = '';
    session.attention = null;
    session.pendingSpawns = [];

    this.closeOpenCalls(session, session.main, at);
    session.main.phase = 'idle';
    session.main.backgroundTaskIds.clear();

    for (const agent of session.agents.values()) {
      this.interrupt(session, agent, at, 'session-end');
    }
  }

  /** An agent that had ended starts a new run; one that was waiting wakes. */
  private backToWork(agent: AgentState, at: number): void {
    const ended = agent.phase === 'finished' || agent.phase === 'interrupted';

    if (ended && agent.endedAt !== null && at > agent.endedAt + RESUME_GRACE_MS) {
      agent.phase = 'working';
      agent.runStartedAt = at;
      agent.endedAt = null;
      this.journal.record(agent, at, { kind: 'resumed' });

      return;
    }

    if (agent.phase === 'waiting') {
      const waitedMs = at - (agent.pausedAt ?? at);

      agent.phase = 'working';
      agent.pausedAt = null;
      this.journal.record(agent, at, { kind: 'woke', waitedMs });
    }
  }
}

/** The agent is no longer running: it waits on nothing, and nothing waits on it. */
function release(session: SessionState, agent: AgentState): void {
  agent.backgroundTaskIds.clear();

  if (agent.agentId === null) {
    return;
  }

  session.main.backgroundTaskIds.delete(agent.agentId);

  for (const other of session.agents.values()) {
    other.backgroundTaskIds.delete(agent.agentId);
  }
}
