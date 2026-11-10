import { type AgentState, agentLabel } from '../../domain/agent.js';
import { MESSAGE_TEXT_LIMIT } from '../../domain/message.js';
import { isStillAnswering } from '../../domain/reply.js';
import {
  isBusy,
  needsUser,
  type OutboxMessage,
  type ReplyPart,
  type SessionState,
} from '../../domain/session.js';
import { clock, formatCount } from '../../util/format.js';
import { width, wrap } from '../../util/text-width.js';
import { type Row, row, type Segment, type Style } from '../paint.js';
import type { EditorView, TextEditor } from '../text-editor.js';
import { agentColor, style } from '../theme.js';
import { outboxStatus } from './session-activity.js';

/** The draft's size is shown once it has taken this share of what a message holds. */
const FULLNESS_SHOWN_FROM = 0.75;
/** A sent message's fate stays in the message box this long. */
const RECENT_MESSAGE_MS = 10 * 60 * 1000;
/** The agent's reply to it takes at most this many rows of the box; all of it is in the activity. */
const REPLY_ROWS = 3;
const REPLY_LABEL = '↳ it said: ';
/** For what it said in a later turn: it had already said something before. */
const LATER_REPLY_LABEL = '↳ then it said: ';
/** The rows a reply wraps onto start under its label, not under the arrow. */
const REPLY_HANG = '  ';
/** Where the rest of a reply that is cut here can be read. */
const REPLY_ELSEWHERE = 'all of it: in its activity';

/** A message being written. Its target is fixed when the box opens, whatever the list does. */
export interface Draft {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly agentId: string | null;
  readonly agentLabel: string | null;
  readonly editor: TextEditor;
}

/** The room the box has, which the terminal's size decides. */
export interface BoxRoom {
  /** Columns the text inside the box has, and the most rows it may take. */
  readonly columns: number;
  readonly maxRows: number;
  /** Columns the texts set into one border of the box may take together. */
  readonly borderColumns: number;
}

export interface MessageBoxContext extends BoxRoom {
  readonly now: number;
  /** The draft being written, when the box is open. */
  readonly draft: Draft | null;
  /** The draft's session as it is now, if it is still known. */
  readonly draftSession: SessionState | null;
  /** What is selected in the list: where a new message would go. */
  readonly session: SessionState | null;
  readonly agent: AgentState | null;
  /** Text written to the selected session earlier and not sent. */
  readonly savedDraft: string | null;
  /** The draft is being signed and queued. */
  readonly sending: boolean;
  /** Whether the session has a waiter listening, so a message reaches it at once. */
  readonly hasWaiter: (sessionId: string) => boolean;
}

/**
 * The box at the bottom of the view, as its parts: who a message goes to sits in its top
 * border, the text in its body, and the keys and what becomes of the message in its bottom
 * border.
 */
export interface MessageBox {
  readonly title: readonly Segment[];
  /**
   * How much there is of the draft, at the far end of the top border: which rows are in view
   * when not all are, and how much of a message's room it has taken once that matters.
   */
  readonly extent: readonly Segment[];
  /** The text being written, wrapped, or the one row that says what to do. */
  readonly body: readonly Row[];
  /**
   * The keys, when the border has room for all of them beside the state. Empty when it has
   * not: the row of key hints under the box carries them then.
   */
  readonly keys: readonly Segment[];
  readonly state: readonly Segment[];
  /** The text cursor within the body, or null when nothing is being written. */
  readonly cursor: { readonly row: number; readonly column: number } | null;
}

const WRITING_KEYS: readonly Segment[] = [
  [style.key, '⏎'],
  [style.dim, ' send · '],
  [style.key, 'alt-⏎'],
  [style.dim, ' new line · '],
  [style.key, 'esc'],
  [style.dim, ' keeps draft'],
];

const segmentsWidth = (segments: readonly Segment[]): number =>
  segments.reduce((sum, [, text]) => sum + width(text), 0);

/** `keys`, when the border has room for all of them beside `state`; otherwise none of them. */
function keysBeside(
  keys: readonly Segment[],
  state: readonly Segment[],
  borderColumns: number,
): readonly Segment[] {
  return segmentsWidth(keys) + segmentsWidth(state) <= borderColumns ? keys : [];
}

/** The box while nothing is being written: no cursor, and whatever parts are given. */
function resting(parts: Pick<MessageBox, 'title' | 'body'> & Partial<MessageBox>): MessageBox {
  return { extent: [], keys: [], state: [], cursor: null, ...parts };
}

/** Where the box's text goes: the columns each row has, and how many rows it may take. */
type Room = Pick<BoxRoom, 'columns' | 'maxRows'>;

/**
 * At most `maxRows` of `lines`. What does not fit is left on the last row, where the painter
 * cuts it with a mark: a row never ends as if nothing followed it.
 */
