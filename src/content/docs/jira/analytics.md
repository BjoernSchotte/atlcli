---
title: "Analytics"
description: "Sprint velocity, burndown, scope change and predictability from Jira"
---

# Analytics

Sprint metrics from story points: velocity, burndown, scope change and predictability. For Kanban-style metrics that need no sprints or points (cycle time, throughput, aging work), see [Flow Metrics](flow-metrics.md).

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects
- A Jira Software board with sprints
- A story points field (detected automatically, or `--points-field`)

## Commands

| Command | Needs | Answers |
|---|---|---|
| `jira analyze velocity --board <id>` | closed sprints | Points completed per sprint, and the trend |
| `jira analyze burndown --sprint <id>` | sprint with start and end date | Remaining points per day against the ideal line |
| `jira analyze scope-change --sprint <id>` | sprint with a start date | Points added and removed after the sprint started |
| `jira analyze predictability --board <id>` | closed sprints | Say-do ratio (completed / committed) per sprint |
| `jira sprint report <id>` | sprint | All of the above for one sprint |

All of them print JSON (`schemaVersion: "1"`), with or without `--json`.

## Options

| Flag | Type | Default | Used by |
|---|---|---|---|
| `--board` | board id | `defaults.board` (predictability) | velocity, predictability |
| `--sprint` | sprint id | required | burndown, scope-change |
| `--sprints` | integer | `5` | velocity, predictability: the most recently closed sprints, listed oldest first |
| `--points-field` | field id | auto-detected | all |
| `--status-map` | `"<status>=todo\|wip\|done,…"` | `flow.statusMap` | all: which statuses count as completed |

### Completed work

An issue counts as completed when its status is in Jira's **Done** category. Some workflows keep a finished status, such as "Fertig", in the **In Progress** category; then every sprint shows 0 % completed. Map that status to done, once in `flow.statusMap` (see [Status mapping](flow-metrics.md#status-mapping)) or per run:

```bash
atlcli jira sprint report 456 --status-map "Fertig=done"
```

[Jira Audit](audit.md) finds such statuses (`workflow/resolved-not-done`). The better fix is to move the status into the Done category in the workflow.

### As of the sprint

Sprint metrics count the sprint as it was, not as the issues are today. atlcli replays each issue's change history (sprint, story points, status) to the sprint's start and end. The end is the moment the sprint was completed; for an active sprint, it is now.

| Term | Meaning |
|---|---|
| Committed | Issues in the sprint at its exact start, at their estimate then |
| Completed | Issues in the sprint at its end, in a done status then, at their estimate then |
| Added / removed | Points that joined after the start / left before the end |
| Issues | Issues in the sprint at its end |

Left out, as in Jira's sprint report:

- **Sub-tasks**: they follow their parent.
- **Issues done before the sprint started**: Jira lists them as "completed outside this sprint".

Work finished after the sprint no longer counts as completed. An estimate changed during the sprint counts as committed at its old value.

**Limitation:** an issue moved out of the sprint before it closed no longer appears in the sprint's issue list. Its removal therefore stays invisible; Jira lists it as "removed from sprint".

### Story points detection

atlcli looks for a field named **Story Points**, **Story point estimate** or **Estimation**. Override it with `--points-field`:

```bash
atlcli jira analyze velocity --board 123 --points-field customfield_10016
```

## Velocity

```bash
atlcli jira analyze velocity --board 123 --sprints 5
```

```json
{
  "schemaVersion": "1",
  "board": { "id": 123, "name": "Team Board" },
  "pointsField": "customfield_10016",
  "sprints": [
    { "id": 10, "name": "Sprint 10", "velocity": 18, "completedIssues": 9 },
    { "id": 11, "name": "Sprint 11", "velocity": 20, "completedIssues": 11 }
  ],
  "averageVelocity": 19,
  "trend": 11.1,
  "trendDescription": "+11.1% (improving)"
}
```

The trend compares the average of the newer half of the sprints with the older half; it needs at least 4 sprints.

## Burndown

```bash
atlcli jira analyze burndown --sprint 456
```

```json
{
  "schemaVersion": "1",
  "sprint": { "id": 456, "name": "Sprint 14", "state": "active", "startDate": "2026-10-06T08:00:00.000Z", "endDate": "2026-10-17T16:00:00.000Z" },
  "pointsField": "customfield_10016",
  "totalPoints": 42,
  "burndown": [
    { "date": "2026-10-06", "remaining": 42, "ideal": 42, "completed": 0 },
    { "date": "2026-10-07", "remaining": 38, "ideal": 37.8, "completed": 4 }
  ]
}
```

The burndown starts at the committed points (see [As of the sprint](#as-of-the-sprint)). An issue burns down on the day of its last status change, if it is in a done status at the sprint's end. Issues added during the sprint do not burn down.

## Scope change

```bash
atlcli jira analyze scope-change --sprint 456
```

```json
{
  "schemaVersion": "1",
  "sprint": { "id": 456, "name": "Sprint 14", "state": "closed" },
  "pointsField": "customfield_10016",
  "scopeChange": {
    "committedPoints": 40,
    "addedPoints": 5,
    "removedPoints": 3,
    "scopeChangePercent": 20,
    "stability": "moderate"
  },
  "issues": { "total": 22, "completed": 18, "incomplete": 4 }
}
```

`scopeChangePercent` is (added + removed) / committed × 100. Stability is `stable` up to 10 %, `moderate` up to 25 % and `unstable` above.

## Predictability

```bash
atlcli jira analyze predictability --board 123
```

```json
{
  "schemaVersion": "1",
  "board": { "id": 123, "name": "Team Board" },
  "pointsField": "customfield_10016",
  "sprints": [
    { "id": 10, "name": "Sprint 10", "committed": 21, "completed": 18, "sayDoRatio": 86, "bar": "[█████████████████───] 86%" }
  ],
  "averageSayDoRatio": 86,
  "predictability": "high"
}
```

Predictability is `high` from 80 %, `moderate` from 60 %, otherwise `low`.

## Sprint report

```bash
atlcli jira sprint report 456
```

```json
{
  "schemaVersion": "1",
  "sprint": { "id": 456, "name": "Sprint 14", "state": "closed", "dates": "2026-10-06 - 2026-10-17" },
  "pointsField": "customfield_10016",
  "velocity": 34,
  "sayDoRatio": 85,
  "scopeChange": 20,
  "issues": { "total": 22, "completed": 18, "incomplete": 4, "added": 5, "removed": 3 },
  "progress": { "committed": 40, "completed": 34, "percent": 85, "bar": "[█████████████████───] 85%" }
}
```

## Requests

Every sprint metric reads the change history of all sprint issues in one request per 1000 issues on Jira Cloud (`changelog/bulkfetch`); velocity and predictability do so once per sprint. On Data Center they read it per issue, five at a time.

## Best practices

1. **Consistent estimation**: use the same story point scale across the team.
2. **Regular analysis**: review velocity trends every sprint.
3. **Scope discipline**: track scope change to improve planning.
4. **Enough history**: analyze at least 5 sprints for meaningful trends.

## Related topics

- [Flow Metrics](flow-metrics.md): cycle time, throughput, aging work, cumulative flow
- [Jira Audit](audit.md): stuck, unassigned and stale work
- [Boards & Sprints](boards-sprints.md): sprint management
- [Fields](fields.md): story points field configuration
- [Time Tracking](time-tracking.md): worklog reports
