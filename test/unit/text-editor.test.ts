/** The message box's text field: several lines, a cursor, and how the text wraps in the box. */
import { describe, expect, it } from 'vitest';
import { TextEditor } from '../../src/tui/text-editor.js';
import { width } from '../../src/util/text-width.js';

const typed = (text: string): TextEditor => {
  const editor = new TextEditor();

  editor.insert(text);

  return editor;
};

describe('editing a draft', () => {
  it('moves by word, deletes, and takes a paste in the middle', () => {
    const editor = typed('skip the rerun');

    editor.wordLeft();
    editor.insert('second ');
    expect(editor.text).toBe('skip the second rerun');

    editor.home();
    editor.deleteWordForward();
    expect(editor.text).toBe(' the second rerun');

    editor.end();
    editor.deleteWordBack();
    editor.backspace();
    expect(editor.text).toBe(' the second');

    editor.left();
    editor.delete();
    expect(editor.text).toBe(' the secon');
  });

  it('holds all of what it is given, however long: what a message may hold is not its to decide', () => {
    const long = `${'word '.repeat(2000)}the end`;

    expect(typed(long).text).toBe(long);
  });

  it('never puts the cursor inside an emoji', () => {
    const editor = typed('a👩‍💻b');

    editor.left();
    editor.backspace();
    expect(editor.text).toBe('ab');
  });

  it('drops control characters and turns tabs into spaces', () => {
    expect(typed('a\tb\x07c').text).toBe('a  bc');
  });

  it('holds exactly what it shows: nothing that reorders a line, no escape sequence', () => {
    expect(typed('+254\u202a 700 000\u202c').text).toBe('+254 700 000');
    expect(typed('red \x1b[31mtext').text).toBe('red text');
  });

  it('keeps a character whole when it arrives in two parts', () => {
    const editor = typed('a');

    editor.insert('❤');
    editor.insert('\ufe0f'); // the part that makes the heart an emoji
    expect(editor.view(20, 3).cursor.column).toBe(3);

    editor.backspace();
    expect(editor.text).toBe('a');
  });

  it('counts a draft of spaces and line breaks as nothing written', () => {
    expect(typed(' \n  \n').isBlank).toBe(true);
    expect(typed(' \n x').isBlank).toBe(false);
  });
});

