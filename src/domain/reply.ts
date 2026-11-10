import { isActive } from './agent-status.policy.js';
import {
  type Answering,
  isBusy,
  type OutboxMessage,
  type ReplyPart,
  type SessionState,
} from './session.js';

// What the main agent says after a message was delivered is its reply to it. Delivered does not
// mean acted on, so the reply is what shows whether the message did anything.
//
// A reply is not over when a turn is. An agent that answers "I have started the review and will
// report when it is done" ends its turn, and speaks again when the work comes back: that is the
// answer the message was sent for. So a reply follows the agent for as long as it carries on by
// itself, one part for each turn, and is over when the agent stops with none of the work it
// started since the message still running, or when the user speaks to the session again. Work
// that was already running when the message came, such as a development server, is not counted:
// it says nothing about whether an answer is still to come.

const sameWords = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A message was delivered: what the main agent says from here is its reply to it. */
export function startReply(session: SessionState, message: OutboxMessage): void {
  session.answering = { message, runningBefore: new Set(session.main.backgroundTaskIds) };
}

/** The main agent said `text` at `at`: part of its reply, if a message is being answered. */
export function noteReply(session: SessionState, text: string, at: number): void {
  const sent = session.answering?.message;

  if (!sent || sent.deliveredAt === null || at < sent.deliveredAt) {
    return;
  }

  const part = partAt(sent, at);

  if (!part) {
    sent.replies.push({ text, at, endedAt: null });

    return;
  }

  // Both sources report the agent's words: the same words are part of the reply once.
  if (sameWords(part.text).includes(sameWords(text))) {
    return;
  }

  part.text = `${part.text}\n\n${text}`;
}

/**
 * The part that words said at `at` belong to: the first whose turn had not ended by then.
 * Words can be reported after their turn ended, by the other source: they are not a new part.
 */
function partAt(sent: OutboxMessage, at: number): ReplyPart | undefined {
  return sent.replies.find((part) => part.endedAt === null || at <= part.endedAt);
}

/**
 * The main agent ended a turn. That ends this part of the reply, and all of it unless work it
 * started since the message is still running: then it will be back, and what it says is the
 * rest. A message handed over as a turn ends is delivered by that very turn end, which ends
 * nothing.
 */
export function closeReply(session: SessionState, at: number): void {
  const answering = session.answering;
  const sent = answering?.message;

  if (!answering || sent?.deliveredAt == null || at <= sent.deliveredAt) {
    return;
  }

  endOpenPart(sent, at);

  if (!hasWorkOnMessage(session, answering)) {
    session.answering = null;
  }
}

/** The user spoke to the session itself: what it says from here answers that, not the message. */
export function userSpoke(session: SessionState, at: number): void {
  const sent = session.answering?.message;

  if (sent?.deliveredAt == null || at <= sent.deliveredAt) {
    return;
  }

  endOpenPart(sent, at);
  session.answering = null;
}

function endOpenPart(sent: OutboxMessage, at: number): void {
  const last = sent.replies.at(-1);

  if (last && last.endedAt === null) {
    last.endedAt = at;
  }
}

/**
 * Whether work the session started since the message was delivered is still running: a
 * background task that was not running before, or a subagent first seen since.
 */
function hasWorkOnMessage(session: SessionState, { message, runningBefore }: Answering): boolean {
  const since = message.deliveredAt ?? 0;
  const tasks = [...session.main.backgroundTaskIds];
  const agents = [...session.agents.values()];

  return (
    tasks.some((id) => !runningBefore.has(id)) ||
    agents.some((agent) => isActive(agent) && (agent.firstSeenAt ?? 0) >= since)
  );
}

/** Whether the main agent may yet say more to `message`: it is at work, or will be back. */
export function isStillAnswering(session: SessionState, message: OutboxMessage): boolean {
  const answering = session.answering;

  if (answering?.message !== message) {
    return false;
  }

  return isBusy(session) || hasWorkOnMessage(session, answering);
}
