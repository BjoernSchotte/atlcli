---
name: jira-agile
description: Boards, sprints, sprint review pages, epics, sprint analytics, and worklog/timer time tracking.
metadata:
  tags: jira, boards, sprints, sprint-review, epics, analytics, worklog, timer
---

# Boards, sprints, epics, and time

## Contents

- [Boards](#boards)
- [Sprints](#sprints)
- [Sprint review page](#sprint-review-page)
- [Epics](#epics)
- [Analytics](#analytics)
  - [Flow metrics](#flow-metrics)
  - [Status map](#status-map)
- [Time tracking](#time-tracking)
- [Anti-patterns](#anti-patterns)

## Boards

```bash
atlcli jira board list --project PROJ --json
atlcli jira board list --type scrum --name platform --json
atlcli jira board get --id 123 --json
atlcli jira board backlog --id 123 --limit 100 --json
atlcli jira board issues --id 123 --jql 'status != Done' --json
```

`board list` takes `--limit` (default 50); `backlog` and `issues` take `--limit`
(default 50) and an extra `--jql` filter. Board IDs come from `board list`.
`sprint list`, `sprint create`, `epic list`, `analyze velocity` and
`analyze predictability` fill `--board` from the default board (`global.board`, or the
profile's own) when the flag is absent. A kanban board has no sprints: `sprint list` on one fails with
"The board does not support sprints".

## Sprints

```bash
atlcli jira sprint list --board 123 --state active --json
atlcli jira sprint get --id 456 --json
atlcli jira sprint issues --id 456 --jql 'assignee = currentUser()' --json
atlcli jira sprint report 456 --json
```

`--state` is `future`, `active`, or `closed`; `list` and `issues` take `--limit`
(default 50). `sprint report <sprintId>` takes the sprint ID positionally
(`--id` also works). It reads at most 200 sprint issues and their changelogs
(a bulk read on Cloud, one request per issue on Data Center), and it needs
the story-points field (auto-detected, or `--points-field <id>`).

Writes:

```bash
atlcli jira sprint create --board 123 --name 'Sprint 48' \
  --start 2026-08-10 --end 2026-08-24 --goal 'Ship the exporter' --json
atlcli jira sprint start --id 456 --end 2026-08-24 --goal 'Ship the exporter' --json
atlcli jira sprint close --id 456 --json
atlcli jira sprint add PROJ-101 PROJ-102 --sprint 456 --json
atlcli jira sprint remove PROJ-101 --json          # moves issues to the backlog
atlcli jira sprint delete --id 456 --confirm --json
```

Issue keys are positional and variadic on `add`/`remove`. `remove` needs no
sprint ID because it moves the issues to the backlog wherever they are.
`start` also accepts `--start`, `--end` and `--goal`. Starting or closing a
sprint is visible to the whole team, so confirm first.

### Sprint review page

```bash
atlcli jira sprint review 456 --space TEAM --dry-run --json
atlcli jira sprint review 456 --space TEAM --parent 12345 --json
atlcli jira sprint review 456 --space TEAM --export review.pdf --json
```

`sprint review <sprintId>` renders the sprint (goal, done and not-done issues,
points and say/do ratio when a story-points field exists) through a template and
creates or updates a Confluence page, so it is a Confluence write. `--space`
falls back to `global.space`. `--dry-run` reads Jira and Confluence, writes
nothing, and returns the rendered `markdown`, the `action` it would take
(`create`, `update`, `unchanged`) and the page `title` (default
`Sprint review – <sprint name>`).

- Re-running updates the page atlcli created for that sprint. A page with the
  same title that atlcli did not create makes the command fail; `--title`
  picks another title, `--force` overwrites that page.
- `--parent <pageId>` sets the parent page on creation.
- `--template <name>` selects a template. A user template of that name (global,
  profile or space level) wins over the bundled `sprint-review`.
  `--list-templates` prints the bundled names and `--print-template <name>`
  writes one to stdout as a starting point; both are local and need no sprint.
- `--var name=value` (repeatable) adds or overrides a template variable.
- `--export <file.pdf|.docx>` also exports the resulting page to that file
  (replacing an existing file). A `.pdf` uses the built-in `report` template
  unless `--export-template <name>` is given; any other extension exports DOCX.
  It is skipped with `--dry-run`.
- `--points-field <id>` overrides story-points detection.
- `--status-map <map>` sets which statuses count as done (see
  [Status map](#status-map)).

## Epics

```bash
atlcli jira epic list --project PROJ --json
atlcli jira epic list --board 123 --done --json     # --done includes completed epics
atlcli jira epic get PROJ-100 --json
atlcli jira epic issues PROJ-100 --status 'In Progress' --limit 100 --json
atlcli jira epic progress PROJ-100 --json
atlcli jira epic create --project PROJ --summary 'Export pipeline' --json
atlcli jira epic add PROJ-101 PROJ-102 --epic PROJ-100 --json
atlcli jira epic remove PROJ-101 --json
```

Epic keys are positional on `get`, `issues`, and `progress`; the epic is a
flag (`--epic`) only on `add`. `epic list` uses the board's epics when `--board`
is given or a default board is set (the profile's, else `global.board`; it then
ignores `--project`); otherwise it
searches `issuetype = Epic` in `--project` (default 50). `epic create` takes the
description as Markdown through `--description <text>` or
`--description-file <path|->`; `--field` is ignored there without error. `epic
issues --status` filters after fetching `--limit` issues (default 50), so it
reports matches only from that first slice, and its `total` counts the filtered
issues. `epic get` and `epic progress` look at the first 1000 child issues.
`jira issue create --parent PROJ-100` is the equivalent path when creating an
issue directly under an epic.

## Analytics

```bash
atlcli jira analyze velocity --board 123 --sprints 5 --json
atlcli jira analyze predictability --board 123 --sprints 8 --json
atlcli jira analyze burndown --sprint 456 --json
atlcli jira analyze scope-change --sprint 456 --json
```

`velocity` and `predictability` take `--board` (or the default board) and look
at the most recent closed sprints, oldest first; `burndown` and
`scope-change` take `--sprint`. `--sprints` defaults to 5. The story-points
field is auto-detected; override it with `--points-field customfield_10028`
when the site uses a non-standard field (find the ID with `jira field search`).

Metrics as defined by the tool: velocity is completed points per sprint;
say-do ratio is completed ÷ committed × 100; scope change is
(added + removed) ÷ committed × 100; burndown is daily remaining against the
ideal curve. "Completed" follows the [status map](#status-map) in all four and
in `sprint report`.

### Flow metrics

```bash
atlcli jira analyze flow --project PROJ --since 30d --json
atlcli jira analyze aging --board 123 --json
atlcli jira analyze cfd --jql 'project = PROJ AND type = Bug' --group-by category --json
```

- `flow`: cycle time (first entry into in-progress to done) and lead time
  (created to done) as P50, P85 and P95, plus weekly throughput.
- `aging`: the issues in progress by age; text output marks those older than
  the cycle-time P85 with `!`.
- `cfd`: cumulative flow, issues per status (`--group-by status`, the default)
  or per category (`--group-by category`) at the end of each UTC day.

The issues come from `--jql`, else `--board` (a board id; the board's saved
filter), else `--project`, else the default board, else the default project.
A trailing `ORDER BY` in `--jql` is dropped. Every open issue of the selection
is read, whatever its age; `--since` (`90d` by default, also `12w` or a bare
number of days) bounds only the others, by their last update, and sets the
metrics window. `--limit` (default 1000) caps the read: the issues are read
oldest first, so a cut drops the newest. A cut prints `Warning: truncated: …`
on stderr in text and CSV mode, and is listed in `diagnostics.warnings` in
JSON; raise `--limit` or narrow the selection.

`--json` prints `schemaVersion: "1"`: `flow` with `query`, `window`,
`metrics` and `diagnostics`; `aging` with `query`, `cycleTimeP85`, `wip` and
`diagnostics`; `cfd` with `query`, `window`, `columns`, `days` and
`diagnostics`. `--csv` prints the completed issues (`flow`), the issues in
progress (`aging`) or one row per day (`cfd`); `--json` wins over `--csv`.

Status changes come from the changelogs: on Cloud in a bulk read, on Data
Center one request per issue, five at a time. On Data Center, narrow the
selection or lower `--limit` on large projects.

Discover these with the bare `atlcli jira analyze`. `--help` on a verb prints
the same group help and runs nothing.

### Status map

Jira's status category decides whether a status counts as to do, in progress
or done, unless a status map overrides it:

```bash
atlcli jira analyze flow --project PROJ --status-map 'Code Review=wip,Fertig=done' --json
```

- `--status-map` takes comma-separated `<status>=todo|wip|done` entries; an
  invalid entry is a usage error.
- `flow.statusMap` in `~/.atlcli/config.json` sets a map globally or per
  profile, for example `"flow": { "statusMap": { "Fertig": "done" } }`. A
  profile's entries win over the global ones, and the flag wins over both.
  `atlcli config set` does not accept the key (see
  [auth-and-config.md](auth-and-config.md)). Write the values in lower case:
  atlcli does not check them in the config file.
- A key is a status name in any case, or a status id. An entry can move a
  status into done or out of it, and the searches follow the map.
- The map applies to `jira analyze` (all seven), `sprint report`,
  `sprint review`, `version notes`, `audit jira` and `atlcli digest`.

## Time tracking

```bash
atlcli jira worklog add PROJ-101 1h30m --comment 'Feature work' --json
atlcli jira worklog add PROJ-101 1.5h --started 09:00 --json
atlcli jira worklog add PROJ-101 2h --round 15m --json
atlcli jira worklog list --issue PROJ-101 --json
atlcli jira worklog update --issue PROJ-101 --id <worklogId> --time 45m --json  # also --comment, --started
atlcli jira worklog delete --issue PROJ-101 --id <worklogId> --confirm --json
atlcli jira worklog report --since 30d --group-by issue --json
atlcli jira worklog report --since 2026-07-01 --until 2026-07-31 --json
```

Issue key and duration are positional on `add`; everything else is a flag.
`--comment` is Markdown on `add`, `update` and `timer stop`. `list` takes
`--limit` (default 50).

Duration formats: `1h30m`, `1h 30m`, `1.5h`, `90m`, `1:30`, `1d` (8h), `1w`
(5d). `--started` accepts `today`, `yesterday`, `14:30`, `2026-01-12`, or full
ISO 8601. `--round` takes any `<n>m`, `<n>min`, `<n>h`, or a bare number of
minutes, for example `15m`, `30m`, `1h`.

`report` covers `--since` (default `30d`) through `--until` (default `today`).
Both accept a superset of the forms `--started` takes (`today`, `yesterday`,
`HH:MM`, `YYYY-MM-DD`, full ISO 8601) plus short relative durations (`7d`,
`2w`, `1m`) that `--started` rejects, so a calendar month is
`--since 2026-07-01 --until 2026-07-31` (`--until` includes that day). `--user`
defaults to `me`, matched by account ID. Any other value is used twice: as a
literal in a JQL `worklogAuthor = "<value>"` clause that pre-selects candidate
issues, then as a case-insensitive substring match against each worklog's author
display name and email. The second check decides what is reported, so pass a
fragment of a name or email address, not an account ID. The report scans one
search page of up to 1000 issues, without following the continuation token, and
up to 1000 worklogs per issue; both caps truncate silently, like
`epic issues --status`.

`report` is per-user and has no project, epic, or JQL scoping. `--user`,
`--since`, `--until`, and `--group-by` are the whole surface. For a team or epic
total, list the issues first and sum their worklogs: `jira epic issues
PROJ-100 --json`, then `jira worklog list --issue <key> --json` for each. The
response's `total` tells you when to raise `--limit` (default 50) to get every
worklog. `list` has no date or author flags, so filter on the returned `started`
and `authorId` fields yourself.

Timer mode stores one running timer in `~/.atlcli/timer.json` and logs it on
stop:

```bash
atlcli jira worklog timer start PROJ-101 --comment 'Working on the exporter'
atlcli jira worklog timer status --json
atlcli jira worklog timer stop --round 15m --json
atlcli jira worklog timer cancel     # discards without logging
```

`timer start` fails while a timer is running. `timer stop` writes a worklog to
Jira, with a minimum of one minute; `--comment` overrides the comment given at
start. The timer remembers the profile it started with, and `timer stop
--profile <name>` overrides that one. The timer file is deleted only after Jira
confirmed the worklog: if `stop` fails (bad `--round`, unknown profile, network
error), nothing is logged, the timer keeps running and the error details carry
`timerPreserved: true`, so the command can be retried. `timer cancel` discards
the timer without logging. Check `timer status` before starting a new timer, and
do not stop or cancel a timer the user started without asking.

## Anti-patterns

- Passing `--sprint` to `analyze velocity` or `--board` to `analyze burndown`.
  Each metric takes exactly one of the two.
- Logging time against the wrong issue because the key was inferred from
  context. Confirm the key with the user for any worklog write.

Related: [jira-search.md](jira-search.md), [jira-issues.md](jira-issues.md),
[safety.md](safety.md).
