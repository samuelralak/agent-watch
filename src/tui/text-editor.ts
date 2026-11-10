import { cleanBlock } from '../util/sanitize.js';
import { width } from '../util/text-width.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const LINE_BREAK = '\n';

const graphemesOf = (text: string): string[] =>
  [...segmenter.segment(text)].map((part) => part.segment);

const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char);

/** One row of the box: the characters from `start` up to, not including, `end`. */
interface VisualRow {
  readonly start: number;
  readonly end: number;
  /** The row ends because the box does, not at a line break: the next row continues its line. */
  readonly wrapped: boolean;
}

export interface EditorView {
  /** The rows in view, top to bottom. */
  readonly rows: string[];
  /** Where the cursor is, within the rows in view. */
  readonly cursor: { readonly row: number; readonly column: number };
  /** The first row in view, counted from 0, and how many rows the text has in all. */
  readonly first: number;
  readonly total: number;
}

/**
 * A text field of several lines: characters, a cursor, and how they wrap in a box of a given
 * width. It does no terminal I/O, so it is tested directly.
 *
 * Wrapping follows what text fields do everywhere. A row breaks after a space where it can, and
 * inside a word only when the word alone is wider than the box. Spaces at the end of a row that
 * wrapped stay with that row: past the edge they hang there unseen, so a row never starts with
 * the space that ended the one above.
 */
export class TextEditor {
  /** One entry per grapheme, so the cursor never lands inside an emoji. */
  private chars: string[] = [];
  private cursor = 0;
  /**
   * Where a word was broken, one position is both the end of a row and the start of the next.
   * True when the cursor at such a position belongs to the end of the row above.
   */
  private atRowEnd = false;
  /** The first row in view when the text has more rows than the box shows. */
  private top = 0;
  /** The width the text was last laid out at: moving up and down goes by these rows. */
  private columns = Number.POSITIVE_INFINITY;

  get text(): string {
    return this.chars.join('');
  }

  /** Nothing is written, or nothing but spaces and line breaks. */
  get isBlank(): boolean {
    return this.chars.every(isSpace);
  }

  /**
   * Inserts at the cursor, all of it: how much a message may hold is for whoever sends it to
   * say, never a reason to drop what was written. Line breaks are kept as line breaks: they
   * are never the Enter key. What cannot be shown (control sequences, characters that reorder
   * a line) is left out, so the draft holds exactly what the box shows.
   */
  insert(text: string): void {
    const before = this.slice(0, this.cursor);
    const after = this.slice(this.cursor);
    const added = cleanBlock(text, Number.POSITIVE_INFINITY);

    // Segmented as one text: a character that arrives in two parts is still one character.
    this.chars = graphemesOf(before + added + after);
    this.place(graphemesOf(before + added).length);
  }

  newLine(): void {
    this.insert(LINE_BREAK);
  }

  left(): void {
    this.place(Math.max(0, this.cursor - 1));
  }

  right(): void {
    this.place(Math.min(this.chars.length, this.cursor + 1));
  }

  /** To the row above, keeping the column where the row is long enough. */
  up(): void {
    this.moveRows(-1);
  }

  down(): void {
    this.moveRows(1);
  }

  /** To the start of the row the cursor is on. */
  home(): void {
    this.place(this.currentRow().start);
  }

  /** To the end of the row the cursor is on: after its last character, before a hanging space. */
  end(): void {
    this.placeOnRow(this.currentRow(), Number.POSITIVE_INFINITY);
  }

  wordLeft(): void {
    this.place(this.wordStart());
  }

  wordRight(): void {
    this.place(this.wordEnd());
  }

  backspace(): void {
    if (this.cursor === 0) {
      return;
    }

    this.chars.splice(this.cursor - 1, 1);
    this.place(this.cursor - 1);
  }

  delete(): void {
    this.chars.splice(this.cursor, 1);
    this.place(this.cursor);
  }

  deleteWordBack(): void {
    const start = this.wordStart();

    this.chars.splice(start, this.cursor - start);
    this.place(start);
  }

  deleteWordForward(): void {
    this.chars.splice(this.cursor, this.wordEnd() - this.cursor);
    this.place(this.cursor);
  }

  /** Deletes from the cursor to the end of the line it is on. */
  killToEnd(): void {
    const lineEnd = this.chars.indexOf(LINE_BREAK, this.cursor);

    this.chars.splice(this.cursor, (lineEnd < 0 ? this.chars.length : lineEnd) - this.cursor);
    this.place(this.cursor);
  }

