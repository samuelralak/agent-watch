/**
 * Locking and unlocking sending. The compiler and `sudo` are stood in for, so these tests show
 * exactly which commands would run as root, and that the pieces they leave fit together.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EnclaveSigner } from '../../src/adapters/enclave/enclave-signer.adapter.js';
import { LockSetup, LockSetupError } from '../../src/adapters/lock/lock-setup.js';
import { lockFiles, SystemLock } from '../../src/adapters/lock/system-lock.adapter.js';
import { runLockCommand } from '../../src/cli/lock.command.js';
import { FAKE_HELPER, ME, pretendToRun } from '../helpers/lock.js';
import { temporaryState } from '../helpers/state.js';

function setup(
  options: { refuse?: (command: string) => boolean; platform?: NodeJS.Platform } = {},
) {
  const paths = temporaryState();
  const commands: string[] = [];
  const lock = new SystemLock(paths.lockDir, ME);

  const lockSetup = new LockSetup({
    paths,
    lock,
    signerSource: FAKE_HELPER,
    run: pretendToRun(commands, options.refuse),
    platform: options.platform ?? 'darwin',
  });

  return {
    paths,
    commands,
    lock,
    lockSetup,
    asRoot: () => commands.filter((c) => c.startsWith('sudo')),
  };
}

describe('locking sending', () => {
  it('builds the helper, makes a key, and runs three commands as root that touch only its folder', () => {
    const { paths, lockSetup, asRoot } = setup();
    const files = lockFiles(paths.lockDir);

    expect(lockSetup.status()).toEqual({ locked: false, agentSends: 'free', ready: false });

    expect(lockSetup.enable('approve')).toEqual({
      locked: true,
      agentSends: 'approve',
      ready: true,
    });

    expect(asRoot()).toEqual([
      `sudo /usr/bin/install -d -o root -g wheel -m 755 ${paths.lockDir}`,
      `sudo /usr/bin/install -o root -g wheel -m 644 ${paths.fingerprintPublicKey} ${files.publicKey}`,
      `sudo /usr/bin/install -o root -g wheel -m 644 ${paths.stateDir}/lock-policy.json ${files.policy}`,
    ]);

    expect(JSON.parse(readFileSync(files.policy, 'utf8'))).toEqual({ agentSends: 'approve' });
  });

  it('leaves a key the hooks can check: what it signs passes, and nothing else does', async () => {
    const { paths, lock, lockSetup } = setup();

    lockSetup.enable('off');

    const signer = new EnclaveSigner({
      helper: paths.signer,
      keyFile: paths.fingerprintKey,
      reason: () => 'send your message',
    });

    const signed = await signer.sign(aMessage());

    signer.close();
    expect(lock.fingerprintKey()?.verify(signed)).toBe(true);
    expect(lock.fingerprintKey()?.verify({ ...signed, sender: 'agent' })).toBe(false);
  });

  it('changes what agents may send without making a new key or building again', () => {
    const { paths, commands, lockSetup } = setup();

    lockSetup.enable('off');

    const key = readFileSync(paths.fingerprintKey, 'utf8');
    const builds = commands.filter((command) => command.startsWith('swiftc')).length;

    expect(lockSetup.enable('free')).toMatchObject({ locked: true, agentSends: 'free' });
    expect(readFileSync(paths.fingerprintKey, 'utf8')).toBe(key);
    expect(commands.filter((command) => command.startsWith('swiftc'))).toHaveLength(builds);
  });

  it('locks nothing when sudo is refused', () => {
    const { lockSetup } = setup({ refuse: (command) => command.startsWith('sudo') });

    expect(() => lockSetup.enable('approve')).toThrow(LockSetupError);
    expect(lockSetup.status().locked).toBe(false);
  });

  it('says what is missing when the helper cannot be built', () => {
    const { lockSetup, asRoot } = setup({ refuse: (command) => command.startsWith('swiftc') });

    expect(() => lockSetup.enable('approve')).toThrow(/Xcode command-line tools/);
    expect(asRoot()).toEqual([]);
  });

  it('is refused where there is no Secure Enclave to keep the key in', () => {
    const { lockSetup, commands } = setup({ platform: 'linux' });

    expect(() => lockSetup.enable('approve')).toThrow(/needs a Mac/);
    expect(commands).toEqual([]);
  });
});

describe('what the lock command says', () => {
  const said = (lockSetup: LockSetup, action: 'enable' | 'status'): string => {
    const lines: string[] = [];

    runLockCommand(
      { command: 'lock', action, agentSends: 'approve' },
      { setup: lockSetup, write: (line) => lines.push(line) },
    );

    return lines.join('\n');
  };

  it('says what a lock stops and what it does not, whenever it reports one', () => {
    const { lockSetup } = setup();

    expect(said(lockSetup, 'status')).toContain('Sending is not locked');

    for (const action of ['enable', 'status'] as const) {
      const text = said(lockSetup, action);

      expect(text).toContain('Sending is locked');
      expect(text).toContain('What this stops: a program forging your messages');

      expect(text).toContain(
        "What it does not stop: a program that rewrites agentwatch's own hook",
      );
    }
  });
});

describe('unlocking sending', () => {
  it('removes only the two files of the lock and its folder, and forgets the key', () => {
    const { paths, lockSetup, asRoot } = setup();
    const files = lockFiles(paths.lockDir);

    lockSetup.enable('free');
    expect(lockSetup.disable()).toMatchObject({ locked: false, agentSends: 'free' });

    expect(asRoot().slice(-2)).toEqual([
      `sudo /bin/rm -f ${files.publicKey} ${files.policy}`,
      `sudo /bin/rmdir ${paths.lockDir}`,
    ]);

    expect(existsSync(paths.lockDir)).toBe(false);
    expect(existsSync(paths.fingerprintKey)).toBe(false);
  });

  it('says sending is still locked when sudo is refused', () => {
    const state = { locked: false };

    const { lockSetup } = setup({
      refuse: (command) => state.locked && command.startsWith('sudo'),
    });

    lockSetup.enable('free');
    state.locked = true;
    expect(() => lockSetup.disable()).toThrow(/still locked/);
    expect(lockSetup.status().locked).toBe(true);
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
