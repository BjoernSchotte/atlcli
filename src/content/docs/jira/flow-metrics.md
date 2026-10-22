---
title: "Flow Metrics"
description: "Cycle time, lead time, throughput, aging work in progress and cumulative flow from Jira status history"
---

# Flow Metrics

`atlcli jira analyze flow`, `aging` and `cfd` compute Kanban-style flow metrics from each issue's status history. They work for any set of issues, with or without sprints and story points.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects for the selected issues
- Jira Cloud for full status histories. On Data Center the history is read per issue and Jira caps it at about 100 changes per issue.

## Steps

1. Pick the issues: a project, a board or any JQL.

   ```bash
   atlcli jira analyze flow --project ATLCLI
   ```

2. See which work in progress is getting old:

   ```bash
   atlcli jira analyze aging --project ATLCLI
   ```

3. Chart how work moved through the statuses:

   ```bash
   atlcli jira analyze cfd --project ATLCLI --since 30d --csv > cfd.csv
   ```

## Definitions

Every status is mapped to one of three flow categories: **todo**, **wip** (in progress) or **done**. By default the mapping follows the Jira status category (To Do, In Progress, Done). See [Status mapping](#status-mapping) to change it.

| Metric | Definition |
|---|---|
| Started | The first time the issue entered a **wip** status. A reopened issue keeps its first start. |
| Done | The start of the final run of **done** statuses, and only if the issue is done now. `Done → Closed` counts from `Done`. |
| Lead time | Done − created, in days with one decimal |
| Cycle time | Done − started. Issues that went straight from todo to done count for lead time only (`skippedWip`). |
| Throughput | Issues done per UTC day and per ISO week inside the window |
| Aging WIP | Issues in a **wip** status now, with their age since they started |
| P50 / P85 / P95 | Nearest-rank percentiles. P85 and P95 need at least 5 completed issues; below that they show `n/a`. |
| Cumulative flow | For each UTC day, the number of issues in each status at 23:59:59 UTC |

An issue that passed through a status the mapping does not know is left out of cycle time, and the status is listed under diagnostics.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `--project` | project key | `defaults.project` | Select the project's issues |
| `--board` | board id | `defaults.board` | Select the issues of the board's saved filter |
| `--jql` | JQL | — | Any JQL. A trailing `ORDER BY` is ignored. |
| `--since` | `<n>d`, `<n>w` or a number of days | `90d` | Window for completions, throughput and the CFD |
| `--limit` | integer ≥ 1 | `1000` | Most issues read. Hitting it prints a `truncated` warning. |
| `--status-map` | `"<status>=todo\|wip\|done,…"` | — | Override the category of statuses, by name or id |
| `--group-by` | `status` or `category` | `status` | CFD columns (`cfd` only) |
| `--csv` | flag | off | One CSV row per issue (per day for `cfd`), RFC 4180 quoting |
| `--json` | flag | off | JSON output with `schemaVersion: "1"` |

Selection precedence: `--jql`, then `--board`, then `--project`, then `defaults.board`, then `defaults.project`. Without any of them the command fails with `ATLCLI_ERR_USAGE`.

The issues read are those matching the selection that are either not done, or were updated inside the window.

## Status mapping

Some workflows put a review or blocked status in the wrong Jira category. Override it per run:

```bash
atlcli jira analyze flow --project ATLCLI --status-map "Code Review=wip,Blocked=wip"
```

Or once in `~/.atlcli/config.json`, globally and per profile:

```json
{
  "flow": { "statusMap": { "Code Review": "wip" } },
  "profiles": {
    "work": { "flow": { "statusMap": { "Blocked": "wip", "10234": "done" } } }
  }
}
```

Keys are status names (case-insensitive) or status ids. The profile wins per key over the global map, and `--status-map` wins over both.

The map also decides which issues are searched as open or done: a status moved into or out of done is listed by id in the JQL (`status not in (…)`), so `jira analyze`, `audit jira` and `atlcli digest` all see the same issue set. A name key applies to the status's id, so a changelog that names the status differently (an older or untranslated name) still resolves.

Prefer status ids or fixing the category in the workflow: Jira allows the same name in several workflows, and a name key maps all of them.

## Examples

### Flow

```bash
atlcli jira analyze flow --project ADMIN --since 60d
```

```
Flow metrics 2026-08-23 – 2026-10-22
Query: (project = "ADMIN") AND (statusCategory != Done OR updated >= -60d) ORDER BY created ASC

                count  min  P50   P85   P95   max    mean
--------------  -----  ---  ----  ----  ----  -----  ----
Cycle time (d)  21     0.1  16.9  34.9  42.2  49.9   19.1
Lead time (d)   45     0.0  9.1   34.9  53.1  631.7  28.1

Throughput per week: ▁▂▅▄▂▁▇█▄▃  W34:0 W35:1 W36:6 W37:5 W38:2 W39:0 W40:10 W41:12 W42:5 W43:4
Work in progress: 16

Note: 24 issue(s) skipped in-progress (lead time only).
```

`--csv` writes `key,type,created,startedAt,doneAt,leadDays,cycleDays`, one row per completed issue.

### Aging

```bash
atlcli jira analyze aging --board 42
```

```
Aging work in progress: 3 issue(s); cycle time P85 34.9 d

   key        age (d)  status       summary
   ---------  -------  -----------  -------------------------
!  ADMIN-231  63.0     In Progress  Migrate mail server
   ADMIN-240  12.5     In Review    Rotate API keys
   ADMIN-244  1.2      In Progress  Update laptop images

! = older than the cycle-time P85
```

The P85 of recent cycle times is a practical service level: an item older than that is unlikely to finish soon without help.

### Cumulative flow

```bash
atlcli jira analyze cfd --jql "project = ATLCLI AND type = Bug" --since 14d --group-by category
```

```
date        todo  wip  done
----------  ----  ---  ----
2026-10-09  12    4    30
2026-10-10  11    5    31
```

:::note[Done band]
The Done band only counts issues that the query found, that is, issues updated inside the window. Issues finished earlier and not touched since are not included, so the band starts at the window start rather than at the project's full history.
:::

For a chart, import the CSV (`--csv`) into a spreadsheet and use a stacked area chart with the columns in the given order.

### JSON

```bash
atlcli jira analyze flow --project ATLCLI --json
```

```json
{
  "schemaVersion": "1",
  "query": "(project = \"ATLCLI\") AND (statusCategory != Done OR updated >= -90d) ORDER BY created ASC",
  "window": { "from": "2026-07-24T08:00:00.000Z", "to": "2026-10-22T08:00:00.000Z" },
  "metrics": {
    "leadTime": { "count": 1, "min": 8, "p50": 8, "p85": null, "p95": null, "max": 8, "mean": 8 },
    "cycleTime": { "count": 1, "min": 3, "p50": 3, "p85": null, "p95": null, "max": 3, "mean": 3 },
    "throughput": { "daily": [], "weekly": [{ "week": "2026-W43", "count": 1 }] },
    "wip": { "count": 1, "aging": [] },
    "completed": []
  },
  "diagnostics": { "issues": 3, "skippedWip": 0, "excludedFromCycleTime": 0, "unknownStatuses": [], "warnings": [] }
}
```

## Requests

One search page per 100 issues, one status list and one changelog request per 1000 issues (Jira Cloud `changelog/bulkfetch`). A board selection adds two requests to read its filter.

## Troubleshooting

**`Note: unmapped statuses …`.**
A status in the history no longer exists or has no category. Map it with `--status-map` or `flow.statusMap`.

**Cycle time count is much lower than lead time count.**
Many issues went from to do straight to done (`skippedWip`). Often a review status sits in the To Do category; map it to `wip`.

**`Warning: truncated: more than 1000 issues matched`.**
Raise `--limit` or narrow `--jql`.

**`P85 n/a`.**
Fewer than 5 issues were completed in the window. Use a longer `--since`.

## Related topics

- [Analytics](analytics.md): sprint velocity, burndown, scope change and predictability
- [Jira Audit](audit.md): findings that use the same cycle-time P85
- [Boards & Sprints](boards-sprints.md)
- [Sprint reporting recipe](../recipes/sprint-reporting.md)
