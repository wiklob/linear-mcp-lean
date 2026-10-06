// Unit tests for the flatteners + name→id resolvers in src/linear.ts, mocking
// `fetch` at the GraphQL seam (the one chokepoint every tool call goes
// through). No Linear workspace, no key, no network — this is what lets fork
// PRs run the suite. Each test asserts BOTH directions of the contract:
//   - what we send upstream (query selection + server-side filter building),
//   - what we return downstream (closed flattened shapes — `toEqual` fails on
//     any extra field, which is exactly the "closed object" guarantee).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// UUID-shaped fixtures (the resolvers treat UUID args as already-resolved).
const U_TEAM = "aaaaaaaa-0000-4000-8000-00000000000a";
const U_PROJECT = "aaaaaaaa-0000-4000-8000-00000000000b";
const U_PROJECT2 = "aaaaaaaa-0000-4000-8000-00000000000c";
const U_STATE = "aaaaaaaa-0000-4000-8000-00000000000d";
const U_STATE2 = "aaaaaaaa-0000-4000-8000-00000000000e";
const U_LABEL = "aaaaaaaa-0000-4000-8000-00000000000f";
const U_MILESTONE = "aaaaaaaa-0000-4000-8000-000000000010";
const U_ISSUE = "aaaaaaaa-0000-4000-8000-000000000011";
const U_BLOCKER = "aaaaaaaa-0000-4000-8000-000000000012";
const U_USER = "aaaaaaaa-0000-4000-8000-000000000013";
const U_INITIATIVE = "aaaaaaaa-0000-4000-8000-000000000014";

interface Recorded {
  query: string;
  variables: Record<string, unknown>;
}

let recorded: Recorded[];
let queue: unknown[];

/** Queue GraphQL `data` payloads, consumed strictly in request order. */
function respond(...data: unknown[]): void {
  queue.push(...data);
}

