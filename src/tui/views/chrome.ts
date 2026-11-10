import { isActive } from '../../domain/agent-status.policy.js';
import { endedOn, needsUser } from '../../domain/session.js';
import type { Store } from '../../domain/store.js';
import { clock } from '../../util/format.js';
import { width } from '../../util/text-width.js';
import type { Focus } from '../layout.js';
import { type Row, row, type Segment } from '../paint.js';
import { style } from '../theme.js';

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

export interface TitleBarContext {
  readonly now: number;
  readonly paused: boolean;
  /** The activity is scrolled back, so new entries are being held. */
  readonly scrolledBack: boolean;
  /** An entry of the activity is being selected, which holds new entries back as well. */
  readonly selecting?: boolean;
  /** A message is being written: Esc closes its box, so it is not the way back to live. */
  readonly writing?: boolean;
  /** Sending is locked: messages need the user's fingerprint. */
  readonly locked?: boolean;
}

/** The top row: what is running, and what needs the user. */
export function titleBar(store: Store, ctx: TitleBarContext): Row {
  let sessions = 0;
  let working = 0;
  let waitingOnUser = 0;
  let asked = 0;

  for (const session of store.sessions.values()) {
    if (!session.alive) {
      continue;
    }

    sessions++;

    if (needsUser(session)) {
      waitingOnUser++;
    } else if (endedOn(session)?.asks) {
      asked++;
    }

    for (const agent of session.agents.values()) {
      if (isActive(agent)) {
        working++;
      }
    }
  }

  const rejected = store.rejections.length;
  const back = ctx.writing ? 'ctrl-d for newer' : 'esc for live';
  const held = heldText(ctx, back);

  return row(
    [[style.bold, ' agentwatch'], ctx.locked ? [style.dim, '  sending locked'] : null],
    [
      [style.dim, `${plural(sessions, 'session')} · `],
      [working ? style.cyan : style.dim, `${plural(working, 'agent')} at work`],
      waitingOnUser
        ? [style.alert, ` · ${waitingOnUser} need${waitingOnUser === 1 ? 's' : ''} you`]
        : null,
      asked ? [style.yellow, ` · ${asked} asked you`] : null,
      rejected ? [style.alert, ` · ⚠ ${rejected} rejected`] : null,
      held ? [style.yellow, `  ${held}`] : null,
      [style.dim, `   ${clock(ctx.now)}`],
    ],
  );
}

/** Why new activity is not being shown, and how to have it again; empty while it is. */
function heldText(ctx: TitleBarContext, back: string): string {
  if (ctx.paused) {
    return 'PAUSED';
  }

  if (ctx.scrolledBack) {
    return `SCROLLED BACK · ${back}`;
  }

  return ctx.selecting ? `HELD WHILE YOU SELECT · ${back}` : '';
}

/** Which of its two lists the list pane shows. */
export type ListShown = 'running' | 'history';

/**
 * The list's first row: its two lists, the one on show in bold. The number of past sessions
 * is said once they have been looked for.
 */
export function listTabs(shown: ListShown, pastCount: number | null): Row {
  const history = pastCount === null ? 'History' : `History (${pastCount})`;

  return row(
    [
      [null, '  '],
      [shown === 'running' ? style.bold : style.dim, 'Live'],
      [style.dim, ' │ '],
      [shown === 'history' ? style.bold : style.dim, history],
    ],
    [[style.dim, 'h switches']],
  );
}

/** The first warning, and how many more there are. */
export function warningRow(warnings: ReadonlyMap<string, string>): Row | null {
  const [first] = warnings.values();

  if (first === undefined) {
    return null;
  }

  const more = warnings.size > 1 ? `  (+${warnings.size - 1} more)` : '';

  return row([
    [style.yellow, ` ! ${first}`],
    [style.dim, more],
  ]);
}

export interface KeyHintContext {
  readonly columns: number;
  /** The message box is open. */
  readonly writing: boolean;
  /** The box's border had room for the keys for writing, so this row need not repeat them. */
  readonly keysInBox: boolean;
  /** The pane the arrow keys belong to. */
  readonly focus: Focus;
  /** One entry of the activity is open in full. */
  readonly readingEntry?: boolean;
  /** Which list is on show, where there are two; undefined where there is no history. */
  readonly listShown?: ListShown;
  readonly showFinished: boolean;
  readonly paused: boolean;
}

const GAP = '   ';

/** As many hints as fit, the most needed first, so a narrow terminal keeps the essential ones. */
function fitted(hints: readonly Hint[], columns: number): Row {
  const segments: Segment[] = [];
  let used = 0;

  for (const [key, action] of hints) {
    const gap = segments.length > 0 ? GAP : '';
    const text = key ? ` ${action}` : action;
    const needed = width(gap) + width(key) + width(text);

    if (used + needed > columns) {
      break;
    }

    segments.push([null, gap], [style.key, key], [style.dim, text]);
    used += needed;
  }

  return row(segments);
}

type Hint = readonly [key: string, action: string];

/**
 * While a message is written, the box's border carries the keys when it has room: this row
 * then keeps the one thing to remember. When it has not, the keys are here.
 */
const WRITING_WITH_KEYS_IN_BOX: readonly Hint[] = [
  ['', 'approvals and answers to its questions go in its own terminal'],
  ['ctrl-u/d', 'scroll'],
];

const WRITING: readonly Hint[] = [
  ['⏎', 'send'],
  ['esc', 'keeps draft'],
  ['alt-⏎', 'new line'],
  ['ctrl-u/d', 'scroll'],
];

const READING_ENTRY: readonly Hint[] = [
  ['↑↓', 'scroll'],
  ['←', 'back to the activity'],
  ['ctrl-u/d', 'half a pane'],
  ['g G', 'top, bottom'],
  ['esc', 'live'],
  ['⏎', 'message'],
];

const IN_ACTIVITY: readonly Hint[] = [
  ['↑↓', 'select'],
  ['→', 'open in full'],
  ['tab', 'back to the list'],
  ['⏎', 'message'],
  ['ctrl-u/d', 'half a pane'],
  ['g G', 'oldest, newest'],
  ['esc', 'live'],
  ['?', 'help'],
];

const historyHint = (shown: ListShown): Hint => ['h', shown === 'running' ? 'history' : 'live'];

/** The keys that matter right now, the most needed first. */
function hintsFor(ctx: KeyHintContext): readonly Hint[] {
  if (ctx.writing) {
    return ctx.keysInBox ? WRITING_WITH_KEYS_IN_BOX : WRITING;
  }

  if (ctx.readingEntry) {
    return READING_ENTRY;
  }

  if (ctx.focus === 'activity') {
    return IN_ACTIVITY;
  }

  return [
    ['⏎', 'message'],
    ['↑↓', 'move'],
    ['?', 'help'],
    ['q', 'quit'],
    ['tab', 'into the activity'],
    ...(ctx.listShown ? [historyHint(ctx.listShown)] : []),
    ['t', 'task'],
    ['d', ctx.showFinished ? 'hide finished' : 'show finished'],
    ['p', ctx.paused ? 'resume' : 'pause'],
  ];
}

/** The bottom row: as many of the keys that matter right now as fit. */
export function keyHints(ctx: KeyHintContext): Row {
  return fitted(hintsFor(ctx), ctx.columns);
}
