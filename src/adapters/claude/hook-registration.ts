import { asRecord, type UnknownRecord } from '../../util/record.js';
import type { StatePaths } from '../fs/state-paths.js';

/** How long an idle waiter may wait. Claude Code enforces `timeout` on asyncRewake hooks. */
const WAIT_TIMEOUT_SECONDS = 86_400;

/** The events the observe hook records. Tool events need a matcher; the others take none. */
const TOOL_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
] as const;

const OTHER_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'Notification',
  'PreCompact',
] as const;

interface HookCommand {
  readonly type: 'command';
  readonly command: string;
  readonly timeout: number;
  readonly async?: boolean;
  readonly asyncRewake?: boolean;
}

interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly HookCommand[];
}

export type HookRegistrations = Readonly<Record<string, readonly HookGroup[]>>;

const sh = (script: string, argument = ''): string =>
  `/bin/sh '${script}'${argument ? ` ${argument}` : ''}`;

/**
 * agentwatch's entries for the `hooks` key of Claude Code's settings.
 *
 * The observe hook is synchronous on purpose: it takes a few milliseconds, and a synchronous
 * PreToolUse hook finishes before the tool runs, so a tool's end is never recorded before its
 * start.
 */
export function hookRegistrations(paths: StatePaths): HookRegistrations {
  const observe: HookCommand = { type: 'command', command: sh(paths.observeScript), timeout: 10 };

  const deliver = (moment: string): HookCommand => ({
    type: 'command',
    command: sh(paths.deliverScript, moment),
    timeout: 15,
  });

  // Idle from here on: wait for a message and wake the session with it.
  const wait: HookCommand = {
    type: 'command',
    command: sh(paths.waitScript),
    timeout: WAIT_TIMEOUT_SECONDS,
    async: true,
    asyncRewake: true,
  };

  const extra: Readonly<Record<string, readonly HookCommand[]>> = {
    PostToolUse: [deliver('tool')],
    Stop: [deliver('turn-end'), wait],
    SessionStart: [wait],
  };

  const registrations: Record<string, HookGroup[]> = {};

  for (const event of TOOL_EVENTS) {
    registrations[event] = [{ matcher: '*', hooks: [observe, ...(extra[event] ?? [])] }];
  }

  for (const event of OTHER_EVENTS) {
    registrations[event] = [{ hooks: [observe, ...(extra[event] ?? [])] }];
  }

  return registrations;
}

/** Whether a hook command is one of agentwatch's scripts. */
export function isAgentwatchCommand(paths: StatePaths, command: unknown): boolean {
  return (
    typeof command === 'string' &&
    [paths.observeScript, paths.deliverScript, paths.waitScript].some((script) =>
      command.includes(script),
    )
  );
}

type Settings = Readonly<Record<string, unknown>>;

function hooksOf(settings: Settings): UnknownRecord {
  return asRecord(settings.hooks) ?? {};
}

/** The groups of one event with agentwatch's commands taken out. A group left empty by that goes. */
function withoutOwnCommands(groups: readonly unknown[], paths: StatePaths): unknown[] {
  return groups.flatMap((group: unknown) => {
    const commands = asRecord(group)?.hooks;

    if (!Array.isArray(commands)) {
      return [group];
    }

    const others = commands.filter((hook) => !isAgentwatchCommand(paths, asRecord(hook)?.command));

    if (others.length === commands.length) {
      return [group];
    }

    return others.length > 0 ? [{ ...asRecord(group), hooks: others }] : [];
  });
}

/**
 * `settings` without agentwatch's hooks. Everything else is kept as it is, including the user's
 * own hooks, groups the user left empty, and entries of a shape this code does not know.
 * Settings that never had the hooks come back as the same object.
 */
export function withoutAgentwatchHooks(settings: Settings, paths: StatePaths): Settings {
  if (!hasAgentwatchHooks(settings, paths)) {
    return settings;
  }

  const hooks: Record<string, unknown> = {};

  for (const [event, groups] of Object.entries(hooksOf(settings))) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }

    const kept = withoutOwnCommands(groups, paths);

    // An event with nothing left under it was there for agentwatch's hooks alone.
    if (kept.length > 0) {
      hooks[event] = kept;
    }
  }

  const { hooks: _removed, ...rest } = settings;

  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

/**
 * `settings` with agentwatch's hooks, once, after any hooks already there. Events and keys keep
 * their places, so installing over an installation changes nothing.
 */
export function withAgentwatchHooks(settings: Settings, paths: StatePaths): Settings {
  const registrations = hookRegistrations(paths);
  const hooks: Record<string, unknown> = {};

  for (const [event, groups] of Object.entries(hooksOf(settings))) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups; // a shape this code does not know: left alone
      continue;
    }

    const merged = [...withoutOwnCommands(groups, paths), ...(registrations[event] ?? [])];

    // Empty only for an event an older version registered and this one does not.
    if (merged.length > 0 || groups.length === 0) {
      hooks[event] = merged;
    }
  }

  for (const [event, groups] of Object.entries(registrations)) {
    hooks[event] ??= groups;
  }

  return { ...settings, hooks };
}

/** Whether agentwatch's hooks are in `settings`. */
export function hasAgentwatchHooks(settings: Settings, paths: StatePaths): boolean {
  return Object.values(hooksOf(settings)).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some((group: unknown) => {
        const commands = asRecord(group)?.hooks;

        return (
          Array.isArray(commands) &&
          commands.some((hook) => isAgentwatchCommand(paths, asRecord(hook)?.command))
        );
      }),
  );
}
