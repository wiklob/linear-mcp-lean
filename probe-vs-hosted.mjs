// Per-tool vs-hosted savings probe. Calls each READ tool on YOUR deployed
// wrapper AND on the hosted Linear MCP with equivalent args, measures
// response-payload bytes, and reports per-tool savings (per-call for gets,
// per-row-normalized for lists so differing result-set sizes compare fairly).
// Read-only — no mutations.
//
// Configure via env (all four required; fixtures must exist in YOUR workspace):
//   WRAPPER_URL       your deployed wrapper's /mcp URL, e.g. https://linear-mcp.example.com/mcp
//   PROBE_PROJECT_ID  a project UUID to fetch (get_project fixture)
//   PROBE_PROJECT     that project's name (list_issues / hosted get_project fixture)
//   PROBE_ISSUE_ID    an issue identifier, e.g. ENG-123 (get_issue fixture)
//   PROBE_TEAM        a team key or name (team-scoped list fixtures)
// Plus both secrets:
//   MCP_BEARER_TOKEN  authenticates to the wrapper
//   LINEAR_API_KEY    authenticates to the hosted MCP as a PAK bearer (same
//                     headless path proxy.ts uses)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FAIL: ${name} is not set — see the header of this file for the required env.`);
    process.exit(2);
  }
  return v;
}

const WRAPPER = requireEnv("WRAPPER_URL");
const HOSTED = "https://mcp.linear.app/mcp";
const PROJECT_ID = requireEnv("PROBE_PROJECT_ID");
const PROJECT = requireEnv("PROBE_PROJECT");
const ISSUE = requireEnv("PROBE_ISSUE_ID");
const TEAM = requireEnv("PROBE_TEAM");
requireEnv("MCP_BEARER_TOKEN");
requireEnv("LINEAR_API_KEY");

async function connect(url, token) {
  const t = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const c = new Client({ name: "vs-hosted-probe", version: "0" });
  await c.connect(t);
  return c;
}
function bytesOf(res) {
  const txt = (res.content || []).map((b) => (b.text ?? JSON.stringify(b))).join("");
  return Buffer.byteLength(txt);
}
function rowCount(res) {
  try {
    const txt = (res.content || []).map((b) => b.text ?? "").join("");
    const j = JSON.parse(txt);
    if (Array.isArray(j)) return j.length;
    // Generic envelope: first property whose value is an array (issues, projects,
    // nodes, teams, statuses, …) — both servers wrap lists differently.
    if (j && typeof j === "object") {
      const arr = Object.values(j).find((v) => Array.isArray(v));
      if (arr) return arr.length;
    }
    return 1;
  } catch { return 1; }
}

// Each case maps the SAME logical request to each server's arg schema (they share
// tool names but differ in arg shapes — e.g. wrapper get_project takes `id`, hosted `query`).
const CASES = [
  { tool: "get_issue", kind: "get", w: { id: ISSUE }, h: { id: ISSUE } },
  { tool: "get_project", kind: "get", w: { id: PROJECT_ID }, h: { query: PROJECT } },
  { tool: "get_team", kind: "get", w: { query: TEAM }, h: { query: TEAM } },
  { tool: "list_teams", kind: "list", w: {}, h: {} },
  { tool: "list_projects", kind: "list", w: { team: TEAM }, h: { team: TEAM } },
  { tool: "list_issues", kind: "list", w: { project: PROJECT, limit: 25 }, h: { project: PROJECT, limit: 25 } },
  { tool: "list_issue_statuses", kind: "list", w: { team: TEAM }, h: { team: TEAM } },
];

async function call(c, tool, args) {
  try {
    const r = await c.callTool({ name: tool, arguments: args });
    return { bytes: bytesOf(r), rows: rowCount(r), err: r.isError ? "isError" : null };
  } catch (e) { return { bytes: 0, rows: 0, err: String(e.message || e).slice(0, 40) }; }
}

const wc = await connect(WRAPPER, process.env.MCP_BEARER_TOKEN);
const hc = await connect(HOSTED, process.env.LINEAR_API_KEY);

const TOK = (b) => Math.round(b / 3.5);
const pad = (s, n) => String(s).padStart(n);
console.log(["tool".padEnd(20), pad("w.bytes", 9), pad("h.bytes", 9), pad("w.rows", 7), pad("h.rows", 7), pad("save%call", 10), pad("save%/row", 10)].join(" "));
console.log("-".repeat(80));
let tw = 0, th = 0;
for (const cse of CASES) {
  const w = await call(wc, cse.tool, cse.w);
  const h = await call(hc, cse.tool, cse.h);
  if (w.err || h.err) { console.log(cse.tool.padEnd(20), "ERR  ", `w=${w.err || "ok"}  h=${h.err || "ok"}`); continue; }
  tw += w.bytes; th += h.bytes;
  const callSave = ((h.bytes - w.bytes) / h.bytes * 100).toFixed(1);
  const wPer = w.bytes / Math.max(w.rows, 1), hPer = h.bytes / Math.max(h.rows, 1);
  const rowSave = ((hPer - wPer) / hPer * 100).toFixed(1);
  console.log([cse.tool.padEnd(20), pad(w.bytes, 9), pad(h.bytes, 9), pad(w.rows, 7), pad(h.rows, 7), pad(callSave + "%", 10), pad(cse.kind === "list" ? rowSave + "%" : "—", 10)].join(" "));
}
console.log("-".repeat(80));
console.log(`TOTAL  wrapper=${tw}B (~${TOK(tw)} tok)  hosted=${th}B (~${TOK(th)} tok)  aggregate save=${((th - tw) / th * 100).toFixed(1)}%`);
await wc.close().catch(() => {});
await hc.close().catch(() => {});
