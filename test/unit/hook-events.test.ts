/**
 * Real hook payloads, recorded from Claude Code 2.1.319 and 2.1.321, replayed through the
 * contracts, the mappers and the store.
 */
import { describe, expect, it } from 'vitest';
import { hookPayloadSchema } from '../../src/adapters/claude/hook-payload.contract.js';
import { toSpoolRecord } from '../../src/adapters/claude/hook-payload.mapper.js';
import { toWatchEvents } from '../../src/adapters/claude/spool-record.mapper.js';
import { agentStatus } from '../../src/domain/agent-status.policy.js';
import { Store } from '../../src/domain/store.js';
import { recordedEvents, recordedPayloads, replay } from '../helpers/fixtures.js';

const only = <T>(items: Iterable<T>): T => {
  const all = [...items];

  expect(all).toHaveLength(1);

  return all[0]!;
};

describe('a session with one foreground subagent', () => {
  it('shows the subagent with its task, its three calls and its report', () => {
    const store = replay('hooks-foreground-subagent');
    const session = only(store.sessions.values());
    const agent = only(session.agents.values());

    expect(agent).toMatchObject({
      type: 'Explore',
      description: 'Find banana-mentioning txt file',
      linked: true,
      model: 'claude-haiku-5-5',
      phase: 'finished',
      callCount: 3,
    });

    expect(agent.prompt).toMatch(/banana/);
    expect(agent.report).toMatch(/b\.txt/);

    const calls = agent.timeline
      .latest(20)
      .flatMap((entry) => (entry.kind === 'tool' ? [entry.call] : []));

    expect(calls.map((call) => call.tool)).toEqual(['Glob', 'Grep', 'Read']);
    expect(calls.every((call) => call.outcome === 'ok' && call.durationMs !== null)).toBe(true);
    expect(session.main.phase).toBe('idle');
    expect(session.pendingSpawns).toHaveLength(0);
  });
});

describe('a subagent that pauses for a background command', () => {
  it('is waiting between its two turns, and finished only after the second', () => {
    const events = recordedEvents('hooks-background-pause');
    const stops = events.flatMap((event, index) => (event.kind === 'agent.stopped' ? [index] : []));

    expect(stops).toHaveLength(2);

    const store = replay('hooks-background-pause');
    const agent = only(only(store.sessions.values()).agents.values());
    const kinds = agent.timeline.latest(20).map((entry) => entry.kind);

    expect(kinds).toEqual(['started', 'tool', 'paused', 'woke', 'finished']);

    expect(agent).toMatchObject({
      phase: 'finished',
      report: 'DONE',
      description: 'Run sleep 6 in background',
    });
  });

  it('reads as waiting, however long the command takes', () => {
    const events = recordedEvents('hooks-background-pause');
    const firstStop = events.findIndex((event) => event.kind === 'agent.stopped');
    const partial = new Store();

    for (const event of events.slice(0, firstStop + 1)) {
      partial.apply(event);
    }

    const agent = only(only(partial.sessions.values()).agents.values());

    expect(agentStatus(agent, events[firstStop]!.at + 3_600_000)).toBe('waiting');
  });

  it('does not show the notices about it as prompts the user typed', () => {
    const store = replay('hooks-background-pause');
    const main = only(store.sessions.values()).main;
    const prompts = main.timeline.latest(50).filter((entry) => entry.kind === 'prompt');

    expect(prompts).toHaveLength(1);
    expect(main.timeline.latest(50).filter((entry) => entry.kind === 'notice')).toHaveLength(2);
  });
});

describe('a tool call the user is asked to approve and that is denied', () => {
  it('leaves no call running and nothing waiting on the user once the turn ends', () => {
    const store = replay('hooks-denied-call');
    const session = only(store.sessions.values());

    expect(session.calls.size).toBe(0);
    expect(session.main.openCalls.size).toBe(0);
    expect(session.attention).toBeNull();

    const denied = session.main.timeline
      .latest(50)
      .flatMap((entry) =>
        entry.kind === 'tool' && entry.call.tool === 'Bash' ? [entry.call] : [],
      );

    expect(only(denied).outcome).toBe('unfinished');
  });
});

