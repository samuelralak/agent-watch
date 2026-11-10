// What a tool call asks for, in one line. Inputs are of unknown shape: Claude Code's tools and
// MCP tools define their own, so every field is read defensively.
import { relativeTo, tidyPaths } from '../../util/paths.js';
import { arrayField, asRecord, numberField, stringField } from '../../util/record.js';
import { cleanBlock, oneLine } from '../../util/sanitize.js';
import { HANDBACK_TOOL } from './tool-names.js';

const SUMMARY_LIMIT = 1000;
const DETAIL_LIMIT = 6000;

/** An agent's report is kept whole up to this size: it is what the agent was started for. */
export const REPORT_LIMIT = 12_000;

/** Reads the fields of one call's input. */
interface InputFields {
  readonly input: unknown;
  /** A text field, or an empty string. */
  text(key: string): string;
  /** A path field, relative to the working directory where it is inside it. */
  path(key: string): string;
}

type InputSummary = (fields: InputFields) => string;

const filePath: InputSummary = ({ path }) => path('file_path');
const query: InputSummary = ({ text }) => text('query');

const spawn: InputSummary = ({ text }) =>
  `${text('subagent_type') || 'general-purpose'}: ${text('description')}`;

/** How each known tool's input reads in one line. Other tools show their first text field. */
const SUMMARIES: Readonly<Record<string, InputSummary>> = {
  Bash: ({ text }) => text('description') || firstLineOf(text('command')),
  Read: ({ input, path }) => {
    const offset = numberField(input, 'offset');

    return path('file_path') + (offset ? `:${offset}` : '');
  },
  Edit: filePath,
  Write: filePath,
  MultiEdit: filePath,
  NotebookEdit: ({ path }) => path('notebook_path'),
  Grep: ({ text, path }) => {
    const where = text('path') ? ` in ${path('path')}` : '';
    const glob = text('glob') ? ` (${text('glob')})` : '';

    return `"${text('pattern')}"${where}${glob}`;
  },
  Glob: ({ text, path }) => text('pattern') + (text('path') ? ` in ${path('path')}` : ''),
  Agent: spawn,
  Task: spawn,
  WebFetch: ({ text }) => text('url'),
  WebSearch: query,
  ToolSearch: query,
  Skill: ({ text }) => text('skill'),
  SendMessage: ({ text }) => `to ${text('to') || '?'}: ${text('message')}`,
  TodoWrite: ({ input }) => `${arrayField(input, 'todos')?.length ?? 0} todos`,
  [HANDBACK_TOOL]: () => 'report delivered',
};

/** One line saying what the call asks for. */
export function summarizeToolInput(name: string | undefined, input: unknown, cwd: string): string {
  const text = (key: string): string => stringField(input, key) ?? '';
  const path = (key: string): string => (text(key) ? relativeTo(text(key), cwd) : '');
  const summarize = SUMMARIES[name ?? ''] ?? firstTextField;

  return oneLine(tidyPaths(summarize({ input, text, path }), cwd), SUMMARY_LIMIT);
}

const firstLineOf = (text: string): string => text.trim().split('\n')[0] ?? '';

/**
 * The call's input as it was written, when the summary does not already say all of it. Today
 * that is a shell command: its line breaks and indentation are part of what it does.
 */
export function toolInputDetail(name: string | undefined, input: unknown, cwd: string): string {
  if (name !== 'Bash') {
    return '';
  }

  const command = cleanBlock(
    tidyPaths(stringField(input, 'command') ?? '', cwd),
    DETAIL_LIMIT,
  ).trim();

  const summary = summarizeToolInput(name, input, cwd);

  return command === summary ? '' : command;
}

const firstTextField: InputSummary = ({ input }) => {
  const first = Object.values(asRecord(input) ?? {}).find(
    (value) => typeof value === 'string' && value,
  );

  return typeof first === 'string' ? first : '';
};

/**
 * The report a call hands back, when the call is how a subagent reports to its caller. Such an
 * agent ends its turn with nothing more to say, so this is the only place its report appears.
 */
export function handedBackReport(name: string | undefined, input: unknown): string | undefined {
  if (name !== HANDBACK_TOOL) {
    return undefined;
  }

  return cleanBlock(stringField(input, 'message'), REPORT_LIMIT) || undefined;
}