function fitted(lines: readonly string[], maxRows: number): string[] {
  if (lines.length <= maxRows) {
    return [...lines];
  }

  return [...lines.slice(0, maxRows - 1), lines.slice(maxRows - 1).join(' ')];
}

/** A line agentwatch words itself, wrapped so that a narrow terminal does not cut it. */
function note(text: string, room: Room, textStyle: Style = style.dim): Row[] {
  return fitted(wrap(text, room.columns), room.maxRows).map((line) => row([[textStyle, line]]));
}

/** The box as it is now. While a draft is open it shows the draft's own target. */
export function messageBox(ctx: MessageBoxContext): MessageBox {
  if (ctx.draft) {
    return writing(ctx.draft, ctx);
  }

  if (!ctx.session) {
    return resting({
      title: [[style.dim, 'Messages']],
      body: note('Select a session or one of its agents to message it.', ctx),
    });
  }

  return unreachable(ctx.session, ctx) ?? ready(ctx.session, ctx);
}

function addressee(name: string, label: string | null, agentId: string | null): Segment[] {
  const to: Segment[] = [
    [style.message, 'To '],
    [style.bold, name],
  ];

  return label ? [...to, [style.dim, ' · about '], [agentColor(agentId), label]] : to;
}

function writing(draft: Draft, ctx: MessageBoxContext): MessageBox {
  const view = draft.editor.view(ctx.columns, ctx.maxRows);
  // Counted the way sending counts it.
  const length = draft.editor.text.trim().length;
  const state = [draftState(ctx, length)];

  return {
    title: addressee(draft.sessionName, draft.agentLabel, draft.agentId),
    extent: extentOf(view, length),
    body: view.rows.map((text) => row([[style.plain, text]])),
    keys: keysBeside(WRITING_KEYS, state, ctx.borderColumns),
    state,
    cursor: view.cursor,
  };
}

/** Which rows the box shows, when the draft has more of them than the box does. */
function rowsInView({ rows, first, total }: EditorView): Segment[] {
  if (rows.length === total) {
    return [];
  }

  const shown = rows.length === 1 ? `row ${first + 1}` : `rows ${first + 1}-${first + rows.length}`;

  return [[style.dim, `${shown} of ${total}`]];
}

/** How full the draft is, said from the point where it starts to matter. */
function fullness(length: number): Segment[] {
  if (length < FULLNESS_SHOWN_FROM * MESSAGE_TEXT_LIMIT) {
    return [];
  }

  const textStyle = length > MESSAGE_TEXT_LIMIT ? style.red : style.dim;

  return [[textStyle, `${formatCount(length)}/${formatCount(MESSAGE_TEXT_LIMIT)}`]];
}

function extentOf(view: EditorView, length: number): Segment[] {
  const rows = rowsInView(view);
  const full = fullness(length);

  return rows.length > 0 && full.length > 0
    ? [...rows, [style.dim, ' · '], ...full]
    : [...rows, ...full];
}

/**
 * What will happen to the draft if it is sent now. Every one of these fits the border of the
 * narrowest terminal the view is drawn in, so none of them is ever cut.
 */
function draftState(ctx: MessageBoxContext, length: number): Segment {
  const { draftSession, hasWaiter, sending } = ctx;

  if (sending) {
    return [style.message, 'sending: use Touch ID if asked'];
  }

  if (!draftSession?.alive) {
    return [style.red, 'session ended: your draft is kept'];
  }

  // Nothing written is ever dropped: a draft that is too long says so, and is not sent as it is.
  if (length > MESSAGE_TEXT_LIMIT) {
    return [style.red, `${formatCount(length - MESSAGE_TEXT_LIMIT)} characters too long`];
  }

  // A message is an instruction, never an answer to a prompt the session is waiting on.
  if (needsUser(draftSession)) {
    return [style.red, 'it needs approval in its terminal'];
  }

  return [style.dim, arrival(draftSession, hasWaiter)];
}

/**
 * When a message sent now would reach the main agent. A waiter left by the last turn end hands
 * it over at once, even to a session that has since gone back to work.
 */
function arrival(session: SessionState, hasWaiter: (sessionId: string) => boolean): string {
  const busy = isBusy(session);

  if (hasWaiter(session.sessionId)) {
    return busy ? 'busy: reaches it right away' : 'idle: wakes it now';
  }

  return busy ? 'busy: at its next tool call' : 'idle: at its next turn';
}

/** Why the selected session cannot be written to right now, or null when it can. */
function unreachable(session: SessionState, room: Room): MessageBox | null {
  if (!session.alive) {
    return resting({
      title: [[style.dim, session.name]],
      body: note('This session has ended.', room),
    });
  }

  if (session.canMessage) {
    return null;
  }

  return resting({
    title: [
      [style.bold, session.name],
      [style.yellow, " can't receive messages yet"],
    ],
    body: note("It hasn't run agentwatch's hooks yet; it will after its next turn.", room),
    state: [[style.dim, '⏎ why']],
  });
}

