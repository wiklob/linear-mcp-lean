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
