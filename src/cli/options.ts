import { parseArgs } from 'node:util';
import type { AgentSends } from '../domain/sending.policy.js';

export const USAGE = `agentwatch: a live view of Claude Code sessions and their subagents

Usage:
  agentwatch                  the full-screen view: agents, their activity, and a message box
  agentwatch --stream         print activity as it happens (for pipes and logs)
  agentwatch --json           print activity as JSON lines
  agentwatch --once           print the agent list once and exit
  agentwatch hooks install    add agentwatch's hooks to your Claude Code settings (once)
  agentwatch hooks update     rewrite the hook scripts only; your settings are not touched
  agentwatch hooks status     say whether the hooks are installed and current
  agentwatch hooks uninstall  take the hooks out again (--purge also deletes agentwatch's state)
  agentwatch lock enable      make your messages need your fingerprint (asks for sudo once)
  agentwatch lock status      say whether sending is locked, and what agents may send
  agentwatch lock disable     go back to messages signed with a key kept in a file
  agentwatch send --session <s> <text>
                              for agents: send a message to another session, marked as an agent's

Options:
  --session <s>   only sessions matching an id prefix, a name, or part of the working directory
  --recent <min>  keep finished agents listed this long (default 10)
  --backlog <n>   past entries printed when streaming starts (default 20)
  --main          include the main agent's activity when streaming
  --no-results    leave tool results out when streaming
  --no-mouse      in the view, leave the mouse to the terminal: no scrolling by trackpad
                  or wheel, and text is selected without holding a key
  --agents <how>  with lock enable, what agents may send: off, approve (the default: each
                  message needs your fingerprint) or free
  --about <id>    with send: the subagent the message is about
  -h, --help      this text
  -v, --version

In the view, press ? for the keys.`;

export type WatchMode = 'view' | 'stream' | 'json' | 'once';
export type HooksAction = 'install' | 'update' | 'uninstall' | 'status';
export type LockAction = 'enable' | 'disable' | 'status';

export interface WatchOptions {
  readonly command: 'watch';
  readonly mode: WatchMode;
  readonly sessionFilter: string | null;
  readonly recentMs: number;
  readonly backlog: number;
  readonly includeMain: boolean;
  readonly includeResults: boolean;
  /** The view asks the terminal to report the mouse, so a trackpad or a wheel scrolls it. */
  readonly mouse: boolean;
}

export interface HooksOptions {
  readonly command: 'hooks';
  readonly action: HooksAction;
  readonly purge: boolean;
}

export interface LockOptions {
  readonly command: 'lock';
  readonly action: LockAction;
  /** With `enable`: what agents may send once sending is locked. */
  readonly agentSends: AgentSends;
}

export interface SendOptions {
  readonly command: 'send';
  /** The session to send to: its id, the start of its id, or its name. */
  readonly session: string;
  readonly aboutAgentId: string | null;
  readonly text: string;
}

export type CliOptions =
  | WatchOptions
  | HooksOptions
  | LockOptions
  | SendOptions
  | { readonly command: 'help' }
  | { readonly command: 'version' };

