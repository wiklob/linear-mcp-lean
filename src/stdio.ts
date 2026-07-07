#!/usr/bin/env node
// stdio entry point — what `npx linear-mcp-lean` runs. The same tool set as the
// HTTP server (src/index.ts), second transport. No bearer gate: a stdio server
// is a local child process of the MCP client, so there is no network edge to
// guard — the only credential is the outbound LINEAR_API_KEY. stdout carries
// the MCP wire protocol; diagnostics must go to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { disableByteLog, probeByteLogWritable } from "./instrument.js";

// Fail fast with a actionable message: without the key every tool call would
// error identically later, which is much harder to diagnose from a client.
if (!process.env.LINEAR_API_KEY) {
  console.error(
    "linear-mcp-lean: LINEAR_API_KEY is not set.\n" +
      "Create a Personal API key in Linear (Settings → Security & access → Personal API keys)\n" +
      'and pass it in your MCP client config, e.g. "env": { "LINEAR_API_KEY": "lin_api_..." }.',
  );
  process.exit(1);
}

// Byte-log is opt-in on stdio: the default path (./byte-log.jsonl) would drop a
// stray file into whatever cwd the MCP client spawned us in. Set BYTE_LOG_PATH
// explicitly to keep the per-call byte log in stdio mode.
if (process.env.BYTE_LOG_PATH) {
  await probeByteLogWritable();
} else {
  disableByteLog();
}

await buildServer().connect(new StdioServerTransport());
