import type { SessionListing, SessionState } from './session.js';

/** A session must be missing from this many complete polls before it counts as gone. */
const POLLS_BEFORE_GONE = 2;
/** A poll must be this much newer than a permission request to clear it. */
const ATTENTION_GRACE_MS = 1500;

/** What one poll of the session list says about a session it lists. */
export function applyListing(
  session: SessionState,
  listing: SessionListing,
  polledAt: number,
): void {
  session.name = listing.name || session.name;
  session.cwd = listing.cwd || session.cwd;
  session.kind = listing.kind || session.kind;
  session.version = listing.version || session.version;
  session.pid = listing.pid ?? null;
  session.shortId = listing.shortId ?? null;
  session.listedAt ??= listing.startedAt ?? polledAt;
  session.status = listing.status ?? '';
  session.waitingFor = listing.waitingFor ?? '';
  session.alive = true;
  session.missedPolls = 0;
  session.endedAt = null;

  syncAttention(session, listing, polledAt);
}

/** One failed or partial poll is not the end of a session: only repeated absence is. */
export function isGone(session: SessionState): boolean {
  return session.missedPolls >= POLLS_BEFORE_GONE;
}

/**
 * "Needs you" follows the session list: it says when a session waits on a prompt and when it
 * stops waiting, which no hook reports (an approved command fires nothing until it ends).
 */
function syncAttention(session: SessionState, listing: SessionListing, polledAt: number): void {
  if (listing.waitingFor) {
    session.attention ??= {
      at: polledAt,
      level: 'permission',
      text: `waiting for you: ${listing.waitingFor}`,
      agentId: null,
    };

    return;
  }

  const pending = session.attention;

  if (pending?.level === 'permission' && polledAt > pending.at + ATTENTION_GRACE_MS) {
    session.attention = null;
  }
}