/** The command line could not be understood. The message says what to change. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const HOOKS_ACTIONS: readonly HooksAction[] = ['install', 'update', 'uninstall', 'status'];
const LOCK_ACTIONS: readonly LockAction[] = ['enable', 'disable', 'status'];
const AGENT_SENDS: readonly AgentSends[] = ['off', 'approve', 'free'];

const isOneOf = <T extends string>(choices: readonly T[], text: string | undefined): text is T =>
  choices.some((choice) => choice === text);

const isHooksAction = (text: string | undefined): text is HooksAction =>
  HOOKS_ACTIONS.some((action) => action === text);

function count(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const number = Number(value);

  if (value.trim() === '' || !Number.isFinite(number) || number < 0) {
    throw new UsageError(`${name} needs a number, zero or more; got "${value}"`);
  }

  return number;
}

const PURGE_MISUSED = '--purge only goes with: agentwatch hooks uninstall';
const MINUTE_MS = 60_000;

function readArguments(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        stream: { type: 'boolean', short: 's' },
        json: { type: 'boolean' },
        once: { type: 'boolean' },
        session: { type: 'string' },
        recent: { type: 'string' },
        backlog: { type: 'string' },
        main: { type: 'boolean' },
        'no-results': { type: 'boolean' },
        'no-mouse': { type: 'boolean' },
        purge: { type: 'boolean' },
        agents: { type: 'string' },
        about: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    // The first sentence says what is wrong; the rest is advice about positionals.
    const reason = error instanceof Error ? error.message : String(error);

    throw new UsageError(reason.split('. ')[0] ?? reason);
  }
}

type Flags = ReturnType<typeof readArguments>['values'];

/** What the command line asks for. Throws `UsageError` for anything it does not understand. */
export function parseOptions(argv: readonly string[]): CliOptions {
  const { values, positionals } = readArguments(argv);
  const [command, ...rest] = positionals;

  if (values.help) {
    return { command: 'help' };
  }

  if (values.version) {
    return { command: 'version' };
  }

  if (command === 'hooks') {
    return hooksOptions(values, rest);
  }

  if (command === 'lock') {
    return lockOptions(values, rest);
  }

  if (command === 'send') {
    return sendOptions(values, rest);
  }

  if (command !== undefined) {
    throw new UsageError(`unknown command: ${command}`);
  }

  return watchOptions(values);
}

function hooksOptions(flags: Flags, [action, ...extra]: readonly string[]): HooksOptions {
  if (!isHooksAction(action) || extra.length > 0) {
    throw new UsageError(`usage: agentwatch hooks ${HOOKS_ACTIONS.join(' | ')}`);
  }

  if (flags.purge && action !== 'uninstall') {
    throw new UsageError(PURGE_MISUSED);
  }

  return { command: 'hooks', action, purge: flags.purge ?? false };
}

function lockOptions(flags: Flags, [action, ...extra]: readonly string[]): LockOptions {
  if (!isOneOf(LOCK_ACTIONS, action) || extra.length > 0) {
    throw new UsageError(`usage: agentwatch lock ${LOCK_ACTIONS.join(' | ')}`);
  }

  if (flags.agents !== undefined && action !== 'enable') {
    throw new UsageError('--agents only goes with: agentwatch lock enable');
  }

  if (flags.agents !== undefined && !isOneOf(AGENT_SENDS, flags.agents)) {
    throw new UsageError(`--agents is one of: ${AGENT_SENDS.join(', ')}`);
  }

  return { command: 'lock', action, agentSends: flags.agents ?? 'approve' };
}

function sendOptions(flags: Flags, words: readonly string[]): SendOptions {
  const text = words.join(' ').trim();

  if (!flags.session?.trim() || !text) {
    throw new UsageError('usage: agentwatch send --session <id or name> <text>');
  }

  return {
    command: 'send',
    session: flags.session.trim(),
    aboutAgentId: flags.about ?? null,
    text,
  };
}

function watchOptions(flags: Flags): WatchOptions {
  if (flags.purge) {
    throw new UsageError(PURGE_MISUSED);
  }

  if (flags.agents !== undefined || flags.about !== undefined) {
    throw new UsageError('--agents goes with lock enable, and --about with send');
  }

  if (flags.session !== undefined && flags.session.trim() === '') {
    throw new UsageError('--session needs an id prefix, a name, or part of a directory');
  }

  return {
    command: 'watch',
    mode: watchMode(flags),
    sessionFilter: flags.session ?? null,
    recentMs: count(flags.recent, '--recent', 10) * MINUTE_MS,
    backlog: Math.floor(count(flags.backlog, '--backlog', 20)),
    includeMain: flags.main ?? false,
    includeResults: !flags['no-results'],
    mouse: !flags['no-mouse'],
  };
}

/** The one way of watching that was asked for; the view when none was. */
function watchMode(flags: Flags): WatchMode {
  const asked: readonly (readonly [boolean | undefined, WatchMode])[] = [
    [flags.stream, 'stream'],
    [flags.json, 'json'],
    [flags.once, 'once'],
  ];

  const modes = asked.filter(([wanted]) => wanted).map(([, mode]) => mode);

  if (modes.length > 1) {
    throw new UsageError('choose one of --stream, --json and --once');
  }

  return modes[0] ?? 'view';
}
