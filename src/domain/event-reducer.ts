import type { AgentState, ToolCall } from './agent.js';
import type { AgentLifecycle } from './agent-lifecycle.js';
import { isActive } from './agent-status.policy.js';
import type { EventOf, SpawnResult, WatchEvent } from './event.js';
import type { Journal } from './journal.js';
import { closeReply, noteReply, startReply, userSpoke } from './reply.js';
import { agentOf, type SessionState } from './session.js';
import { confirmSpawn, dropSpawns, matchSpawn, requestSpawn } from './spawn-links.js';

/**
 * Applies events to a session, one small step per kind of event. It does no I/O: the same
 * events in the same order always give the same state.
 */
export class EventReducer {
  constructor(
    private readonly journal: Journal,
    private readonly lifecycle: AgentLifecycle,
  ) {}

  // eslint-disable-next-line max-lines-per-function -- a flat list: one case per kind of event
  apply(session: SessionState, event: WatchEvent): void {
    if (isStopOfUnknownAgent(session, event)) {
      return;
    }

    session.lastEventAt = Math.max(session.lastEventAt, event.at);

    const agent = agentOf(session, event.agentId);

    switch (event.kind) {
      case 'session.started':
        this.sessionStarted(session, event);
        break;

      case 'session.ended':
        this.lifecycle.endSession(session, event.at);
        break;

      case 'prompt.submitted':
        this.promptSubmitted(session, agent, event);
        break;

      case 'tool.started':
        this.toolStarted(session, agent, event);
        break;

      case 'tool.ended':
        this.toolEnded(session, agent, event);
        break;

      case 'agent.started':
        this.agentStarted(session, agent, event);
        break;

      case 'agent.stopped':
        this.agentStopped(session, agent, event);
        break;

      case 'turn.ended':
        this.turnEnded(session, agent, event);
        break;

      case 'background.ended':
        // Only for the agent told about it: the notice a spawner gets about a subagent says
        // "completed" when that subagent merely paused.
        agent.backgroundTaskIds.delete(event.taskId);
        break;

      case 'narration':
        this.narrated(session, agent, event);
        break;

      case 'message.received':
        this.heard(agent, event.at, { kind: 'message', text: event.text });
        break;

      case 'notice':
        this.heard(agent, event.at, { kind: 'notice', text: event.text });
        break;

      case 'usage':
        agent.contextTokens = event.contextTokens;
        break;

      case 'attention':
        this.attentionNeeded(session, agent, event);
        break;

      case 'compaction':
        this.journal.record(agent, event.at, { kind: 'compaction', trigger: event.trigger });
        break;

      case 'message.delivered':
        this.messageDelivered(session, event);
        break;

      case 'message.rejected':
        this.messageRejected(session, event);
        break;
    }
  }

  /** Something was said to the agent. It is recorded once, and does not wake a paused agent. */
  private heard(
    agent: AgentState,
    at: number,
    entry: { kind: 'message' | 'notice'; text: string },
  ): void {
    this.lifecycle.touch(agent, at, false);
    this.journal.recordOnce(agent, at, entry);
  }

  private sessionStarted(session: SessionState, event: EventOf<'session.started'>): void {
    if (event.cwd) {
      session.cwd = event.cwd;
    }

    // A path a hook reported is the session's own word; one found by searching is a guess.
    if (event.transcriptPath && (event.origin === 'hook' || !session.transcriptPath)) {
      session.transcriptPath = event.transcriptPath;
    }
  }

  private promptSubmitted(
    session: SessionState,
    agent: AgentState,
    event: EventOf<'prompt.submitted'>,
  ): void {
    this.lifecycle.touch(agent, event.at, true);

    if (agent.agentId === null) {
      this.mainAtWork(session, agent, event);
      session.attention = null;
      userSpoke(session, event.at);
    } else if (!agent.prompt) {
      agent.prompt = event.text;
    }

    this.journal.recordOnce(agent, event.at, { kind: 'prompt', text: event.text });
  }

  private toolStarted(
    session: SessionState,
    agent: AgentState,
    event: EventOf<'tool.started'>,
  ): void {
    // Both sources can report a call: the first report counts.
    if (session.calls.has(event.toolUseId) || session.endedCallIds.has(event.toolUseId)) {
      return;
    }

    this.lifecycle.touch(agent, event.at, true);

    if (agent.agentId === null) {
      agent.phase = 'working';
    }

    clearAttentionOf(session, agent);

    const call = newCall({ ...event, startedAt: event.at });

    this.lifecycle.startCall(session, agent, call);

    if (event.report) {
      agent.report = event.report;
    }

    if (event.spawn) {
      requestSpawn(session, agent, call.id, event.spawn, event.at);
    }

    this.journal.record(agent, event.at, { kind: 'tool', call });
  }

