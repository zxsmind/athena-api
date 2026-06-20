#!/usr/bin/env bash
set -euo pipefail

# If running on Windows (Git Bash / MSYS), redirect to Node.js CLI
if [[ "$(uname -s)" =~ CYGWIN|MINGW|MSYS ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  exec node "$SCRIPT_DIR/deploy/cli.mjs" "$@"
fi

# Linux/macOS: use the full bash deploy system
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/deploy/deploy.sh" "$@"
