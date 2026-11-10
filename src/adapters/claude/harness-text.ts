// Text Claude Code itself writes around what agents and tools say: wrappers in tool output, and
// frames around notices and reports that it hands to an agent as if they were prompts.

const WRAPPERS =
  /<system-reminder>[\s\S]*?<\/system-reminder>|<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>|<\/?persisted-output>/g;

/**
 * What an editor extension or the desktop app sends along with a prompt: the file that is
 * open, what is selected, how to use the browser. It is context for the agent, not something
 * the user typed.
 */
const ATTACHED_CONTEXT =
  /<(ide_opened_file|ide_selection|ide_diagnostics|browser_instruction)>[\s\S]*?<\/\1>/g;

/** `text` without what Claude Code and its front ends put around tool output and prompts. */
export const stripHarnessText = (text: string): string =>
  text.replace(WRAPPERS, '').replace(ATTACHED_CONTEXT, '');

/** A notice about background work. Nobody typed it. */
export const TASK_NOTIFICATION = /^\s*<task-notification>/;

/**
 * A subagent's report, handed to its spawner inside a frame that says it is not from the user.
 * The report itself is shown with the agent that wrote it.
 */
export const AGENT_REPORT = /^\s*(?:Another Claude session sent a message:\s*)?<agent-message\b/;
export const AGENT_REPORT_NOTICE = "received a subagent's report";

/** What Claude Code writes where the user pressed Esc or turned a tool call down. */
export const INTERRUPTED = /^\s*\[Request interrupted by user/;

/** The body of a skill that was loaded: instructions, not a message. */
export const SKILL_BODY = /^\s*Base directory for this skill:/;

/** The text inside `<tag>…</tag>`, or an empty string. */
export const tagText = (text: string, tag: string): string =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim() ?? '';
