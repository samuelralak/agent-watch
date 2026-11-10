import type { DeliveryPath } from '../domain/event.js';
import { frameMessage, type SignedMessage } from '../domain/message.js';
import { type Proof, refusal, type Trust } from '../domain/sending.policy.js';
import type { InboxPort } from './ports/inbox.port.js';
import type { MessageVerifierPort } from './ports/message-signer.port.js';
import type { ReceiptWriterPort } from './ports/receipt-writer.port.js';

/** A hook's output is read through a pipe: more than this in one go is not delivered whole. */
const OUTPUT_LIMIT_BYTES = 48 * 1024;
const SEPARATOR = '\n\n---\n\n';

export interface DeliverMessagesDeps {
  readonly inbox: InboxPort;
  /** Checks the key agentwatch keeps in a file. Null when this machine has none. */
  readonly sharedKey: MessageVerifierPort | null;
  /** Checks the user's fingerprint key. Null unless sending is locked. */
  readonly fingerprintKey: MessageVerifierPort | null;
  /** Whether sending is locked, and what agents may send. */
  readonly trust: Trust;
  readonly receipts: ReceiptWriterPort;
  readonly now?: () => number;
}

/**
 * The receiving side, run by a session's own hooks: takes the messages waiting for the session
 * and hands over only those whose sender can be trusted, that are addressed to it, unexpired
 * and not delivered before.
 */
export class DeliverMessagesService {
  private readonly now: () => number;

  constructor(private readonly deps: DeliverMessagesDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The text for the session's main agent, or null when nothing valid was waiting. */
  deliver(sessionId: string, via: DeliveryPath): string | null {
    const { inbox, receipts } = this.deps;
    const parts: string[] = [];
    let bytes = 0;

    for (const claimed of inbox.claim(sessionId)) {
      const reason = this.refusal(sessionId, claimed.message);

      if (reason || !claimed.message) {
        claimed.reject();
        receipts.rejected(sessionId, claimed.file, reason ?? 'unreadable');
        continue;
      }

      const framed = frameMessage(claimed.message);
      const size = Buffer.byteLength(framed) + SEPARATOR.length;

      if (parts.length > 0 && bytes + size > OUTPUT_LIMIT_BYTES) {
        claimed.putBack(); // delivered by the session's next hook
        continue;
      }

      inbox.rememberDelivered(sessionId, claimed.message.nonce);
      claimed.discard();
      receipts.delivered(sessionId, claimed.message, via);
      parts.push(framed);
      bytes += size;
    }

    return parts.length > 0 ? parts.join(SEPARATOR) : null;
  }

  private refusal(sessionId: string, message: SignedMessage | null): string | null {
    if (!message) {
      return 'unreadable';
    }

    const untrusted = this.untrusted(message);

    if (untrusted) {
      return untrusted;
    }

    if (message.session !== sessionId) {
      return 'addressed to another session';
    }

    if (!(message.expiresAt > this.now())) {
      return 'expired';
    }

    if (this.deps.inbox.wasDelivered(sessionId, message.nonce)) {
      return 'already delivered once (replay)';
    }

    return null;
  }

  /** Why the message's sender cannot be taken at its word, or null when it can. */
  private untrusted(message: SignedMessage): string | null {
    const { sharedKey, fingerprintKey, trust } = this.deps;

    if (!sharedKey && !fingerprintKey) {
      return 'no agentwatch key on this machine';
    }

    return refusal(message.sender, this.proofOf(message), trust);
  }

  private proofOf(message: SignedMessage): Proof {
    if (this.deps.fingerprintKey?.verify(message)) {
      return 'fingerprint';
    }

    return this.deps.sharedKey?.verify(message) ? 'shared-key' : 'none';
  }
}
