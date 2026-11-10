import type { HookInstaller } from '../adapters/claude/hook-installer.js';
import { copyToClipboard } from '../adapters/system/clipboard.js';
import { Viewer } from '../tui/viewer.js';
import { composeWatchApp } from './compose.js';
import type { WatchMode, WatchOptions } from './options.js';
import { Shutdown } from './shutdown.js';
import { printAgentList, type StreamOptions, streamJson, streamText } from './stream.js';
import type { WatchApp } from './watch-app.js';

const FALLBACK_COLUMNS = 120;

/**
 * `agentwatch` with no subcommand: the view, or one of the ways of printing. The view and the
 * streams run until told to stop.
 */
export async function runWatchCommand(options: WatchOptions, hookEntry: string): Promise<void> {
  const mode = effectiveMode(options.mode);
  const app = composeWatchApp({ ...options, hookEntry });
  const shutdown = new Shutdown(app);

  shutdown.listen();
  refreshHookScripts(app.installer, app.watch.warnings);
  app.start();

  if (mode === 'view') {
    openViewer(app, options, shutdown);

    return;
  }

  await app.whenReady();
  printWarnings(app);

  if (mode === 'once') {
    printAgentList(app.store, { ...streamOptions(options, mode), recentMs: options.recentMs });
    // Stopped, not exited: the process ends by itself once the output has been written in full.
    app.stop();

    return;
  }

  follow(app, mode, streamOptions(options, mode), shutdown);
}

const isTerminal = (): boolean => process.stdout.isTTY === true;
const wantsColor = (): boolean => !('NO_COLOR' in process.env);

/** The view needs a terminal on both ends; anything else gets the stream. */
function effectiveMode(asked: WatchMode): WatchMode {
  const interactive = isTerminal() && process.stdin.isTTY === true;

  return asked === 'view' && !interactive ? 'stream' : asked;
}

/**
 * Hook scripts written by an older build are brought up to date. Claude Code's settings point at
 * the scripts' paths, which do not change, so the settings are never touched here.
 */
function refreshHookScripts(installer: HookInstaller, warnings: Map<string, string>): void {
  const status = installer.status();

  if (!status.installed || status.scriptsCurrent || status.problem) {
    return;
  }

  try {
    installer.refreshScripts();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    warnings.set('hooks', `the hook scripts are out of date and could not be rewritten: ${reason}`);
  }
}

function openViewer(app: WatchApp, options: WatchOptions, shutdown: Shutdown): void {
  const viewer = new Viewer({
    store: app.store,
    watch: app.watch,
    sendMessage: app.sendMessage,
    inbox: app.inbox,
    recentMs: options.recentMs,
    locked: app.locked,
    hooksInstalled: () => app.installer.status().installed,
    copyToClipboard,
    color: wantsColor(),
    mouse: options.mouse,
    history: app.history,
    toolExchange: app.toolExchange,
    input: process.stdin,
    output: process.stdout,
    onQuit: () => shutdown.exit(0),
  });

  shutdown.restoreWith(() => viewer.stop());
  viewer.start();
}

function printWarnings(app: WatchApp): void {
  for (const warning of app.watch.warnings.values()) {
    process.stderr.write(`agentwatch: warning: ${warning}\n`);
  }
}

function streamOptions(options: WatchOptions, mode: WatchMode): StreamOptions {
  const terminal = isTerminal();

  return {
    backlog: options.backlog,
    includeMain: options.includeMain,
    includeResults: options.includeResults,
    color: terminal && mode !== 'json' && wantsColor(),
    columns: terminal ? (process.stdout.columns || FALLBACK_COLUMNS) - 1 : null,
    write: (line) => process.stdout.write(`${line}\n`),
  };
}

/** Prints activity as it happens, until the reader goes away or the process is told to stop. */
function follow(app: WatchApp, mode: WatchMode, stream: StreamOptions, shutdown: Shutdown): void {
  // The reader went away (`| head`): that is the end, not an error.
  process.stdout.on('error', () => shutdown.exit(0));

  const print = mode === 'json' ? streamJson : streamText;

  print(app.store, stream);

  const live = [...app.store.sessions.values()].filter((session) => session.alive).length;
  const sessions = `${live} session${live === 1 ? '' : 's'}`;

  process.stderr.write(
    live > 0
      ? `agentwatch: following ${sessions}; new ones appear as they start (ctrl-c stops)\n`
      : 'agentwatch: no sessions yet; waiting for one to start (ctrl-c stops)\n',
  );
}
