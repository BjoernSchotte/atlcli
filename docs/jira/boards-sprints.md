# Boards & Sprints

Manage Scrum and Kanban boards, sprints, and backlogs.

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
| `--status` | Filter by status |
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

### Update Sprint

```bash
atlcli jira sprint update --id 456 --name "Sprint 14 - Extended"
atlcli jira sprint update --id 456 --goal "Updated goal"
atlcli jira sprint update --id 456 --end "2025-01-20"
```

### Start Sprint

Start a planned sprint:

```bash
atlcli jira sprint start --id 456
```

### Complete Sprint

Complete an active sprint:

```bash
atlcli jira sprint complete --id 456
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Sprint ID (required) |
| `--move-to` | Sprint ID for incomplete issues |

```bash
# Move incomplete issues to next sprint
atlcli jira sprint complete --id 456 --move-to 457

# Move to backlog (default behavior)
atlcli jira sprint complete --id 456
```

### Add Issues to Sprint

```bash
atlcli jira sprint add --id 456 --issues PROJ-1,PROJ-2,PROJ-3
```

### Remove Issues from Sprint

Move issues back to backlog:

```bash
atlcli jira sprint remove --id 456 --issues PROJ-1,PROJ-2
```

### Sprint Report

Get comprehensive sprint metrics:

```bash
atlcli jira sprint report --id 456
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Sprint ID (required) |
| `--format` | Output: `table`, `json`, `markdown` |

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
# Markdown for documentation
atlcli jira sprint report --id 456 --format markdown > sprint-report.md

# JSON for automation
atlcli jira sprint report --id 456 --json
```

## Ranking

### Rank Issues

Change issue order in backlog or sprint:

```bash
# Move before another issue
atlcli jira rank PROJ-1 --before PROJ-2

# Move after another issue
atlcli jira rank PROJ-1 --after PROJ-3
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
4. **Move incomplete work** - Use `--move-to` when completing sprints
