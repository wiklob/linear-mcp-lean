#!/usr/bin/env bash
# Prod is healthy and running this tree: unit active, /health ok, and the deployed
# build-info commit equals HEAD (the bearer-free stand-in for GET /version).
# --live skips the commit check (land's deployHealth: main may hold commits no deploy covers).
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${LINEAR_MCP_HOST:-root@178.104.140.96}"
URL="${LINEAR_MCP_URL:-https://linear-mcp.wiklob.dev}"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  ssh "$HOST" systemctl is-active --quiet linear-mcp && curl -fsS -o /dev/null "$URL/health" && break
  sleep 2
done
ssh "$HOST" systemctl is-active --quiet linear-mcp || { echo "check-deploy: linear-mcp unit not active" >&2; exit 1; }
curl -fsS -o /dev/null "$URL/health" || { echo "check-deploy: $URL/health failed" >&2; exit 1; }

[ "${1:-}" = --live ] && { echo "check-deploy: live"; exit 0; }

deployed="$(ssh "$HOST" "node -p 'require(\"/opt/linear-mcp/dist/build-info.json\").commit'")"
head="$(git rev-parse HEAD)"
[ "$deployed" = "$head" ] || { echo "check-deploy: deployed $deployed, HEAD $head" >&2; exit 1; }
echo "check-deploy: ok ($head)"
