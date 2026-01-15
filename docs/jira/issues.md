# Issues

Create, read, update, and delete Jira issues.

## Get Issue

```bash
atlcli jira issue get --key PROJ-123
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--fields` | Specific fields to return |
| `--expand` | Expand: `changelog`, `comments`, `transitions` |
| `--format` | Output format: `table`, `json`, `yaml` |

### Examples

```bash
# Get issue with all details
atlcli jira issue get --key PROJ-123 --expand all

# Get specific fields only
atlcli jira issue get --key PROJ-123 --fields summary,status,assignee

# JSON output
atlcli jira issue get --key PROJ-123 --json
```

## Create Issue

```bash
atlcli jira issue create --project PROJ --type Task --summary "Fix login bug"
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Project key (required) |
| `--type` | Issue type (required) |
| `--summary` | Issue summary (required) |
| `--description` | Issue description |
| `--assignee` | Assignee account ID or email |
| `--priority` | Priority name |
| `--labels` | Comma-separated labels |
| `--parent` | Parent issue key (for subtasks) |
| `--epic` | Epic key to add issue to |
| `--sprint` | Sprint ID to add issue to |
| `--template` | Use saved template |

### Examples

```bash
# Create with full details
atlcli jira issue create --project PROJ --type Bug \
  --summary "Login fails on mobile" \
  --description "Users report 500 error on iOS Safari" \
  --priority High \
  --labels bug,mobile,urgent

# Create from template
atlcli jira issue create --project PROJ --template bug-report

# Create and assign
atlcli jira issue create --project PROJ --type Task \
  --summary "Update docs" \
  --assignee alice@company.com
```

## Update Issue

```bash
atlcli jira issue update --key PROJ-123 --summary "Updated summary"
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--summary` | New summary |
| `--description` | New description |
| `--priority` | New priority |
| `--labels` | Replace labels |
| `--add-labels` | Add labels |
| `--remove-labels` | Remove labels |
| `--assignee` | New assignee |
| `--set` | Set field value: `field=value` |

### Examples

```bash
# Update multiple fields
atlcli jira issue update --key PROJ-123 \
  --summary "New summary" \
  --priority Critical

# Modify labels
atlcli jira issue update --key PROJ-123 --add-labels reviewed

# Set custom field
atlcli jira issue update --key PROJ-123 --set "customfield_10001=value"
```

## Delete Issue

```bash
atlcli jira issue delete --key PROJ-123 --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--confirm` | Skip confirmation prompt |
| `--delete-subtasks` | Also delete subtasks |

## Transitions

Change issue status:

```bash
atlcli jira issue transition --key PROJ-123 --to "In Progress"
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--to` | Target status name (required) |

### List Available Transitions

```bash
atlcli jira issue transitions --key PROJ-123
```

Output:

```
ID    NAME           TO STATUS
21    Start          In Progress
31    Done           Done
41    Review         In Review
```

## Comments

Add a comment to an issue:

```bash
atlcli jira issue comment --key PROJ-123 "Working on this"
```

The comment text is passed as a positional argument after `--key`.

## Links

```bash
# Link issues
atlcli jira issue link --from PROJ-123 --to PROJ-456 --type "blocks"
```

Options:

| Flag | Description |
|------|-------------|
| `--from` | Source issue key (required) |
| `--to` | Target issue key (required) |
| `--type` | Link type name (required) |

### Link Types

Common link types:

| Type | Description |
|------|-------------|
| `blocks` | This issue blocks another |
| `is blocked by` | This issue is blocked by another |
| `duplicates` | This issue duplicates another |
| `relates to` | General relation |
| `clones` | This issue clones another |

## Watchers

Watcher commands are top-level jira commands:

```bash
# List watchers
atlcli jira watchers PROJ-123

# Add yourself as watcher
atlcli jira watch PROJ-123

# Remove yourself
atlcli jira unwatch PROJ-123
```

## Assign

```bash
# Assign to user
atlcli jira issue assign --key PROJ-123 --assignee alice@company.com

# Unassign
atlcli jira issue assign --key PROJ-123 --assignee none
```

## Cross-Product Linking

Link Jira issues to Confluence pages for bidirectional traceability.

### Link Page to Issue

```bash
atlcli jira issue link-page --key PROJ-123 --page 12345
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--page` | Confluence page ID (required) |

### List Linked Pages

```bash
atlcli jira issue pages --key PROJ-123
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--space` | Filter by Confluence space |

### Unlink Page

```bash
atlcli jira issue unlink-page --key PROJ-123 --page 12345
```

### Examples

```bash
# Link a Confluence page to an issue
atlcli jira issue link-page --key PROJ-123 --page 12345

# List all Confluence pages linked to an issue
atlcli jira issue pages --key PROJ-123

# Filter by space
atlcli jira issue pages --key PROJ-123 --space TEAM

# Remove link
atlcli jira issue unlink-page --key PROJ-123 --page 12345
```

## JSON Output

All commands support `--json`:

```bash
atlcli jira issue get --key PROJ-123 --json
```

```json
{
  "schemaVersion": "1",
  "key": "PROJ-123",
  "id": "10001",
  "summary": "Fix login bug",
  "status": {
    "name": "In Progress",
    "category": "indeterminate"
  },
  "priority": {
    "name": "High",
    "iconUrl": "..."
  },
  "assignee": {
    "displayName": "Alice",
    "emailAddress": "alice@company.com"
  },
  "reporter": {
    "displayName": "Bob",
    "emailAddress": "bob@company.com"
  },
  "created": "2025-01-14T10:00:00Z",
  "updated": "2025-01-14T15:30:00Z",
  "labels": ["bug", "critical"],
  "url": "https://company.atlassian.net/browse/PROJ-123"
}
```
