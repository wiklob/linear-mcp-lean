import { GraphQLClient, gql } from "graphql-request";
import { parse } from "graphql";
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

/** True when the GraphQL document defines a mutation (or subscription) operation.
 *  Parses the document rather than regex-matching the raw string — GraphQL treats
 *  commas/whitespace as insignificant, so a leading-comma dodge (`,mutation {…}`)
 *  parses as a valid mutation but slips a regex anchored to `^`/`}`. Fails CLOSED:
 *  an unparseable document is treated as a mutation, so it requires the explicit
 *  opt-in below rather than being forwarded. */
function isMutation(query: string): boolean {
  try {
    return parse(query).definitions.some(
      (d) =>
        d.kind === "OperationDefinition" &&
        (d.operation === "mutation" || d.operation === "subscription"),
    );
  } catch {
    return true; // unparseable → fail closed (require LINEAR_GRAPHQL_ALLOW_MUTATION)
  }
}

/** Execute an arbitrary GraphQL query/mutation and return Linear's raw result. */
export async function linearGraphql(args: LinearGraphqlArgs): Promise<unknown> {
  // V-36 (§1 med): the escape hatch runs arbitrary GraphQL with the server's PAK, so
  // a leaked bearer could delete issues / rotate API keys via a raw mutation — wider
  // than the curated tool surface. Gate mutations read-only-by-default; a mutation
  // needs an explicit opt-in env flag. Reads are unaffected.
  if (isMutation(args.query) && process.env.LINEAR_GRAPHQL_ALLOW_MUTATION !== "1") {
    throw new Error(
      "linear_graphql: mutations are disabled by default (V-36 security hardening). " +
      "Set LINEAR_GRAPHQL_ALLOW_MUTATION=1 on the service to enable raw mutations.",
    );
  }
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

/**
 * HTML-entity-decode an incoming name filter before resolution (V-459). Names
 * sourced from HTML-ish surfaces arrive encoded ("Supply-side outreach &amp;
 * licensing"), and the exact-match name filter then resolves to no entity. A
 * name containing a LITERAL "&amp;" is vanishingly unlikely, so decoding is
 * strictly a robustness win. `&amp;` decodes last to avoid double-decoding.
 */
function decodeHtmlEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
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
  const name = decodeHtmlEntities(value);
  const data = await gqlClient().request<NodesById>(query, { name });
  const ids = (data[root]?.nodes ?? []).map((n) => n.id);
  if (ids.length === 0) {
    throw new Error(`unresolved ${kind} name: "${name}" — no ${kind} matched; pass a valid name or id`);
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
    name: decodeHtmlEntities(value),
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

// `full: true` superset — adds the markdown body, status, lead, dates, initiatives.
const GET_PROJECT_QUERY_FULL = gql`
  query GetProjectFull($id: String!) {
    project(id: $id) {
      id
      name
      description
      content
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
  content: string | null;
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
  content?: string | null;
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
    content: p.content ?? null,
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
  return [(await getTeam(decodeHtmlEntities(v))).id];
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
  const m = decodeHtmlEntities(args.milestone!);
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

// --- create_issue_relation (V-674) ------------------------------------------------
// The typed, scoped path for `issueRelationCreate`. `save_issue.blockedBy` only
// ever made `blocks`; every related / duplicate / similar link fell to
// `linear_graphql`, whose mutations the V-36 guard disables. This tool creates
// exactly one relation between two named issues — idempotently.

/** Linear's `IssueRelationType` enum (verified by live introspection). */
export const ISSUE_RELATION_TYPES = ["blocks", "duplicate", "related", "similar"] as const;
/** Types with no direction: A related-to B is the same link as B related-to A. */
const SYMMETRIC_RELATION_TYPES: ReadonlySet<string> = new Set(["related", "similar"]);

const ISSUE_RELATIONS_QUERY = gql`
  query IssueRelations($id: String!) {
    issue(id: $id) {
      id
      identifier
      relations(first: 250) {
        nodes {
          id
          type
          relatedIssue {
            id
          }
        }
      }
      inverseRelations(first: 250) {
        nodes {
          id
          type
          issue {
            id
          }
        }
      }
    }
  }
`;
const ISSUE_RELATION_CREATE_ACK = gql`
  mutation IssueRelationCreateAck($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      issueRelation {
        id
        type
      }
    }
  }
`;

export interface CreateIssueRelationArgs {
  /** The issue the relation hangs off (identifier or id) — the blocker for
   *  `blocks`, the duplicate for `duplicate`. */
  issue: string;
  /** The other issue (identifier or id). */
  related: string;
  /** blocks | duplicate | related | similar. */
  type: string;
}
/** The closed minimal ack `create_issue_relation` returns. `created: false` →
 *  an identical relation already existed and is returned untouched. */
export interface IssueRelationAck {
  id: string;
  type: string;
  issue: string;
  related: string;
  created: boolean;
}

/**
 * Create one relation `issue —type→ related`, returning `{id, type, issue,
 * related, created}`. Idempotent: an identical relation (same type, same
 * direction — either direction for the symmetric `related`/`similar`) is
 * returned with `created: false` instead of a duplicate being made.
 */
export async function createIssueRelation(args: CreateIssueRelationArgs): Promise<IssueRelationAck> {
  if (!args.issue || !args.related) throw new Error("create_issue_relation requires `issue` and `related`");
  if (!(ISSUE_RELATION_TYPES as readonly string[]).includes(args.type)) {
    throw new Error(
      `create_issue_relation: unknown relation type "${args.type}" — valid: ${ISSUE_RELATION_TYPES.join(", ")}`,
    );
  }
  const data = await gqlClient().request<{
    issue: {
      id: string;
      identifier: string;
      relations: { nodes: Array<{ id: string; type: string; relatedIssue: { id: string } | null }> };
      inverseRelations: { nodes: Array<{ id: string; type: string; issue: { id: string } | null }> };
    } | null;
  }>(ISSUE_RELATIONS_QUERY, { id: args.issue });
  if (!data.issue) throw new Error(`issue not found: ${args.issue}`);
  // Linear returns lowercase UUIDs; a passed-through uppercase id would miss the
  // idempotency match and the self-relation guard.
  const relatedId = (await resolveIssueUuid(args.related)).toLowerCase();
  if (relatedId === data.issue.id.toLowerCase()) throw new Error("create_issue_relation: an issue cannot relate to itself");

  const existing =
    data.issue.relations.nodes.find((r) => r.type === args.type && r.relatedIssue?.id.toLowerCase() === relatedId) ??
    (SYMMETRIC_RELATION_TYPES.has(args.type)
      ? data.issue.inverseRelations.nodes.find((r) => r.type === args.type && r.issue?.id.toLowerCase() === relatedId)
      : undefined);
  if (existing) {
    return { id: existing.id, type: existing.type, issue: data.issue.identifier, related: args.related, created: false };
  }

  const created = await gqlClient().request<{ issueRelationCreate: { issueRelation: { id: string; type: string } } }>(
    ISSUE_RELATION_CREATE_ACK,
    { input: { issueId: data.issue.id, relatedIssueId: relatedId, type: args.type } },
  );
  const r = created.issueRelationCreate.issueRelation;
  return { id: r.id, type: r.type, issue: data.issue.identifier, related: args.related, created: true };
}

// --- save_project -----------------------------------------------------------------

const PROJECT_CREATE = gql`
  mutation ProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      project {
        id
        name
        url
        status {
          name
        }
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
        status {
          name
        }
      }
    }
  }
