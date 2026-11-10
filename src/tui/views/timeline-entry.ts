import type { TimelineEntry, ToolCall } from '../../domain/agent.js';
import { clock, formatAge } from '../../util/format.js';
import type { Row, Segment, Style } from '../paint.js';
import { INDENT, textRows } from '../text-rows.js';
import { spinner, style } from '../theme.js';

export interface EntryContext {
  readonly now: number;
  readonly frame: number;
  /** Columns available, gutter included. */
  readonly width: number;
}

const DELIVERY: Readonly<Record<string, string>> = {
  tool: 'at its next tool call',
  'turn-end': 'as its turn ended',
  wake: 'right away',
};

export const deliveryText = (via: string | null): string => (via ? (DELIVERY[via] ?? via) : '');

/** Tools whose result adds nothing to the call line: the file read, the edit applied. */
const QUIET_RESULTS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite']);
const EMPTY_RESULTS = new Set(['', '(no output)', 'updated', 'created']);

function callStatus(call: ToolCall, ctx: EntryContext): Segment[] {
  switch (call.outcome) {
    case 'running':
      return [[style.yellow, `${spinner(ctx.frame)} ${formatAge(ctx.now - call.startedAt)}`]];

    case 'failed':
      return [[style.red, '✗ failed']];

    case 'unfinished':
      return [[style.dim, '– no result']];

    case 'ok': {
      const slow = call.durationMs !== null && call.durationMs >= 1000;

      return [[style.done, slow ? `✓ ${formatAge(call.durationMs ?? 0)}` : '✓']];
    }
  }
}

/** The line that names a call: its tool, what it asked for in a few words, how it went. */
export function callLine(call: ToolCall, gutter: string, ctx: EntryContext): Row[] {
  return textRows({
    gutter,
    lead: [[style.bold, `${call.tool}  `]],
    text: call.summary,
    textStyle: style.plain,
    width: ctx.width,
    right: callStatus(call, ctx),
  });
}

/** The call as it was made: its tool, what it asked for, and its command when it has one. */
export function callRows(call: ToolCall, gutter: string, ctx: EntryContext): Row[] {
  return [...callLine(call, gutter, ctx), ...commandRows(call, ctx)];
}

/** The command a call ran, as it was written: its line breaks and indentation are part of it. */
function commandRows(call: ToolCall, ctx: EntryContext): Row[] {
  if (!call.detail) {
    return [];
  }

  return textRows({
    gutter: INDENT,
    lead: [[style.dim, '$ ']],
    text: call.detail,
    textStyle: style.code,
    width: ctx.width,
    layout: 'code',
  });
}

/** What the call returned, when that says more than the call line already does. */
function resultRows(call: ToolCall, ctx: EntryContext): Row[] {
  const informative = !EMPTY_RESULTS.has(call.result) && !QUIET_RESULTS.has(call.tool);
  const failed = call.outcome === 'failed';

  if (!failed && !(call.outcome === 'ok' && informative)) {
    return [];
  }

  return textRows({
    gutter: INDENT,
    lead: [[style.dim, '⎿ ']],
    text: call.result || 'failed',
    textStyle: failed ? style.red : style.dim,
    width: ctx.width,
  });
}

/** Everything about a call that its rows show. */
type CallShown = Pick<
  ToolCall,
  'tool' | 'summary' | 'detail' | 'outcome' | 'durationMs' | 'result'
>;

/** Rows that were laid out, and what they were laid out from. */
interface LaidOut {
  readonly width: number;
  readonly call: CallShown | null;
  readonly rows: Row[];
}

const laidOut = new WeakMap<TimelineEntry, LaidOut>();

const shownOf = ({ tool, summary, detail, outcome, durationMs, result }: ToolCall): CallShown => ({
  tool,
  summary,
  detail,
  outcome,
  durationMs,
  result,
});

/** Whether rows kept for an entry are still what laying it out again would give. */
function isCurrent(kept: LaidOut, entry: TimelineEntry, width: number): boolean {
  if (kept.width !== width) {
    return false;
  }

  if (entry.kind !== 'tool' || kept.call === null) {
    return entry.kind !== 'tool';
  }

  const now = shownOf(entry.call);
  const then = kept.call;

  return (Object.keys(now) as (keyof CallShown)[]).every((key) => now[key] === then[key]);
}

/**
 * One timeline entry as rows. Long text wraps; nothing is cut.
 *
 * An entry's rows are kept for as long as what they were made from stays the same, so reading
 * far back in a long history lays each entry out once, not again on every frame. Only a call
 * still running is laid out each time: its row carries a clock. The rows are shared: callers
 * copy them into their own lists and never change them.
 */
