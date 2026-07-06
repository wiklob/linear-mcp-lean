import { GraphQLClient, gql } from "graphql-request";
import { byteLogStore } from "./instrument.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";

function apiKey(): string {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY is not set");
  return key;
}

// The single upstream chokepoint. graphql-request deserializes the
// response body before any handler sees it, so we measure the raw Linear wire
// bytes here and add them into the active per-call ctx (set by runInstrumented).
// Clone-then-read: the original stream must stay unconsumed for graphql-request
// to parse it. Best-effort — a measurement failure never breaks the tool call.
const measuringFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const ctx = byteLogStore.getStore();
  if (ctx) {
    try {
      const body = await res.clone().text();
      ctx.upstreamBytes = (ctx.upstreamBytes ?? 0) + Buffer.byteLength(body);
    } catch {
      /* best-effort byte measurement; never fail the request */
    }
  }
  return res;
};

let client: GraphQLClient | null = null;

function gqlClient(): GraphQLClient {
  if (!client) {
    // Linear takes the Personal API Key RAW in `Authorization` — NO "Bearer" prefix.
    // (Distinct from the inbound MCP gate, which DOES use `Bearer`; see src/auth.ts.)
    client = new GraphQLClient(LINEAR_API_URL, { headers: { Authorization: apiKey() }, fetch: measuringFetch });
  }
  return client;
}

// --- linear_graphql escape hatch -----------------------------------------------
// Run an arbitrary GraphQL document against Linear via the same server-side
// client every tool uses. The rare-need tier neither the lean default nor
// `full` covers (a field/connection no tool selects, a one-off mutation). The
// raw result is returned UNTRIMMED by design — it is the escape hatch. Errors
// surface (graphql-request throws on a GraphQL/transport error → the MCP tool
// error), never swallowed. Bearer-gating is inherited from the
// `/mcp` endpoint, like every tool — no separate gate.

export interface LinearGraphqlArgs {
  query: string;
  variables?: Record<string, unknown>;
}

/** Execute an arbitrary GraphQL query/mutation and return Linear's raw result. */
export async function linearGraphql(args: LinearGraphqlArgs): Promise<unknown> {
  return gqlClient().request(args.query, args.variables ?? {});
}

// --- viewer resolution ----------------------------------------------------------

let cachedViewerId: string | null = null;

const VIEWER_QUERY = gql`
  query Viewer {
    viewer {
      id
    }
  }
`;

/** Resolve the API key's user id via a `viewer` query (cached). Backs `assignee: "me"`. */
export async function getViewerId(): Promise<string> {
  if (cachedViewerId) return cachedViewerId;
  const data = await gqlClient().request<{ viewer: { id: string } }>(VIEWER_QUERY);
  cachedViewerId = data.viewer.id;
  return cachedViewerId;
}

/**
 * Fresh (uncached) `viewer` probe — proves the API key actually reaches Linear.
 * Distinct from `getViewerId` (which caches): a readiness check must hit Linear
 * every time, so a later key revocation / the placeholder-key misconfig surfaces.
 * Throws on any transport/auth failure; the caller surfaces the message.
 */
export async function probeViewer(): Promise<{ id: string }> {
  const data = await gqlClient().request<{ viewer: { id: string } }>(VIEWER_QUERY);
  return { id: data.viewer.id };
}

/**
 * Map an assignee argument to a Linear user id. `"me"` resolves via the `viewer`
 * query; anything else is passed through unchanged.
 */
export async function resolveAssignee(assignee: string): Promise<string> {
  if (assignee === "me") return getViewerId();
  return assignee;
}

// --- get_issue ------------------------------------------------------------------

// Default selection. `projectMilestone` carries `id` alongside `name` so callers
// that bind milestones can read `milestone.id` off the default shape.
const GET_ISSUE_QUERY = gql`
  query GetIssue($id: String!) {
    issue(id: $id) {
      identifier
      title
      description
      gitBranchName: branchName
      url
      priority
      createdAt
      state {
        name
      }
      project {
        id
        name
      }
      projectMilestone {
        id
        name
      }
      labels {
        nodes {
          name
        }
      }
      attachments {
        nodes {
          url
        }
      }
      inverseRelations {
        nodes {
          type
          issue {
            identifier
          }
        }
      }
    }
  }
`;

// `full: true` superset. Adds the fields the hosted Linear MCP returns that the
// default drops — assignee, richer state, the lifecycle timestamps, parent,
// estimate, dueDate, updatedAt. Documented in README/FIELDS.md.
const GET_ISSUE_QUERY_FULL = gql`
  query GetIssueFull($id: String!) {
    issue(id: $id) {
      identifier
      title
      description
      gitBranchName: branchName
      url
      priority
      createdAt
      updatedAt
      startedAt
      completedAt
      canceledAt
      dueDate
      estimate
      state {
        id
        name
        type
      }
      assignee {
        name
      }
      parent {
        identifier
      }
      project {
        id
        name
      }
      projectMilestone {
        id
        name
      }
      labels {
        nodes {
          name
        }
      }
      attachments {
        nodes {
          url
        }
      }
      inverseRelations {
        nodes {
          type
          issue {
            identifier
          }
        }
      }
    }
  }
`;

/** The closed, minimal flattened shape `get_issue` returns by default. */
export interface FlatIssue {
  identifier: string;
  title: string;
  description: string | null;
  state: string | null;
  gitBranchName: string | null;
  project: { id: string; name: string } | null;
  url: string;
  attachments: string[];
  blockedBy: string[];
  labels: string[];
  milestone: { id: string; name: string } | null;
  priority: number;
  createdAt: string;
}

/** The `full: true` superset — `FlatIssue` plus the documented extra fields. */
export interface FlatIssueFull extends FlatIssue {
  updatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  dueDate: string | null;
  estimate: number | null;
  stateType: string | null;
  assigneeName: string | null;
  parent: string | null;
}

interface RawIssue {
  identifier: string;
  title: string;
  description: string | null;
  gitBranchName: string | null;
  url: string;
  priority: number;
  createdAt: string;
  state: { id?: string; name: string; type?: string } | null;
  project: { id: string; name: string } | null;
  projectMilestone: { id: string; name: string } | null;
  labels: { nodes: Array<{ name: string }> } | null;
  attachments: { nodes: Array<{ url: string }> } | null;
  inverseRelations: { nodes: Array<{ type: string; issue: { identifier: string } | null }> } | null;
  // full-only
  updatedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  assignee?: { name: string } | null;
  parent?: { identifier: string } | null;
}

/**
 * Fetch one issue and flatten it. Default (`full` falsy) → the closed minimal
 * contract; `full: true` → the documented richer superset, so "absent ⇒ lean"
 * holds.
 */
export async function getIssue(id: string, full = false): Promise<FlatIssue | FlatIssueFull> {
  const data = await gqlClient().request<{ issue: RawIssue | null }>(
    full ? GET_ISSUE_QUERY_FULL : GET_ISSUE_QUERY,
    { id },
  );
  const i = data.issue;
  if (!i) throw new Error(`issue not found: ${id}`);
  const base: FlatIssue = {
    identifier: i.identifier,
    title: i.title,
    description: i.description ?? null,
    state: i.state?.name ?? null,
    gitBranchName: i.gitBranchName ?? null,
    project: i.project ? { id: i.project.id, name: i.project.name } : null,
    url: i.url,
    attachments: (i.attachments?.nodes ?? []).map((n) => n.url),
    // blockedBy = issues that block THIS one = inverse "blocks" relations.
    blockedBy: (i.inverseRelations?.nodes ?? [])
      .filter((n) => n.type === "blocks" && n.issue)
      .map((n) => n.issue!.identifier),
    labels: (i.labels?.nodes ?? []).map((n) => n.name),
    milestone: i.projectMilestone ? { id: i.projectMilestone.id, name: i.projectMilestone.name } : null,
    priority: i.priority,
    createdAt: i.createdAt,
  };
  if (!full) return base;
  return {
    ...base,
    updatedAt: i.updatedAt ?? null,
    startedAt: i.startedAt ?? null,
    completedAt: i.completedAt ?? null,
    canceledAt: i.canceledAt ?? null,
    dueDate: i.dueDate ?? null,
    estimate: i.estimate ?? null,
    stateType: i.state?.type ?? null,
    assigneeName: i.assignee?.name ?? null,
    parent: i.parent?.identifier ?? null,
  };
}

