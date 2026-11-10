import { findNode, type HookScriptInputs, hookCommand, quoted } from './shell.js';

/**
 * Waits, while the session is idle, for a message to wake it with. It blocks in `read` on a
 * FIFO, so waiting costs no CPU.
 */
export function waitScript(inputs: HookScriptInputs): string {
  return `#!/bin/sh
# agentwatch: wake this session when the user sends it a message while it is idle.
#
# Runs as an async hook with asyncRewake on Stop and SessionStart: exit 2 wakes Claude and shows
# it stderr. While waiting it blocks on a FIFO and uses no CPU.
#
# Waiters never signal each other. The newest waiter records itself as the session's owner and
# writes a byte to the FIFO; an older one wakes, sees it is no longer the owner, passes the byte
# on and leaves.

cat >/dev/null

# Headless runs have nobody at a prompt to wake, and Claude Code waits up to 30 s at exit for
# asyncRewake hooks still running. They still get messages at tool calls and turn ends.
if [ "\${CLAUDE_CODE_SESSION_ATTENDED:-1}" = 0 ]; then
  exit 0
fi

sid=$CLAUDE_CODE_SESSION_ID

case $sid in
  '' | *[!A-Za-z0-9_-]*)
    exit 0
    ;;
esac

${findNode(inputs)}

inbox=${quoted(inputs.paths.inbox)}
dir="$inbox/$sid"
fifo="$dir/.wake"
me=$$
claude=$CLAUDE_PID

case $claude in
  *[!0-9]*)
    claude=
    ;;
esac

if ! { mkdir -p "$dir" && chmod 700 "$dir"; } 2>/dev/null; then
  exit 0
fi

# Anything else at that path is not ours to wait on.
if [ ! -p "$fifo" ]; then
  { rm -rf "$fifo"; mkfifo -m 600 "$fifo"; } 2>/dev/null
fi

if [ ! -p "$fifo" ]; then
  exit 0
fi

# This waiter is the session's newest.
owns() {
  owner=
  read -r owner <"$dir/.waiter" 2>/dev/null

  [ "$owner" = "$me" ]
}

# The Claude Code process this waiter was started by is still running.
alive() {
  if [ -z "$claude" ]; then
    return 0
  fi

  kill -0 "$claude" 2>/dev/null
}

# A Claude process can switch to another session (resume, clear): its newest waiter says which
# session it is on, and a waiter for a session it left is no longer needed.
current() {
  if [ -z "$claude" ]; then
    return 0
  fi

  now=
  read -r now <"$inbox/.process-$claude" 2>/dev/null

  [ "$now" = "$sid" ]
}

needed() {
  owns && alive && current
}

# Writes a byte to the FIFO. Opened read-write, which never blocks, even with no reader.
poke() {
  { printf '\\n'; } 1<>"$fifo"
} 2>/dev/null

# Take over: record this waiter as the owner, then wake the one it replaces.
if ! { printf '%s\\n' "$me" >"$dir/.waiter"; } 2>/dev/null; then
  exit 0
fi

if [ -n "$claude" ]; then
  { printf '%s\\n' "$sid" >"$inbox/.process-$claude"; } 2>/dev/null
fi

poke

# In case a wake byte goes astray: every 20 s, wake this waiter if it is no longer needed.
(
  while :; do
    sleep "\${AGENTWATCH_WATCHDOG_S:-20}"

    if ! kill -0 "$me" 2>/dev/null; then
      exit 0
    fi

    if [ ! -d "$dir" ]; then
      kill "$me" 2>/dev/null
      exit 0
    fi

    if ! needed; then
      poke
    fi
  done
) &

watchdog=$!

# On the way out: stop the watchdog, and forget the Claude process once it is gone.
# shellcheck disable=SC2329 # run by the EXIT trap
leave() {
  kill "$watchdog" 2>/dev/null

  if [ -n "$claude" ] && ! alive; then
    rm -f "$inbox/.process-$claude"
  fi
}

trap 'exit 0' TERM INT
trap leave EXIT

# File descriptor 3 is the FIFO, opened read-write, which never blocks, and before the inbox is
# checked, so a message sent in between still finds a reader.
listen() {
  while :; do
    if ! needed; then
      # The byte may have been meant for the session's current waiter: pass it on.
      printf '\\n' >&3

      return 0
    fi

    for file in "$dir"/*.msg; do
      if [ -e "$file" ]; then
        ${hookCommand(inputs, 'wake')} </dev/null 3>&-

        if [ $? -eq 2 ]; then
          return 2
        fi
      fi

      break
    done

    read -r _ <&3 || return 0
  done
}

listen 3<>"$fifo"

if [ $? -eq 2 ]; then
  exit 2
fi

exit 0
`;
}
