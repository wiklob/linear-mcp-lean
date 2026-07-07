import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerGate } from "./auth.js";
import { probeViewer } from "./linear.js";
import { buildServer } from "./server.js";
import { readByteStats, byteLogHealth, probeByteLogWritable } from "./instrument.js";

const PORT = Number(process.env.PORT ?? 8080);

const app = express();
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

// MCP endpoint, stateless Streamable HTTP. The bearer gate runs first → 401 on bad/missing token.
app.post("/mcp", bearerGate, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Stateless transport does not support GET (SSE) or DELETE; reject them clearly (still gated).
const methodNotAllowed = (_req: express.Request, res: express.Response): void => {
  res.status(405).json({ error: "method not allowed (stateless transport)" });
};
app.get("/mcp", bearerGate, methodNotAllowed);
app.delete("/mcp", bearerGate, methodNotAllowed);

// Seed byte-log write-health before accepting traffic, so a never-yet-called
// dead sink (e.g. EROFS under systemd ProtectSystem=strict) already reports
// writable:false on /stats instead of looking idle. Top-level await is legal here
// (ES2022 + NodeNext); the probe is best-effort and never throws.
await probeByteLogWritable();

app.listen(PORT, () => {
  console.log(`linear-mcp wrapper listening on :${PORT}`);
});
