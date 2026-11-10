/**
 * Claude Code versions whose transcript format was checked against this code. Transcripts are an
 * internal format (hooks are the documented one), so a session on any other version gets a
 * warning that its history may be read wrongly.
 */
export const VERIFIED_CLAUDE_VERSIONS: readonly string[] = [
  '2.1.316',
  '2.1.317',
  '2.1.319',
  '2.1.321',
  '2.1.322',
];
