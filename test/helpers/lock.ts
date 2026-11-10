import { chmodSync, copyFileSync, mkdirSync, rmdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CommandRunner } from '../../src/adapters/lock/lock-setup.js';

/** A stand-in for the Swift signing helper: same protocol, an ordinary key, no fingerprint. */
export const FAKE_HELPER = fileURLToPath(new URL('./fake-signer.mjs', import.meta.url));

/** Whoever runs the tests: the owner a test lock folder is trusted for, where root is on a real Mac. */
export const ME = process.getuid?.() ?? 0;

/**
 * Runs the commands locking needs without a compiler or `sudo`: "building" the helper copies
 * the stand-in, and the privileged commands are carried out as the current user. Every command
 * is noted in `log`, so a test can see exactly what would have run as root.
 */
export function pretendToRun(log: string[], refuse: (command: string) => boolean = () => false) {
  const run: CommandRunner = (command, args) => {
    const line = [command, ...args].join(' ');

    log.push(line);

    if (refuse(line)) {
      return false;
    }

    if (command === 'swiftc') {
      return build(args.at(-1) ?? '');
    }

    return command === 'sudo' && asRoot(args[0] ?? '', args.slice(1));
  };

  return run;
}

function build(output: string): boolean {
  copyFileSync(FAKE_HELPER, output);
  chmodSync(output, 0o755);

  return true;
}

function asRoot(program: string, args: readonly string[]): boolean {
  const target = args.at(-1) ?? '';

  if (program === '/usr/bin/install' && args.includes('-d')) {
    mkdirSync(target, { recursive: true, mode: 0o755 });
  } else if (program === '/usr/bin/install') {
    copyFileSync(args.at(-2) ?? '', target);
    chmodSync(target, 0o644);
  } else if (program === '/bin/rm') {
    for (const file of args.filter((arg) => !arg.startsWith('-'))) {
      rmSync(file, { force: true });
    }
  } else if (program === '/bin/rmdir') {
    rmdirSync(target);
  } else {
    return false;
  }

  return true;
}