  /** The text wrapped to `columns`, at most `maxRows` rows of it, with the cursor in view. */
  view(columns: number, maxRows: number): EditorView {
    this.columns = Math.max(1, columns);

    const rows = this.visualRows();
    const cursorRow = this.rowOf(rows);
    const row = rows[cursorRow] ?? { start: 0, end: 0, wrapped: false };

    this.top = Math.min(this.top, cursorRow);
    this.top = Math.max(this.top, cursorRow - maxRows + 1, 0);
    this.top = Math.min(this.top, Math.max(0, rows.length - maxRows));

    return {
      rows: rows.slice(this.top, this.top + maxRows).map((each) => this.shown(each)),
      cursor: {
        row: cursorRow - this.top,
        // Among spaces that hang past the edge, the cursor waits at the edge.
        column: Math.min(this.columns, width(this.slice(row.start, this.cursor))),
      },
      first: this.top,
      total: rows.length,
    };
  }

  /** Every move and every edit ends here, so the cursor never keeps a row it has left. */
  private place(position: number, atRowEnd = false): void {
    this.cursor = position;
    this.atRowEnd = atRowEnd;
  }

  private slice(start: number, end = this.chars.length): string {
    return this.chars.slice(start, end).join('');
  }

  /** A row's text. Spaces that hang past the edge are left out: they are there, unseen. */
  private shown({ start, end }: VisualRow): string {
    const text = this.slice(start, end);

    return width(text) > this.columns ? text.trimEnd() : text;
  }

  private currentRow(): VisualRow {
    const rows = this.visualRows();

    return rows[this.rowOf(rows)] ?? { start: 0, end: 0, wrapped: false };
  }

  /** The row the cursor is on. */
  private rowOf(rows: readonly VisualRow[]): number {
    const index = Math.max(
      0,
      rows.findLastIndex((row) => row.start <= this.cursor),
    );

    const brokenAbove = rows[index - 1]?.wrapped === true && rows[index]?.start === this.cursor;

    return this.atRowEnd && brokenAbove ? index - 1 : index;
  }

  /** The furthest the cursor goes on a row: after its last character that is not a hanging space. */
  private lastPosition(row: VisualRow): number {
    let position = row.end;

    while (row.wrapped && position > row.start && isSpace(this.chars[position - 1])) {
      position--;
    }

    return position;
  }

  /** Puts the cursor on `row`, as near to `column` as the row's text reaches. */
  private placeOnRow(row: VisualRow, column: number): void {
    const last = this.lastPosition(row);
    let position = row.start;
    let used = 0;

    while (position < last && used + width(this.chars[position] ?? '') <= column) {
      used += width(this.chars[position] ?? '');
      position++;
    }

    this.place(position, row.wrapped && position === row.end);
  }

  private moveRows(delta: number): void {
    const rows = this.visualRows();
    const from = this.rowOf(rows);
    const current = rows[from];
    const target = rows[from + delta];

    if (current && target) {
      this.placeOnRow(target, width(this.slice(current.start, this.cursor)));
    }
  }

  /**
   * Where each row of the box starts and ends. A row ends at a line break, or where the next
   * word would not fit: that word starts the next row when it fits on a row of its own, and is
   * broken at the edge when it does not.
   */
  private visualRows(): VisualRow[] {
    const rows: VisualRow[] = [];
    let start = 0;
    let used = 0;
    /** Where the row may be broken: after the last space that follows a word, or -1. */
    let breakAt = -1;
    let hasWord = false;

    const startRow = (at: number, carried: number): void => {
      start = at;
      used = carried;
      breakAt = -1;
      hasWord = carried > 0;
    };

    for (const [index, char] of this.chars.entries()) {
      if (char === LINE_BREAK) {
        rows.push({ start, end: index, wrapped: false });
        startRow(index + 1, 0);
        continue;
      }

      const charWidth = width(char);

      if (isSpace(char)) {
        // A space never starts a row: past the edge it hangs at the end of this one.
        breakAt = hasWord ? index + 1 : breakAt;
        used += charWidth;
        continue;
      }

      if (used + charWidth > this.columns && index > start) {
        const word = breakAt < 0 ? Number.POSITIVE_INFINITY : width(this.slice(breakAt, index));
        const end = word + charWidth <= this.columns ? breakAt : index;

        rows.push({ start, end, wrapped: true });
        startRow(end, end === index ? 0 : word);
      }

      hasWord = true;
      used += charWidth;
    }

    return [...rows, { start, end: this.chars.length, wrapped: false }];
  }

  private wordStart(): number {
    let index = this.cursor;

    while (index > 0 && isSpace(this.chars[index - 1])) {
      index--;
    }

    while (index > 0 && !isSpace(this.chars[index - 1])) {
      index--;
    }

    return index;
  }

  private wordEnd(): number {
    let index = this.cursor;

    while (index < this.chars.length && isSpace(this.chars[index])) {
      index++;
    }

    while (index < this.chars.length && !isSpace(this.chars[index])) {
      index++;
    }

    return index;
  }
}
