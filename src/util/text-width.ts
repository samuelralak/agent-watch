// Display width of text in terminal columns, by grapheme: an emoji sequence is one unit two
// columns wide, a combining mark adds nothing.

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/**
 * Code points that take two columns: East Asian wide characters, and the symbols and emoji
 * terminals draw wide. Each entry is a first and a last code point; the list is in order.
 */
const WIDE_RANGES: readonly (readonly [first: number, last: number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3040, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff],
  [0x20000, 0x3fffd],
];

/** Whether a code point takes two columns: a binary search of the ranges above. */
function isWide(codePoint: number): boolean {
  let low = 0;
  let high = WIDE_RANGES.length - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const [first, last] = WIDE_RANGES[middle] ?? [0, 0];

    if (codePoint < first) {
      high = middle - 1;
    } else if (codePoint > last) {
      low = middle + 1;
    } else {
      return true;
    }
  }

  return false;
}

function isZeroWidth(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp < 0xa0) ||
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x200d ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

function graphemeWidth(grapheme: string): number {
  let base = 0;
  let emojiPresentation = false;

  for (const ch of grapheme) {
    const cp = ch.codePointAt(0)!;

    if (cp === 0xfe0f || cp === 0x200d) {
      emojiPresentation = true;
    }

    if (isZeroWidth(cp)) {
      continue;
    }

    if (isWide(cp)) {
      return 2;
    }

    if (base === 0) {
      base = 1;
    }
  }

  return emojiPresentation && base === 1 ? 2 : base;
}

/** Columns `text` occupies in a terminal. */
export function width(text: string): number {
  if (ASCII_PRINTABLE.test(text)) {
    return text.length;
  }

  let total = 0;

  for (const { segment } of graphemes.segment(text)) {
    total += graphemeWidth(segment);
  }

  return total;
}

/** Splits into graphemes, each with its column width. */
export function cells(text: string): { readonly text: string; readonly width: number }[] {
  return [...graphemes.segment(text)].map(({ segment }) => ({
    text: segment,
    width: graphemeWidth(segment),
  }));
}

/** At most `max` columns; an ellipsis marks a cut. */
export function clip(text: string, max: number): string {
  if (max <= 0) {
    return '';
  }

  if (width(text) <= max) {
    return text;
  }

  let used = 0;
  let out = '';

  for (const cell of cells(text)) {
    if (used + cell.width > max - 1) {
      break;
    }

    out += cell.text;
    used += cell.width;
  }

  return `${out}…`;
}

/** Exactly `columns` wide: padded with spaces, or clipped. */
export function pad(text: string, columns: number): string {
  const w = width(text);

  return w >= columns ? clip(text, columns) : text + ' '.repeat(columns - w);
}

/**
 * Breaks `text` into lines of at most `columns`, at spaces where it can and inside a word only
 * when the word alone is wider than a line. Nothing is dropped. The very first line may have a
 * different room (`firstColumns`), for text that starts after a label.
 */
export function wrap(text: string, columns: number, firstColumns = columns): string[] {
  const out: string[] = [];
  const room = (): number => Math.max(1, out.length === 0 ? firstColumns : columns);

  for (const paragraph of text.split('\n')) {
    let line = '';
    let lineWidth = 0;

    const flush = (): void => {
      out.push(line);
      line = '';
      lineWidth = 0;
    };

    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const wordWidth = width(word);

      if (lineWidth > 0 && lineWidth + 1 + wordWidth > room()) {
        flush();
      }

      if (wordWidth <= room()) {
        line += (lineWidth > 0 ? ' ' : '') + word;
        lineWidth += (lineWidth > 0 ? 1 : 0) + wordWidth;
        continue;
      }

      // A word wider than the line (a path, a URL): broken across lines, not clipped.
      for (const cell of cells(word)) {
        if (lineWidth + cell.width > room()) {
          flush();
        }

        line += cell.text;
        lineWidth += cell.width;
      }
    }

    if (lineWidth > 0 || paragraph.trim() === '') {
      flush();
    }
  }

  return out;
}
