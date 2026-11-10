import { type AgentState, agentLabel } from '../../domain/agent.js';
import type { SessionState } from '../../domain/session.js';
import { pad, wrap } from '../../util/text-width.js';
import { blankRow, type Row, row, type Segment, type Style } from '../paint.js';
import { agentColor, spinner, style } from '../theme.js';

const paragraph = (text: string, width: number, textStyle: Style = style.plain): Row[] =>
  wrap(text, Math.max(20, width)).map((line) => row([[textStyle, line]]));

/** How to restart a session so it loads agentwatch's hooks; its conversation is kept. */
export function resumeCommand(session: SessionState): string {
  return session.kind === 'background'
    ? `claude stop ${session.shortId ?? session.sessionId} && claude --resume ${session.sessionId} --bg`
    : `claude --resume ${session.sessionId}`;
}

/** Why the selected session cannot take a message, and what to do about it. */
export function unreachablePanel(
  session: SessionState,
  hooksInstalled: boolean,
  width: number,
): Row[] {
  const rows: Row[] = [
    row(
      [[style.yellow, `${session.name} can't receive messages yet`]],
      [[style.dim, 'esc closes']],
    ),
    blankRow,
  ];

  if (!hooksInstalled) {
    rows.push(
      ...paragraph(
        "Messages are delivered by agentwatch's hooks, which aren't installed. Run this once in a terminal; every Claude Code session then picks them up, with no change to how you start it:",
        width,
      ),
      row([
        [null, '    '],
        [style.key, 'agentwatch hooks install'],
      ]),
    );

    return rows;
  }

  rows.push(
    ...paragraph(
      "It hasn't run agentwatch's hooks since they were installed. Claude Code picks them up without a restart, but this session has been idle since, so nothing has triggered them.",
      width,
    ),
    blankRow,
    ...paragraph(
      'It becomes reachable by itself after its next turn, for example when one of its subagents finishes. To make it reachable now, send it anything in its own terminal once.',
      width,
      style.dim,
    ),
    blankRow,
    ...paragraph(
      `If it still can't after a turn, restart it: /exit in its terminal, then ${resumeCommand(session)} (y copies it). The conversation is kept.`,
      width,
      style.dim,
    ),
  );

  return rows;
}

/** Everything an agent was asked to do, in full. */
export function taskPanel(agent: AgentState, width: number): Row[] {
  return [
    row(
      [
        [style.heading, 'TASK  '],
        [agentColor(agent.agentId), agentLabel(agent)],
      ],
      [[style.dim, 'esc closes']],
    ),
    blankRow,
    ...paragraph(agent.prompt, width),
  ];
}

/** The widths of the column of keys and of the column of marks in the help. */
const KEY_COLUMN = 18;
const SYMBOL_COLUMN = 3;

const KEYS: readonly (readonly [string, string])[] = [
  ['↑ ↓  j k', 'select a session or one of its agents'],
  ['⏎', 'write a message to the selected session; ⏎ again sends it'],
  ['alt-⏎', 'while writing: a new line (a paste keeps its line breaks too)'],
  ['esc', 'close the message box (the draft is kept) or a panel; back to the newest activity'],
  ['tab  →', 'move into the activity: ↑ ↓ then select its entries, one after another'],
  [
    '→  o',
    'in the activity: open the selected entry in full, with all a tool was given and gave back',
  ],
  ['←  tab', 'back out: from an open entry to the activity, from the activity to the list'],
  ['g  G', 'the first and the last: of the list, of the activity, of an open entry'],
  [
    'ctrl-u  ctrl-d',
    'scroll half a pane, from anywhere, also while writing (PageUp and PageDown too)',
  ],
  [
    'trackpad, wheel',
    'scroll the pane under the pointer; a click selects, a second click opens an entry',
  ],
  ['h', 'switch the list between the running sessions and the past ones'],
  ['t', "read the selected agent's whole task"],
  ['d', 'show or hide finished agents'],
  ['p', 'pause the view'],
  ['q', 'quit'],
];

const MOUSE_NOTE =
  'While agentwatch reports the mouse, select text by holding Option, Fn or Shift, as your terminal has it, or start it with --no-mouse.';

/** A key or a mark, and what it means: the meaning wraps under itself, never under the mark. */
function meaningRows(
  mark: Segment,
  column: number,
  meaning: string,
  textStyle: Style,
  width: number,
): Row[] {
  return wrap(meaning, Math.max(20, width - column)).map((line, index) =>
    row([
      [mark[0], pad(index === 0 ? mark[1] : '', column)],
      [textStyle, line],
    ]),
  );
}

/** Keys, how messages work, and what the symbols mean. */
export function helpPanel(width: number, frame: number): Row[] {
  const rows: Row[] = [
    row([[style.bold, 'How to use agentwatch']], [[style.dim, 'esc closes']]),
    blankRow,
    ...KEYS.flatMap(([key, action]) =>
      meaningRows([style.key, key], KEY_COLUMN, action, style.plain, width),
    ),
    blankRow,
    ...paragraph(MOUSE_NOTE, width, style.dim),
  ];

  rows.push(
    blankRow,
    row([[style.heading, 'MESSAGES']]),
    ...paragraph(
      "A message goes to the session's main agent: the conversation you type into in that terminal. If a subagent is selected, the message says which one, and the main agent can pass it on.",
      width,
      style.dim,
    ),
    ...paragraph(
      'An idle session is woken at once. A busy one gets it right away if it is listening, and otherwise at its next tool call. Messages are signed, so a file dropped in the inbox by another program is rejected.',
      width,
      style.dim,
    ),
    ...paragraph(
      "Messages are instructions, not answers. Claude Code presents them as hook feedback or as a notification, never as you typing, so an agent may decline one and will not take one as approval of something it asked you about. Each message shows what the agent said next. Answer permission prompts and questions in the session's own terminal.",
      width,
      style.yellow,
    ),
    blankRow,
    row([[style.heading, 'SYMBOLS']]),
    ...symbolRows(frame, width),
  );

  return rows;
}

/** What each mark beside an agent means, one to a row so that none is cut on a narrow pane. */
function symbolRows(frame: number, width: number): Row[] {
  const symbols: readonly (readonly [Style, string, string])[] = [
    [style.cyan, '●', 'working'],
    [style.cyan, spinner(frame), 'in a tool'],
    [style.yellow, '◷', 'waiting on its background work'],
    [style.yellow, '◌', 'quiet for 5 min'],
    [style.done, '✓', 'finished'],
    [style.red, '✗', 'interrupted, by you or by its session ending'],
  ];

  return symbols.flatMap(([markStyle, mark, meaning]) =>
    meaningRows([markStyle, mark], SYMBOL_COLUMN, meaning, style.dim, width),
  );
}