  private toolEnded(session: SessionState, agent: AgentState, event: EventOf<'tool.ended'>): void {
    const open = session.calls.get(event.toolUseId);

    if (!open && session.endedCallIds.has(event.toolUseId)) {
      return;
    }

    this.lifecycle.touch(agent, event.at, true);

    const call = open ?? this.callSeenFromItsEnd(agent, event);

    call.endedAt = event.at;
    call.outcome = event.ok ? 'ok' : 'failed';
    call.durationMs = event.durationMs ?? event.at - call.startedAt;
    call.result = event.result;
    call.tool ||= event.tool;
    this.lifecycle.endCall(session, agent, call);

    if (!event.ok) {
      agent.failureCount++;
    }

    clearAttentionOf(session, agent);

    if (event.backgroundTaskId) {
      agent.backgroundTaskIds.add(event.backgroundTaskId);
    }

    if (event.spawned) {
      this.spawnReturned(session, agent, call.id, event.spawned, event.at);
    } else {
      dropSpawns(session, (spawn) => spawn.toolUseId === call.id);
    }
  }

  /** A call whose start predates what this viewer saw is recorded from its end. */
  private callSeenFromItsEnd(agent: AgentState, event: EventOf<'tool.ended'>): ToolCall {
    const { toolUseId, tool } = event;
    const call = newCall({ toolUseId, tool, startedAt: event.at - (event.durationMs ?? 0) });

    agent.callCount++;
    agent.lastCall = call;
    this.journal.record(agent, call.startedAt, { kind: 'tool', call });

    return call;
  }

  /** An Agent call returned and named the agent it started. */
  private spawnReturned(
    session: SessionState,
    spawner: AgentState,
    toolUseId: string,
    spawned: SpawnResult,
    at: number,
  ): void {
    const agent = agentOf(session, spawned.agentId);

    describeSpawned(agent, spawned);

    const spawn = confirmSpawn(session, agent, toolUseId);

    if (agent.firstSeenAt === null) {
      // Known only from the call that started it: the call's start is the run's start.
      const startedAt = spawn?.at ?? at - (spawned.totalDurationMs ?? 0);

      agent.firstSeenAt = startedAt;
      agent.runStartedAt = startedAt;
      agent.lastEventAt = Math.max(agent.lastEventAt, startedAt);
    }

    if (spawned.completed) {
      this.lifecycle.finish(session, agent, at);
    } else if (isActive(agent)) {
      spawner.backgroundTaskIds.add(spawned.agentId);
    }
  }

  private agentStarted(
    session: SessionState,
    agent: AgentState,
    event: EventOf<'agent.started'>,
  ): void {
    if (agent.agentId === null) {
      return;
    }

    describeStarted(agent, event);

    if (agent.firstSeenAt === null) {
      agent.firstSeenAt = event.at;
      agent.runStartedAt = event.at;
      agent.lastEventAt = event.at;
      agent.activity.add(event.at);
      this.journal.record(agent, event.at, { kind: 'started', agentType: agent.type });
    } else if (agent.phase !== 'working') {
      this.lifecycle.touch(agent, event.at, true);
    } else if (agent.runStartedAt !== null && event.at < agent.runStartedAt) {
      // A second report of the same start: the earlier time is the truer one.
      agent.runStartedAt = event.at;
    }

    if (!agent.linked) {
      matchSpawn(session, agent);
    }
  }

  private agentStopped(
    session: SessionState,
    agent: AgentState,
    event: EventOf<'agent.stopped'>,
  ): void {
    const fromAnEarlierRun = agent.runStartedAt !== null && event.at < agent.runStartedAt;

    if (agent.agentId === null || fromAnEarlierRun) {
      return;
    }

    describeStopped(agent, event);

    // A spawn still unresolved when its spawner ends a turn was denied or lost.
    dropSpawns(session, (spawn) => spawn.parentAgentId === agent.agentId);

    if (event.interruptedBy) {
      this.lifecycle.interrupt(session, agent, event.at, event.interruptedBy);
    } else {
      this.lifecycle.pauseOrFinish(session, agent, event.at, event.runningTaskIds);
    }
  }

  private turnEnded(session: SessionState, main: AgentState, event: EventOf<'turn.ended'>): void {
    if (main.agentId !== null) {
      return;
    }

    main.lastEventAt = Math.max(main.lastEventAt, event.at);
    main.phase = 'idle';

    if (event.origin === 'hook') {
      session.status = 'idle';
    }

    if (event.runningTaskIds) {
      main.backgroundTaskIds.clear();

      for (const id of event.runningTaskIds) {
        main.backgroundTaskIds.add(id);
      }
    }

    this.lifecycle.closeOpenCalls(session, main, event.at);
    dropSpawns(session, (spawn) => spawn.parentAgentId === null);
    clearAttentionOf(session, main);

    if (event.text) {
      this.spoke(session, main, event.text, event.at);
    }

    closeReply(session, event.at);

    this.journal.record(main, event.at, { kind: 'turn-ended' });
  }

