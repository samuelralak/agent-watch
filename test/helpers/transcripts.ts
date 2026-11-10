import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const iso = (at: number): string => new Date(at).toISOString();

/** Transcript records in the shapes Claude Code writes. */
export const record = {
  prompt: (at: number, text: string) => ({
    type: 'user',
    timestamp: iso(at),
    message: { content: text },
  }),
  coordinatorMessage: (at: number, text: string) => ({
    type: 'user',
    timestamp: iso(at),
    isMeta: true,
    message: { content: text },
  }),
  narration: (at: number, text: string) => ({
    type: 'assistant',
    timestamp: iso(at),
    message: { content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 20 } },
  }),
  toolUse: (at: number, id: string, name: string, input: object = {}) => ({
    type: 'assistant',
    timestamp: iso(at),
    message: { content: [{ type: 'tool_use', id, name, input }] },
  }),
  toolResult: (at: number, id: string, content = 'ok', toolUseResult?: object) => ({
    type: 'user',
    timestamp: iso(at),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
    ...(toolUseResult ? { toolUseResult } : {}),
  }),
};

/** A throwaway `~/.claude/projects` with helpers to write session and subagent transcripts. */
export function projectsFolder() {
  const projectsDir = mkdtempSync(join(tmpdir(), 'agentwatch-projects-'));

  const folder = (project: string) => {
    const dir = join(projectsDir, project);

    mkdirSync(dir, { recursive: true });

    return dir;
  };

  const lines = (records: readonly object[]) =>
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

  return {
    projectsDir,
    mainPath: (sessionId: string, project = 'proj') => join(folder(project), `${sessionId}.jsonl`),
    writeMain(sessionId: string, records: readonly object[], project = 'proj') {
      writeFileSync(join(folder(project), `${sessionId}.jsonl`), lines(records));
    },
    appendMain(sessionId: string, records: readonly object[], project = 'proj') {
      appendFileSync(join(folder(project), `${sessionId}.jsonl`), lines(records));
    },
    writeAgent(
      sessionId: string,
      agentId: string,
      meta: object,
      records: readonly object[],
      project = 'proj',
    ) {
      const dir = join(folder(project), sessionId, 'subagents');

      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `agent-${agentId}.jsonl`), lines(records));
      writeFileSync(join(dir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
    },
    appendAgent(sessionId: string, agentId: string, records: readonly object[], project = 'proj') {
      appendFileSync(
        join(folder(project), sessionId, 'subagents', `agent-${agentId}.jsonl`),
        lines(records),
      );
    },
    finishAgent(sessionId: string, agentId: string, meta: object, project = 'proj') {
      writeFileSync(
        join(folder(project), sessionId, 'subagents', `agent-${agentId}.meta.json`),
        JSON.stringify({ ...meta, finished: true }),
      );
    },
  };
}
