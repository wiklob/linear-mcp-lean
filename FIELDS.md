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

Write tools return minimal acks and nothing else: `save_issue` → `{id, identifier, state, url}`, `save_comment` → `{id, url}`, `create_issue_relation` → `{id, type, issue, related, created}` (idempotent: an identical existing relation comes back with `created: false`), `save_project` → `{id, name, url, status}`, `save_milestone` → `{id, name}`, `save_initiative` → `{id, name, url, status}`, `delete_git_automation_state` → `{deleted, team, event, state}` (one rule, by id, read back from the named team first — an id not on that team deletes nothing). The long-tail read tools (`get_team`, `list_teams`, `get_user`, …) keep their closed shapes as documented in each tool's description.

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

For the rare need neither the lean default nor `full` covers, `linear_graphql({query, variables})` runs an arbitrary GraphQL document against Linear and returns the **raw, untrimmed** result. Bearer-gated like every tool (the `/mcp` endpoint gate); errors surface, never swallowed. See the README for a usage example.

## Byte budget (why lean-by-default is worth it)

A representative default `list_issues` row serializes to ~340 bytes ≈ 0.28× the hosted MCP's ~1.2 KB/issue; the `save_issue` ack is ~160 bytes vs a 1.5–2 KB full-object echo. Initiatives, measured 2026-09-15 over the same 18-initiative workspace: `list_initiatives` 2,260 B (126 B/row) vs the hosted MCP's 17,216 B (956 B/row) — 87% fewer bytes; `get_initiative` 121 B vs 825 B, and even the `full: true` superset (604 B) stays under the hosted default. Measure your own traffic: every call is logged (upstream vs returned bytes) and `GET /stats` reports per-tool trim ratios; `npm run probe:vs-hosted` compares your deploy against the hosted MCP live.
