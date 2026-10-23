---
name: jira-search
description: Finding Jira issues with JQL, convenience filters, saved filters, and CSV/JSON export.
metadata:
  tags: jira, jql, search, filters, export, import
---

# Finding Jira issues

## Contents

- [Search](#search)
- [Convenience filters](#convenience-filters)
- [My issues](#my-issues)
- [Saved filters](#saved-filters)
- [Export and import](#export-and-import)
- [Anti-patterns](#anti-patterns)

## Search

```bash
atlcli jira search --jql 'project = PROJ AND status != Closed ORDER BY updated DESC' \
  --limit 50 --json
```

JQL may be passed positionally (`atlcli jira search 'project = PROJ'`, the
tokens are joined with spaces), as `--jql <query>` or as `--jql='<query>'`.
The positional form takes precedence if you pass both. Without `--json` the
result is a table (`--columns`, `--plain`, `--csv`).

`--limit` defaults to 25 and must be a positive integer. The search pages
through the API internally until it has `--limit` issues or the last page. The
response carries the effective query, which is worth logging when the query was
assembled from convenience flags:

```json
{ "schemaVersion": "1", "jql": "project = PROJ AND assignee = currentUser()",
  "issues": [ … ], "total": 25, "hasMore": true, "nextPageToken": "…" }
```

Issues come back flattened (`key`, `summary`, `status`, `type`, `assignee`,
`labels`, `parent`, and so on), with `description` as the raw ADF document.

### Result sets larger than `--limit`

`total` is the number of issues returned, not the number that matched. Read
`hasMore`: `true` means more issues matched than were returned. There is no flag
to resume from `nextPageToken`. To get more, raise `--limit`, or pass
`--all-results`, which fetches up to 5000 issues and prints a warning on stderr
about that ceiling. `jira my` takes the same two flags.

For a complete result set of any size use `jira export`, which has no ceiling
(it writes a local file, so confirm the path first):

```bash
atlcli jira export --jql 'project = PROJ AND resolution IS EMPTY' -o ./all.json --json
```

## Convenience filters

atlcli builds clauses from these flags and joins them with `AND`:

| Flag | Becomes |
| --- | --- |
| `--project PROJ` | `project = PROJ` (falls back to the configured default without JQL) |
| `--assignee me` | `assignee = currentUser()` |
| `--assignee <email, name or accountId>` | `assignee = "<accountId>"` (looked up) |
| `--assignee x` (or `none`) | `assignee IS EMPTY` |
| `--status 'In Progress'` | `status = "In Progress"` |
| `--status 'To Do,In Progress'` | `status in ("To Do", "In Progress")` |
| `--type Bug` | `issuetype = "Bug"` |
| `--label ops` | `labels = "ops"` |
| `--sprint current` (or `active`) | `sprint IN openSprints()` |
| `--sprint 42` | `sprint = "42"` |
| `--watching` | `watcher = currentUser()` |
| `--created -7d`, `--updated week` | `created >= -7d`, `updated >= startOfWeek()` |
| `--created-before`, `--updated-before` | `created < …`, `updated < …` |

`--status`, `--type` and `--label` take comma lists. A leading `~` negates
`--status`, `--type`, `--label` and `--assignee` (`--status '~Done'`); quote
it so the shell does not expand it. `--status` also takes the localized status
name Jira shows and translates it for JQL.

With no flags and no JQL the query is `project = <default>` when a default
project is configured, otherwise `ORDER BY created DESC` across the whole site.
Check `atlcli config list --json` before concluding a result set is site-wide.

```bash
atlcli jira search --project PROJ --assignee me --status 'In Progress' --json
```

With JQL, the flags are added to it: `--jql 'project = PROJ ORDER BY rank'
--watching` becomes `(project = PROJ) AND watcher = currentUser() ORDER BY
rank`. The default project is not added to a query that has JQL.

## My issues

```bash
atlcli jira my --json                    # assignee = currentUser() AND resolution IS EMPTY
atlcli jira my --project PROJ --all --json
atlcli jira me --json                    # current user: accountId, displayName, emailAddress, timeZone
```

`jira my` accepts `--project`, `--status`, `--type`, `--limit` and
`--all-results`. It adds `resolution IS EMPTY` unless `--all` or an explicit
`--status` is given, and orders by `updated DESC`. It has no `--jql`. Here
`--all` means "include resolved issues"; it does not lift the limit.

`jira me` returns `{ "user": { … } }`. Its `accountId` identifies the user
unambiguously wherever a flag takes a user.

## Saved filters

```bash
atlcli jira filter list --json
atlcli jira filter list --favorite --json
atlcli jira filter get 10000 --json
atlcli jira filter create --name 'My Open Issues' \
  --jql 'assignee = currentUser() AND resolution IS EMPTY' --json
atlcli jira filter update 10000 --jql 'assignee = currentUser() AND status != Done' --json
atlcli jira filter share 10000 --type project --project PROJ --json
atlcli jira filter delete 10000 --confirm --json
```

Filter IDs are positional on `get`, `update`, `share`, and `delete`. `list`
takes `--query <name text>` and `--limit` (default 50); `--favorite` lists the
favourites and ignores both. `create` also takes `--description` and
`--favorite`. `share --type` is `global`, `project` or `group`; `project` needs
`--project` (or `global.project`) and `group` needs `--group <name>`. Sharing
changes what other people see, so confirm it first.

## Export and import

```bash
atlcli jira export --jql 'project = PROJ AND sprint IN openSprints()' \
  -o ./sprint.json --json
atlcli jira export --jql 'assignee = currentUser()' -o ./mine.csv --format csv --json
```

`--jql` and `-o/--output` are both required; a missing one is a usage error.
Format is `json` (default) or `csv`. Comments (as Markdown) and attachments are
included unless `--no-comments` / `--no-attachments` is passed. A comment or
attachment that fails to download is recorded under `exportErrors` on its
issue in the file, and the run exits 1 after writing the file, naming the
incomplete issues on stderr (in the error `details` with `--json`). This writes a local file: confirm the path.

Attachments are embedded base64-encoded in a JSON export, so the file can get
large. A CSV export instead writes them to `<output>_attachments/<KEY>/` next
to the file. Pass `--no-attachments` unless the user wants them.

`atlcli jira import --file issues.json --project PROJ --dry-run --json` creates
issues from an exported `.json` or `.csv` file. It is a bulk write: run
`--dry-run` first, show the user the plan, and only then repeat without it. Both
`--file` and `--project` (or `global.project`) are required; a missing one is
a usage error, and only a bare `jira import` prints the help. Other flags:

- `--skip-attachments` does not upload the attachments contained in the file.
- `--map-field "CSV Column=field"` renames a CSV column before mapping. It is
  repeatable and applies to CSV only.

Import only creates issues. String descriptions and comments are Markdown. In
the `--dry-run` result every issue counts as `created`; nothing is sent.

## Anti-patterns

- Assuming an empty result means "nothing matches". A configured
  `global.project` may be narrowing the query when the query is built from
  convenience flags, and `--limit` defaults to 25.
- Treating `total` as a match count. Check `hasMore`.
- Reading `.fields.status.name` from a search hit. The shape is flattened to
  `status`.

Related: [jira-issues.md](jira-issues.md),
[jira-bulk-and-admin.md](jira-bulk-and-admin.md) for acting on a query's
results.
