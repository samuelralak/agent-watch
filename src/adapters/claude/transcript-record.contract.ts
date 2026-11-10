import { z } from 'zod';

/**
 * One line of a Claude Code transcript, as far as agentwatch reads it. The format is internal to
 * Claude Code and undocumented, so the contract is loose: unknown fields are dropped, and a line
 * that does not fit is skipped rather than trusted.
 */
export const transcriptRecordSchema = z
  .object({
    type: z.string(),
    timestamp: z.string().optional(),
    cwd: z.string().optional(),
    isMeta: z.boolean().optional(),
    message: z
      .object({
        content: z.unknown().optional(),
        usage: z
          .object({
            input_tokens: z.number().optional(),
            output_tokens: z.number().optional(),
            cache_read_input_tokens: z.number().optional(),
            cache_creation_input_tokens: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    attachment: z
      .object({ type: z.string().optional(), prompt: z.unknown().optional() })
      .optional(),
    toolUseResult: z.unknown().optional(),
  })
  .readonly();

export type TranscriptRecord = z.infer<typeof transcriptRecordSchema>;

/** A subagent's metadata file, written next to its transcript. */
export const agentMetaSchema = z
  .object({
    agentType: z.string().optional(),
    description: z.string().optional(),
    parentAgentId: z.string().optional(),
    model: z.string().optional(),
    worktreePath: z.string().optional(),
    finished: z.boolean().optional(),
  })
  .readonly();

export type AgentMeta = z.infer<typeof agentMetaSchema>;