beforeEach(() => {
  // Fresh module per test: src/linear.ts caches the GraphQLClient and the
  // viewer id at module level; resetModules keeps tests independent.
  vi.resetModules();
  recorded = [];
  queue = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    recorded.push({ query: body.query, variables: body.variables ?? {} });
    const data = queue.shift();
    if (data === undefined) {
      throw new Error(`mock fetch: no response queued for: ${body.query.slice(0, 80)}`);
    }
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const linear = () => import("../src/linear.js");

// --- shared raw fixtures ----------------------------------------------------

const RAW_ISSUE = {
  identifier: "LEAN-1",
  title: "Fix trim regression",
  description: "the body",
  gitBranchName: "wik/lean-1-fix",
  url: "https://linear.app/x/issue/LEAN-1",
  priority: 2,
  createdAt: "2026-07-01T00:00:00.000Z",
  state: { name: "Todo" },
  project: { id: U_PROJECT, name: "Wrapper" },
  projectMilestone: { id: U_MILESTONE, name: "M1" },
  labels: { nodes: [{ name: "bug" }, { name: "lean" }] },
  attachments: { nodes: [{ url: "https://a.example/1" }] },
  inverseRelations: {
    nodes: [
      { type: "blocks", issue: { identifier: "LEAN-2" } },
      { type: "duplicate", issue: { identifier: "LEAN-3" } },
      { type: "blocks", issue: null },
    ],
  },
};

const RAW_ROW = {
  identifier: "LEAN-4",
  title: "A row",
  priority: 3,
  createdAt: "2026-07-02T00:00:00.000Z",
  gitBranchName: null,
  state: { name: "In Progress", type: "started" },
  project: { id: U_PROJECT },
  projectMilestone: null,
  labels: { nodes: [] },
  inverseRelations: { nodes: [] },
};

const issuesPayload = (
  rows: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
) => ({ issues: { nodes: rows, pageInfo: { hasNextPage, endCursor } } });

const teamsPayload = { teams: { nodes: [{ id: U_TEAM, name: "Lean Wrapper", key: "LEAN" }] } };

// --- get_issue ----------------------------------------------------------------

describe("getIssue", () => {
  it("default: lean query, closed flattened shape", async () => {
    respond({ issue: RAW_ISSUE });
    const { getIssue } = await linear();
    const issue = await getIssue("LEAN-1");
    expect(recorded[0].query).toContain("query GetIssue(");
    expect(recorded[0].variables).toEqual({ id: "LEAN-1" });
    expect(issue).toEqual({
      identifier: "LEAN-1",
      title: "Fix trim regression",
      description: "the body",
      state: "Todo",
      gitBranchName: "wik/lean-1-fix",
      project: { id: U_PROJECT, name: "Wrapper" },
      url: "https://linear.app/x/issue/LEAN-1",
      attachments: ["https://a.example/1"],
      blockedBy: ["LEAN-2"], // only inverse "blocks" relations, null issue dropped
      labels: ["bug", "lean"],
      milestone: { id: U_MILESTONE, name: "M1" },
      priority: 2,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("full:true: full query, documented superset", async () => {
    respond({
      issue: {
        ...RAW_ISSUE,
        updatedAt: "2026-07-03T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
        canceledAt: null,
        dueDate: "2026-08-01",
        estimate: 3,
        state: { id: U_STATE, name: "Todo", type: "unstarted" },
        assignee: { name: "Wik" },
        parent: { identifier: "LEAN-9" },
      },
    });
    const { getIssue } = await linear();
    const issue = await getIssue("LEAN-1", true);
    expect(recorded[0].query).toContain("GetIssueFull");
    expect(issue).toMatchObject({
      identifier: "LEAN-1",
      updatedAt: "2026-07-03T00:00:00.000Z",
      startedAt: null,
      dueDate: "2026-08-01",
      estimate: 3,
      stateType: "unstarted",
      assigneeName: "Wik",
      parent: "LEAN-9",
    });
  });

  it("not found → loud throw", async () => {
    respond({ issue: null });
    const { getIssue } = await linear();
    await expect(getIssue("NOPE-1")).rejects.toThrow("issue not found: NOPE-1");
  });
});

// --- list_issues ----------------------------------------------------------------

describe("listIssues", () => {
  it("returns the {issues, hasNextPage, cursor} envelope with closed lean rows", async () => {
    respond(issuesPayload([RAW_ROW], true, "cursor-1"));
    const { listIssues } = await linear();
    const result = await listIssues({});
    expect(recorded[0].query).toContain("query ListIssues(");
    expect(recorded[0].variables).toEqual({ first: 50 }); // no filter, default limit
    expect(result).toEqual({
      issues: [
        {
          identifier: "LEAN-4",
          title: "A row",
          state: "In Progress",
          statusType: "started",
          priority: 3,
          createdAt: "2026-07-02T00:00:00.000Z",
          blockedBy: [],
          labels: [],
          project: { id: U_PROJECT },
          projectMilestone: null,
          gitBranchName: null,
        },
      ],
      hasNextPage: true,
      cursor: "cursor-1",
    });
  });

  it("resolves a state NAME server-side to an id-list filter", async () => {
    respond(
      { workflowStates: { nodes: [{ id: U_STATE }, { id: U_STATE2 }] } },
      issuesPayload([]),
    );
    const { listIssues } = await linear();
    await listIssues({ state: "In Progress" });
    expect(recorded[0].query).toContain("ResolveStates");
    expect(recorded[0].variables).toEqual({ name: "In Progress" });
    expect(recorded[1].variables.filter).toEqual({ state: { id: { in: [U_STATE, U_STATE2] } } });
  });

  it("passes a UUID state through without a resolution roundtrip", async () => {
    respond(issuesPayload([]));
    const { listIssues } = await linear();
    await listIssues({ state: U_STATE });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].variables.filter).toEqual({ state: { id: { in: [U_STATE] } } });
  });

  it("unresolved state name → loud throw, no issues query fired", async () => {
    respond({ workflowStates: { nodes: [] } });
    const { listIssues } = await linear();
    await expect(listIssues({ state: "Nope" })).rejects.toThrow('unresolved state name: "Nope"');
    expect(recorded).toHaveLength(1);
  });

  it("includeCompleted:false excludes terminal states server-side", async () => {
    respond(issuesPayload([]));
    const { listIssues } = await linear();
    await listIssues({ includeCompleted: false });
    expect(recorded[0].variables.filter).toEqual({
      state: { type: { nin: ["completed", "canceled", "duplicate"] } },
    });
  });

  it("an explicit state wins over includeCompleted:false", async () => {
    respond({ workflowStates: { nodes: [{ id: U_STATE }] } }, issuesPayload([]));
    const { listIssues } = await linear();
    await listIssues({ state: "Done", includeCompleted: false });
    expect(recorded[1].variables.filter).toEqual({ state: { id: { in: [U_STATE] } } });
  });

  it("query builds a title-OR-description contains filter", async () => {
    respond(issuesPayload([]));
    const { listIssues } = await linear();
    await listIssues({ query: "trim" });
    expect(recorded[0].variables.filter).toEqual({
      or: [
        { title: { containsIgnoreCase: "trim" } },
        { description: { containsIgnoreCase: "trim" } },
      ],
    });
  });

  it("team narrows server-side via getTeam (key, case-insensitive)", async () => {
    respond(teamsPayload, issuesPayload([]));
    const { listIssues } = await linear();
    await listIssues({ team: "lean" });
    expect(recorded[1].variables.filter).toEqual({ team: { id: { eq: U_TEAM } } });
  });

  it("full:true selects the full query and the richer row", async () => {
    respond(
      issuesPayload([
        {
          ...RAW_ROW,
          description: "d",
          url: "https://linear.app/x/issue/LEAN-4",
          updatedAt: "2026-07-03T00:00:00.000Z",
          assignee: { name: "Wik" },
          projectMilestone: { id: U_MILESTONE, name: "M1" },
        },
      ]),
    );
    const { listIssues } = await linear();
    const result = await listIssues({ full: true });
    expect(recorded[0].query).toContain("ListIssuesFull");
    expect(result.issues[0]).toMatchObject({
      description: "d",
      url: "https://linear.app/x/issue/LEAN-4",
      updatedAt: "2026-07-03T00:00:00.000Z",
      assigneeName: "Wik",
      milestone: { id: U_MILESTONE, name: "M1" },
    });
  });
});

// --- list_projects / get_project -------------------------------------------------

describe("listProjects", () => {
  it("lean rows are closed {id, name, status}", async () => {
    respond({
      projects: { nodes: [{ id: U_PROJECT, name: "Wrapper", status: { name: "In Progress", type: "started" } }] },
    });
    const { listProjects } = await linear();
    const rows = await listProjects({});
    expect(rows).toEqual([{ id: U_PROJECT, name: "Wrapper", status: { name: "In Progress", type: "started" } }]);
  });

  it("builds lifecycle/label filters inline and excludes completed on demand", async () => {
    respond({ projects: { nodes: [] } });
    const { listProjects } = await linear();
    await listProjects({ state: "started", label: "lean", includeCompleted: false });
    expect(recorded[0].variables.filter).toEqual({
      state: { eq: "started" },
      labels: { name: { eq: "lean" } },
      status: { type: { nin: ["completed", "canceled"] } },
    });
  });

  it("full:true flattens lead/labels/initiatives", async () => {
    respond({
      projects: {
        nodes: [
          {
            id: U_PROJECT,
            name: "Wrapper",
            status: null,
            description: "d",
            startDate: "2026-06-01",
            targetDate: null,
            lead: { name: "Wik" },
            labels: { nodes: [{ name: "lean" }] },
            initiatives: { nodes: [{ name: "Tooling" }] },
          },
        ],
      },
    });
    const { listProjects } = await linear();
    const rows = await listProjects({ full: true });
    expect(rows).toEqual([
      {
        id: U_PROJECT,
        name: "Wrapper",
        status: null,
        description: "d",
        startDate: "2026-06-01",
        targetDate: null,
        leadName: "Wik",
        labels: ["lean"],
        initiatives: ["Tooling"],
      },
    ]);
  });
});

describe("getProject", () => {
  it("default: closed {id, name, description, labels}", async () => {
    respond({
      project: { id: U_PROJECT, name: "Wrapper", description: "d", labels: { nodes: [{ name: "lean" }] } },
    });
    const { getProject } = await linear();
    expect(await getProject(U_PROJECT)).toEqual({
      id: U_PROJECT,
      name: "Wrapper",
      description: "d",
      labels: ["lean"],
    });
  });

  it("not found → loud throw", async () => {
    respond({ project: null });
    const { getProject } = await linear();
    await expect(getProject("nope")).rejects.toThrow("project not found: nope");
  });
});

// --- milestones -------------------------------------------------------------------

describe("listMilestones", () => {
  it("resolves a project name and lists its milestones", async () => {
    respond(
      { projects: { nodes: [{ id: U_PROJECT }] } },
      { project: { projectMilestones: { nodes: [{ id: U_MILESTONE, name: "M1" }] } } },
    );
    const { listMilestones } = await linear();
    expect(await listMilestones("Wrapper")).toEqual([{ id: U_MILESTONE, name: "M1" }]);
    expect(recorded[1].variables).toEqual({ projectId: U_PROJECT });
  });

  it("a name matching multiple projects throws instead of picking one", async () => {
    respond({ projects: { nodes: [{ id: U_PROJECT }, { id: U_PROJECT2 }] } });
    const { listMilestones } = await linear();
    await expect(listMilestones("Wrapper")).rejects.toThrow("ambiguous project name");
    expect(recorded).toHaveLength(1);
  });
});

// --- comments ---------------------------------------------------------------------

describe("listComments", () => {
  it("flattens authorName null-safely (bot comments carry no user)", async () => {
    respond({
      issue: {
        comments: {
          nodes: [
            { id: "c1", body: "hi", createdAt: "2026-07-01T00:00:00.000Z", user: { name: "Wik" } },
            { id: "c2", body: "beep", createdAt: "2026-07-02T00:00:00.000Z", user: null },
          ],
        },
      },
    });
    const { listComments } = await linear();
    expect(await listComments("LEAN-1")).toEqual([
      { id: "c1", body: "hi", authorName: "Wik", createdAt: "2026-07-01T00:00:00.000Z" },
      { id: "c2", body: "beep", authorName: null, createdAt: "2026-07-02T00:00:00.000Z" },
    ]);
  });
});

// --- save_issue -------------------------------------------------------------------

describe("saveIssue", () => {
  const CREATE_ACK = {
    issueCreate: {
      issue: { id: U_ISSUE, identifier: "LEAN-13", url: "https://linear.app/x/issue/LEAN-13", state: { name: "Todo" } },
    },
  };

  it("create requires title and team, before any request", async () => {
    const { saveIssue } = await linear();
    await expect(saveIssue({ team: "LEAN" })).rejects.toThrow("save_issue create requires `title`");
    await expect(saveIssue({ title: "t" })).rejects.toThrow("save_issue create requires `team`");
    expect(recorded).toHaveLength(0);
  });

  it("create resolves team, team-scoped state, project, labels; returns the minimal ack", async () => {
    respond(
      teamsPayload, // resolve team "LEAN"
      { workflowStates: { nodes: [{ id: U_STATE }] } }, // team-scoped state
      { projects: { nodes: [{ id: U_PROJECT }] } },
      { issueLabels: { nodes: [{ id: U_LABEL }] } },
      CREATE_ACK,
    );
    const { saveIssue } = await linear();
    const ack = await saveIssue({
      title: "New",
      description: "body",
      team: "LEAN",
      state: "Todo",
      project: "Wrapper",
      labels: ["bug"],
      priority: 1,
    });
    // The write path scopes the state NAME to the create team.
    expect(recorded[1].query).toContain("ResolveStatesForTeam");
    expect(recorded[1].variables).toEqual({ name: "Todo", teamId: U_TEAM });
    expect(recorded[4].variables).toEqual({
      input: {
        title: "New",
        description: "body",
        priority: 1,
        teamId: U_TEAM,
        stateId: U_STATE,
        projectId: U_PROJECT,
        labelIds: [U_LABEL],
      },
    });
    expect(ack).toEqual({
      id: U_ISSUE,
      identifier: "LEAN-13",
      state: "Todo",
      url: "https://linear.app/x/issue/LEAN-13",
    });
  });

  it("update resolves a state NAME scoped to the existing issue's team", async () => {
    respond(
      { issue: { team: { id: U_TEAM } } }, // IssueTeam lookup
      { workflowStates: { nodes: [{ id: U_STATE }] } },
      {
        issueUpdate: {
          issue: { id: U_ISSUE, identifier: "LEAN-1", url: "https://linear.app/x/issue/LEAN-1", state: { name: "Done" } },
        },
      },
    );
    const { saveIssue } = await linear();
    const ack = await saveIssue({ id: "LEAN-1", state: "Done" });
    expect(recorded[0].query).toContain("IssueTeam");
    expect(recorded[1].variables).toEqual({ name: "Done", teamId: U_TEAM });
    expect(ack.state).toBe("Done");
  });

  it("ambiguous team-scoped state name → loud throw", async () => {
    respond({ issue: { team: { id: U_TEAM } } }, { workflowStates: { nodes: [{ id: U_STATE }, { id: U_STATE2 }] } });
    const { saveIssue } = await linear();
    await expect(saveIssue({ id: "LEAN-1", state: "Done" })).rejects.toThrow("ambiguous state name");
  });

  it("blockedBy wires one issueRelationCreate per blocker: blocker blocks the new issue", async () => {
    respond(
      CREATE_ACK,
      { issue: { id: U_BLOCKER } }, // resolve LEAN-2 → UUID
      { issueRelationCreate: { success: true } },
    );
    const { saveIssue } = await linear();
    await saveIssue({ title: "New", team: U_TEAM, blockedBy: ["LEAN-2"] });
    expect(recorded[2].variables).toEqual({
      input: { issueId: U_BLOCKER, relatedIssueId: U_ISSUE, type: "blocks" },
    });
  });

  it("ambiguous project name on create → loud throw", async () => {
    respond(teamsPayload, { projects: { nodes: [{ id: U_PROJECT }, { id: U_PROJECT2 }] } });
    const { saveIssue } = await linear();
    await expect(saveIssue({ title: "t", team: "LEAN", project: "Wrapper" })).rejects.toThrow(
      "ambiguous project name",
    );
  });
});

// --- save_comment -----------------------------------------------------------------

describe("saveComment", () => {
  it("resolves the identifier to a UUID and returns the closed {id, url} ack", async () => {
    respond({ issue: { id: U_ISSUE } }, { commentCreate: { comment: { id: "c9", url: "https://c" } } });
    const { saveComment } = await linear();
    const ack = await saveComment({ issue: "LEAN-1", body: "hello" });
    expect(recorded[1].variables).toEqual({ input: { issueId: U_ISSUE, body: "hello" } });
    expect(ack).toEqual({ id: "c9", url: "https://c" });
  });
});

// --- create_issue_relation --------------------------------------------------------

describe("createIssueRelation", () => {
  const relations = (
    out: Array<{ id: string; type: string; to: string }> = [],
    inv: Array<{ id: string; type: string; from: string }> = [],
  ) => ({
    issue: {
      id: U_ISSUE,
      identifier: "LEAN-1",
      relations: { nodes: out.map((r) => ({ id: r.id, type: r.type, relatedIssue: { id: r.to } })) },
      inverseRelations: { nodes: inv.map((r) => ({ id: r.id, type: r.type, issue: { id: r.from } })) },
    },
  });

  it("resolves both identifiers, creates the relation, returns the closed ack", async () => {
    respond(
      relations(),
      { issue: { id: U_BLOCKER } }, // resolve LEAN-2 → UUID
      { issueRelationCreate: { issueRelation: { id: "r1", type: "related" } } },
    );
    const { createIssueRelation } = await linear();
    const ack = await createIssueRelation({ issue: "LEAN-1", related: "LEAN-2", type: "related" });
    expect(recorded[0].variables).toEqual({ id: "LEAN-1" });
    expect(recorded[2].query).toContain("issueRelationCreate(");
    expect(recorded[2].variables).toEqual({
      input: { issueId: U_ISSUE, relatedIssueId: U_BLOCKER, type: "related" },
    });
    expect(ack).toEqual({ id: "r1", type: "related", issue: "LEAN-1", related: "LEAN-2", created: true });
  });

  it("idempotent: an identical outgoing relation is returned, no mutation sent", async () => {
    respond(relations([{ id: "r0", type: "duplicate", to: U_BLOCKER }]), { issue: { id: U_BLOCKER } });
    const { createIssueRelation } = await linear();
    const ack = await createIssueRelation({ issue: "LEAN-1", related: "LEAN-2", type: "duplicate" });
    expect(recorded).toHaveLength(2);
    expect(ack).toEqual({ id: "r0", type: "duplicate", issue: "LEAN-1", related: "LEAN-2", created: false });
  });

  it("symmetric types match the inverse direction too", async () => {
    respond(relations([], [{ id: "r0", type: "similar", from: U_BLOCKER }]), { issue: { id: U_BLOCKER } });
    const { createIssueRelation } = await linear();
    const ack = await createIssueRelation({ issue: "LEAN-1", related: U_BLOCKER, type: "similar" });
    expect(recorded).toHaveLength(1); // UUID `related` skips the lookup
    expect(ack.created).toBe(false);
  });

  it("directional types do NOT treat the inverse as identical (B blocks A ≠ A blocks B)", async () => {
    respond(
      relations([{ id: "rx", type: "related", to: U_BLOCKER }], [{ id: "r0", type: "blocks", from: U_BLOCKER }]),
      { issueRelationCreate: { issueRelation: { id: "r2", type: "blocks" } } },
    );
    const { createIssueRelation } = await linear();
    const ack = await createIssueRelation({ issue: "LEAN-1", related: U_BLOCKER, type: "blocks" });
    expect(recorded[1].variables).toEqual({
      input: { issueId: U_ISSUE, relatedIssueId: U_BLOCKER, type: "blocks" },
    });
    expect(ack.created).toBe(true);
  });

  it("unknown type → loud throw naming the valid types, before any request", async () => {
    const { createIssueRelation } = await linear();
    await expect(createIssueRelation({ issue: "LEAN-1", related: "LEAN-2", type: "blockedBy" })).rejects.toThrow(
      /unknown relation type "blockedBy".*blocks, duplicate, related, similar/,
    );
    expect(recorded).toHaveLength(0);
  });

  it("unknown issue → loud throw", async () => {
    respond({ issue: null });
    const { createIssueRelation } = await linear();
    await expect(createIssueRelation({ issue: "LEAN-404", related: "LEAN-2", type: "related" })).rejects.toThrow(
      "issue not found: LEAN-404",
    );
  });

  it("self-relation → loud throw", async () => {
    respond(relations());
    const { createIssueRelation } = await linear();
    await expect(createIssueRelation({ issue: "LEAN-1", related: U_ISSUE, type: "related" })).rejects.toThrow(
      "cannot relate to itself",
    );
  });
});

// --- save_project -----------------------------------------------------------------

describe("saveProject", () => {
  const U_STATUS = "aaaaaaaa-0000-4000-8000-000000000015";
  const STATUSES = {
    projectStatuses: {
      nodes: [
        { id: U_PROJECT2, name: "Backlog" },
        { id: U_STATUS, name: "Completed" },
      ],
    },
  };
  const updateAck = (status: string | null) => ({
    projectUpdate: {
      project: {
        id: U_PROJECT,
        name: "Wrapper",
        url: "https://linear.app/x/project/wrapper",
        status: status === null ? null : { name: status },
      },
    },
  });

  it("resolves a status NAME to its id and reads the new status back in the ack", async () => {
    respond(STATUSES, updateAck("Completed"));
    const { saveProject } = await linear();
    const ack = await saveProject({ id: U_PROJECT, status: "Completed" });
    expect(recorded[0].query).toContain("ProjectStatuses");
    expect(recorded[1].variables).toEqual({ id: U_PROJECT, input: { statusId: U_STATUS } });
    expect(ack).toEqual({
      id: U_PROJECT,
      name: "Wrapper",
      url: "https://linear.app/x/project/wrapper",
      status: "Completed",
    });
  });

  it("matches the status name case-insensitively", async () => {
    respond(STATUSES, updateAck("Completed"));
    const { saveProject } = await linear();
    await saveProject({ id: U_PROJECT, status: "completed" });
    expect(recorded[1].variables).toEqual({ id: U_PROJECT, input: { statusId: U_STATUS } });
  });

  it("a UUID status skips resolution entirely", async () => {
    respond(updateAck("Completed"));
    const { saveProject } = await linear();
    await saveProject({ id: U_PROJECT, status: U_STATUS });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].variables).toEqual({ id: U_PROJECT, input: { statusId: U_STATUS } });
  });

  it("unknown status name → loud throw naming the workspace's statuses", async () => {
    respond(STATUSES);
    const { saveProject } = await linear();
    await expect(saveProject({ id: U_PROJECT, status: "Done" })).rejects.toThrow(
      /unresolved project status: "Done".*Backlog, Completed/s,
    );
  });

  it("create sets statusId alongside name + teamIds", async () => {
    respond(STATUSES, teamsPayload, {
      projectCreate: {
        project: { id: U_PROJECT, name: "New", url: "https://p", status: { name: "Backlog" } },
      },
    });
    const { saveProject } = await linear();
    const ack = await saveProject({ name: "New", team: "LEAN", status: "Backlog" });
    expect(recorded[2].variables).toEqual({
      input: { name: "New", teamIds: [U_TEAM], statusId: U_PROJECT2 },
    });
    expect(ack.status).toBe("Backlog");
  });

  it("no status arg → no resolution call and no statusId in the input", async () => {
    respond(updateAck("Backlog"));
    const { saveProject } = await linear();
    const ack = await saveProject({ id: U_PROJECT, name: "Renamed" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].variables).toEqual({ id: U_PROJECT, input: { name: "Renamed" } });
    expect(ack.status).toBe("Backlog");
  });

  const PROJECT_LABELS = {
    projectLabels: {
      nodes: [
        { id: U_LABEL, name: "Infra", isGroup: false },
        { id: U_STATE, name: "Area", isGroup: true },
        { id: U_STATE2, name: "Growth", isGroup: false },
      ],
    },
  };

  it("labels resolve against PROJECT labels (case-insensitive), ids pass through; content is set", async () => {
    respond(PROJECT_LABELS, updateAck("Backlog"));
    const { saveProject } = await linear();
    await saveProject({ id: U_PROJECT, labels: ["infra", U_MILESTONE], content: "# Overview\n\nlong body" });
    expect(recorded[0].query).toContain("projectLabels(");
    expect(recorded[0].query).not.toContain("issueLabels");
    expect(recorded[1].variables).toEqual({
      id: U_PROJECT,
      input: { content: "# Overview\n\nlong body", labelIds: [U_LABEL, U_MILESTONE] },
    });
  });

  it("all-UUID labels skip resolution; [] clears the set", async () => {
    respond(updateAck("Backlog"), updateAck("Backlog"));
    const { saveProject } = await linear();
    await saveProject({ id: U_PROJECT, labels: [U_LABEL] });
    await saveProject({ id: U_PROJECT, labels: [] });
    expect(recorded).toHaveLength(2);
    expect(recorded[0].variables).toEqual({ id: U_PROJECT, input: { labelIds: [U_LABEL] } });
    expect(recorded[1].variables).toEqual({ id: U_PROJECT, input: { labelIds: [] } });
  });

  it("unknown project label → loud throw naming the workspace's labels, before any write", async () => {
    respond(PROJECT_LABELS);
    const { saveProject } = await linear();
    await expect(saveProject({ id: U_PROJECT, labels: ["Nope"] })).rejects.toThrow(
      /unresolved project label: "Nope".*has: Infra, Growth$/,
    );
    expect(recorded).toHaveLength(1);
  });

  it("a label GROUP name → loud throw", async () => {
    respond(PROJECT_LABELS);
    const { saveProject } = await linear();
    await expect(saveProject({ id: U_PROJECT, labels: ["Area"] })).rejects.toThrow("is a label group");
  });

  it("create carries content + labelIds alongside name + teamIds", async () => {
    respond(PROJECT_LABELS, teamsPayload, {
      projectCreate: { project: { id: U_PROJECT, name: "New", url: "https://p", status: null } },
    });
    const { saveProject } = await linear();
    await saveProject({ name: "New", team: "LEAN", labels: ["Growth"], content: "body" });
    expect(recorded[2].variables).toEqual({
      input: { name: "New", teamIds: [U_TEAM], content: "body", labelIds: [U_STATE2] },
    });
  });
});

// --- teams / users ----------------------------------------------------------------

describe("getTeam / listTeams", () => {
  it("matches by key case-insensitively", async () => {
    respond(teamsPayload);
    const { getTeam } = await linear();
    expect(await getTeam("lean")).toEqual({ id: U_TEAM, name: "Lean Wrapper", key: "LEAN" });
  });

  it("unknown team → loud throw", async () => {
    respond(teamsPayload);
    const { getTeam } = await linear();
    await expect(getTeam("nope")).rejects.toThrow('team not found: "nope"');
  });

  it("listTeams filters by name/key substring client-side", async () => {
    respond({
      teams: {
        nodes: [
          { id: U_TEAM, name: "Lean Wrapper", key: "LEAN" },
          { id: U_PROJECT, name: "Platform", key: "PLT" },
        ],
      },
    });
    const { listTeams } = await linear();
    expect(await listTeams({ query: "plat" })).toEqual([{ id: U_PROJECT, name: "Platform", key: "PLT" }]);
  });
});

describe("getUser", () => {
  it('"me" resolves via the viewer query', async () => {
    respond(
      { viewer: { id: U_USER } },
      { user: { id: U_USER, name: "Wik", displayName: "wik", email: "w@x.y", active: true } },
    );
    const { getUser } = await linear();
    const u = await getUser("me");
    expect(recorded[1].variables).toEqual({ id: U_USER });
    expect(u).toEqual({ id: U_USER, name: "Wik", displayName: "wik", email: "w@x.y", active: true });
  });
});

// --- status updates ---------------------------------------------------------------

describe("getStatusUpdates", () => {
  it("by id (project): flattens authorName null-safely", async () => {
    respond({
      projectUpdate: {
        id: "u1",
        body: "on track",
        health: "onTrack",
        createdAt: "2026-07-01T00:00:00.000Z",
        url: "https://u",
        user: null,
      },
    });
    const { getStatusUpdates } = await linear();
    expect(await getStatusUpdates({ type: "project", id: "u1" })).toEqual({
      id: "u1",
      body: "on track",
      health: "onTrack",
      createdAt: "2026-07-01T00:00:00.000Z",
      url: "https://u",
      authorName: null,
    });
  });

  it("initiative list resolves the initiative name into the filter", async () => {
    respond({ initiatives: { nodes: [{ id: U_INITIATIVE }] } }, { initiativeUpdates: { nodes: [] } });
    const { getStatusUpdates } = await linear();
    await getStatusUpdates({ type: "initiative", initiative: "Tooling" });
    expect(recorded[1].variables.filter).toEqual({ initiative: { id: { eq: U_INITIATIVE } } });
  });
});

// --- initiatives ------------------------------------------------------------------

describe("saveInitiative", () => {
  const U_PARENT = "aaaaaaaa-0000-4000-8000-000000000016";
  const U_OTHER_PARENT = "aaaaaaaa-0000-4000-8000-000000000017";
  const U_RELATION = "aaaaaaaa-0000-4000-8000-000000000018";

  const createAck = {
    initiativeCreate: {
      initiative: {
        id: U_INITIATIVE,
        name: "Own media",
        url: "https://linear.app/x/initiative/own-media",
        status: "Planned",
      },
    },
  };
  const updateAck = (name: string) => ({
    initiativeUpdate: {
      initiative: {
        id: U_INITIATIVE,
        name,
        url: "https://linear.app/x/initiative/own-media",
        status: "Active",
      },
    },
  });
  /** No parent yet / already under `parentId` — the nest path's first read. */
  const parentIs = (parentId: string | null) => ({
    initiative: { parentInitiative: parentId === null ? null : { id: parentId } },
  });

  it("create: sends only the set fields and returns the closed ack", async () => {
    respond(createAck);
    const { saveInitiative } = await linear();
    const ack = await saveInitiative({ name: "Own media", status: "Planned" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].query).toContain("mutation InitiativeCreate(");
    expect(recorded[0].variables).toEqual({ input: { name: "Own media", status: "Planned" } });
    expect(ack).toEqual({
      id: U_INITIATIVE,
      name: "Own media",
      url: "https://linear.app/x/initiative/own-media",
      status: "Planned",
    });
  });

  it("create without a name → loud throw before any mutation", async () => {
    const { saveInitiative } = await linear();
    await expect(saveInitiative({ description: "no name" })).rejects.toThrow(
      "save_initiative create requires `name`",
    );
    expect(recorded).toHaveLength(0);
  });

  it("an `id` renames an existing initiative via initiativeUpdate", async () => {
    respond(updateAck("Own media 2027"));
    const { saveInitiative } = await linear();
    const ack = await saveInitiative({ id: U_INITIATIVE, name: "Own media 2027" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].query).toContain("mutation InitiativeUpdateMutation(");
    expect(recorded[0].variables).toEqual({
      id: U_INITIATIVE,
      input: { name: "Own media 2027" },
    });
    expect(ack.name).toBe("Own media 2027");
  });

  it("parentInitiative nests via a separate relation mutation (parent, then child)", async () => {
    respond(createAck, parentIs(null), { initiativeRelationCreate: { success: true } });
    const { saveInitiative } = await linear();
    await saveInitiative({ name: "Own media", parentInitiative: U_PARENT });
    // A UUID parent skips resolution: create → read current parent → relate.
    expect(recorded).toHaveLength(3);
    expect(recorded[0].query).toContain("mutation InitiativeCreate(");
    expect(recorded[2].variables).toEqual({
      // `initiativeId` is the PARENT, `relatedInitiativeId` the CHILD.
      input: { initiativeId: U_PARENT, relatedInitiativeId: U_INITIATIVE },
    });
  });

  it("parentInitiative accepts a NAME, resolved before the write", async () => {
    respond(
      { initiatives: { nodes: [{ id: U_PARENT }] } },
      createAck,
      parentIs(null),
      { initiativeRelationCreate: { success: true } },
    );
    const { saveInitiative } = await linear();
    await saveInitiative({ name: "Own media", parentInitiative: "re:print" });
    expect(recorded[0].query).toContain("query ResolveInitiatives(");
    expect(recorded[0].variables).toEqual({ name: "re:print" });
    expect(recorded[1].query).toContain("mutation InitiativeCreate(");
    expect(recorded[3].variables).toEqual({
      input: { initiativeId: U_PARENT, relatedInitiativeId: U_INITIATIVE },
    });
  });

  it("unknown parent NAME → loud throw naming what exists, and nothing is created", async () => {
    respond(
      { initiatives: { nodes: [] } },
      { initiatives: { nodes: [{ name: "re:print" }, { name: "Lambert" }] } },
    );
    const { saveInitiative } = await linear();
    await expect(
      saveInitiative({ name: "Own media", parentInitiative: "reprint" }),
    ).rejects.toThrow(/unresolved initiative name: "reprint".*this workspace has: re:print, Lambert/s);
    // Resolution fails BEFORE the create — no half-created initiative.
    expect(recorded.some((r) => r.query.includes("InitiativeCreate"))).toBe(false);
  });

  it("ambiguous parent name → loud throw, not the workspace listing", async () => {
    respond({ initiatives: { nodes: [{ id: U_PARENT }, { id: U_OTHER_PARENT }] } });
    const { saveInitiative } = await linear();
    await expect(
      saveInitiative({ name: "Own media", parentInitiative: "Media" }),
    ).rejects.toThrow('ambiguous initiative name: "Media" matched 2 — pass an id');
    expect(recorded).toHaveLength(1);
  });

  it("already under that parent → idempotent, no relation mutation", async () => {
    respond(updateAck("Own media"), parentIs(U_PARENT));
    const { saveInitiative } = await linear();
    await saveInitiative({ id: U_INITIATIVE, parentInitiative: U_PARENT });
    expect(recorded).toHaveLength(2);
    expect(recorded.some((r) => r.query.includes("InitiativeRelationCreate"))).toBe(false);
  });

  it("re-parenting deletes the stale relation before creating the new one", async () => {
    respond(
      updateAck("Own media"),
      parentIs(U_OTHER_PARENT),
      {
        initiativeRelations: {
          nodes: [
            { id: "other", relatedInitiative: { id: U_PARENT } },
            { id: U_RELATION, relatedInitiative: { id: U_INITIATIVE } },
          ],
        },
      },
      { initiativeRelationDelete: { success: true } },
      { initiativeRelationCreate: { success: true } },
    );
    const { saveInitiative } = await linear();
    await saveInitiative({ id: U_INITIATIVE, parentInitiative: U_PARENT });
    expect(recorded[3].query).toContain("mutation InitiativeRelationDelete(");
    expect(recorded[3].variables).toEqual({ id: U_RELATION });
    expect(recorded[4].variables).toEqual({
      input: { initiativeId: U_PARENT, relatedInitiativeId: U_INITIATIVE },
    });
  });

  it("refuses to nest an initiative under itself, before any write", async () => {
    const { saveInitiative } = await linear();
    await expect(
      saveInitiative({ id: U_INITIATIVE, parentInitiative: U_INITIATIVE }),
    ).rejects.toThrow("cannot be its own parentInitiative");
    expect(recorded).toHaveLength(0);
  });

  // Linear gates sub-initiatives behind the Enterprise plan — the schema
  // introspects fine on every plan, so this only bites when the relation
  // mutation runs (observed live 2026-09-15). The initiative is already written
  // by then, so the error has to name it or the caller loses the id.
  it("a plan-gated nesting failure names the gate AND the initiative that was saved", async () => {
    respond(createAck, parentIs(null));
    const { saveInitiative } = await linear();
    // Make only the relation mutation fail, the way Linear does.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("InitiativeRelationCreate")) {
        throw new Error(
          "Not allowed to access feature 'subInitiatives': {\"extensions\":{\"code\":\"FEATURE_NOT_ACCESSIBLE\"}}",
        );
      }
      return (realFetch as (a: unknown, b?: unknown) => Promise<Response>)(input, init);
    });
    await expect(
      saveInitiative({ name: "Own media", parentInitiative: U_PARENT }),
    ).rejects.toThrow(
      /nesting failed — Linear gates sub-initiatives behind the Enterprise plan.*The initiative itself WAS saved \(aaaaaaaa-0000-4000-8000-000000000014/s,
    );
  });

  it("a non-plan nesting failure passes the upstream message through", async () => {
    respond(createAck, parentIs(null));
    const { saveInitiative } = await linear();
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("InitiativeRelationCreate")) throw new Error("upstream exploded");
      return (realFetch as (a: unknown, b?: unknown) => Promise<Response>)(input, init);
    });
    await expect(
      saveInitiative({ name: "Own media", parentInitiative: U_PARENT }),
    ).rejects.toThrow(/nesting failed — upstream exploded/);
  });

  it("unknown status → loud throw naming the valid values, with no network call", async () => {
    const { saveInitiative } = await linear();
    await expect(saveInitiative({ name: "X", status: "Done" })).rejects.toThrow(
      /unresolved initiative status: "Done".*Proposed, Planned, Active, Completed, Canceled/s,
    );
    expect(recorded).toHaveLength(0);
  });

  it("matches the status name case-insensitively", async () => {
    respond(createAck);
    const { saveInitiative } = await linear();
    await saveInitiative({ name: "Own media", status: "planned" });
    expect(recorded[0].variables).toEqual({ input: { name: "Own media", status: "Planned" } });
  });

  it('owner "me" resolves via the viewer query', async () => {
    respond({ viewer: { id: U_USER } }, createAck);
    const { saveInitiative } = await linear();
    await saveInitiative({ name: "Own media", owner: "me" });
    expect(recorded[1].variables).toEqual({ input: { name: "Own media", ownerId: U_USER } });
  });
});