`;
// Project statuses are workspace-level (not team-scoped like workflow states)
// and the root `projectStatuses` query takes no name filter — so the name→id
// resolution below fetches the (handful of) statuses and matches client-side.
const PROJECT_STATUSES = gql`
  query ProjectStatuses {
    projectStatuses {
      nodes {
        id
        name
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

/**
 * Resolve a project-status NAME ("Completed"/"Canceled"/…) to exactly one id.
 * A UUID passes through unchanged. Zero matches → loud throw that names the
 * statuses this workspace actually has; >1 (two statuses differing only in
 * case) → loud "ambiguous" throw. The project-lifecycle counterpart to
 * `resolveStateIdForTeam`.
 */
async function resolveProjectStatusId(value: string): Promise<string> {
  if (isId(value)) return value;
  const name = decodeHtmlEntities(value);
  const data = await gqlClient().request<{ projectStatuses: { nodes: Array<{ id: string; name: string }> } }>(
    PROJECT_STATUSES,
  );
  const all = data.projectStatuses?.nodes ?? [];
  const hits = all.filter((s) => s.name.toLowerCase() === name.toLowerCase());
  if (hits.length === 0) {
    throw new Error(
      `unresolved project status: "${name}" — no status matched; this workspace has: ${all
        .map((s) => s.name)
        .join(", ")}`,
    );
  }
  if (hits.length > 1) {
    throw new Error(`ambiguous project status: "${name}" matched ${hits.length} — pass an id`);
  }
  return hits[0].id;
}

// Project labels are a distinct entity from issue labels (resolveLabelIds would
// match issueLabels — wrong here) and a workspace has a handful, so the name→id
// resolution fetches them once per call and matches client-side, naming the
// labels that DO exist on a miss.
const PROJECT_LABELS_ALL = gql`
  query ProjectLabelsAll($first: Int) {
    projectLabels(first: $first) {
      nodes {
        id
        name
        isGroup
      }
    }
  }
`;

/**
 * Resolve project-label names-or-ids to ids. UUIDs pass through; a name matches
 * case-insensitively. Zero matches → loud throw naming the workspace's project
 * labels; >1 → "ambiguous"; a label GROUP → loud throw (Linear applies only
 * leaf labels). Only fetches when at least one entry is a name.
 */
async function resolveProjectLabelIds(values: string[]): Promise<string[]> {
  if (values.every(isId)) return values;
  const data = await gqlClient().request<{
    projectLabels: { nodes: Array<{ id: string; name: string; isGroup: boolean }> };
  }>(PROJECT_LABELS_ALL, { first: 250 });
  const all = data.projectLabels?.nodes ?? [];
  return values.map((value) => {
    if (isId(value)) return value;
    const name = decodeHtmlEntities(value);
    const hits = all.filter((l) => l.name.toLowerCase() === name.toLowerCase());
    if (hits.length === 0) {
      throw new Error(
        `unresolved project label: "${name}" — no project label matched; this workspace has: ${all
          .filter((l) => !l.isGroup)
          .map((l) => l.name)
          .join(", ")}`,
      );
    }
    if (hits.length > 1) {
      throw new Error(`ambiguous project label: "${name}" matched ${hits.length} — pass an id`);
    }
    if (hits[0].isGroup) {
      throw new Error(`project label "${name}" is a label group — pass one of its labels`);
    }
    return hits[0].id;
  });
}

/** The closed minimal ack `save_project` returns. `status` is the read-back of
 *  the project's lifecycle status after the write — the counterpart of
 *  `save_issue`'s `state`, and the only confirmation a status flip landed. */
export interface ProjectAck {
  id: string;
  name: string;
  url: string;
  status: string | null;
}
interface RawProjectAck {
  id: string;
  name: string;
  url: string;
  status: { name: string } | null;
}

export interface SaveProjectArgs {
  id?: string;
  team?: string;
  name?: string;
  description?: string;
  /** The long markdown body (Linear's `content`), distinct from the short
   *  `description` summary line. */
  content?: string;
  /** Project label names or ids — REPLACES the project's label set (`[]` clears). */
  labels?: string[];
  status?: string;
  addInitiatives?: string[];
}

/** Linear's cap on a project's `description` — the short summary line. The
 *  markdown body lives in `content`, which has no such cap. */
export const PROJECT_DESCRIPTION_MAX = 255;

/**
 * Map `description`/`content` onto the project input. Callers habitually send
 * the whole markdown body as `description`, which Linear rejects past 255
 * chars — so with no `content`, an over-long `description` becomes the
 * `content` and its first non-empty line (heading marks stripped, truncated)
 * the summary. With an explicit `content`, an over-long `description` is the
 * caller's mistake → a clear throw instead of Linear's validation envelope.
 */
export function projectTextInput(args: Pick<SaveProjectArgs, "description" | "content">): Record<string, string> {
  const input: Record<string, string> = {};
  if (args.content !== undefined) input.content = args.content;
  if (args.description === undefined) return input;
  if (args.description.length <= PROJECT_DESCRIPTION_MAX) {
    input.description = args.description;
    return input;
  }
  if (args.content !== undefined) {
    throw new Error(
      `save_project: \`description\` is ${args.description.length} chars; Linear caps it at ${PROJECT_DESCRIPTION_MAX} — put the body in \`content\` and keep \`description\` to a one-line summary`,
    );
  }
  input.content = args.description;
  const firstLine =
    args.description
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find((l) => l.length > 0) ?? "";
  // Cut never leaves a lone high surrogate (a split emoji) before the ellipsis.
  input.description =
    firstLine.length <= PROJECT_DESCRIPTION_MAX
      ? firstLine
      : `${firstLine.slice(0, PROJECT_DESCRIPTION_MAX - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
  return input;
}

/**
 * Create (no `id`) or update (`id`) a project, returning only `{id, name, url,
 * status}`. Create requires a `team` (Linear's `projectCreate` requires
 * `teamIds`). `status` moves the project between lifecycle statuses
 * (Backlog / Planned / In Progress / Completed / Canceled) by name or id.
 * `labels` (project-label names or ids) replaces the project's label set;
 * `content` sets the long markdown body (`description` is the short summary).
 * Initiatives are NOT a create-input field — each `addInitiatives` entry is
 * attached with a separate `initiativeToProjectCreate` after the project exists.
 */
export async function saveProject(args: SaveProjectArgs): Promise<ProjectAck> {
  let project: RawProjectAck;
  const text = projectTextInput(args);
  const statusId = args.status ? await resolveProjectStatusId(args.status) : undefined;
  const labelIds = args.labels ? await resolveProjectLabelIds(args.labels) : undefined;
  if (args.id) {
    const input: Record<string, unknown> = { ...text };
    if (args.name !== undefined) input.name = args.name;
    if (statusId !== undefined) input.statusId = statusId;
    if (labelIds !== undefined) input.labelIds = labelIds;
    const data = await gqlClient().request<{ projectUpdate: { project: RawProjectAck } }>(
      PROJECT_UPDATE,
      { id: args.id, input },
    );
    project = data.projectUpdate.project;
  } else {
    if (!args.name) throw new Error("save_project create requires `name`");
    if (!args.team) throw new Error("save_project create requires `team`");
    const teamId = await resolveOneId(resolveTeamIds, "team", args.team);
    const input: Record<string, unknown> = { name: args.name, teamIds: [teamId], ...text };
    if (statusId !== undefined) input.statusId = statusId;
    if (labelIds !== undefined) input.labelIds = labelIds;
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

  return {
    id: project.id,
    name: project.name,
    url: project.url,
    status: project.status?.name ?? null,
  };
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

// --- git automations: list_git_automation_states / delete_git_automation_state (V-674)
// A team's "move the issue to state X when its PR hits event Y" rules live in
// `Team.gitAutomationStates` (the `Team.*WorkflowState` fields read null). The
// delete is a config deletion, so it is kept narrow: one rule, by id, and only
// after reading it back from the named team — a stale or foreign id fails loud
// instead of reaching `gitAutomationStateDelete`. Nothing else (the team, the
// workflow state, a target branch) is ever deleted.

const TEAM_GIT_AUTOMATION_STATES = gql`
  query TeamGitAutomationStates($id: String!) {
    team(id: $id) {
      key
      gitAutomationStates(first: 100) {
        nodes {
          id
          event
          state {
            id
            name
          }
          targetBranch {
            branchPattern
          }
        }
      }
    }
  }
`;
const GIT_AUTOMATION_STATE_DELETE = gql`
  mutation GitAutomationStateDelete($id: String!) {
    gitAutomationStateDelete(id: $id) {
      success
    }
  }
`;

/** One git automation rule: on PR `event` (draft|start|review|mergeable|merge)
 *  move the issue to `state` (null = "no action"); `targetBranch` is the branch
 *  pattern the rule is scoped to, null for the team default. */
export interface FlatGitAutomationState {
  id: string;
  event: string;
  state: { id: string; name: string } | null;
  targetBranch: string | null;
}
interface RawGitAutomationStates {
  team: {
    key: string;
    gitAutomationStates: {
      nodes: Array<{
        id: string;
        event: string;
        state: { id: string; name: string } | null;
        targetBranch: { branchPattern: string } | null;
      }>;
    };
  } | null;
}

async function fetchGitAutomationStates(team: string): Promise<{ key: string; rows: FlatGitAutomationState[] }> {
  const teamId = await resolveOneId(resolveTeamIds, "team", team);
  const data = await gqlClient().request<RawGitAutomationStates>(TEAM_GIT_AUTOMATION_STATES, { id: teamId });
  if (!data.team) throw new Error(`team not found: "${team}" (by id, key, or name)`);
  return {
    key: data.team.key,
    rows: data.team.gitAutomationStates.nodes.map((g) => ({
      id: g.id,
      event: g.event,
      state: g.state ? { id: g.state.id, name: g.state.name } : null,
      targetBranch: g.targetBranch?.branchPattern ?? null,
    })),
  };
}

/** List a team's git automation rules → [{id, event, state, targetBranch}]. */
export async function listGitAutomationStates(args: { team: string }): Promise<FlatGitAutomationState[]> {
  return (await fetchGitAutomationStates(args.team)).rows;
}

/** The closed minimal ack `delete_git_automation_state` returns — what was removed. */
export interface GitAutomationStateDeleteAck {
  deleted: string;
  team: string;
  event: string;
  state: string | null;
}

/**
 * Delete exactly one git automation rule by `id`, which must belong to `team`
 * (read back first). An id not on that team → loud throw listing the team's
 * rules, and no mutation is sent.
 */
export async function deleteGitAutomationState(args: {
  id: string;
  team: string;
}): Promise<GitAutomationStateDeleteAck> {
  if (!args.id || !args.team) throw new Error("delete_git_automation_state requires `id` and `team`");
  const { key, rows } = await fetchGitAutomationStates(args.team);
  const hit = rows.find((r) => r.id === args.id);
  if (!hit) {
    throw new Error(
      `no git automation state ${args.id} on team ${key}` +
        (rows.length
          ? ` — existing: ${rows.map((r) => `${r.id} (${r.event}→${r.state?.name ?? "no action"})`).join(", ")}`
          : " — the team has no git automation states"),
    );
  }
  const data = await gqlClient().request<{ gitAutomationStateDelete: { success: boolean } }>(
    GIT_AUTOMATION_STATE_DELETE,
    { id: hit.id },
  );
  if (!data.gitAutomationStateDelete.success) {
    throw new Error(`gitAutomationStateDelete reported failure for ${hit.id} on team ${key}`);
  }
  return { deleted: hit.id, team: key, event: hit.event, state: hit.state?.name ?? null };
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

// --- initiatives: save_initiative / list_initiatives / get_initiative ---------
// Initiatives were the one top-level Linear object with no typed tool (LEAN-14),
// so an agent could read them but never author one — and the raw `linear_graphql`
// escape hatch is read-only by default, so there was no workaround either. These
// three close the gap; the escape hatch stays read-only.
//
// Nesting is NOT an input field. Neither InitiativeCreateInput nor
// InitiativeUpdateInput carries a parent id (verified against the live schema) —
// the hierarchy is a separate entity, `InitiativeRelation`, whose `initiative` is
// the PARENT and whose `relatedInitiative` is the CHILD. So `parentInitiative` is
// applied with its own `initiativeRelationCreate` after the initiative exists,
// the same shape `save_project` uses for `addInitiatives`.

// Shared selections — the lean row and the `full: true` superset. Interpolated
// into the list/sub-list/get queries below so the four variants cannot drift.
const INITIATIVE_FIELDS = `
  id
  name
  status
  parentInitiative {
    name
  }
`;
const INITIATIVE_FIELDS_FULL = `
  ${INITIATIVE_FIELDS}
  description
  url
  targetDate
  startedAt
  completedAt
  owner {
    name
  }
  projects {
    nodes {
      name
    }
  }
`;

const LIST_INITIATIVES_QUERY = gql`
  query ListInitiatives($first: Int) {
    initiatives(first: $first) {
      nodes { ${INITIATIVE_FIELDS} }
    }
  }
`;
const LIST_INITIATIVES_QUERY_FULL = gql`
  query ListInitiativesFull($first: Int) {
    initiatives(first: $first) {
      nodes { ${INITIATIVE_FIELDS_FULL} }
    }
  }
`;
// The `parent` filter reads the parent's OWN `subInitiatives` rather than
// `InitiativeFilter.ancestors`: ancestors matches every descendant at any depth,
// where "list what is nested under X" means X's direct children.
const SUB_INITIATIVES_QUERY = gql`
  query SubInitiatives($id: String!, $first: Int) {
    initiative(id: $id) {
      subInitiatives(first: $first) {
        nodes { ${INITIATIVE_FIELDS} }
      }
    }
  }
`;
const SUB_INITIATIVES_QUERY_FULL = gql`
  query SubInitiativesFull($id: String!, $first: Int) {
    initiative(id: $id) {
      subInitiatives(first: $first) {
        nodes { ${INITIATIVE_FIELDS_FULL} }
      }
    }
  }
`;
const GET_INITIATIVE_QUERY = gql`
  query GetInitiative($id: String!) {
    initiative(id: $id) { ${INITIATIVE_FIELDS} }
  }
`;
const GET_INITIATIVE_QUERY_FULL = gql`
  query GetInitiativeFull($id: String!) {
    initiative(id: $id) { ${INITIATIVE_FIELDS_FULL} }
  }
`;

const INITIATIVE_CREATE = gql`
  mutation InitiativeCreate($input: InitiativeCreateInput!) {
    initiativeCreate(input: $input) {
      initiative {
        id
        name
        url
        status
      }
    }
  }
`;
const INITIATIVE_UPDATE_MUTATION = gql`
  mutation InitiativeUpdateMutation($id: String!, $input: InitiativeUpdateInput!) {
    initiativeUpdate(id: $id, input: $input) {
      initiative {
        id
        name
        url
        status
      }
    }
  }
`;
const INITIATIVE_PARENT_QUERY = gql`
  query InitiativeParent($id: String!) {
    initiative(id: $id) {
      parentInitiative {
        id
      }
    }
  }
`;
// `initiativeRelations` takes no filter argument, so the re-parent path fetches
// the workspace's relations and matches the child client-side — the same
// fetch-then-match shape `resolveProjectStatusId` uses, and bounded by the same
// reasoning: a workspace has a handful of initiatives, hence few relations.
const INITIATIVE_RELATIONS_QUERY = gql`
  query InitiativeRelations($first: Int) {
    initiativeRelations(first: $first) {
      nodes {
        id
        relatedInitiative {
          id
        }
      }
    }
  }
`;
const INITIATIVE_RELATION_CREATE = gql`
  mutation InitiativeRelationCreate($input: InitiativeRelationCreateInput!) {
    initiativeRelationCreate(input: $input) {
      success
    }
  }
`;
const INITIATIVE_RELATION_DELETE = gql`
  mutation InitiativeRelationDelete($id: String!) {
    initiativeRelationDelete(id: $id) {
      success
    }
  }
`;
// Error-path only: an unresolved `parentInitiative` name is far more actionable
// when the message names the initiatives that DO exist (a workspace has few).
// Never queried on the happy path.
const INITIATIVE_NAMES_QUERY = gql`
  query InitiativeNames($first: Int) {
    initiatives(first: $first) {
      nodes {
        name
      }
    }
  }
`;

/** Lean initiative row/object — the default shape of `list_initiatives` and
 *  `get_initiative`. `parentInitiative` is the nesting read-back. */
export interface FlatInitiative {
  id: string;
  name: string;
  status: string | null;
  parentInitiative: { name: string } | null;
}
/** The `full: true` superset — `FlatInitiative` plus the documented extras. */
export interface FlatInitiativeFull extends FlatInitiative {
  description: string | null;
  url: string | null;
  targetDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  ownerName: string | null;
  projects: string[];
}
interface RawInitiative {
  id: string;
  name: string;
  status: string | null;
  parentInitiative: { name: string } | null;
  // full-only
  description?: string | null;
  url?: string | null;
  targetDate?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  owner?: { name: string } | null;
  projects?: { nodes: Array<{ name: string }> } | null;
}

function flattenInitiative(i: RawInitiative): FlatInitiative {
  return {
    id: i.id,
    name: i.name,
    status: i.status ?? null,
    parentInitiative: i.parentInitiative ? { name: i.parentInitiative.name } : null,
  };
}

function flattenInitiativeFull(i: RawInitiative): FlatInitiativeFull {
  return {
    ...flattenInitiative(i),
    description: i.description ?? null,
    url: i.url ?? null,
    targetDate: i.targetDate ?? null,
    startedAt: i.startedAt ?? null,
    completedAt: i.completedAt ?? null,
    ownerName: i.owner?.name ?? null,
    projects: (i.projects?.nodes ?? []).map((n) => n.name),
  };
}

export interface ListInitiativesArgs {
  parent?: string;
  limit?: number;
  full?: boolean;
}

/**
 * List initiatives as lean rows; `parent` (name or id) narrows to that
 * initiative's direct sub-initiatives, `full: true` returns the documented
 * superset. An unknown `parent` name throws loudly (the shared resolver), never
 * silently lists the whole workspace.
 */
export async function listInitiatives(
  args: ListInitiativesArgs,
): Promise<FlatInitiative[] | FlatInitiativeFull[]> {
  const first = args.limit ?? 50;
  // FlatInitiativeFull extends FlatInitiative, so the widened signature types
  // both branches without a cast.
  const flatten: (i: RawInitiative) => FlatInitiative = args.full
    ? flattenInitiativeFull
    : flattenInitiative;
  if (args.parent) {
    const id = await resolveOneId(resolveInitiativeIds, "initiative", args.parent);
    const data = await gqlClient().request<{
      initiative: { subInitiatives: { nodes: RawInitiative[] } } | null;
    }>(args.full ? SUB_INITIATIVES_QUERY_FULL : SUB_INITIATIVES_QUERY, { id, first });
    if (!data.initiative) throw new Error(`initiative not found: ${args.parent}`);
    return data.initiative.subInitiatives.nodes.map(flatten);
  }
  const data = await gqlClient().request<{ initiatives: { nodes: RawInitiative[] } }>(
    args.full ? LIST_INITIATIVES_QUERY_FULL : LIST_INITIATIVES_QUERY,
    { first },
  );
  return data.initiatives.nodes.map(flatten);
}

/** Get one initiative. Default → the lean shape; `full: true` → the superset. */
export async function getInitiative(
  id: string,
  full = false,
): Promise<FlatInitiative | FlatInitiativeFull> {
  const data = await gqlClient().request<{ initiative: RawInitiative | null }>(
    full ? GET_INITIATIVE_QUERY_FULL : GET_INITIATIVE_QUERY,
    { id },
  );
  const i = data.initiative;
  if (!i) throw new Error(`initiative not found: ${id}`);
  return full ? flattenInitiativeFull(i) : flattenInitiative(i);
}

/** The closed minimal ack `save_initiative` returns. */
export interface InitiativeAck {
  id: string;
  name: string;
  url: string;
  status: string | null;
}
interface RawInitiativeAck {
  id: string;
  name: string;
  url: string;
  status: string | null;
}

export interface SaveInitiativeArgs {
  id?: string;
  name?: string;
  description?: string;
  parentInitiative?: string;
  status?: string;
  targetDate?: string;
  owner?: string;
  sortOrder?: number;
}

// `InitiativeStatus` is a closed GraphQL enum, not an entity — so unlike project
// statuses there is nothing to resolve over the wire. Match case-insensitively
// against the schema's values and throw loudly (naming them) on anything else,
// rather than letting Linear reject the whole mutation with a shape error.
const INITIATIVE_STATUSES = ["Proposed", "Planned", "Active", "Completed", "Canceled"] as const;

function resolveInitiativeStatus(value: string): string {
  const hit = INITIATIVE_STATUSES.find((s) => s.toLowerCase() === value.toLowerCase());
  if (!hit) {
    throw new Error(
      `unresolved initiative status: "${value}" — must be one of: ${INITIATIVE_STATUSES.join(", ")}`,
    );
  }
  return hit;
}

/**
 * Resolve a `parentInitiative` arg (name or id) to exactly one id via the shared
 * resolver, widening only the ZERO-match error to name the initiatives that do
 * exist. The ambiguous-match error is left alone — listing every initiative
 * would be noise when the caller's problem is that two share a name.
 */
async function resolveParentInitiativeId(value: string): Promise<string> {
  try {
    return await resolveOneId(resolveInitiativeIds, "initiative", value);
  } catch (err) {
    const message = (err as Error).message;
    if (!message.startsWith("unresolved initiative name")) throw err;
    const data = await gqlClient().request<{ initiatives: { nodes: Array<{ name: string }> } }>(
      INITIATIVE_NAMES_QUERY,
      { first: 250 },
    );
    const names = data.initiatives.nodes.map((n) => n.name);
    throw new Error(`${message}; this workspace has: ${names.join(", ")}`);
  }
}

/** Read an initiative's current parent id (null when it is top-level). */
async function currentParentInitiativeId(id: string): Promise<string | null> {
  const data = await gqlClient().request<{
    initiative: { parentInitiative: { id: string } | null } | null;
  }>(INITIATIVE_PARENT_QUERY, { id });
  if (!data.initiative) throw new Error(`initiative not found: ${id}`);
  return data.initiative.parentInitiative?.id ?? null;
}

/**
 * Turn a nesting failure into something a caller can act on. Linear gates
 * sub-initiatives behind the Enterprise plan — the schema introspects fine on
 * every plan, so this only surfaces when the relation mutation actually RUNS
 * (observed live 2026-09-15: `FEATURE_NOT_ACCESSIBLE`, "Subscribe to the
 * Enterprise plan"). Naming the plan gate stops an agent re-trying a request
 * that can never succeed on this workspace; any other error passes through
 * verbatim.
 */
function nestFailureMessage(err: unknown, ack: RawInitiativeAck): string {
  const raw = err instanceof Error ? err.message : String(err);
  const cause = /subInitiatives|FEATURE_NOT_ACCESSIBLE/.test(raw)
    ? "Linear gates sub-initiatives behind the Enterprise plan, so `parentInitiative` cannot be applied on this workspace"
    : raw;
  // The initiative itself is already written at this point — say so, and name
  // it, so the caller neither loses the id nor retries the whole save.
  return `save_initiative: nesting failed — ${cause}. The initiative itself WAS saved (${ack.id}, ${ack.url}); it is simply not nested.`;
}

/**
 * Nest `childId` under `parentId`. Idempotent: an initiative already under that
 * parent is left alone (no duplicate relation). Re-parenting deletes the old
 * relation first — creating a second one would leave the initiative with two
 * parents, a silently wrong tree. Only the relation is deleted, never an
 * initiative (initiative delete/archive stays out of the typed surface).
 */
async function nestInitiative(childId: string, parentId: string): Promise<void> {
  if (childId === parentId) {
    throw new Error("save_initiative: an initiative cannot be its own parentInitiative");
  }
  const existing = await currentParentInitiativeId(childId);
  if (existing === parentId) return;
  if (existing) {
    const data = await gqlClient().request<{
      initiativeRelations: { nodes: Array<{ id: string; relatedInitiative: { id: string } | null }> };
    }>(INITIATIVE_RELATIONS_QUERY, { first: 250 });
    const relation = data.initiativeRelations.nodes.find((n) => n.relatedInitiative?.id === childId);
    if (!relation) {
      throw new Error(
        `save_initiative: ${childId} reports a parent but no matching initiative relation was found — re-parent it in Linear`,
      );
    }
    await gqlClient().request(INITIATIVE_RELATION_DELETE, { id: relation.id });
  }
  await gqlClient().request(INITIATIVE_RELATION_CREATE, {
    input: { initiativeId: parentId, relatedInitiativeId: childId },
  });
}

/**
 * Create (no `id`) or update (`id`) an initiative, returning only `{id, name,
 * url, status}`. Create requires `name`. `owner` (name/id/"me") and
 * `parentInitiative` (name or id) resolve server-side; `parentInitiative` is
 * applied as a separate relation mutation after the write, so it works on both
 * create and update.
 */
export async function saveInitiative(args: SaveInitiativeArgs): Promise<InitiativeAck> {
  const input: Record<string, unknown> = {};
  if (args.name !== undefined) input.name = args.name;
  if (args.description !== undefined) input.description = args.description;
  if (args.targetDate !== undefined) input.targetDate = args.targetDate;
  if (args.sortOrder !== undefined) input.sortOrder = args.sortOrder;
  if (args.status !== undefined) input.status = resolveInitiativeStatus(args.status);
  if (args.owner) input.ownerId = await resolveOneId(resolveAssigneeIds, "owner", args.owner);

  // Resolve the parent BEFORE the write: an unknown parent name should fail
  // loudly without having half-created the initiative.
  const parentId = args.parentInitiative
    ? await resolveParentInitiativeId(args.parentInitiative)
    : undefined;
  // Caught before the write so the refusal costs nothing and cannot be mistaken
  // for a nesting failure that left an initiative behind.
  if (parentId && args.id === parentId) {
    throw new Error("save_initiative: an initiative cannot be its own parentInitiative");
  }

  let initiative: RawInitiativeAck;
  if (args.id) {
    const data = await gqlClient().request<{ initiativeUpdate: { initiative: RawInitiativeAck } }>(
      INITIATIVE_UPDATE_MUTATION,
      { id: args.id, input },
    );
    initiative = data.initiativeUpdate.initiative;
  } else {
    if (!args.name) throw new Error("save_initiative create requires `name`");
    const data = await gqlClient().request<{ initiativeCreate: { initiative: RawInitiativeAck } }>(
      INITIATIVE_CREATE,
      { input },
    );
    initiative = data.initiativeCreate.initiative;
  }

  if (parentId) {
    try {
      await nestInitiative(initiative.id, parentId);
    } catch (err) {
      throw new Error(nestFailureMessage(err, initiative));
    }
  }

  return {
    id: initiative.id,
    name: initiative.name,
    url: initiative.url,
    status: initiative.status ?? null,
  };
}