/** The selected session can be written to: what a new message would do, or the last one did. */
function ready(session: SessionState, ctx: MessageBoxContext): MessageBox {
  const { agent, now } = ctx;
  const title = addressee(session.name, agent ? agentLabel(agent) : null, agent?.agentId ?? null);

  if (needsUser(session)) {
    return resting({
      title,
      body: note('It is asking you to approve something: answer in its terminal.', ctx, style.red),
      state: [[style.red, 'waiting for you']],
    });
  }

  const last = session.outbox.at(-1);
  const recent = last && now - last.createdAt < RECENT_MESSAGE_MS ? last : null;
  const state = recent ? [sentState(session, recent, now)] : [];

  const keys: Segment[] = [
    [style.key, '⏎'],
    [style.dim, ctx.savedDraft ? ' continue the draft' : ' write a message'],
  ];

  return resting({
    title,
    body: invitation(ctx, recent),
    state,
    keys: keysBeside(keys, state, ctx.borderColumns),
  });
}

/**
 * What the box says while nothing is being written: a draft put aside, or the last message
 * sent from here and, once there is one, the agent's reply to it.
 */
function invitation(ctx: MessageBoxContext, recent: OutboxMessage | null): Row[] {
  if (ctx.savedDraft) {
    return [
      row([
        [style.yellow, 'draft: '],
        [style.dim, ctx.savedDraft],
      ]),
    ];
  }

  if (!recent) {
    return note('No recent messages from this window.', ctx);
  }

  if (recent.replies.length > 0) {
    return replyRows(recent.replies, ctx);
  }

  return [
    row([
      [style.magenta, '✉ you said: '],
      [style.dim, recent.text],
    ]),
  ];
}

/**
 * What became of the last message. While the agent is still at work on it, that is said:
 * what it has said so far may be a holding answer, and the one that matters is yet to come.
 */
function sentState(session: SessionState, message: OutboxMessage, now: number): Segment {
  if (message.status === 'delivered' && isStillAnswering(session, message)) {
    return [style.cyan, `✓ delivered ${clock(message.deliveredAt ?? now)} · still at work`];
  }

  return outboxStatus(message, now);
}

/**
 * The newest thing the agent said to the last message, on the few rows the box gives it. When
 * more was said than is here (the rest of this, or what it said in an earlier turn), the box
 * says where all of it is, instead of just stopping.
 */
function replyRows(replies: readonly ReplyPart[], room: Room): Row[] {
  const label = replies.length > 1 ? LATER_REPLY_LABEL : REPLY_LABEL;
  const hang = width(REPLY_HANG);
  const text = inPlainWords(replies.at(-1)?.text ?? '');
  const lines = wrap(text, room.columns - hang, room.columns - width(label));
  const rows = fitted(lines, Math.min(REPLY_ROWS, room.maxRows));
  const pointer = pointsElsewhere(rows, lines.length, replies.length, room);

  return rows.map((line, index) =>
    row(
      [index === 0 ? [style.magenta, label] : [null, REPLY_HANG], [style.dim, line]],
      pointer && index === rows.length - 1 ? [[style.dim, REPLY_ELSEWHERE]] : undefined,
    ),
  );
}

/** The line under a table's first row, or a rule: dashes and bars, nothing to read. */
const ONLY_RULES = /^[\s|:-]+$/;

/**
 * Text as one line of plain words, for the few rows the box has: the marks of Markdown are
 * left out, and the cells of a table are set apart by dots instead of bars. All of it, laid
 * out as it was written, is in the activity.
 */
function inPlainWords(text: string): string {
  return text
    .split('\n')
    .filter((line) => !ONLY_RULES.test(line))
    .map((line) => {
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '');

      return line.trim().startsWith('|')
        ? cells
            .split('|')
            .map((cell) => cell.trim())
            .join(' · ')
        : line;
    })
    .join(' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether the last row says where the whole reply is. It does when the reply is cut here,
 * unless that would take more than half of the row from it; and when there are earlier parts,
 * if the row has the room to spare: the pointer never costs a word that would otherwise show.
 */
function pointsElsewhere(
  rows: readonly string[],
  lineCount: number,
  partCount: number,
  room: Room,
): boolean {
  const needed = width(REPLY_ELSEWHERE) + 2;

  if (rows.length < lineCount) {
    return 2 * needed <= room.columns;
  }

  const lastRow = width(rows.at(-1) ?? '') + (rows.length === 1 ? width(LATER_REPLY_LABEL) : 2);

  return partCount > 1 && lastRow + needed <= room.columns;
}
