import { EventEmitter } from 'node:events';
import type { ViewerInput, ViewerOutput } from '../../src/tui/viewer.js';

const ESC = String.fromCharCode(27);
const CONTROL_SEQUENCE = new RegExp(`${ESC}\\[([0-9;?]*)([A-Za-z])`, 'g');

/**
 * A terminal for tests: it keeps what the viewer drew as plain rows of text, and lets a test
 * type, paste and resize.
 */
export class FakeTerminal {
  columns: number;
  rows: number;
  rawMode = false;
  /** Where the text cursor is shown, or null while it is hidden. */
  cursor: { row: number; column: number } | null = null;
  /** True between entering and leaving the alternate screen. */
  fullScreen = false;
  /** True while the terminal is asked to report clicks and wheel steps. */
  reportsMouse = false;

  private readonly lines = new Map<number, string>();
  private readonly events = new EventEmitter();
  private position = { row: 0, column: 0 };

  constructor(columns = 120, rows = 30) {
    this.columns = columns;
    this.rows = rows;
  }

  readonly input: ViewerInput = {
    setRawMode: (raw) => {
      this.rawMode = raw;
    },
    resume: () => {},
    pause: () => {},
    on: (event, listener) => this.events.on(event, listener),
    off: (event, listener) => this.events.off(event, listener),
  };

  get output(): ViewerOutput {
    const terminal = this;

    return {
      get columns() {
        return terminal.columns;
      },
      get rows() {
        return terminal.rows;
      },
      write: (text) => terminal.write(text),
      on: (event, listener) => terminal.events.on(event, listener),
      off: (event, listener) => terminal.events.off(event, listener),
    };
  }

  /** Keys as the terminal sends them: `\r` is Enter, `\x1b` is Esc. */
  async type(keys: string): Promise<void> {
    this.events.emit('data', Buffer.from(keys));
    await this.settle();
  }

  /** A bracketed paste, delivered in reads of `chunk` bytes the way a real terminal does. */
  async paste(text: string, chunk = 1022): Promise<void> {
    const bytes = Buffer.from(`${ESC}[200~${text}${ESC}[201~`);

    for (let at = 0; at < bytes.length; at += chunk) {
      this.events.emit('data', bytes.subarray(at, at + chunk));
    }

    await this.settle();
  }

  /** One step of the wheel, or a click, with the pointer on `row` and `column` (from 0). */
  async mouse(action: 'press' | 'wheel-up' | 'wheel-down', row: number, column: number) {
    const button = { press: 0, 'wheel-up': 64, 'wheel-down': 65 }[action];

    await this.type(`${ESC}[<${button};${column + 1};${row + 1}M`);
  }

  async resize(columns: number, rows: number): Promise<void> {
    this.columns = columns;
    this.rows = rows;
    this.events.emit('resize');
    await this.settle();
  }

  /** Long enough for a lone Esc to be read as the Escape key, and for the frame after it. */
  async settle(ms = 0): Promise<void> {
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  /** The rows on screen, top to bottom, without trailing spaces. */
  screen(): string[] {
    const last = Math.max(-1, ...this.lines.keys());

    const rows = Array.from({ length: last + 1 }, (_, index) =>
      (this.lines.get(index) ?? '').trimEnd(),
    );

    while (rows.at(-1) === '') {
      rows.pop();
    }

    return rows;
  }

  text(): string {
    return this.screen().join('\n');
  }

  private write(chunk: string): void {
    let at = 0;

    for (const match of chunk.matchAll(CONTROL_SEQUENCE)) {
      this.put(chunk.slice(at, match.index));
      at = match.index + match[0].length;
      this.control(match[1] ?? '', match[2] ?? '');
    }

    this.put(chunk.slice(at));
  }

  private put(text: string): void {
    if (!text) {
      return;
    }

    const { row } = this.position;

    this.lines.set(row, (this.lines.get(row) ?? '') + text);
  }

  private control(parameters: string, command: string): void {
    if (command === 'H') {
      const [row = 1, column = 1] = parameters.split(';').map(Number);

      this.position = { row: row - 1, column: column - 1 };

      // The viewer always rewrites a row from its first column.
      if (column === 1) {
        this.lines.set(row - 1, '');
      }
    } else if (command === 'J') {
      this.lines.clear();
    } else if (parameters === '?25') {
      this.cursor = command === 'h' ? { ...this.position } : null;
    } else if (parameters === '?1049') {
      this.fullScreen = command === 'h';
    } else if (parameters === '?1000') {
      this.reportsMouse = command === 'h';
    }
  }
}
