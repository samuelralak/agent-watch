#!/usr/bin/env node
import { SESSION_ID } from '../adapters/claude/hook-payload.contract.js';
// The part of agentwatch a session's own hooks run, and only when a message is waiting:
//   deliver <tool|turn-end>   print the hook output that hands the messages to the main agent
//   wake                      exit 2 with the messages on stderr, which wakes an idle session
//
// A hook must never fail or stall Claude Code: every error ends quietly with exit 0.
import { EventFileReceiptWriter } from '../adapters/claude/receipt.js';
import { HmacSigner } from '../adapters/crypto/hmac-signer.adapter.js';
import { FileInbox } from '../adapters/fs/inbox.adapter.js';
import { resolveStatePaths } from '../adapters/fs/state-paths.js';
import { SystemLock } from '../adapters/lock/system-lock.adapter.js';
import { DeliverMessagesService } from '../application/deliver-messages.service.js';

const HOOK_EVENT = { tool: 'PostToolUse', 'turn-end': 'Stop' } as const;

function run(): number {
  const [command, moment] = process.argv.slice(2);
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? '';

  if (!SESSION_ID.test(sessionId)) {
    return 0;
  }

  const paths = resolveStatePaths();
  const sharedKey = HmacSigner.loadExisting(paths.key);
  const lock = new SystemLock(paths.lockDir);

  const service = new DeliverMessagesService({
    sharedKey,
    inbox: new FileInbox(paths),
    fingerprintKey: lock.fingerprintKey(),
    trust: lock.trust(),
    receipts: new EventFileReceiptWriter(paths, sharedKey),
  });

  if (command === 'wake') {
    const text = service.deliver(sessionId, 'wake');

    if (text === null) {
      return 0;
    }

    process.stderr.write(text);

    return 2; // Claude Code wakes the session and shows it stderr
  }

  if (command === 'deliver' && (moment === 'tool' || moment === 'turn-end')) {
    const text = service.deliver(sessionId, moment);

    if (text === null) {
      return 0;
    }

    // additionalContext on both events: shown as hook feedback and framed once for the model.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: HOOK_EVENT[moment], additionalContext: text },
      }),
    );
  }

  return 0;
}

try {
  // Set, not forced: the process ends by itself once its output has been written in full.
  process.exitCode = run();
} catch {
  process.exitCode = 0;
}
