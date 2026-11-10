import type { WatchApp } from './watch-app.js';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

/**
 * Everything that ends the process goes through here: the terminal is given back and the event
 * collection released first, whatever the reason. Closing the terminal window (SIGHUP) counts.
 */
export class Shutdown {
  private restoreTerminal: () => void = () => {};

  constructor(private readonly app: WatchApp) {}

  /** Ends the process on every signal that asks for it, and on any error nothing caught. */
  listen(): void {
    for (const signal of SIGNALS) {
      process.on(signal, () => this.exit(0));
    }

    process.on('uncaughtException', (error) => this.crash(error));
    process.on('unhandledRejection', (error) => this.crash(error));
  }

  /** Registers what gives the terminal back, once something has taken it over. */
  restoreWith(restore: () => void): void {
    this.restoreTerminal = restore;
  }

  exit(code: number): never {
    this.restoreTerminal();
    this.app.stop();
    process.exit(code);
  }

  private crash(error: unknown): never {
    // The terminal first, so the error can be read.
    this.restoreTerminal();

    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);

    process.stderr.write(`agentwatch: ${text}\n`);

    return this.exit(1);
  }
}
