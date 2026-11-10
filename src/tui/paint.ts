// Lines for the terminal, as data: views build segments, and only this module turns them into
// escape sequences. Every segment's text is stripped of control characters here, so nothing a
// view passes through can reach the terminal as a control sequence.
import { stripControls } from '../util/sanitize.js';
import { clip, width } from '../util/text-width.js';

/** SGR parameters such as `1;36`, or null for the terminal's default. */
export type Style = string | null;
export type Segment = readonly [style: Style, text: string];
export type Segments = readonly (Segment | null | false | undefined)[];

/** One terminal row: text from the left edge, and optionally text flush to the right edge. */
export interface Row {
  readonly left: Segments;
  readonly right?: Segments;
}

export const row = (left: Segments, right?: Segments): Row => ({ left, right });
export const blankRow: Row = { left: [] };

export interface Painter {
  /** `row` as a string exactly `columns` wide. */
  line(row: Row, columns: number): string;
  /** A horizontal rule. */
  rule(text: string, columns: number): string;
  /** `segments` as text at most `columns` wide, not padded: for output that is not a screen. */
  text(segments: Segments, columns: number): string;
  /** `segments` painted to at most `columns`, with the columns they take. */
  fit(segments: Segments, columns: number): { readonly text: string; readonly width: number };
}

const printable = (text: string): string => stripControls(text).replace(/\n/g, ' ');
/** What `clip` ends a cut text with. */
const CUT_MARK = '…';

export function createPainter(color: boolean): Painter {
  const paint = (segments: Segments, columns: number): { text: string; width: number } => {
    const pieces: { style: Style; text: string }[] = [];
    let used = 0;
    let leftOut = false;

    for (const segment of segments) {
      const clean = segment ? printable(segment[1]) : '';

      if (!segment || clean === '') {
        continue;
      }

      if (used >= columns) {
        leftOut = true;
        break;
      }

      const piece = clip(clean, columns - used);

      used += width(piece);
      pieces.push({ style: segment[0], text: piece });
    }

    const last = pieces.at(-1);

    // Text that found no room is never left out without a mark, wherever the cut falls.
    if (leftOut && last && !last.text.endsWith(CUT_MARK)) {
      last.text = clip(`${last.text}${CUT_MARK}`, width(last.text));
    }

    return {
      text: pieces
        .map((piece) =>
          color && piece.style ? `\x1b[${piece.style}m${piece.text}\x1b[0m` : piece.text,
        )
        .join(''),
      width: pieces.reduce((sum, piece) => sum + width(piece.text), 0),
    };
  };

  return {
    line({ left, right }, columns) {
      const end = right && right.length > 0 ? paint(right, columns) : { text: '', width: 0 };
      const start = paint(left, Math.max(0, columns - end.width - (end.width > 0 ? 2 : 0)));

      return start.text + ' '.repeat(Math.max(0, columns - start.width - end.width)) + end.text;
    },
    rule(text, columns) {
      return paint([['2', text]], columns).text;
    },
    text(segments, columns) {
      return paint(segments, columns).text;
    },
    fit: paint,
  };
}
