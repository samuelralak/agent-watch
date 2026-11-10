import { agentLabel, type TimelineEntry } from '../../domain/agent.js';
import { isActive } from '../../domain/agent-status.policy.js';
import type { OutboxMessage, SessionState } from '../../domain/session.js';
import type { Store } from '../../domain/store.js';
import { clock, formatTokens } from '../../util/format.js';
import { shortPath } from '../../util/paths.js';
import { wrap } from '../../util/text-width.js';
import { distinctLabels } from '../labels.js';
import { blankRow, type Row, row, type Segment } from '../paint.js';
import { INDENT, textRows } from '../text-rows.js';
import { agentColor, style } from '../theme.js';
import type { ActivityBlock, DetailContext, PaneContent } from './agent-detail.js';
import { sessionState } from './agent-list.js';
import { deliveryText, entryRows } from './timeline-entry.js';

/** Calls that only look something up: several in a row read better as one line. */
const LOOKUPS = new Set(['Read', 'Glob', 'Grep']);
const MIN_RUN = 3;

export function outboxStatus(message: OutboxMessage, now: number): Segment {
  if (message.status === 'delivered') {
    return [
      style.green,
      `✓ delivered ${clock(message.deliveredAt ?? now)}, ${deliveryText(message.via)}`,
    ];
  }

  if (now > message.expiresAt) {
    return [style.red, '✗ expired undelivered'];
  }

  return message.woke
    ? [style.magenta, '… waking it']
    : [style.yellow, '… waiting for its next tool call or turn end'];
}

/**
 * The user's messages that have not reached the session yet, each with why it is still
 * waiting. Once a message is delivered it is in the activity below, in full, followed by what
 * the agent said to it.
 */
function waitingRows(session: SessionState, ctx: DetailContext): Row[] {
  const waiting = session.outbox.filter((message) => message.status !== 'delivered');

  if (waiting.length === 0) {
    return [];
  }

  const messages = waiting.flatMap((message) => [
    ...textRows({
      gutter: `${clock(message.createdAt)}  `,
      text: message.text,
      textStyle: style.plain,
      width: ctx.width,
      layout: 'written',
    }),
    row([[null, INDENT], outboxStatus(message, ctx.now)]),
  ]);

  return [row([[style.heading, 'NOT DELIVERED YET']]), ...messages, blankRow];
}

/** Consecutive successful lookups by one agent with one tool, shown as a single line. */
function lookupRun(entries: readonly TimelineEntry[], start: number): number {
  const first = entries[start];

  if (first?.kind !== 'tool' || !LOOKUPS.has(first.call.tool) || first.call.outcome !== 'ok') {
    return 1;
  }

  let end = start + 1;

  while (end < entries.length) {
    const next = entries[end];

    if (next?.kind !== 'tool' || next.agentId !== first.agentId) {
      break;
    }

    if (next.call.tool !== first.call.tool || next.call.outcome !== 'ok') {
      break;
    }

    end++;
  }

  return end - start >= MIN_RUN ? end - start : 1;
}

function runRows(entries: readonly TimelineEntry[], ctx: DetailContext): Row[] {
  const first = entries[0];

  if (first?.kind !== 'tool') {
    return [];
  }

  const summaries = entries.flatMap((entry) => (entry.kind === 'tool' ? [entry.call.summary] : []));

  return textRows({
    gutter: `${clock(first.at)}  `,
    lead: [[style.bold, `${first.call.tool} ×${entries.length}  `]],
    text: summaries.join(' · '),
    textStyle: style.plain,
    width: ctx.width,
    right: [[style.done, '✓']],
  });
}

/**
 * A whole session's activity, grouped by who did it: each agent's entries sit under its name,
 * so parallel agents can be told apart and nothing is squeezed into a label column.
 */
export function sessionActivity(
  store: Store,
  session: SessionState,
  ctx: DetailContext,
): PaneContent {
  const nameOf = agentNames(session);

  const accept = (entry: TimelineEntry): boolean =>
    entry.sessionId === session.sessionId && (!ctx.heldAt || entry.at <= ctx.heldAt);

  return {
    header: headerRows(session, ctx),
    body: (entryCount) => groupedBlocks(store.feed.latest(entryCount, accept), nameOf, ctx),
  };
}

/** The session's name and state, its messages if any, and the heading over the activity. */
function headerRows(session: SessionState, ctx: DetailContext): Row[] {
  const running = [...session.agents.values()].filter(isActive).length;
  const context = session.main.contextTokens;

  const facts = [
    shortPath(session.cwd),
    session.kind,
    `${running} agent${running === 1 ? '' : 's'} running`,
    context ? `${formatTokens(context)} context` : '',
  ].filter(Boolean);

  return [
    row([[style.bold, session.name]], [sessionState(session)]),
    ...wrap(facts.join(' · '), Math.max(10, ctx.width)).map((line) => row([[style.dim, line]])),
    blankRow,
    ...waitingRows(session, ctx),
    row([[style.heading, 'ACTIVITY']]),
  ];
}

/** A name for each agent of the session, with what their labels share left out. */
function agentNames(session: SessionState): (agentId: string | null) => string {
  const agents = [...session.agents.values()];
  const labels = distinctLabels(agents.map(agentLabel));

  const labelOf = new Map<string, string>(
    agents.map((agent, index) => [agent.agentId ?? '', labels[index] ?? '']),
  );

  return (agentId) =>
    agentId === null ? 'main' : labelOf.get(agentId) || `agent ${agentId.slice(0, 7)}`;
}

/** Entries as blocks of rows, with a line naming the agent wherever the one acting changes. */
function groupedBlocks(
  entries: readonly TimelineEntry[],
  nameOf: (agentId: string | null) => string,
  ctx: DetailContext,
): ActivityBlock[] {
  const blocks: ActivityBlock[] = [];
  let speaker: string | null | undefined;
  let index = 0;

  for (let entry = entries[index]; entry; entry = entries[index]) {
    if (entry.agentId !== speaker) {
      speaker = entry.agentId;

      blocks.push({
        rows: [row([[`${agentColor(speaker)};1`, `● ${nameOf(speaker)}`]])],
        entries: [],
      });
    }

    const run = lookupRun(entries, index);
    const together = entries.slice(index, index + run);

    blocks.push({
      rows: run > 1 ? runRows(together, ctx) : entryRows(entry, ctx),
      entries: together,
    });

    index += run;
  }

  return blocks;
}
