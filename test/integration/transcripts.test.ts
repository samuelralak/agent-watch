/**
 * Reading Claude Code's transcripts: history when a viewer opens, and what stays theirs to
 * report once a session's hooks are live.
 */
import { appendFileSync, utimesSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TranscriptSource } from '../../src/adapters/claude/transcript-source.js';
import { visibleAgents } from '../../src/domain/session.js';
import { Store } from '../../src/domain/store.js';
import { projectsFolder, record } from '../helpers/transcripts.js';

const NOW = Date.now();
const MINUTE = 60_000;

function setup() {
  const projects = projectsFolder();
  const store = new Store();

  const source = new TranscriptSource({
    projectsDir: projects.projectsDir,
    recentMs: 10 * MINUTE,
    emit: (event) => store.apply(event),
  });

  const mainKinds = (sessionId = 'S') =>
    store
      .session(sessionId)
      .main.timeline.latest(100)
      .map((entry) => entry.kind);

  return { projects, store, source, mainKinds };
}

const history = (at: number) => [
  record.prompt(at, 'please fix the build'),
  record.narration(at + 1000, 'Looking at the build now.'),
  record.toolUse(at + 2000, 'tu1', 'Bash', { command: 'make' }),
  record.toolResult(at + 3000, 'tu1'),
  record.narration(at + 4000, 'The build passes.'),
];

describe('history when a viewer opens', () => {
  it('shows prompts, tool calls and narration from before it opened', () => {
    const { projects, source, mainKinds } = setup();

    projects.writeMain('S', history(NOW - 5 * MINUTE));
    source.follow({ sessionId: 'S' });
    expect(mainKinds()).toEqual(['prompt', 'narration', 'tool', 'narration']);
  });

  it("is complete even when the session's hooks were live before its transcript was read", () => {
    const { projects, source, mainKinds } = setup();

    projects.writeMain('S', history(NOW - 5 * MINUTE));
    source.follow({ sessionId: 'S' });

    const withoutHooks = mainKinds();

    const second = setup();

    second.projects.writeMain('S', history(NOW - 5 * MINUTE));
    second.source.follow({ sessionId: 'S' });
    second.source.setLiveSince('S', NOW);
    expect(second.mainKinds()).toEqual(withoutHooks);
  });

  it("starts with a new session's first turn, the moment the file a hook named appears", () => {
    const projects = projectsFolder();
    const store = new Store();
    let clock = NOW;

    const source = new TranscriptSource({
      projectsDir: projects.projectsDir,
      recentMs: 10 * MINUTE,
      emit: (event) => store.apply(event),
      now: () => clock,
    });

    const named = { sessionId: 'S', transcriptPath: projects.mainPath('S') };

    expect(source.follow(named)).toBe(false); // started, but nothing said yet

    projects.writeMain('S', [record.narration(NOW, 'PONG')]);
    clock += 1000;
    expect(source.follow(named)).toBe(true);

    expect(
      store
        .session('S')
        .main.timeline.latest(10)
        .map((entry) => entry.kind),
    ).toEqual(['narration']);

    // With no file named by a hook, the projects folder is read again only once in a while.
    expect(source.follow({ sessionId: 'T' })).toBe(false);
    projects.writeMain('T', [record.narration(NOW, 'PING')]);
    clock += 1000;
    expect(source.follow({ sessionId: 'T' })).toBe(false);

    clock += 15_000;
    expect(source.follow({ sessionId: 'T' })).toBe(true);
  });

  it('is not replayed when a session drops out of the list and comes back', () => {
    const { projects, source, mainKinds } = setup();

    projects.writeMain('S', history(NOW - 5 * MINUTE));
    source.follow({ sessionId: 'S' });
    source.follow({ sessionId: 'S', startedAt: NOW }); // listed again, in a new process
    source.tick();
    expect(mainKinds()).toEqual(['prompt', 'narration', 'tool', 'narration']);

    projects.appendMain('S', [record.prompt(NOW, 'carry on')]);
    source.tick();
    expect(mainKinds()).toEqual(['prompt', 'narration', 'tool', 'narration', 'prompt']);
  });

  it('skips a malformed line instead of failing', () => {
    const { projects, source, mainKinds } = setup();

    projects.writeMain('S', history(NOW - 5 * MINUTE));

    appendFileSync(
      projects.mainPath('S'),
      'null\n{"type":7}\n[1,2]\n{"type":"assistant","timestamp":"not a date","message":{"content":[null]}}\n',
    );

    projects.appendMain('S', [record.narration(NOW, 'still here')]);
    expect(() => source.follow({ sessionId: 'S' })).not.toThrow();
    expect(mainKinds().at(-1)).toBe('narration');
  });
});