// --- name → id resolution -------------------------------------------------------
// Resolve state/label/project/assignee NAMES to ids server-side. An unresolved
// name throws a loud Error (surfaced as a tool error) rather than silently
// filtering on nothing — the explicit-resolution choice that makes
// "unresolved name → loud error, not silent null" true.

/** Linear entity ids are UUIDs; a UUID-shaped arg is treated as already-resolved. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isId(s: string): boolean {
  return UUID_RE.test(s);
}

const RESOLVE_STATES = gql`
  query ResolveStates($name: String!) {
    workflowStates(filter: { name: { eq: $name } }) {
      nodes {
        id
      }
    }
  }
`;
const RESOLVE_LABELS = gql`
  query ResolveLabels($name: String!) {
    issueLabels(filter: { name: { eq: $name } }) {
      nodes {
        id
      }
    }
  }
`;
const RESOLVE_PROJECTS = gql`
  query ResolveProjects($name: String!) {
    projects(filter: { name: { eq: $name } }) {
      nodes {
        id
      }
    }
  }
`;
const RESOLVE_USERS = gql`
  query ResolveUsers($name: String!) {
    users(filter: { name: { eq: $name } }) {
      nodes {
        id
      }
    }
  }
`;

type NodesById = Record<string, { nodes: Array<{ id: string }> }>;

/**
 * Resolve a name → list of matching ids via `query` (rooted at `root`). A
 * UUID-shaped value passes through unresolved. Zero matches → loud throw. The
 * id LIST (not a single id) handles same-named entities across teams: filtering
 * by `{ id: { in: ids } }` then matches any of them, which is the correct
 * "issues whose state is named X" semantics regardless of how many teams own an X.
 */
async function resolveIds(
  kind: string,
  query: string,
  root: string,
  value: string,
): Promise<string[]> {
  if (isId(value)) return [value];
  const data = await gqlClient().request<NodesById>(query, { name: value });
  const ids = (data[root]?.nodes ?? []).map((n) => n.id);
  if (ids.length === 0) {
    throw new Error(`unresolved ${kind} name: "${value}" — no ${kind} matched; pass a valid name or id`);
  }
  return ids;
}

const resolveStateIds = (v: string) => resolveIds("state", RESOLVE_STATES, "workflowStates", v);

// --- write-path state resolution: team-scoped -----------------------------------
// A bare state NAME ("In Progress"/"Done"/…) is ambiguous workspace-wide: every
// team owns one, so the global name filter matches N>1 and `resolveOneId` throws
// "ambiguous state name … matched N". The single-target write arg must be scoped
// to the issue's own team, where the name is unique. (The read/filter path keeps
// the global id-LIST `resolveStateIds` — `{ id: { in: ids } }` correctly matches
// any team's same-named state, so it stays correct there.)
const RESOLVE_STATES_FOR_TEAM = gql`
  query ResolveStatesForTeam($name: String!, $teamId: ID!) {
    workflowStates(filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }) {
      nodes {
        id
      }
    }
  }
`;

/**
 * Resolve a workflow-state NAME to exactly one id, scoped to `teamId`. A UUID
 * passes through unchanged. Zero matches → loud "unresolved state name" throw;
 * >1 (one team owning two same-named states — pathological) → loud "ambiguous"
 * throw. The write-path counterpart to `resolveStateIds`.
 */
async function resolveStateIdForTeam(value: string, teamId: string): Promise<string> {
  if (isId(value)) return value;
  const data = await gqlClient().request<NodesById>(RESOLVE_STATES_FOR_TEAM, {
    name: value,
    teamId,
  });
  const ids = (data.workflowStates?.nodes ?? []).map((n) => n.id);
  if (ids.length === 0) {
    throw new Error(
      `unresolved state name: "${value}" — no state matched in the target team; pass a valid name or id`,
    );
  }
  if (ids.length > 1) {
    throw new Error(
      `ambiguous state name: "${value}" matched ${ids.length} in the target team — pass an id`,
    );
  }
  return ids[0];
}
const resolveLabelIds = (v: string) => resolveIds("label", RESOLVE_LABELS, "issueLabels", v);
const resolveProjectIds = (v: string) => resolveIds("project", RESOLVE_PROJECTS, "projects", v);
/** `"me"` → viewer id (cached); any other value → user name/id resolution. */
async function resolveAssigneeIds(v: string): Promise<string[]> {
  if (v === "me") return [await getViewerId()];
  return resolveIds("assignee", RESOLVE_USERS, "users", v);
}

// --- list_issues -----------------------------------------------------------------
// Lean per-issue rows: no description/url/attachments/milestone (those live on
// the fuller `get_issue`). This two-stage trim is what makes a default row
// materially smaller than the hosted MCP's ~1.2KB/issue.

