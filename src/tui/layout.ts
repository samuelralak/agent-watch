/** Below this width the list sits above the detail instead of beside it. */
const SIDE_BY_SIDE_FROM = 110;
/** A rule is drawn above the panes only when the terminal has rows to spare. */
const RULES_FROM_ROWS = 18;
/** The message box grows with what is written in it, up to this many rows of text. */
const MAX_BOX_ROWS = 6;
/** The box grows past its first row of text only while the panes keep this many rows. */
const MIN_PANE_ROWS = 5;
/** The borders above and below the text of the message box. */
const BOX_BORDERS = 2;

/**
 * The pane the arrow keys belong to. In the list they move the selection; in the activity they
 * scroll it. The list has them unless the user moved into the activity.
 */
export type Focus = 'list' | 'activity';

/** Where everything goes for one terminal size. */
export interface Layout {
  /** Columns drawn. The terminal's last column stays empty, so no row wraps by itself. */
  readonly width: number;
  /** The list is above the detail, not beside it. */
  readonly stacked: boolean;
  readonly listWidth: number;
  readonly listRows: number;
  readonly detailWidth: number;
  readonly detailRows: number;
  /** A rule is drawn above the panes. */
  readonly rules: boolean;
}

/** The rows everything but the panes and the text of the message box takes. */
function fixedRows(rows: number, hasWarning: boolean): number {
  const title = 1;
  const rule = rows >= RULES_FROM_ROWS ? 1 : 0;
  const hints = 1;

  return title + (hasWarning ? 1 : 0) + rule + BOX_BORDERS + hints;
}

/** How many rows of text the message box may show on a terminal of this height. */
export function boxRoom(rows: number, hasWarning: boolean): number {
  const spare = rows - fixedRows(rows, hasWarning) - MIN_PANE_ROWS;

  return Math.max(1, Math.min(MAX_BOX_ROWS, spare));
}

/**
 * The title, the message box and the key hints always fit: what shrinks on a small terminal is
 * the panes, never the way to send a message or the keys that explain it.
 */
export function layoutFor(
  columns: number,
  rows: number,
  hasWarning: boolean,
  boxRows: number,
): Layout {
  const width = columns - 1;
  const rules = rows >= RULES_FROM_ROWS;
  const body = Math.max(3, rows - fixedRows(rows, hasWarning) - boxRows);

  if (width < SIDE_BY_SIDE_FROM) {
    // One row of the body is the rule between the two panes.
    const listRows = Math.min(Math.max(2, Math.floor(body * 0.4)), Math.max(2, body - 3));

    return {
      width,
      stacked: true,
      listWidth: width,
      listRows,
      detailWidth: width,
      detailRows: Math.max(1, body - listRows - 1),
      rules,
    };
  }

  const listWidth = Math.min(64, Math.max(42, Math.floor(width * 0.38)));

  return {
    width,
    stacked: false,
    listWidth,
    listRows: body,
    detailWidth: width - listWidth - 1,
    detailRows: body,
    rules,
  };
}
