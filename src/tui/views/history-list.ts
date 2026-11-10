import type { PastSession } from '../../application/ports/session-history.port.js';
import { formatAge } from '../../util/format.js';
import { shortPath } from '../../util/paths.js';
import { type Row, row } from '../paint.js';
import { sessionKey } from '../selection.js';
import { style } from '../theme.js';
import type { ListItem } from './agent-list.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** What sits under a session's title is set in from it. */
const UNDER = '  ';

const MONTH_AND_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** When a session ended: how long ago within a day, the date before that. */
function whenEnded(endedAt: number, now: number): string {
  const ago = now - endedAt;

  return ago < DAY_MS ? `${formatAge(ago)} ago` : MONTH_AND_DAY.format(endedAt);
}

/** A past session in the list: its title, where it ran, and how it ended. */
export function historyItem(past: PastSession, now: number, gapBefore: boolean): ListItem {
  const agents = past.agentCount === 1 ? '1 agent' : `${past.agentCount} agents`;
  const facts = [shortPath(past.cwd), past.agentCount > 0 ? agents : ''].filter(Boolean);

  const rows: Row[] = [
    row([[style.bold, past.title]], [[style.dim, whenEnded(past.endedAt, now)]]),
  ];

  if (facts.length > 0) {
    rows.push(row([[style.dim, `${UNDER}${facts.join(' · ')}`]]));
  }

  if (past.closing) {
    rows.push(
      row([
        [null, UNDER],
        past.closing.asks ? [style.yellow, '? '] : [style.dim, '↳ '],
        [style.dim, past.closing.line],
      ]),
    );
  }

  return {
    key: sessionKey(past.sessionId),
    sessionId: past.sessionId,
    agentId: null,
    rows,
    animated: false,
    gapBefore,
  };
}