// Default selection. Beyond the lean scalars: (1) `projectMilestone { id }` +
// `state { type }` → exposed as `projectMilestone.id` / `statusType`, fields
// milestone-driven callers read off each row; (2) `pageInfo { hasNextPage
// endCursor }` + an `$after` cursor, so callers can page past the first ~50
// rows instead of silently truncating. `state { name type }` carries both the
// display name and the robust Done-ness signal.
const LIST_ISSUES_QUERY = gql`
  query ListIssues($filter: IssueFilter, $first: Int, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        identifier
        title
        priority
        createdAt
        gitBranchName: branchName
        state {
          name
          type
        }
        project {
          id
        }
        projectMilestone {
          id
        }
        labels {
          nodes {
            name
          }
        }
        inverseRelations {
          nodes {
            type
            issue {
              identifier
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// `full: true` superset — per-row richer fields (description, url,
// assignee, milestone name, updatedAt) inside the same `{issues, hasNextPage,
// cursor}` envelope.
const LIST_ISSUES_QUERY_FULL = gql`
  query ListIssuesFull($filter: IssueFilter, $first: Int, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        identifier
        title
        description
        url
        priority
        createdAt
        updatedAt
        gitBranchName: branchName
        state {
          name
          type
        }
        assignee {
          name
        }
        project {
          id
        }
        projectMilestone {
          id
          name
        }
        labels {
          nodes {
            name
          }
        }
        inverseRelations {
          nodes {
            type
            issue {
              identifier
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** The closed, minimal lean row `list_issues` returns by default. */
export interface FlatIssueRow {
  identifier: string;
  title: string;
  state: string | null;
  statusType: string | null;
  priority: number;
  createdAt: string;
  blockedBy: string[];
  labels: string[];
  project: { id: string } | null;
  projectMilestone: { id: string } | null;
  gitBranchName: string | null;
}

/** The `full: true` superset row — `FlatIssueRow` plus the documented extras. */
export interface FlatIssueRowFull extends FlatIssueRow {
  description: string | null;
  url: string | null;
  updatedAt: string | null;
  assigneeName: string | null;
  milestone: { id: string; name: string | null } | null;
}

/**
 * The `list_issues` response envelope — matches the hosted Linear MCP's shape
 * exactly: the rows under the entity key `issues`, plus the two top-level
 * pagination siblings callers loop on. `cursor` is an opaque pass-through
 * (Linear's `endCursor` forwarded verbatim) the caller passes straight back.
 */
export interface ListIssuesResult {
  issues: FlatIssueRow[] | FlatIssueRowFull[];
  hasNextPage: boolean;
  cursor: string | null;
}

interface RawIssueRow {
  identifier: string;
  title: string;
  priority: number;
  createdAt: string;
  gitBranchName: string | null;
  state: { name: string; type?: string } | null;
  project: { id: string } | null;
  // `name` only selected by LIST_ISSUES_QUERY_FULL; optional so the default query
  // (which selects `projectMilestone { id }`) type-checks too.
  projectMilestone: { id: string; name?: string | null } | null;
  labels: { nodes: Array<{ name: string }> } | null;
  inverseRelations: { nodes: Array<{ type: string; issue: { identifier: string } | null }> } | null;
  // full-only
  description?: string | null;
  url?: string | null;
  updatedAt?: string | null;
  assignee?: { name: string } | null;
}

export interface ListIssuesArgs {
  state?: string;
  limit?: number;
  project?: string;
  label?: string;
  assignee?: string;
  /** Case-insensitive substring matched over title OR description — lets a
   *  caller find an existing ticket by text without falling back to the raw
   *  `linear_graphql` escape hatch. AND-ed with the other filters (Linear AND-s
   *  top-level `IssueFilter` fields; the `or` branch OR-s the
   *  title/description sub-filters). */
  query?: string;
  team?: string;
  includeCompleted?: boolean;
  cursor?: string;
  full?: boolean;
}

function flattenIssueRow(i: RawIssueRow): FlatIssueRow {
  return {
    identifier: i.identifier,
    title: i.title,
    state: i.state?.name ?? null,
    statusType: i.state?.type ?? null,
    priority: i.priority,
    createdAt: i.createdAt,
    // blockedBy = issues that block THIS one = inverse "blocks" relations.
    blockedBy: (i.inverseRelations?.nodes ?? [])
      .filter((n) => n.type === "blocks" && n.issue)
      .map((n) => n.issue!.identifier),
    labels: (i.labels?.nodes ?? []).map((n) => n.name),
    project: i.project ? { id: i.project.id } : null,
    projectMilestone: i.projectMilestone ? { id: i.projectMilestone.id } : null,
    gitBranchName: i.gitBranchName ?? null,
  };
}

function flattenIssueRowFull(i: RawIssueRow): FlatIssueRowFull {
  return {
    ...flattenIssueRow(i),
    description: i.description ?? null,
    url: i.url ?? null,
    updatedAt: i.updatedAt ?? null,
    assigneeName: i.assignee?.name ?? null,
    milestone: i.projectMilestone
      ? { id: i.projectMilestone.id, name: i.projectMilestone.name ?? null }
      : null,
  };
}

/**
 * List issues with server-side name resolution on every filter arg, returning
 * the `{issues, hasNextPage, cursor}` envelope. Pass `cursor` (from a prior
 * response) to page forward; `full: true` for the richer per-row superset.
 */
export async function listIssues(args: ListIssuesArgs): Promise<ListIssuesResult> {
  const filter: Record<string, unknown> = {};
  if (args.state) filter.state = { id: { in: await resolveStateIds(args.state) } };
  if (args.project) filter.project = { id: { in: await resolveProjectIds(args.project) } };
  if (args.label) filter.labels = { id: { in: await resolveLabelIds(args.label) } };
  if (args.assignee) filter.assignee = { id: { in: await resolveAssigneeIds(args.assignee) } };
  // Text search: match the substring over title OR description. `or` is a
  // top-level IssueFilter field, so it AND-s with the scalar filters above —
  // e.g. project AND (title~q OR description~q). No name resolution needed.
  if (args.query) {
    filter.or = [
      { title: { containsIgnoreCase: args.query } },
      { description: { containsIgnoreCase: args.query } },
    ];
  }
  if (args.team) filter.team = { id: { eq: (await getTeam(args.team)).id } };
  // includeCompleted defaults true (omit → no filter → unchanged). false + no explicit
  // state excludes terminal rows; an explicit `state` (which also writes filter.state) wins.
  if (args.includeCompleted === false && !args.state)
    filter.state = { type: { nin: ["completed", "canceled", "duplicate"] } };
  const data = await gqlClient().request<{
    issues: { nodes: RawIssueRow[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  }>(args.full ? LIST_ISSUES_QUERY_FULL : LIST_ISSUES_QUERY, {
    filter: Object.keys(filter).length ? filter : undefined,
    first: args.limit ?? 50,
    after: args.cursor,
  });
  const rows = args.full
    ? data.issues.nodes.map(flattenIssueRowFull)
    : data.issues.nodes.map(flattenIssueRow);
  return {
    issues: rows,
    hasNextPage: data.issues.pageInfo.hasNextPage,
    cursor: data.issues.pageInfo.endCursor ?? null,
  };
}

// --- list_projects / get_project -------------------------------------------------

const LIST_PROJECTS_QUERY = gql`
  query ListProjects($filter: ProjectFilter, $first: Int) {
    projects(filter: $filter, first: $first) {
      nodes {
        id
        name
        status {
          name
          type
        }
      }
    }
  }
`;

// `full: true` superset — adds description, labels, lead, dates, initiatives.
// `list_projects` result sets are small and filtered (consumed whole), so no
// pagination envelope is added; see FIELDS.md.
const LIST_PROJECTS_QUERY_FULL = gql`
  query ListProjectsFull($filter: ProjectFilter, $first: Int) {
    projects(filter: $filter, first: $first) {
      nodes {
        id
        name
        status {
          name
          type
        }
        description
        startDate
        targetDate
        lead {
          name
        }
        labels {
          nodes {
            name
          }
        }
        initiatives {
          nodes {
            name
          }
        }
      }
    }
  }
`;

/** Lean project row from `list_projects`. */
export interface FlatProjectRow {
  id: string;
  name: string;
  status: { name: string; type: string } | null;
}
/** The `full: true` superset project row. */
export interface FlatProjectRowFull extends FlatProjectRow {
  description: string | null;
  startDate: string | null;
  targetDate: string | null;
  leadName: string | null;
  labels: string[];
  initiatives: string[];
}
interface RawProjectRow {
  id: string;
  name: string;
  status?: { name: string; type: string } | null;
  description?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  lead?: { name: string } | null;
  labels?: { nodes: Array<{ name: string }> } | null;
  initiatives?: { nodes: Array<{ name: string }> } | null;
}

export interface ListProjectsArgs {
  state?: string;
  label?: string;
  team?: string;
  includeCompleted?: boolean;
  limit?: number;
  full?: boolean;
}

/** List projects. `state` is a lifecycle string (e.g. "started") — NOT a
 *  name→id entity; `label` is a project label, matched by name inline (project
 *  labels are a distinct entity from issueLabels, so resolveLabelIds — which
 *  resolves issue labels — would be wrong here).
 *  `full: true` returns the documented richer superset. */
export async function listProjects(
  args: ListProjectsArgs,
): Promise<FlatProjectRow[] | FlatProjectRowFull[]> {
  const filter: Record<string, unknown> = {};
  if (args.state) filter.state = { eq: args.state };
  if (args.label) filter.labels = { name: { eq: args.label } };
  if (args.team) filter.accessibleTeams = { some: { id: { eq: (await getTeam(args.team)).id } } };
  // includeCompleted defaults true (omit → no filter). false excludes terminal projects;
  // status is a distinct ProjectFilter key from the `state` lifecycle filter above (no collision).
  if (args.includeCompleted === false)
    filter.status = { type: { nin: ["completed", "canceled"] } };
  const data = await gqlClient().request<{ projects: { nodes: RawProjectRow[] } }>(
    args.full ? LIST_PROJECTS_QUERY_FULL : LIST_PROJECTS_QUERY,
    {
      filter: Object.keys(filter).length ? filter : undefined,
      first: args.limit ?? 50,
    },
  );
  if (!args.full) {
    return data.projects.nodes.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status ? { name: p.status.name, type: p.status.type } : null,
    }));
  }
  return data.projects.nodes.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status ? { name: p.status.name, type: p.status.type } : null,
    description: p.description ?? null,
    startDate: p.startDate ?? null,
    targetDate: p.targetDate ?? null,
    leadName: p.lead?.name ?? null,
    labels: (p.labels?.nodes ?? []).map((n) => n.name),
    initiatives: (p.initiatives?.nodes ?? []).map((n) => n.name),
  }));
}

const GET_PROJECT_QUERY = gql`
  query GetProject($id: String!) {
    project(id: $id) {
      id
      name
      description
      labels {
        nodes {
          name
        }
      }
    }
  }
`;

// `full: true` superset — adds status, lead, dates, initiatives.
const GET_PROJECT_QUERY_FULL = gql`
  query GetProjectFull($id: String!) {
    project(id: $id) {
      id
      name
      description
      status {
        name
        type
      }
      startDate
      targetDate
      lead {
        name
      }
      labels {
        nodes {
          name
        }
      }
      initiatives {
        nodes {
          name
        }
      }
    }
  }
`;

/** Fuller single project — exposes `labels[].name` alongside the description. */
export interface FlatProject {
  id: string;
  name: string;
  description: string | null;
  labels: string[];
}
/** The `full: true` superset single project. */
export interface FlatProjectFull extends FlatProject {
  status: { name: string; type: string } | null;
  startDate: string | null;
  targetDate: string | null;
  leadName: string | null;
  initiatives: string[];
}
interface RawProject {
  id: string;
  name: string;
  description: string | null;
  labels: { nodes: Array<{ name: string }> } | null;
  status?: { name: string; type: string } | null;
  startDate?: string | null;
  targetDate?: string | null;
  lead?: { name: string } | null;
  initiatives?: { nodes: Array<{ name: string }> } | null;
}

export async function getProject(id: string, full = false): Promise<FlatProject | FlatProjectFull> {
  const data = await gqlClient().request<{ project: RawProject | null }>(
    full ? GET_PROJECT_QUERY_FULL : GET_PROJECT_QUERY,
    { id },
  );
  const p = data.project;
  if (!p) throw new Error(`project not found: ${id}`);
  const base: FlatProject = {
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    labels: (p.labels?.nodes ?? []).map((n) => n.name),
  };
  if (!full) return base;
  return {
    ...base,
    status: p.status ? { name: p.status.name, type: p.status.type } : null,
    startDate: p.startDate ?? null,
    targetDate: p.targetDate ?? null,
    leadName: p.lead?.name ?? null,
    initiatives: (p.initiatives?.nodes ?? []).map((n) => n.name),
  };
}

// --- milestones -------------------------------------------------------------------

const LIST_MILESTONES_QUERY = gql`
  query ListMilestones($projectId: String!) {
    project(id: $projectId) {
      projectMilestones {
        nodes {
          id
          name
        }
      }
    }
  }
`;

/** Lean milestone row. */
export interface FlatMilestone {
  id: string;
  name: string;
  description?: string | null;
}
interface RawMilestone {
  id: string;
  name: string;
  description?: string | null;
}

/** List a project's milestones. `project` accepts a name or id (resolved). A
 *  name matching multiple projects throws (ambiguous) rather than silently
 *  listing only the first — milestones are project-scoped, so the wrong project
 *  would be a silent data error. */
export async function listMilestones(project: string): Promise<FlatMilestone[]> {
  const ids = await resolveProjectIds(project);
  if (ids.length > 1) {
    throw new Error(`ambiguous project name: "${project}" matched ${ids.length} projects — pass a project id`);
  }
  const projectId = ids[0];
  const data = await gqlClient().request<{ project: { projectMilestones: { nodes: RawMilestone[] } } | null }>(
    LIST_MILESTONES_QUERY,
    { projectId },
  );
  if (!data.project) throw new Error(`project not found: ${project}`);
  return data.project.projectMilestones.nodes.map((m) => ({ id: m.id, name: m.name }));
}

const GET_MILESTONE_QUERY = gql`
  query GetMilestone($id: String!) {
    projectMilestone(id: $id) {
      id
      name
      description
    }
  }
`;

export async function getMilestone(id: string): Promise<FlatMilestone> {
  const data = await gqlClient().request<{ projectMilestone: RawMilestone | null }>(GET_MILESTONE_QUERY, { id });
  const m = data.projectMilestone;
  if (!m) throw new Error(`milestone not found: ${id}`);
  return { id: m.id, name: m.name, description: m.description ?? null };
}

// --- list_comments ----------------------------------------------------------------

const LIST_COMMENTS_QUERY = gql`
  query ListComments($issueId: String!) {
    issue(id: $issueId) {
      comments {
        nodes {
          id
          body
          createdAt
          user {
            name
          }
        }
      }
    }
  }
`;

/** Flat comment — `authorName` flattens the (nullable) `user.name`. */
export interface FlatComment {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: string;
}
interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  user: { name: string } | null;
}

/** List comments on an issue. `issue` accepts an identifier (e.g. ENG-123) or id. */
export async function listComments(issue: string): Promise<FlatComment[]> {
  const data = await gqlClient().request<{ issue: { comments: { nodes: RawComment[] } } | null }>(
    LIST_COMMENTS_QUERY,
    { issueId: issue },
  );
  if (!data.issue) throw new Error(`issue not found: ${issue}`);
  return data.issue.comments.nodes.map((c) => ({
    id: c.id,
    body: c.body,
    // null-safe: bot/integration comments have no `user`.
    authorName: c.user?.name ?? null,
    createdAt: c.createdAt,
  }));
}

// =============================================================================
// WRITE TOOLS — minimal acks
// Each mutation selects only the ack fields, and each handler returns a CLOSED
// object literal (never a spread of the payload) so the full-object echo the
// hosted MCP returns is gone. All id-or-name args resolve via the resolvers above.
// =============================================================================

// --- extra name→id resolvers the writes need (teams, initiatives) -------------

const RESOLVE_INITIATIVES = gql`
  query ResolveInitiatives($name: String!) {
    initiatives(filter: { name: { eq: $name } }) {
      nodes {
        id
      }
    }
  }
`;
// Team name→id resolution is case-insensitive and key-aware. Route through
// `getTeam`, which matches over the team list by id, key, or case-folded
// name, so "Engineering" / "ENGINEERING" / "ENG" all resolve to the same
// team. A genuinely-unknown team still throws loudly (getTeam's
// "team not found" throw). Deliberately NOT a `{ name: { eq } }` filter, which
// would be case-sensitive and name-only.
const resolveTeamIds = async (v: string): Promise<string[]> => {
  if (isId(v)) return [v];
  return [(await getTeam(v)).id];
};
const resolveInitiativeIds = (v: string) =>
  resolveIds("initiative", RESOLVE_INITIATIVES, "initiatives", v);

/**
 * Resolve a name to EXACTLY one id for a single-target mutation arg
 * (state/team/project/assignee/label/initiative on one entity). `resolveIds`
 * already throws on zero matches; this adds the ambiguity guard (>1) so a
 * same-named entity across teams fails loud rather than silently picking one.
 */
async function resolveOneId(
  resolver: (v: string) => Promise<string[]>,
  kind: string,
  value: string,
): Promise<string> {
  const ids = await resolver(value);
  if (ids.length > 1) {
    throw new Error(`ambiguous ${kind} name: "${value}" matched ${ids.length} — pass an id`);
  }
  return ids[0];
}

const ISSUE_ID_QUERY = gql`
  query IssueId($id: String!) {
    issue(id: $id) {
      id
    }
  }
`;

/** Resolve an issue identifier (e.g. ENG-123) to its UUID. UUID passes through.
 *  Mutation inputs (issueRelationCreate, commentCreate) take real ids, so a
 *  bare identifier must be looked up first. */
async function resolveIssueUuid(idOrIdentifier: string): Promise<string> {
  if (isId(idOrIdentifier)) return idOrIdentifier;
  const data = await gqlClient().request<{ issue: { id: string } | null }>(ISSUE_ID_QUERY, {
    id: idOrIdentifier,
  });
  if (!data.issue) throw new Error(`issue not found: ${idOrIdentifier}`);
  return data.issue.id;
}

const ISSUE_TEAM_QUERY = gql`
  query IssueTeam($id: String!) {
    issue(id: $id) {
      team {
        id
      }
    }
  }
`;

/** Fetch an existing issue's team id (the update path) so a state NAME can be
 *  resolved scoped to that team. `issue(id:)` accepts a UUID or an
 *  identifier (e.g. ENG-123). */
async function resolveIssueTeamId(idOrIdentifier: string): Promise<string> {
  const data = await gqlClient().request<{ issue: { team: { id: string } | null } | null }>(
    ISSUE_TEAM_QUERY,
    { id: idOrIdentifier },
  );
  if (!data.issue) throw new Error(`issue not found: ${idOrIdentifier}`);
  if (!data.issue.team) {
    throw new Error(`issue ${idOrIdentifier} has no team — cannot resolve state name`);
  }
  return data.issue.team.id;
}

// --- save_issue -------------------------------------------------------------------

const ISSUE_CREATE = gql`
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      issue {
        id
        identifier
        url
        state {
          name
        }
      }
    }
  }
