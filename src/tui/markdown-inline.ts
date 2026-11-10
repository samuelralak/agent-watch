// The words of one line of text, laid out: which of them are bold or code, and how they wrap
// onto rows. The blocks of Markdown (a paragraph, a list item, a cell of a table) are built on
// this.
import { cells, width } from '../util/text-width.js';
import type { Segment, Style } from './paint.js';
import { style } from './theme.js';

/** One row on screen. */
export type Line = readonly Segment[];

/** A run of text in one style. */
export interface Span {
  readonly text: string;
  readonly style: Style;
}

/** One source line, understood: what leads it, how far its wrapped rows hang, and its text. */
export interface Block {
  readonly indent: number;
  readonly marker: Segment | null;
  readonly hang: number;
  readonly spans: readonly Span[];
}

/** Text beside its indentation needs at least this many columns. */
export const MIN_COLUMNS = 8;

/** `**bold**`, `__bold__` and `` `code` ``: the inline marks worth showing as what they mean. */
const INLINE = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1|`([^`\n]+)`/g;

export const bold = (base: Style): Style => (base ? `${base};1` : style.bold);

/** The columns a row takes. */
export const lineWidth = (line: Line): number =>
  line.reduce((sum, [, text]) => sum + width(text), 0);

/** The text of a line as runs of one style each: plain, bold, or code. */
export function spansOf(text: string, textStyle: Style): Span[] {
  const spans: Span[] = [];
  let at = 0;

  for (const match of text.matchAll(INLINE)) {
    const [whole, , strong, code] = match;

    if (match.index > at) {
      spans.push({ text: text.slice(at, match.index), style: textStyle });
    }

    spans.push(
      code === undefined
        ? { text: strong ?? '', style: bold(textStyle) }
        : { text: code, style: style.code },
    );

    at = match.index + whole.length;
  }

  if (at < text.length) {
    spans.push({ text: text.slice(at), style: textStyle });
  }

  return spans;
}

/** A word and the style it is drawn in; `gap` says a space came before it. */
interface Word {
  readonly text: string;
  readonly style: Style;
  readonly gap: boolean;
}

function wordsOf(spans: readonly Span[]): Word[] {
  const words: Word[] = [];
  let gap = false;

  for (const span of spans) {
    for (const piece of span.text.split(/( +)/)) {
      if (piece.trim() === '') {
        gap = gap || piece.length > 0;
      } else {
        words.push({ text: piece, style: span.style, gap });
        gap = false;
      }
    }
  }

  return words;
}

/** Indentation never takes so much of a row that no text fits beside it. */
const clamped = (indent: number, columns: number): number =>
  Math.max(0, Math.min(indent, columns - MIN_COLUMNS));

/**
 * The block as rows: its first row starts at its indentation, with its marker; the rows it
 * wraps onto hang under its text.
 */
export function wrapBlock(block: Block, firstColumns: number, columns: number): Line[] {
  const rows = new RowBuilder(block, firstColumns, columns);
  const markerWidth = block.marker ? width(block.marker[1]) : 0;
  const firstRoom = firstColumns - clamped(block.indent, firstColumns) - markerWidth;
  const restRoom = columns - clamped(block.hang, columns);
  const longest = Math.max(1, Math.min(firstRoom, restRoom));

  for (const word of wordsOf(block.spans)) {
    for (const piece of broken(word, longest)) {
      rows.add(piece);
    }
  }

  return rows.finish();
}

/** A word wider than a row, as pieces that each fit one; any other word as it is. */
function broken(word: Word, longest: number): Word[] {
  if (width(word.text) <= longest) {
    return [word];
  }

  const pieces: Word[] = [];
  let current = '';
  let used = 0;

  for (const cell of cells(word.text)) {
    if (used + cell.width > longest) {
      pieces.push({ text: current, style: word.style, gap: pieces.length === 0 && word.gap });
      current = '';
      used = 0;
    }

    current += cell.text;
    used += cell.width;
  }

  return [...pieces, { text: current, style: word.style, gap: pieces.length === 0 && word.gap }];
}

/** Fills rows with words, starting a new row when the next word does not fit. */
class RowBuilder {
  private readonly lines: Line[] = [];
  private segments: Segment[] = [];
  private used = 0;
  /** The row holds no word yet: the next one needs no space before it. */
  private empty = true;

  constructor(
    private readonly block: Block,
    private readonly firstColumns: number,
    private readonly columns: number,
  ) {
    this.start(clamped(block.indent, firstColumns), block.marker);
  }

  add(word: Word): void {
    const room = this.lines.length === 0 ? this.firstColumns : this.columns;
    const fits = this.used + (word.gap ? 1 : 0) + width(word.text) <= room;

    if (!this.empty && !fits) {
      this.lines.push(this.segments);
      this.start(clamped(this.block.hang, this.columns), null);
    }

    const text = word.gap && !this.empty ? ` ${word.text}` : word.text;

    this.segments.push([word.style, text]);
    this.used += width(text);
    this.empty = false;
  }

  finish(): Line[] {
    return [...this.lines, this.segments];
  }

  private start(indent: number, marker: Segment | null): void {
    this.segments = indent > 0 ? [[null, ' '.repeat(indent)]] : [];
    this.used = indent;
    this.empty = true;

    if (marker) {
      this.segments.push(marker);
      this.used += width(marker[1]);
    }
  }
}