export function entryRows(entry: TimelineEntry, ctx: EntryContext): Row[] {
  if (entry.kind === 'tool' && entry.call.outcome === 'running') {
    return layOut(entry, ctx);
  }

  const kept = laidOut.get(entry);

  if (kept && isCurrent(kept, entry, ctx.width)) {
    return kept.rows;
  }

  const rows = layOut(entry, ctx);

  laidOut.set(entry, {
    width: ctx.width,
    call: entry.kind === 'tool' ? shownOf(entry.call) : null,
    rows,
  });

  return rows;
}

function layOut(entry: TimelineEntry, ctx: EntryContext): Row[] {
  const gutter = `${clock(entry.at)}  `;

  switch (entry.kind) {
    case 'tool':
      return [...callRows(entry.call, gutter, ctx), ...resultRows(entry.call, ctx)];

    case 'finished':
      return finishedRows(entry.report, gutter, ctx);

    case 'delivered':
      return textRows({
        gutter,
        lead: [
          [style.message, `✉ ${SENT_BY[entry.sender]}, delivered ${deliveryText(entry.via)}: `],
        ],
        hang: 2,
        text: entry.text,
        textStyle: style.magenta,
        width: ctx.width,
        layout: 'written',
      });

    default:
      return markedRows(markedOf(entry), gutter, ctx);
  }
}

/** An entry that is a mark and some text: what the mark is, what the text says, how it looks. */
interface Marked {
  readonly mark: string;
  readonly text: string;
  readonly textStyle: Style;
  /** Someone's own words, shown as they wrote them; otherwise a line agentwatch words itself. */
  readonly written?: boolean;
}

type MarkedEntry = Exclude<TimelineEntry, { kind: 'tool' | 'finished' | 'delivered' }>;

function markedRows(marked: Marked, gutter: string, ctx: EntryContext): Row[] {
  return textRows({
    gutter,
    lead: marked.mark ? [[marked.textStyle, marked.mark]] : [],
    text: marked.text,
    textStyle: marked.textStyle,
    width: ctx.width,
    layout: marked.written ? 'written' : 'wrapped',
  });
}

/** The agent's report, in full, under the line that says it finished. */
function finishedRows(report: string, gutter: string, ctx: EntryContext): Row[] {
  const rows = markedRows({ mark: '■ ', text: 'finished', textStyle: style.green }, gutter, ctx);

  if (!report) {
    return rows;
  }

  const body = textRows({
    gutter: INDENT,
    text: report,
    textStyle: style.plain,
    width: ctx.width,
    layout: 'written',
  });

  return [...rows, ...body];
}

function markedOf(entry: MarkedEntry): Marked {
  switch (entry.kind) {
    case 'narration':
      return { mark: '', text: entry.text, textStyle: style.plain, written: true };

    case 'prompt':
      return { mark: '› ', text: entry.text, textStyle: style.yellow, written: true };

    case 'message':
      return { mark: '← ', text: entry.text, textStyle: style.magenta, written: true };

    case 'notice':
      return { mark: '◆ ', text: entry.text, textStyle: style.blue };

    case 'started':
      return { mark: '▶ ', text: `started (${entry.agentType})`, textStyle: style.green };

    case 'resumed':
      return { mark: '↻ ', text: 'continued: a new run', textStyle: style.green };

    case 'paused':
      return { mark: '⏸ ', text: pausedText(entry.waitingOn), textStyle: style.yellow };

    case 'woke':
      return {
        mark: '▶ ',
        text: `back to work after ${formatAge(entry.waitedMs)}`,
        textStyle: style.green,
      };

    case 'interrupted':
      return { mark: '■ ', text: INTERRUPTED_BY[entry.by], textStyle: style.red };

    case 'turn-ended':
      return { mark: '· ', text: 'turn ended', textStyle: style.dim };

    case 'attention':
      return { mark: '! ', text: entry.text, textStyle: ATTENTION_STYLE[entry.level] };

    case 'compaction':
      return { mark: '⋯ ', text: `compacting context (${entry.trigger})`, textStyle: style.dim };

    case 'rejected':
      return {
        mark: '⚠ ',
        text: `rejected a message file: ${entry.file}: ${entry.reason}`,
        textStyle: style.alert,
      };
  }
}

/** Whose message a delivery was. An agent's is never shown as the user's own. */
const SENT_BY = {
  user: 'your message',
  agent: "an agent's message",
} as const;

const INTERRUPTED_BY = {
  user: 'interrupted by you',
  'session-end': 'interrupted: its session ended before it finished',
} as const;

const ATTENTION_STYLE = {
  permission: style.alert,
  error: style.yellow,
  info: style.yellow,
} as const;

function pausedText(waitingOn: number): string {
  const tasks = `${waitingOn} background task${waitingOn === 1 ? '' : 's'}`;

  return `waiting on ${tasks} it started`;
}
