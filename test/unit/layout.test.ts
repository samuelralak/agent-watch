/** Where things go on the screen, at every terminal size the view is drawn in. */
import { describe, expect, it } from 'vitest';
import { composeFrame } from '../../src/tui/frame.js';
import { boxRoom, type Focus, layoutFor } from '../../src/tui/layout.js';
import { createPainter, row } from '../../src/tui/paint.js';
import { MIN_COLUMNS, MIN_ROWS } from '../../src/tui/screen.js';
import { width } from '../../src/util/text-width.js';

const painter = createPainter(false);

function frame(
  columns: number,
  rows: number,
  warning: boolean,
  textRows = 1,
  focus: Focus = 'list',
) {
  const boxRows = Math.min(textRows, boxRoom(rows, warning));
  const layout = layoutFor(columns, rows, warning, boxRows);

  const fill = (count: number, text: string) =>
    Array.from({ length: count }, () => row([[null, text]]));

  const composed = composeFrame(
    {
      title: row([[null, 'agentwatch']]),
      warning: warning ? row([[null, 'a warning']]) : null,
      list: fill(layout.listRows, 'list'),
      detail: fill(layout.detailRows, 'detail'),
      hints: row([[null, '⏎ message']]),
      focus,
      messageBox: {
        title: [[null, 'To someone']],
        extent: [],
        body: fill(boxRows, 'a message'),
        keys: [[null, '⏎ send']],
        state: [[null, 'idle: wakes it now']],
        cursor: null,
      },
    },
    layout,
    painter,
  );

  return { layout, boxRows, ...composed };
}

describe('the frame', () => {
  it('fills the terminal exactly at every size, with or without a warning, whatever is written', () => {
    for (let rows = MIN_ROWS; rows <= 60; rows += 3) {
      for (const columns of [MIN_COLUMNS, 79, 109, 110, 111, 160, 240]) {
        for (const warning of [false, true]) {
          for (const textRows of [1, 3, 6, 20]) {
            const { lines } = frame(columns, rows, warning, textRows);
            const size = `${columns}x${rows}${warning ? ' with a warning' : ''}, ${textRows} rows of text`;

            expect(lines.length, size).toBe(rows);

            for (const line of lines) {
              expect(width(line), size).toBeLessThan(columns);
            }
          }
        }
      }
    }
  });

  it('keeps the message box and the key hints on the smallest terminal', () => {
    const { lines, inputRow } = frame(MIN_COLUMNS, MIN_ROWS, true);

    expect(lines[inputRow - 1]).toMatch(/^┌ To someone ─+┐$/);
    expect(lines[inputRow]).toMatch(/^│ a message +│$/);
    expect(lines[inputRow + 1]).toMatch(/^└ ⏎ send ─+ idle: wakes it now ─┘$/);
    expect(lines.at(-1)).toContain('⏎ message');
  });

  it('gives the box a row for each row of text, up to six, and leaves the panes room', () => {
    expect(frame(120, 40, false, 1).boxRows).toBe(1);
    expect(frame(120, 40, false, 4).boxRows).toBe(4);
    expect(frame(120, 40, false, 20).boxRows).toBe(6);
    expect(frame(120, 40, false, 20).layout.listRows).toBeGreaterThanOrEqual(5);

    // On a short terminal the panes keep their rows, and the box gets what is left.
    expect(frame(MIN_COLUMNS, MIN_ROWS, false, 20).boxRows).toBe(1);
    expect(frame(80, 14, false, 20).boxRows).toBeLessThan(6);
  });

  it('cuts a title too long for the top border with a mark, and never leaves it out', () => {
    const layout = layoutFor(60, 30, false, 1);
    const blank = row([]);

    const { lines, inputRow } = composeFrame(
      {
        title: blank,
        warning: null,
        list: [],
        detail: [],
        hints: blank,
        focus: 'list',
        messageBox: {
          title: [
            [null, 'To '],
            [null, 'payments-api'],
            [null, ' · about '],
            [null, 'Adversarial review of the drafter before it is committed and deployed'],
          ],
          extent: [[null, 'rows 3-8 of 61']],
          body: [blank],
          keys: [[null, '⏎ send · alt-⏎ new line · esc keeps draft']],
          state: [[null, 'idle: wakes it now']],
          cursor: null,
        },
      },
      layout,
      painter,
    );

    // Who the message goes to stays, cut with a mark; what shows of the draft stays whole.
    expect(lines[inputRow - 1]).toMatch(
      /^┌ To payments-api · about Adver.*… ─+ rows 3-8 of 61 ─┐$/,
    );

    // Keys that do not fit are left out whole, never half named.
    expect(lines[inputRow + 1]).toMatch(/^└─+ idle: wakes it now ─┘$/);

    for (const line of [lines[inputRow - 1], lines[inputRow + 1]]) {
      expect(width(line ?? '')).toBe(59);
    }
  });

  it('marks a cut wherever it falls, also between two pieces of a row', () => {
    const text = (columns: number) =>
      painter.text(
        [
          [null, 'To alpha'],
          [null, ' · about '],
          [null, 'the build'],
        ],
        columns,
      );

    expect(text(30)).toBe('To alpha · about the build');
    expect(text(12)).toBe('To alpha · …');
    // The room ends exactly where one piece does: what follows is still not left out unmarked.
    expect(text(8)).toBe('To alph…');
  });

  it('keeps what is set into the bottom border on the right whole when the row is narrow', () => {
    const { lines, inputRow } = frame(MIN_COLUMNS, MIN_ROWS, false);

    expect(lines[inputRow + 1]).toContain('idle: wakes it now ─┘');
  });

  it("draws the rule over the activity heavy while the arrow keys are the activity's", () => {
    const rule = (lines: string[], heavy: boolean) =>
      lines.find((line) => (heavy ? line.includes('━') : /^─+┬─+$/.test(line)));

    // Side by side: the list's part of the rule stays light.
    expect(rule(frame(160, 40, false).lines, false)).toBeDefined();
    expect(frame(160, 40, false).lines.some((line) => line.includes('━'))).toBe(false);
    expect(rule(frame(160, 40, false, 1, 'activity').lines, true)).toMatch(/^─+┬━+$/);

    // Stacked: it is the rule between the list and the activity.
    const stacked = frame(80, 40, false, 1, 'activity');
    const heavyAt = stacked.lines.findIndex((line) => /^━+$/.test(line));

    expect(heavyAt).toBe(2 + stacked.layout.listRows);
    expect(frame(80, 40, false).lines.some((line) => line.includes('━'))).toBe(false);
  });

  it('puts the list beside the activity on a wide terminal and above it on a narrow one', () => {
    const wide = frame(160, 40, false);

    expect(wide.layout.stacked).toBe(false);
    expect(wide.lines.some((line) => line.includes('list') && line.includes('detail'))).toBe(true);

    const narrow = frame(80, 40, false);

    expect(narrow.layout.stacked).toBe(true);

    expect(narrow.lines.some((line) => line.includes('list') && line.includes('detail'))).toBe(
      false,
    );

    expect(narrow.layout.detailRows).toBeGreaterThan(narrow.layout.listRows);
  });
});
