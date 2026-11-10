/** The tool a subagent calls to hand its report to whoever started it. */
export const HANDBACK_TOOL = 'SubagentHandback';

/** Whether a call to this tool starts a subagent. */
export const isSpawnTool = (name: string | undefined): boolean =>
  name === 'Agent' || name === 'Task';

/** `mcp__server__tool` as `server:tool`; other names as they are. */
export function toolDisplayName(name: string | undefined): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name ?? '');

  return match ? `${match[1]}:${match[2]}` : name || 'tool';
}