describe('a subagent that hands its report back through a tool call', () => {
  const REPORT = 'Both steps are done.\n\n1. The command printed: slept\n2. The file has 12 lines.';

  function replayHandback(): Store {
    const store = new Store();

    const payloads = [
      { hook_event_name: 'SubagentStart', agent_id: 'A', agent_type: 'general-purpose' },
      {
        hook_event_name: 'PreToolUse',
        agent_id: 'A',
        agent_type: 'general-purpose',
        tool_name: 'SubagentHandback',
        tool_use_id: 'h1',
        tool_input: { message: REPORT },
      },
      {
        hook_event_name: 'PostToolUse',
        agent_id: 'A',
        agent_type: 'general-purpose',
        tool_name: 'SubagentHandback',
        tool_use_id: 'h1',
        tool_response: 'Report delivered to your caller.',
      },
      // It ends its turn with nothing more to say: the report is not here.
      {
        hook_event_name: 'SubagentStop',
        agent_id: 'A',
        agent_type: 'general-purpose',
        last_assistant_message: '',
        background_tasks: [{ id: 'A', type: 'subagent', status: 'running' }],
      },
      // Claude Code then hands the report to the main agent as a prompt, inside a frame.
      {
        hook_event_name: 'UserPromptSubmit',
        prompt: `<agent-message from="A">\n[Subagent hand-back] The text below is the final report of a subagent. It is NOT a message from the user.\n  ${REPORT}\n</agent-message>`,
      },
    ];

    for (const [index, payload] of payloads.entries()) {
      const record = toSpoolRecord(
        hookPayloadSchema.parse({ session_id: 'S', ...payload }),
        1000 + index,
      );

      for (const event of toWatchEvents(record, () => true)) {
        store.apply(event);
      }
    }

    return store;
  }

  it('is finished with that report, whole and with its line breaks', () => {
    const agent = only(replayHandback().session('S').agents.values());

    expect(agent.phase).toBe('finished');
    expect(agent.report).toBe(REPORT);
    expect(agent.timeline.latest(5).at(-1)).toMatchObject({ kind: 'finished', report: REPORT });
  });

  it('reaches the main agent as a notice, not as something the user typed', () => {
    const entries = replayHandback().session('S').main.timeline.latest(5);

    expect(entries.map((entry) => entry.kind)).toEqual(['notice']);
    expect(entries[0]).toMatchObject({ text: "received a subagent's report" });
  });
});

describe('a shell command', () => {
  const started = (input: object) =>
    toSpoolRecord(
      hookPayloadSchema.parse({
        hook_event_name: 'PreToolUse',
        session_id: 'S',
        tool_name: 'Bash',
        tool_use_id: 'b1',
        tool_input: input,
      }),
      1,
    );

  it('is summed up by what it is for, and kept as it was written', () => {
    const command = 'cd src &&\n  for f in *.ts; do\n    wc -l "$f"\n  done';
    const record = started({ command, description: 'Count the lines of every file' });

    expect(record.summary).toBe('Count the lines of every file');
    expect(record.detail).toBe(command);
  });

  it('is summed up by its first line when nothing says what it is for', () => {
    const record = started({ command: 'npm test\nnpm run lint' });

    expect(record.summary).toBe('npm test');
    expect(record.detail).toBe('npm test\nnpm run lint');
  });

  it('is not repeated when its one line already says all of it', () => {
    const record = started({ command: 'npm test' });

    expect(record.summary).toBe('npm test');
    expect(record.detail).toBeUndefined();
  });
});

