import type { AgentState } from './agent.js';

/** What an agent is doing, as shown to the user. Derived from its state and the time. */
export type AgentStatus =
  | 'in-tool'
  | 'working'
  | 'waiting'
  | 'stalled'
  | 'finished'
  | 'interrupted'
  | 'idle';

/** No event for this long, outside a tool call and with nothing to wait on, reads as stalled. */
export const STALL_AFTER_MS = 5 * 60 * 1000;

/** Quiet for this long with background work running reads as waiting, even with no stop seen. */
const QUIET_BEFORE_WAITING_MS = 15_000;

export function agentStatus(agent: AgentState, now: number): AgentStatus {
  if (agent.phase === 'finished' || agent.phase === 'interrupted' || agent.phase === 'idle') {
    return agent.phase;
  }

  if (agent.openCalls.size > 0) {
    return 'in-tool';
  }

  if (agent.phase === 'waiting') {
    return 'waiting';
  }

  const quietMs = agent.lastEventAt ? now - agent.lastEventAt : 0;

  // Without hooks there is no stop event: an agent that went quiet after starting background
  // work is waiting on it, not stalled.
  if (agent.backgroundTaskIds.size > 0 && quietMs > QUIET_BEFORE_WAITING_MS) {
    return 'waiting';
  }

  return quietMs > STALL_AFTER_MS ? 'stalled' : 'working';
}

/** Still part of the session's live work: not finished and not interrupted. */
export function isActive(agent: AgentState): boolean {
  return agent.phase !== 'finished' && agent.phase !== 'interrupted';
}
