import { z } from 'zod';
import { SESSION_ID } from './hook-payload.contract.js';

const spawnRequest = z.object({
  agentType: z.string(),
  description: z.string(),
  prompt: z.string(),
  background: z.boolean(),
});

const spawnResult = z.object({
  agentId: z.string(),
  agentType: z.string().optional(),
  model: z.string().optional(),
  completed: z.boolean(),
  totalTokens: z.number().optional(),
  totalDurationMs: z.number().optional(),
  toolUseCount: z.number().optional(),
});

/**
 * One hook event as the spool keeps it: reduced to what the views need, because raw payloads
 * can be large (an Agent result carries the whole prompt and report; a Read result the file).
 */
export const spoolRecordSchema = z
  .object({
    v: z.literal(2),
    at: z.number(),
    event: z.string(),
    sessionId: z.string().regex(SESSION_ID),
    agentId: z.string().optional(),
    agentType: z.string().optional(),
    cwd: z.string().optional(),
    transcriptPath: z.string().optional(),
    reason: z.string().optional(),
    text: z.string().optional(),
    toolUseId: z.string().optional(),
    toolName: z.string().optional(),
    summary: z.string().optional(),
    detail: z.string().optional(),
    spawn: spawnRequest.optional(),
    ok: z.boolean().optional(),
    durationMs: z.number().optional(),
    result: z.string().optional(),
    spawned: spawnResult.optional(),
    backgroundTaskId: z.string().optional(),
    runningTaskIds: z.array(z.string()).optional(),
    notificationType: z.string().optional(),
    trigger: z.string().optional(),
    // Delivery receipts, signed by the hook that delivered or rejected a message.
    nonce: z.string().optional(),
    sender: z.string().optional(),
    via: z.string().optional(),
    file: z.string().optional(),
    mac: z.string().optional(),
  })
  .readonly();

export type SpoolRecord = z.infer<typeof spoolRecordSchema>;
