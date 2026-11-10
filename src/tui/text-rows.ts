// Rows of the timeline: a time gutter, an optional label, and text that wraps under itself.
// This is the one place that decides how text sits beside its label and where it continues, so
// every view lays its entries out the same way.
import { width, wrap } from '../util/text-width.js';
import { type Line, type MarkdownOptions, renderCode, renderMarkdown } from './markdown.js';
import { type Row, row, type Segment, type Style } from './paint.js';
import { style } from './theme.js';

/** The time gutter: `HH:MM:SS` and two spaces. */
export const GUTTER = 10;
/** What a row starts with when it has no time of its own. */
export const INDENT = ' '.repeat(GUTTER);

/**
 * How text is laid out:
 * - `wrapped` (the default): words flow to fill each row. For lines agentwatch words itself.
 * - `written`: an agent's or a person's own words, with their line breaks, their indentation
 *   and their Markdown.
 * - `code`: exactly as written, every space kept.
 */
export type TextLayout = 'wrapped' | 'written' | 'code';

/** Text beside a lead needs at least this many columns; with fewer it starts on the next row. */
const MIN_TEXT_COLUMNS = 8;

const segmentsWidth = (segments: readonly Segment[]): number =>
  segments.reduce((sum, segment) => sum + width(segment[1]), 0);

/**
 * Rows for `text` wrapped to the columns after the gutter, never clipped: the first row carries
 * `lead` and `right`, continuation rows are indented by `hang`. A lead too wide to leave room
 * for text beside it takes rows of its own.
 */
export function textRows(options: {
  readonly gutter: string;
  readonly lead?: readonly Segment[];
  readonly text: string;
  readonly textStyle: Style;
  readonly width: number;
  readonly hang?: number;
  readonly right?: readonly Segment[];
  readonly layout?: TextLayout;
}): Row[] {
  const lead = options.lead ?? [];
  const leadWidth = segmentsWidth(lead);
  const rightWidth = segmentsWidth(options.right ?? []);
  const room = options.width - GUTTER;
  // Continuation rows hang under the text, but never so far in that no text fits.
  const hang = Math.min(options.hang ?? leadWidth, Math.max(0, room - MIN_TEXT_COLUMNS));
  const restRoom = Math.max(MIN_TEXT_COLUMNS, room - hang);
  const beside = room - leadWidth - (rightWidth ? rightWidth + 2 : 0);

  const lines = (firstColumns: number): Line[] =>
    laidOut(options.text, options.layout, {
      columns: restRoom,
      firstColumns,
      textStyle: options.textStyle,
    });

  const continuation = (line: Line): Row => row([[null, INDENT + ' '.repeat(hang)], ...line]);

  if (lead.length > 0 && beside < MIN_TEXT_COLUMNS) {
    return [
      ...leadRows(options.gutter, lead, room, options.right),
      ...lines(restRoom).map(continuation),
    ];
  }

  const [first = [], ...rest] = lines(Math.max(MIN_TEXT_COLUMNS, beside));

  return [
    row([[style.dim, options.gutter], ...lead, ...first], options.right),
    ...rest.map(continuation),
  ];
}

/** A lead on rows of its own, wrapped when it is wider than the pane. */
function leadRows(
  gutter: string,
  lead: readonly Segment[],
  room: number,
  right: readonly Segment[] | undefined,
): Row[] {
  const leadStyle = lead[0]?.[0] ?? null;
  const text = lead.map((segment) => segment[1]).join('');
  const lines = wrap(text.trimEnd(), Math.max(MIN_TEXT_COLUMNS, room));

  return lines.map((line, index) =>
    index === 0
      ? row(
          [
            [style.dim, gutter],
            [leadStyle, line],
          ],
          right,
        )
      : row([
          [null, INDENT],
          [leadStyle, line],
        ]),
  );
}

function laidOut(text: string, layout: TextLayout | undefined, options: MarkdownOptions): Line[] {
  if (layout === 'written') {
    return renderMarkdown(text, options);
  }

  if (layout === 'code') {
    return renderCode(text, options.columns, options.firstColumns);
  }

  return wrap(text, options.columns, options.firstColumns).map(
    (line): Line => [[options.textStyle, line]],
  );
}
