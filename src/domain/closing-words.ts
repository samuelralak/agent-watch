/** How a message ended: the line that says it, and whether that line asks for something. */
export interface ClosingWords {
  /** The request the message ends on when it ends on one, and its last line otherwise. */
  readonly line: string;
  /** The line asks the reader for an answer or a decision. */
  readonly asks: boolean;
}

/** How many of a message's last lines are looked at: a request is often followed by a line or two. */
const LINES_LOOKED_AT = 3;
/** A question mark, then nothing but what closes a quotation, a bracket or an emphasis. */
const ENDS_ASKING = /[?？][)\]"'”’*_`\s]*$/;
/** What Markdown puts around or before a line's words. */
const MARKUP = /^(?:[-*+]|\d+[.)]|#{1,6}|>)\s+|\*\*|__|`/g;

/**
 * Ways of asking for a decision without a question mark. Kept to requests for a choice or a
 * go-ahead: "let me know if you have questions" is a courtesy, and is not among them.
 */
const ASKS_FOR_A_DECISION = new RegExp(
  [
    'let me know (which|whether|how|what|when)\\b',
    "let me know if (you want|you'd like|you would like|i should|this|that)\\b",
    'tell me (which|whether|how|what)\\b',
    '\\b(do|would) you (want|like|prefer)\\b',
    '\\b(should|shall) i\\b',
    '\\bwant me to\\b',
    '\\bplease (confirm|advise|choose|decide|approve)\\b',
    '\\byour (call|decision)\\b',
    '\\b(waiting (for|on)|awaiting) your\\b',
  ].join('|'),
  'i',
);

const asks = (line: string): boolean => ENDS_ASKING.test(line) || ASKS_FOR_A_DECISION.test(line);

/**
 * How a message ended, or null when it says nothing. If one of its last lines asks the reader
 * for something, that line is given; otherwise its last line is.
 *
 * This reads what was said; it does not know what was meant. A question mark and a handful of
 * English phrases are what it goes by, so a request put another way is not recognised as one
 * (its line is still given), and a rhetorical question at the very end is.
 */
export function closingWords(text: string): ClosingWords | null {
  const lines = text
    .split('\n')
    .map((line) => line.replace(MARKUP, '').trim())
    .filter(Boolean);

  const last = lines.at(-1);

  if (!last) {
    return null;
  }

  const request = lines.slice(-LINES_LOOKED_AT).findLast(asks);

  return request ? { line: request, asks: true } : { line: last, asks: false };
}
