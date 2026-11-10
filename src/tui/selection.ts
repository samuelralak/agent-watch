export interface SelectableRow {
  /** `s:<session>` for a session, `a:<session>:<agent>` for one of its agents. */
  readonly key: string;
  readonly sessionId: string;
  readonly agentId: string | null;
}

export const sessionKey = (sessionId: string): string => `s:${sessionId}`;
export const agentKey = (sessionId: string, agentId: string): string => `a:${sessionId}:${agentId}`;

/**
 * Which row is selected after the list changed.
 *
 * The selection moves only when the user moves it. It is picked once, when rows first appear,
 * and if its row goes away it falls back to that row's own session, never to another session:
 * the message box addresses whatever is selected, so a selection that drifts sends to the wrong
 * place.
 */
export function keepSelection(
  current: string | null,
  rows: readonly SelectableRow[],
  isRunning: (row: SelectableRow) => boolean,
): string | null {
  if (current !== null && rows.some((candidate) => candidate.key === current)) {
    return current;
  }

  if (current !== null) {
    const own = sessionKey(current.split(':')[1] ?? '');

    if (rows.some((candidate) => candidate.key === own)) {
      return own;
    }
  }

  const running = rows.find((candidate) => candidate.agentId !== null && isRunning(candidate));

  return (running ?? rows[0])?.key ?? null;
}
