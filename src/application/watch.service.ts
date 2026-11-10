import type { SessionListing } from '../domain/session.js';
import type { Store } from '../domain/store.js';
import type { InboxPort } from './ports/inbox.port.js';
import type { SessionListPort } from './ports/session-list.port.js';
import type {
  EventCollectorPort,
  HistoryPort,
  LiveEventsPort,
} from './ports/watch-sources.port.js';

const FORGET_AFTER_MS = 60 * 60 * 1000;
/** Changes to the session list arrive in bursts: one poll serves them all. */
const POLL_SETTLE_MS = 300;

export interface WatchServiceDeps {
  readonly store: Store;
  readonly sessionList: SessionListPort;
  readonly history: HistoryPort;
  readonly liveEvents: LiveEventsPort;
  readonly collector: EventCollectorPort;
  readonly inbox: InboxPort;
  /** Only sessions matching this id prefix, name, or part of the working directory. */
  readonly sessionFilter?: string | null;
  /** How long finished agents stay listed. */
  readonly recentMs: number;
  /** Claude Code versions whose transcript format was checked. */
  readonly verifiedVersions: readonly string[];
  readonly now?: () => number;
}

/**
 * Keeps the store current: which sessions run, their history, their live events, and whether
 * each can be messaged. It owns no timers; whoever composes it calls `tick` every second and
 * `housekeep` every half minute.
 */
export class WatchService {
  /** Things the user should know, by topic. A topic clears when its problem goes away. */
  readonly warnings = new Map<string, string>();
  private readonly now: () => number;
  private readonly liveSince = new Map<string, number>();
  /** Listed sessions with no transcript yet: a session gets one with its first turn. */
  private readonly awaitingHistory = new Map<string, SessionListing>();
  private polling = false;
  private pollAgain = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopWatchingList: () => void = () => {};
  private polledOnce = false;

  constructor(private readonly deps: WatchServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** True once the session list has been read for the first time. */
  get ready(): boolean {
    return this.polledOnce;
  }

  get isCollecting(): boolean {
    return this.deps.collector.isCollecting;
  }

  start(): void {
    this.deps.collector.tick(this.now());
    this.deps.liveEvents.start();
    this.stopWatchingList = this.deps.sessionList.onChange(() => this.pollSoon());
    void this.poll();
  }

  stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    this.stopWatchingList();
    this.deps.liveEvents.close();
    this.deps.history.close();
    this.deps.collector.stop();
  }

  /** A session's hooks are delivering events; its history reader steps down from `since`. */
  noteLive(sessionId: string, since: number): void {
    this.liveSince.set(sessionId, since);
    this.deps.store.markHooksLive(sessionId);
    this.deps.history.setLiveSince(sessionId, since);
  }

  tick(): void {
    this.deps.collector.tick(this.now());
    this.deps.liveEvents.tick();
    this.followAwaited();
    this.deps.history.tick();
    this.setWarning('live', this.deps.liveEvents.warnings()[0]);
    this.refreshMessaging();
  }

  housekeep(): void {
    const now = this.now();

    this.deps.history.rescan();

    const before = new Set(this.deps.store.sessions.keys());

    this.deps.store.prune(now, Math.max(this.deps.recentMs * 6, FORGET_AFTER_MS));

    for (const sessionId of before) {
      if (this.deps.store.sessions.has(sessionId)) {
        continue;
      }

      this.deps.history.forget(sessionId);
      this.liveSince.delete(sessionId);
    }

    if (this.deps.collector.isCollecting) {
      this.deps.inbox.recoverAbandoned(now);
      this.deps.collector.forgetOldSpools(now);
    }

    this.setWarning('history', this.deps.history.warnings()[0]);
    void this.poll(); // in case a change to the session list went unnoticed
  }

  /** Reads the session list. Calls that overlap a running poll are folded into one more poll. */
  async poll(): Promise<void> {
    if (this.polling) {
      this.pollAgain = true;

      return;
    }

    this.polling = true;

    try {
      const result = await this.deps.sessionList.list();

      this.setWarning('sessions', result.problem);

      const sessions = result.sessions.filter((session) => this.matchesFilter(session));

      this.deps.store.syncListing(sessions, this.now(), result.authoritative);
      this.awaitingHistory.clear();

      for (const listing of sessions) {
        this.follow(listing);
      }

      this.polledOnce = true;
    } finally {
      this.polling = false;

      if (this.pollAgain) {
        this.pollAgain = false;
        void this.poll();
      }
    }
  }

  /**
   * Looks again for the history of sessions that had none. Waiting for the next read of the
   * session list would show a new session's first turn half a minute late.
   */
  private followAwaited(): void {
    for (const listing of [...this.awaitingHistory.values()]) {
      this.follow(listing);
    }
  }

  private pollSoon(): void {
    if (this.pollTimer) {
      return;
    }

    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, POLL_SETTLE_MS);
  }

  private follow(listing: SessionListing): void {
    const { store, history, verifiedVersions } = this.deps;
    const session = store.session(listing.sessionId);

    const followed = history.follow({
      sessionId: listing.sessionId,
      cwd: listing.cwd,
      startedAt: listing.startedAt,
      transcriptPath: session.transcriptPath,
    });

    if (followed) {
      this.awaitingHistory.delete(listing.sessionId);
    } else {
      this.awaitingHistory.set(listing.sessionId, listing);
    }

    const since = this.liveSince.get(listing.sessionId);

    if (since !== undefined) {
      history.setLiveSince(listing.sessionId, since);
    }

    // Transcripts are an internal format: say so when a version has not been checked.
    const untested =
      listing.version && !verifiedVersions.includes(listing.version) ? listing.version : null;

    this.setWarning(
      `version:${listing.sessionId}`,
      untested
        ? `Claude Code ${untested} is untested for reading transcripts (history, context size, narration); live hook events are unaffected`
        : undefined,
    );
  }

  // A message can reach a session once it runs agentwatch's hooks.
  private refreshMessaging(): void {
    for (const session of this.deps.store.sessions.values()) {
      const reachable =
        session.alive && (session.hooksLive || this.deps.inbox.canReceive(session.sessionId));

      this.deps.store.setCanMessage(session.sessionId, reachable);
    }
  }

  private matchesFilter(listing: SessionListing): boolean {
    const filter = this.deps.sessionFilter;

    if (!filter) {
      return true;
    }

    return (
      listing.sessionId.startsWith(filter) ||
      listing.name === filter ||
      (listing.cwd ?? '').includes(filter)
    );
  }

  private setWarning(topic: string, text: string | undefined): void {
    if (text) {
      this.warnings.set(topic, text);
    } else {
      this.warnings.delete(topic);
    }
  }
}
