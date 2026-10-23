---
title: "Search"
description: "Search - atlcli documentation"
---

# Search

Search Jira issues with JQL or with filter flags, and print the results as a table, CSV or JSON.

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

# Filter by project, status or type (comma-separated for several)
atlcli jira my --project PROJ
atlcli jira my --status "In Progress"
atlcli jira my --type Bug,Task

# Limit results
atlcli jira my --limit 50
```

The `jira my` command generates JQL like:
```
assignee = currentUser() AND resolution IS EMPTY ORDER BY updated DESC
```

## Basic Search

```bash
# By assignee: me, an email, a name or an account id; x (or none) for unassigned
atlcli jira search --assignee me
atlcli jira search --assignee alice@example.com
atlcli jira search --assignee x

# By status or type; a comma-separated list matches any of them
atlcli jira search --status "In Progress"
atlcli jira search --type Bug,Task

# Issues you watch, and issues you viewed recently (most recent first)
atlcli jira search --watching
atlcli jira search --history

# Created or updated recently
atlcli jira search --updated -7d
atlcli jira search --created week

# Combined
atlcli jira search --assignee me --status Open --project PROJ
```

## JQL Search

Use full JQL for complex queries:

```bash
atlcli jira search --jql "project = PROJ AND sprint in openSprints() ORDER BY priority DESC"
```

Filter flags are added to the JQL with `AND`; the JQL's `ORDER BY` stays at the end:

```bash
atlcli jira search --jql "project = PROJ ORDER BY rank" --watching --updated -14d
# → (project = PROJ) AND watcher = currentUser() AND updated >= -14d ORDER BY rank
```

## Filter flags

Each flag expands to JQL:

| Flag | JQL Equivalent |
|------|----------------|
| `--project PROJ` | `project = PROJ` (default: `defaults.project`, only without `--jql`) |
| `--assignee me` | `assignee = currentUser()` |
| `--assignee alice@example.com` | `assignee = "<account id>"` (looked up by email or name) |
| `--assignee x` / `none` | `assignee IS EMPTY` |
| `--status Open` | `status = "Open"` |
| `--status "To Do,In Progress"` | `status in ("To Do", "In Progress")` |
| `--type Bug,Task` | `issuetype in ("Bug", "Task")` |
| `--label backend` | `labels = "backend"` |
| `--sprint current` | `sprint in openSprints()` |
| `--watching` | `watcher = currentUser()` |
| `--history` | `issuekey IN issueHistory()`, ordered by `lastViewed DESC` |
| `--created -7d` | `created >= -7d` |
| `--updated week` | `updated >= startOfWeek()` |
| `--created-before 2026-01-01` | `created < "2026-01-01"` |
| `--updated-before -30d` | `updated < -30d` |
| `--status '~Done'` | `status != "Done"` |
| `--status '~Done,Closed'` | `status not in ("Done", "Closed")` |
| `--label '~ui'` | `(labels IS EMPTY OR labels != "ui")` |
| `--assignee '~me'` | `(assignee IS EMPTY OR assignee != currentUser())` |
| `--assignee '~x'` | `assignee IS NOT EMPTY` |

`--created`, `--updated`, `--created-before` and `--updated-before` take a relative time (`-30m`, `-4h`, `-7d`, `-2w`), `today`, `week`, `month`, `year` (their start), or a date (`2026-10-01`).

### Negation

A leading `~` turns `--status`, `--type`, `--label` and `--assignee` into "anything but". For labels and the assignee, issues with no value count as "anything but", so `--label '~ui'` also finds issues without labels. Quote the value: a shell may expand `~name` to a home directory.

### Status names

Jira shows status names in your language ("Fertig"), but JQL matches the untranslated name ("Done"). `--status` takes either and translates it, so `--status Fertig` finds the issues the table shows as "Fertig". In raw `--jql`, use the untranslated name.

A name for `--assignee` must match one active user: an exact email or display name wins, otherwise the only hit. Several hits fail and list the candidates.

## Output Options

Without `--json`, `search`, `my`, `filter run`, `board issues`, `board backlog`, `sprint issues` and `epic issues` print a table:

```
key     type  status       assignee  summary
PROJ-2  Bug   In Progress  Ann Lee   Login fails on Safari
PROJ-1  Task  To Do                  Update docs
```

```bash
# Choose columns: field ids or field names, also custom fields
atlcli jira search --project PROJ --columns key,status,"Story Points",summary

# Tab-separated for shell scripts, without the header row
atlcli jira search --project PROJ --plain --no-headers | cut -f1

# Another separator
atlcli jira search --project PROJ --delimiter "|"

# CSV (RFC 4180)
atlcli jira search --project PROJ --csv > issues.csv

# Limit results (pages through Jira as needed)
atlcli jira search --jql "..." --limit 250

# Everything that matches, up to 5000 issues
atlcli jira search --jql "..." --all-results

# JSON output
atlcli jira search --jql "..." --json
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--columns` | comma-separated list | `key,type,status,assignee,summary` | Columns: `key`, `id`, `type`, a field id (`duedate`, `customfield_10016`) or a field name (`"Story Points"`) |
| `--plain` | flag | off | Tab-separated, no padding |
| `--delimiter` | text | tab | Separator for `--plain`; implies `--plain` |
| `--csv` | flag | off | CSV with quoting |
| `--no-headers` | flag | off | Leave out the header row |
| `--limit` | positive integer | `25` | Maximum issues returned. Values above 100 are fetched page by page. |
| `--all-results` | flag | off | Return all matches, stopping at 5000 with a warning. Overrides `--limit`. |

Cells show names (status, users, options), join lists with commas, and render rich text as one line of markdown. When more issues match than were returned, a note goes to stderr.

`--json` output is unchanged by the table flags and contains:

| Field | Meaning |
|-------|---------|
| `issues` | The returned issues |
| `total` | Number of issues **returned**. Jira's search endpoint does not report a total match count. |
| `hasMore` | `true` if Jira offered another page. Jira also does this when a page is exactly full, so a next page can be empty |
| `nextPageToken` | Jira's token for the next page, when `hasMore` is `true` |

:::note
`jira my --all` keeps its meaning (include resolved issues). Use `--all-results` to lift the result limit.
:::

## Examples

```bash
# My bugs
atlcli jira search --assignee me --type Bug

# Unassigned issues updated this week
atlcli jira search --project PROJ --assignee x --updated week

# Current sprint issues with story points, as CSV
atlcli jira search --sprint current --project PROJ --columns key,summary,"Story Points" --csv

# Keys of issues I watch, for a loop
atlcli jira search --watching --plain --no-headers --columns key
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `"lee" matches several users` | The name fits more than one user | Use the email, the full display name or the account id |
| `Unknown column "Points"` | No field has that id or name | `atlcli jira field search points` lists the exact names |
| `--history` returns nothing | Jira records views from the browser, not from API calls | Open the issues in Jira first |
| `--jql 'status = Fertig'` finds nothing, but the table shows "Fertig" | JQL matches the untranslated status name | Use `--status Fertig`, or the untranslated name (`status = Done`) |
| `--status ~me` matches the wrong value | The shell expanded `~me` to a home directory | Quote it: `--status '~me'` |
| A just-changed issue still matches the old value | Jira's search index lags a few seconds behind writes | Search again |

## Related Topics

- [Issues](issues.md) - Work with individual issues
- [Filters](filters.md) - Save, run and share JQL queries
- [Bulk Operations](bulk-operations.md) - Batch updates on search results
