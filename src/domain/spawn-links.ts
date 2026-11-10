// Linking a subagent to the Agent call that started it. The agent's own start names no parent,
// so a started agent is matched provisionally to the oldest open call of its type; the call's
// result names the agent it started, and confirms the match or corrects it.
import type { AgentState } from './agent.js';
import type { SpawnRequest } from './event.js';
import type { PendingSpawn, SessionState } from './session.js';

/** Remembers what an Agent call asked for, until its result says which agent it started. */
export function requestSpawn(
  session: SessionState,
  spawner: AgentState,
  toolUseId: string,
  request: SpawnRequest,
  at: number,
): void {
  session.pendingSpawns.push({
    toolUseId,
    parentAgentId: spawner.agentId,
    agentType: request.agentType,
    description: request.description,
    prompt: request.prompt,
    background: request.background,
    at,
    agentId: null,
  });
}

/** Provisional link: the oldest unmatched spawn of the agent's type in this session. */
export function matchSpawn(session: SessionState, agent: AgentState): void {
  const open = session.pendingSpawns.filter((spawn) => spawn.agentId === null);

  const spawn =
    open.find((candidate) => candidate.agentType === agent.type) ??
    (open.length === 1 ? open[0] : undefined);

  if (spawn) {
    assign(session, agent, spawn, false);
  }
}

/**
 * The call `toolUseId` returned and named `agent` as the one it started. Confirms that link and
 * undoes a provisional one that turns out wrong (parallel spawns of one type can start in any
 * order). Returns the spawn, or undefined when the call's start was never seen.
 */
export function confirmSpawn(
  session: SessionState,
  agent: AgentState,
  toolUseId: string,
): PendingSpawn | undefined {
  const spawn = session.pendingSpawns.find((candidate) => candidate.toolUseId === toolUseId);

  if (!spawn) {
    return undefined;
  }

  const wronglyMatched = spawn.agentId !== agent.agentId ? spawn.agentId : null;

  const stale = session.pendingSpawns.find(
    (candidate) => candidate !== spawn && candidate.agentId === agent.agentId,
  );

  if (stale) {
    stale.agentId = null;
  }

  assign(session, agent, spawn, true);

  if (wronglyMatched) {
    unlink(session, wronglyMatched);
  }

  return spawn;
}

/** Forgets the spawns `dead` picks out: their calls were denied, failed, or lost. */
export function dropSpawns(session: SessionState, dead: (spawn: PendingSpawn) => boolean): void {
  const dropped = session.pendingSpawns.filter(dead);

  if (dropped.length === 0) {
    return;
  }

  session.pendingSpawns = session.pendingSpawns.filter((spawn) => !dead(spawn));

  // An agent provisionally matched to a spawn that never ran was matched wrongly.
  for (const spawn of dropped) {
    unlink(session, spawn.agentId);
  }
}

function assign(
  session: SessionState,
  agent: AgentState,
  spawn: PendingSpawn,
  confirmed: boolean,
): void {
  spawn.agentId = agent.agentId;

  if (spawn.description) {
    agent.description = spawn.description;
  }

  if (spawn.prompt) {
    agent.prompt = spawn.prompt;
  }

  agent.parentAgentId = spawn.parentAgentId;
  agent.background = spawn.background;
  agent.linked = confirmed;

  if (confirmed) {
    session.pendingSpawns = session.pendingSpawns.filter((other) => other !== spawn);
  }
}

/** Takes back a provisional link, and looks for another spawn the agent may belong to. */
function unlink(session: SessionState, agentId: string | null): void {
  const agent = agentId === null ? undefined : session.agents.get(agentId);

  if (!agent || agent.linked) {
    return;
  }

  agent.description = '';
  agent.prompt = '';
  agent.parentAgentId = null;
  matchSpawn(session, agent);
}
