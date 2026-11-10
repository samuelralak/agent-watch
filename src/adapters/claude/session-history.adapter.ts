import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PastSession,
  SessionHistoryPort,
} from '../../application/ports/session-history.port.js';
import { closingWords } from '../../domain/closing-words.js';
import { Store } from '../../domain/store.js';
import { arrayField, asRecord, stringField } from '../../util/record.js';
import { cleanBlock, oneLine } from '../../util/sanitize.js';
import { firstLines, scanBackwards } from '../fs/tail.js';
import { firstPrompt } from './transcript-reader.js';
import { TranscriptSource } from './transcript-source.js';

/** Claude Code names a session's transcript after its id, which is a UUID. */
const TRANSCRIPT_NAME = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/i;
/** A transcript's end is read this far back for the session's title and its last words. */
const LINES_LOOKED_AT = 3000;
const TITLE_LIMIT = 120;

/** The records Claude Code writes a session's title in, and the field each keeps it in. */
const TITLE_FIELDS: Readonly<Record<string, string>> = {
  'custom-title': 'customTitle',
  'ai-title': 'aiTitle',
};

/** What a transcript's end says about its session. */
interface Edges {
  readonly title: string;
  readonly cwd: string;
  readonly lastWords: string;
}

/** A session as it was read, and the state of its file then: an unchanged file is not read again. */
interface Known {
  readonly modifiedAt: number;
  readonly size: number;
  readonly session: PastSession;
}

/**
 * Past sessions, from the transcripts Claude Code keeps of them. A transcript is Claude Code's
 * own format, so this is enrichment: a file that does not read as one is left out.
 */
export class TranscriptSessionHistory implements SessionHistoryPort {
  private readonly known = new Map<string, Known>();

  constructor(private readonly projectsDir: string) {}

  list(): PastSession[] {
    const sessions = this.transcripts().flatMap((file) => this.read(file) ?? []);

    return sessions.sort((a, b) => b.endedAt - a.endedAt);
  }

  open(past: PastSession): Store {
    const store = new Store();
    const { sessionId, cwd, endedAt } = past;

    // Every agent of a past session is of interest, however long ago it finished.
    const source = new TranscriptSource({
      projectsDir: this.projectsDir,
      recentMs: Number.POSITIVE_INFINITY,
      emit: (event) => store.apply(event),
    });

    source.follow({ sessionId, cwd, transcriptPath: this.transcriptFile(sessionId, null) });
    source.close();
    store.syncListing([{ sessionId, cwd, name: past.title }], endedAt);

    store.apply({
      at: endedAt,
      sessionId,
      agentId: null,
      origin: 'transcript',
      kind: 'session.ended',
    });

    return store;
  }

  /** The transcript of a past session's main agent (`null`) or of one of its subagents. */
  transcriptFile(sessionId: string, agentId: string | null): string | null {
    const main = [...this.known.keys()].find((file) => file.endsWith(`/${sessionId}.jsonl`));

    if (!main || agentId === null) {
      return main ?? null;
    }

    return join(subagentsOf(main), `agent-${agentId}.jsonl`);
  }

  /** The main transcripts under the projects folder: `<project>/<session id>.jsonl`. */
  private transcripts(): string[] {
    const files: string[] = [];

    for (const project of names(this.projectsDir)) {
      for (const name of names(join(this.projectsDir, project))) {
        if (TRANSCRIPT_NAME.test(name)) {
          files.push(join(this.projectsDir, project, name));
        }
      }
    }

    return files;
  }

  private read(file: string): PastSession | null {
    try {
      const { mtimeMs: modifiedAt, size } = statSync(file);
      const known = this.known.get(file);

      if (known?.modifiedAt === modifiedAt && known.size === size) {
        return known.session;
      }

      const session = pastSession(file, modifiedAt);

      this.known.set(file, { modifiedAt, size, session });

      return session;
    } catch {
      return null; // gone, or not readable
    }
  }
}

const names = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const subagentsOf = (transcript: string): string =>
  join(transcript.replace(/\.jsonl$/, ''), 'subagents');

function pastSession(file: string, endedAt: number): PastSession {
  const sessionId = file.slice(file.lastIndexOf('/') + 1, -'.jsonl'.length);
  const edges = edgesOf(file);
  const asked = edges.title ? '' : firstAsked(file);

  return {
    sessionId,
    endedAt,
    cwd: edges.cwd,
    // Claude Code's title for it, or what it was first asked, or failing both its id.
    title: edges.title || asked || sessionId.slice(0, 8),
    agentCount: names(subagentsOf(file)).filter((name) => /^agent-.+\.jsonl$/.test(name)).length,
    closing: closingWords(edges.lastWords),
  };
}

/** What the session was first asked, in one line: it stands in for a title that is missing. */
function firstAsked(file: string): string {
  for (const line of firstLines(file)) {
    const record = parsed(line);
    const asked = stringField(record, 'type') === 'user' ? firstPrompt(record) : '';

    if (asked) {
      return oneLine(asked, TITLE_LIMIT);
    }
  }

  return '';
}

/** Reads a transcript from its end for the session's title, folder and last words. */
function edgesOf(file: string): Edges {
  let title = '';
  let cwd = '';
  let lastWords = '';
  let lines = 0;

  scanBackwards(file, (line) => {
    lines++;

    // Most lines are tool results, some of them large: only the ones that can matter are parsed.
    if (line.includes('-title"') || line.includes('"type":"assistant"')) {
      const record = parsed(line);

      title ||= titleIn(record);
      cwd ||= stringField(record, 'cwd') ?? '';
      lastWords ||= wordsIn(record);
    }

    return (title !== '' && cwd !== '' && lastWords !== '') || lines >= LINES_LOOKED_AT;
  });

  return { title, cwd, lastWords };
}

function parsed(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null; // a torn line
  }
}

function titleIn(record: unknown): string {
  const field = TITLE_FIELDS[stringField(record, 'type') ?? ''];

  return field ? oneLine(stringField(record, field), TITLE_LIMIT) : '';
}

/** What the main agent said in a record of its own, when it said anything. */
function wordsIn(record: unknown): string {
  const own = stringField(record, 'type') === 'assistant' && asRecord(record)?.isSidechain !== true;
  const blocks = own ? (arrayField(asRecord(record)?.message, 'content') ?? []) : [];

  const text = blocks
    .filter((block) => stringField(block, 'type') === 'text')
    .map((block) => stringField(block, 'text') ?? '')
    .join('\n');

  return cleanBlock(text, 20_000).trim();
}
