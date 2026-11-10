// Text from agents, tools and transcripts is untrusted: it can carry terminal control sequences
// that retitle the window, clear the screen or repaint a line. Everything shown passes through
// here.

// CSI, OSC (terminated by BEL or ST), and two-character escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;
// C0 and C1 controls, DEL, and the bidi overrides that can reorder what a line appears to say.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;

/** A tab is shown as this many spaces, so indentation keeps its shape. */
const TAB = '  ';

/** Removes control sequences and control characters; tabs become spaces, newlines stay. */
export function stripControls(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, '').replace(/\t/g, TAB).replace(CONTROL, '');
}

/** One printable line: controls removed, whitespace collapsed, at most `max` characters. */
export function oneLine(text: unknown, max = 2000): string {
  const flat = stripControls(String(text ?? ''))
    .replace(/\s+/g, ' ')
    .trim();

  return flat.length > max ? flat.slice(0, max) : flat;
}

/**
 * Printable text that keeps its line breaks and indentation (what an agent said, a report, a
 * prompt, a command), at most `max` characters.
 */
export function cleanBlock(text: unknown, max = 20_000): string {
  // Line endings first: a bare carriage return is a control character and would be dropped.
  const clean = stripControls(String(text ?? '').replace(/\r\n?/g, '\n'));

  return clean.length > max ? clean.slice(0, max) : clean;
}
