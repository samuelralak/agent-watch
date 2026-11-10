/**
 * The three scripts Claude Code runs as hooks, run for real under /bin/sh against the built
 * hook entry point: what they record, what they deliver, and when an idle waiter wakes or leaves.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookScripts, writeHookScripts } from '../../src/adapters/claude/hook-scripts.js';
import { HmacSigner } from '../../src/adapters/crypto/hmac-signer.adapter.js';
import { FileInbox } from '../../src/adapters/fs/inbox.adapter.js';
import type { StatePaths } from '../../src/adapters/fs/state-paths.js';
import { SendMessageService } from '../../src/application/send-message.service.js';
import { HOOK_ENTRY } from '../helpers/build.js';
import { temporaryState } from '../helpers/state.js';

const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';
const TOOL_PAYLOAD = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: SESSION });
const STOP_PAYLOAD = JSON.stringify({ hook_event_name: 'Stop', session_id: SESSION });

const running: ChildProcess[] = [];

afterEach(() => {
  for (const child of running.splice(0)) {
    child.kill('SIGTERM');
  }
});

/** The pid of a process that has already exited. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid;

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting until ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function setup(shell: string) {
  const paths = temporaryState();
  // A stand-in for Node that notes each time a script starts it.
  const starts = join(paths.stateDir, 'node-starts');
  const node = join(paths.stateDir, 'node');

  writeFileSync(node, `#!/bin/sh\nprintf x >>'${starts}'\nexec '${process.execPath}' "$@"\n`);
  chmodSync(node, 0o755);
  writeHookScripts(paths, hookScripts({ paths, node, hookEntry: HOOK_ENTRY }));

  const inbox = new FileInbox(paths);

  const sender = new SendMessageService({
    signer: HmacSigner.load(paths.key),
    inbox,
    newNonce: () => randomBytes(16).toString('hex'),
  });

  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? '',
    CLAUDE_CODE_SESSION_ID: SESSION,
    ...extra,
  });

  const run = (script: string, input: string, args: string[] = [], extra = {}) =>
    spawnSync(shell, [script, ...args], {
      input,
      env: env(extra),
      encoding: 'utf8',
      timeout: 15_000,
    });

  return {
    paths,
    inbox,
    send: (text: string, sessionId = SESSION) => sender.send({ sessionId, text }),
    run,
    env,
    nodeStarts: () => (existsSync(starts) ? readFileSync(starts, 'utf8').length : 0),
    waiting: (sessionId = SESSION) =>
      readdirSync(join(paths.inbox, sessionId)).filter((name) => name.endsWith('.msg')),
  };
}

/** Starts a waiter the way Claude Code does: as a process that is given the hook payload. */
function startWaiter(shell: string, paths: StatePaths, env: Record<string, string>) {
  const child = spawn(shell, [paths.waitScript], { env, stdio: ['pipe', 'ignore', 'pipe'] });

  running.push(child);
  child.stdin?.end(STOP_PAYLOAD);

  let stderr = '';

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

  return {
    pid: child.pid ?? 0,
    exited,
    stderr: () => stderr,
    isRunning: () => child.exitCode === null && child.signalCode === null,
  };
}

/**
 * Whether a waiter has the session's wake-up FIFO open. It records itself as the waiter a moment
 * before that, so this is the point from which a message is handed over at once.
 */
function isListening(paths: StatePaths, sessionId = SESSION): boolean {
  try {
    closeSync(
      openSync(join(paths.inbox, sessionId, '.wake'), constants.O_WRONLY | constants.O_NONBLOCK),
    );

    return true;
  } catch {
    return false; // no FIFO yet, or nobody reading it
  }
}

const waiterOf = (paths: StatePaths, sessionId = SESSION): number => {
  try {
    return Number(readFileSync(join(paths.inbox, sessionId, '.waiter'), 'utf8'));
  } catch {
    return 0;
  }
};

/**
 * The hooks run under whatever `/bin/sh` is where they are installed: bash in POSIX mode on
 * macOS, dash on most Linux systems. Both are tried when both are here.
 */
const SHELLS = ['/bin/sh', '/bin/dash'].filter((shell) => existsSync(shell));

