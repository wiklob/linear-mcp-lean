#!/usr/bin/env bash
# Coverage proof: every tool this server promises (the expected list below —
# the hosted Linear MCP surface plus the linear_graphql escape hatch) is
# actually served via tools/list — a real GraphQL impl OR a hosted-MCP proxy
# passthrough — never silently missing. tools/list makes NO Linear call, so a
# real LINEAR_API_KEY is not needed (a dummy is fine; the proof is key-free).
set -euo pipefail
cd "$(dirname "$0")"

[ -f dist/index.js ] || { echo "FAIL: dist/index.js missing — run 'npm run build' first"; exit 2; }

# A free port per run: two worktrees gating at once on a fixed port would probe
# each other's server (same default token) and judge the wrong build.
PORT="${PORT:-$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')}"
export PORT
export MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-probe-secret}"
export LINEAR_API_KEY="${LINEAR_API_KEY:-dummy-not-used-by-tools-list}"

node dist/index.js >/dev/null 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT
up=0
for _ in $(seq 1 50); do
  kill -0 "$SRV" 2>/dev/null || { echo "FAIL: server exited on startup (port $PORT taken?)"; exit 2; }
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && { up=1; break; }
  sleep 0.1
done
[ "$up" = 1 ] || { echo "FAIL: server never answered /health on port $PORT"; exit 2; }

listing=$(curl -s -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | sed -n 's/^data: //p')
served=$(printf '%s' "$listing" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("\n".join(sorted(t["name"] for t in d["result"]["tools"])))')

# The promised surface: every tool name the hosted Linear MCP serves that this
# server covers (impl or proxy), plus the linear_graphql escape hatch.
# sort -u: two branches adding the same name merge cleanly into a duplicate,
# which comm would then report as "NOT served".
expected=$(sort -u <<'EOF'
create_attachment
create_attachment_from_upload
create_issue_label
create_issue_relation
delete_git_automation_state
delete_issue_relation
delete_milestone
extract_images
get_attachment
get_diff
get_diff_threads
get_document
get_initiative
get_issue
get_issue_status
get_milestone
get_project
get_status_updates
get_team
get_user
linear_graphql
list_comments
list_cycles
list_diffs
list_documents
list_git_automation_states
list_issue_labels
list_issue_statuses
list_issue_relations
list_issues
list_milestones
list_project_labels
list_projects
list_teams
list_users
prepare_attachment_upload
save_comment
save_document
save_initiative
save_issue
save_milestone
save_project
save_status_update
search_documentation
EOF
)

echo "expected: $(printf '%s\n' "$expected" | grep -c .)   served by wrapper: $(printf '%s\n' "$served" | grep -c .)"

missing=$(comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$served") || true)
if [ -n "$missing" ]; then
  echo "FAIL: expected tool names NOT served (would resolve to silent missing):"
  printf '%s\n' "$missing" | sed 's/^/  - /'
  exit 1
fi
echo "PASS: every expected tool name is served by the wrapper (impl or proxy)."

# Typed args callers rely on instead of raw linear_graphql (tool.arg). A dropped
# arg would push callers back to the escape hatch, so it fails here.
missing_args=$(printf '%s' "$listing" | python3 -c '
import sys, json
want = ["list_issues.milestone", "list_issues.team", "list_issues.includeCompleted", "list_issues.query",
        "linear_graphql.op", "linear_graphql.allowMutation"]
tools = {t["name"]: t.get("inputSchema", {}).get("properties", {}) for t in json.load(sys.stdin)["result"]["tools"]}
print("\n".join(w for w in want if w.split(".")[1] not in tools.get(w.split(".")[0], {})))')
if [ -n "$missing_args" ]; then
  echo "FAIL: expected tool args NOT advertised:"
  printf '%s\n' "$missing_args" | sed 's/^/  - /'
  exit 1
fi
echo "PASS: typed args advertised (list_issues milestone/team/includeCompleted/query; linear_graphql op/allowMutation)."

extra=$(comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$served") || true)
[ -n "$extra" ] && { echo "note: served beyond the expected list (update the list here):"; printf '%s\n' "$extra" | sed 's/^/  + /'; }
exit 0
