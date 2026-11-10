import type {
  ToolCallRef,
  ToolExchange,
  ToolExchangePort,
} from '../../application/ports/tool-exchange.port.js';
import { arrayField, asRecord, stringField } from '../../util/record.js';
import { cleanBlock } from '../../util/sanitize.js';
import { scanBackwards } from '../fs/tail.js';

/** A tool can return a whole file. This much of either side is shown; the rest is counted. */
const SIDE_LIMIT = 200_000;

/** Finds the transcript that records what an agent did; null when it is not followed. */
export type TranscriptLocator = (sessionId: string, agentId: string | null) => string | null;

/**
 * A tool call's whole input and output, read from the transcript of the agent that made it.
 * Transcripts are Claude Code's own format, so this is enrichment: when a call is not found,
 * or its lines no longer look as expected, the answer is null and nothing else is affected.
 */
export class TranscriptToolExchange implements ToolExchangePort {
  constructor(private readonly transcriptOf: TranscriptLocator) {}

  find({ sessionId, agentId, toolUseId }: ToolCallRef): ToolExchange | null {
    const file = this.transcriptOf(sessionId, agentId);

    if (!file || !toolUseId) {
      return null;
    }

    let input: string | null = null;
    let result: string | null = null;

    // From the end: the result comes after the call, and what is looked up is usually recent.
    scanBackwards(file, (line) => {
      // Most lines are about something else: they are not even parsed.
      for (const block of line.includes(toolUseId) ? contentBlocks(line) : []) {
        const type = stringField(block, 'type');

        if (type === 'tool_result' && stringField(block, 'tool_use_id') === toolUseId) {
          result ??= resultText(asRecord(block)?.content);
        } else if (type === 'tool_use' && stringField(block, 'id') === toolUseId) {
          input = inputText(asRecord(block)?.input);
        }
      }

      // The call itself is the earliest line about it: nothing before it matters.
      return input !== null;
    });

    return input === null ? null : { input, result };
  }
}

/** The content blocks of a transcript line's message; none when the line is something else. */
function contentBlocks(line: string): readonly unknown[] {
  try {
    return arrayField(asRecord(JSON.parse(line))?.message, 'content') ?? [];
  } catch {
    return []; // a torn line
  }
}

/** The arguments of a call, one after another: text as it was written, the rest as JSON. */
function inputText(input: unknown): string {
  const fields = Object.entries(asRecord(input) ?? {});

  const lines = fields.map(([name, value]) => {
    if (typeof value !== 'string') {
      return `${name}: ${JSON.stringify(value)}`;
    }

    // Text of several lines starts on a line of its own, set in, so its shape is kept.
    return value.includes('\n') ? `${name}:\n${indented(value)}` : `${name}: ${value}`;
  });

  return limited(lines.join('\n'));
}

const indented = (text: string): string =>
  text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');

/** A result is text, or a list of blocks of which the text ones are read. */
function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return limited(content);
  }

  if (!Array.isArray(content)) {
    return limited(content === undefined ? '' : JSON.stringify(content, null, 2));
  }

  const parts = content.map((block) => {
    const type = stringField(block, 'type');

    return type === 'text'
      ? (stringField(block, 'text') ?? '')
      : `[${type ?? 'something'} not shown]`;
  });

  return limited(parts.join('\n'));
}

/** Printable text, and when it is longer than is shown, a last line that says by how much. */
function limited(text: string): string {
  const clean = cleanBlock(text, Number.POSITIVE_INFINITY);

  if (clean.length <= SIDE_LIMIT) {
    return clean;
  }

  const more = (clean.length - SIDE_LIMIT).toLocaleString('en-US');

  return `${clean.slice(0, SIDE_LIMIT)}\n… ${more} more characters are not shown here`;
}