`;
const ISSUE_UPDATE = gql`
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      issue {
        id
        identifier
        url
        state {
          name
        }
      }
    }
  }
`;
const ISSUE_RELATION_CREATE = gql`
  mutation IssueRelationCreate($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
    }
  }
`;

export interface SaveIssueArgs {
  id?: string;
  title?: string;
  description?: string;
  team?: string;
  state?: string;
  assignee?: string;
  project?: string;
  milestone?: string;
  labels?: string[];
  blockedBy?: string[];
  priority?: number;
}

/** The closed minimal ack `save_issue` returns — and nothing else. */
export interface IssueAck {
  id: string;
  identifier: string;
  state: string | null;
  url: string;
}
interface RawIssueAck {
  id: string;
  identifier: string;
  url: string;
  state: { name: string } | null;
}

/** Resolve `milestone` (name or id) to a projectMilestone id. A name needs a
 *  project for context — reuse `listMilestones` (which carries the single-match
 *  project guard); a name without a project is a loud error. */
async function resolveMilestoneId(args: SaveIssueArgs): Promise<string> {
  const m = args.milestone!;
  if (isId(m)) return m;
  if (!args.project) {
    throw new Error(
      `save_issue: milestone name "${m}" needs a project to resolve — pass a milestone id, or include project`,
    );
  }
  const list = await listMilestones(args.project);
  const match = list.find((x) => x.name === m);
  if (!match) throw new Error(`unresolved milestone name: "${m}" in project "${args.project}"`);
  return match.id;
}

/**
 * Create (no `id`) or update (`id`) an issue, returning only `{id, identifier,
 * state, url}`. Every id-or-name arg resolves server-side. `blockedBy` is NOT a
 * create-input field in Linear — each blocker is wired with a separate
 * `issueRelationCreate` where the blocker `blocks` this issue (the inverse
 * relation `getIssue`/`flattenIssueRow` read back as `blockedBy`).
 */
export async function saveIssue(args: SaveIssueArgs): Promise<IssueAck> {
  const input: Record<string, unknown> = {};
  if (args.title !== undefined) input.title = args.title;
  if (args.description !== undefined) input.description = args.description;
  if (args.priority !== undefined) input.priority = args.priority;

  // Create requires title + team; resolve the team up front so a state
  // NAME can be scoped to it. On update the team comes from the existing issue
  // instead (fetched lazily below, only when a state name actually needs it).
  if (!args.id) {
    if (!args.title) throw new Error("save_issue create requires `title`");
    if (!args.team) throw new Error("save_issue create requires `team`");
    input.teamId = await resolveOneId(resolveTeamIds, "team", args.team);
  }

  // State-name resolution is team-scoped on the write path: a bare name
  // is ambiguous workspace-wide. Target team = the create `team` (above) or the
  // existing issue's team. A UUID `state` skips resolution and the team fetch.
  if (args.state) {
    if (isId(args.state)) {
      input.stateId = args.state;
    } else {
      const teamId = args.id ? await resolveIssueTeamId(args.id) : (input.teamId as string);
      input.stateId = await resolveStateIdForTeam(args.state, teamId);
    }
  }
  if (args.assignee) input.assigneeId = await resolveOneId(resolveAssigneeIds, "assignee", args.assignee);
  if (args.project) input.projectId = await resolveOneId(resolveProjectIds, "project", args.project);
  if (args.labels) {
    input.labelIds = await Promise.all(
      args.labels.map((l) => resolveOneId(resolveLabelIds, "label", l)),
    );
  }
  if (args.milestone) input.projectMilestoneId = await resolveMilestoneId(args);

  let issue: RawIssueAck;
  if (args.id) {
    const data = await gqlClient().request<{ issueUpdate: { issue: RawIssueAck } }>(ISSUE_UPDATE, {
      id: args.id,
      input,
    });
    issue = data.issueUpdate.issue;
  } else {
    const data = await gqlClient().request<{ issueCreate: { issue: RawIssueAck } }>(ISSUE_CREATE, {
      input,
    });
    issue = data.issueCreate.issue;
  }

  // Each blocker `blocks` THIS issue → this issue is `blockedBy` it. Separate
  // mutation per relation; ids resolved to UUIDs first (mutation inputs are ids).
  if (args.blockedBy?.length) {
    for (const blocker of args.blockedBy) {
      const blockerId = await resolveIssueUuid(blocker);
      await gqlClient().request(ISSUE_RELATION_CREATE, {
        input: { issueId: blockerId, relatedIssueId: issue.id, type: "blocks" },
      });
    }
  }

  return {
    id: issue.id,
    identifier: issue.identifier,
    state: issue.state?.name ?? null,
    url: issue.url,
  };
}

// --- save_comment -----------------------------------------------------------------

const COMMENT_CREATE = gql`
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      comment {
        id
        url
      }
    }
  }