describe("once a session's hooks are live", () => {
  it('leaves tool calls and prompts to the hooks, and still reports narration and context size', () => {
    const { projects, store, source, mainKinds } = setup();

    projects.writeMain('S', history(NOW - 5 * MINUTE));
    source.follow({ sessionId: 'S' });
    source.setLiveSince('S', NOW);

    projects.appendMain('S', [
      record.prompt(NOW + 1000, 'a prompt the hooks report'),
      record.toolUse(NOW + 2000, 'tu2', 'Bash', { command: 'make test' }),
      record.toolResult(NOW + 3000, 'tu2'),
      record.narration(NOW + 4000, 'Tests pass.'),
    ]);

    source.tick();

    expect(mainKinds().slice(4)).toEqual(['narration']);
    expect(store.session('S').main.contextTokens).toBe(120);
  });

  it("still reports a coordinator's message to a subagent, which no hook carries", () => {
    const { projects, store, source } = setup();

    projects.writeMain('S', [record.prompt(NOW - MINUTE, 'go')]);

    projects.writeAgent(
      'S',
      'a1',
      { agentType: 'general-purpose', description: 'Build the thing' },
      [record.prompt(NOW - MINUTE, 'You are a builder.')],
    );

    source.follow({ sessionId: 'S' });
    source.setLiveSince('S', NOW);

    projects.appendAgent('S', 'a1', [
      record.coordinatorMessage(NOW + 1000, 'The coordinator sent a message: re-check the fix'),
    ]);

    source.rescan();

    const kinds = store
      .session('S')
      .agents.get('a1')!
      .timeline.latest(20)
      .map((entry) => entry.kind);

    expect(kinds).toContain('message');
  });
});

describe('subagents found in transcripts', () => {
  it('show their task, their prompt, and that they finished', () => {
    const { projects, store, source } = setup();

    projects.writeMain('S', [record.prompt(NOW - 2 * MINUTE, 'go')]);

    const meta = {
      agentType: 'Explore',
      description: 'Find the coach model',
      parentAgentId: undefined,
    };

    projects.writeAgent('S', 'a1', { ...meta, finished: true }, [
      record.prompt(NOW - 2 * MINUTE, 'Find where the coach is defined.'),
      record.toolUse(NOW - 110_000, 't1', 'Grep', { pattern: 'class Coach' }),
      record.toolResult(NOW - 109_000, 't1', 'app/models/coach.rb'),
    ]);

    source.follow({ sessionId: 'S' });

    const agent = store.session('S').agents.get('a1')!;

    expect(agent).toMatchObject({
      type: 'Explore',
      description: 'Find the coach model',
      phase: 'finished',
      callCount: 1,
    });

    expect(agent.prompt).toBe('Find where the coach is defined.');
  });

  it('appear on the next tick when they are the first of their session', () => {
    const { projects, store, source } = setup();

    projects.writeMain('S', [record.prompt(NOW - 1000, 'go')]);
    source.follow({ sessionId: 'S' });
    expect(store.session('S').agents.size).toBe(0);

    projects.writeAgent('S', 'a1', { agentType: 'Explore', description: 'First of the session' }, [
      record.prompt(NOW, 'task'),
    ]);

    projects.appendMain('S', [
      record.toolUse(NOW, 'spawn1', 'Agent', {
        subagent_type: 'Explore',
        description: 'First of the session',
      }),
    ]);

    source.tick();
    expect(store.session('S').agents.get('a1')?.description).toBe('First of the session');
  });

  it('left unfinished by an earlier process of the same session are not shown as running', () => {
    const { projects, store, source } = setup();

    projects.writeMain('S', [record.prompt(NOW - 3 * 60 * MINUTE, 'go')]);

    projects.writeAgent('S', 'old', { agentType: 'general-purpose', description: 'Orphaned' }, [
      record.prompt(NOW - 3 * 60 * MINUTE, 'task'),
    ]);

    const threeHoursAgo = new Date(NOW - 3 * 60 * MINUTE);

    for (const file of ['agent-old.jsonl', 'agent-old.meta.json']) {
      utimesSync(`${projects.projectsDir}/proj/S/subagents/${file}`, threeHoursAgo, threeHoursAgo);
    }

    source.follow({ sessionId: 'S', startedAt: NOW - MINUTE });
    expect(store.session('S').agents.size).toBe(0);
  });
});

