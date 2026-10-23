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
| `--issues` | Comma-separated issue keys (instead of `--jql`) |
| `--set` | Set field value: `field=value` (repeatable). Commas inside a value, as in `labels=a,b`, stay part of that value. |
| `--dry-run` | Preview changes without applying |
| `--limit` | Maximum issues to update (default 1000) |

Every bulk command takes either `--jql` or `--issues`, not both.

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
| `--issues` | Comma-separated issue keys (instead of `--jql`) |
| `--to` | Target status name (required) |
| `--dry-run` | Preview changes |
| `--limit` | Maximum issues to process (default 1000) |

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

Move issues into a sprint or back to the backlog:

```bash
# Move to sprint
atlcli jira bulk move --jql "labels = release-2.0" --sprint 456

# Move to backlog
atlcli jira bulk move --jql "sprint = 123 AND status = 'To Do'" --backlog

# Specific issues, preview first
atlcli jira bulk move --issues PROJ-1,PROJ-2 --sprint 456 --dry-run
```

Options:

| Flag | Description |
|------|-------------|
| `--jql` | JQL query |
| `--issues` | Comma-separated keys (instead of `--jql`) |
| `--sprint` | Target sprint ID (numeric) |
| `--backlog` | Move to the backlog |
| `--dry-run` | List the issues and the target without moving anything |
| `--limit` | Maximum issues to move (default 1000) |

Give exactly one of `--sprint` or `--backlog`. Issues are moved 50 at a time, the Jira Agile API maximum per request; a failed chunk is reported in `result.errors` and the remaining chunks still run. Moving issues between projects is not supported. For a single sprint, `atlcli jira sprint add` and `sprint remove` do the same job.

## Bulk Link Page

Link one Confluence page to every matching issue (as a remote link, like [`issue link-page`](issues.md#cross-product-linking)):

```bash
atlcli jira bulk link-page --jql "sprint in openSprints()" --page 12345 --dry-run
atlcli jira bulk link-page --issues PROJ-1,PROJ-2 --page 12345 --comment
```

Options:

| Flag | Description |
|------|-------------|
| `--jql` | JQL query |
| `--issues` | Comma-separated keys (instead of `--jql`) |
| `--page` | Confluence page ID (required) |
| `--comment [text]` | Also post a comment on each issue: bare, "Linked to Confluence page: <link>" (as `jira issue link-page` posts); with text, that text as Markdown. `--dry-run` shows it as `comment` (`null` when none) |
| `--dry-run` | Show the page and the matching issues without linking |
| `--limit` | Maximum issues to link (default 1000) |

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
| `--limit` | Maximum issues to delete (default 1000) |

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

```json
{
  "schemaVersion": "1",
  "dryRun": true,
  "operation": "edit",
  "jql": "project = PROJ AND type = Bug",
  "fields": { "priority": { "name": "High" } },
  "affectedIssues": [
    { "key": "PROJ-101", "summary": "Fix login bug" },
    { "key": "PROJ-102", "summary": "Update documentation" }
  ],
  "count": 2
}
```

## Errors

Issues are processed in parallel batches of 10. A failing issue does not stop the others; failures are listed in `result.errors`:

```json
{
  "result": {
    "total": 100,
    "successful": 98,
    "failed": 2,
    "errors": [
      { "key": "PROJ-150", "error": "Permission denied" },
      { "key": "PROJ-175", "error": "Invalid transition" }
    ]
  }
}
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
  "jql": "project = PROJ AND type = Bug",
  "fields": { "priority": { "name": "High" } },
  "result": { "total": 15, "successful": 15, "failed": 0, "errors": [] }
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
- [Boards & Sprints](boards-sprints.md) - Single-sprint moves
