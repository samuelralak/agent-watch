/**
 * What the store shows about an agent's life: working, waiting on its own background work,
 * finished, continued, interrupted.
 */
import { describe, expect, it } from 'vitest';
import { agentStatus } from '../../src/domain/agent-status.policy.js';
import { needsUser } from '../../src/domain/session.js';
import { Store } from '../../src/domain/store.js';
import { event, MINUTE, SECOND } from '../helpers/events.js';

const T0 = 1_800_000_000_000;

function storeWithAgent(agentId = 'A') {
  const store = new Store();

  store.apply(event('agent.started', T0, { agentId, agentType: 'general-purpose' }));

  const agent = () => store.session('S').agents.get(agentId)!;

  const kinds = () =>
    agent()
      .timeline.latest(50)
      .map((entry) => entry.kind);

  return { store, agent, kinds };
}

describe('an agent pausing for background work', () => {
  it('is shown as waiting, not finished, while a command it started is still running', () => {
    const { store, agent, kinds } = storeWithAgent();

    store.apply(
      event('tool.started', T0 + 1000, {
        agentId: 'A',
        toolUseId: 't1',
        tool: 'Bash',
        summary: 'sleep 45',
      }),
    );

    store.apply(
      event('tool.ended', T0 + 1100, {
        agentId: 'A',
        toolUseId: 't1',
        tool: 'Bash',
        ok: true,
        result: '',
        backgroundTaskId: 'shell-1',
      }),
    );

    store.apply(
      event('agent.stopped', T0 + 2000, { agentId: 'A', runningTaskIds: ['A', 'shell-1'] }),
    );

    expect(agent().phase).toBe('waiting');
    expect(agentStatus(agent(), T0 + 10 * MINUTE)).toBe('waiting');
    expect(kinds()).toEqual(['started', 'tool', 'paused']);
  });

  it('continues the same run when it wakes, with its clock unchanged', () => {
    const { store, agent, kinds } = storeWithAgent();

    store.apply(
      event('tool.ended', T0 + 1100, {
        agentId: 'A',
        toolUseId: 't1',
        tool: 'Bash',
        ok: true,
        result: '',
        backgroundTaskId: 'shell-1',
      }),
    );

    store.apply(event('agent.stopped', T0 + 2000, { agentId: 'A', runningTaskIds: ['shell-1'] }));

    store.apply(
      event('agent.started', T0 + 47_000, { agentId: 'A', agentType: 'general-purpose' }),
    );

    expect(agent().phase).toBe('working');
    expect(agent().runStartedAt).toBe(T0);
    expect(kinds().at(-1)).toBe('woke');
  });

  it('is finished, with its report, once it stops with none of its work still running', () => {
    const { store, agent, kinds } = storeWithAgent();

    store.apply(
      event('tool.ended', T0 + 1100, {
        agentId: 'A',
        toolUseId: 't1',
        tool: 'Bash',
        ok: true,
        result: '',
        backgroundTaskId: 'shell-1',
      }),
    );

    store.apply(event('agent.stopped', T0 + 2000, { agentId: 'A', runningTaskIds: ['shell-1'] }));
    store.apply(event('agent.started', T0 + 47_000, { agentId: 'A' }));

    // Another agent's shell is still running in the session: not this agent's concern.
    store.apply(
      event('agent.stopped', T0 + 48_000, {
        agentId: 'A',
        report: 'DONE',
        runningTaskIds: ['shell-9'],
      }),
    );

    expect(agent().phase).toBe('finished');
    expect(agent().report).toBe('DONE');
    expect(kinds().filter((kind) => kind === 'finished')).toHaveLength(1);
  });

  it('is not woken by a narration line that arrives late from its transcript', () => {
    const { store, agent } = storeWithAgent();

    store.apply(
      event('tool.ended', T0 + 1100, {
        agentId: 'A',
        toolUseId: 't1',
        tool: 'Bash',
        ok: true,
        result: '',
        backgroundTaskId: 'shell-1',
      }),
    );

    store.apply(event('agent.stopped', T0 + 2000, { agentId: 'A', runningTaskIds: ['shell-1'] }));

    store.apply(
      event('narration', T0 + 2500, {
        agentId: 'A',
        origin: 'transcript',
        text: 'Waiting for the sleep.',
      }),
    );

    expect(agent().phase).toBe('waiting');
  });

  it('reads as waiting without hooks too, once it goes quiet after starting background work', () => {
    const { store, agent } = storeWithAgent();

    store.apply(
      event('tool.ended', T0 + 1100, {
        agentId: 'A',
        origin: 'transcript',
        toolUseId: 't1',
        tool: 'Bash',
        ok: true,
        result: '',
        backgroundTaskId: 'shell-1',
      }),
    );

    expect(agentStatus(agent(), T0 + 5 * SECOND)).toBe('working');
    expect(agentStatus(agent(), T0 + 10 * MINUTE)).toBe('waiting');
    store.apply(event('background.ended', T0 + 11 * MINUTE, { agentId: 'A', taskId: 'shell-1' }));
    expect(agentStatus(agent(), T0 + 20 * MINUTE)).toBe('stalled');
  });
});