describe("listInitiatives / getInitiative", () => {
  const U_PARENT = "aaaaaaaa-0000-4000-8000-000000000016";
  const RAW_INITIATIVE = {
    id: U_INITIATIVE,
    name: "Own media",
    status: "Active",
    parentInitiative: { name: "re:print" },
  };
  const RAW_INITIATIVE_FULL = {
    ...RAW_INITIATIVE,
    description: "the media thread",
    url: "https://linear.app/x/initiative/own-media",
    targetDate: "2026-12-31",
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: null,
    owner: { name: "Wik" },
    projects: { nodes: [{ name: "Newsletter" }] },
  };
  const LEAN = {
    id: U_INITIATIVE,
    name: "Own media",
    status: "Active",
    parentInitiative: { name: "re:print" },
  };

  it("lean default: closed rows, no description/url/owner", async () => {
    respond({ initiatives: { nodes: [RAW_INITIATIVE] } });
    const { listInitiatives } = await linear();
    const rows = await listInitiatives({});
    expect(recorded[0].query).toContain("query ListInitiatives(");
    expect(recorded[0].variables).toEqual({ first: 50 });
    expect(rows).toEqual([LEAN]);
  });

  it("full:true: the documented superset", async () => {
    respond({ initiatives: { nodes: [RAW_INITIATIVE_FULL] } });
    const { listInitiatives } = await linear();
    const rows = await listInitiatives({ full: true });
    expect(recorded[0].query).toContain("query ListInitiativesFull(");
    expect(rows).toEqual([
      {
        ...LEAN,
        description: "the media thread",
        url: "https://linear.app/x/initiative/own-media",
        targetDate: "2026-12-31",
        startedAt: "2026-09-01T00:00:00.000Z",
        completedAt: null,
        ownerName: "Wik",
        projects: ["Newsletter"],
      },
    ]);
  });

  it("`parent` reads the parent's DIRECT sub-initiatives", async () => {
    respond({ initiative: { subInitiatives: { nodes: [RAW_INITIATIVE] } } });
    const { listInitiatives } = await linear();
    const rows = await listInitiatives({ parent: U_PARENT });
    expect(recorded[0].query).toContain("query SubInitiatives(");
    expect(recorded[0].variables).toEqual({ id: U_PARENT, first: 50 });
    expect(rows).toEqual([LEAN]);
  });

  it("`parent` resolves a name and errors loudly when it matches nothing", async () => {
    respond({ initiatives: { nodes: [] } });
    const { listInitiatives } = await linear();
    await expect(listInitiatives({ parent: "nope" })).rejects.toThrow(
      'unresolved initiative name: "nope"',
    );
  });

  it("getInitiative: lean by default, null-safe on a top-level initiative", async () => {
    respond({ initiative: { ...RAW_INITIATIVE, parentInitiative: null } });
    const { getInitiative } = await linear();
    expect(await getInitiative(U_INITIATIVE)).toEqual({ ...LEAN, parentInitiative: null });
  });

  it("getInitiative: not found → loud throw", async () => {
    respond({ initiative: null });
    const { getInitiative } = await linear();
    await expect(getInitiative("nope")).rejects.toThrow("initiative not found: nope");
  });
});
