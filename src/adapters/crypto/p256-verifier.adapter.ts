import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import type { MessageVerifierPort } from '../../application/ports/message-signer.port.js';
import { type SignedMessage, signingInput } from '../../domain/message.js';

/** ECDSA over P-256 with SHA-256: what a Secure Enclave key signs with. */
export const P256_ALG = 'ecdsa-p256-sha256';

/**
 * Checks signatures made with the user's fingerprint key, against its public half. The private
 * half never leaves the Secure Enclave, so a valid signature means the sensor was touched.
 */
export class P256Verifier implements MessageVerifierPort {
  private readonly key: KeyObject;

  /** `publicKey` is the key as the Secure Enclave exports it (DER, SubjectPublicKeyInfo). */
  constructor(publicKey: Buffer) {
    this.key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
  }

  verify(message: SignedMessage): boolean {
    if (message.alg !== P256_ALG) {
      return false;
    }

    try {
      const signature = Buffer.from(message.sig, 'base64');

      return verify('sha256', Buffer.from(signingInput(message)), this.key, signature);
    } catch {
      return false; // not a signature at all
    }
  }
}