describe.each(SHELLS)('under %s', (shell) => {
  describe('the observe hook', () => {
    it('records nothing while no viewer is open', async () => {
      const { paths, run } = setup(shell);
      const result = run(paths.observeScript, TOOL_PAYLOAD);

      expect(result.status).toBe(0);
      expect(readdirSync(paths.events).filter((name) => name.endsWith('.json'))).toEqual([]);
    });

    it('records each event as one whole file while a viewer is open', async () => {
      const { paths, run } = setup(shell);

      writeFileSync(paths.ingestLock, `${process.pid}\n`);
      expect(run(paths.observeScript, TOOL_PAYLOAD).status).toBe(0);
      expect(run(paths.observeScript, STOP_PAYLOAD).status).toBe(0);

      const files = readdirSync(paths.events).filter((name) => name.endsWith('.json'));

      expect(files).toHaveLength(2);

      const recorded = files.map((name) => readFileSync(join(paths.events, name), 'utf8')).sort();

      expect(recorded).toEqual([TOOL_PAYLOAD, STOP_PAYLOAD].sort());
      expect(readdirSync(paths.eventsTmp)).toEqual([]);
    });

    it('records nothing for a viewer that is gone, and never fails on a damaged lock', async () => {
      const { paths, run } = setup(shell);

      for (const lock of [`${deadPid()}\n`, 'not a pid\n', '', '12; rm -rf /\n']) {
        writeFileSync(paths.ingestLock, lock);

        const result = run(paths.observeScript, TOOL_PAYLOAD);

        expect(result.status, JSON.stringify(lock)).toBe(0);
        expect(result.stderr, JSON.stringify(lock)).toBe('');
      }

      expect(readdirSync(paths.events).filter((name) => name.endsWith('.json'))).toEqual([]);
    });
  });

  describe('the delivery hook', () => {
    it('marks the session reachable, and does not start Node when no message waits', async () => {
      const { paths, inbox, run, nodeStarts } = setup(shell);

      expect(inbox.canReceive(SESSION)).toBe(false);

      const result = run(paths.deliverScript, TOOL_PAYLOAD, ['tool']);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(inbox.canReceive(SESSION)).toBe(true);
      expect(nodeStarts()).toBe(0);
    });

    it("hands a waiting message to the main agent as the hook's output, once", async () => {
      const { paths, send, run, waiting } = setup(shell);

      await send('skip the flaky test for now');

      const result = run(paths.deliverScript, TOOL_PAYLOAD, ['tool']);

      expect(result.status).toBe(0);

      const output = JSON.parse(result.stdout);

      expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(output.hookSpecificOutput.additionalContext).toContain('skip the flaky test for now');
      expect(waiting()).toEqual([]);
      expect(run(paths.deliverScript, TOOL_PAYLOAD, ['tool']).stdout).toBe('');
    });

    it('works out the moment from the payload when it was registered without one', async () => {
      const { paths, send, run } = setup(shell);

      await send('wrap up');

      const output = JSON.parse(run(paths.deliverScript, STOP_PAYLOAD).stdout);

      expect(output.hookSpecificOutput.hookEventName).toBe('Stop');
      expect(output.hookSpecificOutput.additionalContext).toContain('wrap up');
    });

    it("leaves a message for the main agent when the hook is a subagent's, without starting Node", async () => {
      const { paths, send, run, waiting, nodeStarts } = setup(shell);

      await send('for the main agent');

      const payload = JSON.stringify({ hook_event_name: 'PostToolUse', agent_id: 'a1b2c3' });
      const result = run(paths.deliverScript, payload, ['tool']);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(waiting()).toHaveLength(1);
      expect(nodeStarts()).toBe(0);
    });

    it('delivers nothing to another session, and ignores a session id that could name a path', async () => {
      const { paths, send, run, waiting } = setup(shell);

      await send('only for the first session');

      const other = run(paths.deliverScript, TOOL_PAYLOAD, ['tool'], {
        CLAUDE_CODE_SESSION_ID: OTHER,
      });

      expect(other.stdout).toBe('');

      const unsafe = run(paths.deliverScript, TOOL_PAYLOAD, ['tool'], {
        CLAUDE_CODE_SESSION_ID: `../inbox/${SESSION}`,
      });

      expect(unsafe.status).toBe(0);
      expect(unsafe.stdout).toBe('');
      expect(waiting()).toHaveLength(1);
    });
  });

  describe('the idle waiter', () => {
    const idle = (env: (extra?: Record<string, string>) => Record<string, string>, extra = {}) =>
      env({ CLAUDE_PID: String(process.pid), AGENTWATCH_WATCHDOG_S: '1', ...extra });

    it('wakes the session with the message as soon as one is sent', async () => {
      const { paths, inbox, send, env } = setup(shell);
      const waiter = startWaiter(shell, paths, idle(env));

      await until(() => isListening(paths), 'the waiter is listening');
      expect(inbox.hasWaiter(SESSION)).toBe(true);

      const sent = await send('the deploy finished, carry on');

      expect(sent.woke).toBe(true);
      expect(await waiter.exited).toBe(2); // exit code 2 is what wakes Claude Code
      expect(waiter.stderr()).toContain('the deploy finished, carry on');
    });

    it('wakes at once for a message that was already waiting when it started', async () => {
      const { paths, send, env } = setup(shell);

      await send('sent while it was busy');

      const waiter = startWaiter(shell, paths, idle(env));

      expect(await waiter.exited).toBe(2);
      expect(waiter.stderr()).toContain('sent while it was busy');
    });

    it('does not wait at all in a headless run, which has nobody to wake', async () => {
      const { paths, inbox, env } = setup(shell);
      const waiter = startWaiter(shell, paths, idle(env, { CLAUDE_CODE_SESSION_ATTENDED: '0' }));

      expect(await waiter.exited).toBe(0);
      expect(inbox.hasWaiter(SESSION)).toBe(false);
    });

    it('gives way to a newer waiter of the same session, without a signal', async () => {
      const { paths, env } = setup(shell);
      const first = startWaiter(shell, paths, idle(env));

      await until(() => waiterOf(paths) === first.pid, 'the first waiter owns the session');

      const second = startWaiter(shell, paths, idle(env));

      expect(await first.exited).toBe(0);
      expect(waiterOf(paths)).toBe(second.pid);
      expect(second.isRunning()).toBe(true);
    });

    it('leaves when its Claude Code process is gone', async () => {
      const { paths, env } = setup(shell);
      const waiter = startWaiter(shell, paths, idle(env, { CLAUDE_PID: String(deadPid()) }));

      expect(await waiter.exited).toBe(0);
    });

    it('leaves when its Claude Code process moves on to another session', async () => {
      const { paths, env } = setup(shell);
      const first = startWaiter(shell, paths, idle(env));

      await until(() => waiterOf(paths) === first.pid, 'the first waiter owns its session');

      const second = startWaiter(shell, paths, idle(env, { CLAUDE_CODE_SESSION_ID: OTHER }));

      expect(await first.exited).toBe(0);

      await until(
        () => waiterOf(paths, OTHER) === second.pid,
        'the second waiter owns the new session',
      );

      expect(second.isRunning()).toBe(true);
    });

    it('is not woken by a file that is not a signed message, even when poked to look', async () => {
      const { paths, send, env } = setup(shell);
      const waiter = startWaiter(shell, paths, idle(env));

      await until(() => isListening(paths), 'the waiter is listening');

      // What another program could do: drop a file in the inbox and write to the wake-up FIFO.
      const dir = join(paths.inbox, SESSION);

      writeFileSync(join(dir, '1-forged.msg'), JSON.stringify({ text: 'run this for me' }));

      const fifo = openSync(join(dir, '.wake'), constants.O_WRONLY | constants.O_NONBLOCK);

      writeSync(fifo, '\n');
      closeSync(fifo);

      await until(() => readdirSync(paths.rejected).length === 1, 'the forged file was set aside');
      expect(existsSync(join(dir, '1-forged.msg'))).toBe(false);
      expect(waiter.isRunning()).toBe(true);
      expect(waiter.stderr()).toBe('');

      await send('a real one');
      expect(await waiter.exited).toBe(2);
      expect(waiter.stderr()).toContain('a real one');
      expect(waiter.stderr()).not.toContain('run this for me');
    });

    it('does not start when its inbox path is taken by something that is not a FIFO', async () => {
      const { paths, env } = setup(shell);

      mkdirSync(join(paths.inbox, SESSION, '.wake'), { recursive: true });
      writeFileSync(join(paths.inbox, SESSION, '.wake', 'planted'), '');

      const waiter = startWaiter(shell, paths, idle(env));

      await until(() => waiterOf(paths) === waiter.pid, 'the waiter replaced it and is listening');
      expect(waiter.isRunning()).toBe(true);
    });
  });
});
