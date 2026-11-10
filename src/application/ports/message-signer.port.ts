import type { MessageFields, SignedMessage } from '../../domain/message.js';

/**
 * Signs messages the user sends. Signing may take a while: a key that needs the user's
 * fingerprint answers only once they have touched the sensor.
 */
export interface MessageSignerPort {
  sign(fields: MessageFields): SignedMessage | Promise<SignedMessage>;
}

/** Checks that a message was signed by the user's signer, on the receiving side. */
export interface MessageVerifierPort {
  verify(message: SignedMessage): boolean;
}

/** Signs and checks the delivery hook's receipts, so the viewer can trust "delivered". */
export interface ReceiptSignerPort {
  signReceipt(fields: readonly (string | null)[]): string;
  verifyReceipt(fields: readonly (string | null)[], mac: string | undefined): boolean;
}
