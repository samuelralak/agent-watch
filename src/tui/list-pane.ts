import type { AgentState } from '../domain/agent.js';
import { isActive } from '../domain/agent-status.policy.js';
import type { SessionState } from '../domain/session.js';
import type { Store } from '../domain/store.js';
import { blankRow, type Row, row } from './paint.js';
import { keepSelection } from './selection.js';
import { style } from './theme.js';
import { agentListItems, type ListContext, type ListItem } from './views/agent-list.js';

/** What is selected: a session, and one of its agents when an agent's row is selected. */
export interface Selection {
  readonly session: SessionState | null;
  readonly agent: AgentState | null;
  /** The store the session is kept in, when that is not the one of the running sessions. */
  readonly store?: Store;
}

/** What a list shows, and what each of its items stands for. */
export interface ListSource {
  items(ctx: ListContext): ListItem[];
  selectionOf(item: ListItem | undefined): Selection;
  /** Whether the item is something still running: the selection starts on one that is. */
  isRunning(item: ListItem): boolean;
}

/** The running sessions, each followed by its agents. */
export function runningSessions(store: Store): ListSource {
  return {
    items: (ctx) => agentListItems(store, ctx),
    selectionOf(item) {
      const session = item ? (store.sessions.get(item.sessionId) ?? null) : null;
      const agent = session && item?.agentId ? (session.agents.get(item.agentId) ?? null) : null;

      return { session, agent };
    },
    isRunning(item) {
      const agent = store.sessions.get(item.sessionId)?.agents.get(item.agentId ?? '');

      return agent !== undefined && isActive(agent);
    },
  };
}

export interface PaneRows {
  readonly rows: Row[];
  /** A spinner is among the rows, so they must be redrawn while they are in view. */
  readonly animated: boolean;
}

interface ListRow {
  readonly row: Row;
  /** The item the row belongs to; null for a gap or the text of an empty list. */
  readonly key: string | null;
  /** A row of the selected item: all of them are kept in view together. */
  readonly selected: boolean;
  /** The row that carries the mark: the selected item's title, not the lines under it. */
  readonly marked: boolean;
  readonly animated: boolean;
}

/** The left-hand pane: the items of a list, one of them selected. */
export class ListPane {
  private items: ListItem[] = [];
  private selected: string | null = null;
  /** The first row in view when the list is longer than the pane. */
  private top = 0;
  /** The view keeps the selected item in sight, until the list is scrolled away from it. */
  private follows = true;
  /** The item of each row now in view, top to bottom: what a click on a row selects. */
  private shown: (string | null)[] = [];

  constructor(private readonly source: ListSource) {}

  /** Rebuilds the list. The selection stays where the user put it, however rows come and go. */
  refresh(ctx: ListContext): void {
    this.items = this.source.items(ctx);

    this.selected = keepSelection(this.selected, this.items, (row) =>
      this.items.some((item) => item.key === row.key && this.source.isRunning(item)),
    );
  }

  selection(): Selection {
    return this.source.selectionOf(this.items.find((item) => item.key === this.selected));
  }

  /** Moves the selection `delta` items down (or up, when negative), stopping at the ends. */
  move(delta: number): void {
    const index = this.items.findIndex((item) => item.key === this.selected);
    const target = Math.max(0, Math.min(this.items.length - 1, Math.max(0, index) + delta));
    const next = this.items[target];

    if (next) {
      this.select(next.key);
    }
  }

  /** Selects the item drawn on the `row`th row in view. False when that row is no item's. */
  selectAt(row: number): boolean {
    const key = this.shown[row];

    if (!key) {
      return false;
    }

    this.select(key);

    return true;
  }

  /** Scrolls the list itself, leaving the selection where it is, even out of sight. */
  scrollBy(rows: number): void {
    this.top = Math.max(0, this.top + rows);
    this.follows = false;
  }

  private select(key: string): void {
    this.selected = key;
    this.follows = true;
  }

  moveToStart(): void {
    this.move(-this.items.length);
  }

  moveToEnd(): void {
    this.move(this.items.length);
  }

  /** The rows in view, the selected item marked and kept in view. */
  rows(room: number, emptyText: string): PaneRows {
    const all = this.allRows(emptyText);

    if (this.follows) {
      this.scrollTo(all, room);
    }

    this.top = Math.max(0, Math.min(this.top, all.length - room));

    const visible = all.slice(this.top, this.top + room);

    this.shown = visible.map((entry) => entry.key);

    return {
      rows: visible.map((entry) =>
        row(
          [entry.marked ? [style.key, '▌'] : [null, ' '], [null, ' '], ...entry.row.left],
          entry.row.right,
        ),
      ),
      animated: visible.some((entry) => entry.animated),
    };
  }

  private allRows(emptyText: string): ListRow[] {
    const unmarked = { key: null, selected: false, marked: false, animated: false };

    if (this.items.length === 0) {
      return [{ ...unmarked, row: row([[style.dim, emptyText]]) }];
    }

    const all: ListRow[] = [];

    for (const item of this.items) {
      const selected = item.key === this.selected;

      if (item.gapBefore) {
        all.push({ ...unmarked, row: blankRow });
      }

      for (const [index, itemRow] of item.rows.entries()) {
        all.push({
          row: itemRow,
          key: item.key,
          selected,
          marked: selected && index === 0,
          animated: item.animated,
        });
      }
    }

    return all;
  }

  /** Scrolls just far enough to keep every row of the selected item in view. */
  private scrollTo(all: readonly ListRow[], room: number): void {
    const first = Math.max(
      0,
      all.findIndex((entry) => entry.selected),
    );

    const last = Math.max(
      first,
      all.findLastIndex((entry) => entry.selected),
    );

    if (first < this.top) {
      this.top = first;
    }

    if (last >= this.top + room) {
      this.top = last + 1 - room;
    }
  }
}
