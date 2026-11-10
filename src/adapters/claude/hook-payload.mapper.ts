import { booleanField, numberField, stringField } from '../../util/record.js';
import { cleanBlock, oneLine } from '../../util/sanitize.js';
import { type HookPayload, RECEIPT_DELIVERED, RECEIPT_REJECTED } from './hook-payload.contract.js';
import type { SpoolRecord } from './spool-record.contract.js';
import {
  handedBackReport,
  REPORT_LIMIT,
  summarizeToolInput,
  toolInputDetail,
} from './tool-input.summary.js';
import { isSpawnTool } from './tool-names.js';
import { backgroundTaskIdOf, summarizeHookResult } from './tool-result.summary.js';

const PROMPT_LIMIT = 6000;
const LINE_LIMIT = 500;
const RECEIPT_LINE_LIMIT = 200;

/** What a record keeps of a payload, beyond when, which event and whose. */
type SpoolFields = Partial<Omit<SpoolRecord, 'v' | 'at' | 'event' | 'sessionId'>>;

/**
 * Reduces a hook payload, received at `at`, to the record the spool keeps. Raw payloads can be
 * large (an Agent result carries the whole report, a Read result the file); a record keeps one
 * line per tool call and caps prompts and reports.
 */
export function toSpoolRecord(payload: HookPayload, at: number): SpoolRecord {
  const reduce = FIELDS[payload.hook_event_name];

  return {
    v: 2,
    at,
    event: payload.hook_event_name,
    sessionId: payload.session_id,
    ...(payload.agent_id ? { agentId: payload.agent_id, agentType: payload.agent_type } : {}),
    ...reduce?.(payload),
  };
}

/** One reducer per hook event. An event that is not listed keeps only who and when. */
const FIELDS: Readonly<Record<string, (payload: HookPayload) => SpoolFields>> = {
  SessionStart: (payload) => ({ cwd: payload.cwd, transcriptPath: payload.transcript_path }),
  SessionEnd: (payload) => ({ reason: payload.reason }),
  UserPromptSubmit: (payload) => ({ text: cleanBlock(payload.prompt, PROMPT_LIMIT) }),
  PreToolUse: toolStarted,
  PermissionRequest: toolRequested,
  PostToolUse: toolSucceeded,
  PostToolUseFailure: toolFailed,
  SubagentStop: (payload) => ({
    transcriptPath: payload.agent_transcript_path,
    text: cleanBlock(payload.last_assistant_message, REPORT_LIMIT),
    runningTaskIds: runningTaskIds(payload) ?? [],
  }),
  Stop: (payload) => ({
    text: cleanBlock(payload.last_assistant_message, REPORT_LIMIT),
    runningTaskIds: runningTaskIds(payload),
  }),
  StopFailure: (payload) => ({
    text: oneLine(errorText(payload.error) || payload.reason || 'unknown error', LINE_LIMIT),
  }),
  Notification: (payload) => ({
    text: oneLine(payload.message, LINE_LIMIT),
    notificationType: payload.notification_type,
  }),
  PreCompact: (payload) => ({ trigger: payload.trigger }),
  [RECEIPT_DELIVERED]: (payload) => ({
    nonce: payload.nonce,
    sender: payload.sender,
    via: payload.via,
    text: cleanBlock(payload.text, PROMPT_LIMIT),
    mac: payload.mac,
  }),
  [RECEIPT_REJECTED]: (payload) => ({
    file: oneLine(payload.file, RECEIPT_LINE_LIMIT),
    reason: oneLine(payload.reason, RECEIPT_LINE_LIMIT),
    mac: payload.mac,
  }),
};

/** A call asking for permission: the call and what it would do, nothing more. */
function toolRequested(payload: HookPayload): SpoolFields {
  const { tool_name: name, tool_input: input, cwd = '' } = payload;
  const detail = toolInputDetail(name, input, cwd);

  return {
    toolUseId: payload.tool_use_id,
    toolName: name,
    summary: summarizeToolInput(name, input, cwd),
    ...(detail ? { detail } : {}),
  };
}

function toolStarted(payload: HookPayload): SpoolFields {
  const input = payload.tool_input;
  const report = handedBackReport(payload.tool_name, input);

  return {
    ...toolRequested(payload),
    ...(report ? { text: report } : {}),
    ...(isSpawnTool(payload.tool_name) ? { spawn: spawnRequest(input) } : {}),
  };
}

function spawnRequest(input: unknown): NonNullable<SpoolRecord['spawn']> {
  return {
    agentType: stringField(input, 'subagent_type') ?? 'general-purpose',
    description: oneLine(stringField(input, 'description'), LINE_LIMIT),
    prompt: cleanBlock(stringField(input, 'prompt'), PROMPT_LIMIT),
    background: booleanField(input, 'run_in_background') ?? false,
  };
}

function toolSucceeded(payload: HookPayload): SpoolFields {
  const response = payload.tool_response;
  const spawned = isSpawnTool(payload.tool_name) ? spawnResult(response) : undefined;

  return {
    toolUseId: payload.tool_use_id,
    toolName: payload.tool_name,
    ok: true,
    durationMs: payload.duration_ms,
    result: summarizeHookResult(payload.tool_name, response, payload.cwd ?? ''),
    backgroundTaskId: backgroundTaskIdOf(response),
    ...(spawned ? { spawned } : {}),
  };
}

function toolFailed(payload: HookPayload): SpoolFields {
  const reason = errorText(payload.error) || stringField(payload.tool_response, 'error');

  return {
    toolUseId: payload.tool_use_id,
    toolName: payload.tool_name,
    ok: false,
    durationMs: payload.duration_ms,
    result: oneLine(reason || 'failed', LINE_LIMIT),
  };
}

/** The agent an Agent call started, as its result names it; undefined when it names none. */
function spawnResult(response: unknown): SpoolRecord['spawned'] {
  const agentId = stringField(response, 'agentId');

  if (!agentId) {
    return undefined;
  }

  return {
    agentId,
    agentType: stringField(response, 'agentType'),
    model: stringField(response, 'resolvedModel'),
    completed: stringField(response, 'status') === 'completed',
    totalTokens: numberField(response, 'totalTokens'),
    totalDurationMs: numberField(response, 'totalDurationMs'),
    toolUseCount: numberField(response, 'totalToolUseCount'),
  };
}

/** The background tasks a stop event lists as still running, session-wide. */
function runningTaskIds(payload: HookPayload): string[] | undefined {
  return payload.background_tasks
    ?.filter((task) => task.status === undefined || task.status === 'running')
    .map((task) => task.id);
}

function errorText(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  return stringField(error, 'message') ?? '';
}
