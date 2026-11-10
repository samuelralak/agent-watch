import type { SpawnRequest, SpawnResult, WatchEvent } from '../../domain/event.js';
import { tidyPaths } from '../../util/paths.js';
import { asRecord, booleanField, numberField, stringField } from '../../util/record.js';
import { cleanBlock, oneLine } from '../../util/sanitize.js';
import { scanBackwards, Tail } from '../fs/tail.js';
import {
  AGENT_REPORT,
  AGENT_REPORT_NOTICE,
  INTERRUPTED,
  SKILL_BODY,
  stripHarnessText,
  TASK_NOTIFICATION,
  tagText,
} from './harness-text.js';
import { handedBackReport, summarizeToolInput, toolInputDetail } from './tool-input.summary.js';
import { HANDBACK_TOOL, isSpawnTool, toolDisplayName } from './tool-names.js';
import {
  backgroundTaskIdOf,
  contentText,
  summarizeTranscriptResult,
} from './tool-result.summary.js';
import { type TranscriptRecord, transcriptRecordSchema } from './transcript-record.contract.js';

/** What an agent says, and what is said to it, is kept whole up to this size. */
const TEXT_LIMIT = 12_000;

/**
 * A user record that is not just tool results opens a run: the first prompt, or a message that
 * continues an agent after it handed back a report.
 */
export function opensRun(record: TranscriptRecord): boolean {
  if (record.type !== 'user' || !record.message) {
    return false;
  }

  const content = record.message.content;

  if (!Array.isArray(content) || content.length === 0) {
    return true;
  }

  return !content.every((block) => stringField(block, 'type') === 'tool_result');
}

export function contextTokens(
  usage: NonNullable<NonNullable<TranscriptRecord['message']>['usage']>,
): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  );
}

export interface TranscriptReaderOptions {
  readonly sessionId: string;
  readonly agentId: string | null;
  readonly cwd: string;
  readonly emit: (event: WatchEvent) => void;
}

/**
 * Follows one transcript and reports what it says. Records older than `liveSince` are reported
 * in full (history). From `liveSince` on, the session's hooks report tools, prompts and lifecycle
 * precisely, so only what hooks lack is reported: context size, narration, and messages to
 * subagents.
 */
export class TranscriptReader {
  liveSince = Number.POSITIVE_INFINITY;
  /** Lines read, and how many of them were recognisable messages: a drifted format shows here. */
  linesSeen = 0;
  messagesSeen = 0;

  private readonly tail: Tail;
  private readonly sessionId: string;
  private readonly agentId: string | null;
  private readonly emit: (event: WatchEvent) => void;
  private readonly openCalls = new Map<string, { readonly at: number; readonly name: string }>();
  private cwd: string;
  private lastAt = 0;
  private handedBack = false;

  constructor(file: string, options: TranscriptReaderOptions) {
    this.tail = new Tail(file);
    this.sessionId = options.sessionId;
    this.agentId = options.agentId;
    this.cwd = options.cwd;
    this.emit = options.emit;
  }

  get file(): string {
    return this.tail.file;
  }

  seekNearEnd(bytes: number): void {
    this.tail.seekNearEnd(bytes);
  }

  /** Reads what was appended since the last call; returns how many lines it read. */
  pump(maxBytes?: number): number {
    const values = this.tail.read(maxBytes);

    for (const value of values) {
      this.ingest(value);
    }

    return values.length;
  }

  private ingest(value: unknown): void {
    this.linesSeen++;

    const record = transcriptRecordSchema.safeParse(value).data;
    const at = record ? this.timeOf(record) : null;

    if (!record || at === null) {
      return;
    }

    this.lastAt = at;
    this.cwd = record.cwd || this.cwd;

    const moment: Moment = {
      history: at < this.liveSince,
      base: { at, sessionId: this.sessionId, agentId: this.agentId, origin: 'transcript' },
    };

    this.noteNewRun(record, moment);

    if (record.type === 'assistant' && record.message) {
      this.assistantSpoke(record.message, moment);
    } else if (record.type === 'user' && record.message) {
      this.userSpoke(record, record.message.content, moment);
    } else if (record.type === 'attachment' && record.attachment?.type === 'queued_command') {
      this.userText(String(record.attachment.prompt ?? ''), true, moment);
    }
  }

  /** When the record was written. One without a time of its own shares the previous one's. */
  private timeOf(record: TranscriptRecord): number | null {
    const at = record.timestamp ? Date.parse(record.timestamp) : this.lastAt;

    return at && !Number.isNaN(at) ? at : null;
  }

