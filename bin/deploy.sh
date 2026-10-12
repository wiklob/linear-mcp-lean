#!/usr/bin/env bash
#
# Deploy the wrapper to the VPS — the scripted form of deploy/README.md's
# "Redeploy" steps, run by `land` after a merge (LEAN-15).
#
# Builds here (the box has no git checkout: `postbuild` stamps the commit into
# dist/build-info.json, which is how `--check` and GET /version tell what runs),
# rsyncs dist/ with --delete so the box holds exactly one commit, installs prod
# deps only when the lockfile changed, restarts the unit and waits for /health.
#
# Usage:
#   bin/deploy.sh                    # deploy HEAD (clean tree on main)
#   bin/deploy.sh --check            # exit 0 iff the box runs HEAD and the unit is active
#   bin/deploy.sh --check-infra      # exit 0 iff the box's unit + Caddyfile match deploy/ (LEAN-9)
#   bin/deploy.sh --allow-dirty --allow-branch   # escape hatches, loud
#
# The target lives in the operator's .envrc, not here (the repo is public):
#   export LINEAR_MCP_DEPLOY_HOST=root@<your box>
#
set -euo pipefail

HOST="${LINEAR_MCP_DEPLOY_HOST:-}"
[[ -n "$HOST" ]] || { echo "deploy: LINEAR_MCP_DEPLOY_HOST is unset — add 'export LINEAR_MCP_DEPLOY_HOST=root@<box>' to .envrc" >&2; exit 2; }
REMOTE_DIR="/opt/linear-mcp"
SERVICE="linear-mcp"
# Same reasoning as cbapp's deploy scripts: walking every key in the agent trips
# MaxAuthTries and the sshd jail; BatchMode fails loudly instead of prompting.
SSH_KEY="${LINEAR_MCP_SSH_KEY:-$HOME/.ssh/id_ed25519}"
SSH_OPTS=(-o BatchMode=yes)
[[ -f "$SSH_KEY" ]] && SSH_OPTS+=(-o IdentitiesOnly=yes -i "$SSH_KEY")

ALLOW_DIRTY=0
ALLOW_BRANCH=0
CHECK_ONLY=0
CHECK_INFRA=0
for arg in "$@"; do
  case "$arg" in
    --check)        CHECK_ONLY=1 ;;
    --check-infra)  CHECK_INFRA=1 ;;
    --allow-dirty)  ALLOW_DIRTY=1 ;;
    --allow-branch) ALLOW_BRANCH=1 ;;
    *) echo "deploy: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
head="$(git rev-parse HEAD)"
remote() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

# deploy/'s unit and Caddyfile are shipped by hand (deploy/README.md), so land can't
# deploy them — but it runs this on every merge touching them, and a box that differs
# fails the land loudly instead of sitting silently stale. The unit is read with
# `systemctl cat` (so drop-ins count) and a pending daemon-reload is drift too.
# Comments, blank lines, Documentation= and a bare-hostname Caddy site address (the
# repo has a placeholder) don't count. Caddy's loaded config isn't checked: after
# shipping the Caddyfile, `systemctl reload caddy` is on the operator.
if [[ $CHECK_INFRA = 1 ]]; then
  [[ $CHECK_ONLY = 0 ]] || { echo "deploy: --check and --check-infra are separate runs" >&2; exit 2; }
  unit_norm() { sed -e '/^[[:space:]]*[#;]/d' -e '/^[[:space:]]*$/d' -e '/^Documentation=/d'; }
  caddy_norm() { sed -E -e 's/(^|[[:space:]])#.*$//' -e '/^[[:space:]]*$/d' -e 's/^[A-Za-z0-9.-]+ \{$/<site> {/'; }
  drift=0
  check() {  # <label> <normalizer> <repo file> <remote command>
    local box
    box="$(remote "$4")" || { echo "deploy: cannot read $1 on the box" >&2; exit 1; }
    if ! diff <(printf '%s\n' "$box" | "$2") <("$2" < "$3") >&2; then
      echo "deploy: $1 on the box differs from $3 (above: < box, > repo)" >&2
      drift=1
    fi
  }
  check "unit $SERVICE" unit_norm deploy/linear-mcp.service "systemctl cat $SERVICE"
  check /etc/caddy/Caddyfile caddy_norm deploy/Caddyfile "cat /etc/caddy/Caddyfile"
  if [[ "$(remote "systemctl show -p NeedDaemonReload --value $SERVICE")" != no ]]; then
    echo "deploy: $SERVICE unit changed on disk but systemd hasn't reloaded it — daemon-reload + restart" >&2
    drift=1
  fi
  if [[ $drift = 1 ]]; then
    echo "deploy: ship deploy/ by hand per deploy/README.md (Install steps 6–7), then re-run this check" >&2
    exit 1
  fi
  echo "deploy: box unit + Caddyfile match deploy/"
  exit 0
fi

running="$(remote "sed -n 's/^ *\"commit\": \"\\([0-9a-f]*\\)\".*/\\1/p' $REMOTE_DIR/dist/build-info.json" 2>/dev/null || true)"
if [[ $CHECK_ONLY = 1 ]]; then
  remote "systemctl is-active --quiet $SERVICE" || { echo "deploy: $SERVICE is not active" >&2; exit 1; }
  [[ "$running" = "$head" ]] || { echo "deploy: box runs ${running:-unknown}, HEAD is $head" >&2; exit 1; }
  echo "deploy: box runs $head"
  exit 0
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  [[ $ALLOW_DIRTY = 1 ]] || { echo "deploy: tree is dirty — commit first (or --allow-dirty)" >&2; exit 1; }
  echo "deploy: WARNING deploying a dirty tree" >&2
fi
if [[ "$(git branch --show-current)" != main ]]; then
  [[ $ALLOW_BRANCH = 1 ]] || { echo "deploy: not on main — merge first (or --allow-branch)" >&2; exit 1; }
  echo "deploy: WARNING deploying a non-main branch" >&2
fi

npm ci --no-audit --no-fund --loglevel=error
npm run build --silent

lock_changed=1
remote "cmp -s - $REMOTE_DIR/package-lock.json" < package-lock.json && lock_changed=0

rsync -az --delete -e "ssh ${SSH_OPTS[*]}" dist/ "$HOST:$REMOTE_DIR/dist/"
rsync -az -e "ssh ${SSH_OPTS[*]}" package.json package-lock.json "$HOST:$REMOTE_DIR/"
if [[ $lock_changed = 1 ]]; then
  remote "cd $REMOTE_DIR && npm ci --omit=dev --no-audit --no-fund --loglevel=error"
fi
remote "chown -R $SERVICE:$SERVICE $REMOTE_DIR && systemctl restart $SERVICE"

for _ in $(seq 1 20); do
  if remote "curl -fsS -o /dev/null http://127.0.0.1:8080/health"; then
    echo "deploy: ${running:0:7} → ${head:0:7} live"
    exit 0
  fi
  sleep 1
done
echo "deploy: $SERVICE did not answer /health after restart" >&2
remote "journalctl -u $SERVICE -n 20 --no-pager" >&2 || true
exit 1
