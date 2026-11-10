import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { MessageSignerPort } from '../../application/ports/message-signer.port.js';
import { type MessageFields, type SignedMessage, signingInput } from '../../domain/message.js';
import { P256_ALG } from '../crypto/p256-verifier.adapter.js';

const replySchema = z.object({
  id: z.number(),
  signature: z.string().optional(),
  error: z.string().optional(),
});

export interface EnclaveSignerOptions {
  /** The compiled helper (`native/agentwatch-signer.swift`). */
  readonly helper: string;
  /** The file holding the reference to the user's key. */
  readonly keyFile: string;
  /** What the fingerprint prompt says for a message. */
  readonly reason: (fields: MessageFields) => string;
  /** Ask for a fingerprint for every message, instead of once for the life of this signer. */
  readonly approveEach?: boolean;
}

interface Waiting {
  readonly resolve: (signature: string) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Signs with the user's fingerprint key. The key never leaves the Secure Enclave: a helper
 * process asks it to sign, and macOS asks the user for a touch. One helper serves one signer,
 * so one touch covers every message sent from one agentwatch window.
 */
export class EnclaveSigner implements MessageSignerPort {
  private helper: ChildProcess | null = null;
  private readonly waiting = new Map<number, Waiting>();
  private lastId = 0;

  constructor(private readonly options: EnclaveSignerOptions) {}

  sign(fields: MessageFields): Promise<SignedMessage> {
    const id = ++this.lastId;

    const request = {
      id,
      data: Buffer.from(signingInput(fields)).toString('base64'),
      reason: this.options.reason(fields),
      approve: this.options.approveEach === true,
    };

    return new Promise((resolve, reject) => {
      this.waiting.set(id, {
        reject,
        resolve: (signature) => resolve({ ...fields, alg: P256_ALG, sig: signature }),
      });

      this.running().stdin?.write(`${JSON.stringify(request)}\n`);
    });
  }

  /** Lets the helper go. The next message would start a new one, and ask for a touch again. */
  close(): void {
    this.helper?.stdin?.end();
    this.helper = null;
  }

  /** The helper process, started on first use. */
  private running(): ChildProcess {
    if (this.helper) {
      return this.helper;
    }

    const helper = spawn(this.options.helper, ['sign', this.options.keyFile], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this.helper = helper;

    helper.on('error', (error) =>
      this.stopped(helper, `the signing helper failed: ${error.message}`),
    );

    helper.on('exit', () => this.stopped(helper, 'the signing helper stopped'));
    helper.stdin?.on('error', () => {}); // a helper that died is reported by its exit

    if (helper.stdout) {
      createInterface({ input: helper.stdout }).on('line', (line) => this.answered(line));
    }

    return helper;
  }

  private answered(line: string): void {
    const reply = parseReply(line);
    const waiting = reply ? this.waiting.get(reply.id) : undefined;

    if (!reply || !waiting) {
      return;
    }

    this.waiting.delete(reply.id);

    if (reply.signature) {
      waiting.resolve(reply.signature);
    } else {
      waiting.reject(new Error(reply.error || 'the signing helper gave no signature'));
    }
  }

  /** The helper is gone: nothing still waiting on it will be answered. */
  private stopped(helper: ChildProcess, reason: string): void {
    if (this.helper === helper) {
      this.helper = null;
    }

    for (const waiting of this.waiting.values()) {
      waiting.reject(new Error(reason));
    }

    this.waiting.clear();
  }
}

function parseReply(line: string): z.infer<typeof replySchema> | null {
  try {
    return replySchema.parse(JSON.parse(line));
  } catch {
    return null;
  }
}
