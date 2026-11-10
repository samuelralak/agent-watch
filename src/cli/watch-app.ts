import type { HookInstaller } from '../adapters/claude/hook-installer.js';
import type { InboxPort } from '../application/ports/inbox.port.js';
import type { SessionHistoryPort } from '../application/ports/session-history.port.js';
import type { ToolExchangePort } from '../application/ports/tool-exchange.port.js';
import type { SendMessageService } from '../application/send-message.service.js';
import type { WatchService } from '../application/watch.service.js';
import type { Store } from '../domain/store.js';

const TICK_MS = 1000;
const HOUSEKEEP_MS = 30_000;
const READY_POLL_MS = 50;
const READY_TIMEOUT_MS = 25_000;

export interface WatchAppParts {
  readonly store: Store;
  readonly watch: WatchService;
  readonly sendMessage: SendMessageService;
  readonly inbox: InboxPort;
  readonly installer: HookInstaller;
  /** The sessions that are over. */
  readonly history: SessionHistoryPort;
  /** A tool call's whole input and output, for an entry opened in full. */
  readonly toolExchange: ToolExchangePort;
  /** Sending is locked: the user's messages need their fingerprint. */
  readonly locked: boolean;
  /** Lets go of whatever signing holds on to. */
  readonly release: () => void;
}

/** Everything a way of watching needs, and the loop that keeps the store current. */
export class WatchApp {
  readonly store: Store;
  readonly watch: WatchService;
  readonly sendMessage: SendMessageService;
  readonly inbox: InboxPort;
  readonly installer: HookInstaller;
  readonly history: SessionHistoryPort;
  readonly toolExchange: ToolExchangePort;
  readonly locked: boolean;
  private readonly release: () => void;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(parts: WatchAppParts) {
    this.store = parts.store;
    this.watch = parts.watch;
    this.sendMessage = parts.sendMessage;
    this.inbox = parts.inbox;
    this.installer = parts.installer;
    this.history = parts.history;
    this.toolExchange = parts.toolExchange;
    this.locked = parts.locked;
    this.release = parts.release;
  }

  start(): void {
    this.watch.start();
    this.every(TICK_MS, 'tick', () => this.watch.tick());
    this.every(HOUSEKEEP_MS, 'housekeeping', () => this.watch.housekeep());
  }

  /** Stops the loop and lets go of the event collection, so another viewer can take it over. */
  stop(): void {
    for (const timer of this.timers.splice(0)) {
      clearInterval(timer);
    }

    this.watch.stop();
    this.release();
  }

  /** Resolves once the session list was read and its sessions' history loaded, or on timeout. */
  async whenReady(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!this.watch.ready && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }

    this.watch.tick();
  }

  private every(ms: number, name: string, step: () => void): void {
    this.timers.push(setInterval(() => this.attempt(name, step), ms));
  }

  /** A step that throws is reported in the view and tried again: one bad file must not end it. */
  private attempt(name: string, step: () => void): void {
    try {
      step();
      this.watch.warnings.delete(name);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      this.watch.warnings.set(name, `internal error in ${name}, retrying: ${reason}`);
    }
  }
}
