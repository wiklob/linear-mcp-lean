# Field contract

The wrapper returns a **lean default** field set per tool and a **`full: true`** richer superset on the hot read tools. A field a caller consumes that the wrapper silently trims to `undefined` is a bug, not a feature — if you find one, widen the default (or use `full`/`linear_graphql`) rather than papering over it client-side.

## `list_issues` response shape (the envelope)

Matches the hosted Linear MCP's shape exactly:

```json
{ "issues": [ { …row… } ], "hasNextPage": true, "cursor": "<opaque token>" }
```

- The rows are under the entity key **`issues`** (not `nodes`).
- `hasNextPage` / `cursor` are top-level siblings.
- `cursor` is an **opaque pass-through** — the wrapper forwards Linear's `pageInfo.endCursor` verbatim; the caller reads it and passes it straight back as the `cursor` arg (→ GraphQL `after`). No caller should inspect the token's internal form.

To page: call `list_issues({project, …})`, then while `hasNextPage` is true, call again with `cursor: <prior cursor>`, accumulating `issues`. Without pagination, an issue past the first ~50-row page would be silently invisible.

### Filters (incl. text search)

`state` / `project` / `label` / `assignee` / `team` resolve names→ids server-side and AND together; `includeCompleted:false` (no explicit `state`) excludes completed/canceled/duplicate rows server-side. **`query`** is a case-insensitive text search matched over **title OR description**, AND-ed with the rest — e.g. `list_issues({project: "bugs", query: "deliverability"})` finds issues whose title/body mentions "deliverability", without needing the `linear_graphql` escape hatch.

**`milestone`** lists a milestone's members (`filter.projectMilestone`): pass the milestone **id** (e.g. the `projectMilestone.id` off any row or `get_issue`), or its **name together with `project`** — a name without a project errors loudly, since milestone names repeat across projects. "Is this the last open issue in its milestone?" is `list_issues({milestone: <id>, includeCompleted: false})` — no raw `projectMilestone(id){issues}` query.

## Pagination coverage — which list tools page

`list_issues` is the **only** paginated tool. The other list tools return small, filtered result sets consumed whole and keep their bare-array shape — adding an envelope to them would be unused bytes.

| Tool | Paginated? | Shape |
|------|------------|-------|
| `list_issues` | **yes** | `{issues, hasNextPage, cursor}` envelope |
| `list_projects` | no | bare array |
| `list_comments` | no | bare array |
| `list_milestones` / `get_milestone` | no | bare array / object |
| `list_issue_labels` / `list_project_labels` | no (a `limit` arg caps rows) | bare array |
| `list_teams` / `list_users` / `list_cycles` / `list_documents` | no | bare array |
| `list_initiatives` / `get_initiative` | no (a `limit` arg caps rows) | bare array / object |

If you need to page one of these, treat it as a gap to fix here — not a silent hole.

## Default vs `full` contract (per hot read tool)

`full: true` is opt-in on the hot read tools; absent → the lean default below, present → the documented superset. `list_issues` `full` enriches each **row** inside the same envelope.

| Tool | Default fields | `full: true` adds |
|------|----------------|-------------------|
| `get_issue` | identifier, title, description, state, gitBranchName, project{id,name}, url, attachments[], blockedBy[], labels[], milestone{id,name}, priority, createdAt | updatedAt, startedAt, completedAt, canceledAt, dueDate, estimate, stateType, assigneeName, parent |
| `list_issues` (per row) | identifier, title, state, statusType, priority, createdAt, blockedBy[], labels[], project{id}, projectMilestone{id}, gitBranchName | description, url, updatedAt, assigneeName, milestone{id,name} |
| `list_projects` (per row) | id, name, status{name,type} | description, startDate, targetDate, leadName, labels[], initiatives[] |
| `get_project` | id, name, description, labels[] | content, status{name,type}, startDate, targetDate, leadName, initiatives[] |
| `list_initiatives` (per row) | id, name, status, parentInitiative{name} | description, url, targetDate, startedAt, completedAt, ownerName, projects[] |
| `get_initiative` | id, name, status, parentInitiative{name} | description, url, targetDate, startedAt, completedAt, ownerName, projects[] |

