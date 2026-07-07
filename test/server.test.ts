// Tool-set parity: both entry points (HTTP src/index.ts, stdio src/stdio.ts)
// serve buildServer(), so asserting the registered tool names here proves the
// drop-in contract for both transports without a network.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { buildServer } from "../src/server.js";

// The 36 tools promised by README.md — same names as the hosted Linear MCP.
const EXPECTED_TOOLS = [
  // issues
  "get_issue", "list_issues", "save_issue", "list_comments", "save_comment",
  // projects
  "get_project", "list_projects", "save_project", "list_milestones", "get_milestone", "save_milestone",
  // teams & users
  "get_team", "list_teams", "get_user", "list_users",
  // labels & states
  "list_issue_labels", "list_project_labels", "create_issue_label",
  "list_issue_statuses", "get_issue_status", "list_cycles",
  // documents
  "get_document", "list_documents", "save_document",
  // attachments
  "get_attachment", "create_attachment", "prepare_attachment_upload", "create_attachment_from_upload",
  // status updates
  "get_status_updates", "save_status_update",
  // proxied to the hosted MCP
  "search_documentation", "extract_images", "get_diff", "get_diff_threads", "list_diffs",
  // escape hatch
  "linear_graphql",
];

it("buildServer registers exactly the promised drop-in tool set", async () => {
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parity-test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  expect(new Set(tools.map((t) => t.name))).toEqual(new Set(EXPECTED_TOOLS));
  expect(tools).toHaveLength(36);
  await client.close();
  await server.close();
});
