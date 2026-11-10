# Changelog

## 0.4.0

Restart agentwatch after upgrading.

**Added**

- A message box that grows as you write, with several lines.
- `tab` into the activity to select entries; `→` opens one in full.
- Trackpad and mouse wheel scrolling; clicks select.
- Text shown as written: Markdown, tables, code.
- `asked you`, for a session that stopped on a question.
- A History tab (`h`) with every past session on the machine.
- Replies that follow an agent's later answer.
- Locked sending with Touch ID (optional).
- `agentwatch send`, for agents.

**Changed**

- A draft is never cut; one over 4,000 characters is not sent until it fits.
- `ctrl-u` scrolls everywhere and no longer clears a draft.
- Claude Code's idle notice is no longer shown as a request.

**Fixed**

- A new session's first reply showed up to half a minute late.
- Scrolling far back in a long history was slow.

## 0.3.0

Rewritten in TypeScript.

- Activity is grouped by agent and wraps instead of being cut.
- Each message shows what the agent said next.
- A paste is one draft, and never the Enter key.
- Works down to 40 columns by 10 rows.
- Installing and uninstalling the hooks leave your other settings untouched.
