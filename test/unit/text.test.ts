import { describe, expect, it } from 'vitest';
import { cleanBlock, oneLine, stripControls } from '../../src/util/sanitize.js';
import { clip, pad, width, wrap } from '../../src/util/text-width.js';

describe('text from an agent', () => {
  it('cannot retitle the window, clear the screen or move the cursor', () => {
    const hostile = 'All good\x1b]0;PWNED\x07\x1b[2J\x1b[5;1H\x1b[31mFAKE ERROR\x1b[0m done';

    expect(stripControls(hostile)).toBe('All goodFAKE ERROR done');
    expect(oneLine(hostile)).toBe('All goodFAKE ERROR done');
    expect(cleanBlock(hostile)).not.toContain('\x1b');
  });

  it('cannot reorder what a line appears to say with bidi overrides', () => {
    expect(stripControls('approve ‮yolped eht‬')).toBe('approve yolped eht');
  });

  it('keeps its line breaks in a block and loses them on one line', () => {
    expect(cleanBlock('one\r\ntwo\rthree')).toBe('one\ntwo\nthree');
    expect(oneLine('one\n  two\tthree')).toBe('one two three');
  });
});

describe('display width', () => {
  it('counts wide characters and emoji as two columns, combining marks as none', () => {
    expect(width('abc')).toBe(3);
    expect(width('日本')).toBe(4);
    expect(width('✅')).toBe(2);
    expect(width('⚡')).toBe(2);
    expect(width('👩‍💻')).toBe(2);
    expect(width('⚠️')).toBe(2);
    expect(width('é')).toBe(1);
    expect(width('✓ ok')).toBe(4);
  });

  it('clips and pads to exact column counts', () => {
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(width(clip('✅ Fix 修正 done', 8))).toBeLessThanOrEqual(8);
    expect(pad('ab', 5)).toBe('ab   ');
    expect(width(pad('日本語のテキスト', 7))).toBeLessThanOrEqual(7);
  });
});

describe('wrapping', () => {
  it('breaks at spaces and drops nothing', () => {
    const text = 'Wait for the research score totals and then record the latest state';
    const lines = wrap(text, 20);

    expect(lines.every((line) => width(line) <= 20)).toBe(true);
    expect(lines.join(' ')).toBe(text);
  });

  it('breaks a path wider than the line across lines instead of clipping it', () => {
    const path =
      '/private/tmp/claude-501/-Users-dev/87d98e8e/scratchpad/review/security/repro_events.mjs';

    const lines = wrap(`Read ${path}`, 30);

    expect(lines.every((line) => width(line) <= 30)).toBe(true);
    expect(lines.join('').replace(/ /g, '')).toBe(`Read${path}`);
  });

  it('keeps blank lines between paragraphs', () => {
    expect(wrap('one\n\ntwo', 10)).toEqual(['one', '', 'two']);
  });
});

describe('wrapping after a label', () => {
  it('gives the first line its own room and the rest the full width', () => {
    const lines = wrap('one two three four five six seven', 14, 7);

    expect(lines[0]).toBe('one two');
    expect(lines.slice(1).every((line) => width(line) <= 14)).toBe(true);
    expect(lines.join(' ')).toBe('one two three four five six seven');
  });
});
