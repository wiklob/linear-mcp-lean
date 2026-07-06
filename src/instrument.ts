// Server-side per-call byte logging.
//
// The wrapper is the one place that sees BOTH the raw upstream Linear GraphQL
// response AND the trimmed body we return — but not at one trivial line:
// `graphql-request` deserializes Linear's HTTP body into JS objects before any
// tool handler runs (src/linear.ts), and the generic `jsonContent()` envelope
// (src/index.ts) sees only the already-trimmed value. This module restores
// single-point co-observability:
//   - upstream wire bytes are measured by a custom `fetch` on the GraphQLClient
//     (src/linear.ts) which adds into the active AsyncLocalStorage ctx;
//   - downstream bytes are measured here at handler completion;
//   - `runInstrumented` correlates the two (+ tool name + status) per /mcp call
//     and appends one JSONL record, so "how much did the wrapper save" is a
//     one-line query over real traffic — zero transcript forensics.

import { AsyncLocalStorage } from "node:async_hooks";
import { access, appendFile, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";

/** Per-call accumulator threaded across the (awaited) graphql-request fetch. */
export interface ByteCtx {
  tool: string;
  // null until a gqlClient() fetch fires. Proxy-backed tools (proxy.ts) never
  // hit gqlClient, so their upstreamBytes stays null — trim ratio is N/A for
  // them by design (they're the untrimmed last-resort set).
  upstreamBytes: number | null;
}

/** One structured per-tool-request log entry. */
export interface ByteRecord {
  ts: string;
  tool: string;
  upstreamBytes: number | null;
  downstreamBytes: number;
  status: "ok" | "error";
}

export const byteLogStore = new AsyncLocalStorage<ByteCtx>();

/** Where the JSONL byte log is appended. Default is relative to the service
 *  cwd; override to a durable box path (e.g. /var/lib/linear-mcp/bytes.jsonl). */
export const BYTE_LOG_PATH = process.env.BYTE_LOG_PATH ?? "./byte-log.jsonl";

// Byte-log write-health. A dead sink (e.g. EROFS under systemd
// ProtectSystem=strict) is otherwise byte-identical to a legitimately-idle one
// on /stats. The single writer (appendByteLog) and a boot-time probe seed these
// so an HTTP caller can tell "logging is broken" from "no calls yet".
let lastError: string | null = null;
let lastWriteTs: string | null = null;

/** Bytes of the trimmed body we return — measured off the MCP text envelope
 *  (`{ content: [{ type, text }], isError? }`) every tool produces. */
function downstreamBytesOf(result: unknown): number {
  try {
    const content = (result as { content?: unknown })?.content;
    if (Array.isArray(content)) {
      let n = 0;
      for (const item of content) {
        const text = (item as { text?: unknown })?.text;
        n += typeof text === "string"
          ? Buffer.byteLength(text)
          : Buffer.byteLength(JSON.stringify(item));
      }
      return n;
    }
    return Buffer.byteLength(JSON.stringify(result ?? null));
  } catch {
    return 0;
  }
}

/** Best-effort JSONL append. Observability must never break a tool call, so a
 *  write failure (full disk, bad path) is warned-and-swallowed, not thrown. */
async function appendByteLog(record: ByteRecord): Promise<void> {
  try {
    await appendFile(BYTE_LOG_PATH, JSON.stringify(record) + "\n");
    lastWriteTs = record.ts;
    lastError = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastError = msg;
    console.warn(`byte-log append failed: ${msg}`);
  }
}

/** Boot-time write-health probe: check the sink's directory is writable and seed
 *  `lastError` BEFORE any tool call, so a never-yet-called dead sink (the EROFS
 *  class) already reports `writable:false` on /stats instead of looking idle.
 *  Best-effort and never throws — same contract as appendByteLog. */
export async function probeByteLogWritable(): Promise<void> {
  try {
    await access(dirname(BYTE_LOG_PATH), constants.W_OK);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
}

/** Write-health snapshot for GET /stats. `writable === (lastError === null)` by
 *  construction; `path` is the resolved BYTE_LOG_PATH (directly diagnostic for
 *  the EROFS class). */
export function byteLogHealth(): {
  writable: boolean;
  lastError: string | null;
  lastWriteTs: string | null;
  path: string;
} {
  return { writable: lastError === null, lastError, lastWriteTs, path: BYTE_LOG_PATH };
}

/**
 * Wrap a tool handler: open a per-call ctx, run it, record the byte entry, and
 * propagate the result/throw unchanged. `status` is `error` when the handler
 * throws OR the result carries `isError` (a proxied upstream error passed
 * through). On throw the record is still written, then the error re-thrown so
 * MCP still surfaces it (`is_error`).
 */
export async function runInstrumented<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  return byteLogStore.run({ tool, upstreamBytes: null }, async () => {
    const ctx = byteLogStore.getStore() as ByteCtx;
    const ts = new Date().toISOString();
    try {
      const result = await fn();
      const status: "ok" | "error" = (result as { isError?: unknown })?.isError ? "error" : "ok";
      await appendByteLog({ ts, tool, upstreamBytes: ctx.upstreamBytes, downstreamBytes: downstreamBytesOf(result), status });
      return result;
    } catch (err) {
      await appendByteLog({ ts, tool, upstreamBytes: ctx.upstreamBytes, downstreamBytes: 0, status: "error" });
      throw err;
    }
  });
}

export interface ByteStats {
  perTool: Record<string, {
    calls: number;
    okCalls: number;
    errorCalls: number;
    upstreamBytes: number; // summed over records that have an upstream (gqlClient-backed)
    downstreamBytes: number; // summed over the same records
    trimRatio: number | null; // 1 - down/up over upstream-bearing records; null if none
  }>;
  totals: { calls: number; upstreamBytes: number; downstreamBytes: number; trimRatio: number | null };
}

/** Aggregate the JSONL log into per-tool + overall trim ratios for GET /stats.
 *  Trim ratio is computed ONLY over records carrying an upstream byte count
 *  (proxy-backed tools have upstreamBytes:null and don't contribute). */
export async function readByteStats(): Promise<ByteStats> {
  const perTool: ByteStats["perTool"] = {};
  let tUp = 0, tDown = 0, tCalls = 0;
  let raw = "";
  try {
    raw = await readFile(BYTE_LOG_PATH, "utf8");
  } catch {
    return { perTool, totals: { calls: 0, upstreamBytes: 0, downstreamBytes: 0, trimRatio: null } };
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let r: ByteRecord;
    try {
      r = JSON.parse(line) as ByteRecord;
    } catch {
      continue;
    }
    const t = (perTool[r.tool] ??= { calls: 0, okCalls: 0, errorCalls: 0, upstreamBytes: 0, downstreamBytes: 0, trimRatio: null });
    t.calls++;
    tCalls++;
    if (r.status === "error") t.errorCalls++;
    else t.okCalls++;
    if (typeof r.upstreamBytes === "number") {
      t.upstreamBytes += r.upstreamBytes;
      t.downstreamBytes += r.downstreamBytes;
      tUp += r.upstreamBytes;
      tDown += r.downstreamBytes;
    }
  }
  for (const t of Object.values(perTool)) {
    t.trimRatio = t.upstreamBytes > 0 ? 1 - t.downstreamBytes / t.upstreamBytes : null;
  }
  return {
    perTool,
    totals: { calls: tCalls, upstreamBytes: tUp, downstreamBytes: tDown, trimRatio: tUp > 0 ? 1 - tDown / tUp : null },
  };
}
