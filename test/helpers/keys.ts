import { generateKeyPairSync, sign } from 'node:crypto';
import { P256_ALG } from '../../src/adapters/crypto/p256-verifier.adapter.js';
import { type MessageFields, type SignedMessage, signingInput } from '../../src/domain/message.js';

/**
 * A P-256 key pair standing in for the user's fingerprint key. The real one lives in the Secure
 * Enclave and signs only after a touch; what it produces has exactly this form.
 */
export function fingerprintKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  return {
    /** The public half, as the Secure Enclave exports it. */
    publicKey: publicKey.export({ type: 'spki', format: 'der' }),
    sign(fields: MessageFields): SignedMessage {
      const signature = sign('sha256', Buffer.from(signingInput(fields)), privateKey);

      return { ...fields, alg: P256_ALG, sig: signature.toString('base64') };
    },
  };
}
