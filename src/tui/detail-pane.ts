import type { ToolExchangePort } from '../application/ports/tool-exchange.port.js';
import { agentLabel, type TimelineEntry } from '../domain/agent.js';
import type { Store } from '../domain/store.js';
import { ActivityView, type DetailView, type Pointed } from './activity-view.js';
import type { PaneRows, Selection } from './list-pane.js';
import { type Row, row } from './paint.js';
import { type Exchanges, entryPanel } from './views/entry-panel.js';
import { helpPanel, taskPanel, unreachablePanel } from './views/panels.js';

export type { DetailView } from './activity-view.js';

/** Something shown over the activity until it is closed. */
type Panel =
  | { readonly kind: 'help' }
  | { readonly kind: 'task' }
  | { readonly kind: 'why'; readonly hooksInstalled: boolean }
  | { readonly kind: 'entry'; readonly entries: readonly TimelineEntry[] };

/** An opened entry's rows, kept while nothing they were made from has changed. */
interface OpenedEntry {
  readonly width: number;
  /** How each call stood when it was looked up: a call that ends is looked up again. */
  readonly outcomes: string;
  readonly rows: Row[];
}

const inset = (rows: readonly Row[]): Row[] =>
  rows.map((each) => row([[null, ' '], ...each.left], each.right));

const outcomesOf = (entries: readonly TimelineEntry[]): string =>
  entries.map((entry) => (entry.kind === 'tool' ? entry.call.outcome : '')).join(',');

/**
 * The right-hand pane: the activity of what is selected in the list, or a panel over it (the
 * help, an agent's task, one entry in full).
 */
export class DetailPane {
  private readonly activity: ActivityView;
  private panel: Panel | null = null;
  private panelScroll = 0;
  private opened: OpenedEntry | null = null;
  private pageRows = 10;

  constructor(
    private readonly store: Store,
    now: () => number,
    private readonly toolExchange: Pick<ToolExchangePort, 'find'> | null = null,
  ) {
    this.activity = new ActivityView(store, now);
  }

  get isScrolledBack(): boolean {
    return this.activity.isScrolledBack;
  }

  /** New activity is being held back while an entry is being selected. */
  get isSelecting(): boolean {
    return this.activity.isSelecting;
  }

  /** One entry is open in full. */
  get isReadingEntry(): boolean {
    return this.panel?.kind === 'entry';
  }

  /** The panel that explains why a session cannot be messaged is open. */
  get explainsUnreachable(): boolean {
    return this.panel?.kind === 'why';
  }

  rows(selection: Selection, view: DetailView): PaneRows {
    this.pageRows = Math.max(1, Math.floor(view.room / 2));

    const panel = this.panelRows(selection, view);

    if (panel) {
      this.panelScroll = Math.max(0, Math.min(this.panelScroll, panel.length - view.room));

      const visible = panel.slice(this.panelScroll, this.panelScroll + view.room);

      return { rows: inset(visible), animated: false };
    }

    return this.activity.rows(selection, view);
  }

  /**
   * Moves the view `rows` towards what is older, or with a negative number towards the newest.
   * A panel reads from its top, so older is towards its start. Drawing cuts the position to
   * what there is to show.
   */
  scrollBy(rows: number): void {
    if (this.panel) {
      this.panelScroll = Math.max(0, this.panelScroll - rows);
    } else {
      this.activity.scrollBy(rows);
    }
  }

  /** Half a pane towards what is older. */
  scrollBack(): void {
    this.scrollBy(this.pageRows);
  }

  scrollForward(): void {
    this.scrollBy(-this.pageRows);
  }

  scrollToOldest(): void {
    if (this.panel) {
      this.panelScroll = 0;
    } else {
      this.activity.scrollToOldest();
    }
  }

  scrollToNewest(): void {
    if (this.panel) {
      this.panelScroll = Number.MAX_SAFE_INTEGER;
    } else {
      this.activity.scrollToNewest();
    }
  }

  /** One press of an arrow key while the keys are the activity's: see `ActivityView.step`. */
  step(delta: number): void {
    if (this.panel) {
      this.scrollBy(-delta);
    } else {
      this.activity.step(delta);
    }
  }

  /** Hands the arrow keys to the activity, or takes them back. */
  selecting(on: boolean): void {
    this.activity.selecting(on);

    if (!on && this.isReadingEntry) {
      this.closePanel();
    }
  }

  /** A click on the `row`th row of the pane. */
  selectAt(row: number): Pointed {
    return this.panel ? 'nothing' : this.activity.selectAt(row);
  }

  /** Opens the selected entry in full. */
  openSelected(): void {
    const entries = this.activity.selection;

    if (entries.length > 0) {
      this.show({ kind: 'entry', entries });
    }
  }

  /** Opens the help or the task, or closes it when it is the one already open. */
  toggle(kind: 'help' | 'task'): void {
    if (this.panel?.kind === kind) {
      this.closePanel();
    } else {
      this.show({ kind });
    }
  }

  explainUnreachable(hooksInstalled: boolean): void {
    this.show({ kind: 'why', hooksInstalled });
  }

  closePanel(): void {
    this.panel = null;
    this.opened = null;
  }

  /** Another row was selected: back to its newest activity. */
  selectionChanged(): void {
    this.activity.toLive();

    // The help applies to everything; the other panels are about what was selected.
    if (this.panel?.kind !== 'help') {
      this.closePanel();
    }
  }

  /** Closes any panel and returns to the newest activity. */
  reset(): void {
    this.closePanel();
    this.activity.toLive();
  }

  private show(panel: Panel): void {
    this.panel = panel;
    this.panelScroll = 0;
    this.opened = null;
  }

  private panelRows({ session, agent }: Selection, view: DetailView): Row[] | null {
    switch (this.panel?.kind) {
      case 'help':
        return helpPanel(view.width, view.frame);

      case 'task':
        return agent ? taskPanel(agent, view.width) : null;

      case 'why':
        return session ? unreachablePanel(session, this.panel.hooksInstalled, view.width) : null;

      case 'entry':
        return this.entryRows(this.panel.entries, view);

      default:
        return null;
    }
  }

  /**
   * The opened entry's rows. A call's whole text can be long and is read from a file, so the
   * rows are made once and kept until the pane's width changes or a call in them ends.
   */
  private entryRows(entries: readonly TimelineEntry[], view: DetailView): Row[] {
    const outcomes = outcomesOf(entries);

    if (this.opened?.width !== view.width || this.opened.outcomes !== outcomes) {
      const rows = entryPanel(entries, this.lookUp(entries), { ...view, who: this.whose(entries) });

      this.opened = { width: view.width, outcomes, rows };
    }

    return this.opened.rows;
  }

  private lookUp(entries: readonly TimelineEntry[]): Exchanges {
    const exchanges = new Map<string, ReturnType<ToolExchangePort['find']>>();

    for (const entry of entries) {
      if (entry.kind === 'tool') {
        const { sessionId, agentId, call } = entry;

        exchanges.set(
          call.id,
          this.toolExchange?.find({ sessionId, agentId, toolUseId: call.id }) ?? null,
        );
      }
    }

    return exchanges;
  }

  /** Who the entries are by, in the words the activity uses. */
  private whose(entries: readonly TimelineEntry[]): string {
    const first = entries[0];
    const session = first ? this.store.sessions.get(first.sessionId) : undefined;
    const agent = first?.agentId ? session?.agents.get(first.agentId) : undefined;

    if (!first || !session) {
      return '';
    }

    return `${agent ? agentLabel(agent) : 'main'} · in ${session.name}`;
  }
}
