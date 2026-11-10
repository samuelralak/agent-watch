/** Reading how a message ended: what tells a session that is waiting from one that is done. */
import { describe, expect, it } from 'vitest';
import { closingWords } from '../../src/domain/closing-words.js';

describe('how a message ended', () => {
  it('is the question, when its last line asks one', () => {
    expect(closingWords('The build is green.\n\nShall I deploy to production?')).toEqual({
      line: 'Shall I deploy to production?',
      asks: true,
    });
  });

  it('is the question a line or two before the end, where options or a note follow it', () => {
    const text = 'Two ways to do this.\n\nWhich do you prefer?\n- A: rename it\n- B: keep it';

    expect(closingWords(text)).toEqual({ line: 'Which do you prefer?', asks: true });
  });

  it('is a request for a decision put without a question mark', () => {
    for (const request of [
      'Let me know which approach you want.',
      "Let me know if you'd like me to deploy.",
      'Tell me whether to keep the old parser.',
      'I can deploy now if you want me to.',
      'Please confirm before I delete the branch.',
      'Both would work; your call.',
      'Waiting on your go-ahead to merge.',
    ]) {
      expect(closingWords(`Done with the first part.\n\n${request}`), request).toEqual({
        line: request,
        asks: true,
      });
    }
  });

  it('is its last line, and asks nothing, when it ends by telling', () => {
    expect(closingWords('Why did it fail? Because the port was taken.\nFixed now.')).toEqual({
      line: 'Fixed now.',
      asks: false,
    });

    // A courtesy is not a request, and a question far from the end is part of the telling.
    expect(closingWords('All done.\nLet me know if you have any questions.')?.asks).toBe(false);

    expect(closingWords('Was it the cache?\nNo.\nIt was the port.\nFixed.\nAll green.')).toEqual({
      line: 'All green.',
      asks: false,
    });
  });

  it('is given in plain words, without the Markdown around it', () => {
    expect(closingWords('- **Deploy now?**')?.line).toBe('Deploy now?');
    expect(closingWords('Run `make release` too? ')?.line).toBe('Run make release too?');
    expect(closingWords('## Summary\n\n1. Everything passes.')?.line).toBe('Everything passes.');
    expect(closingWords('続けますか？')).toEqual({ line: '続けますか？', asks: true });
  });

  it('is nothing for a message that says nothing', () => {
    expect(closingWords('')).toBeNull();
    expect(closingWords('\n  \n')).toBeNull();
  });
});
