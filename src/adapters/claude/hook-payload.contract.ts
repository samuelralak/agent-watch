import { z } from 'zod';

/** Session ids name files and folders; only the shape Claude Code uses is accepted. */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const backgroundTask = z.object({
  id: z.string(),
  type: z.string().optional(),
  status: z.string().optional(),
});

/**
 * What a Claude Code hook writes to its command's stdin, as far as agentwatch reads it. Unknown
 * fields are dropped: hook payloads gain fields between Claude Code versions.
 */
export const hookPayloadSchema = z
  .object({
    hook_event_name: z.string(),
    session_id: z.string().regex(SESSION_ID),
    cwd: z.string().optional(),
    transcript_path: z.string().optional(),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    agent_transcript_path: z.string().optional(),
    tool_name: z.string().optional(),
    tool_use_id: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    duration_ms: z.number().optional(),
    prompt: z.string().optional(),
    source: z.string().optional(),
    reason: z.string().optional(),
    error: z.unknown().optional(),
    message: z.string().optional(),
    notification_type: z.string().optional(),
    trigger: z.string().optional(),
    last_assistant_message: z.string().optional(),
    background_tasks: z.array(backgroundTask).optional(),
    // Receipts written by agentwatch's own delivery hook.
    nonce: z.string().optional(),
    sender: z.string().optional(),
    via: z.string().optional(),
    text: z.string().optional(),
    file: z.string().optional(),
    mac: z.string().optional(),
  })
  .readonly();

export type HookPayload = z.infer<typeof hookPayloadSchema>;

/** Hook event names agentwatch's own delivery hook uses for its receipts. */
export const RECEIPT_DELIVERED = 'AgentwatchDelivered';
export const RECEIPT_REJECTED = 'AgentwatchRejected';
