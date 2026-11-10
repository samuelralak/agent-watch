// What a tool call returned, in one line. Results are of unknown shape: each tool defines its
// own, so they are recognised by the fields they carry and never assumed.
import { relativeTo, tidyPaths } from '../../util/paths.js';
import {
  arrayField,
  asRecord,
  booleanField,
  numberField,
  stringField,
  type UnknownRecord,
} from '../../util/record.js';
import { oneLine } from '../../util/sanitize.js';
import { stripHarnessText } from './harness-text.js';
import { isSpawnTool } from './tool-names.js';

const RESULT_LIMIT = 500;
const NO_OUTPUT = '(no output)';
const FILES_SHOWN = 5;
/** Fields that generic tools put their answer in, in the order they are tried. */
const ANSWER_FIELDS = ['result', 'content', 'message', 'output'] as const;

/** The text of a content value: a string, or blocks of which the text ones are joined. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content.map(blockText).join('\n');
}

function blockText(block: unknown): string {
  const type = stringField(block, 'type');

  if (type === 'text') {
    return stringField(block, 'text') ?? '';
  }

  return type === 'image' ? '[image]' : '';
}

/** The id of background work a tool call left running, if any. */
export function backgroundTaskIdOf(response: unknown): string | undefined {
  return stringField(response, 'backgroundTaskId') ?? stringField(response, 'taskId');
}

/** A tool result as a transcript stores it (the content of a `tool_result` block). */
export function summarizeTranscriptResult(
  name: string | undefined,
  content: unknown,
  cwd: string,
): string {
  const text = contentText(content);

  if (name === 'Read') {
    return `${stripHarnessText(text).split('\n').filter(Boolean).length} lines`;
  }

  return firstLine(text, cwd) || NO_OUTPUT;
}

/** A tool result as a PostToolUse hook receives it (`tool_response`). */
export function summarizeHookResult(
  name: string | undefined,
  response: unknown,
  cwd: string,
): string {
  if (response === null || response === undefined) {
    return '';
  }

  if (typeof response === 'string' || Array.isArray(response)) {
    return firstLine(contentText(response), cwd) || NO_OUTPUT;
  }

  const record = asRecord(response);

  if (!record) {
    return oneLine(String(response), RESULT_LIMIT); // a bare number or boolean
  }

  return summarizeRecord({ name: name ?? '', record, cwd });
}

interface RecordResult {
  readonly name: string;
  readonly record: UnknownRecord;
  readonly cwd: string;
}

/** Each recognises one shape of result and says what it means, or passes. */
const SHAPES: readonly ((result: RecordResult) => string | undefined)[] = [
  spawned,
  fileRead,
  shellOutput,
  fileList,
  fileWritten,
  answer,
];

function summarizeRecord(result: RecordResult): string {
  for (const recognise of SHAPES) {
    const summary = recognise(result);

    if (summary !== undefined) {
      return summary;
    }
  }

  return oneLine(JSON.stringify(result.record), RESULT_LIMIT);
}

function spawned({ name, record, cwd }: RecordResult): string | undefined {
  if (!isSpawnTool(name)) {
    return undefined;
  }

  if (record.status === 'async_launched') {
    return 'launched in the background';
  }

  return firstLine(contentText(record.content), cwd) || stringField(record, 'status') || '';
}

function fileRead({ name, record }: RecordResult): string | undefined {
  const lines = name === 'Read' ? numberField(record.file, 'numLines') : undefined;

  return lines === undefined ? undefined : `${lines} lines`;
}

function shellOutput({ record, cwd }: RecordResult): string | undefined {
  if (!('stdout' in record || 'stderr' in record)) {
    return undefined;
  }

  const background = stringField(record, 'backgroundTaskId');

  if (background) {
    return `running in the background (${background})`;
  }

  const output = stringField(record, 'stdout') || stringField(record, 'stderr') || '';
  const nothing = booleanField(record, 'interrupted') ? 'interrupted' : NO_OUTPUT;

  return firstLine(output, cwd) || nothing;
}

function fileList({ record, cwd }: RecordResult): string | undefined {
  const filenames = arrayField(record, 'filenames');

  if (!filenames) {
    return undefined;
  }

  const count = numberField(record, 'numFiles') ?? filenames.length;

  const shown = filenames
    .filter((file): file is string => typeof file === 'string')
    .slice(0, FILES_SHOWN)
    .map((file) => relativeTo(file, cwd));

  return `${count} file${count === 1 ? '' : 's'}${shown.length ? `: ${shown.join(', ')}` : ''}`;
}

function fileWritten({ name, record }: RecordResult): string | undefined {
  if (!stringField(record, 'filePath') || !/^(Edit|Write|MultiEdit)$/.test(name)) {
    return undefined;
  }

  return record.type === 'create' ? 'created' : 'updated';
}

function answer({ record, cwd }: RecordResult): string | undefined {
  for (const key of ANSWER_FIELDS) {
    const value = record[key];

    if (typeof value === 'string' && value) {
      return firstLine(value, cwd);
    }

    if (Array.isArray(value)) {
      return firstLine(contentText(value), cwd);
    }
  }

  return undefined;
}

/** The first line of some output, and how many more lines there were. */
function firstLine(text: string, cwd: string): string {
  const lines = stripHarnessText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const first = lines[0];

  if (first === undefined) {
    return '';
  }

  const more = lines.length > 1 ? `  (+${lines.length - 1} lines)` : '';

  return oneLine(tidyPaths(first, cwd), RESULT_LIMIT) + more;
}
