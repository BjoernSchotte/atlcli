---
title: "Filters"
description: "Filters - atlcli documentation"
---

# Filters

Save, run and share JQL filters.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects (read), Manage Filters (create/update)

## List Filters

```bash
atlcli jira filter list
```

Options:

| Flag | Description |
|------|-------------|
| `--favorite` | Show only favorites |
| `--query` | Filter by name |
| `--limit` | Maximum filters (default 50) |

## Get Filter

```bash
atlcli jira filter get 12345
```

## Run Filter

List the filter's issues, like [search](search.md): a table by default, with `--columns`, `--plain`, `--csv`, `--no-headers`, `--limit`, `--all-results` and `--json`.

```bash
atlcli jira filter run 12345
atlcli jira filter run 12345 --columns key,status,assignee --csv
```

## Create Filter

```bash
atlcli jira filter create --name "My Open Bugs" --jql "assignee = currentUser() AND type = Bug AND status != Done"
```

Options:

| Flag | Description |
|------|-------------|
| `--name` | Filter name |
| `--jql` | JQL query |
| `--description` | Filter description |
| `--favorite` | Add to favorites |

## Update Filter

```bash
atlcli jira filter update 12345 --jql "assignee = currentUser() AND status = 'In Progress'"
```

## Delete Filter

```bash
atlcli jira filter delete 12345 --confirm
```

## Share Filter

Share a filter with a user, a group, a project or everyone:

```bash
atlcli jira filter share 12345 --user alice@company.com
atlcli jira filter share 12345 --group developers
atlcli jira filter share 12345 --project PROJ
atlcli jira filter share 12345 --type global
```

Options:

| Flag | Description |
|------|-------------|
| `--user` | Share with a user: email, name or account ID (Jira Cloud) |
| `--group` | Share with a group |
| `--project` | Share with a project |
| `--type` | `global`, `project`, `group` or `user`. Optional when `--user`, `--group` or `--project` is given |

## Related Topics

- [Search](search.md) - JQL search, filter flags and table output
- [Bulk Operations](bulk-operations.md) - Use filters for batch updates
