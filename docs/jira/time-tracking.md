# Time Tracking

Log work on issues with direct entry or timer mode.

## Timer Mode

Start a timer, work, then stop to log time automatically:

```bash
# Start timer
atlcli jira worklog timer start PROJ-123

# Check active timer
atlcli jira worklog timer status

# Stop and log time
atlcli jira worklog timer stop PROJ-123
```

### Timer Options

```bash
# Stop with comment
atlcli jira worklog timer stop PROJ-123 --comment "Completed code review"

# Cancel timer without logging
atlcli jira worklog timer cancel PROJ-123
```

## Direct Entry

Log time directly:

```bash
atlcli jira worklog add PROJ-123 --time 2h
atlcli jira worklog add PROJ-123 --time 30m --comment "Bug investigation"
atlcli jira worklog add PROJ-123 --time 1h --started "2025-01-14T09:00:00"
```

### Time Formats

| Format | Example |
|--------|---------|
| Hours | `2h`, `1.5h` |
| Minutes | `30m`, `45m` |
| Combined | `1h 30m` |
| Days | `1d` (= 8h by default) |
| Weeks | `1w` (= 5d by default) |

## List Worklogs

```bash
atlcli jira worklog list PROJ-123
```

## Update Worklog

```bash
atlcli jira worklog update PROJ-123 --worklog 10001 --time 3h
```

## Delete Worklog

```bash
atlcli jira worklog delete PROJ-123 --worklog 10001 --confirm
```

## Time Report

View logged time across issues:

```bash
atlcli jira worklog report --user me --from 2025-01-01 --to 2025-01-14
```
