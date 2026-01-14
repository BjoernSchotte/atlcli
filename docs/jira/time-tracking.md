# Time Tracking

Log work on issues with direct entry or timer mode.

## Timer Mode

Start a timer, work, then stop to log time automatically:

```bash
# Start timer
atlcli jira worklog timer start --key PROJ-123

# Check active timer
atlcli jira worklog timer status

# Stop and log time
atlcli jira worklog timer stop
```

### Timer Options

```bash
# Start with comment
atlcli jira worklog timer start --key PROJ-123 --comment "Starting code review"

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
atlcli jira worklog add --key PROJ-123 --time 2h
atlcli jira worklog add --key PROJ-123 --time 30m --comment "Bug investigation"
atlcli jira worklog add --key PROJ-123 --time 1h --started "2025-01-14T09:00:00"
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--time` | Time spent (required) |
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
atlcli jira worklog add --key PROJ-123 --time 1h30m
atlcli jira worklog add --key PROJ-123 --time 1.5h
atlcli jira worklog add --key PROJ-123 --time "1 hour 30 minutes"
atlcli jira worklog add --key PROJ-123 --time 1:30
atlcli jira worklog add --key PROJ-123 --time "1w 2d"

# Various date formats
atlcli jira worklog add --key PROJ-123 --time 2h --started yesterday
atlcli jira worklog add --key PROJ-123 --time 2h --started "2025-01-14T09:00:00"
atlcli jira worklog add --key PROJ-123 --time 2h --started 09:00
```

## Rounding

Round logged time to common intervals:

```bash
# Round to 15 minutes
atlcli jira worklog add --key PROJ-123 --time 37m --round 15m
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
atlcli jira worklog list --key PROJ-123
```

Output:

```
ID       AUTHOR         TIME    DATE         COMMENT
10001    alice@co.com   2h      2025-01-14   Initial investigation
10002    bob@co.com     1h 30m  2025-01-14   Code review
10003    alice@co.com   3h      2025-01-15   Implementation
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--limit` | Maximum results |

## Update Worklog

```bash
atlcli jira worklog update --key PROJ-123 --worklog-id 10001 --time 3h
atlcli jira worklog update --key PROJ-123 --worklog-id 10001 --comment "Updated description"
```

## Delete Worklog

```bash
atlcli jira worklog delete --key PROJ-123 --worklog-id 10001 --confirm
```

## Time Report

View logged time across issues:

```bash
atlcli jira worklog report --user me --from 2025-01-01 --to 2025-01-14
```

Output:

```
Time Report: 2025-01-01 to 2025-01-14
User: alice@company.com

ISSUE        TIME     DESCRIPTION
PROJ-123     8h       Login feature implementation
PROJ-124     4h 30m   Bug fixes
PROJ-125     2h       Code review
─────────────────────
TOTAL        14h 30m
```

Options:

| Flag | Description |
|------|-------------|
| `--user` | User email or `me` |
| `--from` | Start date |
| `--to` | End date |
| `--project` | Filter by project |
| `--format` | Output: `table`, `json`, `csv` |

## JSON Output

```bash
atlcli jira worklog list --key PROJ-123 --json
```

```json
{
  "schemaVersion": "1",
  "issueKey": "PROJ-123",
  "worklogs": [
    {
      "id": "10001",
      "author": {
        "displayName": "Alice",
        "emailAddress": "alice@company.com"
      },
      "timeSpent": "2h",
      "timeSpentSeconds": 7200,
      "started": "2025-01-14T09:00:00.000+0000",
      "comment": "Initial investigation"
    }
  ],
  "total": 3
}
```

## Best Practices

1. **Use timer mode** - More accurate than manual entry
2. **Add comments** - Describe what work was done
3. **Round consistently** - Use same interval across team
4. **Log daily** - Don't let work accumulate
5. **Review reports** - Track where time is spent
