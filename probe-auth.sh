#!/usr/bin/env bash
# Encoded proof of the inbound-auth invariant:
#   missing/invalid inbound bearer token -> 401, valid token -> NOT 401.
# Tests ONLY the inbound gate, so no real Linear API key is needed (a dummy
# LINEAR_API_KEY is fine — the gate rejects before any tool/Linear call).
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8765}"
export PORT
export MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-probe-secret}"
export LINEAR_API_KEY="${LINEAR_API_KEY:-dummy-key-not-used-by-the-gate}"

[ -f dist/index.js ] || { echo "FAIL: dist/index.js missing — run 'npm run build' first"; exit 2; }

node dist/index.js &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT

# Wait for the server to accept connections.
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.1
done

post() { curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp" "$@"; }

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

code_none=$(post -H 'Content-Type: application/json' -d '{}')
code_bad=$(post -H 'Content-Type: application/json' -H 'Authorization: Bearer wrong-token' -d '{}')
code_ok=$(post -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" -d "$INIT")

echo "no-token:    $code_none (expect 401)"
echo "bad-token:   $code_bad (expect 401)"
echo "valid-token: $code_ok (expect non-401)"

fail=0
[ "$code_none" = "401" ] || { echo "FAIL: missing token did not 401"; fail=1; }
[ "$code_bad" = "401" ] || { echo "FAIL: bad token did not 401"; fail=1; }
[ "$code_ok" != "401" ] || { echo "FAIL: valid token was rejected"; fail=1; }

[ "$fail" = "0" ] && echo "PASS: inbound bearer gate denies missing/invalid tokens"
exit "$fail"
