# Usage

Run `agentwatch` in any terminal. Open and close it whenever you like: it does not affect
your sessions.

## The view

- **List** (left): sessions, each followed by its subagents. `h` switches it between the
  running sessions (Live) and the ones that are over (History).
- **Activity** (right): what the selected session or agent has done, newest at the bottom.
- **Message box** (bottom): who a message goes to, and what became of the last one.

## Which sessions appear

Every Claude Code session running on this machine: in a terminal, headless, started from the
Claude desktop app, or from an editor extension. Sessions that run elsewhere, such as on
claude.ai/code, do not.

## Session states

| State | Meaning |
| --- | --- |
| `busy` | working |
| `idle` | finished its turn |
| `needs you` | blocked on a prompt, such as a permission request. Answer in its terminal. |
| `asked you` | idle, and its last words ask you something |

`asked you` is a guess from the agent's last lines (a question mark, or phrases like "let me
know which"). Every idle session shows its closing line, so you can always check.

## Keys

| Where | Key | Does |
| --- | --- | --- |
| Anywhere | `⏎` | write a message |
| | `ctrl-u` `ctrl-d` | scroll the activity half a pane |
| | `esc` | close, and return to the newest activity |
| | `t` | read the selected agent's task |
| | `d` | show or hide finished agents |
| | `p` | pause |
| | `?` `q` | help, quit |
| List | `↑` `↓` | select a session or an agent |
| | `h` | Live or History |
| | `tab` `→` | move into the activity |
| Activity | `↑` `↓` | select an entry |
| | `→` `o` | open it in full |
| | `←` `tab` | back |
| | `g` `G` | oldest, newest |
| Writing | `⏎` | send |
| | `alt-⏎` | new line |
| | `esc` | close; the draft is kept |

## Reading the activity

- Text is shown as written: line breaks, indentation, Markdown, tables and code.
- Scrolling back or selecting holds the view. New entries wait until you press `esc`.
- Opening a tool call shows everything it was given and everything it returned.

## History

`h` lists every past session Claude Code has a record of on this machine, newest first, with
where it ran and how it ended. Select one to read what it did. A past session cannot be
messaged.

## Sending a message

1. Select a session or one of its agents and press `⏎`.
2. Write. The box grows up to six rows; `alt-⏎` starts a new line.
3. Press `⏎` to send.

The bottom of the box says when the message will arrive, then what became of it and what the
agent replied. A message holds 4,000 characters; a longer draft is kept whole and is not
sent until it fits.

## Mouse

A trackpad or wheel scrolls the pane under the pointer. A click selects; a second click opens
an entry. To select text, hold Option (iTerm2), Fn (Terminal) or Shift (most others), or
start with `--no-mouse`.

## Without the view

| Command | Prints |
| --- | --- |
| `agentwatch --stream` | activity as it happens |
| `agentwatch --json` | the same, as JSON lines |
| `agentwatch --once` | the list of sessions and agents |

`agentwatch --help` lists every command and option.
