#!/usr/bin/env bash
#
# Installs agentwatch from this clone:
#
#   1. builds it;
#   2. links the `agentwatch` command into ~/.local/bin;
#   3. adds its hooks to Claude Code (your settings are backed up first).
#
# Run it again after pulling a new version.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

readonly REPO_DIR
readonly BIN_DIR="${HOME}/.local/bin"
readonly COMMAND="${BIN_DIR}/agentwatch"
readonly NODE_MAJOR=22
readonly NODE_MINOR=15

# ---- output ----

step() {
  printf '\n==> %s\n' "$1"
}

note() {
  printf '    %s\n' "$1"
}

fail() {
  printf '\ninstall: %s\n' "$1" >&2
  exit 1
}

# Runs a command without its output, and shows that output only if the command fails.
quietly() {
  local log

  log="$(mktemp)"

  if ! "$@" >"${log}" 2>&1; then
    cat "${log}" >&2
    rm -f "${log}"
    fail "\`$*\` failed."
  fi

  rm -f "${log}"
}

# ---- steps ----

node_is_recent_enough() {
  node -e "
    const [major, minor] = process.versions.node.split('.').map(Number);
    const enough = major > ${NODE_MAJOR} || (major === ${NODE_MAJOR} && minor >= ${NODE_MINOR});

    process.exit(enough ? 0 : 1);
  "
}

check_requirements() {
  step 'Checking requirements'

  local needed="Node.js ${NODE_MAJOR}.${NODE_MINOR} or later"

  if ! command -v node >/dev/null; then
    fail "${needed} is needed, and no Node.js was found."
  fi

  if ! command -v npm >/dev/null; then
    fail 'npm is needed, and it was not found.'
  fi

  if ! node_is_recent_enough; then
    fail "${needed} is needed; this is $(node --version)."
  fi

  note "Node.js $(node --version)"

  if [[ "$(uname -s)" != 'Darwin' ]]; then
    note 'agentwatch has been tested on macOS only.'
  fi
}

build() {
  step 'Building'

  cd "${REPO_DIR}"
  quietly npm ci --no-audit --no-fund
  quietly npm run build

  note "${REPO_DIR}/dist"
}

link_command() {
  step 'Linking the agentwatch command'

  mkdir -p "${BIN_DIR}"
  ln -sf "${REPO_DIR}/bin/agentwatch.mjs" "${COMMAND}"

  note "${COMMAND}"

  if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
    note "${BIN_DIR} is not on your PATH. Add this line to your shell profile:"
    note "  export PATH=\"${BIN_DIR}:\$PATH\""
  fi
}

install_hooks() {
  step 'Adding the hooks to Claude Code'

  "${COMMAND}" hooks install
}

main() {
  check_requirements
  build
  link_command
  install_hooks

  step 'Done'
  note 'Start watching with: agentwatch'
}

main "$@"
