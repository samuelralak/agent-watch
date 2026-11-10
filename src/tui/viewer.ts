import type { InboxPort } from '../application/ports/inbox.port.js';
import type { SessionHistoryPort } from '../application/ports/session-history.port.js';
import type { ToolExchangePort } from '../application/ports/tool-exchange.port.js';
import type { SendMessageService } from '../application/send-message.service.js';
import type { WatchService } from '../application/watch.service.js';
import type { Store } from '../domain/store.js';
import { clip } from '../util/text-width.js';
import { DetailPane } from './detail-pane.js';
import {
  borderColumns,
  boxColumns,
  composeFrame,
  type Frame,
  type FrameParts,
  isInside,
} from './frame.js';
import { HistoryList } from './history-list.js';
import { InputDecoder, type InputToken, type MouseToken } from './input-decoder.js';
import { boxRoom, type Focus, type Layout, layoutFor } from './layout.js';
import { ListPane, runningSessions } from './list-pane.js';
import { MessageComposer } from './message-composer.js';
import { createPainter, type Painter, type Row, row, type Style } from './paint.js';
import { MIN_COLUMNS, MIN_ROWS, Screen, type TerminalOutput } from './screen.js';
import { style } from './theme.js';
import { keyHints, type ListShown, listTabs, titleBar, warningRow } from './views/chrome.js';
import { type BoxRoom, type Draft, type MessageBox, messageBox } from './views/message-box.js';
import { resumeCommand } from './views/panels.js';

const FRAME_MS = 125;
const TOAST_MS = 8000;
const TOO_SMALL = `agentwatch needs at least ${MIN_COLUMNS} columns and ${MIN_ROWS} rows`;
/** Letters that open the message box, besides Enter. */
const OPENS_BOX = new Set(['m', 'i']);
/** Rows one step of a wheel or a trackpad moves a pane. */
const WHEEL_ROWS = 3;

