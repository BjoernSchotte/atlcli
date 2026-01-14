# Search

Search Jira issues using JQL or convenient shortcuts.

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
| `--reporter me` | `reporter = currentUser()` |
| `--status Open` | `status = "Open"` |
| `--type Bug` | `issuetype = Bug` |
| `--project PROJ` | `project = PROJ` |
| `--sprint current` | `sprint in openSprints()` |
| `--updated 7d` | `updated >= -7d` |

## Output Options

```bash
# Limit results
atlcli jira search --jql "..." --limit 50

# Specific fields
atlcli jira search --jql "..." --fields key,summary,status

# JSON output
atlcli jira search --jql "..." --json
```

## Examples

```bash
# My bugs from this week
atlcli jira search --assignee me --type Bug --updated 7d

# Unassigned high priority
atlcli jira search --jql "assignee is EMPTY AND priority = High"

# Sprint issues by status
atlcli jira search --sprint current --project PROJ
```
