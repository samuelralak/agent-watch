import { createPainter, type Row } from '../../src/tui/paint.js';

const painter = createPainter(false);

/** Rows as plain text `columns` wide, without colour or trailing spaces. */
export const plain = (rows: readonly Row[], columns = 100): string[] =>
  rows.map((row) => painter.line(row, columns).trimEnd());

/** All the words of some rows in order, as one line: what a reader sees, however it wrapped. */
export const words = (rows: readonly Row[], columns = 100): string =>
  plain(rows, columns).join(' ').split(/\s+/).filter(Boolean).join(' ');
