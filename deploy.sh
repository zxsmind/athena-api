#!/usr/bin/env bash
set -euo pipefail

SERVER="${1:?Usage: ./deploy.sh <user@host> [remote-path]}"
REMOTE_DIR="${2:-/opt/athena}"

# Check uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  Uncommitted changes. Commit and push first:"
  echo "   git add -A && git commit -m '...' && git push"
  exit 1
fi

echo "→ Pushing to git..."
git push

echo "→ Updating server on $SERVER..."
ssh "$SERVER" "cd '$REMOTE_DIR' && git pull && cd server && npm install && npm run build && (pm2 restart athena 2>/dev/null || systemctl restart athena 2>/dev/null || sudo systemctl restart athena 2>/dev/null || echo '⚠️  Restart server manually')"

echo "✓ Deployed!"
