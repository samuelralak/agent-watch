/**
 * Two sources report the same session (hooks live, transcripts for history). The store shows
 * each thing once, in time order, and links each subagent to the call that spawned it.
 */
import { describe, expect, it } from 'vitest';
import { isStillAnswering } from '../../src/domain/reply.js';
import { visibleAgents } from '../../src/domain/session.js';
import { Store } from '../../src/domain/store.js';
import { event, MINUTE } from '../helpers/events.js';

const T0 = 1_800_000_000_000;

const mainKinds = (store: Store) =>
  store
    .session('S')
    .main.timeline.latest(50)
    .map((e) => e.kind);

describe('one thing reported by both sources', () => {
  it('shows a tool call once, whichever source reports it first', () => {
    const store = new Store();

    store.apply(event('tool.started', T0, { toolUseId: 't1', tool: 'Bash', summary: 'make' }));

    store.apply(
      event('tool.started', T0, {
        origin: 'transcript',
        toolUseId: 't1',
        tool: 'Bash',
        summary: 'make',
      }),
    );

    store.apply(
      event('tool.ended', T0 + 500, { toolUseId: 't1', tool: 'Bash', ok: true, result: 'ok' }),
    );

    store.apply(
      event('tool.ended', T0 + 500, {
        origin: 'transcript',
        toolUseId: 't1',
        tool: 'Bash',
        ok: true,
        result: 'ok',
      }),
    );

    store.apply(
      event('tool.started', T0 + 900, {
        origin: 'transcript',
        toolUseId: 't1',
        tool: 'Bash',
        summary: 'late',
      }),
    );

    const main = store.session('S').main;

    expect(main.callCount).toBe(1);
    expect(main.openCalls.size).toBe(0);
    expect(mainKinds(store)).toEqual(['tool']);
  });

  it('shows a prompt, a notice and a coordinator message once', () => {
    const store = new Store();

    for (const origin of ['hook', 'transcript'] as const) {
      store.apply(event('prompt.submitted', T0, { origin, text: 'fix the build' }));

      store.apply(
        event('notice', T0 + 10, { origin, text: 'Background command "tests" completed' }),
      );

      store.apply(
        event('message.received', T0 + 20, { origin, agentId: 'A', text: 'Re-check the fix' }),
      );
    }

    expect(mainKinds(store)).toEqual(['prompt', 'notice']);

    expect(
      store
        .session('S')
        .agents.get('A')!
        .timeline.latest(10)
        .map((e) => e.kind),
    ).toEqual(['message']);
  });

  it('still shows the same words again when they are said much later', () => {
    const store = new Store();

    store.apply(event('prompt.submitted', T0, { text: 'continue' }));
    store.apply(event('prompt.submitted', T0 + 10 * MINUTE, { text: 'continue' }));
    expect(mainKinds(store)).toEqual(['prompt', 'prompt']);
  });
});

describe('the feed', () => {
  it('lists the newest events by time, whatever order history was loaded in', () => {
    const store = new Store();

    for (let i = 0; i < 8; i++) {
      store.apply(
        event('narration', T0 - 40_000 + i * 1000, { origin: 'transcript', text: `main ${i}` }),
      );
    }

    // An agent that finished five minutes ago is loaded after the main transcript.
    store.apply(
      event('agent.started', T0 - 300_000, {
        origin: 'transcript',
        agentId: 'old',
        agentType: 'Explore',
      }),
    );

    for (let i = 0; i < 8; i++) {
      store.apply(
        event('narration', T0 - 299_000 + i * 100, {
          origin: 'transcript',
          agentId: 'old',
          text: `old ${i}`,
        }),
      );
    }

    const newest = store.feed.latest(6).map((entry) => ('text' in entry ? entry.text : entry.kind));

    expect(newest).toEqual(['main 2', 'main 3', 'main 4', 'main 5', 'main 6', 'main 7']);
  });
});

