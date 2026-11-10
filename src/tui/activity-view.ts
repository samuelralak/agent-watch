import type { TimelineEntry } from '../domain/agent.js';
import type { Store } from '../domain/store.js';
import type { PaneRows, Selection } from './list-pane.js';
import { type Row, row, type Segment } from './paint.js';
import { style } from './theme.js';
import { type ActivityBlock, agentDetail, type DetailContext } from './views/agent-detail.js';
import { sessionActivity } from './views/session-activity.js';

export interface DetailView {
  readonly now: number;
  readonly frame: number;
  /** Columns and rows the pane has. */
  readonly width: number;
  readonly room: number;
  /** When the view was paused; 0 while it follows. */
  readonly pausedAt: number;
}

/** What a click on a row of the activity did. */
export type Pointed = 'selected' | 'again' | 'nothing';

/** A pane shorter than this keeps only the first of its fixed rows. */
const SHORT_PANE_ROWS = 6;
/** More rows than any history has: scrolling this far reaches its end. */
const WHOLE_HISTORY = 1_000_000;
/** Entries laid out beyond what the pane needs, so there is always one above to move to. */
const LOOK_BEHIND = 2;

const UNMARKED: Segment = [null, ' '];
/** The selected entry: its first row carries the mark, the rows under it a fainter one. */
const MARKED: Segment = [style.key, '▌'];
const MARKED_ON: Segment = ['2;36', '▌'];

/** Where a block sits among the rows laid out, counted from the oldest. */
interface Extent {
  readonly block: ActivityBlock;
  readonly start: number;
  readonly end: number;
}

/** What was last drawn: where each block is, and how many rows the pane shows of them. */
interface LaidOut {
  readonly extents: readonly Extent[];
  readonly rowCount: number;
  /** The rows that stay above the scrolling ones, and the rows left for these. */
  readonly headerRows: number;
  readonly room: number;
}

/** The rows in view: from `top` up to, not including, `bottom`. */
interface Window {
  readonly top: number;
  readonly bottom: number;
}

const canBeSelected = (extent: Extent): boolean => extent.block.entries.length > 0;

/**
 * The activity of what is selected in the list, newest at the bottom: how far back it is
 * scrolled, and which of its entries is selected while the arrow keys are the activity's.
 *
 * Selecting holds the view the way scrolling back does: entries that arrive meanwhile wait, so
 * nothing moves under the selection.
 */
export class ActivityView {
  /** Rows scrolled back from the newest. */
  private scroll = 0;
  /** When scrolling back began: newer entries wait, so the text being read stays put. */
  private scrolledAt = 0;
  /** When selecting began; 0 while the arrow keys are the list's. */
  private selectingSince = 0;
  /** An entry of the selected block. Entries are the store's own objects, so this stays true. */
  private selected: TimelineEntry | null = null;
  /** After a jump to the oldest entry, the selection goes to the top of what is in view. */
  private fromTop = false;
  private pageRows = 10;
  private laid: LaidOut | null = null;

  constructor(
    private readonly store: Store,
    private readonly now: () => number,
  ) {}

  get isScrolledBack(): boolean {
    return this.scroll > 0;
  }

  get isSelecting(): boolean {
    return this.selectingSince > 0;
  }

  /** The entries of the selected block; none when nothing is selected. */
  get selection(): readonly TimelineEntry[] {
    return this.selectedExtent()?.block.entries ?? [];
  }

  /** Hands the arrow keys to the activity, or takes them back. */
  selecting(on: boolean): void {
    if (on === this.isSelecting) {
      return;
    }

    this.selectingSince = on ? this.now() : 0;
    this.selected = null;
    this.fromTop = false;
  }

  /** Moves the view `rows` towards what is older, or with a negative number towards the newest. */
  scrollBy(rows: number): void {
    if (this.scroll === 0 && rows > 0) {
      this.scrolledAt = this.now();
    }

    this.scroll = Math.max(0, this.scroll + rows);

    if (this.scroll === 0) {
      this.scrolledAt = 0; // back at the newest: live again
    }
  }

  /** Half a pane towards what is older (1) or newer (-1). */
  page(direction: 1 | -1): void {
    this.scrollBy(direction * this.pageRows);
  }

  scrollToOldest(): void {
    this.scrollBy(WHOLE_HISTORY);
    this.selected = null;
    this.fromTop = true;
  }

  scrollToNewest(): void {
    this.scrollBy(-WHOLE_HISTORY);
    this.selected = null;
    this.fromTop = false;
  }

  /** Back to the newest activity, with nothing selected. */
  toLive(): void {
    this.scroll = 0;
    this.scrolledAt = 0;
    this.selected = null;
    this.fromTop = false;
  }

  /**
   * One press of an arrow key: -1 towards what is older, 1 towards the newest. An entry taller
   * than what shows of it is read a row at a time; once all of it has been seen, the selection
   * moves to the next entry. So the same key reads on and moves on.
   */
  step(delta: number): void {
    const laid = this.laid;
    const selectable = laid?.extents.filter(canBeSelected) ?? [];
    const index = selectable.findIndex((extent) => this.holds(extent));
    const current = selectable[index];

    if (!laid || !current) {
      this.scrollBy(-delta);

      return;
    }

    // Several presses can arrive before the next frame: where the view is, is worked out from
    // how far it is scrolled now, not from what was last drawn.
    if (delta < 0) {
      this.stepOlder(current, selectable[index - 1], this.window(laid));
    } else {
      this.stepNewer(current, selectable[index + 1], this.window(laid));
    }
  }

