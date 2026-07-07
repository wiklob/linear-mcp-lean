import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getIssue,
  listIssues,
  listProjects,
  getProject,
  listMilestones,
  getMilestone,
  listComments,
  saveIssue,
  saveComment,
  saveProject,
  saveMilestone,
  // long-tail GraphQL tools
  getTeam,
  listTeams,
  getUser,
  listUsers,
  getAttachment,
  createAttachment,
  createAttachmentFromUpload,
  prepareAttachmentUpload,
  getDocument,
  listDocuments,
  saveDocument,
  listIssueLabels,
  listProjectLabels,
  createIssueLabel,
  listIssueStatuses,
  getIssueStatus,
  listCycles,
  getStatusUpdates,
  saveStatusUpdate,
  linearGraphql,
} from "./linear.js";
import { proxyToHostedMcp } from "./proxy.js";
import { runInstrumented } from "./instrument.js";

/** Wrap a result object as the MCP text-content envelope every tool returns. */
function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/**
 * Decorate a server's `registerTool` so every tool handler runs inside
 * `runInstrumented(name, …)`: it opens the per-call AsyncLocalStorage ctx (so
 * the measuring fetch in linear.ts can attribute upstream bytes), measures
 * downstream bytes + status, and appends one JSONL byte-log record. Decorating
 * the method (rather than wrapping each call site) keeps every `registerTool`
 * call below fully type-inferred — the cast is contained to this one seam.
 */
function instrumentRegisterTool(server: McpServer): void {
  const base = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as { registerTool: unknown }).registerTool = ((name: string, config: unknown, cb: (...a: unknown[]) => unknown) =>
    base(name, config, (...a: unknown[]) => runInstrumented(name, () => cb(...a) as Promise<unknown>))) as typeof server.registerTool;
}