describe("a background agent whose launch is still in the session's history", () => {
  /** The session started the agent in the background: all the main transcript says about it. */
  const launch = (at: number, agentId: string) => [
    record.prompt(at, 'look into it in the background'),
    record.toolUse(at + 1000, 'spawn1', 'Agent', {
      subagent_type: 'general-purpose',
      description: 'Look into it',
      run_in_background: true,
    }),
    record.toolResult(at + 2000, 'spawn1', 'Async agent launched', {
      isAsync: true,
      status: 'async_launched',
      agentId,
    }),
  ];

  const setFilesAge = (projectsDir: string, agentId: string, at: number) => {
    for (const file of [`agent-${agentId}.jsonl`, `agent-${agentId}.meta.json`]) {
      utimesSync(`${projectsDir}/proj/S/subagents/${file}`, new Date(at), new Date(at));
    }
  };

  it('is not shown as running when it finished too long ago to list', () => {
    const { projects, store, source } = setup();
    const launchedAt = NOW - 30 * MINUTE;

    projects.writeMain('S', launch(launchedAt, 'old'));

    const meta = { agentType: 'general-purpose', description: 'Look into it', finished: true };

    projects.writeAgent('S', 'old', meta, [record.prompt(launchedAt + 2000, 'Look into it.')]);
    setFilesAge(projects.projectsDir, 'old', NOW - 25 * MINUTE);
    source.follow({ sessionId: 'S', startedAt: NOW - 60 * MINUTE });

    const session = store.session('S');

    expect(session.agents.get('old')?.phase).toBe('finished');
    expect(session.main.backgroundTaskIds.size).toBe(0);
    expect(visibleAgents(session, NOW, 10 * MINUTE)).toEqual([]);
  });

  it('is shown as interrupted when an earlier process of the session left it unfinished', () => {
    const { projects, store, source } = setup();
    const launchedAt = NOW - 5 * MINUTE;

    projects.writeMain('S', launch(launchedAt, 'cut'));

    const meta = { agentType: 'general-purpose', description: 'Look into it' };

    projects.writeAgent('S', 'cut', meta, [record.prompt(launchedAt + 2000, 'Look into it.')]);
    setFilesAge(projects.projectsDir, 'cut', NOW - 4 * MINUTE);
    source.follow({ sessionId: 'S', startedAt: NOW - MINUTE }); // resumed a minute ago

    const agent = store.session('S').agents.get('cut');

    expect(agent?.phase).toBe('interrupted');

    expect(agent?.timeline.latest(3).at(-1)).toMatchObject({
      kind: 'interrupted',
      by: 'session-end',
    });

    expect(store.session('S').main.backgroundTaskIds.size).toBe(0);
  });

  it('is running when its own transcript says so', () => {
    const { projects, store, source } = setup();
    const launchedAt = NOW - 5 * MINUTE;

    projects.writeMain('S', launch(launchedAt, 'busy'));

    const meta = { agentType: 'general-purpose', description: 'Look into it' };

    projects.writeAgent('S', 'busy', meta, [
      record.prompt(launchedAt + 2000, 'Look into it.'),
      record.toolUse(NOW - 1000, 't1', 'Bash', { command: 'make' }),
    ]);

    source.follow({ sessionId: 'S', startedAt: NOW - 60 * MINUTE });

    const session = store.session('S');

    expect(session.agents.get('busy')?.phase).toBe('working');
    expect([...session.main.backgroundTaskIds]).toEqual(['busy']);
  });
});

