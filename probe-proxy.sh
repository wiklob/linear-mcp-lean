#!/usr/bin/env bash
# Deploy-time gate for the hosted-MCP proxy: assert the Linear Personal API Key
# authenticates against the HOSTED Linear MCP, so the proxy fallback
# (search_documentation, extract_images, get_diff, get_diff_threads, list_diffs)
# actually works. The proxy design rests on Linear's docs claiming the hosted
# MCP accepts a PAK bearer headlessly — this PROBES that claim instead of
# trusting it. Requires a real LINEAR_API_KEY; skips loudly without one (run at
# deploy with the env loaded).
set -euo pipefail

URL="https://mcp.linear.app/mcp"
if [ -z "${LINEAR_API_KEY:-}" ]; then
  echo "SKIP: LINEAR_API_KEY not set — run at deploy with the real key to verify the proxy-auth premise."
  exit 0
fi

INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"proxy-probe","version":"0"}}}'
resp=$(curl -s -w $'\n%{http_code}' -X POST "$URL" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $LINEAR_API_KEY" -d "$INIT")
code=$(printf '%s' "$resp" | tail -n1)
body=$(printf '%s' "$resp" | sed '$d')

echo "hosted Linear MCP initialize: HTTP $code (expect non-401/403)"
if [ "$code" = "401" ] || [ "$code" = "403" ]; then
  echo "FAIL: hosted Linear MCP rejected the PAK bearer — proxy fallback will not work. Body:"
  printf '%s\n' "$body" | head -c 400
  exit 1
fi
echo "PASS: hosted Linear MCP accepts the PAK bearer; proxy fallback viable."
exit 0
