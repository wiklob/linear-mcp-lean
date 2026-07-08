# Deploy — linear-mcp-lean on a Linux VPS

Reproducible deploy of the wrapper to any small Linux box (tested on Ubuntu
24.04 — Hetzner, DigitalOcean, EC2, etc. all work). The wrapper binds
`127.0.0.1:8080`; Caddy terminates TLS and is the only public-facing process.

These files (`linear-mcp.service`, `Caddyfile`) are the source of truth; this
runbook documents the steps for install, redeploy, and rollback. Replace
`linear-mcp.example.com` with your domain throughout (including in the
`Caddyfile`).

## Topology

```
internet ──:443 (TLS)──▶ Caddy ──:8080 (localhost)──▶ node dist/index.js
                          (linear-mcp.example.com,           (linear-mcp.service)
                           auto Let's Encrypt cert)
```

## Prerequisites

- DNS: `A linear-mcp.example.com → <your server IP>` (DNS-only — no CDN proxy,
  or Caddy's ACME challenge fails).
- Inbound `:80` + `:443` open (`ufw allow 80,443/tcp`; also any cloud-level firewall).
- Node 20 LTS (NodeSource) and Caddy (official apt repo).

## Install (run as root on the box)

1. **Node 20 + Caddy** via their official apt repos.
2. **Build locally**: `npm ci && npm run build` on your machine.
3. **App** → `/opt/linear-mcp`: rsync `dist/`, `package.json`, `package-lock.json`
   (exclude `.env`, `src/`, `node_modules/`), then `npm ci --omit=dev` on the box.
4. **Service user**: `useradd --system --no-create-home --shell /usr/sbin/nologin linear-mcp`;
   `chown -R linear-mcp:linear-mcp /opt/linear-mcp`.
5. **Secrets** → `/etc/linear-mcp.env`, `chown root:root`, `chmod 600`:
   ```
   MCP_BEARER_TOKEN=<openssl rand -hex 32>
   LINEAR_API_KEY=<Linear Personal API Key — pasted by the operator, never committed>
   ```
   Generate the bearer with `openssl rand -hex 32`. The Linear key is added by the
   operator over their own SSH; it must never appear in the repo, a commit, or a chat.
6. **Unit**: copy `linear-mcp.service` → `/etc/systemd/system/`; `systemctl daemon-reload`;
   `systemctl enable --now linear-mcp`. The unit's `StateDirectory=linear-mcp` makes systemd
   provision `/var/lib/linear-mcp` (owned by `linear-mcp`, read-write even under
   `ProtectSystem=strict`) for the byte log (`BYTE_LOG_PATH=/var/lib/linear-mcp/byte-log.jsonl`).
   Without a writable path the append fails `EROFS` and is silently swallowed — `/stats` stays at `calls:0`.
7. **Caddy site**: copy `Caddyfile` → `/etc/caddy/Caddyfile` (edit the domain);
   `ufw allow 80,443/tcp`; `systemctl reload caddy`.

## Verify (observed, not asserted)

```bash
systemctl is-active linear-mcp                                   # active
curl -fsS https://linear-mcp.example.com/health                  # {"ok":true} — LIVENESS only (no Linear call)
# READINESS — proves the LINEAR_API_KEY actually reaches Linear (catches the placeholder-key
# misconfig /health cannot). Bearer-gated; expects {"ok":true,"linear":{"ok":true,"viewerId":…}}.
curl -fsS -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  https://linear-mcp.example.com/ready                           # 200 {linear.ok:true}; 503 {linear.ok:false,error} on a bad key
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://linear-mcp.example.com/mcp -d '{}'             # 401 (no bearer)
# PROVENANCE — which commit the running binary was built from. Bearer-gated (the SHA
# is deploy detail). .commit must equal `git rev-parse HEAD` of the tree you built.
curl -fsS -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  https://linear-mcp.example.com/version | jq -r '.commitShort, .dirty, .builtAt'  # e.g. a823fee / false / <ISO>
echo | openssl s_client -connect linear-mcp.example.com:443 2>/dev/null \
  | openssl x509 -noout -issuer                                  # issuer = Let's Encrypt
sudo systemctl kill -s SIGKILL linear-mcp; sleep 3; systemctl is-active linear-mcp  # active (restart-on-failure)

# Byte log — fire a real /mcp tools/call, then confirm the sink records it.
journalctl -u linear-mcp | grep byte-log                         # EMPTY — no "EROFS … byte-log.jsonl"
sudo ls -l /var/lib/linear-mcp/byte-log.jsonl                    # exists, owned by linear-mcp, grows per /mcp call
curl -fsS -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  https://linear-mcp.example.com/stats | jq '.totals.calls'     # non-zero after live traffic (not 0)

# Proxy-auth premise — asserts the hosted Linear MCP accepts your PAK as a bearer
# (the 5 proxied tools depend on it). Run with the real key in env.
npm run probe:proxy
```

Offline invariants (no box, no key — encoded proofs of the negatives):

```bash
npm run probe:secrets   # asserts no secret is tracked in the repo
npm run probe:auth      # asserts missing/invalid bearer -> 401
```

## Redeploy

Rebuild locally (`npm run build` — its `postbuild` stamps `dist/build-info.json`
with the current git SHA), rsync `dist/` again (the stamp ships inside it), then
`systemctl restart linear-mcp`. Re-run the `/health` + `/ready` curls, then
confirm the deploy actually advanced: `GET /version` `.commit` must equal
`git rev-parse HEAD` of the tree you just built (and `.dirty` should be `false`).

## Rollback

```bash
systemctl disable --now linear-mcp
rm /etc/systemd/system/linear-mcp.service && systemctl daemon-reload
# remove the Caddy site block from /etc/caddy/Caddyfile, then: systemctl reload caddy
# (optional) rm -rf /opt/linear-mcp /etc/linear-mcp.env
```
