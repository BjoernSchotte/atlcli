---
title: "Bulk Operations"
description: "Bulk Operations - atlcli documentation"
---

# Bulk Operations

Perform batch operations on multiple issues.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Edit Issues for all matched issues

## Bulk Edit

Update multiple issues at once using `--set field=value` syntax:

```bash
atlcli jira bulk edit --jql "project = PROJ AND labels = cleanup" --set "labels=backend,tech-debt"
```

Options:

| Flag | Description |
|------|-------------|
| `--jql` | JQL query to select issues |
| `--issues` | Comma-separated issue keys |
| `--set` | Set field value: `field=value` (repeatable) |
| `--dry-run` | Preview changes without applying |
| `--limit` | Maximum issues to update |
| `--confirm` | Skip confirmation prompt |

### Examples

```bash
# Set priority
atlcli jira bulk edit --jql "project = PROJ AND type = Bug" --set "priority=High"

# Set assignee
atlcli jira bulk edit --jql "status = 'To Do' AND sprint in openSprints()" \
  --set "assignee=alice@company.com"

# Set multiple fields
atlcli jira bulk edit --jql "labels = needs-review" \
  --set "priority=Medium" \
  --set "labels=reviewed"

# Set custom field
atlcli jira bulk edit --jql "project = PROJ" \
  --set "customfield_10001=value"

# By issue keys
atlcli jira bulk edit --issues PROJ-1,PROJ-2,PROJ-3 --set "priority=Low"
```

### Label Operations

For labels, use the dedicated bulk label commands:

```bash
# Add a label to matching issues
atlcli jira bulk label add release-2.0 --jql "sprint in openSprints()"

# Remove a label from matching issues
atlcli jira bulk label remove deprecated --jql "project = PROJ"

# Preview with dry-run
atlcli jira bulk label add reviewed --jql "..." --dry-run
```

## Bulk Transition

Move multiple issues to a new status:

```bash
atlcli jira bulk transition --jql "project = PROJ AND status = 'To Do'" --to "In Progress"
```

Options:

| Flag | Description |
|------|-------------|
| `--jql` | JQL query to select issues |
| `--to` | Target status name (required) |
| `--dry-run` | Preview changes |
| `--limit` | Maximum issues to process |

### Examples

```bash
# Close all bugs in old sprint
atlcli jira bulk transition \
  --jql "type = Bug AND sprint = 'Sprint 10' AND status != Done" \
  --to Done

# Start work on all assigned issues
atlcli jira bulk transition \
  --jql "assignee = currentUser() AND status = 'To Do'" \
  --to "In Progress"
```

## Bulk Move

Move issues between sprints or projects:

```bash
# Move to sprint
atlcli jira bulk move --jql "labels = release-2.0" --sprint 456

# Move to backlog
atlcli jira bulk move --jql "sprint = 123 AND status = 'To Do'" --backlog
```

Options:

| Flag | Description |
|------|-------------|
| `--jql` | JQL query |
| `--issues` | Comma-separated keys |
| `--sprint` | Target sprint ID |
| `--backlog` | Move to backlog |
| `--dry-run` | Preview changes |
| `--confirm` | Skip confirmation |

## Bulk Delete

Delete multiple issues:

```bash
atlcli jira bulk delete --jql "project = PROJ AND labels = test" --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--jql` | JQL query |
| `--issues` | Comma-separated keys |
| `--confirm` | Required for destructive operation |
| `--dry-run` | Preview what would be deleted |

:::caution
Bulk delete is irreversible. Always use `--dry-run` first.

:::

```bash
# Preview first
atlcli jira bulk delete --jql "project = TEST AND created < -90d" --dry-run

# Then execute
atlcli jira bulk delete --jql "project = TEST AND created < -90d" --confirm
```

## Dry Run

All bulk operations support `--dry-run` to preview changes:

```bash
atlcli jira bulk edit --jql "..." --set "priority=High" --dry-run
```

Output:

```
Dry run - no changes will be made

Issues to update (15 total):
  PROJ-101  Fix login bug
  PROJ-102  Update documentation
  PROJ-103  Refactor auth module
  ... and 12 more

Changes:
  priority: Current → High

Run without --dry-run to apply changes.
```

## Progress and Errors

For large batches, progress is shown:

```
Updating issues: 45/100 [████████░░░░░░░░░░░░] 45%
```

Failed updates are reported:

```
Completed: 98/100
Failed: 2
  PROJ-150: Permission denied
  PROJ-175: Invalid transition
```

## Rate Limiting

Bulk operations automatically handle rate limiting:

- Requests are batched
- Automatic retry with backoff on 429 errors
- Progress continues after transient failures

## JSON Output

```bash
atlcli jira bulk edit --jql "..." --set "priority=High" --json
```

```json
{
  "schemaVersion": "1",
  "operation": "edit",
  "total": 15,
  "successful": 15,
  "failed": 0,
  "issues": [
    {"key": "PROJ-101", "status": "updated"},
    {"key": "PROJ-102", "status": "updated"}
  ]
}
```

## Best Practices

1. **Always dry-run first** - Preview before making changes
2. **Use specific JQL** - Narrow your query to avoid unintended updates
3. **Batch appropriately** - Use `--limit` for very large result sets
4. **Check permissions** - Ensure you have edit rights for all matched issues

## Related Topics

- [Search](search.md) - JQL query syntax
- [Issues](issues.md) - Single issue operations
- [Filters](filters.md) - Save and reuse JQL queries