describe('a draft of several lines', () => {
  it('keeps the line breaks of what is pasted, and can be given one by hand', () => {
    const editor = typed('first line\r\nsecond line');

    editor.newLine();
    editor.insert('third');
    expect(editor.text).toBe('first line\nsecond line\nthird');
    expect(editor.view(40, 6).rows).toEqual(['first line', 'second line', 'third']);
  });

  it('wraps at words to the width of the box, and breaks a word wider than the box', () => {
    const editor = typed('hold the promotion until supercalifragilistic is seen');

    expect(editor.view(12, 10).rows.map((row) => row.trimEnd())).toEqual([
      'hold the',
      'promotion',
      'until',
      'supercalifra',
      'gilistic is',
      'seen',
    ]);
  });

  it('says where the cursor is among the rows', () => {
    const editor = typed('one two three');

    expect(editor.view(8, 6).cursor).toEqual({ row: 1, column: 5 });

    editor.home();
    expect(editor.view(8, 6).cursor).toEqual({ row: 1, column: 0 });

    editor.up();
    expect(editor.view(8, 6).cursor).toEqual({ row: 0, column: 0 });
  });

  it('moves up and down by row, keeping the column where the row is long enough', () => {
    const editor = typed('a long first line\nshort\nanother long line');

    editor.view(40, 6);
    editor.up();
    expect(editor.view(40, 6).cursor).toEqual({ row: 1, column: 5 }); // "short" ends at 5

    editor.up();
    expect(editor.view(40, 6).cursor).toEqual({ row: 0, column: 5 });

    editor.down();
    editor.down();
    editor.down(); // already on the last row: stays
    expect(editor.view(40, 6).cursor.row).toBe(2);
  });

  it('deletes to the end of the line the cursor is on, not past it', () => {
    const editor = typed('keep this, drop that\nand keep this line');

    editor.up();
    editor.home();
    editor.wordRight();
    editor.wordRight();
    editor.killToEnd();
    expect(editor.text).toBe('keep this,\nand keep this line');
  });

  it('shows the rows around the cursor when there are more than the box has room for', () => {
    const editor = typed('1\n2\n3\n4\n5\n6\n7\n8');

    expect(editor.view(20, 3)).toEqual({
      rows: ['6', '7', '8'],
      cursor: { row: 2, column: 1 },
      first: 5,
      total: 8,
    });

    for (let i = 0; i < 6; i++) {
      editor.up();
    }

    expect(editor.view(20, 3)).toEqual({
      rows: ['2', '3', '4'],
      cursor: { row: 0, column: 1 },
      first: 1,
      total: 8,
    });
  });

  it('never starts a row with the space that ended the row above', () => {
    expect(typed('hello world again').view(5, 10).rows).toEqual(['hello', 'world', 'again']);

    // A row that fills the box exactly: its space hangs at its end, unseen.
    expect(typed('abcde fgh').view(5, 10).rows).toEqual(['abcde', 'fgh']);

    // Indentation is the writer's own, and stays.
    expect(typed('one\n  two').view(10, 10).rows).toEqual(['one', '  two']);
  });

  it('never makes a row wider than the box, whatever is written', () => {
    const drafts = [
      'the failing test is in test/integration/some/deeply/nested/directory/viewer.test.ts now',
      ` ${'b'.repeat(34)}中 and more`,
      ` ${'日本語'.repeat(8)}`,
      `${' '.repeat(50)}indented far past the edge`,
      `ends in spaces${' '.repeat(60)}`,
      'emoji 👩‍💻👍🏽 beside wide 中文 text that wraps more than once in a narrow box',
    ];

    for (const draft of drafts) {
      for (const columns of [5, 12, 35, 36, 75]) {
        const editor = typed(draft);
        const { rows, cursor } = editor.view(columns, 100);

        for (const row of rows) {
          expect(width(row), `"${draft}" at ${columns}`).toBeLessThanOrEqual(columns);
        }

        expect(cursor.column, `"${draft}" at ${columns}`).toBeLessThanOrEqual(columns);
        // Nothing is lost between the rows: only spaces that hang are unseen.
        expect(rows.join('').replace(/\s/g, '')).toBe(draft.replace(/\s/g, ''));
      }
    }
  });

  it('goes up and down one row at a time, to the end of a row shorter than the column', () => {
    const editor = typed('hello world foo bar baz');

    expect(editor.view(10, 6).rows.map((row) => row.trimEnd())).toEqual([
      'hello',
      'world foo',
      'bar baz',
    ]);

    editor.up();
    expect(editor.view(10, 6).cursor).toEqual({ row: 1, column: 7 });

    editor.up();
    expect(editor.view(10, 6).cursor).toEqual({ row: 0, column: 5 });

    const skipping = typed('aaaaaaaaa bb cccccccccc dddddddddd');

    skipping.view(10, 6);
    skipping.up();
    skipping.up();
    skipping.up();
    skipping.end();
    expect(skipping.view(10, 6).cursor).toEqual({ row: 0, column: 9 });

    skipping.down();
    expect(skipping.view(10, 6).cursor).toEqual({ row: 1, column: 2 }); // after "bb", not past it
  });

  it('puts End after the last character of a row that fills the box', () => {
    const editor = typed('abcde fgh');

    editor.view(5, 6);
    editor.up();
    editor.home();
    editor.end();
    expect(editor.view(5, 6).cursor).toEqual({ row: 0, column: 5 });

    editor.insert('!');
    expect(editor.text).toBe('abcde! fgh');
  });

  it('puts End at the end of a row where a long word was broken, and types there', () => {
    const editor = typed('abcdefghijklmno');

    editor.view(5, 6);
    editor.up();
    expect(editor.view(5, 6).cursor).toEqual({ row: 1, column: 5 });

    editor.up();
    editor.home();
    editor.end();
    expect(editor.view(5, 6).cursor).toEqual({ row: 0, column: 5 });

    editor.insert('X');
    expect(editor.text).toBe('abcdeXfghijklmno');
    expect(editor.view(5, 6).cursor).toEqual({ row: 1, column: 1 });
  });

  it('reaches every row with Up and Down from anywhere in ordinary prose', () => {
    const prose =
      'first read the whole of the report that the reviewer left on the pull request and then ' +
      'look at test/integration/some/deeply/nested/directory/structure/viewer.test.ts too, ' +
      'because the failing test is in there and it is the one that matters most right now';

    for (const columns of [20, 35, 36, 60, 75]) {
      const editor = typed(prose);
      const total = editor.view(columns, 100).total;

      for (let row = total - 1; row > 0; row--) {
        expect(editor.view(columns, 100).cursor.row, `up at ${columns}`).toBe(row);
        editor.up();
      }

      expect(editor.view(columns, 100).cursor.row).toBe(0);
      editor.end();

      for (let row = 0; row < total - 1; row++) {
        expect(editor.view(columns, 100).cursor.row, `down at ${columns}`).toBe(row);
        editor.down();
      }

      expect(editor.view(columns, 100).cursor.row).toBe(total - 1);
    }
  });

  it('is one empty row, with the cursor at its start, before anything is written', () => {
    const editor = new TextEditor();

    expect(editor.isBlank).toBe(true);

    expect(editor.view(20, 6)).toEqual({
      rows: [''],
      cursor: { row: 0, column: 0 },
      first: 0,
      total: 1,
    });
  });
});
