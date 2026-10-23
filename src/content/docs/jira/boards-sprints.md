---
title: "Boards & Sprints"
description: "Boards & Sprints - atlcli documentation"
---

# Boards & Sprints

Manage Scrum and Kanban boards, sprints, and backlogs.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects (read), Manage Sprints (sprint operations)

Issue lists (`board issues`, `board backlog`, `sprint issues`) print a table without `--json`; the other commands print JSON, pretty-printed even without `--json`.

## Boards

### List Boards

```bash
atlcli jira board list
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Filter by project key. Default: `defaults.project` of the profile |
| `--all-projects` | Ignore `--project` and `defaults.project`; list the boards of every project |
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

## Sprints

`--board` on `sprint list` and `sprint create` falls back to `defaults.board` from your config.

### List Sprints

```bash
atlcli jira sprint list --board 123
```

Options:

| Flag | Description |
|------|-------------|
| `--board` | Board ID (required, or `defaults.board`) |
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
| `--board` | Board ID (required, or `defaults.board`) |
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
