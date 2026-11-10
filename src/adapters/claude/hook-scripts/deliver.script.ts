import { findNode, type HookScriptInputs, hookCommand, quoted } from './shell.js';

/**
 * Hands waiting messages to the session's main agent. With no message waiting it ends after a
 * look at its own inbox folder, without starting Node.
 */
export function deliverScript(inputs: HookScriptInputs): string {
  return `#!/bin/sh
# agentwatch: hand the user's signed messages to this session's main agent.
# usage: deliver.sh [tool|turn-end]

sid=$CLAUDE_CODE_SESSION_ID

case $sid in
  '' | *[!A-Za-z0-9_-]*)
    cat >/dev/null
    exit 0
    ;;
esac

dir=${quoted(inputs.paths.inbox)}/"$sid"

# Marks, once, that this session runs agentwatch's hooks, so the viewer knows it can be messaged.
if [ ! -e "$dir/.hooks" ]; then
  { mkdir -p "$dir" && printf '' >"$dir/.hooks"; } 2>/dev/null
fi

mail=

for file in "$dir"/*.msg; do
  if [ -e "$file" ]; then
    mail=1
  fi

  break
done

if [ -z "$mail" ]; then
  cat >/dev/null
  exit 0
fi

# Mail is waiting. Only the main agent takes messages: a subagent's hook leaves it for later,
# without starting Node.
payload=$(cat)

case $payload in
  *'"agent_id":"'* | *'"agent_id": "'*)
    exit 0
    ;;
esac

# Settings written by an older version name no moment: the payload says which hook this is.
moment=$1

if [ -z "$moment" ]; then
  case $payload in
    *'"hook_event_name":"Stop"'* | *'"hook_event_name": "Stop"'*)
      moment=turn-end
      ;;
    *)
      moment=tool
      ;;
  esac
fi

${findNode(inputs)}

exec env ${hookCommand(inputs, 'deliver "$moment"')}
`;
}