Write tools return minimal acks and nothing else: `save_issue` → `{id, identifier, state, url}`, `save_comment` → `{id, url}`, `create_issue_relation` → `{id, type, issue, related, created}` (idempotent: an identical existing relation comes back with `created: false`), `delete_issue_relation` → `{id, type, issue, related, deleted: true}` (one relation, by id, read back first; refuses without `confirm: true`), `save_project` → `{id, name, url, status}`, `save_milestone` → `{id, name}`, `save_team` → `{id, name, key}` (create, or rename / re-key the team `id` names; no delete), `save_initiative` → `{id, name, url, status}`, `delete_milestone` → `{id, deleted: true}`, `delete_git_automation_state` → `{deleted, team, event, state}` (one rule, by id, read back from the named team first — an id not on that team deletes nothing). `list_issue_relations` → `[{id, type, issue, related}]` — every relation touching the issue, both directions, each read `issue —type→ related` by identifier. Every delete follows the guard below. The long-tail read tools (`get_team`, `list_teams`, `get_user`, …) keep their closed shapes as documented in each tool's description.

## Destructive ops (`delete_*`) — the standing guard

Every tool that deletes something follows this, and so does any future one:

1. **Read the target back first.** An unknown or foreign id fails loud before any mutation is built.
2. **Require `confirm: true`.** Absent or `false` deletes nothing and errors with what the call *would* have deleted — e.g. `delete_milestone: nothing deleted — this would delete milestone "M1" (<id>) in project "Wrapper". Re-run with confirm: true to delete it.` The caller decides on the name, not on an opaque id.
3. **Then delete, and ack minimally.** `success: false` from Linear is an error, never a false ack.
4. **Keep the permission prompt.** In the harness, `delete_*` tools are listed under `permissions.ask` in `~/.claude/settings.json`, so they prompt even though reads and non-destructive `save_*` are allowlisted. A new `delete_*` tool is added to that `ask` list in the same change that ships it.

The guard lives in `requireConfirm` in `src/linear.ts`; a new destructive tool calls it after its read-back.

## Issue due date (`save_issue`)

`dueDate` takes an ISO calendar date (`YYYY-MM-DD`) and sets the issue's due date; `null` clears it. Anything else — a timestamp, `2026-02-30` — fails before any request, so a create never half-applies. `get_issue({full: true})` reads it back as `dueDate`.

## Project labels and body (`save_project`)

`labels` takes project-label names or ids (the `list_project_labels` set — project labels are a different entity from issue labels) and **replaces** the project's label set; `[]` clears it. An unknown name fails before the write and the error names the labels that exist; a label group is rejected. `content` is the project's long markdown body (its overview page), distinct from the short `description` summary.

## Initiative nesting (`save_initiative`)

Linear's initiative hierarchy is **not** a field on the initiative — it is a separate `InitiativeRelation` entity, so neither `initiativeCreate` nor `initiativeUpdate` accepts a parent id. `save_initiative` hides that: pass `parentInitiative` (name or id) on create or update and the wrapper applies the relation itself, after the write.

