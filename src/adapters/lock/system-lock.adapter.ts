import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { MessageVerifierPort } from '../../application/ports/message-signer.port.js';
import { type Trust, UNLOCKED } from '../../domain/sending.policy.js';
import { P256Verifier } from '../crypto/p256-verifier.adapter.js';

const ROOT = 0;
const WRITABLE_BY_OTHERS = 0o022;

const policySchema = z.object({ agentSends: z.enum(['off', 'approve', 'free']) });

/** The files of a lock, inside its folder. */
export const lockFiles = (dir: string) => ({
  publicKey: join(dir, 'public-key.der'),
  policy: join(dir, 'policy.json'),
  signer: join(dir, 'agentwatch-signer'),
});

/**
 * The lock on sending: a folder only root can write, holding the public half of the user's
 * fingerprint key and the policy for messages sent by agents. Programs running as the user can
 * read it and cannot change it, so what it says can be trusted by the hooks.
 */
export class SystemLock {
  private readonly files: ReturnType<typeof lockFiles>;

  /** `owner` is who must own the folder and its files: root, except in tests. */
  constructor(
    private readonly dir: string,
    private readonly owner = ROOT,
  ) {
    this.files = lockFiles(dir);
  }

  get isLocked(): boolean {
    return this.publicKey() !== null;
  }

  /** What the receiving side goes by. With no lock, or one that cannot be trusted: unlocked. */
  trust(): Trust {
    if (!this.isLocked) {
      return UNLOCKED;
    }

    return { locked: true, agentSends: this.agentSends() };
  }

  /** Checks signatures made with the user's fingerprint key; null when sending is not locked. */
  fingerprintKey(): MessageVerifierPort | null {
    const publicKey = this.publicKey();

    try {
      return publicKey ? new P256Verifier(publicKey) : null;
    } catch {
      return null; // not a public key
    }
  }

  private publicKey(): Buffer | null {
    return this.isProtected(this.dir) ? this.readProtected(this.files.publicKey) : null;
  }

  /** A policy that is missing or unreadable allows nothing. */
  private agentSends(): Trust['agentSends'] {
    try {
      const policy = this.readProtected(this.files.policy);

      return policy ? policySchema.parse(JSON.parse(policy.toString('utf8'))).agentSends : 'off';
    } catch {
      return 'off';
    }
  }

  private readProtected(path: string): Buffer | null {
    try {
      return this.isProtected(path) ? readFileSync(path) : null;
    } catch {
      return null;
    }
  }

  /** Owned by the trusted owner, and writable by nobody else. */
  private isProtected(path: string): boolean {
    try {
      const { uid, mode } = statSync(path);

      return uid === this.owner && (mode & WRITABLE_BY_OTHERS) === 0;
    } catch {
      return false;
    }
  }
}
