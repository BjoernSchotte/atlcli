# Boards & Sprints

Manage Scrum and Kanban boards, sprints, and backlogs.

::: toc

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects (read), Manage Sprints (sprint operations)

## Boards

### List Boards

```bash
atlcli jira board list
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Filter by project key |
| `--type` | Filter by type: `scrum`, `kanban` |
| `--name` | Filter by name pattern |
| `--limit` | Maximum results |

### Examples

```bash
# All boards for a project
atlcli jira board list --project PROJ

# Only Scrum boards
atlcli jira board list --type scrum

# Search by name
atlcli jira board list --name "Team"
```

### Get Board

```bash
atlcli jira board get --id 123
```

Output:

```
Board: Team Scrum Board
ID:    123
Type:  scrum
Project: PROJ (Project Name)
Filter: 10001

Columns:
  - To Do
  - In Progress
  - Done
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
| `--limit` | Maximum results |

### Backlog

View the backlog for a board:

```bash
atlcli jira board backlog --id 123
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Board ID (required) |
| `--limit` | Maximum results |

## Sprints

### List Sprints

```bash
atlcli jira sprint list --board 123
```

Options:

| Flag | Description |
|------|-------------|
| `--board` | Board ID (required) |
| `--state` | Filter: `active`, `future`, `closed` |
| `--limit` | Maximum results |

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

Output:

```
Sprint: Sprint 14
ID:     456
State:  active
Board:  123 (Team Scrum Board)
Start:  2025-01-06
End:    2025-01-17
Goal:   Complete API refactoring

Issues: 24 (18 done, 4 in progress, 2 to do)
Points: 21 committed, 16 completed
```

### Create Sprint

```bash
atlcli jira sprint create --board 123 --name "Sprint 15"
```

Options:

| Flag | Description |
|------|-------------|
| `--board` | Board ID (required) |
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
```

### Close Sprint

Close an active sprint:

```bash
atlcli jira sprint close --id 456
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Sprint ID (required) |
| `--confirm` | Skip confirmation prompt |

### Add Issues to Sprint

```bash
atlcli jira sprint add PROJ-1 PROJ-2 PROJ-3 --sprint 456
```

Options:

| Flag | Description |
|------|-------------|
| `--sprint` | Sprint ID (required) |
| `--issues` | Comma-separated issue keys (alternative to positional args) |

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

Get comprehensive sprint metrics:

```bash
atlcli jira sprint report --id 456
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Sprint ID (required) |
| `--points-field` | Custom story points field ID |
| `--json` | JSON output |

Output:

```
Sprint 14 Report
================
Duration: Jan 6 - Jan 17, 2025 (10 days)
Status: Active

SUMMARY
-------
Total Issues:     24
Completed:        18 (75%)
In Progress:       4 (17%)
Not Started:       2 (8%)

STORY POINTS
------------
Committed:        21
Completed:        16
Remaining:         5

SCOPE CHANGES
-------------
Added:            3 issues
Removed:          1 issue

TOP CONTRIBUTORS
----------------
Alice:            8 issues completed
Bob:              6 issues completed
Carol:            4 issues completed
```

### Export Sprint Report

```bash
# JSON for automation or documentation
atlcli jira sprint report --id 456 --json > sprint-report.json
```

## JSON Output

All commands support `--json`:

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
      "startDate": "2025-01-06",
      "endDate": "2025-01-17",
      "goal": "Complete API refactoring",
      "boardId": 123
    }
  ]
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