/** Build a fresh MCP server with every tool registered. Shared by both entry
 *  points: HTTP (src/index.ts, per-request) and stdio (src/stdio.ts, long-lived). */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "linear", version: "0.1.0" });
  instrumentRegisterTool(server);

  server.registerTool(
    "get_issue",
    {
      title: "Get issue",
      description:
        "Retrieve a Linear issue by ID. Default → a minimal flattened field set; full:true → a documented richer superset (assignee, lifecycle timestamps, state type, parent, estimate, dueDate).",
      inputSchema: {
        id: z.string().describe("Issue ID or identifier, e.g. ENG-123"),
        full: z.boolean().optional().describe("Return the richer documented superset instead of the lean default"),
      },
    },
    async ({ id, full }) => jsonContent(await getIssue(id, full)),
  );

  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description:
        "List issues as a {issues, hasNextPage, cursor} envelope. Lean rows by default (identifier, title, state, statusType, priority, createdAt, blockedBy, labels, project{id}, projectMilestone{id}, gitBranchName); full:true adds description, url, assignee, milestone name, updatedAt per row. `query` is a case-insensitive title/description text search (find an existing ticket without raw graphql). Page forward by passing the returned `cursor` back. Filter names (state/project/label/assignee/team) resolve server-side; an unresolved name errors loudly. Narrow server-side with `team` and `includeCompleted:false` (excludes completed/canceled/duplicate) to cut row count before it reaches you.",
      inputSchema: {
        state: z.string().optional().describe("Workflow state name or id (e.g. In Progress)"),
        limit: z.number().int().positive().optional().describe("Max rows (default 50)"),
        project: z.string().optional().describe("Project name or id"),
        label: z.string().optional().describe("Issue label name or id"),
        assignee: z.string().optional().describe('User name or id, or "me"'),
        query: z.string().optional().describe("Case-insensitive text search over title OR description (AND-ed with the other filters)"),
        team: z.string().optional().describe("Team name, key, or id — narrows to that team's issues server-side"),
        includeCompleted: z.boolean().optional().describe("Default true. false + no explicit state excludes completed/canceled/duplicate issues server-side"),
        cursor: z.string().optional().describe("Next-page cursor from a prior response"),
        full: z.boolean().optional().describe("Return the richer documented per-row superset instead of the lean default"),
      },
    },
    async (args) => jsonContent(await listIssues(args)),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List projects as lean rows (id, name, status{name,type}) by default; full:true adds description, dates, lead, labels, initiatives. Optional state (lifecycle string), label (project label name), and team filters; includeCompleted:false excludes completed/canceled projects server-side.",
      inputSchema: {
        state: z.string().optional().describe('Project lifecycle state (e.g. started, completed)'),
        label: z.string().optional().describe("Project label name"),
        team: z.string().optional().describe("Team name, key, or id — narrows to that team's projects server-side"),
        includeCompleted: z.boolean().optional().describe("Default true. false excludes completed/canceled projects server-side"),
        limit: z.number().int().positive().optional().describe("Max rows (default 50)"),
        full: z.boolean().optional().describe("Return the richer documented superset instead of the lean default"),
      },
    },
    async (args) => jsonContent(await listProjects(args)),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description: "Get one project. Default → id, name, description, labels[name]; full:true adds status{name,type}, dates, lead, initiatives.",
      inputSchema: {
        id: z.string().describe("Project id"),
        full: z.boolean().optional().describe("Return the richer documented superset instead of the lean default"),
      },
    },
    async ({ id, full }) => jsonContent(await getProject(id, full)),
  );

  server.registerTool(
    "list_milestones",
    {
      title: "List milestones",
      description: "List a project's milestones (id, name). `project` accepts a name or id.",
      inputSchema: { project: z.string().describe("Project name or id") },
    },
    async ({ project }) => jsonContent(await listMilestones(project)),
  );

  server.registerTool(
    "get_milestone",
    {
      title: "Get milestone",
      description: "Get one project milestone (id, name, description).",
      inputSchema: { id: z.string().describe("Milestone id") },
    },
    async ({ id }) => jsonContent(await getMilestone(id)),
  );

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description: "List an issue's comments (id, body, authorName, createdAt). `issue` accepts an identifier (e.g. ENG-123) or id.",
      inputSchema: { issue: z.string().describe("Issue identifier or id") },
    },
    async ({ issue }) => jsonContent(await listComments(issue)),
  );

  // --- write tools — minimal acks -------------------------------------------

  server.registerTool(
    "save_issue",
    {
      title: "Save issue",
      description:
        "Create (no `id`) or update (`id`) an issue. Returns only {id, identifier, state, url} — no full-object echo. id-or-name args (state/assignee/project/milestone/labels) resolve server-side; `blockedBy` takes issue identifiers; create requires `title` + `team`.",
      inputSchema: {
        id: z.string().optional().describe("Issue id or identifier to UPDATE; omit to create"),
        title: z.string().optional().describe("Issue title (required on create)"),
        description: z.string().optional().describe("Markdown body"),
        team: z.string().optional().describe("Team name or id (required on create)"),
        state: z.string().optional().describe("Workflow state name or id (e.g. In Progress)"),
        assignee: z.string().optional().describe('User name or id, or "me"'),
        project: z.string().optional().describe("Project name or id"),
        milestone: z.string().optional().describe("Milestone name (needs project) or id"),
        labels: z.array(z.string()).optional().describe("Label names or ids"),
        blockedBy: z.array(z.string()).optional().describe("Issue identifiers/ids that block this issue"),
        priority: z.number().int().min(0).max(4).optional().describe("0=None,1=Urgent,2=High,3=Medium,4=Low"),
      },
    },
    async (args) => jsonContent(await saveIssue(args)),
  );

  server.registerTool(
    "save_comment",
    {
      title: "Save comment",
      description: "Add a comment to an issue. Returns only {id, url}. `issue` accepts an identifier or id.",
      inputSchema: {
        issue: z.string().describe("Issue identifier or id"),
        body: z.string().describe("Comment body (Markdown)"),
      },
    },
    async (args) => jsonContent(await saveComment(args)),
  );

  server.registerTool(
    "save_project",
    {
      title: "Save project",
      description:
        "Create (no `id`) or update (`id`) a project. Returns only {id, name, url}. Create requires `name` + `team`; `addInitiatives` (names or ids) are attached after create.",
      inputSchema: {
        id: z.string().optional().describe("Project id to UPDATE; omit to create"),
        team: z.string().optional().describe("Team name or id (required on create)"),
        name: z.string().optional().describe("Project name (required on create)"),
        description: z.string().optional().describe("Markdown body"),
        addInitiatives: z.array(z.string()).optional().describe("Initiative names or ids to attach"),
      },
    },
    async (args) => jsonContent(await saveProject(args)),
  );

  server.registerTool(
    "save_milestone",
    {
      title: "Save milestone",
      description:
        "Create (no `id`) or update (`id`) a project milestone. Returns only {id, name}. Create requires `name` + `project` (name or id).",
      inputSchema: {
        id: z.string().optional().describe("Milestone id to UPDATE; omit to create"),
        project: z.string().optional().describe("Project name or id (required on create)"),
        name: z.string().optional().describe("Milestone name (required on create)"),
        description: z.string().optional().describe("Milestone description (Markdown)"),
      },
    },
    async (args) => jsonContent(await saveMilestone(args)),
  );

  // --- long-tail GraphQL tools ----------------------------------------------
  // Every tool Linear's public GraphQL can back, trimmed.

  server.registerTool(
    "get_team",
    {
      title: "Get team",
      description: "Get one team by id, key, or name → {id, name, key}.",
      inputSchema: { query: z.string().describe("Team UUID, key (e.g. ENG), or name") },
    },
    async ({ query }) => jsonContent(await getTeam(query)),
  );

  server.registerTool(
    "list_teams",
    {
      title: "List teams",
      description: "List teams → [{id, name, key}]. `query` filters by name/key substring.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Max rows (default 50)"),
        query: z.string().optional().describe("Filter by team name/key substring"),
      },
    },
    async (args) => jsonContent(await listTeams(args)),
  );

  server.registerTool(
    "get_user",
    {
      title: "Get user",
      description: 'Get one user by id, "me", or name → {id, name, displayName, email, active}.',
      inputSchema: { query: z.string().describe('User id, name, or "me"') },
    },
    async ({ query }) => jsonContent(await getUser(query)),
  );

  server.registerTool(
    "list_users",
    {
      title: "List users",
      description: "List users → [{id, name, displayName, email, active}]. `query` filters by name/displayName/email substring.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Max rows (default 50)"),
        query: z.string().optional().describe("Filter by name/displayName/email substring"),
      },
    },
    async (args) => jsonContent(await listUsers(args)),
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Get attachment",
      description: "Get one attachment → {id, title, subtitle, url, sourceType}.",
      inputSchema: { id: z.string().describe("Attachment id") },
    },
    async ({ id }) => jsonContent(await getAttachment(id)),
  );

  server.registerTool(
    "create_attachment",
    {
      title: "Create attachment",
      description: "Link an external URL to an issue as an attachment → {id, title, url}. `issue` accepts an identifier or id.",
      inputSchema: {
        issue: z.string().describe("Issue identifier or id"),
        url: z.string().describe("URL to attach"),
        title: z.string().describe("Attachment title"),
        subtitle: z.string().optional().describe("Attachment subtitle"),
      },
    },
    async (args) => jsonContent(await createAttachment(args)),
  );

  server.registerTool(
    "create_attachment_from_upload",
    {
      title: "Create attachment from upload",
      description: "Finalize an upload: link an already-uploaded assetUrl to an issue → {id, title, url}. Call after prepare_attachment_upload + the client-side byte PUT.",
      inputSchema: {
        issue: z.string().describe("Issue identifier or id"),
        assetUrl: z.string().describe("assetUrl returned by prepare_attachment_upload"),
        title: z.string().optional().describe("Attachment title (defaults to the asset URL)"),
        subtitle: z.string().optional().describe("Attachment subtitle"),
      },
    },
    async (args) => jsonContent(await createAttachmentFromUpload(args)),
  );

  server.registerTool(
    "prepare_attachment_upload",
    {
      title: "Prepare attachment upload",
      description: "Get a presigned direct-upload URL (fileUpload) → {assetUrl, uploadUrl, headers, issue}. PUT raw bytes to uploadUrl with headers verbatim (client-side), then call create_attachment_from_upload.",
      inputSchema: {
        issue: z.string().describe("Issue identifier or id (for the finalize step)"),
        filename: z.string().describe("Filename, e.g. screenshot.png"),
        contentType: z.string().describe("MIME type, e.g. image/png"),
        size: z.number().int().positive().describe("Exact file size in bytes"),
        title: z.string().optional().describe("Suggested attachment title for finalize"),
        subtitle: z.string().optional().describe("Suggested attachment subtitle for finalize"),
      },
    },
    async (args) => jsonContent(await prepareAttachmentUpload(args)),
  );

  server.registerTool(
    "get_document",
    {
      title: "Get document",
      description: "Get one document → {id, title, content, slugId, updatedAt, project{id}}. `id` accepts a document id or slug.",
      inputSchema: { id: z.string().describe("Document id or slug") },
    },
    async ({ id }) => jsonContent(await getDocument(id)),
  );

  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description: "List documents as lean rows → [{id, title, slugId, updatedAt}] (no content).",
      inputSchema: { limit: z.number().int().positive().optional().describe("Max rows (default 50)") },
    },
    async (args) => jsonContent(await listDocuments(args)),
  );

  server.registerTool(
    "save_document",
    {
      title: "Save document",
      description: "Create (no `id`) or update (`id`) a document → {id, title, slugId}. Create requires `title`; `project` (name or id) resolves server-side.",
      inputSchema: {
        id: z.string().optional().describe("Document id to UPDATE; omit to create"),
        title: z.string().optional().describe("Title (required on create)"),
        content: z.string().optional().describe("Markdown content"),
        project: z.string().optional().describe("Project name or id to attach the doc to"),
      },
    },
    async (args) => jsonContent(await saveDocument(args)),
  );

  server.registerTool(
    "list_issue_labels",
    {
      title: "List issue labels",
      description: "List issue labels → [{id, name, color, isGroup}]. Optional `name` filter.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Max rows (default 50)"),
        name: z.string().optional().describe("Filter by exact label name"),
      },
    },
    async (args) => jsonContent(await listIssueLabels(args)),
  );

  server.registerTool(
    "list_project_labels",
    {
      title: "List project labels",
      description: "List project labels → [{id, name, color, isGroup}]. Optional `name` filter.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Max rows (default 50)"),
        name: z.string().optional().describe("Filter by exact label name"),
      },
    },
    async (args) => jsonContent(await listProjectLabels(args)),
  );

  server.registerTool(
    "create_issue_label",
    {
      title: "Create issue label",
      description: "Create an issue label → {id, name, color}. `team` (name or id) scopes it to a team; omit for a workspace label.",
      inputSchema: {
        name: z.string().describe("Label name"),
        color: z.string().optional().describe("Hex color, e.g. #bec2c8"),
        team: z.string().optional().describe("Team name or id (omit for a workspace label)"),
      },
    },
    async (args) => jsonContent(await createIssueLabel(args)),
  );

  server.registerTool(
    "list_issue_statuses",
    {
      title: "List issue statuses",
      description: "List workflow states → [{id, name, type, color}]. Optional `team` (name or id) scope.",
      inputSchema: {
        team: z.string().optional().describe("Team name or id to scope to"),
        limit: z.number().int().positive().optional().describe("Max rows (default 50)"),
      },
    },
    async (args) => jsonContent(await listIssueStatuses(args)),
  );

  server.registerTool(
    "get_issue_status",
    {
      title: "Get issue status",
      description: "Get one workflow state → {id, name, type, color}.",
      inputSchema: { id: z.string().describe("Workflow state id") },
    },
    async ({ id }) => jsonContent(await getIssueStatus(id)),
  );

  server.registerTool(
    "list_cycles",
    {
      title: "List cycles",
      description: "List cycles → [{id, number, name, startsAt, endsAt}]. Optional `team` (name or id) scope.",
      inputSchema: {
        team: z.string().optional().describe("Team name or id to scope to"),
        limit: z.number().int().positive().optional().describe("Max rows (default 50)"),
      },
    },
    async (args) => jsonContent(await listCycles(args)),
  );

  server.registerTool(
    "get_status_updates",
    {
      title: "Get status updates",
      description: "Get one status update by `id`, or list a project's/initiative's updates → [{id, body, health, createdAt, url, authorName}]. `type` selects project vs initiative.",
      inputSchema: {
        type: z.enum(["project", "initiative"]).describe("Status update type"),
        project: z.string().optional().describe("Project name or id (when type=project)"),
        initiative: z.string().optional().describe("Initiative name or id (when type=initiative)"),
        id: z.string().optional().describe("Status update id — returns just that one"),
        limit: z.number().int().positive().optional().describe("Max rows when listing (default 50)"),
      },
    },
    async (args) => jsonContent(await getStatusUpdates(args)),
  );

  server.registerTool(
    "save_status_update",
    {
      title: "Save status update",
      description: "Create (no `id`) or update (`id`) a project/initiative status update → {id, url, health}. Create requires the matching parent (`project` or `initiative`).",
      inputSchema: {
        type: z.enum(["project", "initiative"]).describe("Status update type"),
        project: z.string().optional().describe("Project name or id (when type=project, on create)"),
        initiative: z.string().optional().describe("Initiative name or id (when type=initiative, on create)"),
        body: z.string().optional().describe("Update body (Markdown)"),
        health: z.enum(["onTrack", "atRisk", "offTrack"]).optional().describe("Health"),
        id: z.string().optional().describe("Status update id to UPDATE; omit to create"),
      },
    },
    async (args) => jsonContent(await saveStatusUpdate(args)),
  );

  // --- hosted-MCP proxy fallback --------------------------------------------
  // The few tools Linear's PUBLIC GraphQL cannot back (verified
  // absent from the schema): forwarded verbatim to the hosted Linear MCP. See
  // src/proxy.ts. Each handler returns the upstream result untouched.

  server.registerTool(
    "search_documentation",
    {
      title: "Search documentation",
      description: "Search Linear's help-center documentation. Proxied to the hosted Linear MCP (no public GraphQL backing).",
      inputSchema: {
        query: z.string().describe("Search query"),
        page: z.number().int().nonnegative().optional().describe("Page number (default 0)"),
      },
    },
    async (args) => proxyToHostedMcp("search_documentation", args as Record<string, unknown>),
  );

  server.registerTool(
    "extract_images",
    {
      title: "Extract images",
      description: "Extract and fetch images from markdown content. Proxied to the hosted Linear MCP (content helper, no GraphQL backing).",
      inputSchema: { markdown: z.string().describe("Markdown containing image references") },
    },
    async (args) => proxyToHostedMcp("extract_images", args as Record<string, unknown>),
  );

  server.registerTool(
    "get_diff",
    {
      title: "Get diff",
      description: "Exact lookup for a Linear diff (review URL, PR URL/ID, slug, or full identifier). Proxied to the hosted Linear MCP (no public GraphQL backing).",
      inputSchema: { urlOrId: z.string().min(1).describe("Review URL, diff slug, PR id, identifier, or GitHub PR URL") },
    },
    async (args) => proxyToHostedMcp("get_diff", args as Record<string, unknown>),
  );

  server.registerTool(
    "get_diff_threads",
    {
      title: "Get diff threads",
      description: "Exact lookup for diff review threads. Proxied to the hosted Linear MCP (no public GraphQL backing).",
      inputSchema: {
        urlOrId: z.string().min(1).describe("Review URL, diff slug, PR id, identifier, or GitHub PR URL"),
        threadId: z.string().optional().describe("Top-level thread/comment id"),
        resolved: z.boolean().optional().describe("Filter by resolved state"),
        orderBy: z.enum(["createdAt", "updatedAt"]).optional().describe("Sort order"),
      },
    },
    async (args) => proxyToHostedMcp("get_diff_threads", args as Record<string, unknown>),
  );

  server.registerTool(
    "list_diffs",
    {
      title: "List diffs",
      description: "List Linear diff pull requests. Proxied to the hosted Linear MCP (no public GraphQL backing).",
      inputSchema: {
        query: z.string().optional().describe("Search by title, branch, PR number, or slug"),
        limit: z.number().int().positive().optional().describe("Max results (default 50)"),
        cursor: z.string().optional().describe("Next page cursor"),
        status: z.string().optional().describe("Filter by PR status"),
        owner: z.string().optional().describe("Filter by repo owner"),
        repo: z.string().optional().describe("Filter by repo name"),
        orderBy: z.enum(["createdAt", "updatedAt"]).optional().describe("Sort order"),
      },
    },
    async (args) => proxyToHostedMcp("list_diffs", args as Record<string, unknown>),
  );

  // --- escape hatch ----------------------------------------------------------
  // Arbitrary GraphQL against Linear via the same server-side client. The rare
  // need neither the lean default nor `full` covers; raw (untrimmed) result.
  // Bearer-gated like every tool (the /mcp endpoint gate); does NOT depend on
  // the hosted proxy.
  server.registerTool(
    "linear_graphql",
    {
      title: "Linear GraphQL (escape hatch)",
      description:
        "Run an arbitrary GraphQL query or mutation against Linear's API (https://api.linear.app/graphql) and return the raw result. For the rare need neither the lean default nor full:true covers. Example: linear_graphql({query: \"query($id:String!){ issue(id:$id){ identifier subscribers{ nodes{ name } } } }\", variables: {id: \"ENG-123\"}}). Bearer-gated like every tool; errors surface, never swallowed.",
      inputSchema: {
        query: z.string().describe("A GraphQL document (query or mutation)"),
        variables: z.record(z.unknown()).optional().describe("Variables object for the document"),
      },
    },
    async ({ query, variables }) => jsonContent(await linearGraphql({ query, variables })),
  );

  return server;
}
