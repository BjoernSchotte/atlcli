# Logging

atlcli includes comprehensive JSONL logging for observability, debugging, and enterprise audit requirements.

::: toc

## Log Locations

| Location | Path | Purpose |
|----------|------|---------|
| **Global** | `~/.atlcli/logs/YYYY-MM-DD.jsonl` | All operations |
| **Project** | `.atlcli/logs/YYYY-MM-DD.jsonl` | Project-specific operations |

Both locations are written to by default when a `.atlcli/` directory exists.

## Viewing Logs

### List Recent Entries

```bash
atlcli log list
atlcli log list --limit 50
```

### Filter by Time

```bash
# Relative time
atlcli log list --since 1h
atlcli log list --since 24h
atlcli log list --since 7d

# Date range
atlcli log list --since "2025-01-01" --until "2025-01-14"
```

### Filter by Level

```bash
atlcli log list --level error
atlcli log list --level warn
atlcli log list --level info
atlcli log list --level debug
```

### Filter by Type

```bash
# All API logs
atlcli log list --type api

# Just command invocations
atlcli log list --type cli.command

# Sync events
atlcli log list --type sync

# Auth changes
atlcli log list --type auth
```

### Combine Filters

```bash
atlcli log list --type api --level error --since 24h
```

## Following Logs

Real-time log streaming:

```bash
# Follow new entries
atlcli log tail -f

# Follow with filter
atlcli log tail -f --level error

# Project logs only
atlcli log tail --project
```

## Log Entry Details

View full details of a specific entry:

```bash
# Get ID from log list
atlcli log list --limit 5

# Show full entry
atlcli log show abc123-uuid-here
```

## Clearing Logs

```bash
# Clear logs older than 30 days
atlcli log clear --before 30d --confirm

# Clear only global logs
atlcli log clear --before 7d --global --confirm

# Clear only project logs
atlcli log clear --before 7d --project --confirm
```

## Log Entry Types

| Type | Description |
|------|-------------|
| `cli.command` | CLI command invocations with args and flags |
| `cli.result` | Command completion with exit code and duration |
| `api.request` | Confluence/Jira API requests |
| `api.response` | API responses with status and duration |
| `sync.event` | Sync events (pull, push, conflict) |
| `auth.change` | Authentication changes (login, logout, switch) |
| `error` | Errors with stack traces and context |

## Log Format

Each entry is a JSON object:

```json
{
  "id": "5bb8303b-08ce-4c9d-9a2e-657ca2ceaece",
  "timestamp": "2025-01-14T12:12:20.722Z",
  "level": "info",
  "type": "api.request",
  "pid": 12345,
  "sessionId": "3ea06a39-52b2-4b18-a74b-8d0e6ee02ddf",
  "data": {
    "requestId": "ada26fed-45b8-42f1-881b-2034f6f9b6bd",
    "method": "GET",
    "url": "https://company.atlassian.net/wiki/rest/api/content/123"
  }
}
```

### Key Fields

| Field | Description |
|-------|-------------|
| `id` | Unique entry identifier |
| `sessionId` | Correlates all logs from one CLI invocation |
| `requestId` | Correlates API request with its response |
| `pid` | Process ID |
| `level` | error, warn, info, debug |
| `type` | Entry type (see above) |
| `data` | Type-specific payload |

## JSON Output

For scripting and analysis:

```bash
# Get raw JSON
atlcli log list --json

# Query with jq
atlcli log list --json | jq '.entries[] | select(.data.status >= 400)'

# Count errors by type
atlcli log list --level error --json | jq 'group_by(.type) | map({type: .[0].type, count: length})'
```

## Configuration

Configure logging in `~/.atlcli/config.json`:

```json
{
  "logging": {
    "level": "info",
    "global": true,
    "project": true
  }
}
```

### Options

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `level` | off, error, warn, info, debug | `info` | Minimum level to log |
| `global` | true, false | `true` | Write to global log |
| `project` | true, false | `true` | Write to project log |

## Disabling Logging

```bash
# Single command
atlcli wiki page list --space DEV --no-log

# Globally (in config)
# Set "level": "off"
```

## Sensitive Data Handling

Sensitive fields are automatically redacted:

| Field | Redacted As |
|-------|-------------|
| API tokens | `[REDACTED]` |
| Passwords | `[REDACTED]` |
| Authorization headers | `Basic [REDACTED]` |

**Not redacted** (needed for audit):

- Email addresses
- Page titles
- Content (for sync debugging)

## Use Cases

### Debug API Failures

```bash
# Find failed requests
atlcli log list --type api.response --json | \
  jq '.entries[] | select(.data.status >= 400) | {url: .data.url, status: .data.status}'
```

### Audit Trail

```bash
# Who did what
atlcli log list --type cli.command --since 7d --json | \
  jq '.entries[] | "\(.timestamp): \(.data.command) \(.data.args | join(" "))"'
```

### Performance Analysis

```bash
# Slow API calls
atlcli log list --type api.response --json | \
  jq '.entries[] | select(.data.duration > 1000) | {url: .data.url, duration: .data.duration}'
```

### Correlate Request/Response

```bash
# Find response for a request
REQUEST_ID="ada26fed-45b8-42f1-881b-2034f6f9b6bd"
atlcli log list --json | jq ".entries[] | select(.data.requestId == \"$REQUEST_ID\")"
```

## Related Topics

- [Troubleshooting](troubleshooting.md) - Common issues and solutions
- [Configuration](../configuration.md) - Logging configuration options
- [Doctor](doctor.md) - Health checks and diagnostics
