import type { Focus, Layout } from './layout.js';
import { blankRow, type Painter, type Row, type Segment, type Segments } from './paint.js';
import { style } from './theme.js';
import type { MessageBox } from './views/message-box.js';

/** Everything one frame shows. The panes are already cut to the rows they have. */
export interface FrameParts {
  readonly title: Row;
  readonly warning: Row | null;
  readonly list: readonly Row[];
  readonly detail: readonly Row[];
  readonly messageBox: MessageBox;
  readonly hints: Row;
  /** The pane the arrow keys belong to: the rule over the activity is drawn heavy when it is. */
  readonly focus: Focus;
}

/** A rectangle of the terminal, in rows and columns counted from 0. */
export interface Region {
  readonly top: number;
  readonly left: number;
  readonly rows: number;
  readonly columns: number;
}

export const isInside = (region: Region, row: number, column: number): boolean =>
  row >= region.top &&
  row < region.top + region.rows &&
  column >= region.left &&
  column < region.left + region.columns;

export interface Frame {
  readonly lines: string[];
  /** Where the two panes were drawn. */
  readonly list: Region;
  readonly detail: Region;
  /** Where the text of the message box starts: the cursor is placed from here. */
  readonly inputRow: number;
  readonly inputColumn: number;
}

/** A border and a space on each side of the text in the message box. */
const BOX_PADDING = 2;

/** The columns the text of the message box has in a frame `width` wide. */
export const boxColumns = (width: number): number => width - 2 * BOX_PADDING;

/** What a border spends on its corners, and on the spaces and the rule around what is set in. */
const BORDER_FITTINGS = 8;

/** The columns the texts set into one border may take together, in a frame `width` wide. */
export const borderColumns = (width: number): number => width - BORDER_FITTINGS;

const NOTHING = { text: '', width: 0 };

/** Paints the parts into the terminal rows `layout` gives them. */
export function composeFrame(parts: FrameParts, layout: Layout, painter: Painter): Frame {
  const { width } = layout;
  const lines: string[] = [painter.line(parts.title, width)];

  if (parts.warning) {
    lines.push(painter.line(parts.warning, width));
  }

  if (layout.rules) {
    // Side by side, this rule is the one over the activity; stacked, it is over the list.
    lines.push(paneRule(layout, painter, '┬', !layout.stacked && parts.focus === 'activity'));
  }

  const panesTop = lines.length;

  lines.push(...paneLines(parts, layout, painter));

  const box = boxLines(parts.messageBox, width, painter);
  const inputRow = lines.length + 1;

  lines.push(...box, ` ${painter.line(parts.hints, width - 1)}`);

  return { lines, inputRow, inputColumn: BOX_PADDING, ...paneRegions(layout, panesTop) };
}

/** Where `paneLines` puts the two panes, given the row they start at. */
function paneRegions(layout: Layout, top: number): Pick<Frame, 'list' | 'detail'> {
  const { listWidth, detailWidth, listRows, detailRows } = layout;
  const list = { top, left: 0, rows: listRows, columns: listWidth };

  // Stacked, a rule separates the list from the detail under it; side by side, a bar does.
  const detail = layout.stacked
    ? { top: top + listRows + 1, left: 0, rows: detailRows, columns: detailWidth }
    : { top, left: listWidth + 1, rows: detailRows, columns: detailWidth };

  return { list, detail };
}

/**
 * A rule over the panes. Over the activity it is heavy while the arrow keys are the
 * activity's, so it is plain to see which pane they will move.
 */
function paneRule(
  layout: Layout,
  painter: Painter,
  joint: string,
  activityHasKeys: boolean,
): string {
  const { width, listWidth, detailWidth } = layout;

  const overActivity = (columns: number): Segment =>
    activityHasKeys ? [style.key, '━'.repeat(columns)] : [style.dim, '─'.repeat(columns)];

  if (layout.stacked) {
    return painter.text([overActivity(width)], width);
  }

  return painter.text(
    [[style.dim, `${'─'.repeat(listWidth)}${joint}`], overActivity(detailWidth)],
    width,
  );
}

/** The list and the detail: side by side, or the list above the detail. */
function paneLines(parts: FrameParts, layout: Layout, painter: Painter): string[] {
  const { listWidth, detailWidth, listRows, detailRows } = layout;
  const list = (index: number): string => painter.line(parts.list[index] ?? blankRow, listWidth);

  const detail = (index: number): string =>
    painter.line(parts.detail[index] ?? blankRow, detailWidth);

  if (!layout.stacked) {
    const bar = painter.rule('│', 1);

    return Array.from({ length: listRows }, (_, index) => `${list(index)}${bar}${detail(index)}`);
  }

  return [
    ...Array.from({ length: listRows }, (_, index) => list(index)),
    paneRule(layout, painter, '─', parts.focus === 'activity'),
    ...Array.from({ length: detailRows }, (_, index) => detail(index)),
  ];
}

/** The message box: its top border names who it goes to, its bottom one carries keys and state. */
function boxLines(box: MessageBox, width: number, painter: Painter): string[] {
  const side = painter.rule('│', 1);

  return [
    border(['┌', '┐'], box.title, box.extent, width, painter, 'cut'),
    ...box.body.map((row) => `${side} ${painter.line(row, boxColumns(width))} ${side}`),
    border(['└', '┘'], box.keys, box.state, width, painter, 'left out'),
  ];
}

/**
 * One border of the box, with text set into it: `left` after the corner, `right` before the
 * far one. The right comes first: it is whole wherever the row has the columns for it, and cut
 * with a mark on a narrower one. A left that does not fit beside it is either cut with a mark
 * (who the message goes to must stay) or left out (a key is never shown half named).
 */
function border(
  corners: readonly [string, string],
  left: Segments,
  right: Segments,
  width: number,
  painter: Painter,
  crowdedLeft: 'cut' | 'left out',
): string {
  const [open, close] = corners;
  const inner = width - 2;
  const end = painter.fit(right, Math.max(0, inner - 4));
  const endColumns = end.width > 0 ? end.width + 3 : 0;
  const room = Math.max(0, borderColumns(width) - end.width);
  const whole = painter.fit(left, Number.POSITIVE_INFINITY);
  const crowded = crowdedLeft === 'cut' ? painter.fit(left, room) : NOTHING;
  const start = whole.width <= room ? whole : crowded;
  const startColumns = start.width > 0 ? start.width + 2 : 0;
  const fill = painter.rule('─'.repeat(Math.max(0, inner - startColumns - endColumns)), inner);

  return [
    painter.rule(open, 1),
    start.width > 0 ? ` ${start.text} ` : '',
    fill,
    end.width > 0 ? ` ${end.text} ${painter.rule('─', 1)}` : '',
    painter.rule(close, 1),
  ].join('');
}