  private narrated(session: SessionState, agent: AgentState, event: EventOf<'narration'>): void {
    this.lifecycle.touch(agent, event.at, false);
    this.spoke(session, agent, event.text, event.at);
    this.journal.record(agent, event.at, { kind: 'narration', text: event.text });
  }

  /** What an agent said last. The main agent's words after a message are its reply to it. */
  private spoke(session: SessionState, agent: AgentState, text: string, at: number): void {
    // History can arrive after what is live: the last thing said is the latest, not the last told.
    if (at >= agent.lastNarrationAt) {
      agent.lastNarration = text;
      agent.lastNarrationAt = at;
    }

    if (agent.agentId === null) {
      noteReply(session, text, at);
    }
  }

  private attentionNeeded(
    session: SessionState,
    agent: AgentState,
    event: EventOf<'attention'>,
  ): void {
    const { at, level, text } = event;

    session.attention = { at, level, text, agentId: agent.agentId };
    this.journal.record(agent, at, { kind: 'attention', level, text });
  }

  private messageDelivered(session: SessionState, event: EventOf<'message.delivered'>): void {
    const sent = session.outbox.find((message) => message.nonce === event.nonce);

    if (sent) {
      sent.status = 'delivered';
      sent.deliveredAt = event.at;
      sent.via = event.via;
      startReply(session, sent);
    }

    this.journal.record(session.main, event.at, {
      kind: 'delivered',
      sender: event.sender,
      via: event.via,
      text: event.text,
    });
  }

  private messageRejected(session: SessionState, event: EventOf<'message.rejected'>): void {
    const { at, file, reason } = event;

    this.journal.reject({ at, sessionId: session.sessionId, file, reason });
    this.journal.record(session.main, at, { kind: 'rejected', file, reason });
  }

  /** Busy or idle is the session's live state: replayed history never sets it. */
  private mainAtWork(session: SessionState, main: AgentState, event: WatchEvent): void {
    main.phase = 'working';

    if (event.origin === 'hook') {
      session.status = 'busy';
    }
  }
}

/**
 * A stop for an agent the session has never shown changes nothing. Claude Code runs internal
 * helper agents (prompt suggestions) that report a stop with no type and no start, and history
 * reports the end of agents that were over before this viewer opened.
 */
function isStopOfUnknownAgent(session: SessionState, event: WatchEvent): boolean {
  if (event.kind !== 'agent.stopped' || event.agentId === null) {
    return false;
  }

  const unknown = !session.agents.has(event.agentId);

  return unknown && (!event.agentType || event.origin === 'transcript');
}

function newCall(event: {
  toolUseId: string;
  tool: string;
  summary?: string;
  detail?: string;
  startedAt: number;
}): ToolCall {
  return {
    id: event.toolUseId,
    tool: event.tool,
    summary: event.summary ?? '',
    detail: event.detail ?? '',
    startedAt: event.startedAt,
    endedAt: null,
    outcome: 'running',
    durationMs: null,
    result: '',
  };
}

/** Whatever the agent was waiting on the user for has been answered or is over. */
function clearAttentionOf(session: SessionState, agent: AgentState): void {
  if (session.attention?.agentId === agent.agentId) {
    session.attention = null;
  }
}

function describeStarted(agent: AgentState, event: EventOf<'agent.started'>): void {
  agent.type = event.agentType || agent.type;
  agent.prompt = event.prompt || agent.prompt;
  agent.model = event.model || agent.model;
  agent.parentAgentId = event.parentAgentId || agent.parentAgentId;

  if (event.description) {
    agent.description = event.description;
    agent.linked = true;
  }
}

function describeStopped(agent: AgentState, event: EventOf<'agent.stopped'>): void {
  agent.type = event.agentType || agent.type;
  agent.report = event.report || agent.report;
  agent.transcriptPath = event.transcriptPath || agent.transcriptPath;
  agent.firstSeenAt ??= event.at;
  agent.runStartedAt ??= event.at;
  agent.lastEventAt = Math.max(agent.lastEventAt, event.at);
}

function describeSpawned(agent: AgentState, spawned: SpawnResult): void {
  agent.type = spawned.agentType || agent.type;
  agent.model = spawned.model || agent.model;

  if (spawned.totalTokens !== undefined) {
    agent.totals = {
      tokens: spawned.totalTokens,
      durationMs: spawned.totalDurationMs,
      toolUses: spawned.toolUseCount,
    };
  }
}
