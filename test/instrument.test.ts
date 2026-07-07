// Unit tests for the byte-log instrumentation: record shape, aggregation, the
// stdio-mode disable switch, and write-health. BYTE_LOG_PATH is read at module
// load, so each test sets the env var and then dynamically imports a fresh
// module (vi.resetModules in beforeEach).
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let dir: string;

beforeEach(async () => {
  vi.resetModules();
  dir = await mkdtemp(join(tmpdir(), "bytelog-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.BYTE_LOG_PATH;
});

const okResult = (text: string) => ({ content: [{ type: "text", text }] });

it("runInstrumented appends one ok record with upstream + downstream bytes", async () => {
  process.env.BYTE_LOG_PATH = join(dir, "log.jsonl");
  const { runInstrumented, byteLogStore } = await import("../src/instrument.js");
  await runInstrumented("get_issue", async () => {
    byteLogStore.getStore()!.upstreamBytes = 1000;
    return okResult("x".repeat(300));
  });
  const lines = (await readFile(process.env.BYTE_LOG_PATH, "utf8")).trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toMatchObject({
    tool: "get_issue",
    upstreamBytes: 1000,
    downstreamBytes: 300,
    status: "ok",
  });
});

it("a throwing handler still writes an error record, then rethrows", async () => {
  process.env.BYTE_LOG_PATH = join(dir, "log.jsonl");
  const { runInstrumented } = await import("../src/instrument.js");
  await expect(
    runInstrumented("get_issue", async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  const record = JSON.parse((await readFile(process.env.BYTE_LOG_PATH, "utf8")).trim());
  expect(record).toMatchObject({ tool: "get_issue", downstreamBytes: 0, status: "error" });
});

it("disableByteLog stops appends (stdio mode without BYTE_LOG_PATH)", async () => {
  process.env.BYTE_LOG_PATH = join(dir, "log.jsonl");
  const { runInstrumented, disableByteLog } = await import("../src/instrument.js");
  disableByteLog();
  const result = await runInstrumented("get_issue", async () => okResult("hi"));
  expect(result).toEqual(okResult("hi")); // the call itself is unaffected
  await expect(stat(process.env.BYTE_LOG_PATH)).rejects.toThrow(); // no sink written
});

it("readByteStats aggregates per-tool trim ratios and skips malformed lines", async () => {
  process.env.BYTE_LOG_PATH = join(dir, "log.jsonl");
  await writeFile(
    process.env.BYTE_LOG_PATH,
    [
      JSON.stringify({ ts: "t1", tool: "get_issue", upstreamBytes: 1000, downstreamBytes: 250, status: "ok" }),
      "{not json",
      JSON.stringify({ ts: "t2", tool: "get_issue", upstreamBytes: 1000, downstreamBytes: 350, status: "ok" }),
      // proxy-backed record: no upstream — must not contribute to the ratio
      JSON.stringify({ ts: "t3", tool: "search_documentation", upstreamBytes: null, downstreamBytes: 500, status: "ok" }),
    ].join("\n") + "\n",
  );
  const { readByteStats } = await import("../src/instrument.js");
  const stats = await readByteStats();
  expect(stats.perTool.get_issue).toMatchObject({ calls: 2, okCalls: 2, upstreamBytes: 2000, downstreamBytes: 600 });
  expect(stats.perTool.get_issue.trimRatio).toBeCloseTo(0.7);
  expect(stats.perTool.search_documentation.trimRatio).toBeNull();
  expect(stats.totals).toMatchObject({ calls: 3, upstreamBytes: 2000, downstreamBytes: 600 });
});

it("probeByteLogWritable flags an unwritable sink directory", async () => {
  process.env.BYTE_LOG_PATH = join(dir, "no-such-subdir", "log.jsonl");
  const { probeByteLogWritable, byteLogHealth } = await import("../src/instrument.js");
  await probeByteLogWritable();
  expect(byteLogHealth().writable).toBe(false);
});