describe('linking a subagent to the call that spawned it', () => {
  const spawn = (description: string) => ({
    agentType: 'Explore',
    description,
    prompt: `do ${description}`,
    background: true,
  });

  it('corrects the match when parallel spawns of one type start in the other order', () => {
    const store = new Store();

    store.apply(
      event('tool.started', T0, {
        toolUseId: 'call1',
        tool: 'Agent',
        summary: '',
        spawn: spawn('first'),
      }),
    );

    store.apply(
      event('tool.started', T0 + 1, {
        toolUseId: 'call2',
        tool: 'Agent',
        summary: '',
        spawn: spawn('second'),
      }),
    );

    store.apply(event('agent.started', T0 + 2, { agentId: 'B', agentType: 'Explore' }));
    store.apply(event('agent.started', T0 + 3, { agentId: 'A', agentType: 'Explore' }));

    const agents = store.session('S').agents;

    expect(agents.get('B')!.description).toBe('first'); // provisional: oldest call of that type

    store.apply(
      event('tool.ended', T0 + 4, {
        toolUseId: 'call2',
        tool: 'Agent',
        ok: true,
        result: '',
        spawned: { agentId: 'B', completed: false },
      }),
    );

    expect(agents.get('B')).toMatchObject({ description: 'second', linked: true });
    expect(agents.get('A')!.description).toBe('first');

    store.apply(
      event('tool.ended', T0 + 5, {
        toolUseId: 'call1',
        tool: 'Agent',
        ok: true,
        result: '',
        spawned: { agentId: 'A', completed: false },
      }),
    );

    expect(agents.get('A')!.linked).toBe(true);
    expect(store.session('S').pendingSpawns).toHaveLength(0);
  });

  it("does not lend a denied spawn's description to the next agent of that type", () => {
    const store = new Store();

    store.apply(
      event('tool.started', T0, {
        toolUseId: 'denied',
        tool: 'Agent',
        summary: '',
        spawn: spawn('denied task'),
      }),
    );

    store.apply(event('turn.ended', T0 + 1000)); // the call never returned: it was denied

    store.apply(
      event('tool.started', T0 + 2000, {
        toolUseId: 'real',
        tool: 'Agent',
        summary: '',
        spawn: spawn('real task'),
      }),
    );

    store.apply(event('agent.started', T0 + 2100, { agentId: 'A', agentType: 'Explore' }));

    expect(store.session('S').agents.get('A')!.description).toBe('real task');
  });

  it('drops the spawn of an Agent call that failed', () => {
    const store = new Store();

    store.apply(
      event('tool.started', T0, {
        toolUseId: 'failed',
        tool: 'Agent',
        summary: '',
        spawn: spawn('failed task'),
      }),
    );

    store.apply(
      event('tool.ended', T0 + 100, {
        toolUseId: 'failed',
        tool: 'Agent',
        ok: false,
        result: 'error',
      }),
    );

    expect(store.session('S').pendingSpawns).toHaveLength(0);
  });

  it('shows how long an agent ran when only its finished call was seen', () => {
    const store = new Store();

    store.apply(
      event('tool.started', T0, {
        toolUseId: 'call1',
        tool: 'Agent',
        summary: '',
        spawn: { ...spawn('audit'), background: false },
      }),
    );

    store.apply(
      event('tool.ended', T0 + 90_000, {
        toolUseId: 'call1',
        tool: 'Agent',
        ok: true,
        result: 'done',
        spawned: { agentId: 'A', agentType: 'Explore', completed: true, totalTokens: 24_000 },
      }),
    );

    const agent = store.session('S').agents.get('A')!;

    expect(agent).toMatchObject({
      phase: 'finished',
      description: 'audit',
      runStartedAt: T0,
      endedAt: T0 + 90_000,
    });
  });

  it('counts a background agent as work its spawner is waiting on', () => {
    const store = new Store();

    store.apply(event('agent.started', T0, { agentId: 'parent', agentType: 'general-purpose' }));

    store.apply(
      event('tool.started', T0 + 10, {
        agentId: 'parent',
        toolUseId: 'call1',
        tool: 'Agent',
        summary: '',
        spawn: spawn('child task'),
      }),
    );

    store.apply(event('agent.started', T0 + 20, { agentId: 'child', agentType: 'Explore' }));

    store.apply(
      event('tool.ended', T0 + 30, {
        agentId: 'parent',
        toolUseId: 'call1',
        tool: 'Agent',
        ok: true,
        result: '',
        spawned: { agentId: 'child', completed: false },
      }),
    );

    store.apply(event('agent.stopped', T0 + 40, { agentId: 'parent', runningTaskIds: ['child'] }));

    const agents = store.session('S').agents;

    expect(agents.get('parent')!.phase).toBe('waiting');
    expect(agents.get('child')!.parentAgentId).toBe('parent');
  });
});