  /** Selects the block drawn on the `row`th row of the pane. */
  selectAt(row: number): Pointed {
    const laid = this.laid;
    const top = laid ? this.window(laid).top : 0;
    const at = laid ? top + row - laid.headerRows : -1;

    const extent = laid?.extents.find(
      (each) => canBeSelected(each) && at >= each.start && at < each.end,
    );

    if (!extent || at < top) {
      return 'nothing';
    }

    if (this.holds(extent)) {
      return 'again';
    }

    this.selected = extent.block.entries[0] ?? null;

    return 'selected';
  }

  /** The selection's fixed rows above as much of its newest activity as fits. */
  rows({ session, agent, store }: Selection, view: DetailView): PaneRows {
    if (!session) {
      this.laid = null;

      return { rows: [], animated: false };
    }

    this.pageRows = Math.max(1, Math.floor(view.room / 2));

    const heldAt = view.pausedAt || this.scrolledAt || this.selectingSince;
    const ctx: DetailContext = { ...view, heldAt };

    const content = agent
      ? agentDetail(session, agent, ctx)
      : sessionActivity(store ?? this.store, session, ctx);

    const header = fixedRows(content.header, view.room);
    const room = Math.max(0, view.room - header.length);
    // An entry is at least one row, so this many entries always fill the rows there are.
    const extents = extentsOf(content.body(room + this.scroll + LOOK_BEHIND));
    const rowCount = extents.at(-1)?.end ?? 0;

    this.scroll = Math.max(0, Math.min(this.scroll, rowCount - room));

    if (this.scroll === 0) {
      this.scrolledAt = 0;
    }

    this.laid = { extents, rowCount, headerRows: header.length, room };
    this.keepSelectionInView(this.laid);

    const working = agent ? [agent] : [session.main, ...session.agents.values()];

    return {
      rows: [...header.map((each) => inset(each, UNMARKED)), ...this.rowsInView(this.laid)],
      animated: working.some((each) => each.openCalls.size > 0),
    };
  }

  /** The rows in view, given how far the view is scrolled now. */
  private window({ rowCount, room }: LaidOut): Window {
    const scroll = Math.max(0, Math.min(this.scroll, rowCount - room));
    const bottom = rowCount - scroll;

    return { top: Math.max(0, bottom - room), bottom };
  }

  private holds(extent: Extent): boolean {
    return this.selected !== null && extent.block.entries.includes(this.selected);
  }

  private selectedExtent(): Extent | undefined {
    return this.laid?.extents.find((extent) => this.holds(extent));
  }

  private stepOlder(current: Extent, older: Extent | undefined, { top }: Window): void {
    if (current.start < top || !older) {
      this.scrollBy(1);

      return;
    }

    this.selected = older.block.entries[0] ?? null;
    // Its last row comes into view; the rows above it follow, one press at a time.
    this.scrollBy(Math.max(0, top - older.end + 1));
  }

  private stepNewer(current: Extent, newer: Extent | undefined, { bottom }: Window): void {
    if (current.end > bottom) {
      this.scrollBy(-1);

      return;
    }

    if (newer) {
      this.selected = newer.block.entries[0] ?? null;
      this.scrollBy(-Math.max(0, newer.start - bottom + 1));
    }
  }

  /**
   * While selecting, something in view is always selected: the entry it was on, or when that
   * has left the view, the nearest one still in it.
   */
  private keepSelectionInView(laid: LaidOut): void {
    if (!this.isSelecting) {
      return;
    }

    const { extents } = laid;
    const { top, bottom } = this.window(laid);

    const inView = extents.filter(
      (extent) => canBeSelected(extent) && extent.end > top && extent.start < bottom,
    );

    const current = extents.find((extent) => this.holds(extent));

    if (current && inView.includes(current)) {
      return;
    }

    const leftAbove = current ? current.end <= top : this.fromTop;
    const nearest = leftAbove ? inView[0] : inView.at(-1);

    this.selected = nearest?.block.entries[0] ?? null;
    this.fromTop = false;
  }

  private rowsInView(laid: LaidOut): Row[] {
    const { extents } = laid;
    const { top, bottom } = this.window(laid);
    const rows: Row[] = [];

    for (const extent of extents) {
      if (extent.end <= top || extent.start >= bottom) {
        continue;
      }

      const marked = this.isSelecting && this.holds(extent);

      for (let at = Math.max(extent.start, top); at < Math.min(extent.end, bottom); at++) {
        const mark = at === extent.start ? MARKED : MARKED_ON;
        const each = extent.block.rows[at - extent.start];

        if (each) {
          rows.push(inset(each, marked ? mark : UNMARKED));
        }
      }
    }

    return rows;
  }
}

/** A row of the pane: one column for the mark of what is selected, then the row itself. */
const inset = (each: Row, mark: Segment): Row => row([mark, ...each.left], each.right);

function extentsOf(blocks: readonly ActivityBlock[]): Extent[] {
  const extents: Extent[] = [];
  let start = 0;

  for (const block of blocks) {
    extents.push({ block, start, end: start + block.rows.length });
    start += block.rows.length;
  }

  return extents;
}

/**
 * The rows that stay above the scrolling ones. They never take more than half the pane, and on
 * a very short one only the title is kept: what changes is what the pane is for.
 */
function fixedRows(header: readonly Row[], room: number): Row[] {
  const budget = room < SHORT_PANE_ROWS ? 1 : Math.floor(room / 2);

  return header.slice(0, budget);
}
