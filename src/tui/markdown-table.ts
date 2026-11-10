// A Markdown table, laid out in columns: each column as wide as its longest cell when the pane
// has the room, and cells wrapped inside their column when it has not. Nothing is cut.
import { width } from '../util/text-width.js';
import { bold, type Line, lineWidth, spansOf, wrapBlock } from './markdown-inline.js';
import type { Segment, Style } from './paint.js';
import { style } from './theme.js';

type Alignment = 'left' | 'right' | 'center';

/** A column narrower than this says nothing: a table that would need one is left as written. */
const MIN_CELL = 3;
const BETWEEN = ' │ ';
const CROSSING = '─┼─';
/** The line under a table's first row: dashes, with colons where a column is aligned. */
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** What is between the bars of a row, each cell without the space around it. */
function cellsOf(source: string): string[] {
  const inner = source
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');

  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/**
 * How many lines the table that starts at `index` takes: its first row, the delimiter under
 * it, and the rows that follow. 0 when no table starts there.
 */
export function tableAt(sources: readonly string[], index: number): number {
  const first = sources[index] ?? '';
  const delimiter = sources[index + 1] ?? '';
  const isTable = first.includes('|') && delimiter.includes('-') && DELIMITER.test(delimiter);

  if (!isTable || cellsOf(first).length !== cellsOf(delimiter).length) {
    return 0;
  }

  let end = index + 2;

  while ((sources[end] ?? '').includes('|')) {
    end++;
  }

  return end - index;
}

const alignmentOf = (delimiter: string): Alignment => {
  const right = delimiter.endsWith(':');

  if (right && delimiter.startsWith(':')) {
    return 'center';
  }

  return right ? 'right' : 'left';
};

/**
 * The table in `sources` as rows of at most `columns`. Null when the pane is too narrow to
 * give every column a few characters: the caller then shows the lines as they were written.
 */
export function renderTable(
  sources: readonly string[],
  columns: number,
  textStyle: Style,
): Line[] | null {
  const [first = '', delimiter = '', ...rest] = sources;
  const alignments = cellsOf(delimiter).map(alignmentOf);

  // A row with fewer cells than the table has columns is filled out; extra cells are left out.
  const rows = [first, ...rest].map((source) => {
    const cells = cellsOf(source);

    return alignments.map((_, column) => cells[column] ?? '');
  });

  const widths = columnWidths(rows, columns - width(BETWEEN) * (alignments.length - 1));

  if (!widths) {
    return null;
  }

  const [head = [], ...body] = rows;

  return [
    ...rowLines(head, widths, alignments, bold(textStyle)),
    [[style.dim, widths.map((columnWidth) => '─'.repeat(columnWidth)).join(CROSSING)]],
    ...body.flatMap((cells) => rowLines(cells, widths, alignments, textStyle)),
  ];
}

const cellWidth = (cell: string): number =>
  spansOf(cell, null).reduce((sum, span) => sum + width(span.text), 0);

/**
 * The width of each column. Every column gets what its longest cell needs when that fits in
 * `room`; otherwise the room is shared out, narrow columns first, so that a column of short
 * words is not squeezed for the sake of one long sentence.
 */
function columnWidths(rows: readonly (readonly string[])[], room: number): number[] | null {
  const natural = (rows[0] ?? []).map((_, column) =>
    Math.max(1, ...rows.map((cells) => cellWidth(cells[column] ?? ''))),
  );

  if (natural.reduce((sum, each) => sum + each, 0) <= room) {
    return natural;
  }

  if (room < natural.length * MIN_CELL) {
    return null;
  }

  const widths = natural.map(() => 0);

  const narrowFirst = natural
    .map((_, column) => column)
    .sort((a, b) => (natural[a] ?? 0) - (natural[b] ?? 0));

  let left = room;

  for (const [position, column] of narrowFirst.entries()) {
    const share = Math.floor(left / (narrowFirst.length - position));
    const given = Math.min(natural[column] ?? 0, share);

    widths[column] = given;
    left -= given;
  }

  return widths;
}

/** One row of the table as rows on screen: as many as its tallest cell needs. */
function rowLines(
  cells: readonly string[],
  widths: readonly number[],
  alignments: readonly Alignment[],
  cellStyle: Style,
): Line[] {
  const wrapped = cells.map((cell, column) => {
    const room = widths[column] ?? MIN_CELL;

    return wrapBlock(
      { indent: 0, marker: null, hang: 0, spans: spansOf(cell, cellStyle) },
      room,
      room,
    );
  });

  const height = Math.max(1, ...wrapped.map((lines) => lines.length));

  return Array.from({ length: height }, (_, index) =>
    wrapped.flatMap((lines, column): Segment[] => {
      const last = column === wrapped.length - 1;

      const cell = aligned(
        lines[index] ?? [],
        widths[column] ?? 0,
        alignments[column] ?? 'left',
        last,
      );

      return last ? cell : [...cell, [style.dim, BETWEEN]];
    }),
  );
}

/** A cell's row padded to its column. The last column is not padded on its right. */
function aligned(line: Line, columnWidth: number, alignment: Alignment, last: boolean): Segment[] {
  const spare = Math.max(0, columnWidth - lineWidth(line));
  const before = alignment === 'right' ? spare : alignment === 'center' ? Math.floor(spare / 2) : 0;
  const after = last && alignment === 'left' ? 0 : spare - before;

  return [[null, ' '.repeat(before)], ...line, [null, ' '.repeat(after)]];
}
