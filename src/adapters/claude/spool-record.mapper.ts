import type { DeliveryPath, WatchEvent } from '../../domain/event.js';
import { oneLine } from '../../util/sanitize.js';
import { AGENT_REPORT, AGENT_REPORT_NOTICE, TASK_NOTIFICATION, tagText } from './harness-text.js';
import { RECEIPT_DELIVERED, RECEIPT_REJECTED } from './hook-payload.contract.js';
import type { SpoolRecord } from './spool-record.contract.js';
import { toolDisplayName } from './tool-names.js';

/** Whether a delivery receipt carries a valid signature from agentwatch's hook. */
export type ReceiptVerifier = (record: SpoolRecord) => boolean;

/** When, where and who: what every event of a record shares. */
type EventBase = Pick<WatchEvent, 'at' | 'sessionId' | 'agentId' | 'origin'>;

type EventMapper = (
  record: SpoolRecord,
  base: EventBase,
  verifyReceipt: ReceiptVerifier,
) => WatchEvent[];

const IDLE_NOTICE = 'idle for a minute: ready for your next prompt';

const DELIVERY_PATHS: Readonly<Record<string, DeliveryPath>> = {
  tool: 'tool',
  'turn-end': 'turn-end',
  wake: 'wake',
};

/** The events a spool record stands for. Receipts count only when `verifyReceipt` accepts them. */
export function toWatchEvents(record: SpoolRecord, verifyReceipt: ReceiptVerifier): WatchEvent[] {
  const base: EventBase = {
    at: record.at,
    sessionId: record.sessionId,
    agentId: record.agentId ?? null,
    origin: 'hook',
  };

  return EVENTS[record.event]?.(record, base, verifyReceipt) ?? [];
}

/** One mapper per hook event. An event that is not listed stands for nothing. */
const EVENTS: Readonly<Record<string, EventMapper>> = {
  SessionStart: (record, base) => [
    { ...base, kind: 'session.started', cwd: record.cwd, transcriptPath: record.transcriptPath },
  ],
  SessionEnd: (record, base) => [{ ...base, kind: 'session.ended', reason: record.reason }],
  UserPromptSubmit: promptSubmitted,
  PreToolUse: toolStarted,
  PostToolUse: toolEnded,
  PostToolUseFailure: toolEnded,
  SubagentStart: (record, base) => [
    { ...base, kind: 'agent.started', agentType: record.agentType },
  ],
  SubagentStop: (record, base) => [
    {
      ...base,
      kind: 'agent.stopped',
      agentType: record.agentType,
      report: record.text,
      transcriptPath: record.transcriptPath,
      runningTaskIds: record.runningTaskIds ?? [],
    },
  ],
  Stop: (record, base) => [
    { ...base, kind: 'turn.ended', text: record.text, runningTaskIds: record.runningTaskIds },
  ],
  StopFailure: (record, base) => [
    { ...base, kind: 'attention', level: 'error', text: `turn failed: ${record.text ?? ''}` },
  ],
  Notification: notified,
  PermissionRequest: (record, base) => [
    {
      ...base,
      kind: 'attention',
      level: 'permission',
      text: `permission: ${toolDisplayName(record.toolName)} ${record.summary ?? ''}`,
    },
  ],
  PreCompact: (record, base) => [
    { ...base, kind: 'compaction', trigger: record.trigger ?? 'auto' },
  ],
  [RECEIPT_DELIVERED]: messageDelivered,
  [RECEIPT_REJECTED]: messageRejected,
};

/**
 * Claude Code's notices to the user. The one it sends when a session has sat idle for a minute
 * says "Claude is waiting for your input", which reads as if something had been asked: it is
 * shown as what it is, and never as something that needs attention.
 */
function notified(record: SpoolRecord, base: EventBase): WatchEvent[] {
  if (record.notificationType === 'idle_prompt') {
    return [{ ...base, kind: 'notice', text: IDLE_NOTICE }];
  }

  return [
    {
      ...base,
      kind: 'attention',
      level: record.notificationType === 'permission_prompt' ? 'permission' : 'info',
      text: record.text ?? '',
    },
  ];
}

/** What reaches an agent as a prompt is not always something the user typed. */
function promptSubmitted(record: SpoolRecord, base: EventBase): WatchEvent[] {
  const text = record.text ?? '';

  if (TASK_NOTIFICATION.test(text)) {
    return backgroundNotice(text, base);
  }

  if (AGENT_REPORT.test(text)) {
    return [{ ...base, kind: 'notice', text: AGENT_REPORT_NOTICE }];
  }

  return [{ ...base, kind: 'prompt.submitted', text: text.trim() }];
}

/**
 * A notice about background work. Its status is not used: it says "completed" when a subagent
 * only paused, and the stop events carry the list of what is really still running.
 */
function backgroundNotice(text: string, base: EventBase): WatchEvent[] {
  const summary = tagText(text, 'summary');

  // agentwatch's own wake-ups arrive this way too; the delivery receipt already shows them.
  if (summary === 'Stop hook feedback') {
    return [];
  }

  return [{ ...base, kind: 'notice', text: oneLine(summary || 'background task update') }];
}

function toolStarted(record: SpoolRecord, base: EventBase): WatchEvent[] {
  if (!record.toolUseId) {
    return [];
  }

  return [
    {
      ...base,
      kind: 'tool.started',
      toolUseId: record.toolUseId,
      tool: toolDisplayName(record.toolName),
      summary: record.summary ?? '',
      detail: record.detail,
      spawn: record.spawn,
      report: record.text,
    },
  ];
}

function toolEnded(record: SpoolRecord, base: EventBase): WatchEvent[] {
  if (!record.toolUseId) {
    return [];
  }

  return [
    {
      ...base,
      kind: 'tool.ended',
      toolUseId: record.toolUseId,
      tool: toolDisplayName(record.toolName),
      ok: record.ok !== false,
      durationMs: record.durationMs,
      result: record.result ?? '',
      spawned: record.spawned,
      backgroundTaskId: record.backgroundTaskId,
    },
  ];
}

function messageDelivered(
  record: SpoolRecord,
  base: EventBase,
  verifyReceipt: ReceiptVerifier,
): WatchEvent[] {
  const via = DELIVERY_PATHS[record.via ?? ''];

  if (!record.nonce || !via || !verifyReceipt(record)) {
    return forgedReceipt(base);
  }

  return [
    {
      ...base,
      agentId: null,
      kind: 'message.delivered',
      nonce: record.nonce,
      sender: record.sender === 'agent' ? 'agent' : 'user',
      via,
      text: record.text ?? '',
    },
  ];
}

function messageRejected(
  record: SpoolRecord,
  base: EventBase,
  verifyReceipt: ReceiptVerifier,
): WatchEvent[] {
  if (!verifyReceipt(record)) {
    return forgedReceipt(base);
  }

  return [
    {
      ...base,
      agentId: null,
      kind: 'message.rejected',
      file: record.file ?? '',
      reason: record.reason ?? '',
    },
  ];
}

/** A receipt without a valid signature was not written by the delivery hook. Say so, loudly. */
function forgedReceipt(base: EventBase): WatchEvent[] {
  return [
    {
      ...base,
      agentId: null,
      kind: 'message.rejected',
      file: 'delivery receipt',
      reason: 'a receipt without a valid signature was written to the event folder',
    },
  ];
}
