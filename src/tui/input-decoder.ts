import { StringDecoder } from 'node:string_decoder';

/** What a mouse did: a button pressed, or one step of its wheel (a trackpad sends those too). */
export type MouseAction = 'press' | 'wheel-up' | 'wheel-down';

/** Where the pointer was, counted from 0 at the top left of the terminal. */
export interface MouseToken {
  readonly type: 'mouse';
  readonly action: MouseAction;
  readonly row: number;
  readonly column: number;
}

export type InputToken =
  | { readonly type: 'key'; readonly name: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'paste'; readonly text: string }
  | MouseToken;

const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** A lone Esc is the Escape key only if nothing follows it within this time. */
const ESCAPE_WAIT_MS = 40;
/** A paste whose end marker never arrives is delivered anyway, after this long. */
const PASTE_WAIT_MS = 1000;

const CONTROL_KEYS: Readonly<Record<string, string>> = {
  '\r': 'enter',
  '\n': 'enter',
  '\t': 'tab',
  '\x7f': 'backspace',
  '\b': 'backspace',
};

const ARROW_KEYS: Readonly<Record<string, string>> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
};

const TILDE_KEYS: Readonly<Record<string, string>> = {
  1: 'home',
  7: 'home',
  4: 'end',
  8: 'end',
  3: 'delete',
  5: 'pageup',
  6: 'pagedown',
};

/** The buttons of a mouse report that mean something here, once the held keys are taken off. */
const MOUSE_ACTIONS: Readonly<Record<number, MouseAction>> = {
  0: 'press',
  64: 'wheel-up',
  65: 'wheel-down',
};

/** Shift, Alt and Ctrl held during a mouse report add these to its button. */
const HELD_KEYS = 4 | 8 | 16;