  /** An agent that speaks again after handing its report back has been continued: a new run. */
  private noteNewRun(record: TranscriptRecord, { base, history }: Moment): void {
    if (!this.handedBack || !opensRun(record)) {
      return;
    }

    this.handedBack = false;

    // Hooks report it themselves once they are live.
    if (history && this.agentId !== null) {
      this.emit({ ...base, kind: 'agent.started' });
    }
  }

  private assistantSpoke(message: Message, moment: Moment): void {
    this.messagesSeen++;

    if (message.usage) {
      this.emit({ ...moment.base, kind: 'usage', contextTokens: contextTokens(message.usage) });
    }

    for (const block of Array.isArray(message.content) ? message.content : []) {
      const type = stringField(block, 'type');

      if (type === 'tool_use') {
        this.toolUse(block, moment);
      } else if (type === 'text') {
        this.narration(stringField(block, 'text') ?? '', moment);
      }
    }
  }

  private narration(raw: string, { base }: Moment): void {
    const text = cleanBlock(tidyPaths(raw, this.cwd), TEXT_LIMIT).trim();

    if (text) {
      this.emit({ ...base, kind: 'narration', text });
    }
  }

  private userSpoke(record: TranscriptRecord, content: unknown, moment: Moment): void {
    this.messagesSeen++;

    const isMeta = record.isMeta === true;

    if (typeof content === 'string') {
      this.userText(content, isMeta, moment);

      return;
    }

    for (const block of Array.isArray(content) ? content : []) {
      const type = stringField(block, 'type');

      if (type === 'tool_result' && moment.history) {
        this.toolResult(block, record.toolUseResult, moment);
      } else if (type === 'text') {
        this.userText(stringField(block, 'text') ?? '', isMeta, moment);
      }
    }
  }

  private toolUse(block: unknown, { base, history }: Moment): void {
    const id = stringField(block, 'id');
    const name = stringField(block, 'name') ?? '';

    if (name === HANDBACK_TOOL) {
      this.handedBack = true;
    }

    if (!history || !id) {
      return;
    }

    const input = asRecord(block)?.input;

    this.openCalls.set(id, { at: base.at, name });

    this.emit({
      ...base,
      kind: 'tool.started',
      toolUseId: id,
      tool: toolDisplayName(name),
      summary: summarizeToolInput(name, input, this.cwd),
      detail: toolInputDetail(name, input, this.cwd) || undefined,
      spawn: isSpawnTool(name) ? spawnRequest(input) : undefined,
      report: handedBackReport(name, input),
    });
  }

  private toolResult(block: unknown, toolUseResult: unknown, { base }: Moment): void {
    const id = stringField(block, 'tool_use_id');

    if (!id) {
      return;
    }

    const started = this.openCalls.get(id);
    const name = started?.name;

    this.openCalls.delete(id);

    this.emit({
      ...base,
      kind: 'tool.ended',
      toolUseId: id,
      tool: toolDisplayName(name),
      ok: booleanField(block, 'is_error') !== true,
      durationMs: started ? base.at - started.at : undefined,
      result: summarizeTranscriptResult(name, asRecord(block)?.content, this.cwd),
      spawned: isSpawnTool(name) ? spawnResult(toolUseResult) : undefined,
      backgroundTaskId: backgroundTaskIdOf(toolUseResult),
    });
  }

  /**
   * Text that reached the agent as a user message. Much of it was not typed by anyone: notices
   * about background work, a subagent's report, a loaded skill, an interrupt.
   */
  private userText(raw: string, isMeta: boolean, moment: Moment): void {
    // A loaded skill's instructions are not a message.
    if (isMeta && SKILL_BODY.test(raw)) {
      return;
    }

    if (TASK_NOTIFICATION.test(raw)) {
      this.backgroundNotice(raw, moment);
    } else if (AGENT_REPORT.test(raw)) {
      this.notice(AGENT_REPORT_NOTICE, moment);
    } else if (INTERRUPTED.test(raw)) {
      this.interrupted(moment);
    } else {
      this.said(raw, isMeta, moment);
    }
  }

  private backgroundNotice(raw: string, moment: Moment): void {
    const summary = tagText(raw, 'summary');
    const taskId = tagText(raw, 'task-id');

    // agentwatch's own wake-ups: the delivery receipt already shows them.
    if (summary === 'Stop hook feedback') {
      return;
    }

    // Told to this agent that work it started is over. A subagent pausing is told to its
    // spawner as "completed" too, so only shells count.
    if (taskId && /^Background command/.test(summary)) {
      this.emit({ ...moment.base, kind: 'background.ended', taskId });
    }

    this.notice(oneLine(summary || 'background task update'), moment);
  }

