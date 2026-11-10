#!/usr/bin/env node
// The launcher: what the `agentwatch` command is linked to. It hands over to the built code in
// `dist`, so the link survives rebuilds.
//
// It also answers `agentwatch.mjs hook wake`, the way waiters started by versions before 0.3
// call for their messages. Those waiters live until their session's next turn ends.
const [command] = process.argv.slice(2);

try {
  if (command === 'hook') {
    process.argv.splice(2, 1);
    await import('../dist/hook/main.js');
  } else {
    await import('../dist/cli/main.js');
  }
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') {
    throw error;
  }

  // A hook must never fail Claude Code; only a person is told what to do.
  if (command !== 'hook') {
    process.stderr.write(
      'agentwatch is not built yet: run `npm install && npm run build` in its folder\n',
    );

    process.exitCode = 1;
  }
}