describe('an agent continued after it finished', () => {
  it('starts a new run, and its clock restarts', () => {
    const { store, agent, kinds } = storeWithAgent();

    store.apply(
      event('agent.stopped', T0 + 5000, {
        agentId: 'A',
        report: 'first report',
        runningTaskIds: [],
      }),
    );

    store.apply(
      event('tool.started', T0 + MINUTE, {
        agentId: 'A',
        toolUseId: 't2',
        tool: 'Read',
        summary: 'a.ts',
      }),
    );

    expect(agent().phase).toBe('working');
    expect(agent().runStartedAt).toBe(T0 + MINUTE);
    expect(kinds()).toContain('resumed');
  });

  it('is not ended by the stop of an earlier run that arrives late', () => {
    const { store, agent } = storeWithAgent();

    store.apply(event('agent.stopped', T0 - 50, { agentId: 'A', runningTaskIds: [] }));
    expect(agent().phase).toBe('working');
  });
});

describe('a session that goes away', () => {
  it('is kept through one missed poll, and gone after two', () => {
    const store = new Store();

    store.syncListing([{ sessionId: 'S', name: 'alpha', status: 'busy' }], T0);
    store.syncListing([], T0 + 5000);
    expect(store.session('S').alive).toBe(true);
    store.syncListing([], T0 + 10_000);
    expect(store.session('S').alive).toBe(false);
  });

  it('leaves nothing running: its agents are interrupted and their calls closed', () => {
    const { store, agent, kinds } = storeWithAgent();

    store.syncListing([{ sessionId: 'S', status: 'busy' }], T0);

    store.apply(
      event('tool.started', T0 + 1000, {
        agentId: 'A',
        toolUseId: 't1',
        tool: 'Bash',
        summary: 'long build',
      }),
    );

    store.syncListing([], T0 + 5000);
    store.syncListing([], T0 + 10_000);

    expect(agent().phase).toBe('interrupted');
    expect(agent().openCalls.size).toBe(0);
    expect(agentStatus(agent(), T0 + 60 * MINUTE)).toBe('interrupted');
    expect(kinds().at(-1)).toBe('interrupted');

    expect(
      agent()
        .timeline.latest(10)
        .find((entry) => entry.kind === 'tool'),
    ).toMatchObject({
      call: { outcome: 'unfinished' },
    });
  });

  it('picks up where it was when it is resumed, and its interrupted agent can be continued', () => {
    const { store, agent } = storeWithAgent();

    store.syncListing([{ sessionId: 'S' }], T0);
    store.syncListing([], T0 + 5000);
    store.syncListing([], T0 + 10_000);
    store.syncListing([{ sessionId: 'S' }], T0 + MINUTE);

    expect(store.session('S').alive).toBe(true);
    expect(agent().phase).toBe('interrupted');
    store.apply(event('agent.started', T0 + 2 * MINUTE, { agentId: 'A' }));
    expect(agent().phase).toBe('working');
  });
});

