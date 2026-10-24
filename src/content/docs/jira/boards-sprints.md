---
title: "Boards & Sprints"
description: "Boards & Sprints - atlcli documentation"
---

# Boards & Sprints

Manage Scrum and Kanban boards, sprints, and backlogs.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects (read), Manage Sprints (sprint operations). Creating a board located in a project needs Administer Projects there; deleting one needs board admin rights.

Issue lists (`board issues`, `board backlog`, `sprint issues`) print a table without `--json`; the other commands print JSON, pretty-printed even without `--json`.

## Boards

### List Boards

```bash
atlcli jira board list
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Filter by project key. Default: `global.project` of the profile |
| `--all-projects` | Ignore `--project` and `global.project`; list the boards of every project |
| `--type` | Filter by type: `scrum`, `kanban`, `simple` |
| `--name` | Filter by name pattern |
| `--limit` | Maximum results (default 50) |

`board list` pages through Jira's results until it has `--limit` boards. If more exist, it prints `Showing N of M boards; raise --limit for more.` on stderr.

### Examples

```bash
# All boards for a project
atlcli jira board list --project PROJ

# Only Scrum boards
atlcli jira board list --type scrum

# Every Scrum board, whatever the profile's default project
atlcli jira board list --all-projects --type scrum

# Search by name
atlcli jira board list --name "Team"
```

### Get Board

```bash
atlcli jira board get --id 123
```

Prints the board's name, ID, type and project. With `--json`:

```json
{
  "schemaVersion": "1",
  "board": {
    "id": 123,
    "name": "Team Scrum Board",
    "type": "scrum",
    "location": { "projectId": 10000, "projectKey": "PROJ", "projectName": "Main Project" }
  }
}
```

### Board Issues

Get all issues on a board:

```bash
atlcli jira board issues --id 123
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Board ID (required) |
| `--jql` | Filter with JQL query |
| `--limit` | Maximum results (default 50) |

The table takes the same `--columns`, `--plain`, `--delimiter`, `--csv` and `--no-headers` flags as [search](search.md).

### Backlog

View the backlog for a board:

```bash
atlcli jira board backlog --id 123
atlcli jira board backlog --id 123 --jql "type = Bug"
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Board ID (required) |
| `--jql` | Filter with JQL query |
| `--limit` | Maximum results (default 50) |

Table flags as for `board issues`.

### Create Board

A board always sits on a saved filter, which decides the issues it shows.

```bash
# Scrum board for a project: atlcli makes the filter
atlcli jira board create --name "Team AB" --project AB

# Kanban board on a narrower query
atlcli jira board create --name "AB bugs" --type kanban --project AB \
  --jql "project = AB AND type = Bug ORDER BY Rank ASC"

# Board on an existing filter
atlcli jira board create --name "Release board" --filter 10500 --project AB
```

Options:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--name` | string | (required) | Board name; also the name of a filter atlcli makes |
| `--type` | `scrum` \| `kanban` | `scrum` | Board type |
| `--project` | key | `global.project` | Project the board is located in |
| `--filter` | filter ID | | Existing saved filter to use as it is |
| `--jql` | JQL | `project = "<key>" ORDER BY Rank ASC` | Query of the filter atlcli makes; not with `--filter` |

Without `--filter`, atlcli first creates a filter named like the board and shares it with `--project`, as Jira's own board wizard does; without the share only you would see the board. If the board then cannot be created, that filter is deleted again. Without `--project`, `global.project`, `--jql` or `--filter`, the command stops with a usage error.

Output (`--json`):

```json
{
  "schemaVersion": "1",
  "board": { "id": 882, "name": "Team AB", "type": "scrum" },
  "filter": { "id": "11334", "created": true }
}
```

Keep `ORDER BY Rank` in your own `--jql`: a Scrum board needs it to rank its backlog. Jira refuses a filter name you already use; pick another `--name` or pass `--filter`.

