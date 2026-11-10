import { describe, expect, it } from 'vitest';
import { InputDecoder, type InputToken } from '../../src/tui/input-decoder.js';

/** Feeds the chunks, settles anything pending, and returns the tokens as short strings. */
function decode(chunks: readonly (string | Buffer)[]): string[] {
  const tokens: InputToken[] = [];
  const decoder = new InputDecoder((token) => tokens.push(token));

  for (const chunk of chunks) {
    decoder.feed(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  decoder.flush();

  return tokens.map((token) => {
    if (token.type === 'mouse') {
      return `<${token.action} ${token.row},${token.column}>`;
    }

    return token.type === 'key' ? `<${token.name}>` : `${token.type}:${token.text}`;
  });
}

/** Splits a buffer into reads of `size` bytes, as a terminal delivers a long paste. */
function reads(buffer: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];

  for (let i = 0; i < buffer.length; i += size) {
    out.push(buffer.subarray(i, i + size));
  }

  return out;
}

describe('a paste', () => {
  it('arrives as one paste, however the terminal chunks it', () => {
    const lines = Array.from(
      { length: 60 },
      (_, i) => `Build is failing on main, see log. Line ${i + 1}.`,
    ).join('\n');

    const raw = Buffer.from(`\x1b[200~${lines}\x1b[201~`);

    for (const size of [1022, 100, 7, 1]) {
      expect(decode(reads(raw, size))).toEqual([`paste:${lines}`]);
    }
  });

  it('never presses Enter or runs a command with what it contains', () => {
    expect(decode(['\x1b[200~q\nj\r\x1b[201~'])).toEqual(['paste:q\nj\r']);
  });

  it('is kept apart from what is typed right after it', () => {
    expect(decode(['\x1b[200~pasted\x1b[201~typed\r'])).toEqual([
      'paste:pasted',
      'text:typed',
      '<enter>',
    ]);
  });

  it('is still delivered, as a paste, when its end marker never arrives', () => {
    expect(decode(['\x1b[200~half a paste\nwith a newline'])).toEqual([
      'paste:half a paste\nwith a newline',
    ]);
  });

  it('keeps characters that were split across reads intact', () => {
    const text = '修'.repeat(500);

    expect(decode(reads(Buffer.from(`\x1b[200~${text}\x1b[201~`), 1022))).toEqual([
      `paste:${text}`,
    ]);

    expect(decode(reads(Buffer.from('修正 ✅'), 1)).join('')).toBe('text:修text:正text: text:✅');
  });
});

describe('keys', () => {
  it('read Esc alone as Escape, and Esc followed by a key as an Alt chord', () => {
    expect(decode(['\x1b'])).toEqual(['<escape>']);
    expect(decode(['\x1bb'])).toEqual(['<word-left>']); // Option+Left in most terminals
    expect(decode(['\x1b', 'f'])).toEqual(['<word-right>']); // even split across reads
    expect(decode(['\x1bq'])).toEqual(['<alt-q>']); // never the q command
    expect(decode(['\x1b\x7f'])).toEqual(['<delete-word-back>']);
  });

  it('recognise arrows, word movement and editing keys, whole or split across reads', () => {
    expect(decode(['\x1b[A\x1b[B\x1b[C\x1b[D'])).toEqual(['<up>', '<down>', '<right>', '<left>']);
    expect(decode(['\x1b', '[', 'A'])).toEqual(['<up>']);
    expect(decode(['\x1b[1;3D\x1b[1;5C'])).toEqual(['<word-left>', '<word-right>']);

    expect(decode(['\x1b[H\x1b[F\x1b[1~\x1b[4~\x1b[3~\x1b[5~\x1b[6~'])).toEqual([
      '<home>',
      '<end>',
      '<home>',
      '<end>',
      '<delete>',
      '<pageup>',
      '<pagedown>',
    ]);

    expect(decode(['\x1bOA'])).toEqual(['<up>']);

    expect(decode(['\x15\x04\x03\x01\x05\x17\x0b'])).toEqual([
      '<ctrl-u>',
      '<ctrl-d>',
      '<ctrl-c>',
      '<ctrl-a>',
      '<ctrl-e>',
      '<ctrl-w>',
      '<ctrl-k>',
    ]);
  });

  it('read a wheel step and a click with where the pointer was, and nothing for a button let go', () => {
    expect(decode(['\x1b[<64;10;5M'])).toEqual(['<wheel-up 4,9>']);
    expect(decode(['\x1b[<65;120;40M'])).toEqual(['<wheel-down 39,119>']);
    expect(decode(['\x1b[<0;3;2M', '\x1b[<0;3;2m'])).toEqual(['<press 1,2>']);

    // Shift, Alt or Ctrl held changes the number, not what was done.
    expect(decode(['\x1b[<68;1;1M', '\x1b[<81;1;1M'])).toEqual([
      '<wheel-up 0,0>',
      '<wheel-down 0,0>',
    ]);

    // Split across reads, as any sequence can be; and never typed into a draft.
    expect(decode(['\x1b[<64;1', '0;5M', 'a'])).toEqual(['<wheel-up 4,9>', 'text:a']);
    expect(decode(['\x1b[<2;1;1M', '\x1b[<35;4;4M'])).toEqual([]);
  });

  it('read Alt+Enter as its own key, never as Enter', () => {
    expect(decode(['\x1b\r'])).toEqual(['<alt-enter>']);
    expect(decode(['\x1b', '\r'])).toEqual(['<alt-enter>']);
  });

  it('ignore focus reports and unknown sequences instead of typing them', () => {
    expect(decode(['a\x1b[I\x1b[O\x1b[?25hb'])).toEqual(['text:a', 'text:b']);
    expect(decode(['\x1b[12'])).toEqual([]);
  });
});
