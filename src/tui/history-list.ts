import type { PastSession, SessionHistoryPort } from '../application/ports/session-history.port.js';
import type { Store } from '../domain/store.js';
import type { ListSource, Selection } from './list-pane.js';
import type { ListContext, ListItem } from './views/agent-list.js';
import { historyItem } from './views/history-list.js';

/** A past session that was read, and how it stood then: read again only if it has changed. */
interface Opened {
  readonly sessionId: string;
  readonly endedAt: number;
  readonly store: Store;
}

/**
 * The sessions that are over, as a list. Their names come from a quick look at each record;
 * what one of them did is read only when it is selected.
 */
export class HistoryList implements ListSource {
  private sessions: PastSession[] = [];
  private opened: Opened | null = null;
  /** Null until the past sessions have been looked for. */
  private found: number | null = null;

  constructor(
    private readonly history: SessionHistoryPort,
    /** The running sessions: one of those is not history yet. */
    private readonly running: Store,
  ) {}

  /** How many past sessions there are; null before they were first looked for. */
  get count(): number | null {
    return this.found;
  }

  /** Looks for the past sessions again. */
  reload(): void {
    this.sessions = this.history
      .list()
      .filter((past) => this.running.sessions.get(past.sessionId)?.alive !== true);

    this.found = this.sessions.length;
  }

  items(ctx: ListContext): ListItem[] {
    return this.sessions.map((past, index) => historyItem(past, ctx.now, index > 0));
  }

  selectionOf(item: ListItem | undefined): Selection {
    const past = this.sessions.find((each) => each.sessionId === item?.sessionId);

    if (!past) {
      return { session: null, agent: null };
    }

    const store = this.open(past);

    return { session: store.sessions.get(past.sessionId) ?? null, agent: null, store };
  }

  isRunning(): boolean {
    return false;
  }

  private open(past: PastSession): Store {
    const { sessionId, endedAt } = past;

    if (this.opened?.sessionId !== sessionId || this.opened.endedAt !== endedAt) {
      this.opened = { sessionId, endedAt, store: this.history.open(past) };
    }

    return this.opened.store;
  }
}
