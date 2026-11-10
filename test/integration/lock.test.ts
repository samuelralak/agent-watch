/**
 * The lock on sending: a folder only its owner can write, read by every hook. In these tests
 * the trusted owner is whoever runs them; on a real machine it is root.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lockFiles, SystemLock } from '../../src/adapters/lock/system-lock.adapter.js';
import { UNLOCKED } from '../../src/domain/sending.policy.js';
import { fingerprintKey } from '../helpers/keys.js';
import { temporaryState } from '../helpers/state.js';

const ME = process.getuid?.() ?? 0;
const SOMEONE_ELSE = ME + 1;

function lockFolder(options: { policy?: string; publicKey?: Buffer } = {}) {
  const { lockDir } = temporaryState();
  const files = lockFiles(lockDir);
  const key = fingerprintKey();

  mkdirSync(lockDir, { recursive: true, mode: 0o755 });
  writeFileSync(files.publicKey, options.publicKey ?? key.publicKey, { mode: 0o644 });

  if (options.policy !== undefined) {
    writeFileSync(files.policy, options.policy, { mode: 0o644 });
  }

  return { lockDir, files, key };
}

describe('the lock on sending', () => {
  it('is off on a machine where it was never set up', () => {
    const lock = new SystemLock(temporaryState().lockDir, ME);

    expect(lock.isLocked).toBe(false);
    expect(lock.trust()).toEqual(UNLOCKED);
    expect(lock.fingerprintKey()).toBeNull();
  });

  it("is on once its folder holds the user's public key, with the policy it names", () => {
    const { lockDir, key } = lockFolder({ policy: '{"agentSends":"approve"}' });
    const lock = new SystemLock(lockDir, ME);
    const message = key.sign(aMessage());

    expect(lock.trust()).toEqual({ locked: true, agentSends: 'approve' });
    expect(lock.fingerprintKey()?.verify(message)).toBe(true);
    expect(lock.fingerprintKey()?.verify({ ...message, text: 'something else' })).toBe(false);
  });

  it('lets agents send nothing when its policy is missing or cannot be read', () => {
    for (const policy of [undefined, 'not json', '{"agentSends":"always"}', '[]']) {
      const { lockDir } = lockFolder({ policy });

      expect(new SystemLock(lockDir, ME).trust(), String(policy)).toEqual({
        locked: true,
        agentSends: 'off',
      });
    }
  });

  it('is not trusted when someone other than its owner could have written it', () => {
    const owned = lockFolder({ policy: '{"agentSends":"free"}' });

    expect(new SystemLock(owned.lockDir, SOMEONE_ELSE).isLocked).toBe(false);

    const writableFolder = lockFolder();

    chmodSync(writableFolder.lockDir, 0o777);
    expect(new SystemLock(writableFolder.lockDir, ME).isLocked).toBe(false);

    const writableKey = lockFolder();

    chmodSync(writableKey.files.publicKey, 0o666);
    expect(new SystemLock(writableKey.lockDir, ME).isLocked).toBe(false);
  });

  it('ignores a policy file others could have written, and allows agents nothing', () => {
    const { lockDir, files } = lockFolder({ policy: '{"agentSends":"free"}' });

    chmodSync(files.policy, 0o666);
    expect(new SystemLock(lockDir, ME).trust()).toEqual({ locked: true, agentSends: 'off' });
  });

  it('checks nothing with a file that is not a public key', () => {
    const { lockDir } = lockFolder({ publicKey: Buffer.from('not a key') });
    const lock = new SystemLock(lockDir, ME);

    expect(lock.fingerprintKey()).toBeNull();
  });
});

function aMessage() {
  return {
    v: 2 as const,
    session: 'aaaaaaaa-1111-2222-3333-444444444444',
    target: 'main' as const,
    sender: 'user' as const,
    aboutAgentId: null,
    aboutLabel: null,
    nonce: 'c'.repeat(32),
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_000_060_000,
    text: 'use the staging database',
  };
}
