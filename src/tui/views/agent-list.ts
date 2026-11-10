import { type AgentState, agentLabel, currentCall } from '../../domain/agent.js';
import { type AgentStatus, agentStatus, isActive } from '../../domain/agent-status.policy.js';
import {
  endedOn,
  isBusy,
  needsUser,
  type SessionState,
  visibleAgents,
} from '../../domain/session.js';
import type { Store } from '../../domain/store.js';
import { formatAge, formatTokens } from '../../util/format.js';
import { distinctLabels } from '../labels.js';
import { type Row, row, type Segment } from '../paint.js';
import { agentKey, type SelectableRow, sessionKey } from '../selection.js';
import { agentColor, spinner, style } from '../theme.js';

/** One selectable entry of the list: a session, or one of its agents. */
export interface ListItem extends SelectableRow {
  readonly rows: readonly Row[];
  /** It shows a spinner, so it must be redrawn while visible. */
  readonly animated: boolean;
  /** A blank row precedes it: sessions are set apart from each other. */
  readonly gapBefore: boolean;
}

export interface ListContext {
  readonly now: number;
  readonly frame: number;
  /** How long a finished agent stays listed. */
  readonly recentMs: number;
  readonly showFinished: boolean;
}

/**
 * A session is listed once the session list has reported it: while it is alive, and briefly
 * after, if it has agents to show. One known only from its hook events (filtered out with
 * `--session`, or not reported yet) is not shown.
 */
function isListed(session: SessionState, ctx: ListContext): boolean {
  if (session.listedAt === null) {
    return false;
  }

  return session.alive || (ctx.now - session.lastEventAt < ctx.recentMs && session.agents.size > 0);
}

/**
 * Oldest session first, and never reordered by activity: rows that jump under the selection are
 * how a message ends up addressed to the wrong session.
 */
export function listedSessions(store: Store, ctx: ListContext): SessionState[] {
  const order = (session: SessionState): number => session.listedAt ?? Number.MAX_SAFE_INTEGER;

  return [...store.sessions.values()]
    .filter((session) => isListed(session, ctx))
    .sort((a, b) => order(a) - order(b) || (a.sessionId < b.sessionId ? -1 : 1));
}

/** Agents under their spawners, live ones first, each with its depth. */
function inTreeOrder(agents: readonly AgentState[]): { agent: AgentState; depth: number }[] {
  const known = new Set(agents.map((agent) => agent.agentId));
  const children = new Map<string, AgentState[]>();

  for (const agent of agents) {
    const parent = agent.parentAgentId && known.has(agent.parentAgentId) ? agent.parentAgentId : '';

    children.set(parent, [...(children.get(parent) ?? []), agent]);
  }

  const byState = (a: AgentState, b: AgentState): number =>
    Number(!isActive(a)) - Number(!isActive(b)) ||
    (isActive(a)
      ? (a.runStartedAt ?? 0) - (b.runStartedAt ?? 0)
      : (b.endedAt ?? 0) - (a.endedAt ?? 0));

  const out: { agent: AgentState; depth: number }[] = [];

  const walk = (parent: string, depth: number): void => {
    for (const agent of [...(children.get(parent) ?? [])].sort(byState)) {
      out.push({ agent, depth });
      walk(agent.agentId ?? '', depth + 1);
    }
  };

  walk('', 0);

  return out;
}

export function sessionState(session: SessionState): Segment {
  if (!session.alive) {
    return [style.dim, session.endedAt ? 'ended' : 'gone'];
  }

  if (needsUser(session)) {
    return [style.alert, 'needs you'];
  }

  if (isBusy(session)) {
    return [style.yellow, 'busy'];
  }

  // Idle to Claude Code, but its last words ask for something: it is waiting, not done.
  if (endedOn(session)?.asks) {
    return [style.yellow, 'asked you'];
  }

  const background = session.main.backgroundTaskIds.size;

  return [style.green, background ? `idle · ${background} in background` : 'idle'];
}

const STATUS_GLYPH: Readonly<Record<AgentStatus, Segment>> = {
  'in-tool': [style.cyan, '⠋'],
  working: [style.cyan, '●'],
  waiting: [style.yellow, '◷'],
  stalled: [style.yellow, '◌'],
  finished: [style.done, '✓'],
  interrupted: [style.red, '✗'],
  idle: [style.dim, '·'],
};

