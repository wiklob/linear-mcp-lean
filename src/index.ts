import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerGate } from "./auth.js";
import { getBuildInfo } from "./version.js";
import { probeViewer } from "./linear.js";
import { buildServer } from "./server.js";
import { readByteStats, byteLogHealth, probeByteLogWritable } from "./instrument.js";

const PORT = Number(process.env.PORT ?? 8080);
// Loopback by default: this server holds a Linear PAK and is meant to sit behind a
// TLS reverse proxy, so binding every interface would expose it to the network on
// any box without a firewall. Containerised deployments that genuinely need an
// external bind set HOST=0.0.0.0 explicitly.
const HOST = process.env.HOST ?? "127.0.0.1";

const app = express();
// Don't advertise the framework to unauthenticated callers.
app.disable("x-powered-by");
app.use(express.json());

// Liveness: intentionally UNGATED + upstream-free so a deploy reverse-proxy can
// cheaply probe "is the process up". It deliberately makes NO Linear call — that
// is /ready's job (see below). Keeping them split stops a Linear outage from
// flipping liveness.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Readiness: proves the wrapper can actually reach Linear with its API key by
// running a fresh `viewer` query. /health cannot catch a bad/placeholder
// LINEAR_API_KEY (it makes no upstream call); /ready does — 200 {linear.ok:true}
// only when the key truly authenticates, else 503 with the surfaced error
// (never swallowed). Bearer-GATED: the error detail + viewerId would
// otherwise leak to any unauthenticated internet caller.
app.get("/ready", bearerGate, async (_req, res) => {
  try {
    const viewer = await probeViewer();
    res.json({ ok: true, linear: { ok: true, viewerId: viewer.id } });
  } catch (err) {
    res.status(503).json({
      ok: false,
      linear: { ok: false, error: err instanceof Error ? err.message : String(err) },
    });
  }
});

// Byte-savings observability. Aggregates the per-call JSONL byte log
// (src/instrument.ts) into per-tool + overall upstream/downstream totals and
// trim ratios, so "how much did the wrapper save" is answered from server-side
// data with no session transcript. Bearer-GATED like /ready: it exposes traffic
// shape (per-tool call counts + sizes) that shouldn't leak to the open internet.
app.get("/stats", bearerGate, async (_req, res) => {
  try {
    res.json({ ok: true, ...(await readByteStats()), byteLog: byteLogHealth() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Build provenance: which commit this binary was built from. Baked into
// dist/build-info.json at build time (bin/gen-version.mjs) since the box has no
// git. Bearer-GATED like /ready and /stats — the exact SHA is deploy detail that
// shouldn't leak to the open internet (it maps the running code to a public
// commit). Verify a redeploy with:
//   curl -fsS -H "Authorization: Bearer $MCP_BEARER_TOKEN" .../version | jq -r .commit
// and compare against `git rev-parse HEAD` of the build tree.
app.get("/version", bearerGate, (_req, res) => {
  res.json({ ok: true, ...getBuildInfo() });
});

// MCP endpoint, stateless Streamable HTTP. The bearer gate runs first → 401 on bad/missing token.
app.post("/mcp", bearerGate, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  // A throw here would otherwise reject the async handler and take the process
  // down (no express error path for an unhandled rejection) — a trivial
  // crash-DoS from a single malformed request.
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
});

// Stateless transport does not support GET (SSE) or DELETE; reject them clearly (still gated).
const methodNotAllowed = (_req: express.Request, res: express.Response): void => {
  res.status(405).json({ error: "method not allowed (stateless transport)" });
};
app.get("/mcp", bearerGate, methodNotAllowed);
app.delete("/mcp", bearerGate, methodNotAllowed);

// Terminal error boundary: keeps a malformed-JSON body-parser SyntaxError (or any
// downstream throw) from returning a stack trace to unauthenticated callers.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;
  const status = (err as { type?: string })?.type === "entity.parse.failed" ? 400 : 500;
  res.status(status).json({ error: status === 400 ? "invalid json" : "internal error" });
});

// Seed byte-log write-health before accepting traffic, so a never-yet-called
// dead sink (e.g. EROFS under systemd ProtectSystem=strict) already reports
// writable:false on /stats instead of looking idle. Top-level await is legal here
// (ES2022 + NodeNext); the probe is best-effort and never throws.
await probeByteLogWritable();

app.listen(PORT, HOST, () => {
  console.log(`linear-mcp wrapper listening on ${HOST}:${PORT}`);
});
