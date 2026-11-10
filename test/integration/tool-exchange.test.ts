/** A tool call's whole input and output, read from the transcript of the agent that made it. */
import { describe, expect, it } from 'vitest';
import { TranscriptToolExchange } from '../../src/adapters/claude/tool-exchange.adapter.js';
import { projectsFolder, record } from '../helpers/transcripts.js';

const NOW = Date.now();

function setup() {
  const projects = projectsFolder();
  const lookup = new TranscriptToolExchange((sessionId) => projects.mainPath(sessionId));

  return { projects, lookup };
}

describe('opening a tool call in full', () => {
  it('gives what the tool was given and what it gave back, whole', () => {
    const { projects, lookup } = setup();
    const output = Array.from({ length: 300 }, (_, index) => `output line ${index + 1}`).join('\n');

    projects.writeMain('S', [
      record.prompt(NOW, 'run the tests'),
      record.toolUse(NOW + 1000, 'tu1', 'Bash', {
        command: 'npm test -- payments \\\n  --reporter verbose',
        description: 'Run the payment tests',
        timeout: 120000,
      }),
      record.toolResult(NOW + 2000, 'tu1', output),
      record.toolUse(NOW + 3000, 'tu2', 'Read', { file_path: '/work/a.ts' }),
    ]);

    const found = lookup.find({ sessionId: 'S', agentId: null, toolUseId: 'tu1' });

    expect(found?.input).toBe(
      'command:\n  npm test -- payments \\\n    --reporter verbose\ndescription: Run the payment tests\ntimeout: 120000',
    );

    expect(found?.result).toBe(output);
  });

  it('says a call has no result yet, and nothing at all for a call it cannot find', () => {
    const { projects, lookup } = setup();

    projects.writeMain('S', [record.toolUse(NOW, 'tu1', 'Read', { file_path: '/work/a.ts' })]);

    expect(lookup.find({ sessionId: 'S', agentId: null, toolUseId: 'tu1' })).toEqual({
      input: 'file_path: /work/a.ts',
      result: null,
    });

    expect(lookup.find({ sessionId: 'S', agentId: null, toolUseId: 'other' })).toBeNull();
    expect(lookup.find({ sessionId: 'unknown', agentId: null, toolUseId: 'tu1' })).toBeNull();
  });

  it('strips what could act on the terminal, and counts what is too long to show', () => {
    const { projects, lookup } = setup();

    projects.writeMain('S', [
      record.toolUse(NOW, 'tu1', 'Bash', { command: 'cat big.log' }),
      record.toolResult(NOW + 1000, 'tu1', `\x1b[31mred\x1b[0m ${'x'.repeat(250_000)}`),
    ]);

    const result = lookup.find({ sessionId: 'S', agentId: null, toolUseId: 'tu1' })?.result ?? '';

    expect(result.startsWith('red xxx')).toBe(true);
    expect(result).not.toContain('\x1b');
    expect(result).toMatch(/\n… 50,004 more characters are not shown here$/);
  });
});