/** What an agent is doing right now, in one line. */
function activity(agent: AgentState, status: AgentStatus, now: number): Segment[] {
  switch (status) {
    case 'in-tool':
      return callInProgress(agent, now);

    case 'waiting': {
      const tasks = agent.backgroundTaskIds.size;
      const waited = formatAge(now - (agent.pausedAt ?? agent.lastEventAt));

      return [
        [style.yellow, `waiting on ${tasks} background task${tasks === 1 ? '' : 's'} · ${waited}`],
      ];
    }

    case 'stalled':
      return [
        [style.yellow, `quiet for ${formatAge(now - agent.lastEventAt)}`],
        [style.dim, agent.lastNarration ? `  ${agent.lastNarration}` : ''],
      ];

    case 'working':
      return [[style.dim, lastThingDone(agent)]];

    default:
      return [];
  }
}

function callInProgress(agent: AgentState, now: number): Segment[] {
  const call = currentCall(agent);

  if (!call) {
    return [];
  }

  const age = now - call.startedAt;

  return [
    [style.bold, call.tool],
    [style.yellow, age > 3000 ? ` ${formatAge(age)}` : ''],
    [style.dim, `  ${call.summary}`],
  ];
}

/** Between calls: whichever is newer of what the agent last said and what it last ran. */
function lastThingDone(agent: AgentState): string {
  const call = agent.lastCall;

  if (!call) {
    return agent.lastNarration || 'starting…';
  }

  const spokeAfter = agent.lastNarrationAt >= (call.endedAt ?? call.startedAt);

  return agent.lastNarration && spokeAfter ? agent.lastNarration : `${call.tool}  ${call.summary}`;
}

function agentItem(agent: AgentState, label: string, depth: number, ctx: ListContext): ListItem {
  const status = agentStatus(agent, ctx.now);
  const ended = status === 'finished' || status === 'interrupted';
  const indent = '  '.repeat(depth + 1);

  const glyph: Segment =
    status === 'in-tool' ? [style.cyan, spinner(ctx.frame)] : STATUS_GLYPH[status];

  const elapsed: Segment = ended
    ? [style.dim, `${formatAge(ctx.now - (agent.endedAt ?? ctx.now))} ago`]
    : [style.plain, formatAge(ctx.now - (agent.runStartedAt ?? ctx.now))];

  const rows: Row[] = [
    row(
      [[null, indent], glyph, [null, ' '], [ended ? style.dim : agentColor(agent.agentId), label]],
      [elapsed],
    ),
  ];

  const doing = activity(agent, status, ctx.now);

  if (doing.length > 0) {
    rows.push(row([[null, `${indent}  `], ...doing]));
  }

  return {
    key: agentKey(agent.sessionId, agent.agentId ?? ''),
    sessionId: agent.sessionId,
    agentId: agent.agentId,
    rows,
    animated: status === 'in-tool',
    gapBefore: false,
  };
}

/** The agents of a session that are worth listing, with labels told apart. */
export function listedAgents(
  session: SessionState,
  ctx: ListContext,
): { agent: AgentState; depth: number; label: string }[] {
  const agents = visibleAgents(session, ctx.now, ctx.recentMs).filter(
    (agent) => ctx.showFinished || isActive(agent),
  );

  const ordered = inTreeOrder(agents);
  const labels = distinctLabels(ordered.map(({ agent }) => agentLabel(agent)));

  return ordered.map((entry, index) => ({
    ...entry,
    label: labels[index] ?? agentLabel(entry.agent),
  }));
}

/** The list: every session, each followed by its agents. */
export function agentListItems(store: Store, ctx: ListContext): ListItem[] {
  const items: ListItem[] = [];

  for (const session of listedSessions(store, ctx)) {
    const tokens = session.main.contextTokens;

    const rows: Row[] = [
      row(
        [[style.bold, session.name]],
        [sessionState(session), [style.dim, tokens ? `  ${formatTokens(tokens)}` : '']],
      ),
    ];

    if (session.attention) {
      rows.push(
        row([
          [
            session.attention.level === 'permission' ? style.red : style.yellow,
            `! ${session.attention.text}`,
          ],
        ]),
      );
    }

    const ending = endedOn(session);

    // How an idle session ended is under its name: what it asked, or its last words.
    if (ending) {
      rows.push(
        row([ending.asks ? [style.yellow, '? '] : [style.dim, '↳ '], [style.dim, ending.line]]),
      );
    }

    items.push({
      key: sessionKey(session.sessionId),
      sessionId: session.sessionId,
      agentId: null,
      rows,
      animated: false,
      gapBefore: items.length > 0,
    });

    for (const { agent, depth, label } of listedAgents(session, ctx)) {
      items.push(agentItem(agent, label, depth, ctx));
    }
  }

  return items;
}