describe('an agent the user interrupted', () => {
  it('is shown as interrupted, not as waiting on the background work it had started', () => {
    const { store, agent, kinds } = storeWithAgent();

    store.apply(
      event('tool.started', T0 + 1000, {
        agentId: 'A',
        toolUseId: 't1',
        tool: 'Bash',
        summary: 'make',
      }),
    );

    store.apply(
      event('tool.ended', T0 + 1100, {
        agentId: 'A',
        toolUseId: 't1',
        tool: 'Bash',
        ok: true,
        result: '',
        backgroundTaskId: 'shell-1',
      }),
    );

    store.apply(
      event('tool.started', T0 + 2000, {
        agentId: 'A',
        toolUseId: 't2',
        tool: 'Bash',
        summary: 'wait',
      }),
    );

    store.apply(event('agent.stopped', T0 + 3000, { agentId: 'A', interruptedBy: 'user' }));

    expect(agent().phase).toBe('interrupted');
    expect(agentStatus(agent(), T0 + 2 * 60 * MINUTE)).toBe('interrupted');
    expect(agent().openCalls.size).toBe(0);
    expect(agent().backgroundTaskIds.size).toBe(0);
    expect(kinds().at(-1)).toBe('interrupted');
  });

  it('starts a new run when it is continued afterwards', () => {
    const { store, agent, kinds } = storeWithAgent();

    store.apply(event('agent.stopped', T0 + 3000, { agentId: 'A', interruptedBy: 'user' }));

    store.apply(
      event('tool.started', T0 + MINUTE, {
        agentId: 'A',
        toolUseId: 't9',
        tool: 'Read',
        summary: 'a.ts',
      }),
    );

    expect(agent().phase).toBe('working');
    expect(agent().runStartedAt).toBe(T0 + MINUTE);
    expect(kinds()).toContain('resumed');
  });

  it('is not finished a second time by a stop reported afterwards', () => {
    const { store, agent, kinds } = storeWithAgent();

    store.apply(event('agent.stopped', T0 + 3000, { agentId: 'A', interruptedBy: 'user' }));
    store.apply(event('agent.stopped', T0 + 3500, { agentId: 'A', interruptedBy: 'user' }));

    expect(agent().phase).toBe('interrupted');
    expect(kinds().filter((kind) => kind === 'interrupted')).toHaveLength(1);
  });
});

describe('a tool call that is denied', () => {
  it('is closed when the main agent ends its turn, instead of running forever', () => {
    const store = new Store();

    store.apply(event('tool.started', T0, { toolUseId: 't1', tool: 'Bash', summary: 'touch x' }));

    store.apply(
      event('attention', T0 + 100, { level: 'permission', text: 'permission: Bash touch x' }),
    );

    store.apply(event('turn.ended', T0 + 3000));

    const session = store.session('S');

    expect(session.main.openCalls.size).toBe(0);
    expect(session.calls.size).toBe(0);
    expect(session.attention).toBeNull();
  });

  it('is closed when a subagent ends its turn', () => {
    const { store, agent } = storeWithAgent();

    store.apply(
      event('tool.started', T0 + 1000, {
        agentId: 'A',
        toolUseId: 't1',
        tool: 'Bash',
        summary: 'rm',
      }),
    );

    store.apply(event('agent.stopped', T0 + 2000, { agentId: 'A', runningTaskIds: [] }));
    expect(agent().openCalls.size).toBe(0);
  });
});

describe('"needs you"', () => {
  it('shows while the session list says a session is waiting on a prompt', () => {
    const store = new Store();

    store.syncListing([{ sessionId: 'S', status: 'waiting', waitingFor: 'permission prompt' }], T0);
    expect(needsUser(store.session('S'))).toBe(true);
  });

  it('clears as soon as the list says the session is busy again, long before the command ends', () => {
    const store = new Store();

    store.apply(
      event('tool.started', T0, { toolUseId: 't1', tool: 'Bash', summary: 'long build' }),
    );

    store.apply(
      event('attention', T0 + 100, { level: 'permission', text: 'permission: Bash long build' }),
    );

    store.syncListing(
      [{ sessionId: 'S', status: 'waiting', waitingFor: 'permission prompt' }],
      T0 + 500,
    );

    expect(needsUser(store.session('S'))).toBe(true);

    store.syncListing([{ sessionId: 'S', status: 'busy' }], T0 + 8000);
    expect(needsUser(store.session('S'))).toBe(false);
    expect(store.session('S').main.openCalls.size).toBe(1); // the approved command is still running
  });
});