const ALT_KEYS: Readonly<Record<string, string>> = {
  b: 'word-left',
  f: 'word-right',
  d: 'delete-word-forward',
  '\x7f': 'delete-word-back',
  '\b': 'delete-word-back',
  // Alt+Enter asks for a new line where Enter alone would send.
  '\r': 'alt-enter',
  '\n': 'alt-enter',
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CSI = /^\x1b\[([0-9;?<=>]*)([ -/]*)([@-~])/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const UNFINISHED_CSI = /^\x1b\[[0-9;?<=>]*[ -/]*$/;

function isPrintable(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;

  return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0);
}

/**
 * Turns raw terminal input into keys, typed text and pastes.
 *
 * Stateful on purpose: a terminal delivers input in arbitrary chunks (about 1 KB on macOS), so
 * an escape sequence, a bracketed paste or a multi-byte character can be split across reads.
 * Parsing each chunk alone turns a large paste into keystrokes, and every newline in it into
 * the Enter key. A paste is always one token, however it was chunked.
 */
export class InputDecoder {
  private readonly utf8 = new StringDecoder('utf8');
  private buffer = '';
  /** Text collected so far while inside a bracketed paste. */
  private paste: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly onToken: (token: InputToken) => void) {}

  feed(chunk: Buffer | string): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = null;
    this.buffer += typeof chunk === 'string' ? chunk : this.utf8.write(chunk);
    this.parse();

    if (this.paste !== null) {
      this.timer = setTimeout(() => this.flush(), PASTE_WAIT_MS);
    } else if (this.buffer) {
      this.timer = setTimeout(() => this.flush(), ESCAPE_WAIT_MS);
    }
  }

  /** Settles what is pending: an unfinished paste is delivered, a lone Esc becomes the key. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = null;

    if (this.paste !== null) {
      const text = this.paste + this.buffer;

      this.paste = null;
      this.buffer = '';
      this.onToken({ type: 'paste', text });

      return;
    }

    const rest = this.buffer;

    this.buffer = '';

    if (rest === ESC) {
      this.key('escape');
    } else if (rest.length === 2 && rest[0] === ESC) {
      this.key(ALT_KEYS[rest[1]!] ?? `alt-${rest[1]}`);
    }
    // Anything else is an unfinished control sequence, and is dropped.
  }

  /** Forgets what is pending; nothing more is delivered for it. */
  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = null;
    this.buffer = '';
    this.paste = null;
  }

  private key(name: string): void {
    this.onToken({ type: 'key', name });
  }

  private parse(): void {
    for (;;) {
      if (this.paste !== null) {
        const end = this.buffer.indexOf(PASTE_END);

        if (end < 0) {
          // Keep a tail that could be the start of the end marker.
          const kept = Math.min(this.buffer.length, PASTE_END.length - 1);

          this.paste += this.buffer.slice(0, this.buffer.length - kept);
          this.buffer = this.buffer.slice(this.buffer.length - kept);

          return;
        }

        const text = this.paste + this.buffer.slice(0, end);

        this.paste = null;
        this.buffer = this.buffer.slice(end + PASTE_END.length);
        this.onToken({ type: 'paste', text });
        continue;
      }

      if (!this.buffer) {
        return;
      }

      if (this.buffer[0] !== ESC) {
        this.plain();
        continue;
      }

      if (!this.escape()) {
        return; // more input is needed to decide
      }
    }
  }

  /** Leading characters up to the next Esc: runs of printable text, and control keys. */
  private plain(): void {
    let index = 0;
    let text = '';

    const emitText = (): void => {
      if (text) {
        this.onToken({ type: 'text', text });
      }

      text = '';
    };

    while (index < this.buffer.length && this.buffer[index] !== ESC) {
      const code = this.buffer.codePointAt(index) ?? 0;
      const char = String.fromCodePoint(code);

      index += char.length;

      if (isPrintable(char)) {
        text += char;
        continue;
      }

      emitText();

      const named = CONTROL_KEYS[char];

      if (named) {
        this.key(named);
      } else if (code >= 1 && code <= 26) {
        this.key(`ctrl-${String.fromCharCode(96 + code)}`);
      }
    }

    emitText();
    this.buffer = this.buffer.slice(index);
  }

  /** One sequence starting with Esc. Returns false when more input is needed. */
  private escape(): boolean {
    const buffer = this.buffer;
    const next = buffer[1];
    const maybePasteStart = buffer.length < PASTE_START.length && PASTE_START.startsWith(buffer);

    // A lone Esc, or the beginning of what may become the paste marker: wait for more.
    if (next === undefined || maybePasteStart) {
      return false;
    }

    if (buffer.startsWith(PASTE_START)) {
      this.paste = '';
      this.buffer = buffer.slice(PASTE_START.length);

      return true;
    }

    if (next === ESC) {
      this.buffer = buffer.slice(1);
      this.key('escape');

      return true;
    }

    if (next === '[') {
      return this.csi(buffer);
    }

    if (next === 'O') {
      return this.applicationKey(buffer);
    }

    // Esc followed by a key is an Alt chord (Option+Left sends Esc b), never the Escape key.
    this.buffer = buffer.slice(2);
    this.key(ALT_KEYS[next] ?? `alt-${next}`);

    return true;
  }

  /** `Esc [ … final`: a control sequence, such as an arrow key or a focus report. */
  private csi(buffer: string): boolean {
    const match = CSI.exec(buffer);

    if (match) {
      this.buffer = buffer.slice(match[0].length);
      this.controlSequence(match[1] ?? '', match[3] ?? '');

      return true;
    }

    if (UNFINISHED_CSI.test(buffer)) {
      return false;
    }

    // Not a sequence at all: its two opening characters are dropped, never typed.
    this.buffer = buffer.slice(2);

    return true;
  }

  /** `Esc O x`: an arrow, Home or End from a terminal in application cursor mode. */
  private applicationKey(buffer: string): boolean {
    const final = buffer[2];

    if (final === undefined) {
      return false;
    }

    this.buffer = buffer.slice(3);

    const named = ARROW_KEYS[final];

    if (named) {
      this.key(named);
    }

    return true;
  }

  /**
   * `Esc [ < button ; column ; row M`: a button went down or the wheel moved a step. The same
   * with `m` is a button going up, which nothing here acts on.
   */
  private mouse(parameters: string, final: string): void {
    const [button = Number.NaN, column = Number.NaN, row = Number.NaN] = parameters
      .slice(1)
      .split(';')
      .map(Number);

    const action = MOUSE_ACTIONS[button & ~HELD_KEYS];

    if (final === 'M' && action && column >= 1 && row >= 1) {
      this.onToken({ type: 'mouse', action, row: row - 1, column: column - 1 });
    }
  }

  private controlSequence(parameters: string, final: string): void {
    if (parameters.startsWith('<')) {
      this.mouse(parameters, final);

      return;
    }

    const parts = parameters.split(';');
    const modified = parts.length > 1 && parts[1] !== '1'; // Alt, Ctrl or Cmd held
    const arrow = ARROW_KEYS[final];

    if (arrow) {
      if (modified && arrow === 'left') {
        this.key('word-left');
      } else if (modified && arrow === 'right') {
        this.key('word-right');
      } else {
        this.key(arrow);
      }

      return;
    }

    const named = final === '~' ? TILDE_KEYS[parts[0] ?? ''] : undefined;

    if (named) {
      this.key(modified && named === 'delete' ? 'delete-word-forward' : named);
    }
    // Focus reports, stray paste markers and unknown sequences are ignored.
  }
}
