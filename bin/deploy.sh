#!/usr/bin/env bash
# Redeploy the server to the shared box (deploy/README.md "Redeploy"), run by `land` after merge.
# Builds locally so dist/build-info.json carries this tree's commit, ships dist/ + package files,
# reinstalls prod deps only when the lockfile changed, restarts the unit. Secrets never move.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${LINEAR_MCP_HOST:-root@178.104.140.96}"
APP=/opt/linear-mcp

npm ci
npm run build

lock_changed=1
if ssh "$HOST" "cat $APP/package-lock.json" 2>/dev/null | cmp -s - package-lock.json; then
  lock_changed=0
fi

rsync -a --delete dist/ "$HOST:$APP/dist/"
rsync -a package.json package-lock.json "$HOST:$APP/"
if [ "$lock_changed" = 1 ]; then
  ssh "$HOST" "cd $APP && npm ci --omit=dev"
fi
ssh "$HOST" "chown -R linear-mcp:linear-mcp $APP && systemctl restart linear-mcp"

bin/check-deploy.sh
