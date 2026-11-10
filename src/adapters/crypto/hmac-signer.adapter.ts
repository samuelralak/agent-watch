import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  MessageSignerPort,
  MessageVerifierPort,
  ReceiptSignerPort,
} from '../../application/ports/message-signer.port.js';
import { type MessageFields, type SignedMessage, signingInput } from '../../domain/message.js';

const ALG = 'hmac-sha256';
const KEY_BYTES = 32;

/**
 * Signs with a key kept in a file only the user can read.
 *
 * Any program running as the user can read that file, so this stops a message file that was
 * merely dropped in the inbox, not a program that deliberately reads the key.
 */
export class HmacSigner implements MessageSignerPort, MessageVerifierPort, ReceiptSignerPort {
  private constructor(private readonly key: Buffer) {}

  /** Loads the key, creating it on first use. */
  static load(keyPath: string): HmacSigner {
    return new HmacSigner(HmacSigner.read(keyPath) ?? HmacSigner.create(keyPath));
  }

  /** Loads the key if there is one. Hooks never create it: with no key, nothing verifies. */
  static loadExisting(keyPath: string): HmacSigner | null {
    const key = HmacSigner.read(keyPath);

    return key ? new HmacSigner(key) : null;
  }

  sign(fields: MessageFields): SignedMessage {
    return { ...fields, alg: ALG, sig: this.mac(signingInput(fields)) };
  }

  verify(message: SignedMessage): boolean {
    return message.alg === ALG && this.matches(this.mac(signingInput(message)), message.sig);
  }

  signReceipt(fields: readonly (string | null)[]): string {
    return this.mac(`receipt:${JSON.stringify(fields)}`);
  }

  verifyReceipt(fields: readonly (string | null)[], mac: string | undefined): boolean {
    return mac !== undefined && this.matches(this.signReceipt(fields), mac);
  }

  private mac(input: string): string {
    return createHmac('sha256', this.key).update(input).digest('hex');
  }

  private matches(expected: string, given: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(given)) {
      return false;
    }

    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'));
  }

  private static read(keyPath: string): Buffer | null {
    try {
      const key = readFileSync(keyPath);

      return key.length === KEY_BYTES ? key : null; // a key of another length is not ours
    } catch {
      return null;
    }
  }

  private static create(keyPath: string): Buffer {
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });

    const key = randomBytes(KEY_BYTES);

    try {
      writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });

      return key;
    } catch (error) {
      // Another process created it first.
      const existing = HmacSigner.read(keyPath);

      if (existing) {
        return existing;
      }

      throw error;
    }
  }
}