`;

/** The closed minimal ack `save_comment` returns. */
export interface CommentAck {
  id: string;
  url: string;
}

export interface SaveCommentArgs {
  issue: string;
  body: string;
}

/** Add a comment to an issue, returning only `{id, url}`. `issue` accepts an
 *  identifier or id (resolved to a UUID for the mutation input). */
export async function saveComment(args: SaveCommentArgs): Promise<CommentAck> {
  const issueId = await resolveIssueUuid(args.issue);
  const data = await gqlClient().request<{ commentCreate: { comment: { id: string; url: string } } }>(
    COMMENT_CREATE,
    { input: { issueId, body: args.body } },
  );
  const c = data.commentCreate.comment;
  return { id: c.id, url: c.url };
}

// --- save_project -----------------------------------------------------------------

const PROJECT_CREATE = gql`
  mutation ProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      project {
        id
        name
        url
      }
    }
  }
`;
const PROJECT_UPDATE = gql`
  mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      project {
        id
        name
        url
      }
    }
  }
`;
const INITIATIVE_TO_PROJECT_CREATE = gql`
  mutation InitiativeToProjectCreate($input: InitiativeToProjectCreateInput!) {
    initiativeToProjectCreate(input: $input) {
      success
    }
  }
`;

/** The closed minimal ack `save_project` returns. */
export interface ProjectAck {
  id: string;
  name: string;
  url: string;
}
interface RawProjectAck {
  id: string;
  name: string;
  url: string;
}

export interface SaveProjectArgs {
  id?: string;
  team?: string;
  name?: string;
  description?: string;
  addInitiatives?: string[];
}

/**
 * Create (no `id`) or update (`id`) a project, returning only `{id, name, url}`.
 * Create requires a `team` (Linear's `projectCreate` requires `teamIds`).
 * Initiatives are NOT a create-input field — each `addInitiatives` entry is
 * attached with a separate `initiativeToProjectCreate` after the project exists.
 */
export async function saveProject(args: SaveProjectArgs): Promise<ProjectAck> {
  let project: RawProjectAck;
  if (args.id) {
    const input: Record<string, unknown> = {};
    if (args.name !== undefined) input.name = args.name;
    if (args.description !== undefined) input.description = args.description;
    const data = await gqlClient().request<{ projectUpdate: { project: RawProjectAck } }>(
      PROJECT_UPDATE,
      { id: args.id, input },
    );
    project = data.projectUpdate.project;
  } else {
    if (!args.name) throw new Error("save_project create requires `name`");
    if (!args.team) throw new Error("save_project create requires `team`");
    const teamId = await resolveOneId(resolveTeamIds, "team", args.team);
    const input: Record<string, unknown> = { name: args.name, teamIds: [teamId] };
    if (args.description !== undefined) input.description = args.description;
    const data = await gqlClient().request<{ projectCreate: { project: RawProjectAck } }>(
      PROJECT_CREATE,
      { input },
    );
    project = data.projectCreate.project;
  }

  if (args.addInitiatives?.length) {
    for (const ini of args.addInitiatives) {
      const initiativeId = await resolveOneId(resolveInitiativeIds, "initiative", ini);
      await gqlClient().request(INITIATIVE_TO_PROJECT_CREATE, {
        input: { initiativeId, projectId: project.id },
      });
    }
  }

  return { id: project.id, name: project.name, url: project.url };
}

// --- save_milestone ---------------------------------------------------------------

const MILESTONE_CREATE = gql`
  mutation MilestoneCreate($input: ProjectMilestoneCreateInput!) {
    projectMilestoneCreate(input: $input) {
      projectMilestone {
        id
        name
      }
    }
  }
`;
const MILESTONE_UPDATE = gql`
  mutation MilestoneUpdate($id: String!, $input: ProjectMilestoneUpdateInput!) {
    projectMilestoneUpdate(id: $id, input: $input) {
      projectMilestone {
        id
        name
      }
    }
  }
