# How it works

## Goals

1. Show what Claude Code's subagents are doing, live.
2. Hide nothing: the point is visibility.
3. Let you message the main agent while looking at a subagent.

## Overview

```
 Claude Code session
   hook event ──> observe.sh ──> events/            (only while a view is open)
              ──> deliver.sh ──> hands waiting messages to the main agent
              ──> wait.sh    ──> sleeps while idle; wakes the session for a message

 agentwatch
   events/ ──> spool ──┐
   transcripts ────────┼──> Store ──> view, --stream, --json, --once
   claude agents ──────┘
   message box ──> signs ──> inbox/<session>/ ──> read by that session's hooks
```

- **Hooks** report what happens as it happens. They are installed once, in your settings.
- **Transcripts** give the history when a view opens, and what hooks do not carry.
- **`claude agents --json`** says which sessions run and whether they are busy.
- **The store** keeps the state of every session. The view only draws it.
- **History** lists past sessions from their transcripts, and reads one when it is selected.

## Hooks

Three POSIX shell scripts. They never fail a session, and start Node only when a message is
waiting.

| Script | Runs on | Does |
| --- | --- | --- |
| `observe.sh` | every event | writes the event to a file, in 3 to 7 ms; does nothing while no view is open |
| `deliver.sh` | after a tool call, at a turn end | gives waiting messages to the main agent |
| `wait.sh` | while the session is idle | blocks on a FIFO, and wakes the session when a message arrives |

## Decisions worth knowing

- **Documented interfaces first.** Hooks carry everything that matters. Transcripts are
  Claude Code's own format, read tolerantly, and a version that was not checked gets a warning.
- **One view collects.** The view holding a lock file turns event files into a small log per
  session; another view takes over within a second if it exits.
- **History, then live.** A session's first hook event marks where hooks take over from the
  transcript, so nothing is shown twice.
- **Pause or finish.** A subagent's stop event fires on every pause. It counts as finished
  only when none of the background work it started is still running.
- **Asked, not done.** Claude Code calls a session idle whether it finished or stopped on a
  question. The agent's last lines tell the two apart.
- **A reply spans turns.** What the agent says after a message is followed while work it
  started since the message is still running.
- **Text is untrusted.** Control sequences are stripped where text is painted.
- **Nothing is cut silently.** Text wraps, a cut is marked, and a draft is never trimmed.
- **Rows are laid out once.** A finished entry keeps its rows, so long histories stay fast.
- **Bounded memory.** 5,000 entries in all, 400 per agent.

Messages and signing are covered in [security.md](security.md).

## Code

```
src/
  domain/        state and rules, no I/O
  application/   use cases, and the ports they need
  adapters/      Claude Code (hooks, transcripts), files, signing, the lock
  tui/           the view
  cli/           commands
  hook/          what a session's hooks run
native/          the Touch ID signing helper (Swift)
```

Imports go one way: `domain` ← `application` ← `adapters` ← `tui`, `cli`, `hook`.

## Checked against Claude Code

| Fact | Result |
| --- | --- |
| Hooks installed globally reach running sessions | yes, without a restart |
| A hook exiting 2 from an idle wait wakes the session | yes; a model may decline the message |
| `SubagentStop` fires on a pause | yes, with the list of running background tasks |
| A denied tool call | PreToolUse, PermissionRequest, then nothing |
| A subagent's report | may come through a tool call, with no last message |
| Headless runs, and `claude --init-only` | not delayed by the idle wait |
