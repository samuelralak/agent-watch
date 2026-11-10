/** What the command line asks for, and what it refuses with a reason. */
import { describe, expect, it } from 'vitest';
import { parseOptions, UsageError } from '../../src/cli/options.js';

const MINUTE = 60_000;

describe('the command line', () => {
  it('opens the view by default, with ten minutes of finished agents', () => {
    expect(parseOptions([])).toEqual({
      command: 'watch',
      mode: 'view',
      sessionFilter: null,
      recentMs: 10 * MINUTE,
      backlog: 20,
      includeMain: false,
      includeResults: true,
      mouse: true,
    });

    expect(parseOptions(['--no-mouse'])).toMatchObject({ command: 'watch', mouse: false });
  });

  it('streams, filters and tunes when asked', () => {
    expect(
      parseOptions(['--stream', '--session', 'api', '--recent', '2', '--backlog', '5', '--main']),
    ).toMatchObject({
      mode: 'stream',
      sessionFilter: 'api',
      recentMs: 2 * MINUTE,
      backlog: 5,
      includeMain: true,
    });

    expect(parseOptions(['--json', '--no-results'])).toMatchObject({
      mode: 'json',
      includeResults: false,
    });

    expect(parseOptions(['-s'])).toMatchObject({ mode: 'stream' });
  });

  it('runs the hooks subcommands', () => {
    expect(parseOptions(['hooks', 'install'])).toEqual({
      command: 'hooks',
      action: 'install',
      purge: false,
    });

    expect(parseOptions(['hooks', 'uninstall', '--purge'])).toMatchObject({ purge: true });
    expect(parseOptions(['--help'])).toEqual({ command: 'help' });
    expect(parseOptions(['-v'])).toEqual({ command: 'version' });
  });

  it('locks and unlocks sending, with what agents may send', () => {
    expect(parseOptions(['lock', 'enable'])).toEqual({
      command: 'lock',
      action: 'enable',
      agentSends: 'approve',
    });

    expect(parseOptions(['lock', 'enable', '--agents', 'free'])).toMatchObject({
      agentSends: 'free',
    });

    expect(parseOptions(['lock', 'status'])).toMatchObject({ action: 'status' });
    expect(() => parseOptions(['lock'])).toThrow(/usage: agentwatch lock/);
    expect(() => parseOptions(['lock', 'enable', '--agents', 'sometimes'])).toThrow(/one of/);
    expect(() => parseOptions(['lock', 'status', '--agents', 'off'])).toThrow(/only goes with/);
    expect(() => parseOptions(['--agents', 'off'])).toThrow(UsageError);
  });

  it('sends a message for an agent, to a session it names', () => {
    expect(parseOptions(['send', '--session', 'api', 'the', 'build', 'is', 'green'])).toEqual({
      command: 'send',
      session: 'api',
      aboutAgentId: null,
      text: 'the build is green',
    });

    expect(parseOptions(['send', '--session', 'api', '--about', 'a1b2', 'hi'])).toMatchObject({
      aboutAgentId: 'a1b2',
    });

    expect(() => parseOptions(['send', 'no session named'])).toThrow(/usage: agentwatch send/);
    expect(() => parseOptions(['send', '--session', 'api'])).toThrow(/usage: agentwatch send/);
  });

  it('refuses a filter with no value instead of taking the next option as one', () => {
    expect(() => parseOptions(['--session'])).toThrow(UsageError);
    expect(() => parseOptions(['--session', '--stream'])).toThrow(UsageError);
    expect(() => parseOptions(['--session', ' '])).toThrow(UsageError);
  });

  it('refuses numbers that are not numbers', () => {
    expect(() => parseOptions(['--recent', 'soon'])).toThrow(/--recent needs a number/);
    expect(() => parseOptions(['--backlog', '-3'])).toThrow(UsageError);
  });

  it('refuses what it does not know, and combinations that mean nothing', () => {
    expect(() => parseOptions(['--verbose'])).toThrow(UsageError);
    expect(() => parseOptions(['watch'])).toThrow(/unknown command: watch/);
    expect(() => parseOptions(['hooks'])).toThrow(/usage: agentwatch hooks/);
    expect(() => parseOptions(['hooks', 'reinstall'])).toThrow(UsageError);
    expect(() => parseOptions(['--stream', '--json'])).toThrow(/choose one/);
    expect(() => parseOptions(['--purge'])).toThrow(/--purge only goes with/);
    expect(() => parseOptions(['hooks', 'install', '--purge'])).toThrow(/--purge only goes with/);
  });
});
