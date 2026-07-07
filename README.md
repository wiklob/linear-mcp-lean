# linear-mcp-lean

[![CI](https://github.com/wiklob/linear-mcp-lean/actions/workflows/ci.yml/badge.svg)](https://github.com/wiklob/linear-mcp-lean/actions/workflows/ci.yml)
[![savings re-measured weekly](https://github.com/wiklob/linear-mcp-lean/actions/workflows/probe-vs-hosted.yml/badge.svg)](https://github.com/wiklob/linear-mcp-lean/actions/workflows/probe-vs-hosted.yml)

A self-hosted [MCP](https://modelcontextprotocol.io) server for [Linear](https://linear.app) that **controls the response shape**: field-selected, flattened reads and minimal write acks instead of the fat full-object payloads the hosted Linear MCP returns. Run it locally over stdio (`npx linear-mcp-lean`) or as a shared HTTP deploy.

Built for LLM agents (Claude Code, or any MCP client) that call Linear tools hundreds of times per session: every byte a tool returns is a token your model pays to read. This wrapper serves the same tool names as the hosted Linear MCP, so it's a drop-in replacement — but a default `list_issues` row is ~0.3× the hosted ~1.2 KB/issue, and a `save_issue` ack is ~160 bytes with no full-object echo.

## In plain words

- Your agent talks to Linear through this server instead of Linear's own MCP server. **Same tool names, same behavior — nothing in your prompts or workflows changes.**
- The difference is what comes back: **only the fields agents actually use**, not the whole object. A typical issue row is ~340 bytes here vs ~1.2 KB from the hosted server; a write returns a tiny receipt (`{id, identifier, state, url}`) instead of echoing the full issue back.
- Fewer bytes returned = fewer tokens your model reads = **cheaper, faster agent sessions** — the savings compound over hundreds of calls.
- Need more sometimes? Pass `full: true` on that one call, or drop to raw GraphQL with `linear_graphql`. **Lean by default, never a dead end.**
- You don't have to take the savings on faith: every call is logged, and `GET /stats` shows the trim ratio **measured on your own traffic**.
- It authenticates with a plain Linear API key — no OAuth dance — so it works headless: CI, cron, background agents, multiple machines sharing one deploy.

## Measured savings vs the hosted MCP

<!-- savings:begin -->
Measured 2026-07-07 against a live deploy — identical requests to this wrapper and to the hosted Linear MCP, response bytes compared per call (per row for lists). The [probe-vs-hosted workflow](.github/workflows/probe-vs-hosted.yml) re-measures weekly and fails on regression:

```text
tool                   w.bytes   h.bytes  w.rows  h.rows  save%call  save%/row
--------------------------------------------------------------------------------
get_issue                 1422      2138       0       0      33.5%          —
get_project                311      1100       0       0      71.7%          —
get_team                    83       148       1       1      43.9%          —
list_teams                 618      1256       8       8      50.8%      50.8%
list_projects              270      2025       2       2      86.7%      86.7%
list_issues               2788      9402       6       6      70.3%      70.3%
list_issue_statuses        697       571       7       7     -22.1%     -22.1%
--------------------------------------------------------------------------------
TOTAL  wrapper=6189B (~1768 tok)  hosted=16640B (~4754 tok)  aggregate save=62.8%
```
<!-- savings:end -->

## How it compares

- **vs Linear's hosted MCP** ([mcp.linear.app](https://linear.app/docs/mcp)) — identical tool names, so it's a drop-in swap; but reads are field-trimmed to roughly a third of the size and writes return minimal acks instead of full-object echoes. Static API key instead of per-user OAuth, which is what makes headless use possible. The 5 tools Linear's public GraphQL can't back are proxied to the hosted server, so nothing is lost in the swap.
- **vs community SDK wrappers** ([cline/linear-mcp](https://github.com/cline/linear-mcp), [tacticlaunch/mcp-linear](https://github.com/tacticlaunch/mcp-linear), [dvcrn/mcp-server-linear](https://github.com/dvcrn/mcp-server-linear), …) — those expose plain CRUD with untrimmed SDK payloads. This serves field-trimmed responses — response size is the entire point of its design — over the same convenient stdio transport (`npx linear-mcp-lean`), plus an HTTP mode one deploy can share across machines and agents.
- **vs [linear-toon-mcp](https://github.com/hoblin/linear-toon-mcp)** — same motivation (the hosted MCP burns context), different mechanism: TOON re-encodes *all* the data in a more compact text format (~40–60% claimed). This server instead *selects fields server-side*, so unneeded data never crosses the wire at all, stays plain JSON (no extra format for the model to parse), keeps the hosted server's tool names for drop-in compatibility, and proves its savings from live traffic via `/stats`.

## How it works

```
MCP client ──stdio (npx linear-mcp-lean)──────────────▶ this server
        or ──POST /mcp (Bearer MCP_BEARER_TOKEN)──────▶     │
                                                            │
                               hand-written minimal GraphQL ├──▶ api.linear.app/graphql   (LINEAR_API_KEY)
                               verbatim proxy (5 tools)     └──▶ mcp.linear.app/mcp       (LINEAR_API_KEY)
```

- **Two transports, one tool set** — stdio (local child process of your MCP client, one command, no server to run) and stateless Streamable HTTP behind a bearer gate (one deploy shared across machines, plus the `/stats` byte-log). Both serve the same `buildServer()` registrations.

- **Trimmed GraphQL tools** — each read is a hand-written minimal GraphQL query flattened into a **closed** object (never a spread of the raw response, so no field sneaks in); each write returns a minimal ack (`save_issue` → `{id, identifier, state, url}`).
- **Server-side name→id resolution** — filter and write args accept names (`state: "In Progress"`, `project: "My Project"`, `assignee: "me"`, team key/name case-insensitively); an unresolved name throws a **loud error**, never a silent empty result.
- **Hosted-MCP proxy fallback** — 5 tools Linear's public GraphQL cannot back (`search_documentation`, `extract_images`, `get_diff`, `get_diff_threads`, `list_diffs`) are forwarded verbatim to the hosted Linear MCP.
- **`linear_graphql` escape hatch** — run an arbitrary GraphQL document and get the raw, untrimmed result, for the rare need the lean defaults don't cover.
- **Byte-savings observability** — every call appends one JSONL record (upstream bytes vs bytes returned); `GET /stats` aggregates per-tool trim ratios from real traffic.

### Stack

`@modelcontextprotocol/sdk` (`McpServer` + stateless `StreamableHTTPServerTransport`) behind Express `POST /mcp`; `graphql-request` for the hand-written queries; zero database.

## Quick start

Requires Node 20+ and a [Linear Personal API key](https://linear.app/settings/account/security) (Settings → Security & access → Personal API keys).

### Local (stdio) — no server to run

```bash
# with LINEAR_API_KEY exported in your shell:
claude mcp add linear -e LINEAR_API_KEY=${LINEAR_API_KEY} -- npx -y linear-mcp-lean
```

or in `.mcp.json` / `~/.claude.json` `mcpServers` (any MCP client with stdio support):

```json
{
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "linear-mcp-lean"],
      "env": { "LINEAR_API_KEY": "${LINEAR_API_KEY}" }
    }
  }
}
```

(`${LINEAR_API_KEY}` is expanded from the client's environment at session start.) No bearer token here: a stdio server is a local child process of your MCP client, so the only credential is the outbound `LINEAR_API_KEY`. The byte log is off in stdio mode unless you set `BYTE_LOG_PATH` explicitly.

### Hosted (HTTP) — one deploy shared across machines and agents

```bash
npm install
cp .env.example .env    # fill in MCP_BEARER_TOKEN + LINEAR_API_KEY
npm run build
npm start               # listens on :$PORT (default 8080), MCP at POST /mcp
```

- `MCP_BEARER_TOKEN` — inbound auth: the token your MCP clients must send. Generate one: `openssl rand -hex 32`.
- `LINEAR_API_KEY` — outbound auth: the same Personal API key as above.

Smoke test:

```bash
source .env
curl -s http://localhost:8080/health     # {"ok":true} — liveness, no Linear call
curl -s -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  http://localhost:8080/ready            # proves the LINEAR_API_KEY actually reaches Linear
curl -s -X POST http://localhost:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_issue","arguments":{"id":"ENG-123"}}}'
```

## Connect an MCP client

Register under the server name `linear` so tool names (`mcp__linear__*` in Claude Code) match the hosted Linear MCP exactly — existing prompts and call sites keep working unchanged. For the stdio form see [Quick start](#local-stdio--no-server-to-run); connecting to a hosted deploy:

**Claude Code** (CLI):

```bash
claude mcp add --transport http linear https://linear-mcp.example.com/mcp \
  --header "Authorization: Bearer ${MCP_BEARER_TOKEN}"
```

or in `.mcp.json` / `~/.claude.json` `mcpServers`:

```json
{
  "mcpServers": {
    "linear": {
      "type": "http",
      "url": "https://linear-mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_BEARER_TOKEN}" }
    }
  }
}
```

(`${MCP_BEARER_TOKEN}` is expanded from the client's environment at session start.)

For local experimentation, point at `http://localhost:8080/mcp` instead.

## Tools

Same names and semantics as the hosted Linear MCP (36 tools total):

| Group | Tools |
|-------|-------|
| Issues | `get_issue`, `list_issues`, `save_issue`, `list_comments`, `save_comment` |
| Projects | `get_project`, `list_projects`, `save_project`, `list_milestones`, `get_milestone`, `save_milestone` |
| Teams & users | `get_team`, `list_teams`, `get_user`, `list_users` |
| Labels & states | `list_issue_labels`, `list_project_labels`, `create_issue_label`, `list_issue_statuses`, `get_issue_status`, `list_cycles` |
| Documents | `get_document`, `list_documents`, `save_document` |
| Attachments | `get_attachment`, `create_attachment`, `prepare_attachment_upload`, `create_attachment_from_upload` |
| Status updates | `get_status_updates`, `save_status_update` |
| Proxied to hosted MCP | `search_documentation`, `extract_images`, `get_diff`, `get_diff_threads`, `list_diffs` |
| Escape hatch | `linear_graphql` |

## Field contract — lean default, broaden on demand

Reads are **lean by default, broaden on demand**. The full per-tool field map lives in [`FIELDS.md`](./FIELDS.md); the contract in brief:

- **`full: true`** (opt-in on `get_issue`, `list_issues`, `list_projects`, `get_project`) → a documented richer superset (assignee, lifecycle timestamps, state type, parent, estimate, due date, …). Absent → the minimal contract. You only pay the extra bytes when you ask.

- **`list_issues` returns a pagination envelope** matching the hosted MCP shape:
  ```json
  { "issues": [ … ], "hasNextPage": true, "cursor": "<opaque token>" }
  ```
  To page: pass the returned `cursor` back as the `cursor` arg until `hasNextPage` is false. `list_issues` is the only paginated tool (see `FIELDS.md` for why the other lists stay bare arrays).

- **`linear_graphql({query, variables})`** — arbitrary GraphQL against `https://api.linear.app/graphql` via the same server-side client, raw untrimmed result. Bearer-gated like every tool; errors surface, never swallowed.
  ```jsonc
  // request
  { "name": "linear_graphql", "arguments": {
      "query": "query($id:String!){ issue(id:$id){ identifier subscribers{ nodes{ name } } } }",
      "variables": { "id": "ENG-123" } } }
  ```

## Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /mcp` | Bearer | The MCP endpoint (stateless Streamable HTTP) |
| `GET /health` | none | Liveness — process up, deliberately no Linear call |
| `GET /ready` | Bearer | Readiness — fresh `viewer` query proves the `LINEAR_API_KEY` authenticates (catches a placeholder/revoked key `/health` can't); 503 + surfaced error on failure |
| `GET /stats` | Bearer | Per-tool + overall upstream/downstream byte totals and trim ratios, plus byte-log write-health |

## Tests and verification probes

Unit tests cover the flatteners and name→id resolvers with `fetch` mocked at the GraphQL seam — no Linear workspace, key, or network needed (they run on fork PRs):

```bash
npm test
```

Live invariants are covered by encoded, runnable probes:

```bash
npm run build
npm run probe:auth       # missing/invalid bearer -> 401; valid -> non-401 (key-free)
npm run probe:tools      # tools/list serves every promised tool name (key-free)
npm run probe:bytelog    # dead byte-log sink is distinguishable from idle on /stats (key-free)
npm run probe:secrets    # no secret tracked in the repo (offline)
npm run probe:status     # no deprecated GraphQL field selected (needs LINEAR_API_KEY)
npm run probe:proxy      # hosted MCP accepts the PAK bearer (needs LINEAR_API_KEY)
npm run probe:vs-hosted  # byte-savings comparison vs the hosted MCP (needs a deploy; see file header)
```

[CI](.github/workflows/ci.yml) runs the type-check, build, unit tests, and the four key-free probes (`auth`, `tools`, `bytelog`, `secrets`) on every PR and push to main. The [probe-vs-hosted workflow](.github/workflows/probe-vs-hosted.yml) re-measures the savings weekly and fails when the aggregate drops below its floor; refresh the committed table with `scripts/update-readme-savings.mjs` when the numbers meaningfully change.

## Deploy

`deploy/` has a complete runbook (`deploy/README.md`) for a small Linux VPS: systemd unit (hardened: `ProtectSystem=strict`, dedicated no-login user, root-owned `chmod 600` env file) + Caddy for automatic HTTPS.

## Security notes

- **Single-tenant by design.** The server holds ONE Linear API key; every client presenting the bearer token acts as that Linear user, with that user's full workspace access. Don't share the bearer across trust boundaries — this is a personal/team-internal service, not a multi-tenant gateway.
- The bearer gate runs before the MCP transport and compares tokens with a timing-safe equality; a missing `MCP_BEARER_TOKEN` fails closed (500), never open.
- `/ready` and `/stats` are bearer-gated too — they expose the viewer id and traffic shape.
- Secrets come only from the environment (`.env` locally, a root-owned env file under systemd). Only `.env.example` is committed; `npm run probe:secrets` asserts nothing secret is tracked.

## License

MIT — see [LICENSE](./LICENSE).
