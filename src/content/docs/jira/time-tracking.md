---
title: "Time Tracking"
description: "Time Tracking - atlcli documentation"
---

# Time Tracking

Log work on issues with direct entry or timer mode.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Work on Issues

## Timer Mode

Start a timer, work, then stop to log time automatically:

```bash
# Start timer
atlcli jira worklog timer start PROJ-123

# Check active timer
atlcli jira worklog timer status

# Stop and log time
atlcli jira worklog timer stop
```

### Timer Options

```bash
# Start with comment
atlcli jira worklog timer start PROJ-123 --comment "Starting code review"

# Stop with rounding
atlcli jira worklog timer stop --round 15m

# Cancel timer without logging
atlcli jira worklog timer cancel
```

### Timer State

Timer state is stored in `~/.atlcli/timer.json`:

```json
{
  "issueKey": "PROJ-123",
  "startTime": "2025-01-14T09:00:00Z",
  "comment": "Working on feature"
}
```

## Direct Entry

Log time directly without using the timer:

```bash
atlcli jira worklog add PROJ-123 2h
atlcli jira worklog add PROJ-123 30m --comment "Bug investigation"
atlcli jira worklog add PROJ-123 1h --started "2026-01-14T09:00:00"
```

Options:

| Flag | Description |
|------|-------------|
| `--comment` | Work description |
| `--started` | Start time (defaults to now) |
| `--round` | Round time to interval |

## Time Formats

atlcli supports flexible time input formats:

### Duration Formats

| Format | Example | Description |
|--------|---------|-------------|
| Hours | `2h`, `1.5h` | Hours (decimal supported) |
| Minutes | `30m`, `45m` | Minutes |
| Combined | `1h 30m`, `1h30m` | Hours and minutes |
| Days | `1d` | Days (= 8h by default) |
| Weeks | `1w` | Weeks (= 5d by default) |
| Full | `1w 2d 3h 4m` | All units combined |
| Colon | `1:30` | Hours:minutes format |
| Verbose | `1 hour 30 minutes` | Natural language |

### Date/Time Formats

For `--started` flag:

| Format | Example |
|--------|---------|
| ISO 8601 | `2025-01-14T09:00:00` |
| Date only | `2025-01-14` (assumes start of day) |
| Relative | `today`, `yesterday` |
| Time only | `09:00`, `14:30` (today) |

### Examples

```bash
# Various time formats
atlcli jira worklog add PROJ-123 1h30m
atlcli jira worklog add PROJ-123 1.5h
atlcli jira worklog add PROJ-123 "1 hour 30 minutes"
atlcli jira worklog add PROJ-123 1:30
atlcli jira worklog add PROJ-123 "1w 2d"

# Various date formats
atlcli jira worklog add PROJ-123 2h --started yesterday
atlcli jira worklog add PROJ-123 2h --started "2026-01-14T09:00:00"
atlcli jira worklog add PROJ-123 2h --started 09:00
```

## Rounding

Round logged time to common intervals:

```bash
# Round to 15 minutes
atlcli jira worklog add PROJ-123 37m --round 15m
# Result: 45m

# Round on timer stop
atlcli jira worklog timer stop --round 15m
```

Common rounding intervals:

| Interval | Description |
|----------|-------------|
| `5m` | Round to 5 minutes |
| `15m` | Round to quarter hour |
| `30m` | Round to half hour |
| `1h` | Round to full hour |

Rounding uses standard rounding rules (rounds up at midpoint).

## List Worklogs

View all worklogs on an issue:

```bash
atlcli jira worklog list --issue PROJ-123
```

Options:

| Flag | Description |
|------|-------------|
| `--issue` | Issue key (required) |
| `--limit` | Maximum results |

## Update Worklog

```bash
atlcli jira worklog update --issue PROJ-123 --id 10001 --time 3h
atlcli jira worklog update --issue PROJ-123 --id 10001 --comment "Updated description"
```

## Delete Worklog

```bash
atlcli jira worklog delete --issue PROJ-123 --id 10001 --confirm
```

## Time Report

Generate a time report for a user across all issues:

```bash
# Current user, last 30 days (default)
atlcli jira worklog report

# Specific date range
atlcli jira worklog report --since 2026-01-01 --until 2026-01-14

# Specific user
atlcli jira worklog report --user john@example.com

# Group by issue or date
atlcli jira worklog report --group-by issue
atlcli jira worklog report --group-by date
```

Options:

| Flag | Description |
|------|-------------|
| `--user` | User email or `me` (default: `me`) |
| `--since` | Start date (default: 30 days ago) |
| `--until` | End date (default: today) |
| `--group-by` | Group results: `issue` or `date` |

### Date formats for --since/--until

| Format | Example | Description |
|--------|---------|-------------|
| Relative days | `7d`, `30d` | Days ago |
| Relative weeks | `1w`, `2w` | Weeks ago |
| Relative months | `1m`, `3m` | Months ago |
| Absolute date | `2026-01-01` | Specific date |
| Relative | `today`, `yesterday` | Named dates |

### Report Output

The report includes:

- **Summary**: Total time, worklog count, issue count, average per day
- **Worklogs**: List of all worklogs with issue key, summary, time, and comment
- **Grouping**: Optional `byIssue` or `byDate` breakdown

```bash
atlcli jira worklog report --since 7d --json
```

```json
{
  "schemaVersion": "1",
  "user": "Björn Schotte",
  "dateRange": { "from": "2026-01-07", "to": "2026-01-14" },
  "summary": {
    "totalTimeSeconds": 5400,
    "totalTimeHuman": "1 hour 30 minutes",
    "worklogCount": 1,
    "issueCount": 1,
    "averagePerDay": "12 minutes"
  },
  "worklogs": [
    {
      "issueKey": "PROJ-123",
      "issueSummary": "Implement feature",
      "timeSpent": "1h 30m",
      "timeSpentSeconds": 5400,
      "started": "2026-01-14T09:00:00.000+0100",
      "comment": "Initial work"
    }
  ]
}
```

## JSON Output

All worklog commands support `--json` for structured output:

```bash
atlcli jira worklog list --issue PROJ-123 --json
```

```json
{
  "schemaVersion": "1",
  "worklogs": [
    {
      "id": "10001",
      "author": "Alice",
      "authorId": "557058:abc123",
      "timeSpent": "2h",
      "timeSpentSeconds": 7200,
      "timeSpentHuman": "2 hours",
      "started": "2026-01-14T09:00:00.000+0000",
      "comment": "Initial investigation"
    }
  ],
  "total": 1
}
```

## Best Practices

1. **Use timer mode** - More accurate than manual entry
2. **Add comments** - Describe what work was done
3. **Round consistently** - Use same interval across team
4. **Log daily** - Don't let work accumulate
5. **Review reports** - Track where time is spent

## Related Topics

- [Issues](issues.md) - Work with individual issues
- [Analytics](analytics.md) - Sprint velocity and metrics
- [Boards & Sprints](boards-sprints.md) - Sprint management
