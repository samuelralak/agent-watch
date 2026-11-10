/** Past sessions, read from the transcripts Claude Code keeps of them. */
import { utimesSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TranscriptSessionHistory } from '../../src/adapters/claude/session-history.adapter.js';
import { projectsFolder, record } from '../helpers/transcripts.js';

const NOW = Date.now();
const HOUR = 3_600_000;
const OLDER = 'aaaaaaaa-1111-4222-8333-444444444444';
const NEWER = 'bbbbbbbb-1111-4222-8333-444444444444';

function setup() {
  const projects = projectsFolder();
  const history = new TranscriptSessionHistory(projects.projectsDir);

  const lastWrittenAt = (sessionId: string, at: number) =>
    utimesSync(projects.mainPath(sessionId), at / 1000, at / 1000);

  return { projects, history, lastWrittenAt };
}

describe('the sessions that are over', () => {
  it('are listed newest first, each with its title, where it ran and how it ended', () => {
    const { projects, history, lastWrittenAt } = setup();

    projects.writeMain(OLDER, [
      // What a session is first asked is not always its first record.
      { type: 'queue-operation', operation: 'enqueue', sessionId: OLDER },
      record.prompt(NOW - 5 * HOUR, 'fix the flaky upload test'),
      record.narration(NOW - 5 * HOUR + 1000, 'Fixed.\n\nShall I also remove the old retry?'),
    ]);

    projects.writeMain(NEWER, [
      record.prompt(NOW - 2 * HOUR, 'rebuild the prototype'),
      { type: 'ai-title', aiTitle: 'Rebuild prototype cleanly', sessionId: NEWER },
      record.narration(NOW - 2 * HOUR + 1000, 'All four screens now match the brief.'),
      { type: 'ai-title', aiTitle: 'Rebuild prototype cleanly', sessionId: NEWER },
    ]);

    projects.writeAgent(NEWER, 'A1', { agentType: 'Explore' }, [record.narration(NOW, 'looked')]);
    lastWrittenAt(OLDER, NOW - 5 * HOUR);
    lastWrittenAt(NEWER, NOW - 2 * HOUR);

    expect(history.list()).toMatchObject([
      {
        sessionId: NEWER,
        title: 'Rebuild prototype cleanly',
        agentCount: 1,
        closing: { line: 'All four screens now match the brief.', asks: false },
      },
      {
        sessionId: OLDER,
        // No title was written for it: what it was first asked stands in.
        title: 'fix the flaky upload test',
        agentCount: 0,
        closing: { line: 'Shall I also remove the old retry?', asks: true },
      },
    ]);
  });

  it('give all a session did when one is opened, as a session that has ended', () => {
    const { projects, history } = setup();

    projects.writeMain(OLDER, [
      record.prompt(NOW - HOUR, 'please fix the build'),
      record.toolUse(NOW - HOUR + 1000, 'tu1', 'Bash', { command: 'make' }),
      record.toolResult(NOW - HOUR + 2000, 'tu1'),
      record.narration(NOW - HOUR + 3000, 'The build passes.'),
    ]);

    const [past] = history.list();

    if (!past) {
      throw new Error('the session was not listed');
    }

    const session = history.open(past).session(OLDER);

    expect(session).toMatchObject({ alive: false, name: 'please fix the build' });
    expect(session.endedAt).toBe(past.endedAt);

    expect(session.main.timeline.latest(10).map((entry) => entry.kind)).toEqual([
      'prompt',
      'tool',
      'narration',
    ]);

    expect(history.transcriptFile(OLDER, null)).toBe(projects.mainPath(OLDER));
  });

  it('leave out what is not a session, and read a file again only when it has changed', () => {
    const { projects, history } = setup();

    projects.writeMain(OLDER, [record.narration(NOW, 'Done.')]);
    projects.writeMain('notes', [record.narration(NOW, 'not a session id')]);

    const [first] = history.list();

    expect(history.list()).toHaveLength(1);
    expect(history.list()[0]).toBe(first); // the very same record: the file was not read again

    projects.appendMain(OLDER, [record.narration(NOW + 1000, 'One more thing: tests added.')]);
    expect(history.list()[0]?.closing?.line).toBe('One more thing: tests added.');
  });
});