export interface ViewerInput {
  setRawMode(raw: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

export interface ViewerOutput extends TerminalOutput {
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

export interface ViewerDeps {
  readonly store: Store;
  readonly watch: Pick<WatchService, 'warnings' | 'ready'>;
  readonly sendMessage: Pick<SendMessageService, 'send'>;
  readonly inbox: Pick<InboxPort, 'hasWaiter'>;
  /** How long finished agents stay listed. */
  readonly recentMs: number;
  /** Sending is locked: the first message of this window asks for a fingerprint. */
  readonly locked?: boolean;
  readonly hooksInstalled: () => boolean;
  /** Returns false when the text could not be copied. */
  readonly copyToClipboard: (text: string) => boolean;
  readonly color: boolean;
  /** The sessions that are over. Without it the list has only the running ones. */
  readonly history?: SessionHistoryPort;
  /** A tool call's whole input and output, read when an entry is opened in full. */
  readonly toolExchange?: Pick<ToolExchangePort, 'find'>;
  /** Whether the terminal is asked to report the mouse: that is how a trackpad scrolls. */
  readonly mouse?: boolean;
  readonly input: ViewerInput;
  readonly output: ViewerOutput;
  /** The user asked to quit. The terminal is already restored. */
  readonly onQuit: () => void;
  readonly now?: () => number;
}

/** A line shown in place of the key hints for a few seconds. */
interface Toast {
  readonly text: string;
  readonly textStyle: Style;
  readonly at: number;
}

/**
 * The full-screen view: a list of sessions and their agents, the selected one's activity, and a
 * message box that is always on screen. It reads the store and draws; the only thing it changes
 * is the user's own outbox.
 */
export class Viewer {
  private readonly screen: Screen;
  private readonly painter: Painter;
  private readonly decoder: InputDecoder;
  private readonly running: ListPane;
  /** The past sessions and the pane that lists them; null when there is no history. */
  private readonly past: { readonly sessions: HistoryList; readonly pane: ListPane } | null;
  private shown: ListShown = 'running';
  private readonly detail: DetailPane;
  private readonly composer: MessageComposer;
  private readonly now: () => number;
  /** When the view was paused; 0 while it follows. */
  private pausedAt = 0;
  private showFinished = true;
  private focus: Focus = 'list';
  /** Where the panes were last drawn: what a pointer is over. */
  private panes: Pick<Frame, 'list' | 'detail'> | null = null;
  private toast: Toast | null = null;
  private frame = 0;
  /** A spinner is on screen, so frames are drawn even when nothing else changed. */
  private animated = false;
  private drawnVersion = -1;
  private drawnSecond = -1;
  private waiterCheck: { sessionId: string; second: number; waiting: boolean } | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private renderQueued = false;
  private started = false;

  constructor(private readonly deps: ViewerDeps) {
    this.now = deps.now ?? Date.now;
    this.screen = new Screen(deps.output, deps.mouse === true);
    this.painter = createPainter(deps.color);
    this.running = new ListPane(runningSessions(deps.store));

    const sessions = deps.history ? new HistoryList(deps.history, deps.store) : null;

    this.past = sessions ? { sessions, pane: new ListPane(sessions) } : null;
    this.detail = new DetailPane(deps.store, this.now, deps.toolExchange ?? null);

    this.composer = new MessageComposer({
      store: deps.store,
      sendMessage: deps.sendMessage,
      say: (text, textStyle) => this.say(text, textStyle),
    });

    this.decoder = new InputDecoder((token) => {
      this.onToken(token);
      this.queueRender();
    });
  }

  /** The list on show: the running sessions, or the past ones. */
  private get list(): ListPane {
    return this.shown === 'history' && this.past ? this.past.pane : this.running;
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.screen.enter();
    this.deps.input.setRawMode(true);
    this.deps.input.resume();
    this.deps.input.on('data', this.onData);
    this.deps.output.on('resize', this.onResize);
    this.render();
    this.frameTimer = setInterval(() => this.onFrame(), FRAME_MS);
  }

  /** Gives the terminal back as it was. Safe to call more than once, and from a signal. */
  stop(): void {
    if (!this.started) {
      return;
    }

    this.started = false;

    if (this.frameTimer) {
      clearInterval(this.frameTimer);
    }

    this.decoder.close();
    this.deps.input.off('data', this.onData);
    this.deps.output.off('resize', this.onResize);
    this.screen.leave();

    try {
      this.deps.input.setRawMode(false);
      this.deps.input.pause();
    } catch {
      // The terminal is already gone.
    }
  }

  /** Draws a frame now. */
  render(): void {
    if (!this.started) {
      return;
    }

    const now = this.now();
    const size = this.screen.size();

    this.drawnVersion = this.deps.store.version;
    this.drawnSecond = Math.floor(now / 1000);

    if (size.columns < MIN_COLUMNS || size.rows < MIN_ROWS) {
      this.screen.draw([clip(TOO_SMALL, size.columns - 1)], null);

      return;
    }

    const warning = warningRow(this.deps.watch.warnings);
    const hasWarning = warning !== null;

    this.list.refresh({
      now,
      frame: this.frame,
      recentMs: this.deps.recentMs,
      showFinished: this.showFinished,
    });

    // The box is sized by what is written in it; the panes get the rows that are left.
    const width = size.columns - 1;

    const box = this.messageBox(
      {
        columns: boxColumns(width),
        borderColumns: borderColumns(width),
        maxRows: boxRoom(size.rows, hasWarning),
      },
      now,
    );

    const layout = layoutFor(size.columns, size.rows, hasWarning, box.body.length);
    const frame = composeFrame(this.frameParts(layout, warning, box, now), layout, this.painter);

    this.panes = frame;

    const cursor = box.cursor && {
      row: frame.inputRow + box.cursor.row,
      column: frame.inputColumn + box.cursor.column,
    };

    this.screen.draw(frame.lines.slice(0, size.rows), cursor);
  }

  // ---- what is drawn ----

  /** Everything one frame shows. */
  private frameParts(
    layout: Layout,
    warning: Row | null,
    box: MessageBox,
    now: number,
  ): FrameParts {
    // Where there is a history, the list's first row says which of the two lists it is.
    const tabs = this.past ? [listTabs(this.shown, this.past.sessions.count)] : [];
    const list = this.list.rows(layout.listRows - tabs.length, this.emptyListText());

    const detail = this.detail.rows(this.list.selection(), {
      now,
      frame: this.frame,
      width: layout.detailWidth - 1,
      room: layout.detailRows,
      pausedAt: this.pausedAt,
    });

    this.animated = list.animated || detail.animated;

    return {
      warning,
      title: titleBar(this.deps.store, {
        now,
        paused: this.pausedAt > 0,
        scrolledBack: this.detail.isScrolledBack,
        selecting: this.detail.isSelecting,
        writing: this.composer.current !== null,
        locked: this.deps.locked === true,
      }),
      list: [...tabs, ...list.rows],
      detail: detail.rows,
      messageBox: box,
      focus: this.focus,
      hints: this.hints(layout.width - 1, now, box.keys.length > 0),
    };
  }

  private emptyListText(): string {
    if (this.shown === 'history') {
      return 'No past sessions.';
    }

    return this.deps.watch.ready ? 'No Claude Code sessions running.' : 'Looking for sessions…';
  }

  private messageBox(room: BoxRoom, now: number): MessageBox {
    const { session, agent } = this.list.selection();
    const draft = this.composer.current;
    const { sessions } = this.deps.store;

    return messageBox({
      ...room,
      now,
      draft,
      session,
      agent,
      draftSession: draft ? (sessions.get(draft.sessionId) ?? null) : null,
      savedDraft: session ? this.composer.savedDraft(session.sessionId) : null,
      sending: this.composer.isSending,
      hasWaiter: (sessionId) => this.hasWaiter(sessionId, now),
    });
  }

  /** The bottom row: something just said to the user, or the keys that matter right now. */
  private hints(columns: number, now: number, keysInBox: boolean): Row {
    if (this.toast && now - this.toast.at < TOAST_MS) {
      return row([[this.toast.textStyle, this.toast.text]]);
    }

    return keyHints({
      columns,
      writing: this.composer.current !== null,
      keysInBox,
      focus: this.focus,
      readingEntry: this.detail.isReadingEntry,
      listShown: this.past ? this.shown : undefined,
      showFinished: this.showFinished,
      paused: this.pausedAt > 0,
    });
  }

  // One file read a second at most: the hint is drawn on every keystroke.
  private hasWaiter(sessionId: string, now: number): boolean {
    const second = Math.floor(now / 1000);

    if (this.waiterCheck?.sessionId !== sessionId || this.waiterCheck.second !== second) {
      this.waiterCheck = { sessionId, second, waiting: this.deps.inbox.hasWaiter(sessionId) };
    }

    return this.waiterCheck.waiting;
  }

  private say(text: string, textStyle: Style = style.dim): void {
    this.toast = { text, textStyle, at: this.now() };
    this.queueRender();
  }

  // ---- what keys do ----

  /** Opens the box for what is selected, and returns the draft; null if it cannot be messaged. */
  private openBox(): Draft | null {
    const { session, agent } = this.list.selection();

    if (!session) {
      this.say('Select a session or one of its agents first.', style.yellow);

      return null;
    }

    if (!session.alive) {
      this.say(`${session.name} has ended.`, style.yellow);

      return null;
    }

    if (!session.canMessage) {
      this.detail.explainUnreachable(this.deps.hooksInstalled());

      return null;
    }

    this.detail.closePanel();

    return this.composer.open(session, agent);
  }

  private move(change: () => void): void {
    change();
    this.detail.selectionChanged();
  }

  private openTask(): void {
    if (this.list.selection().agent?.prompt) {
      this.detail.toggle('task');
    }
  }

  /** Copies the command that restarts the selected session so that it loads the hooks. */
  private copyResumeCommand(): void {
    const { session } = this.list.selection();

    if (!session || !this.detail.explainsUnreachable) {
      return;
    }

    const command = resumeCommand(session);
    const copied = this.deps.copyToClipboard(command);

    this.say(
      copied ? `Copied: ${command}` : `Copy this: ${command}`,
      copied ? style.green : style.yellow,
    );
  }

  /** Esc: the newest activity again, and the arrow keys back with the list. */
  private backToLive(): void {
    this.detail.reset();
    this.focusOn('list');
    this.toast = null;
  }

  private quit(): void {
    this.stop();
    this.deps.onQuit();
  }

  /**
   * Hands the arrow keys to a pane. In the activity they select its entries, and what arrives
   * meanwhile waits, so nothing moves under the selection.
   */
  private focusOn(focus: Focus): void {
    this.focus = focus;
    this.detail.selecting(focus === 'activity');
  }

  /** The arrow keys go to the pane that has them: the list moves its selection, the activity its own. */
  private step(rows: number): void {
    if (this.focus === 'activity') {
      this.detail.step(rows);
    } else {
      this.move(() => this.list.move(rows));
    }
  }

  private toStart(): void {
    if (this.focus === 'activity') {
      this.detail.scrollToOldest();
    } else {
      this.move(() => this.list.moveToStart());
    }
  }

  private toEnd(): void {
    if (this.focus === 'activity') {
      this.detail.scrollToNewest();
    } else {
      this.move(() => this.list.moveToEnd());
    }
  }

  /** Switches the list between the running sessions and the past ones. */
  private switchList(): void {
    if (!this.past) {
      return;
    }

    this.shown = this.shown === 'running' ? 'history' : 'running';

    if (this.shown === 'history') {
      this.past.sessions.reload();
    }

    this.focusOn('list');
    this.detail.selectionChanged();
  }

  /** Further in: from the list into the activity, from the activity into the selected entry. */
  private goIn(): void {
    if (this.focus === 'activity') {
      this.detail.openSelected();
    } else {
      this.focusOn('activity');
    }
  }

  /** Back out: from an open entry to the activity, from the activity to the list. */
  private goOut(): void {
    if (this.detail.isReadingEntry) {
      this.detail.closePanel();
    } else {
      this.focusOn('list');
    }
  }

  /**
   * The keys that scroll the activity. They do the same while a message is being written: a
   * key that scrolls in one place must never delete a draft in another.
   */
  private readonly scrolling: Readonly<Record<string, () => void>> = {
    'ctrl-u': () => this.detail.scrollBack(),
    pageup: () => this.detail.scrollBack(),
    'ctrl-d': () => this.detail.scrollForward(),
    pagedown: () => this.detail.scrollForward(),
  };

  private readonly keys: Readonly<Record<string, () => void>> = {
    ...this.scrolling,
    up: () => this.step(-1),
    down: () => this.step(1),
    home: () => this.toStart(),
    end: () => this.toEnd(),
    tab: () => this.focusOn(this.focus === 'list' ? 'activity' : 'list'),
    right: () => this.goIn(),
    left: () => this.goOut(),
    enter: () => this.openBox(),
    'ctrl-c': () => this.quit(),
    escape: () => this.backToLive(),
  };

  private readonly commands: Readonly<Record<string, () => void>> = {
    j: () => this.step(1),
    k: () => this.step(-1),
    g: () => this.toStart(),
    G: () => this.toEnd(),
    o: () => this.goIn(),
    h: () => this.switchList(),
    '?': () => this.detail.toggle('help'),
    t: () => this.openTask(),
    y: () => this.copyResumeCommand(),
    q: () => this.quit(),
    d: () => {
      this.showFinished = !this.showFinished;
    },
    p: () => {
      this.pausedAt = this.pausedAt ? 0 : this.now();
    },
  };

  /**
   * The wheel scrolls the pane the pointer is over, and the activity from anywhere else, also
   * while a message is being written. A click selects in the list, or moves into the activity.
   */
  private pointed({ action, row, column }: MouseToken): void {
    const overList = this.panes !== null && isInside(this.panes.list, row, column);
    const overDetail = this.panes !== null && isInside(this.panes.detail, row, column);

    if (action !== 'press') {
      const older = action === 'wheel-up' ? WHEEL_ROWS : -WHEEL_ROWS;

      if (overList) {
        this.list.scrollBy(-older);
      } else {
        this.detail.scrollBy(older);
      }

      return;
    }

    // A draft's target is fixed: a click does not move the selection from under it.
    if (this.composer.current) {
      return;
    }

    // The list's first row is its tabs, where there is a history: a click there switches.
    const listRow = row - (this.panes?.list.top ?? 0) - (this.past ? 1 : 0);

    if (overList && listRow < 0) {
      this.switchList();
    } else if (overList && this.list.selectAt(listRow)) {
      this.focusOn('list');
      this.detail.selectionChanged();
    } else if (overDetail) {
      this.focusOn('activity');

      // A click selects the entry under the pointer; a click on the selected one opens it.
      if (this.detail.selectAt(row - (this.panes?.detail.top ?? 0)) === 'again') {
        this.detail.openSelected();
      }
    }
  }

  private onToken(token: InputToken): void {
    if (token.type === 'mouse') {
      this.pointed(token);
    } else if (this.composer.current) {
      this.writing(token);
    } else if (token.type === 'key') {
      this.keys[token.name]?.();
    } else if (token.type === 'paste') {
      // A paste outside the box starts a draft with it. It is never read as commands.
      if (this.openBox()) {
        this.composer.type(token.text);
      }
    } else {
      this.typed(token.text);
    }
  }

  /**
   * Input while the message box is open goes to the draft, whatever it is, except the keys
   * that scroll: what is being answered can be read back without closing the box.
   */
  private writing(token: Exclude<InputToken, MouseToken>): void {
    if (token.type !== 'key') {
      this.composer.type(token.text);

      return;
    }

    const scroll = this.scrolling[token.name];

    if (scroll) {
      scroll();
    } else {
      this.composer.key(token.name);
    }
  }

  /** Letters typed outside the message box are commands, one each. */
  private typed(text: string): void {
    const chars = [...text];

    for (const [index, char] of chars.entries()) {
      if (!OPENS_BOX.has(char)) {
        this.commands[char]?.();
        continue;
      }

      // Typing that arrived in the same read as the key that opened the box belongs to the draft.
      if (this.openBox()) {
        this.composer.type(chars.slice(index + 1).join(''));

        return;
      }
    }
  }

  // ---- when frames are drawn ----

  private readonly onData = (chunk: Buffer): void => this.decoder.feed(chunk);

  private readonly onResize = (): void => {
    this.screen.invalidate();
    this.render();
  };

  private queueRender(): void {
    if (this.renderQueued) {
      return;
    }

    this.renderQueued = true;

    setImmediate(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  // Drawn when something changed, once a second for the clocks, and while a spinner is in view.
  private onFrame(): void {
    this.frame++;

    const second = Math.floor(this.now() / 1000);
    const changed = this.deps.store.version !== this.drawnVersion || second !== this.drawnSecond;

    if (changed || this.animated) {
      this.render();
    }
  }
}