`;

/** The closed minimal ack `save_milestone` returns. */
export interface MilestoneAck {
  id: string;
  name: string;
}

export interface SaveMilestoneArgs {
  id?: string;
  project?: string;
  name?: string;
  description?: string;
}

/** Create (no `id`) or update (`id`) a project milestone, returning only
 *  `{id, name}`. Create requires `project` (name or id, resolved to one). */
export async function saveMilestone(args: SaveMilestoneArgs): Promise<MilestoneAck> {
  let m: MilestoneAck;
  if (args.id) {
    const input: Record<string, unknown> = {};
    if (args.name !== undefined) input.name = args.name;
    if (args.description !== undefined) input.description = args.description;
    const data = await gqlClient().request<{ projectMilestoneUpdate: { projectMilestone: MilestoneAck } }>(
      MILESTONE_UPDATE,
      { id: args.id, input },
    );
    m = data.projectMilestoneUpdate.projectMilestone;
  } else {
    if (!args.name) throw new Error("save_milestone create requires `name`");
    if (!args.project) throw new Error("save_milestone create requires `project`");
    const projectId = await resolveOneId(resolveProjectIds, "project", args.project);
    const input: Record<string, unknown> = { projectId, name: args.name };
    if (args.description !== undefined) input.description = args.description;
    const data = await gqlClient().request<{ projectMilestoneCreate: { projectMilestone: MilestoneAck } }>(
      MILESTONE_CREATE,
      { input },
    );
    m = data.projectMilestoneCreate.projectMilestone;
  }
  return { id: m.id, name: m.name };
}

// =============================================================================
// LONG-TAIL TOOL COVERAGE
// Each tool below maps to a real Linear PUBLIC GraphQL operation, verified
// against the published schema SDL. Tools NOT backed by public
// GraphQL — search_documentation, extract_images, get_diff, get_diff_threads,
// list_diffs — are served by the hosted-MCP proxy in src/proxy.ts, not here.
// Every handler returns a CLOSED minimal shape and throws on not-found: the same
// "loud, never silent-null" discipline as the hot-path tools above.
// =============================================================================

// --- teams: get_team / list_teams --------------------------------------------

const TEAMS_QUERY = gql`
  query Teams($first: Int) {
    teams(first: $first) {
      nodes { id name key }
    }
  }
`;

export interface FlatTeam {
  id: string;
  name: string;
  key: string;
}

export interface ListTeamsArgs {
  limit?: number;
  query?: string;
}

/** List teams (id, name, key). `query` optionally filters by name/key substring. */
export async function listTeams(args: ListTeamsArgs): Promise<FlatTeam[]> {
  const data = await gqlClient().request<{ teams: { nodes: FlatTeam[] } }>(TEAMS_QUERY, {
    first: args.limit ?? 50,
  });
  let rows = data.teams.nodes;
  if (args.query) {
    const q = args.query.toLowerCase();
    rows = rows.filter((t) => t.name.toLowerCase().includes(q) || t.key.toLowerCase().includes(q));
  }
  return rows.map((t) => ({ id: t.id, name: t.name, key: t.key }));
}

/** Get one team by id, key, or name (matched over the team list — a workspace
 *  has few teams). Loud throw if none matches. */
export async function getTeam(query: string): Promise<FlatTeam> {
  const data = await gqlClient().request<{ teams: { nodes: FlatTeam[] } }>(TEAMS_QUERY, { first: 250 });
  const v = query.toLowerCase();
  const t = data.teams.nodes.find(
    (x) => x.id === query || x.key.toLowerCase() === v || x.name.toLowerCase() === v,
  );
  if (!t) throw new Error(`team not found: "${query}" (by id, key, or name)`);
  return { id: t.id, name: t.name, key: t.key };
}

// --- users: get_user / list_users --------------------------------------------

const USERS_QUERY = gql`
  query Users($first: Int) {
    users(first: $first) {
      nodes { id name displayName email active }
    }
  }
`;
const USER_QUERY = gql`
  query User($id: String!) {
    user(id: $id) { id name displayName email active }
  }
`;

export interface FlatUser {
  id: string;
  name: string;
  displayName: string;
  email: string;
  active: boolean;
}

export interface ListUsersArgs {
  limit?: number;
  query?: string;
}

export async function listUsers(args: ListUsersArgs): Promise<FlatUser[]> {
  const data = await gqlClient().request<{ users: { nodes: FlatUser[] } }>(USERS_QUERY, {
    first: args.limit ?? 50,
  });
  let rows = data.users.nodes;
  if (args.query) {
    const q = args.query.toLowerCase();
    rows = rows.filter((u) => [u.name, u.displayName, u.email].some((f) => f?.toLowerCase().includes(q)));
  }
  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    displayName: u.displayName,
    email: u.email,
    active: u.active,
  }));
}

/** Get one user by id, "me", or name (resolved server-side). */
export async function getUser(query: string): Promise<FlatUser> {
  let id = query;
  if (query === "me") id = await getViewerId();
  else if (!isId(query)) id = await resolveOneId(resolveAssigneeIds, "user", query);
  const data = await gqlClient().request<{ user: FlatUser | null }>(USER_QUERY, { id });
  const u = data.user;
  if (!u) throw new Error(`user not found: ${query}`);
  return { id: u.id, name: u.name, displayName: u.displayName, email: u.email, active: u.active };
}

// --- attachments: get_attachment / create_attachment /
//     prepare_attachment_upload / create_attachment_from_upload ---------------

const ATTACHMENT_QUERY = gql`
  query Attachment($id: String!) {
    attachment(id: $id) { id title subtitle url sourceType }
  }
`;
const ATTACHMENT_CREATE = gql`
  mutation AttachmentCreate($input: AttachmentCreateInput!) {
    attachmentCreate(input: $input) {
      attachment { id title url }
    }
  }
`;
const FILE_UPLOAD = gql`
  mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
    fileUpload(contentType: $contentType, filename: $filename, size: $size) {
      uploadFile {
        assetUrl
        uploadUrl
        headers { key value }
      }
    }
  }
`;

export interface FlatAttachment {
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
  sourceType: string | null;
}
interface RawAttachment {
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
  sourceType: string | null;
}

export async function getAttachment(id: string): Promise<FlatAttachment> {
  const data = await gqlClient().request<{ attachment: RawAttachment | null }>(ATTACHMENT_QUERY, { id });
  const a = data.attachment;
  if (!a) throw new Error(`attachment not found: ${id}`);
  return {
    id: a.id,
    title: a.title,
    subtitle: a.subtitle ?? null,
    url: a.url,
    sourceType: a.sourceType ?? null,
  };
}

/** The closed minimal ack the attachment writes return. */
export interface AttachmentAck {
  id: string;
  title: string;
  url: string;
}

export interface CreateAttachmentArgs {
  issue: string;
  url: string;
  title: string;
  subtitle?: string;
}

/** Link an external URL to an issue as an attachment. */
export async function createAttachment(args: CreateAttachmentArgs): Promise<AttachmentAck> {
  const issueId = await resolveIssueUuid(args.issue);
  const input: Record<string, unknown> = { issueId, url: args.url, title: args.title };
  if (args.subtitle !== undefined) input.subtitle = args.subtitle;
  const data = await gqlClient().request<{ attachmentCreate: { attachment: AttachmentAck } }>(
    ATTACHMENT_CREATE,
    { input },
  );
  const a = data.attachmentCreate.attachment;
  return { id: a.id, title: a.title, url: a.url };
}

export interface CreateAttachmentFromUploadArgs {
  issue: string;
  assetUrl: string;
  title?: string;
  subtitle?: string;
}

/** Link an already-uploaded Linear assetUrl to an issue (the finalize step after
 *  prepare_attachment_upload + the client-side byte PUT). */
export async function createAttachmentFromUpload(
  args: CreateAttachmentFromUploadArgs,
): Promise<AttachmentAck> {
  return createAttachment({
    issue: args.issue,
    url: args.assetUrl,
    title: args.title ?? args.assetUrl,
    subtitle: args.subtitle,
  });
}

export interface UploadPrep {
  assetUrl: string;
  uploadUrl: string;
  headers: Array<{ key: string; value: string }>;
  issue: string;
  title?: string;
  subtitle?: string;
}

export interface PrepareAttachmentUploadArgs {
  issue: string;
  filename: string;
  contentType: string;
  size: number;
  title?: string;
  subtitle?: string;
}

/** Prepare a direct file upload (`fileUpload` → presigned URL + signed headers).
 *  The raw byte PUT to `uploadUrl` happens client-side (send `headers` verbatim);
 *  then call create_attachment_from_upload with the returned `assetUrl`. */
export async function prepareAttachmentUpload(args: PrepareAttachmentUploadArgs): Promise<UploadPrep> {
  const data = await gqlClient().request<{
    fileUpload: {
      uploadFile: { assetUrl: string; uploadUrl: string; headers: Array<{ key: string; value: string }> } | null;
    };
  }>(FILE_UPLOAD, { contentType: args.contentType, filename: args.filename, size: args.size });
  const u = data.fileUpload.uploadFile;
  if (!u) throw new Error("fileUpload returned no uploadFile");
  return {
    assetUrl: u.assetUrl,
    uploadUrl: u.uploadUrl,
    headers: u.headers,
    issue: args.issue,
    title: args.title,
    subtitle: args.subtitle,
  };
}

// --- documents: get_document / list_documents / save_document ----------------

const DOCUMENT_QUERY = gql`
  query Document($id: String!) {
    document(id: $id) {
      id
      title
      content
      slugId
      updatedAt
      project { id }
    }
  }
