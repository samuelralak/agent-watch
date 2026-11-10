import {
  MESSAGE_LIFETIME_MS,
  MESSAGE_TEXT_LIMIT,
  type MessageFields,
  type MessageSender,
} from '../domain/message.js';
import type { OutboxMessage } from '../domain/session.js';
import type { InboxPort } from './ports/inbox.port.js';
import type { MessageSignerPort } from './ports/message-signer.port.js';

export interface SendMessageInput {
  readonly sessionId: string;
  readonly text: string;
  readonly sender?: MessageSender;
  /** The subagent the user was looking at, so the main agent knows what the message is about. */
  readonly aboutAgentId?: string | null;
  readonly aboutLabel?: string | null;
}

export interface SendMessageDeps {
  readonly signer: MessageSignerPort;
  readonly inbox: InboxPort;
  readonly newNonce: () => string;
  readonly now?: () => number;
}

/** Signs a message and leaves it in the session's inbox for that session's hooks. */
export class SendMessageService {
  private readonly now: () => number;

  constructor(private readonly deps: SendMessageDeps) {
    this.now = deps.now ?? Date.now;
  }

  async send(input: SendMessageInput): Promise<OutboxMessage> {
    const text = input.text.trim();

    if (!text) {
      throw new Error('the message is empty');
    }

    // Cutting it would send something the sender did not write.
    if (text.length > MESSAGE_TEXT_LIMIT) {
      throw new Error(`the message is longer than ${MESSAGE_TEXT_LIMIT} characters`);
    }

    const createdAt = this.now();

    const fields: MessageFields = {
      v: 2,
      session: input.sessionId,
      target: 'main',
      sender: input.sender ?? 'user',
      aboutAgentId: input.aboutAgentId ?? null,
      aboutLabel: input.aboutLabel ?? null,
      nonce: this.deps.newNonce(),
      createdAt,
      expiresAt: createdAt + MESSAGE_LIFETIME_MS,
      text,
    };

    const woke = this.deps.inbox.put(await this.deps.signer.sign(fields));

    return {
      nonce: fields.nonce,
      text,
      createdAt,
      expiresAt: fields.expiresAt,
      aboutAgentId: fields.aboutAgentId,
      aboutLabel: fields.aboutLabel,
      woke,
      status: 'queued',
      deliveredAt: null,
      via: null,
      replies: [],
    };
  }
}
