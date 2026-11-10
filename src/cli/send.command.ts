import type { InboxPort } from '../application/ports/inbox.port.js';
import type { MessageSignerPort } from '../application/ports/message-signer.port.js';
import type { SessionListPort } from '../application/ports/session-list.port.js';
import { SendMessageService } from '../application/send-message.service.js';
import type { Trust } from '../domain/sending.policy.js';
import type { SessionListing } from '../domain/session.js';
import type { SendOptions } from './options.js';

const PREVIEW_LENGTH = 120;

/** A signer that holds a helper process, to be let go once the message is signed. */
export type ClosableSigner = MessageSignerPort & { close(): void };

export interface SendCommandDeps {
  readonly sessionList: Pick<SessionListPort, 'list'>;
  /** Whether sending is locked, and what agents may send. */
  readonly trust: Trust;
  readonly inbox: InboxPort;
  /** Signs with the key kept in a file: enough where agents may send freely. */
  readonly sharedKey: MessageSignerPort;
  /** Signs with the user's fingerprint, asking for this one message with `reason`. */
  readonly approver: (reason: string) => ClosableSigner;
  readonly newNonce: () => string;
  readonly write: (line: string) => void;
}

/**
 * `agentwatch send`: how an agent sends a message to another session. What it sends is always
 * delivered as an agent's message, never as the user's. Returns the process exit code.
 */
export async function runSendCommand(options: SendOptions, deps: SendCommandDeps): Promise<number> {
  if (deps.trust.agentSends === 'off') {
    deps.write('Not sent: agents may not send messages on this machine (agentwatch lock status).');

    return 1;
  }

  const { sessions } = await deps.sessionList.list();
  const session = findSession(sessions, options.session);

  if (typeof session === 'string') {
    deps.write(`Not sent: ${session}.`);

    return 1;
  }

  return deliver(options, session, deps);
}

async function deliver(
  options: SendOptions,
  session: SessionListing,
  deps: SendCommandDeps,
): Promise<number> {
  const name = session.name ?? session.sessionId;

  const approver =
    deps.trust.agentSends === 'approve' ? deps.approver(approval(name, options.text)) : null;

  const sender = new SendMessageService({
    signer: approver ?? deps.sharedKey,
    inbox: deps.inbox,
    newNonce: deps.newNonce,
  });

  try {
    const sent = await sender.send({
      sessionId: session.sessionId,
      text: options.text,
      sender: 'agent',
      aboutAgentId: options.aboutAgentId,
    });

    const when = sent.woke
      ? 'it is being woken now'
      : 'it arrives at its next tool call or turn end';

    deps.write(`Queued for ${name}: ${when}. It is delivered as a message from an agent.`);

    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    deps.write(`Not sent: ${reason.replace(/\.$/, '')}.`);

    return 1;
  } finally {
    approver?.close();
  }
}

/** What the fingerprint prompt says. macOS puts "… is trying to" before it. */
function approval(session: string, text: string): string {
  const preview = text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;

  return `let an agent send this message to ${session}: "${preview}"`;
}

/** The one running session `wanted` names, or why there is not exactly one. */
function findSession(sessions: readonly SessionListing[], wanted: string): SessionListing | string {
  const exact = sessions.find((session) => session.sessionId === wanted);

  if (exact) {
    return exact;
  }

  const matches = sessions.filter(
    (session) => session.sessionId.startsWith(wanted) || session.name === wanted,
  );

  if (matches.length === 1 && matches[0]) {
    return matches[0];
  }

  if (matches.length === 0) {
    return `no running session matches "${wanted}"`;
  }

  const names = matches.map((session) => `${session.name ?? '?'} (${session.sessionId})`);

  return `"${wanted}" matches several sessions: ${names.join(', ')}`;
}