`;
const DOCUMENTS_QUERY = gql`
  query Documents($first: Int) {
    documents(first: $first) {
      nodes { id title slugId updatedAt }
    }
  }
`;
const DOCUMENT_CREATE = gql`
  mutation DocumentCreate($input: DocumentCreateInput!) {
    documentCreate(input: $input) {
      document { id title slugId }
    }
  }
`;
const DOCUMENT_UPDATE = gql`
  mutation DocumentUpdate($id: String!, $input: DocumentUpdateInput!) {
    documentUpdate(id: $id, input: $input) {
      document { id title slugId }
    }
  }
`;

export interface FlatDocument {
  id: string;
  title: string;
  content: string | null;
  slugId: string;
  updatedAt: string;
  project: { id: string } | null;
}
interface RawDocument {
  id: string;
  title: string;
  content: string | null;
  slugId: string;
  updatedAt: string;
  project: { id: string } | null;
}

export async function getDocument(id: string): Promise<FlatDocument> {
  const data = await gqlClient().request<{ document: RawDocument | null }>(DOCUMENT_QUERY, { id });
  const d = data.document;
  if (!d) throw new Error(`document not found: ${id}`);
  return {
    id: d.id,
    title: d.title,
    content: d.content ?? null,
    slugId: d.slugId,
    updatedAt: d.updatedAt,
    project: d.project ? { id: d.project.id } : null,
  };
}

/** Lean document row (no `content` — that lives on the fuller `get_document`). */
export interface FlatDocumentRow {
  id: string;
  title: string;
  slugId: string;
  updatedAt: string;
}
export async function listDocuments(args: { limit?: number }): Promise<FlatDocumentRow[]> {
  const data = await gqlClient().request<{ documents: { nodes: FlatDocumentRow[] } }>(DOCUMENTS_QUERY, {
    first: args.limit ?? 50,
  });
  return data.documents.nodes.map((d) => ({
    id: d.id,
    title: d.title,
    slugId: d.slugId,
    updatedAt: d.updatedAt,
  }));
}

/** The closed minimal ack save_document returns. */
export interface DocumentAck {
  id: string;
  title: string;
  slugId: string;
}
export interface SaveDocumentArgs {
  id?: string;
  title?: string;
  content?: string;
  project?: string;
}

/** Create (no `id`) or update (`id`) a document. Create requires `title`;
 *  `project` (name or id) is resolved server-side. */
export async function saveDocument(args: SaveDocumentArgs): Promise<DocumentAck> {
  if (args.id) {
    const input: Record<string, unknown> = {};
    if (args.title !== undefined) input.title = args.title;
    if (args.content !== undefined) input.content = args.content;
    if (args.project) input.projectId = await resolveOneId(resolveProjectIds, "project", args.project);
    const data = await gqlClient().request<{ documentUpdate: { document: DocumentAck } }>(DOCUMENT_UPDATE, {
      id: args.id,
      input,
    });
    return data.documentUpdate.document;
  }
  if (!args.title) throw new Error("save_document create requires `title`");
  const input: Record<string, unknown> = { title: args.title };
  if (args.content !== undefined) input.content = args.content;
  if (args.project) input.projectId = await resolveOneId(resolveProjectIds, "project", args.project);
  const data = await gqlClient().request<{ documentCreate: { document: DocumentAck } }>(DOCUMENT_CREATE, {
    input,
  });
  return data.documentCreate.document;
}

// --- labels: list_issue_labels / create_issue_label / list_project_labels ----

const ISSUE_LABELS_QUERY = gql`
  query IssueLabels($filter: IssueLabelFilter, $first: Int) {
    issueLabels(filter: $filter, first: $first) {
      nodes { id name color isGroup }
    }
  }
`;
const ISSUE_LABEL_CREATE = gql`
  mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) {
      issueLabel { id name color }
    }
  }
`;
const PROJECT_LABELS_QUERY = gql`
  query ProjectLabels($filter: ProjectLabelFilter, $first: Int) {
    projectLabels(filter: $filter, first: $first) {
      nodes { id name color isGroup }
    }
  }
`;

export interface FlatLabel {
  id: string;
  name: string;
  color: string;
  isGroup: boolean;
}

export async function listIssueLabels(args: { limit?: number; name?: string }): Promise<FlatLabel[]> {
  const filter = args.name ? { name: { eq: args.name } } : undefined;
  const data = await gqlClient().request<{ issueLabels: { nodes: FlatLabel[] } }>(ISSUE_LABELS_QUERY, {
    filter,
    first: args.limit ?? 50,
  });
  return data.issueLabels.nodes.map((l) => ({ id: l.id, name: l.name, color: l.color, isGroup: l.isGroup }));
}

export async function listProjectLabels(args: { limit?: number; name?: string }): Promise<FlatLabel[]> {
  const filter = args.name ? { name: { eq: args.name } } : undefined;
  const data = await gqlClient().request<{ projectLabels: { nodes: FlatLabel[] } }>(PROJECT_LABELS_QUERY, {
    filter,
    first: args.limit ?? 50,
  });
  return data.projectLabels.nodes.map((l) => ({ id: l.id, name: l.name, color: l.color, isGroup: l.isGroup }));
}

/** The closed minimal ack create_issue_label returns. */
export interface LabelAck {
  id: string;
  name: string;
  color: string;
}
export interface CreateIssueLabelArgs {
  name: string;
  color?: string;
  team?: string;
}

/** Create an issue label. `team` (name or id) scopes it to a team; omit for a
 *  workspace-level label. */
export async function createIssueLabel(args: CreateIssueLabelArgs): Promise<LabelAck> {
  const input: Record<string, unknown> = { name: args.name };
  if (args.color !== undefined) input.color = args.color;
  if (args.team) input.teamId = await resolveOneId(resolveTeamIds, "team", args.team);
  const data = await gqlClient().request<{ issueLabelCreate: { issueLabel: LabelAck } }>(ISSUE_LABEL_CREATE, {
    input,
  });
  return data.issueLabelCreate.issueLabel;
}

// --- workflow states: list_issue_statuses / get_issue_status -----------------

const WORKFLOW_STATES_QUERY = gql`
  query WorkflowStates($filter: WorkflowStateFilter, $first: Int) {
    workflowStates(filter: $filter, first: $first) {
      nodes { id name type color }
    }
  }
`;
const WORKFLOW_STATE_QUERY = gql`
  query WorkflowState($id: String!) {
    workflowState(id: $id) { id name type color }
  }
`;

export interface FlatState {
  id: string;
  name: string;
  type: string;
  color: string;
}

/** List workflow states, optionally scoped to a `team` (name or id). */
export async function listIssueStatuses(args: { team?: string; limit?: number }): Promise<FlatState[]> {
  let filter: Record<string, unknown> | undefined;
  if (args.team) {
    filter = { team: { id: { eq: await resolveOneId(resolveTeamIds, "team", args.team) } } };
  }
  const data = await gqlClient().request<{ workflowStates: { nodes: FlatState[] } }>(WORKFLOW_STATES_QUERY, {
    filter,
    first: args.limit ?? 50,
  });
  return data.workflowStates.nodes.map((s) => ({ id: s.id, name: s.name, type: s.type, color: s.color }));
}

export async function getIssueStatus(id: string): Promise<FlatState> {
  const data = await gqlClient().request<{ workflowState: FlatState | null }>(WORKFLOW_STATE_QUERY, { id });
  const s = data.workflowState;
  if (!s) throw new Error(`workflow state not found: ${id}`);
  return { id: s.id, name: s.name, type: s.type, color: s.color };
}

// --- cycles: list_cycles -----------------------------------------------------

const CYCLES_QUERY = gql`
  query Cycles($filter: CycleFilter, $first: Int) {
    cycles(filter: $filter, first: $first) {
      nodes { id number name startsAt endsAt }
    }
  }
