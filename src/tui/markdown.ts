// Text as an agent wrote it, laid out for the terminal: line breaks and indentation are kept,
// and the Markdown that agents use is shown as what it means (a heading in bold, a list with its
// marker, code in its own colour) instead of as punctuation.
import { cells, width } from '../util/text-width.js';
import { type Block, bold, type Line, MIN_COLUMNS, spansOf, wrapBlock } from './markdown-inline.js';
import { renderTable, tableAt } from './markdown-table.js';
import type { Style } from './paint.js';
import { style } from './theme.js';

export type { Line } from './markdown-inline.js';

export interface MarkdownOptions {
  /** Columns each row may fill. */
  readonly columns: number;
  /** Columns of the very first row, when a label beside it leaves it less room. */
  readonly firstColumns?: number;
  /** How plain text looks. Bold builds on it. */
  readonly textStyle: Style;
}

const RULE_COLUMNS = 24;

const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const HEADING = /^(\s*)#{1,6}\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const QUOTE = /^(\s*)>\s?(.*)$/;
const INDENTED = /^(\s*)(.*)$/;

/** `text` as rows for the terminal. Nothing is cut: long lines wrap, long words break. */
export function renderMarkdown(text: string, options: MarkdownOptions): Line[] {
  const lines: Line[] = [];
  let inCode = false;

  const room = (): number =>
    Math.max(
      MIN_COLUMNS,
      lines.length === 0 ? (options.firstColumns ?? options.columns) : options.columns,
    );

  const sources = text.split('\n');
  let index = 0;

  while (index < sources.length) {
    const source = sources[index] ?? '';
    const tableLines = inCode ? 0 : tableAt(sources, index);

    const table =
      tableLines > 0 ? tableRows(sources.slice(index, index + tableLines), lines, options) : null;

    if (table) {
      lines.push(...table);
      index += tableLines;
      continue;
    }

    if (FENCE.test(source)) {
      inCode = !inCode;
    } else if (inCode) {
      lines.push(...codeLines(source, room()));
    } else if (source.trim() === '') {
      pushBlank(lines);
    } else if (RULE.test(source)) {
      lines.push([[style.dim, '─'.repeat(Math.min(RULE_COLUMNS, room()))]]);
    } else {
      lines.push(...wrapBlock(blockOf(source, options.textStyle), room(), options.columns));
    }

    index++;
  }

  return trimBlank(lines);
}

/**
 * A table as rows, or null when the pane is too narrow for one. A table has one width for all
 * its rows, so when a label leaves the very first row less room, the table starts under it.
 */
function tableRows(
  sources: readonly string[],
  before: readonly Line[],
  options: MarkdownOptions,
): Line[] | null {
  const table = renderTable(sources, Math.max(MIN_COLUMNS, options.columns), options.textStyle);

  const besideLabel =
    before.length === 0 && (options.firstColumns ?? options.columns) < options.columns;

  return table && besideLabel ? [[], ...table] : table;
}

/** One blank row between blocks, however many blank lines the text had. */
function pushBlank(lines: Line[]): void {
  if (lines.length > 0 && lines.at(-1)?.length !== 0) {
    lines.push([]);
  }
}

function trimBlank(lines: Line[]): Line[] {
  while (lines.at(-1)?.length === 0) {
    lines.pop();
  }

  return lines;
}

/**
 * Text exactly as written: every line break and every space kept, long lines continued. In
 * the colour of code unless another style is given (a tool's output is kept, not coloured).
 */
export function renderCode(
  text: string,
  columns: number,
  firstColumns = columns,
  textStyle: Style = style.code,
): Line[] {
  const lines: Line[] = [];

  for (const source of text.split('\n')) {
    lines.push(...codeLines(source, lines.length === 0 ? firstColumns : columns, textStyle));
  }

  return lines;
}

/** A line exactly as written. Too long for the row, it continues on the next. */
function codeLines(source: string, columns: number, textStyle: Style = style.code): Line[] {
  const room = Math.max(MIN_COLUMNS, columns);
  const lines: Line[] = [];
  let current = '';
  let used = 0;

  for (const cell of cells(source)) {
    if (used + cell.width > room) {
      lines.push([[textStyle, current]]);
      current = '';
      used = 0;
    }

    current += cell.text;
    used += cell.width;
  }

  return [...lines, [[textStyle, current]]];
}

/** What kind of line this is, and the text it carries. */
function blockOf(source: string, textStyle: Style): Block {
  const heading = HEADING.exec(source);
  const bullet = BULLET.exec(source);
  const numbered = NUMBERED.exec(source);
  const quote = QUOTE.exec(source);
  const [, spaces = '', rest = ''] = INDENTED.exec(source) ?? [];
  const indent = spaces.length;

  if (heading) {
    return {
      indent,
      marker: null,
      hang: indent,
      spans: spansOf(heading[2] ?? '', bold(textStyle)),
    };
  }

  if (bullet) {
    return listItem(indent, '• ', bullet[2] ?? '', textStyle);
  }

  if (numbered) {
    return listItem(indent, `${numbered[2]} `, numbered[3] ?? '', textStyle);
  }

  if (quote) {
    return {
      indent,
      marker: [style.dim, '│ '],
      hang: indent + 2,
      spans: spansOf(quote[2] ?? '', style.dim),
    };
  }

  return { indent, marker: null, hang: indent, spans: spansOf(rest, textStyle) };
}

function listItem(indent: number, marker: string, text: string, textStyle: Style): Block {
  return {
    indent,
    marker: [textStyle, marker],
    hang: indent + width(marker),
    spans: spansOf(text, textStyle),
  };
}
