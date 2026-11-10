import type { ToolExchange } from '../../application/ports/tool-exchange.port.js';
import type { TimelineEntry, ToolCall } from '../../domain/agent.js';
import { clock } from '../../util/format.js';
import { wrap } from '../../util/text-width.js';
import { renderCode } from '../markdown.js';
import { blankRow, type Row, row, type Style } from '../paint.js';
import { style } from '../theme.js';
import { callLine, type EntryContext, entryRows } from './timeline-entry.js';

export interface EntryPanelContext extends EntryContext {
  /** Whose entry it is, as the activity names them. */
  readonly who: string;
}

/** What is known of each call in the panel, by the call's id; null when it was not found. */
export type Exchanges = ReadonlyMap<string, ToolExchange | null>;

const INDENT = '  ';

const NOT_FOUND =
  "A call's whole input and output are read from its agent's transcript when the call is opened. This one was not found there, so what follows is what agentwatch kept of it.";

const NO_RESULT = 'none on record: the call is still running, or it was not allowed to run';

/**
 * One entry of the activity, all of it. For a tool call that is what the tool was given and
 * what it gave back, of which the activity keeps a line each; for anything else it is the
 * entry by itself, to be read without the rest moving around it.
 */
export function entryPanel(
  entries: readonly TimelineEntry[],
  exchanges: Exchanges,
  ctx: EntryPanelContext,
): Row[] {
  const rows: Row[] = [
    row(
      [
        [style.heading, 'ENTRY  '],
        [style.dim, ctx.who],
      ],
      [[style.dim, '← or esc closes']],
    ),
  ];

  for (const entry of entries) {
    rows.push(blankRow);

    rows.push(
      ...(entry.kind === 'tool'
        ? callInFull(entry, exchanges.get(entry.call.id) ?? null, ctx)
        : entryRows(entry, ctx)),
    );
  }

  return rows;
}

function callInFull(
  entry: TimelineEntry & { kind: 'tool' },
  exchange: ToolExchange | null,
  ctx: EntryContext,
): Row[] {
  if (!exchange) {
    return [...note(NOT_FOUND, ctx.width), blankRow, ...entryRows(entry, ctx)];
  }

  return [
    ...callLine(entry.call, `${clock(entry.at)}  `, ctx),
    ...section('INPUT', exchange.input, style.code, ctx.width),
    ...resultSection(entry.call, exchange.result, ctx.width),
  ];
}

function resultSection(call: ToolCall, result: string | null, width: number): Row[] {
  if (result === null) {
    return [blankRow, row([[style.heading, 'RESULT']]), ...note(NO_RESULT, width, INDENT)];
  }

  const textStyle = call.outcome === 'failed' ? style.red : style.plain;

  return section('RESULT', result || '(no output)', textStyle, width);
}

/** A heading and, under it, text exactly as it was: nothing of it is summed up or cut. */
function section(title: string, text: string, textStyle: Style, width: number): Row[] {
  const lines = renderCode(text, Math.max(8, width - INDENT.length), undefined, textStyle);

  return [
    blankRow,
    row([[style.heading, title]]),
    ...lines.map((line) => row([[null, INDENT], ...line])),
  ];
}

const note = (text: string, width: number, indent = ''): Row[] =>
  wrap(text, Math.max(20, width - indent.length)).map((line) =>
    row([
      [null, indent],
      [style.dim, line],
    ]),
  );
