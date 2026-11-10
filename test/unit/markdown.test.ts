/** Text as an agent wrote it, laid out for the terminal. */
import { describe, expect, it } from 'vitest';
import { type Line, renderMarkdown } from '../../src/tui/markdown.js';
import { style } from '../../src/tui/theme.js';
import { width } from '../../src/util/text-width.js';

const render = (text: string, columns = 60, firstColumns?: number): Line[] =>
  renderMarkdown(text, { columns, firstColumns, textStyle: style.plain });

const plain = (lines: readonly Line[]): string[] =>
  lines.map((line) => line.map(([, text]) => text).join(''));

/** The style a piece of text is drawn in, wherever it landed. */
const styleOf = (lines: readonly Line[], text: string) =>
  lines.flat().find((segment) => segment[1].includes(text))?.[0];

describe('what an agent wrote', () => {
  it('keeps its line breaks and its indentation', () => {
    const text =
      'Done. Two things changed:\n  first, the parser\n    and its tests\nNext: the docs.';

    expect(plain(render(text))).toEqual([
      'Done. Two things changed:',
      '  first, the parser',
      '    and its tests',
      'Next: the docs.',
    ]);
  });

  it('leaves one blank row between blocks, however many blank lines there were', () => {
    expect(plain(render('one\n\n\n\ntwo\n\n'))).toEqual(['one', '', 'two']);
  });

  it('wraps a long line under its own indentation', () => {
    const rows = plain(render('    an indented line that is too long for the row it is on', 30));

    expect(rows).toEqual([
      '    an indented line that is',
      '    too long for the row it is',
      '    on',
    ]);
  });

  it('breaks a word longer than a row instead of cutting it', () => {
    const path = '/a/very/long/path/that/does/not/fit/on/one/row/of/the/pane.ts';
    const rows = plain(render(`see ${path} now`, 24));

    expect(rows.join('')).toBe(`see${path} now`);
    expect(rows.every((row) => width(row) <= 24)).toBe(true);
  });

  it('gives the first row less room when a label sits beside it', () => {
    const rows = plain(render('alpha beta gamma delta epsilon', 30, 12));

    expect(rows).toEqual(['alpha beta', 'gamma delta epsilon']);
  });

  it('puts every word on some row, at any width', () => {
    const text =
      '# Plan\n\n1. **Read** the `config.ts` file\n2. Run:\n```\nnpm   test -- --watch\n```\n> then tell me';

    for (const columns of [10, 17, 33, 80]) {
      // A word wider than a row is broken across rows: nothing of it is lost.
      const shown = plain(render(text, columns)).join('').replace(/\s+/g, '');

      for (const word of ['Plan', 'Read', 'config.ts', 'npm', '--watch', 'then', 'tell']) {
        expect(shown, `${word} at ${columns}`).toContain(word);
      }
    }
  });
});

describe('Markdown', () => {
  it('shows a heading in bold, without its marks', () => {
    const rows = render('## What changed');

    expect(plain(rows)).toEqual(['What changed']);
    expect(styleOf(rows, 'What')).toBe(style.bold);
  });

  it('shows bold and inline code as what they mean, without the marks', () => {
    const rows = render('Run `npm test` and **do not** skip it.');

    expect(plain(rows)).toEqual(['Run npm test and do not skip it.']);
    expect(styleOf(rows, 'npm')).toBe(style.code);
    expect(styleOf(rows, 'do')).toBe(style.bold);
    expect(styleOf(rows, 'skip')).toBe(style.plain);
  });

  it('keeps bold on top of the colour the text already has', () => {
    const rows = renderMarkdown('a **b**', { columns: 40, textStyle: style.magenta });

    expect(styleOf(rows, 'b')).toBe(`${style.magenta};1`);
  });

  it('shows list items with a marker, and wraps them under their own text', () => {
    const rows = plain(
      render('- first item which is long enough to wrap\n  - nested\n3. third', 24),
    );

    expect(rows).toEqual([
      '• first item which is',
      '  long enough to wrap',
      '  • nested',
      '3. third',
    ]);
  });

  it('shows a quotation set off by a bar', () => {
    expect(plain(render('> as the user said'))).toEqual(['│ as the user said']);
  });

  it('shows a code block exactly as written, without its fences', () => {
    const text =
      'Here:\n```ts\nfunction add(a, b) {\n    return a  +  b; // **not bold**\n}\n```\nDone.';

    const rows = render(text);

    expect(plain(rows)).toEqual([
      'Here:',
      'function add(a, b) {',
      '    return a  +  b; // **not bold**',
      '}',
      'Done.',
    ]);

    expect(styleOf(rows, 'return')).toBe(style.code);
    expect(styleOf(rows, 'Done')).toBe(style.plain);
  });

  it('continues a code line that is too long on the next row, losing nothing', () => {
    const line = 'const result = await client.messages.create({ model, max_tokens });';
    const rows = plain(render(`\`\`\`\n${line}\n\`\`\``, 30));

    expect(rows.join('')).toBe(line);
    expect(rows.every((row) => width(row) <= 30)).toBe(true);
  });

  it('leaves text that only looks like Markdown alone', () => {
    expect(plain(render('2 * 3 * 4 = 24 and snake_case_name stay as they are'))).toEqual([
      '2 * 3 * 4 = 24 and snake_case_name stay as they are',
    ]);
  });
});

