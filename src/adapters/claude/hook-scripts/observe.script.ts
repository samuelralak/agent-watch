import type { StatePaths } from '../../fs/state-paths.js';
import { quoted } from './shell.js';

/**
 * Records one hook event, and only while a viewer is open. It starts no process to find that
 * out, so with nobody watching a hook costs two shell builtins.
 */
export function observeScript(paths: StatePaths): string {
  return `#!/bin/sh
# agentwatch: record one hook event while an agentwatch viewer is open.
#
# With no viewer open it writes nothing: a viewer reads history from the transcripts when it
# starts. Each payload goes to its own file, renamed into place, so readers never see half of one.

lock=${quoted(paths.ingestLock)}
events=${quoted(paths.events)}

# Nothing to record. The payload is still read, so Claude Code never writes to a closed pipe.
skip() {
  cat >/dev/null
  exit 0
}

# The lock holds the pid of the viewer that collects events.
pid=

if [ -r "$lock" ]; then
  read -r pid <"$lock"
fi

case $pid in
  '' | *[!0-9]*)
    skip
    ;;
esac

if ! kill -0 "$pid" 2>/dev/null; then
  skip
fi

file=$(mktemp "$events/.tmp/ev.XXXXXXXXXX" 2>/dev/null) || skip

if cat >"$file"; then
  mv -f "$file" "$events/\${file##*/}.json" 2>/dev/null || rm -f "$file"
else
  rm -f "$file"
fi

exit 0
`;
}