### Delete Board

```bash
atlcli jira board delete --id 882 --confirm
atlcli jira board delete --id 882 --confirm --delete-filter
```

Deleting a board leaves its issues and sprints' issues untouched. Its saved filter stays unless you add `--delete-filter`, which reads the filter from the board first and deletes it after the board. If another board still uses the filter, it stays, and the output names it under `keptFilter` with the ids of those boards (`usedByBoards`). Saved searches and subscriptions of other users are not checked: use `--delete-filter` for a filter made for this board.

Output (`--json`): `{ "schemaVersion": "1", "deleted": 882, "deletedFilter": "11334" }`.

## Sprints

`--board` on `sprint list` and `sprint create` falls back to `global.board` from your config.

### List Sprints

```bash
atlcli jira sprint list --board 123
```

Options:

| Flag | Description |
|------|-------------|
| `--board` | Board ID (required, or `global.board`) |
| `--state` | Filter: `active`, `future`, `closed` |
| `--limit` | Maximum results (default 50) |

Like `board list`, `sprint list` pages through all results up to `--limit` and prints `Showing N of M sprints; raise --limit for more.` on stderr when more exist.

### Examples

```bash
# Active sprints only
atlcli jira sprint list --board 123 --state active

# Future (planned) sprints
atlcli jira sprint list --board 123 --state future
```

### Get Sprint

```bash
atlcli jira sprint get --id 456
```

Prints the sprint's name, state, dates, board and goal. With `--json`:

```json
{
  "schemaVersion": "1",
  "sprint": {
    "id": 456,
    "name": "Sprint 14",
    "state": "active",
    "startDate": "2025-01-06T09:00:00.000Z",
    "endDate": "2025-01-17T17:00:00.000Z",
    "goal": "Complete API refactoring",
    "boardId": 123
  }
}
```

