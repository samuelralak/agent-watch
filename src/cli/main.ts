#!/usr/bin/env node
// agentwatch: a live view of Claude Code sessions and their subagents, with signed messages to
// a session's main agent. This file only reads the command line and hands over.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SettingsUnreadableError } from '../adapters/claude/settings-file.adapter.js';
import { resolveStatePaths } from '../adapters/fs/state-paths.js';
import { composeInstaller, composeLockSetup, composeSendCommand } from './compose.js';
import { runHooksCommand } from './hooks.command.js';
import { runLockCommand } from './lock.command.js';
import { type CliOptions, parseOptions, USAGE, UsageError } from './options.js';
import { runSendCommand } from './send.command.js';
import { runWatchCommand } from './watch.command.js';

/** The built hook entry point sits beside this file's folder: `dist/hook/main.js`. */
const HOOK_ENTRY = fileURLToPath(new URL('../hook/main.js', import.meta.url));

/** The signing helper's source ships beside the build, and is compiled when sending is locked. */
const SIGNER_SOURCE = fileURLToPath(
  new URL('../../native/agentwatch-signer.swift', import.meta.url),
);

function version(): string {
  const manifest = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');

  return z.object({ version: z.string() }).parse(JSON.parse(manifest)).version;
}

const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** Returns an exit code, or null when the command keeps running (the view, a stream). */
async function run(options: CliOptions): Promise<number | null> {
  switch (options.command) {
    case 'help':
      print(USAGE);

      return 0;

    case 'version':
      print(version());

      return 0;

    case 'hooks': {
      const paths = resolveStatePaths();
      const installer = composeInstaller(HOOK_ENTRY, paths);

      return runHooksCommand(options.action, options, { installer, paths, write: print });
    }

    case 'lock':
      return runLockCommand(options, { setup: composeLockSetup(SIGNER_SOURCE), write: print });

    case 'send':
      return runSendCommand(options, composeSendCommand(print));

    case 'watch':
      await runWatchCommand(options, HOOK_ENTRY);

      return null;
  }
}

try {
  const code = await run(parseOptions(process.argv.slice(2)));

  if (code !== null) {
    process.exitCode = code;
  }
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`agentwatch: ${error.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
  } else if (error instanceof SettingsUnreadableError) {
    process.stderr.write(`agentwatch: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
