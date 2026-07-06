#!/usr/bin/env bash
# Encoded proof that no secret is tracked in the repo:
#   1. no .env file (any depth) is tracked by git — only .env.example is allowed;
#   2. no tracked file contains a Linear Personal API Key (they start "lin_api_");
#   3. no tracked file assigns a literal value to MCP_BEARER_TOKEN / LINEAR_API_KEY
#      (placeholders like <...>, ${...}, $VAR, or empty are fine).
# Runs offline against the git index — no box, no key needed.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "SKIP: not a git repository — nothing is tracked yet."
  exit 0
fi

fail=0

# 1. tracked .env files (allow .env.example)
envs=$(git ls-files | grep -E '(^|/)\.env(\..+)?$' | grep -v -E '\.env\.example$' || true)
if [ -n "$envs" ]; then
  echo "FAIL: .env file(s) tracked by git:"
  printf '%s\n' "$envs" | sed 's/^/  - /'
  fail=1
else
  echo "ok: no .env tracked (only .env.example allowed)"
fi

# 2. Linear PAK material in any tracked file
paks=$(git grep -l "lin_api_" -- . 2>/dev/null | grep -v 'deploy/probe-secrets.sh' || true)
if [ -n "$paks" ]; then
  echo "FAIL: tracked file(s) contain Linear API key material (lin_api_…):"
  printf '%s\n' "$paks" | sed 's/^/  - /'
  fail=1
else
  echo "ok: no Linear API key material in tracked files"
fi

# 3. literal secret assignments (VAR=<literal> where the literal is not a
#    placeholder). Matches shell/env-style assignments in tracked files.
literals=$(git grep -nE '(MCP_BEARER_TOKEN|LINEAR_API_KEY)=[A-Za-z0-9]' -- . 2>/dev/null \
  | grep -v -E '=\$|=<|=\{|dummy|probe-secret|openssl rand' || true)
if [ -n "$literals" ]; then
  echo "FAIL: literal-looking secret assignment(s) in tracked files:"
  printf '%s\n' "$literals" | sed 's/^/  - /'
  fail=1
else
  echo "ok: no literal secret assignments in tracked files"
fi

[ "$fail" = "0" ] && echo "PASS: no secret is tracked in the repo."
exit "$fail"