  /** Hooks report the main agent's notices once they are live; nothing reports a subagent's. */
  private notice(text: string, { base, history }: Moment): void {
    if (history || this.agentId !== null) {
      this.emit({ ...base, kind: 'notice', text });
    }
  }

  /** No hook reports an interrupt. For a subagent it is the end of its run. */
  private interrupted({ base }: Moment): void {
    if (this.agentId === null) {
      this.emit({ ...base, kind: 'notice', text: 'interrupted by you' });
    } else {
      this.emit({ ...base, kind: 'agent.stopped', interruptedBy: 'user' });
    }
  }

  /** A prompt the user typed, or (marked as meta) a message from the agent's coordinator. */
  private said(raw: string, isMeta: boolean, { base, history }: Moment): void {
    const text = cleanBlock(tidyPaths(stripHarnessText(raw), this.cwd), TEXT_LIMIT).trim();

    if (!text) {
      return;
    }

    if (!isMeta && history) {
      this.emit({ ...base, kind: 'prompt.submitted', text });
    } else if (isMeta && (history || this.agentId !== null)) {
      this.emit({ ...base, kind: 'message.received', text });
    }
  }
}

type EventBase = Pick<WatchEvent, 'at' | 'sessionId' | 'agentId' | 'origin'>;

/** When and where a record happened, and whether hooks were not yet reporting the session. */
interface Moment {
  readonly base: EventBase;
  /** Before the session's hooks went live: everything the record says is reported. */
  readonly history: boolean;
}

type Message = NonNullable<TranscriptRecord['message']>;

function spawnRequest(input: unknown): SpawnRequest {
  return {
    agentType: stringField(input, 'subagent_type') ?? 'general-purpose',
    description: oneLine(stringField(input, 'description'), 500),
    prompt: cleanBlock(stringField(input, 'prompt'), 6000),
    background: booleanField(input, 'run_in_background') ?? false,
  };
}

function spawnResult(result: unknown): SpawnResult | undefined {
  const agentId = stringField(result, 'agentId');

  if (!agentId) {
    return undefined;
  }

  return {
    agentId,
    agentType: stringField(result, 'agentType'),
    model: stringField(result, 'resolvedModel'),
    completed: stringField(result, 'status') === 'completed',
    totalTokens: numberField(result, 'totalTokens'),
    totalDurationMs: numberField(result, 'totalDurationMs'),
    toolUseCount: numberField(result, 'totalToolUseCount'),
  };
}

/** The text of a transcript's first user message: an agent's task. */
export function firstPrompt(record: unknown): string {
  const parsed = transcriptRecordSchema.safeParse(record);

  if (!parsed.success || !parsed.data.message) {
    return '';
  }

  return cleanBlock(stripHarnessText(contentText(parsed.data.message.content)), 6000).trim();
}

/** When a transcript record happened, or null. */
export function recordTime(record: unknown): number | null {
  const timestamp = stringField(record, 'timestamp');
  const at = timestamp ? Date.parse(timestamp) : Number.NaN;

  return Number.isNaN(at) ? null : at;
}

/**
 * Start of an agent's current run, or of its last run if it has finished: found by reading the
 * transcript backwards and stopping at the hand-back before that run. `budgetBytes` bounds the
 * read; past it the answer is unknown and the caller falls back to the transcript's first record.
 */
export function lastRunStart(file: string, budgetBytes = 8 * 1024 * 1024): number | null {
  let candidate: number | null = null;
  let bytesRead = 0;
  let found: number | null | undefined;

  scanBackwards(file, (line) => {
    bytesRead += line.length + 1;

    if (bytesRead > budgetBytes) {
      return true;
    }

    const isUser = line.includes('"type":"user"');
    const isHandback = line.includes(`"name":"${HANDBACK_TOOL}"`);

    if (!isUser && !isHandback) {
      return false;
    }

    let value: unknown;

    try {
      value = JSON.parse(line);
    } catch {
      return false;
    }

    const parsed = transcriptRecordSchema.safeParse(value);

    if (!parsed.success) {
      return false;
    }

    if (isHandback && parsed.data.type === 'assistant') {
      if (candidate !== null) {
        found = candidate; // a run began after this hand-back

        return true;
      }

      return false; // the agent finished: keep going to where its last run began
    }

    if (opensRun(parsed.data)) {
      candidate = recordTime(value) ?? candidate;
    }

    return false;
  });

  if (found !== undefined) {
    return found;
  }

  return bytesRead > budgetBytes ? null : candidate;
}
