import {
  type AgentState,
  agentLabel,
  currentCall,
  type TimelineEntry,
} from '../../domain/agent.js';
import { agentStatus } from '../../domain/agent-status.policy.js';
import type { SessionState } from '../../domain/session.js';
import { formatAge, formatDuration, formatTokens, sparkline } from '../../util/format.js';
import { width, wrap } from '../../util/text-width.js';
import { blankRow, type Row, row, type Segment } from '../paint.js';
import { agentColor, spinner, style } from '../theme.js';
import { type EntryContext, entryRows } from './timeline-entry.js';

/** The task's first lines sit above the timeline; `t` opens all of it. */
const TASK_LINES = 2;

export interface DetailContext extends EntryContext {
  /** Entries newer than this are held back (the view is paused or scrolled back); 0 shows all. */
  readonly heldAt: number;
}

/** A stretch of the scrolling rows that stands for one thing. */
export interface ActivityBlock {
  readonly rows: Row[];
  /**
   * The entries the rows show: one, or several where lookups were put on one line. None for a
   * line that only names who is acting. A block with entries can be selected and opened.
   */
  readonly entries: readonly TimelineEntry[];
}

/** A pane's content: rows that stay put, and blocks that scroll, newest at the bottom. */
export interface PaneContent {
  readonly header: Row[];
  /** Builds the scrolling blocks from the newest `entryCount` entries. */
  body(entryCount: number): ActivityBlock[];
}

/** The selected agent: who it is, what it was asked, and everything it has done. */
export function agentDetail(
  session: SessionState,
  agent: AgentState,
  ctx: DetailContext,
): PaneContent {
  const header: Row[] = [
    row([[`${agentColor(agent.agentId)};1`, agentLabel(agent)]], statusPill(agent, ctx)),
    ...factRows(session, agent, ctx),
    ...numberRows(agent, ctx),
    blankRow,
    ...taskRows(agent, ctx),
    row([[style.heading, 'TIMELINE']]),
  ];

  const accept = ctx.heldAt ? (entry: { at: number }) => entry.at <= ctx.heldAt : undefined;

  return {
    header,
    body: (entryCount) =>
      agent.timeline
        .latest(entryCount, accept)
        .map((entry) => ({ rows: entryRows(entry, ctx), entries: [entry] })),
  };
}

const dimRows = (text: string, columns: number): Row[] =>
  wrap(text, Math.max(10, columns)).map((line) => row([[style.dim, line]]));

const ago = (since: number | null, now: number): string => `${formatAge(now - (since ?? now))} ago`;

/** What the agent is doing right now, in a few words at the top right. */
function statusPill(agent: AgentState, ctx: EntryContext): Segment[] {
  switch (agentStatus(agent, ctx.now)) {
    case 'finished':
      return [[style.green, `✓ finished ${ago(agent.endedAt, ctx.now)}`]];

    case 'interrupted':
      return [[style.red, `✗ interrupted ${ago(agent.endedAt, ctx.now)}`]];

    case 'in-tool': {
      const call = currentCall(agent);
      const running = formatAge(ctx.now - (call?.startedAt ?? ctx.now));

      return [[style.cyan, `${spinner(ctx.frame)} ${call?.tool ?? 'tool'} ${running}`]];
    }

    case 'waiting':
      return [[style.yellow, '◷ waiting on its background work']];

    case 'stalled':
      return [[style.yellow, `◌ quiet for ${formatAge(ctx.now - agent.lastEventAt)}`]];

    default:
      return [[style.cyan, '● working']];
  }
}

/** What kind of agent it is, and where it belongs. */
function factRows(session: SessionState, agent: AgentState, ctx: DetailContext): Row[] {
  const parent = agent.parentAgentId ? session.agents.get(agent.parentAgentId) : undefined;

  const facts = [
    agent.type,
    agent.model,
    agent.background ? 'background' : '',
    `in ${session.name}`,
    parent ? `from ${agentLabel(parent)}` : '',
  ].filter(Boolean);

  return dimRows(facts.join(' · '), ctx.width);
}

/** How long it has run, how much context it holds, how many calls it made and how many failed. */
function numberRows(agent: AgentState, ctx: DetailContext): Row[] {
  const stats = statistics(agent, ctx.now).join(' · ');
  const failed = agent.failureCount ? `${agent.failureCount} failed` : '';
  const statsWidth = width(stats) + (failed ? width(failed) + 3 : 0);

  // Too narrow for one row: the numbers wrap, and nothing is cut.
  if (statsWidth > ctx.width) {
    return [...dimRows(stats, ctx.width), ...(failed ? [row([[style.red, failed]])] : [])];
  }

  // The last half hour, a bar a minute. Left out when it is empty or would crowd the numbers.
  const recent = sparkline(agent.activity.series(ctx.now));
  const showRecent = recent.trim() !== '' && statsWidth + 2 + width(recent) <= ctx.width;

  return [
    row(
      [
        [style.dim, stats],
        [style.red, failed ? ` · ${failed}` : ''],
      ],
      showRecent ? [[style.cyan, recent]] : undefined,
    ),
  ];
}

function statistics(agent: AgentState, now: number): string[] {
  const started = agent.runStartedAt ?? now;

  const ran =
    agent.endedAt === null
      ? `running ${formatDuration(now - started)}`
      : `ran ${formatDuration(agent.endedAt - started)}`;

  const context = agent.contextTokens || agent.totals?.tokens;

  return [
    ran,
    context ? `${formatTokens(context)} context` : '',
    `${agent.callCount} tool call${agent.callCount === 1 ? '' : 's'}`,
  ].filter(Boolean);
}

/** The start of the task the agent was given. The whole of it is one key away. */
function taskRows(agent: AgentState, ctx: DetailContext): Row[] {
  if (!agent.prompt) {
    return [];
  }

  const lines = wrap(agent.prompt, Math.max(10, ctx.width));
  const hint = lines.length > TASK_LINES ? `t shows all ${lines.length} lines` : '';

  return [
    row([[style.heading, 'TASK']], hint ? [[style.dim, hint]] : undefined),
    ...lines.slice(0, TASK_LINES).map((line) => row([[style.dim, line]])),
    blankRow,
  ];
}