describe('what is and is not shown', () => {
  it("leaves out Claude Code's internal helper agents", () => {
    const store = new Store();

    store.apply(event('agent.stopped', T0, { agentId: 'internal', report: 'check on the agent' }));
    expect(store.session('S').agents.size).toBe(0);
  });

  it('keeps an agent that finished recently, and forgets it later', () => {
    const store = new Store();

    store.apply(event('agent.started', T0, { agentId: 'A', agentType: 'Explore' }));
    store.apply(event('agent.stopped', T0 + 1000, { agentId: 'A', runningTaskIds: [] }));

    const session = store.session('S');

    expect(visibleAgents(session, T0 + 5 * MINUTE, 10 * MINUTE)).toHaveLength(1);
    expect(visibleAgents(session, T0 + 20 * MINUTE, 10 * MINUTE)).toHaveLength(0);
    store.prune(T0 + 2 * 60 * MINUTE, 60 * MINUTE);
    expect(session.agents.size).toBe(0);
  });

  it('forgets a session that is gone and has nothing left to show', () => {
    const store = new Store();

    store.syncListing([{ sessionId: 'S' }], T0);
    store.syncListing([], T0 + 1);
    store.syncListing([], T0 + 2);
    store.prune(T0 + 2 * 60 * MINUTE, 60 * MINUTE);
    expect(store.sessions.has('S')).toBe(false);
  });
});