describe('a report handed back through a tool call', () => {
  it("is the finished agent's report in history too", () => {
    const { projects, store, source } = setup();
    const at = NOW - 2 * MINUTE;
    const meta = { agentType: 'general-purpose', description: 'Count the lines' };

    projects.writeMain('S', [record.prompt(at, 'count the lines')]);

    projects.writeAgent('S', 'A', meta, [
      record.prompt(at, 'Count the lines of the file.'),
      record.toolUse(at + 1000, 'h1', 'SubagentHandback', { message: 'The file has 12 lines.' }),
      record.toolResult(at + 1100, 'h1', 'Report delivered to your caller.'),
    ]);

    projects.finishAgent('S', 'A', meta);
    source.follow({ sessionId: 'S' });

    const agent = store.session('S').agents.get('A');

    expect(agent?.phase).toBe('finished');
    expect(agent?.report).toBe('The file has 12 lines.');
  });
});

describe('an interrupt', () => {
  const INTERRUPT = '[Request interrupted by user for tool use]';

  it("ends a subagent's run, which no hook reports", () => {
    const { projects, store, source } = setup();
    const at = NOW - 2 * MINUTE;

    projects.writeMain('S', [record.prompt(at, 'port the tests')]);

    projects.writeAgent('S', 'A', { agentType: 'general-purpose', description: 'Port the tests' }, [
      record.prompt(at, 'Port every test.'),
      record.toolUse(at + 1000, 'tu1', 'Bash', { command: 'npm test', run_in_background: true }),
      record.toolResult(at + 2000, 'tu1', 'started', { backgroundTaskId: 'shell-1' }),
      record.prompt(at + 3000, INTERRUPT),
    ]);

    source.follow({ sessionId: 'S' });
    source.setLiveSince('S', at + 500); // even with hooks live from before the interrupt

    const agent = store.session('S').agents.get('A');

    expect(agent?.phase).toBe('interrupted');
    expect(agent?.timeline.latest(5).at(-1)).toMatchObject({ kind: 'interrupted', by: 'user' });
  });

  it("is noted in the main agent's history as an interrupt, not as something the user typed", () => {
    const { projects, store, source } = setup();

    projects.writeMain('S', [
      record.prompt(NOW - MINUTE, 'fix the build'),
      record.prompt(NOW - MINUTE + 1000, INTERRUPT),
    ]);

    source.follow({ sessionId: 'S' });

    const entries = store.session('S').main.timeline.latest(5);

    expect(entries.map((entry) => entry.kind)).toEqual(['prompt', 'notice']);
    expect(entries.at(-1)).toMatchObject({ text: 'interrupted by you' });
  });
});

describe("finding a session's transcript", () => {
  it('uses the most recently written copy when two project folders hold the same session id', () => {
    const { projects, source, mainKinds } = setup();

    projects.writeMain('S', [record.prompt(NOW - 60 * MINUTE, 'stale copy')], 'old-folder');

    const stale = new Date(NOW - 30 * 24 * 60 * MINUTE);

    utimesSync(projects.mainPath('S', 'old-folder'), stale, stale);

    projects.writeMain(
      'S',
      [record.prompt(NOW - MINUTE, 'current'), record.narration(NOW, 'hello')],
      'new-folder',
    );

    source.follow({ sessionId: 'S' });
    expect(mainKinds()).toEqual(['prompt', 'narration']);
    expect(source.transcriptPath('S')).toBe(projects.mainPath('S', 'new-folder'));
  });

  it('uses the path a hook reported over any other', () => {
    const { projects, source } = setup();

    projects.writeMain('S', [record.prompt(NOW, 'newer but not the one')], 'other');
    projects.writeMain('S', [record.prompt(NOW - MINUTE, 'the hook said this one')], 'hooked');
    source.follow({ sessionId: 'S', transcriptPath: projects.mainPath('S', 'hooked') });
    expect(source.transcriptPath('S')).toBe(projects.mainPath('S', 'hooked'));
  });
});
