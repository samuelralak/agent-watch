import type { MessageSender } from './message.js';

/**
 * How messages that agents send through agentwatch are treated: refused, delivered only when
 * the user approved that one message with their fingerprint, or delivered as they come.
 */
export type AgentSends = 'off' | 'approve' | 'free';

/** What the receiving side goes by when deciding whether to hand a message over. */
export interface Trust {
  /** Sending is locked: the user's messages must be signed with their fingerprint. */
  readonly locked: boolean;
  readonly agentSends: AgentSends;
}

/** Without a lock every message is signed with the key agentwatch keeps in a file. */
export const UNLOCKED: Trust = { locked: false, agentSends: 'free' };

/**
 * What a message's signature proves: that the user touched the sensor for it, that it was made
 * with the key agentwatch keeps in a file (which any program running as the user can read), or
 * nothing.
 */
export type Proof = 'fingerprint' | 'shared-key' | 'none';

/** Why a message may not be delivered, or null when it may. */
export function refusal(sender: MessageSender, proof: Proof, trust: Trust): string | null {
  if (proof === 'none') {
    return 'signature does not match';
  }

  return sender === 'user' ? userRefusal(proof, trust) : agentRefusal(proof, trust);
}

function userRefusal(proof: Proof, trust: Trust): string | null {
  if (trust.locked && proof !== 'fingerprint') {
    return "sending is locked: the user's messages need their fingerprint";
  }

  return null;
}

function agentRefusal(proof: Proof, trust: Trust): string | null {
  if (trust.agentSends === 'off') {
    return 'agents may not send messages here';
  }

  if (trust.agentSends === 'approve' && proof !== 'fingerprint') {
    return "an agent's message needs the user's approval";
  }

  return null;
}