For issue counts and points, use [`sprint report`](#sprint-report).

### Sprint Issues

```bash
atlcli jira sprint issues --id 456
atlcli jira sprint issues --id 456 --jql "statusCategory != Done" --limit 100
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Sprint ID (required) |
| `--jql` | Filter with JQL query |
| `--limit` | Maximum results (default 50) |

Prints a table; it takes the same `--columns`, `--plain`, `--delimiter`, `--csv` and `--no-headers` flags as [search](search.md). Use `--json` for `{schemaVersion, issues, total}`.

### Create Sprint

```bash
atlcli jira sprint create --board 123 --name "Sprint 15"
```

Options:

| Flag | Description |
|------|-------------|
| `--board` | Board ID (required, or `global.board`) |
| `--name` | Sprint name (required) |
| `--start` | Start date (YYYY-MM-DD) |
| `--end` | End date (YYYY-MM-DD) |
| `--goal` | Sprint goal |

### Examples

```bash
# Create with dates
atlcli jira sprint create --board 123 --name "Sprint 15" \
  --start "2025-01-20" --end "2025-02-03"

# Create with goal
atlcli jira sprint create --board 123 --name "Sprint 15" \
  --goal "Complete user authentication feature"
```

### Start Sprint

Start a planned sprint:

```bash
atlcli jira sprint start --id 456
atlcli jira sprint start --id 456 --start 2025-01-20 --end 2025-02-03 --goal "Ship login"
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Sprint ID (required) |
| `--start` | Start date (YYYY-MM-DD) |
| `--end` | End date (YYYY-MM-DD) |
| `--goal` | Sprint goal |

### Close Sprint

Close an active sprint:

```bash
atlcli jira sprint close --id 456
```

`--id` is the only option; the sprint closes without a prompt.

### Delete Sprint

```bash
atlcli jira sprint delete --id 456 --confirm
```

`--confirm` is required. Prints `{schemaVersion, deleted}`.

### Add Issues to Sprint

```bash
atlcli jira sprint add PROJ-1 PROJ-2 PROJ-3 --sprint 456
```

Options:

| Flag | Description |
|------|-------------|
| `--sprint` | Sprint ID (required) |
| `--issues` | Comma-separated issue keys (alternative to positional args) |

For many issues, use [`bulk move`](bulk-operations.md#bulk-move).

### Remove Issues from Sprint

Move issues back to backlog:

```bash
atlcli jira sprint remove PROJ-1 PROJ-2
```

Options:

| Flag | Description |
|------|-------------|
| `--issues` | Comma-separated issue keys (alternative to positional args) |

### Rank Issues

Reorder issues on boards and in the backlog, as dragging them in Jira does. The issues land directly before or after the target, in the order you give them:

```bash
# Put PROJ-7 and PROJ-8 at the top, above PROJ-1
atlcli jira issue rank PROJ-7 PROJ-8 --before PROJ-1

# Move PROJ-3 right below PROJ-12
atlcli jira issue rank PROJ-3 --after PROJ-12
```

Options:

| Flag | Description |
|------|-------------|
| `--before <key>` | Rank directly above this issue |
| `--after <key>` | Rank directly below this issue |
| `--issues` | Comma-separated issue keys (alternative to positional args) |

Give exactly one of `--before` or `--after`. Rank is global: one order serves every board that shows the issues. More than 50 issues are sent in batches of 50 and keep their order.

If Jira cannot rank some issues (no permission, or the board has no rank field), the command names them with Jira's error and exits 1; the others are ranked.

### Sprint Report

Get sprint metrics:

```bash
atlcli jira sprint report 456
atlcli jira sprint report 456 --status-map "Fertig=done"
```

Options:

| Flag | Description |
|------|-------------|
| `<id>` | Sprint ID (positional, or `--id`) |
| `--points-field` | Story points field ID (default: auto-detected) |
| `--status-map` | `"<status>=todo\|wip\|done,…"`: which statuses count as completed (default: `flow.statusMap`) |

Output:

```json
{
  "schemaVersion": "1",
  "sprint": { "id": 456, "name": "Sprint 14", "state": "closed", "dates": "2026-10-06 - 2026-10-17" },
  "pointsField": "customfield_10016",
  "velocity": 34,
  "sayDoRatio": 85,
  "scopeChange": 20,
  "issues": { "total": 22, "completed": 18, "incomplete": 4, "added": 2, "removed": 1 },
  "progress": { "committed": 40, "completed": 34, "added": 5, "removed": 3, "percent": 85, "bar": "[█████████████████───] 85%" }
}
```

`issues.added` and `issues.removed` count issues; the points are in `progress.added` and `progress.removed`. See [Analytics: Sprint report](analytics.md#sprint-report) for how each value is calculated.

### Sprint Review Page

Create or update a Confluence sprint review page (goal, metrics, done and not-done work), optionally exported to PDF:

```bash
atlcli jira sprint review 456 --space TEAM --export sprint-review.pdf
```

See [Release Notes and Sprint Review Pages](report-pages.md) for options and templates.

## JSON Output

```bash
atlcli jira sprint list --board 123 --json
```

```json
{
  "schemaVersion": "1",
  "sprints": [
    {
      "id": 456,
      "name": "Sprint 14",
      "state": "active",
      "startDate": "2025-01-06T09:00:00.000Z",
      "endDate": "2025-01-17T17:00:00.000Z",
      "goal": "Complete API refactoring",
      "boardId": 123
    }
  ],
  "total": 1
}
```

## Best Practices

1. **Plan sprints in advance** - Create future sprints so issues can be assigned
2. **Set sprint goals** - Clear goals improve focus
3. **Use sprint reports** - Review metrics to improve velocity

## Related Topics

- [Analytics](analytics.md) - Velocity and burndown charts
- [Issues](issues.md) - Work with individual issues
- [Bulk Operations](bulk-operations.md) - Batch updates on sprint issues
