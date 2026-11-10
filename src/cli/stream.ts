import { agentLabel, type TimelineEntry, type ToolCall } from '../domain/agent.js';
import type { Store, StoreChange } from '../domain/store.js';
import { createPainter, type Row, row, type Segment } from '../tui/paint.js';
import { textRows } from '../tui/text-rows.js';
import { agentColor, style } from '../tui/theme.js';
import { agentListItems } from '../tui/views/agent-list.js';
import { callRows, entryRows } from '../tui/views/timeline-entry.js';
import { clock, formatAge } from '../util/format.js';

export interface StreamOptions {
  /** Past entries printed before the live ones. */
  readonly backlog: number;
  readonly includeMain: boolean;
  readonly includeResults: boolean;
  readonly color: boolean;
  /** Columns to wrap at, or null when the output is not a terminal: then nothing is wrapped. */
  readonly columns: number | null;
  readonly write: (line: string) => void;
  readonly now?: () => number;
}

/** Only sessions the session list reported: with `--session`, the ones that matched. */
const isWatched = (store: Store, sessionId: string): boolean =>
  store.sessions.get(sessionId)?.listedAt != null;

/** Who a line is about, the same on every line of theirs, so a stream can be searched by it. */
function speaker(store: Store, sessionId: string, agentId: string | null): string {
  const session = store.sessions.get(sessionId);
  const agent = agentId === null ? session?.main : session?.agents.get(agentId);
  const name = agent ? agentLabel(agent) : `agent ${agentId?.slice(0, 7)}`;

  return `${session?.name ?? sessionId.slice(0, 8)}/${name}`;
}

/** The end of a call whose start was already printed. */
function endedRows(call: ToolCall, width: number, now: number): Row[] {
  const mark = call.outcome === 'ok' ? '✓' : call.outcome === 'failed' ? '✗' : '–';

  const took =
    call.durationMs !== null && call.durationMs >= 1000 ? ` ${formatAge(call.durationMs)}` : '';

  const result = call.result || (call.outcome === 'unfinished' ? 'no result' : '');

  return textRows({
    gutter: `${clock(call.endedAt ?? now)}  `,
    lead: [[style.dim, '⎿ ']],
    text: `${mark}${took} ${call.tool}${result ? `: ${result}` : ''}`,
    textStyle: call.outcome === 'failed' ? style.red : style.dim,
    width,
  });
}

/**
 * Prints activity as text, one or more lines per entry: the time, who, and what. Returns a
 * function that stops it.
 */
export function streamText(store: Store, options: StreamOptions): () => void {
  const painter = createPainter(options.color);
  const now = options.now ?? Date.now;
  const width = options.columns ?? Number.POSITIVE_INFINITY;

  const wanted = (sessionId: string, agentId: string | null): boolean =>
    isWatched(store, sessionId) && (options.includeMain || agentId !== null);

  // Every row of an entry starts with its time gutter: the speaker goes right after it.
  const print = (rows: readonly Row[], sessionId: string, agentId: string | null): void => {
    const who: Segment = [agentColor(agentId), `[${speaker(store, sessionId, agentId)}] `];

    for (const each of rows) {
      const [gutter, ...rest] = each.left;

      options.write(painter.text([gutter, who, ...rest], width));
    }
  };

  const printEntry = (entry: TimelineEntry): void => {
    const ctx = { now: now(), frame: 0, width };

    // A stream cannot go back and add a call's result under it: that is printed when it ends.
    const rows =
      entry.kind === 'tool'
        ? callRows(entry.call, `${clock(entry.at)}  `, ctx)
        : entryRows(entry, ctx);

    print(rows, entry.sessionId, entry.agentId);
  };

  for (const entry of store.feed.latest(options.backlog, (e) => wanted(e.sessionId, e.agentId))) {
    printEntry(entry);

    if (entry.kind === 'tool' && entry.call.outcome !== 'running' && options.includeResults) {
      print(endedRows(entry.call, width, now()), entry.sessionId, entry.agentId);
    }
  }

  return store.subscribe((change) => {
    if (change.kind === 'recorded') {
      if (wanted(change.entry.sessionId, change.entry.agentId)) {
        printEntry(change.entry);
      }
    } else if (options.includeResults && wanted(change.sessionId, change.agentId)) {
      print(endedRows(change.call, width, now()), change.sessionId, change.agentId);
    }
  });
}

/** One change as a flat object: an entry's own fields, plus when, where and who. */
function changeRecord(store: Store, change: StoreChange): Record<string, unknown> {
  const sessionId = change.kind === 'recorded' ? change.entry.sessionId : change.sessionId;
  const agentId = change.kind === 'recorded' ? change.entry.agentId : change.agentId;
  const session = store.sessions.get(sessionId);
  const agent = agentId === null ? null : session?.agents.get(agentId);

  const about = {
    session: session?.name ?? null,
    sessionId,
    agent: agent ? agentLabel(agent) : null,
    agentId,
  };

  if (change.kind === 'call-ended') {
    const { call } = change;

    return {
      time: new Date(call.endedAt ?? call.startedAt).toISOString(),
      ...about,
      kind: 'tool.ended',
      callId: call.id,
      tool: call.tool,
      outcome: call.outcome,
      durationMs: call.durationMs,
      result: call.result,
    };
  }

  const { at, seq: _seq, sessionId: _session, agentId: _agent, ...body } = change.entry;
  const time = new Date(at).toISOString();

  if (body.kind === 'tool') {
    const { call } = body;

    return {
      time,
      ...about,
      kind: 'tool.started',
      callId: call.id,
      tool: call.tool,
      summary: call.summary,
      ...(call.detail ? { command: call.detail } : {}),
    };
  }

  return { time, ...about, ...body };
}

/** Prints every change as one JSON object per line. Returns a function that stops it. */
export function streamJson(store: Store, options: StreamOptions): () => void {
  return store.subscribe((change) => {
    const sessionId = change.kind === 'recorded' ? change.entry.sessionId : change.sessionId;
    const agentId = change.kind === 'recorded' ? change.entry.agentId : change.agentId;

    if (!isWatched(store, sessionId) || (!options.includeMain && agentId === null)) {
      return;
    }

    if (change.kind === 'call-ended' && !options.includeResults) {
      return;
    }

    options.write(JSON.stringify(changeRecord(store, change)));
  });
}

/** Prints the list of sessions and their agents, as it is now. */
export function printAgentList(
  store: Store,
  options: Pick<StreamOptions, 'color' | 'columns' | 'write' | 'now'> & { recentMs: number },
): void {
  const painter = createPainter(options.color);
  const columns = options.columns ?? 120;

  const items = agentListItems(store, {
    now: (options.now ?? Date.now)(),
    frame: 0,
    recentMs: options.recentMs,
    showFinished: true,
  });

  if (items.length === 0) {
    options.write('No Claude Code sessions running.');
  }

  for (const item of items) {
    if (item.gapBefore) {
      options.write('');
    }

    for (const each of item.rows) {
      options.write(painter.line(row([[null, '  '], ...each.left], each.right), columns).trimEnd());
    }
  }
}
