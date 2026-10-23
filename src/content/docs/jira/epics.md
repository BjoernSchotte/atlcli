---
title: "Epics"
description: "Epics - atlcli documentation"
---

# Epics

Manage epics and their child issues.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects (read), Edit Issues (write)

## List Epics

```bash
atlcli jira epic list --project ATLCLI
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Filter by project key (default: `defaults.project`) |
| `--board` | List the epics of a board instead (Agile API) |
| `--done` | Include completed epics |
| `--limit` | Maximum results (default 50) |

`epic list` searches with JQL (`issuetype = Epic`, unresolved unless `--done`) by default. It uses the board instead when you pass `--board`, or when `defaults.board` is set and you pass no `--project`; an explicit `--project` wins over `defaults.board`.

### Examples

```bash
# List epics in a project
atlcli jira epic list --project ATLCLI

# List epics on a board
atlcli jira epic list --board 123

# Include completed epics
atlcli jira epic list --project ATLCLI --done
```

## Get Epic

```bash
atlcli jira epic get ATLCLI-100
```

Prints the epic's status, assignee, progress bar and description. With `--json`: `{schemaVersion, epic}` with `key`, `summary`, `status`, `statusCategory`, `description`, `assignee`, `reporter`, `created`, `updated`, `childCount` and `progress` (`done`, `total`, `percent`).

## Create Epic

```bash
atlcli jira epic create --project ATLCLI --summary "User Authentication"
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Project key (required) |
| `--summary` | Epic summary (required) |
| `--description` | Epic description |

## Epic Issues

List issues in an epic:

```bash
atlcli jira epic issues ATLCLI-100
```

Options:

| Flag | Description |
|------|-------------|
| `--status` | Filter by status name |
| `--limit` | Maximum results (default 50) |

Prints a table without `--json`; it takes the same `--columns`, `--plain`, `--delimiter`, `--csv` and `--no-headers` flags as [search](search.md).

## Add Issues to Epic

Add one or more issues to an epic:

```bash
atlcli jira epic add ATLCLI-101 ATLCLI-102 ATLCLI-103 --epic ATLCLI-100
```

The issue keys are positional arguments, and `--epic` specifies the target epic.

## Remove Issues from Epic

Remove issues from their epic:

```bash
atlcli jira epic remove ATLCLI-101
```

This removes the issue from its current epic.

## Epic Progress

View completion status:

```bash
atlcli jira epic progress ATLCLI-100
```

Output:

```json
{
  "schemaVersion": "1",
  "epic": { "key": "ATLCLI-100", "summary": "User Authentication", "status": "In Progress" },
  "progress": {
    "done": 6,
    "inProgress": 2,
    "todo": 2,
    "total": 10,
    "percent": 60,
    "bar": "[############--------] 60%"
  }
}
```

The counts follow each child issue's status category (Done, In Progress, To Do).

## JSON Output

All epic commands except `epic issues` print JSON, pretty-printed even without `--json`.

```bash
atlcli jira epic list --project ATLCLI
```

```json
{
  "schemaVersion": "1",
  "jql": "issuetype = Epic AND project = ATLCLI AND resolution IS EMPTY ORDER BY created DESC",
  "epics": [
    {
      "key": "ATLCLI-100",
      "summary": "User Authentication",
      "status": "In Progress",
      "statusCategory": "indeterminate",
      "assignee": "Alice Lee",
      "created": "2025-01-06T09:00:00.000+0000"
    }
  ]
}
```

With `--board`, each epic has the Agile API fields instead: `id`, `key`, `name`, `summary`, `done` and `color`, plus `total`.

## Related Topics

- [Issues](issues.md) - Work with individual issues
- [Boards & Sprints](boards-sprints.md) - Sprint management
- [Analytics](analytics.md) - Epic progress tracking
