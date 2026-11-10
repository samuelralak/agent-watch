/** The smallest terminal the view is drawn in. */
export const MIN_COLUMNS = 40;
export const MIN_ROWS = 10;

/** Report button presses and wheel steps, with positions in the form that has no upper limit. */
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

/** The part of a terminal's output the view uses. */
export interface TerminalOutput {
  readonly columns?: number;
  readonly rows?: number;
  write(text: string): unknown;
}

export interface ScreenSize {
  readonly columns: number;
  readonly rows: number;
}

/**
 * Full-screen output that rewrites only the rows that changed since the last frame, so a busy
 * view does not flicker or flood the terminal.
 */
export class Screen {
  private previous: readonly string[] = [];

  /**
   * `mouse` asks the terminal to report clicks and wheel steps, which is how a trackpad
   * scrolls the view. A terminal that reports the mouse keeps its own text selection for when
   * a key is held (Option or Shift, as the terminal has it).
   */
  constructor(
    private readonly out: TerminalOutput,
    private readonly mouse = false,
  ) {}

  /** The terminal's real size. Callers decide what to do when it is too small. */
  size(): ScreenSize {
    return { columns: this.out.columns || 100, rows: this.out.rows || 30 };
  }

  /** Alternate screen, hidden cursor, bracketed paste (so a paste arrives marked as one). */
  enter(): void {
    this.out.write(`\x1b[?1049h\x1b[?25l\x1b[?2004h${this.mouse ? MOUSE_ON : ''}\x1b[2J`);
    this.previous = [];
  }

  leave(): void {
    this.out.write(`${this.mouse ? MOUSE_OFF : ''}\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l`);
  }

  /** Forgets the last frame, so the next draw repaints everything (after a resize). */
  invalidate(): void {
    this.previous = [];
    this.out.write('\x1b[2J');
  }

  /** Draws `lines`; `cursor` shows the text cursor at that position, null hides it. */
  draw(lines: readonly string[], cursor: { row: number; column: number } | null): void {
    let output = '';

    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== this.previous[i]) {
        output += `\x1b[${i + 1};1H${lines[i]}\x1b[0m\x1b[K`;
      }
    }

    for (let i = lines.length; i < this.previous.length; i++) {
      output += `\x1b[${i + 1};1H\x1b[K`;
    }

    this.previous = lines;
    output += cursor ? `\x1b[${cursor.row + 1};${cursor.column + 1}H\x1b[?25h` : '\x1b[?25l';
    this.out.write(output);
  }
}
