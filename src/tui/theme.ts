import type { Style } from './paint.js';

/** SGR parameters. The terminal's own palette is used, so the view follows the user's theme. */
export const style = {
  plain: null,
  bold: '1',
  dim: '2',
  heading: '2;1',
  red: '31',
  alert: '31;1',
  green: '32',
  done: '32;2',
  yellow: '33',
  blue: '34',
  magenta: '35',
  message: '35;1',
  cyan: '36',
  key: '36;1',
  /** Code, inline or in a block: set apart from prose by colour alone. */
  code: '36',
} as const satisfies Record<string, Style>;

const AGENT_COLORS = ['36', '35', '33', '34', '32', '96', '95', '93', '94', '92'] as const;

/** A stable colour per agent, so its lines can be told apart at a glance. */
export function agentColor(agentId: string | null): string {
  if (agentId === null) {
    return style.bold;
  }

  let hash = 5381;

  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) + hash + agentId.charCodeAt(i)) >>> 0;
  }

  return AGENT_COLORS[hash % AGENT_COLORS.length] ?? style.cyan;
}

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

export const spinner = (frame: number): string => SPINNER[frame % SPINNER.length] ?? '⠋';
