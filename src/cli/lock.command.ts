import { type LockSetup, LockSetupError, type LockStatus } from '../adapters/lock/lock-setup.js';
import type { AgentSends } from '../domain/sending.policy.js';
import type { LockOptions } from './options.js';

export interface LockCommandDeps {
  readonly setup: LockSetup;
  readonly write: (line: string) => void;
}

const AGENTS: Readonly<Record<AgentSends, string>> = {
  off: 'agents may not send messages',
  approve: 'each message an agent sends needs your fingerprint',
  free: "agents may send messages; they are always marked as an agent's",
};

/** `agentwatch lock <action>`. Returns the process exit code. */
export function runLockCommand(options: LockOptions, { setup, write }: LockCommandDeps): number {
  try {
    if (options.action === 'enable') {
      explainEnable(write);
      describe(setup.enable(options.agentSends), write);
      adviseAfterLocking(write);
    } else if (options.action === 'disable') {
      describe(setup.disable(), write);
    } else {
      describe(setup.status(), write);
    }

    return 0;
  } catch (error) {
    if (!(error instanceof LockSetupError)) {
      throw error;
    }

    write(`Not done: ${error.message}.`);

    return 1;
  }
}

function explainEnable(write: (line: string) => void): void {
  write("Locking sending: this builds a small helper, makes a key in this Mac's Secure Enclave,");
  write('and asks for your password once (sudo) to store two small files only root can change.');
}

function describe(status: LockStatus, write: (line: string) => void): void {
  if (!status.locked) {
    write('Sending is not locked: messages are signed with a key kept in a file, which any');
    write('program running as you can read. Lock it with: agentwatch lock enable');

    return;
  }

  write('Sending is locked: your messages need your fingerprint, once per agentwatch window.');
  write(`Agents: ${AGENTS[status.agentSends]} (change with: agentwatch lock enable --agents …).`);
  explainLimits(write);
}

/** What a lock is worth is said wherever a lock is reported, not only in the documentation. */
function explainLimits(write: (line: string) => void): void {
  write('');
  write('What this stops: a program forging your messages with the key kept in a file.');
  write("What it does not stop: a program that rewrites agentwatch's own hook files, or the");
  write('hooks in your Claude Code settings. See docs/security.md.');
}

function adviseAfterLocking(write: (line: string) => void): void {
  write('');
  write('Close any open agentwatch window and start it again.');
  write('Your first message in a window asks for your fingerprint. Touch the sensor only then:');
  write('any program can raise such a prompt, so refuse one you did not cause.');
}