describe('a message the user sent', () => {
  const message = {
    nonce: 'n1',
    text: 'skip the rerun',
    createdAt: T0,
    expiresAt: T0 + MINUTE,
    aboutAgentId: null,
    aboutLabel: null,
    woke: true,
    status: 'queued' as const,
    deliveredAt: null,
    via: null,
    replies: [],
  };

  it('is marked delivered, and what the main agent says next is kept as the reply', () => {
    const store = new Store();

    store.addOutbox('S', { ...message, replies: [] });

    store.apply(
      event('narration', T0 + 500, { origin: 'transcript', text: 'said before delivery' }),
    );

    store.apply(
      event('message.delivered', T0 + 1000, {
        sender: 'user',
        nonce: 'n1',
        via: 'wake',
        text: 'skip the rerun',
      }),
    );

    store.apply(
      event('turn.ended', T0 + 4000, {
        text: "I didn't act on that: it came inside a notification.",
      }),
    );

    store.apply(event('turn.ended', T0 + 9000, { text: 'a later turn' }));

    const sent = store.session('S').outbox[0]!;

    expect(sent).toMatchObject({ status: 'delivered', via: 'wake', deliveredAt: T0 + 1000 });

    expect(sent.replies.map((part) => part.text)).toEqual([
      "I didn't act on that: it came inside a notification.",
    ]);
  });

  const delivered = (store: Store, via: 'tool' | 'turn-end' | 'wake', at = T0 + 1000) =>
    store.apply(
      event('message.delivered', at, { sender: 'user', nonce: 'n1', via, text: 'skip the rerun' }),
    );

  it('has everything the main agent says until its turn ends as its reply, not only the first words', () => {
    const store = new Store();

    store.addOutbox('S', { ...message, replies: [] });
    delivered(store, 'tool');
    store.apply(event('narration', T0 + 2000, { text: 'Understood, skipping it.' }));

    store.apply(
      event('tool.started', T0 + 3000, { toolUseId: 't1', tool: 'Bash', summary: 'make' }),
    );

    store.apply(event('narration', T0 + 5000, { text: 'Done:\n\n- rerun skipped\n- build green' }));

    store.apply(
      event('turn.ended', T0 + 6000, { text: 'Done:\n\n- rerun skipped\n- build green' }),
    );

    store.apply(event('narration', T0 + 60_000, { text: 'something from a later turn' }));

    expect(store.session('S').outbox[0]?.replies.map((part) => part.text)).toEqual([
      'Understood, skipping it.\n\nDone:\n\n- rerun skipped\n- build green',
    ]);
  });

  it('has what the main agent says when its work comes back as the rest of its reply', () => {
    const store = new Store();

    store.addOutbox('S', { ...message, replies: [] });
    delivered(store, 'tool');

    // A holding answer: the turn ends while work it started is still running.
    store.apply(
      event('turn.ended', T0 + 3000, {
        text: 'I have started the review and will report when it is done.',
        runningTaskIds: ['bg1'],
      }),
    );

    const sent = store.session('S').outbox[0]!;

    expect(isStillAnswering(store.session('S'), sent)).toBe(true);

    // The transcript reports the same words a moment later: they are not a new part.
    store.apply(
      event('narration', T0 + 2900, {
        text: 'I have started the review and will report when it is done.',
        origin: 'transcript',
      }),
    );

    // The work comes back, and the agent says what the message was sent for.
    store.apply(event('narration', T0 + 60_000, { text: 'The review found two issues.' }));

    store.apply(
      event('turn.ended', T0 + 61_000, {
        text: 'The review found two issues.',
        runningTaskIds: [],
      }),
    );

    // Nothing is left running: what it says from here is no longer about the message.
    store.apply(event('narration', T0 + 300_000, { text: 'Unrelated, much later.' }));

    expect(sent.replies.map((part) => part.text)).toEqual([
      'I have started the review and will report when it is done.',
      'The review found two issues.',
    ]);

    expect(isStillAnswering(store.session('S'), sent)).toBe(false);
  });

  it('does not wait on work that was already running when the message came', () => {
    const store = new Store();

    // A development server has been running in the background since before the message.
    store.apply(event('turn.ended', T0, { text: 'Server started.', runningTaskIds: ['server'] }));
    store.addOutbox('S', { ...message, replies: [] });
    delivered(store, 'wake');

    store.apply(
      event('turn.ended', T0 + 3000, { text: 'Done: skipped it.', runningTaskIds: ['server'] }),
    );

    const sent = store.session('S').outbox[0]!;

    // The server still runs, but the answer has been given: nothing more is expected.
    expect(isStillAnswering(store.session('S'), sent)).toBe(false);

    store.apply(event('narration', T0 + 600_000, { text: 'Unrelated, ten minutes later.' }));
    expect(sent.replies.map((part) => part.text)).toEqual(['Done: skipped it.']);

    // Work started since the message is another matter, with the server still there.
    const other = new Store();

    other.apply(event('turn.ended', T0, { text: 'Server started.', runningTaskIds: ['server'] }));
    other.addOutbox('S', { ...message, replies: [] });
    delivered(other, 'wake');

    other.apply(
      event('turn.ended', T0 + 3000, {
        text: 'Started the review.',
        runningTaskIds: ['server', 'review'],
      }),
    );

    expect(isStillAnswering(other.session('S'), other.session('S').outbox[0]!)).toBe(true);
  });

  it('stops following the agent once the user speaks to the session itself', () => {
    const store = new Store();

    store.addOutbox('S', { ...message, replies: [] });
    delivered(store, 'tool');

    store.apply(
      event('turn.ended', T0 + 3000, { text: 'Started; I will report.', runningTaskIds: ['bg1'] }),
    );

    store.apply(event('prompt.submitted', T0 + 5000, { text: 'Never mind that, look at this.' }));
    store.apply(event('narration', T0 + 6000, { text: 'Looking at this instead.' }));

    expect(store.session('S').outbox[0]?.replies.map((part) => part.text)).toEqual([
      'Started; I will report.',
    ]);
  });

  it('is not closed by the turn end that delivered it', () => {
    const store = new Store();

    store.addOutbox('S', { ...message, replies: [] });
    // Handed over as a turn ended: that turn end is reported around the same moment.
    delivered(store, 'turn-end', T0 + 1000);
    store.apply(event('turn.ended', T0 + 900, { text: 'what it said before the message' }));
    store.apply(event('narration', T0 + 3000, { text: 'Now skipping the rerun.' }));
    store.apply(event('turn.ended', T0 + 4000, { text: 'Now skipping the rerun.' }));

    expect(store.session('S').outbox[0]?.replies.map((part) => part.text)).toEqual([
      'Now skipping the rerun.',
    ]);
  });

  it('keeps a rejected message file visible', () => {
    const store = new Store();

    store.apply(
      event('message.rejected', T0, { file: '1-forged.msg', reason: 'signature does not match' }),
    );

    expect(store.rejections).toHaveLength(1);
    expect(mainKinds(store)).toEqual(['rejected']);
  });
});