`;

export interface FlatCycle {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
}

/** List cycles, optionally scoped to a `team` (name or id). */
export async function listCycles(args: { team?: string; limit?: number }): Promise<FlatCycle[]> {
  let filter: Record<string, unknown> | undefined;
  if (args.team) {
    filter = { team: { id: { eq: await resolveOneId(resolveTeamIds, "team", args.team) } } };
  }
  const data = await gqlClient().request<{ cycles: { nodes: FlatCycle[] } }>(CYCLES_QUERY, {
    filter,
    first: args.limit ?? 50,
  });
  return data.cycles.nodes.map((c) => ({
    id: c.id,
    number: c.number,
    name: c.name ?? null,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
  }));
}

// --- status updates: get_status_updates / save_status_update -----------------
// Both tools span project AND initiative updates (the `type` arg), each its own
// GraphQL op family. `health` is a provider enum (on/atRisk/offTrack) passed and
// returned as a string.

const PROJECT_UPDATES_QUERY = gql`
  query ProjectUpdates($filter: ProjectUpdateFilter, $first: Int) {
    projectUpdates(filter: $filter, first: $first) {
      nodes { id body health createdAt url user { name } }
    }
  }
`;
const PROJECT_UPDATE_QUERY = gql`
  query ProjectUpdate($id: String!) {
    projectUpdate(id: $id) { id body health createdAt url user { name } }
  }
`;
const INITIATIVE_UPDATES_QUERY = gql`
  query InitiativeUpdates($filter: InitiativeUpdateFilter, $first: Int) {
    initiativeUpdates(filter: $filter, first: $first) {
      nodes { id body health createdAt url user { name } }
    }
  }
`;
const INITIATIVE_UPDATE_QUERY = gql`
  query InitiativeUpdate($id: String!) {
    initiativeUpdate(id: $id) { id body health createdAt url user { name } }
  }
`;
const PROJECT_UPDATE_CREATE = gql`
  mutation ProjectUpdateCreate($input: ProjectUpdateCreateInput!) {
    projectUpdateCreate(input: $input) { projectUpdate { id url health } }
  }
`;
const PROJECT_UPDATE_UPDATE = gql`
  mutation ProjectUpdateUpdate($id: String!, $input: ProjectUpdateUpdateInput!) {
    projectUpdateUpdate(id: $id, input: $input) { projectUpdate { id url health } }
  }
`;
const INITIATIVE_UPDATE_CREATE = gql`
  mutation InitiativeUpdateCreate($input: InitiativeUpdateCreateInput!) {
    initiativeUpdateCreate(input: $input) { initiativeUpdate { id url health } }
  }
`;
const INITIATIVE_UPDATE_UPDATE = gql`
  mutation InitiativeUpdateUpdate($id: String!, $input: InitiativeUpdateUpdateInput!) {
    initiativeUpdateUpdate(id: $id, input: $input) { initiativeUpdate { id url health } }
  }
`;

export type StatusUpdateType = "project" | "initiative";

export interface FlatStatusUpdate {
  id: string;
  body: string;
  health: string;
  createdAt: string;
  url: string;
  authorName: string | null;
}
interface RawStatusUpdate {
  id: string;
  body: string;
  health: string;
  createdAt: string;
  url: string;
  user: { name: string } | null;
}
function flattenStatusUpdate(u: RawStatusUpdate): FlatStatusUpdate {
  return {
    id: u.id,
    body: u.body,
    health: u.health,
    createdAt: u.createdAt,
    url: u.url,
    authorName: u.user?.name ?? null,
  };
}

export interface GetStatusUpdatesArgs {
  type: StatusUpdateType;
  project?: string;
  initiative?: string;
  id?: string;
  limit?: number;
}

/** Get one status update by `id`, or list a project's/initiative's updates. */
export async function getStatusUpdates(
  args: GetStatusUpdatesArgs,
): Promise<FlatStatusUpdate | FlatStatusUpdate[]> {
  if (args.id) {
    if (args.type === "project") {
      const data = await gqlClient().request<{ projectUpdate: RawStatusUpdate | null }>(PROJECT_UPDATE_QUERY, {
        id: args.id,
      });
      if (!data.projectUpdate) throw new Error(`project update not found: ${args.id}`);
      return flattenStatusUpdate(data.projectUpdate);
    }
    const data = await gqlClient().request<{ initiativeUpdate: RawStatusUpdate | null }>(
      INITIATIVE_UPDATE_QUERY,
      { id: args.id },
    );
    if (!data.initiativeUpdate) throw new Error(`initiative update not found: ${args.id}`);
    return flattenStatusUpdate(data.initiativeUpdate);
  }
  if (args.type === "project") {
    const filter = args.project
      ? { project: { id: { eq: await resolveOneId(resolveProjectIds, "project", args.project) } } }
      : undefined;
    const data = await gqlClient().request<{ projectUpdates: { nodes: RawStatusUpdate[] } }>(
      PROJECT_UPDATES_QUERY,
      { filter, first: args.limit ?? 50 },
    );
    return data.projectUpdates.nodes.map(flattenStatusUpdate);
  }
  const filter = args.initiative
    ? { initiative: { id: { eq: await resolveOneId(resolveInitiativeIds, "initiative", args.initiative) } } }
    : undefined;
  const data = await gqlClient().request<{ initiativeUpdates: { nodes: RawStatusUpdate[] } }>(
    INITIATIVE_UPDATES_QUERY,
    { filter, first: args.limit ?? 50 },
  );
  return data.initiativeUpdates.nodes.map(flattenStatusUpdate);
}

/** The closed minimal ack save_status_update returns. */
export interface StatusUpdateAck {
  id: string;
  url: string;
  health: string;
}
export interface SaveStatusUpdateArgs {
  type: StatusUpdateType;
  project?: string;
  initiative?: string;
  body?: string;
  health?: string;
  id?: string;
}

/** Create (no `id`) or update (`id`) a project/initiative status update. Create
 *  requires the matching parent (`project` or `initiative`, name or id). */
export async function saveStatusUpdate(args: SaveStatusUpdateArgs): Promise<StatusUpdateAck> {
  if (args.type === "project") {
    if (args.id) {
      const input: Record<string, unknown> = {};
      if (args.body !== undefined) input.body = args.body;
      if (args.health !== undefined) input.health = args.health;
      const data = await gqlClient().request<{ projectUpdateUpdate: { projectUpdate: StatusUpdateAck } }>(
        PROJECT_UPDATE_UPDATE,
        { id: args.id, input },
      );
      return data.projectUpdateUpdate.projectUpdate;
    }
    if (!args.project) throw new Error("save_status_update create (project) requires `project`");
    const input: Record<string, unknown> = {
      projectId: await resolveOneId(resolveProjectIds, "project", args.project),
    };
    if (args.body !== undefined) input.body = args.body;
    if (args.health !== undefined) input.health = args.health;
    const data = await gqlClient().request<{ projectUpdateCreate: { projectUpdate: StatusUpdateAck } }>(
      PROJECT_UPDATE_CREATE,
      { input },
    );
    return data.projectUpdateCreate.projectUpdate;
  }
  if (args.id) {
    const input: Record<string, unknown> = {};
    if (args.body !== undefined) input.body = args.body;
    if (args.health !== undefined) input.health = args.health;
    const data = await gqlClient().request<{ initiativeUpdateUpdate: { initiativeUpdate: StatusUpdateAck } }>(
      INITIATIVE_UPDATE_UPDATE,
      { id: args.id, input },
    );
    return data.initiativeUpdateUpdate.initiativeUpdate;
  }
  if (!args.initiative) throw new Error("save_status_update create (initiative) requires `initiative`");
  const input: Record<string, unknown> = {
    initiativeId: await resolveOneId(resolveInitiativeIds, "initiative", args.initiative),
  };
  if (args.body !== undefined) input.body = args.body;
  if (args.health !== undefined) input.health = args.health;
  const data = await gqlClient().request<{ initiativeUpdateCreate: { initiativeUpdate: StatusUpdateAck } }>(
    INITIATIVE_UPDATE_CREATE,
    { input },
  );
  return data.initiativeUpdateCreate.initiativeUpdate;
}
