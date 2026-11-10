import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AgentSends, Trust } from '../../domain/sending.policy.js';
import type { StatePaths } from '../fs/state-paths.js';
import { lockFiles, SystemLock } from './system-lock.adapter.js';

const createdKeySchema = z.object({ key: z.string().min(1), publicKey: z.string().min(1) });

/** Runs a command with the terminal attached, so `sudo` can ask for a password. */
export type CommandRunner = (command: string, args: readonly string[]) => boolean;

const runAttached: CommandRunner = (command, args) =>
  spawnSync(command, [...args], { stdio: 'inherit' }).status === 0;

export interface LockSetupOptions {
  readonly paths: StatePaths;
  /** The signing helper's Swift source, shipped with agentwatch. */
  readonly signerSource: string;
  readonly lock?: SystemLock;
  readonly run?: CommandRunner;
  readonly platform?: NodeJS.Platform;
}

export interface LockStatus extends Trust {
  /** The helper is built and a key was made: sending can be locked, or already is. */
  readonly ready: boolean;
}

/** Something the user has to see to: a missing tool, a refused `sudo`. */
export class LockSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockSetupError';
  }
}

/**
 * Turns the lock on sending on and off. Turning it on builds the signing helper, makes a key in
 * the Secure Enclave, and puts the key's public half and the policy for agents where only root
 * can change them: the one step that needs `sudo`.
 */
export class LockSetup {
  private readonly paths: StatePaths;
  private readonly lock: SystemLock;
  private readonly run: CommandRunner;

  constructor(private readonly options: LockSetupOptions) {
    this.paths = options.paths;
    this.lock = options.lock ?? new SystemLock(options.paths.lockDir);
    this.run = options.run ?? runAttached;
  }

  status(): LockStatus {
    const ready = existsSync(this.paths.signer) && existsSync(this.paths.fingerprintKey);

    return { ...this.lock.trust(), ready };
  }

  /** Locks sending, or changes what agents may send when it already is. */
  enable(agentSends: AgentSends): LockStatus {
    if ((this.options.platform ?? process.platform) !== 'darwin') {
      throw new LockSetupError('locking needs a Mac: the key lives in its Secure Enclave');
    }

    this.buildHelper();
    this.createKey();
    this.installAsRoot(agentSends);

    const status = this.status();

    if (!status.locked || status.agentSends !== agentSends) {
      throw new LockSetupError(`${this.paths.lockDir} was not written as expected`);
    }

    return status;
  }

  /** Unlocks sending and forgets the key. Messages go back to the key kept in a file. */
  disable(): LockStatus {
    const files = lockFiles(this.paths.lockDir);

    // Only the lock's own two files and its then-empty folder: never a recursive delete as root.
    const removed =
      this.run('sudo', ['/bin/rm', '-f', files.publicKey, files.policy]) &&
      this.run('sudo', ['/bin/rmdir', this.paths.lockDir]);

    if (!removed && this.lock.isLocked) {
      throw new LockSetupError('the lock was not removed: sending is still locked');
    }

    rmSync(this.paths.fingerprintKey, { force: true });
    rmSync(this.paths.fingerprintPublicKey, { force: true });

    return this.status();
  }

  /** Compiles the helper when there is none, or its source is newer. */
  private buildHelper(): void {
    const { signer } = this.paths;
    const source = this.options.signerSource;

    if (existsSync(signer) && statSync(signer).mtimeMs >= statSync(source).mtimeMs) {
      return;
    }

    mkdirSync(dirname(signer), { recursive: true });

    if (!this.run('swiftc', ['-O', source, '-o', signer])) {
      throw new LockSetupError(
        'the signing helper could not be built; it needs the Xcode command-line tools (xcode-select --install)',
      );
    }
  }

  /** Makes the key, once. Making it asks for nothing; using it asks for a fingerprint. */
  private createKey(): void {
    if (existsSync(this.paths.fingerprintKey) && existsSync(this.paths.fingerprintPublicKey)) {
      return;
    }

    const created = createdKeySchema.parse(
      JSON.parse(execFileSync(this.paths.signer, ['create-key'], { encoding: 'utf8' })),
    );

    mkdirSync(this.paths.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.paths.fingerprintKey, `${created.key}\n`, { mode: 0o600 });

    writeFileSync(this.paths.fingerprintPublicKey, Buffer.from(created.publicKey, 'base64'), {
      mode: 0o644,
    });
  }

  private installAsRoot(agentSends: AgentSends): void {
    const { lockDir, stateDir, fingerprintPublicKey } = this.paths;
    const files = lockFiles(lockDir);
    const policy = join(stateDir, 'lock-policy.json');
    const asRoot = ['-o', 'root', '-g', 'wheel'];

    writeFileSync(policy, `${JSON.stringify({ agentSends })}\n`, { mode: 0o644 });

    const installed =
      this.run('sudo', ['/usr/bin/install', '-d', ...asRoot, '-m', '755', lockDir]) &&
      this.run('sudo', [
        '/usr/bin/install',
        ...asRoot,
        '-m',
        '644',
        fingerprintPublicKey,
        files.publicKey,
      ]) &&
      this.run('sudo', ['/usr/bin/install', ...asRoot, '-m', '644', policy, files.policy]);

    rmSync(policy, { force: true });

    if (!installed) {
      throw new LockSetupError('sudo did not finish: nothing was locked');
    }
  }
}
