#!/usr/bin/env bash
# Encoded proof that byte-log write-health is visible on GET /stats, so a DEAD
# sink is distinguishable from a legitimately-IDLE one. Three scenarios, each on
# a fresh server:
#   (A) unwritable BYTE_LOG_PATH *dir*, ZERO /mcp traffic -> writable:false + non-null lastError
#         — boot-time fs.access(W_OK) seeding catches a never-yet-called dead sink.
#   (B) writable dir but unwritable target *file*: at boot writable:true (dir is fine),
#         then ONE tool call flips it to writable:false + non-null lastError
#         — proves the WRITER (appendByteLog) records the failed write, distinct from boot.
#   (C) fully writable BYTE_LOG_PATH, ZERO /mcp traffic   -> writable:true + totals.calls:0
#         — an idle-but-healthy sink, the thing a dead one would otherwise be indistinguishable from.
# A tools/call with a dummy key fails upstream, but runInstrumented's catch still
# calls appendByteLog, so the failing write is reached — no real LINEAR_API_KEY needed.
set -euo pipefail
cd "$(dirname "$0")"

[ -f dist/index.js ] || { echo "FAIL: dist/index.js missing — run 'npm run build' first"; exit 2; }

# chmod 555 is bypassed by root, which would silently pass the unwritable-dir arms.
if [ "$(id -u)" = "0" ]; then
  echo "FAIL: running as root — chmod 555 does not block root writes, so the dead-sink arms would falsely pass. Run as a non-root user."
  exit 2
fi

export MCP_BEARER_TOKEN="${MCP_BEARER_TOKEN:-probe-secret}"
export LINEAR_API_KEY="${LINEAR_API_KEY:-dummy-not-used-by-this-probe}"

TMP="$(mktemp -d)"
SRV=""
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null || true; chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

DEAD_DIR="$TMP/dead"          # unwritable dir → boot probe + writes both fail
LIVE_DIR="$TMP/live"          # fully writable → healthy
BADFILE_DIR="$TMP/badfile"    # writable dir, but the target file is unwritable
mkdir -p "$DEAD_DIR" "$LIVE_DIR" "$BADFILE_DIR"
chmod 555 "$DEAD_DIR"         # read+execute, no write → appendFile + fs.access(W_OK) both fail
: > "$BADFILE_DIR/byte-log.jsonl"
chmod 000 "$BADFILE_DIR/byte-log.jsonl"   # dir writable (boot probe passes), file write denied

start_server() {  # <port> <byte_log_path>
  PORT="$1" BYTE_LOG_PATH="$2" node dist/index.js >/dev/null 2>&1 &
  SRV=$!
  for _ in $(seq 1 50); do
    curl -fsS "http://127.0.0.1:$1/health" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  echo "FAIL: server on :$1 did not become healthy"; exit 1
}
stop_server() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null || true; SRV=""; sleep 0.2; }
get_stats() {  # <port>
  curl -s "http://127.0.0.1:$1/stats" -H "Authorization: Bearer $MCP_BEARER_TOKEN"
}
fire_tool_call() {  # <port> — one tools/call; fails on the dummy key but still records
  curl -s -X POST "http://127.0.0.1:$1/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_teams","arguments":{}}}' >/dev/null 2>&1 || true
  sleep 0.2  # let the awaited appendByteLog catch-path settle
}

# assert_stats <label> <json> <expect: dead-zero|dead-call|live-zero>
assert_stats() {
  printf '%s' "$2" | python3 -c '
import sys, json
label, mode = sys.argv[1], sys.argv[2]
raw = sys.stdin.read()
d = json.loads(raw)
ctx = label + " stats=" + raw
bl = d.get("byteLog")
assert bl is not None, label + ": /stats carries no byteLog block"
writable, last_error, path = bl["writable"], bl["lastError"], bl["path"]
calls = d["totals"]["calls"]
assert path, label + ": byteLog.path empty"
assert writable == (last_error is None), label + ": writable != (lastError is None) -> " + ctx
if mode == "dead":
    assert writable is False, label + ": expected writable:false on a dead sink -> " + ctx
    assert last_error is not None, label + ": expected non-null lastError on a dead sink -> " + ctx
if mode == "healthy":
    assert writable is True, label + ": expected writable:true (dir writable) -> " + ctx
    assert last_error is None, label + ": expected null lastError -> " + ctx
if mode == "idle":
    assert writable is True, label + ": expected writable:true on a healthy idle sink -> " + ctx
    assert last_error is None, label + ": expected null lastError on a healthy sink -> " + ctx
    assert calls == 0, label + ": expected totals.calls:0 on an idle sink -> " + ctx
print("  PASS " + label + ": writable=" + str(writable) + " lastError=" + str(last_error is not None) + " calls=" + str(calls))
' "$1" "$3"
}

echo "byte-log write-health probe"

# (A) dead dir, zero traffic — boot-time seeding must already report writable:false
start_server 8771 "$DEAD_DIR/byte-log.jsonl"
assert_stats "A dead-dir+zero-traffic (boot seeding)" "$(get_stats 8771)" dead
stop_server

# (B) writable dir + unwritable file — boot says writable:true, the tool-call write flips it false
start_server 8772 "$BADFILE_DIR/byte-log.jsonl"
assert_stats "B writable-dir+badfile, pre-call (boot passes)" "$(get_stats 8772)" healthy
fire_tool_call 8772
assert_stats "B writable-dir+badfile, post-call (writer seeding)" "$(get_stats 8772)" dead
stop_server

# (C) fully writable sink, zero traffic — healthy idle, distinguishable from the dead arms
start_server 8773 "$LIVE_DIR/byte-log.jsonl"
assert_stats "C live+zero-traffic (idle healthy)" "$(get_stats 8773)" idle
stop_server

echo "PASS: dead-vs-idle is distinguishable on /stats (boot + writer write-health)."
