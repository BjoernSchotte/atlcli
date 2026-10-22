---
title: "Jira Audit"
description: "atlcli audit jira: stuck or unassigned work, stale issues and hygiene gaps, as a report"
---

# Jira Audit

`atlcli audit jira` checks a set of Jira issues for work that needs attention: items stuck in progress, in-progress work without an assignee, stale issues and gaps such as missing epics or estimates. It only reports; it never changes an issue.

Flow metrics answer "how fast do we deliver" ([Flow Metrics](flow-metrics.md)). The audit answers "what should we act on", and uses the same issue selection and status mapping.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects
- The audit feature flag, shared with [Wiki Audit](../confluence/audit.md):

  ```bash
  atlcli flag set audit true --global
  ```

## Steps

1. Audit a project:

   ```bash
   atlcli audit jira --project ATLCLI
   ```

2. Run only some checks, for example before a stand-up:

   ```bash
   atlcli audit jira --board 42 --checks stuck-wip,unassigned-wip
   ```

3. Write a Markdown report for a retro page:

   ```bash
   atlcli audit jira --project ATLCLI --markdown > jira-audit.md
   ```

## Checks

The audit reads the open issues of the selection and the issues done in the last 90 days.

| Check | Rule | Severity | Condition |
|---|---|---|---|
| `stuck-wip` | `stuck-wip` | warning / error | In progress longer than the cycle-time P85 (warning) or P95 (error) of the issues done in the last 90 days. Needs 5 completed issues; otherwise skipped with a note. |
| `unassigned-wip` | `unassigned-wip` | warning | In progress without an assignee |
| `stale` | `stale` | info / warning / error | Not updated for 30 / 60 / 90 days. Only in-progress issues, unless `--all` adds to-do issues. |
| `hygiene` | `no-parent` | info | An issue that is neither an epic nor a subtask has no parent |
| `hygiene` | `unestimated-in-sprint` | warning | In an open or active sprint without story points. Skipped when no story points field is found. |
| `hygiene` | `done-without-version` | info | Done in the last 90 days without a fix version, in a project that has versions |

Findings are grouped by check and sorted by severity, then age.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `--project` | project key | `defaults.project` | Select the project's issues |
| `--board` | board id | `defaults.board` | Select the issues of the board's saved filter |
| `--jql` | JQL | — | Any JQL; wins over `--board` and `--project` |
| `--checks` | comma-separated | all four | `stuck-wip`, `unassigned-wip`, `stale`, `hygiene` |
| `--all` | flag | off | Include to-do issues in the stale check |
| `--stale` | `a,b,c` days, ascending | `30,60,90` | Stale thresholds for info / warning / error |
| `--status-map` | `"<status>=todo\|wip\|done,…"` | — | Override status categories (see [Flow Metrics](flow-metrics.md#status-mapping)) |
| `--points-field` | field id | auto-detected | Story points field for `unestimated-in-sprint` |
| `--limit` | integer ≥ 1 | `1000` | Most issues per query; hitting it adds a `truncated` note |
| `--markdown` | flag | off | Markdown report with one table per check |
| `--json` | flag | off | JSON report |

### Configuration

Stale thresholds can be set globally or per profile in `~/.atlcli/config.json`; the profile wins, and `--stale` wins over both:

```json
{
  "audit": { "jira": { "staleDays": [14, 30, 60] } },
  "profiles": {
    "work": { "audit": { "jira": { "staleDays": [30, 60, 120] } } }
  }
}
```

The status mapping comes from `flow.statusMap`, as for flow metrics.

## Examples

Minimal:

```bash
atlcli audit jira --project ADMIN
```

```
Jira audit: 93 finding(s) — 19 error, 8 warning, 66 info
Query: project = "ADMIN"

Stuck in progress (14)
  [error] ADMIN-22432  Shut down the old website (Chris) — In progress for 1063 d, above the cycle-time P95 (42.2 d).
  ...

In progress without assignee (5)
  [warning] ADMIN-22840  Revoke repository access — In progress without an assignee.

Stale (6)
  [error] ADMIN-22812  Project permissions (Chris) — Not updated for 981 d.
  [info] ADMIN-23779  WordPress maintenance release (Chris) — Not updated for 33 d.

Hygiene (68)
  [warning] ADMIN-22432  Shut down the old website (Chris) — In an open sprint without story points.
  [info] ADMIN-22840  Revoke repository access — No parent (epic).
```

Advanced: one component, stricter stale levels, JSON for a dashboard:

```bash
atlcli audit jira --jql "project = ATLCLI AND component = API" --stale 7,14,30 --all --json
```

```json
{
  "schemaVersion": "1",
  "generatedAt": "2026-10-22T08:00:00.000Z",
  "summary": {
    "total": 2,
    "bySeverity": { "error": 0, "warning": 1, "info": 1 },
    "byCheck": { "stuck-wip": 0, "unassigned-wip": 1, "stale": 1, "hygiene": 0 }
  },
  "findings": [
    { "check": "unassigned-wip", "rule": "unassigned-wip", "severity": "warning", "key": "ATLCLI-12", "summary": "Retry uploads", "status": "In Progress", "detail": "In progress without an assignee." }
  ],
  "diagnostics": [],
  "query": "project = ATLCLI AND component = API"
}
```

## Exit codes

The audit exits 0 when it ran, with or without findings, and 1 when a request failed or the arguments were wrong.

## Troubleshooting

**`Audit feature is not enabled`.**
Run `atlcli flag set audit true --global`.

**`stuck-wip skipped: … need 5 for a P85`.**
Fewer than 5 issues were done in the last 90 days with a known start. The other checks still run.

**`unestimated-in-sprint skipped`.**
No story points field was found, or the site has no Jira Software sprints. Pass `--points-field`.

**Everything shows up as stale or stuck.**
Check the status mapping: a done-like status in the In Progress category keeps finished work "in progress". Map it with `--status-map "Released=done"`.

## Related topics

- [Flow Metrics](flow-metrics.md)
- [Wiki Audit](../confluence/audit.md)
- [Bulk Operations](bulk-operations.md): act on findings, for example `jira bulk label`
- [Sprint reporting recipe](../recipes/sprint-reporting.md)