- **Idempotent** — an initiative already nested under that parent is left alone; no duplicate relation.
- **Re-parenting replaces** — a different existing parent has its relation deleted first, because creating a second one would leave the initiative with two parents and a silently wrong tree. Only the *relation* is ever deleted; initiative delete/archive is deliberately absent from the typed surface.
- **`list_initiatives({parent})` reads direct children** (the parent's own `subInitiatives`), not every descendant.

An unknown `parentInitiative` name fails before the write — so a typo never leaves a half-created initiative behind — and the error names the initiatives that do exist.

### Nesting needs Linear's Enterprise plan

**Linear gates sub-initiatives behind the Enterprise plan.** The schema introspects identically on every plan, so this is invisible until the relation mutation actually runs, at which point Linear answers `FEATURE_NOT_ACCESSIBLE` — "Subscribe to the Enterprise plan to access sub-initiatives in your workspace" (confirmed live, 2026-09-15).

The wrapper surfaces that as a single actionable error naming the gate **and** the initiative that was nonetheless saved, with its id and url — the write lands before the nesting does, so losing the id to a bare upstream error would be the worse failure:

```
save_initiative: nesting failed — Linear gates sub-initiatives behind the Enterprise plan,
so `parentInitiative` cannot be applied on this workspace. The initiative itself WAS saved
(a3cba198-…, https://linear.app/…); it is simply not nested.
```

Everything else works on any plan: create, update/rename, status, owner, target date, and every read — including `parentInitiative` read-back and `list_initiatives({parent})`, which are ungated and simply return nothing while no nesting exists.

## `linear_graphql` escape hatch

The last resort, in this order: a typed tool, then a sanctioned named op, then a raw query. Bearer-gated like every tool (the `/mcp` endpoint gate); errors surface, never swallowed.

### Typed first — want X → use Y

Most raw-GraphQL calls seen in real sessions were for things a typed tool already does, leaner. Check this map before reaching for `linear_graphql`:

| Want | Typed tool |
|---|---|
| Project status (read) | `list_projects` (lean rows carry `status{name,type}`) or `get_project({id, full: true})` |
| Project status (change) | `save_project({id, status: "In Progress"})` — status by name, resolved server-side |
| Project description / body (read) | `get_project({id})` → `description`; `full: true` adds `content` (the markdown body) |
| Project description / body (write) | `save_project({id, description})` (≤255-char summary) / `save_project({id, content})` (body) |
| Project id from its name | `list_projects` — no name filter, so narrow with `team`/`state`/`label` (default limit 50); `get_project` takes an id, not a name |
| Project labels (change) | `save_project({id, labels: [...]})` — replaces the set |
| Workflow-state id | Usually unneeded: `save_issue({state: "Done"})` and `list_issues({state})` take the name. When you do need ids/types: `list_issue_statuses({team})` → `[{id, name, type}]`; one id → `get_issue_status({id})` |
| Project status updates (read / post) | `get_status_updates({type: "project", project})` / `save_status_update({type: "project", project, body, health})` |
| Issue comments (read / post) | `list_comments({issue})` / `save_comment({issue, body})` |
| Documents (read / write) | `list_documents` → `get_document({id})` (which carries `project{id}`); `save_document({title, content, project})` |
| Milestone's issues / membership | `list_issues({milestone, project})` |
| Find an issue by text | `list_issues({query})` — title OR description |
| Issue relations (duplicate / related / blocks) | `create_issue_relation` / `list_issue_relations` / `delete_issue_relation` |
| Delete a milestone | `delete_milestone({id, confirm: true})` |
| Due date, assignee, timestamps, parent, estimate (read) | `get_issue({id, full: true})` |
| Due date (write) | `save_issue({id, dueDate: "YYYY-MM-DD"})` — `null` clears |

### Sanctioned named ops — `linear_graphql({op, variables})`

What's left for the escape hatch — reads with no typed path today — runs as a **named op**: pass `op` + `variables` and no query. The server holds the canonical minimal query and returns a trimmed closed shape, so the caller neither sends a document nor receives raw bytes.

| `op` | variables | returns |
|------|-----------|---------|
| `project_comments` | `id` | `[{id, body, createdAt, user}]` — `list_comments` is issue-only |
| `project_documents` | `id` | `[{id, title, slugId, updatedAt}]` — `list_documents` has no project filter |
| `issue_subscribers` | `id` | `[name]` |
| `issue_children` | `id` | `[{identifier, title, state}]` |
| `issue_history` | `id` | `[{at, actor, fromState?, toState?, fromAssignee?, toAssignee?}]` — state/assignee changes, oldest first (from the latest 100 history entries) |
| `type_shape` | `name` | `{name, kind, fields?, inputFields?, enumValues?}` — schema shape while debugging, each field as `"name: Type"`, e.g. `labelIds: [String!]` |

An unknown op errors with the list; a missing variable errors before any request; an unknown issue or project is a loud not-found. If the same raw read keeps coming back, that's a missing named op, typed tool or filter — file it rather than repeating the query.

### Raw `query` — genuine one-offs

`linear_graphql({query, variables})` runs an arbitrary GraphQL document. The result is **null-stripped** (null object fields dropped at every depth; array slots kept) — Linear's raw payloads are dominated by null SLA/timestamp fields. Select only the fields you need.

**Mutations** are rejected unless the call passes **`allowMutation: true`** *and* the service sets `LINEAR_GRAPHQL_ALLOW_MUTATION=1` (V-36 — a leaked bearer can't mutate through the server's key by passing a flag). An unparseable document counts as a mutation. Every recurring write has a typed tool; a write with no typed tool is a ticket for one, not a reason to set the flag.

## Byte budget (why lean-by-default is worth it)

A representative default `list_issues` row serializes to ~340 bytes ≈ 0.28× the hosted MCP's ~1.2 KB/issue; the `save_issue` ack is ~160 bytes vs a 1.5–2 KB full-object echo. Initiatives, measured 2026-09-15 over the same 18-initiative workspace: `list_initiatives` 2,260 B (126 B/row) vs the hosted MCP's 17,216 B (956 B/row) — 87% fewer bytes; `get_initiative` 121 B vs 825 B, and even the `full: true` superset (604 B) stays under the hosted default. Measure your own traffic: every call is logged (upstream vs returned bytes) and `GET /stats` reports per-tool trim ratios; `npm run probe:vs-hosted` compares your deploy against the hosted MCP live.
