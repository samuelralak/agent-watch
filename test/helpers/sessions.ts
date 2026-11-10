import type { OutboxMessage, SessionListing } from '../../src/domain/session.js';
import type { Store } from '../../src/domain/store.js';
import { event } from './events.js';

export const listing = (
  sessionId: string,
  extra: Partial<SessionListing> = {},
): SessionListing => ({
  sessionId,
  name: sessionId,
  status: 'idle',
  ...extra,
});

/** A subagent of session `S` that has started, with a task. */
export function startAgent(
  store: Store,
  agentId: string,
  at: number,
  fields: { description?: string; prompt?: string; sessionId?: string } = {},
): void {
  store.apply(
    event('agent.started', at, {
      sessionId: fields.sessionId ?? 'S',
      agentId,
      agentType: 'general-purpose',
      description: fields.description ?? `agent ${agentId}`,
      prompt: fields.prompt ?? '',
    }),
  );
}

/** One finished tool call, in session `S` unless said otherwise. */
export function call(
  store: Store,
  at: number,
  fields: {
    agentId: string | null;
    id: string;
    tool: string;
    summary: string;
    result?: string;
    sessionId?: string;
  },
): void {
  const { agentId, id, tool, summary, result = '', sessionId = 'S' } = fields;

  store.apply(event('tool.started', at, { sessionId, agentId, toolUseId: id, tool, summary }));

  store.apply(
    event('tool.ended', at + 100, { sessionId, agentId, toolUseId: id, tool, ok: true, result }),
  );
}

let nonces = 0;

/** A message as the viewer's outbox holds it right after sending. */
export function outboxMessage(text: string, createdAt: number): OutboxMessage {
  return {
    nonce: (++nonces).toString(16).padStart(32, '0'),
    text,
    createdAt,
    expiresAt: createdAt + 3_600_000,
    aboutAgentId: null,
    aboutLabel: null,
    woke: false,
    status: 'queued',
    deliveredAt: null,
    via: null,
    replies: [],
  };
}
