import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const HOSTED_LINEAR_MCP = new URL("https://mcp.linear.app/mcp");

/**
 * Forward a tool call to Linear's HOSTED MCP server and return its result
 * verbatim ("give the original"). The fallback for the few tools that Linear's
 * PUBLIC GraphQL API genuinely cannot back (verified absent from the schema
 * SDL): `search_documentation` (Linear's internal AI-conversation help-center
 * search) and the diff/image helpers `extract_images`, `get_diff`,
 * `get_diff_threads`, `list_diffs`. Everything Linear's GraphQL CAN back is
 * implemented + trimmed in `src/linear.ts`; this is the last resort.
 *
 * Responses are intentionally UNTRIMMED — these tools are rarely on an agent's
 * hot path, so their payload size barely affects the byte-trim goal.
 *
 * Auth: the SAME Linear Personal API Key the GraphQL client uses, sent here as
 * `Authorization: Bearer <key>` (the hosted MCP accepts a PAK bearer for headless
 * use — distinct from `api.linear.app/graphql`, which takes the key RAW). That
 * the hosted MCP accepts the PAK is asserted by Linear's docs but must be
 * confirmed empirically at deploy — see `probe-proxy.sh`.
 *
 * Errors are surfaced, never swallowed: a transport/connect failure throws (the
 * MCP server reports it as a tool error) and an upstream `isError` result is
 * passed through unchanged.
 */
export async function proxyToHostedMcp(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    throw new Error("LINEAR_API_KEY is not set (required to proxy to the hosted Linear MCP)");
  }

  const transport = new StreamableHTTPClientTransport(HOSTED_LINEAR_MCP, {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "linear-mcp-wrapper-proxy", version: "0.1.0" });

  try {
    await client.connect(transport);
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close().catch(() => undefined);
  }
}
