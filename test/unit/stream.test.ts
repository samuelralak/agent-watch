/** Printing activity for pipes and logs: text lines, JSON lines, and the agent list. */
import { describe, expect, it } from 'vitest';
import {
  printAgentList,
  type StreamOptions,
  streamJson,
  streamText,
} from '../../src/cli/stream.js';
import { Store } from '../../src/domain/store.js';
import { event, MINUTE, SECOND } from '../helpers/events.js';
import { call, listing, startAgent } from '../helpers/sessions.js';

const T0 = 1_800_000_000_000;

function setup(overrides: Partial<StreamOptions> = {}) {
  const store = new Store();

  store.syncListing([listing('S')], T0);

  const lines: string[] = [];

  const options: StreamOptions = {
    backlog: 20,
    includeMain: false,
    includeResults: true,
    color: false,
    columns: null,
    write: (line) => lines.push(line),
    now: () => T0 + MINUTE,
    ...overrides,
  };

  return { store, lines, options };
}

describe('the text stream', () => {
  it('prints every line with its time and who it is about, so it can be searched by agent', () => {
    const { store, lines, options } = setup();

    streamText(store, options);
    startAgent(store, 'A', T0, { description: 'Port the tests' });

    call(store, T0 + SECOND, {
      agentId: 'A',
      id: 'c1',
      tool: 'Bash',
      summary: 'npm test',
      result: '12 passing',
    });

    expect(lines).toHaveLength(3);

    for (const line of lines) {
      expect(line).toMatch(/^\d\d:\d\d:\d\d {2}\[S\/Port the tests\] /);
    }

    expect(lines[0]).toContain('▶ started (general-purpose)');
    expect(lines[1]).toContain('Bash  npm test');
    expect(lines[2]).toContain('⎿ ✓ Bash: 12 passing');
  });

  it('leaves the main agent out unless asked, and results out when told to', () => {
    const quiet = setup({ includeResults: false });

    streamText(quiet.store, quiet.options);
    call(quiet.store, T0, { agentId: null, id: 'm1', tool: 'Bash', summary: 'main work' });
    startAgent(quiet.store, 'A', T0);

    call(quiet.store, T0 + SECOND, {
      agentId: 'A',
      id: 'c1',
      tool: 'Bash',
      summary: 'agent work',
      result: 'ok',
    });

    expect(quiet.lines.join('\n')).not.toContain('main work');
    expect(quiet.lines.join('\n')).toContain('agent work');
    expect(quiet.lines.join('\n')).not.toContain('⎿');

    const all = setup({ includeMain: true });

    streamText(all.store, all.options);
    call(all.store, T0, { agentId: null, id: 'm1', tool: 'Bash', summary: 'main work' });
    expect(all.lines[0]).toContain('[S/main] Bash  main work');
  });

  it('never wraps or cuts a line when the output is not a terminal', () => {
    const { store, lines, options } = setup({ includeMain: true });

    streamText(store, options);

    const command = Array.from({ length: 200 }, (_, i) => `arg${i}`).join(' ');

    call(store, T0, { agentId: null, id: 'c1', tool: 'Bash', summary: command });

    expect(lines[0]).toContain(command);
    expect(lines[0]).not.toContain('…');
  });

  it('prints the most recent entries from before it started, then what happens next', () => {
    const { store, lines, options } = setup({ includeMain: true, backlog: 2 });

    for (let i = 0; i < 5; i++) {
      store.apply(event('narration', T0 + i * SECOND, { text: `thought ${i}` }));
    }

    streamText(store, options);

    expect(lines.map((line) => line.slice(line.indexOf('] ') + 2))).toEqual([
      'thought 3',
      'thought 4',
    ]);

    store.apply(event('narration', T0 + 10 * SECOND, { text: 'thought 5' }));
    expect(lines.at(-1)).toContain('thought 5');
  });

  it('leaves out sessions the session list never reported', () => {
    const { store, lines, options } = setup({ includeMain: true });

    streamText(store, options);
    store.apply(event('narration', T0, { sessionId: 'filtered-out', text: 'not for this viewer' }));
    expect(lines).toEqual([]);
  });

  it('stops printing when it is stopped', () => {
    const { store, lines, options } = setup({ includeMain: true });
    const stop = streamText(store, options);

    stop();
    store.apply(event('narration', T0, { text: 'unheard' }));
    expect(lines).toEqual([]);
  });
});

describe('the JSON stream', () => {
  it('prints one object per entry and one for the end of each call', () => {
    const { store, lines, options } = setup();

    streamJson(store, options);
    startAgent(store, 'A', T0, { description: 'Port the tests' });

    call(store, T0 + SECOND, {
      agentId: 'A',
      id: 'c1',
      tool: 'Bash',
      summary: 'npm test',
      result: '12 passing',
    });

    const records = lines.map((line) => JSON.parse(line));

    expect(records.map((record) => record.kind)).toEqual(['started', 'tool.started', 'tool.ended']);

    expect(records[1]).toMatchObject({
      time: new Date(T0 + SECOND).toISOString(),
      session: 'S',
      sessionId: 'S',
      agent: 'Port the tests',
      agentId: 'A',
      callId: 'c1',
      tool: 'Bash',
      summary: 'npm test',
    });

    expect(records[2]).toMatchObject({ callId: 'c1', outcome: 'ok', result: '12 passing' });
  });
});

describe('the agent list, printed once', () => {
  it('lists sessions and their agents, or says there are none', () => {
    const { store, lines, options } = setup();

    startAgent(store, 'A', T0, { description: 'Port the tests' });
    printAgentList(store, { ...options, recentMs: 10 * MINUTE });
    expect(lines[0]).toMatch(/^ {2}S\s+idle$/);
    expect(lines[1]).toContain('● Port the tests');

    const none: string[] = [];

    printAgentList(new Store(), { ...options, write: (line) => none.push(line), recentMs: MINUTE });
    expect(none).toEqual(['No Claude Code sessions running.']);
  });
});