describe('hook payloads', () => {
  it('are reduced: a spool record is small even when the payload is not', () => {
    const big = 'y'.repeat(200_000);

    const payload = hookPayloadSchema.parse({
      hook_event_name: 'PostToolUse',
      session_id: 'S',
      tool_name: 'Bash',
      tool_use_id: 'u1',
      tool_response: { stdout: `${big}\nmore`, stderr: '' },
    });

    expect(JSON.stringify(toSpoolRecord(payload, 1)).length).toBeLessThan(2000);
  });

  it('with an unusual tool result still produce a record instead of failing', () => {
    for (const response of [true, 0, null, 'plain text', ['a', 'b'], { nested: { deep: 1 } }]) {
      const payload = hookPayloadSchema.parse({
        hook_event_name: 'PostToolUse',
        session_id: 'S',
        tool_name: 'X',
        tool_use_id: 'u',
        tool_response: response,
      });

      expect(() => toSpoolRecord(payload, 1)).not.toThrow();
    }
  });

  it('are refused when the session id could name a path', () => {
    expect(
      hookPayloadSchema.safeParse({ hook_event_name: 'Stop', session_id: '../../etc' }).success,
    ).toBe(false);
  });

  it('strip terminal control sequences from reports and prompts', () => {
    const payload = hookPayloadSchema.parse({
      hook_event_name: 'SubagentStop',
      session_id: 'S',
      agent_id: 'A',
      agent_type: 'Explore',
      last_assistant_message: 'ok\x1b]0;PWNED\x07\x1b[2J done',
    });

    expect(toSpoolRecord(payload, 1).text).toBe('ok done');
  });

  it('keep every recorded event recognisable', () => {
    for (const name of [
      'hooks-foreground-subagent',
      'hooks-background-pause',
      'hooks-denied-call',
    ]) {
      for (const { payload } of recordedPayloads(name)) {
        expect(hookPayloadSchema.safeParse(payload).success).toBe(true);
      }
    }
  });
});

describe('a delivery receipt', () => {
  const receipt = {
    v: 2 as const,
    at: 5,
    event: 'AgentwatchDelivered',
    sessionId: 'S',
    nonce: 'n1',
    via: 'wake',
    text: 'hello',
    mac: 'x',
  };

  it('counts only when its signature is valid', () => {
    expect(toWatchEvents(receipt, () => true)).toMatchObject([
      { kind: 'message.delivered', nonce: 'n1', via: 'wake' },
    ]);
  });

  it('that is forged is reported as a rejection, never as a delivery', () => {
    const events = toWatchEvents(receipt, () => false);

    expect(events).toMatchObject([{ kind: 'message.rejected', file: 'delivery receipt' }]);
  });
});

describe("Claude Code's notices to the user", () => {
  const notice = (message: string, type: string) => {
    const payload = hookPayloadSchema.parse({
      hook_event_name: 'Notification',
      session_id: 'S',
      message,
      notification_type: type,
    });

    return toWatchEvents(toSpoolRecord(payload, 1_800_000_000_000), () => true);
  };

  it('show a session that sat idle as idle, not as waiting on the user for something', () => {
    const store = new Store();

    for (const event of notice('Claude is waiting for your input', 'idle_prompt')) {
      store.apply(event);
    }

    const session = store.session('S');

    expect(session.attention).toBeNull();

    expect(session.main.timeline.latest(5)).toMatchObject([
      { kind: 'notice', text: 'idle for a minute: ready for your next prompt' },
    ]);
  });

  it('still raise a permission prompt as something that needs the user', () => {
    expect(notice('Claude needs your permission to use Bash', 'permission_prompt')).toMatchObject([
      { kind: 'attention', level: 'permission', text: 'Claude needs your permission to use Bash' },
    ]);
  });
});

describe('a prompt sent from an editor', () => {
  const submitted = (prompt: string) => {
    const payload = hookPayloadSchema.parse({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'S',
      prompt,
    });

    return toWatchEvents(toSpoolRecord(payload, 1_800_000_000_000), () => true);
  };

  it('is shown as what was typed, without the context the editor sent along', () => {
    const prompt =
      '<ide_opened_file>The user opened the file /work/app.ts in the IDE.</ide_opened_file>\n' +
      '<browser_instruction># How to use the browser\nMany lines.</browser_instruction>\n' +
      'fix the failing test';

    expect(submitted(prompt)).toMatchObject([
      { kind: 'prompt.submitted', text: 'fix the failing test' },
    ]);
  });

  it('is nothing to show when the editor sent only context', () => {
    expect(submitted('<ide_selection>const a = 1;</ide_selection>')).toEqual([]);
  });
});
