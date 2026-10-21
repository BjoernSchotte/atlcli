---
title: "Search"
description: "Search - atlcli documentation"
---

# Search

Search Jira issues using JQL or convenient shortcuts.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects

## My Issues

Quick access to your assigned issues:

```bash
# Open issues assigned to me (default)
atlcli jira my

# All my issues (including resolved)
atlcli jira my --all

# Filter by project
atlcli jira my --project PROJ

# Filter by status
atlcli jira my --status "In Progress"

# Filter by type
atlcli jira my --type Bug

# Limit results
atlcli jira my --limit 50
```

The `jira my` command generates JQL like:
```
assignee = currentUser() AND resolution IS EMPTY ORDER BY updated DESC
```

## Basic Search

```bash
# By assignee
atlcli jira search --assignee me

# By status
atlcli jira search --status "In Progress"

# By project
atlcli jira search --project PROJ

# Combined
atlcli jira search --assignee me --status Open --project PROJ
```

## JQL Search

Use full JQL for complex queries:

```bash
atlcli jira search --jql "project = PROJ AND sprint in openSprints() ORDER BY priority DESC"
```

## Shortcuts

Convenience flags that expand to JQL:

| Flag | JQL Equivalent |
|------|----------------|
| `--assignee me` | `assignee = currentUser()` |
| `--status Open` | `status = "Open"` |
| `--type Bug` | `issuetype = Bug` |
| `--project PROJ` | `project = PROJ` |
| `--label backend` | `labels = "backend"` |
| `--sprint current` | `sprint in openSprints()` |

## Output Options

```bash
# Limit results (pages through Jira as needed)
atlcli jira search --jql "..." --limit 250

# Everything that matches, up to 5000 issues
atlcli jira search --jql "..." --all-results

# JSON output
atlcli jira search --jql "..." --json
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--limit` | positive integer | `25` | Maximum issues returned. Values above 100 are fetched page by page. |
| `--all-results` | flag | off | Return all matches, stopping at 5000 with a warning. Overrides `--limit`. |

`search` and `my` accept the same two flags. JSON output contains:

| Field | Meaning |
|-------|---------|
| `issues` | The returned issues |
| `total` | Number of issues **returned**. Jira's search endpoint does not report a total match count. |
| `hasMore` | `true` if more issues matched than were returned |
| `nextPageToken` | Jira's token for the next page, when `hasMore` is `true` |

:::note
`jira my --all` keeps its meaning (include resolved issues). Use `--all-results` to lift the result limit.
:::

## Examples

```bash
# My bugs
atlcli jira search --assignee me --type Bug

# Unassigned high priority
atlcli jira search --jql "assignee is EMPTY AND priority = High"

# Current sprint issues
atlcli jira search --sprint current --project PROJ

# Issues with specific label
atlcli jira search --label backend --status "In Progress"
```

## Related Topics

- [Issues](issues.md) - Work with individual issues
- [Filters](filters.md) - Save and reuse JQL queries
- [Bulk Operations](bulk-operations.md) - Batch updates on search results