describe('a Markdown table', () => {
  /** The rows as text, without the spaces a row ends with. */
  const rendered = (text: string, columns: number): string[] =>
    plain(render(text, columns)).map((row) => row.trimEnd());

  const table = [
    '| Key | Action |',
    '| --- | --- |',
    '| `⏎` | send the message |',
    '| `alt-⏎` | new line |',
  ].join('\n');

  it('is laid out in columns as wide as their longest cell, its first row in bold', () => {
    expect(rendered(table, 60)).toEqual([
      'Key   │ Action',
      '──────┼─────────────────',
      '⏎     │ send the message',
      'alt-⏎ │ new line',
    ]);

    expect(styleOf(render(table), 'Key')).toContain('1');
  });

  it('wraps a cell inside its column when the pane is narrower than the table', () => {
    const wide = [
      '| Area | What you get |',
      '| --- | --- |',
      '| Message box | A bordered box that grows to six rows as you write in it |',
      '| Scrolling | Tab into the activity |',
    ].join('\n');

    expect(rendered(wide, 40)).toEqual([
      'Area        │ What you get',
      `${'─'.repeat(11)}─┼─${'─'.repeat(26)}`, // the whole width of the pane: 40 columns
      'Message box │ A bordered box that grows',
      '            │ to six rows as you write',
      '            │ in it',
      'Scrolling   │ Tab into the activity',
    ]);

    for (const columns of [12, 20, 33, 47]) {
      for (const row of rendered(wide, columns)) {
        expect(width(row), `at ${columns}`).toBeLessThanOrEqual(columns);
      }
    }
  });

  it('aligns a column to the right or the middle where its delimiter says so', () => {
    const numbers = [
      '| Test | ms |',
      '| :--- | ---: |',
      '| fast one | 12 |',
      '| slow | 3389 |',
    ].join('\n');

    expect(rendered(numbers, 40)).toEqual([
      'Test     │   ms',
      '─────────┼─────',
      'fast one │   12',
      'slow     │ 3389',
    ]);
  });

  it('keeps the text around it, and fills out a row that has fewer cells', () => {
    const text = `Before.\n\n${table}\n| orphan |\n\nAfter.`;

    expect(rendered(text, 60)).toEqual([
      'Before.',
      '',
      'Key    │ Action',
      '───────┼─────────────────',
      '⏎      │ send the message',
      'alt-⏎  │ new line',
      'orphan │',
      '',
      'After.',
    ]);
  });

  it('is left as written when it is not one, or when the pane is too narrow for its columns', () => {
    expect(rendered('a | b\nplain text', 40)).toEqual(['a | b', 'plain text']);
    expect(rendered('```\n| a | b |\n| - | - |\n```', 40)).toEqual(['| a | b |', '| - | - |']);

    const many = `| ${'x |'.repeat(12)}\n| ${'- |'.repeat(12)}\n| ${'1 |'.repeat(12)}`;

    expect(rendered(many, 20).join(' ')).toContain('|');
  });
});
