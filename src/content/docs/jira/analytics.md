---
title: "Analytics"
description: "Analytics - atlcli documentation"
---

# Analytics

Sprint velocity, burndown, and predictability metrics.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects
- Board with sprint history for velocity/predictability metrics

## Velocity

View story points completed per sprint:

```bash
atlcli jira analyze velocity --board 123
```

Options:

| Flag | Description |
|------|-------------|
| `--board` | Board ID (required) |
| `--sprints` | Number of sprints to analyze (default: 5) |
| `--points-field` | Story points field ID (auto-detected) |
| `--json` | JSON output |

Output:

```
SPRINT                COMMITTED    COMPLETED    DELTA
Sprint 10             21           18           -3
Sprint 11             20           20           0
Sprint 12             22           24           +2
Sprint 13             20           19           -1
Sprint 14             21           21           0

Average velocity: 20.4 points/sprint
Commitment accuracy: 91%
```

### Story Points Detection

atlcli automatically detects your story points field by searching for fields named:

- Story Points
- Story point estimate
- Estimation

Override with `--field`:

```bash
atlcli jira analyze velocity --board 123 --field "customfield_10016"
```

## Burndown

Sprint burndown chart data:

```bash
atlcli jira analyze burndown --sprint 456
```

Options:

| Flag | Description |
|------|-------------|
| `--sprint` | Sprint ID (required) |
| `--points-field` | Story points field ID (auto-detected) |
| `--json` | JSON output |

Output:

```
DATE         REMAINING    IDEAL
2025-01-06   42           42
2025-01-07   38           36
2025-01-08   35           30
2025-01-09   28           24
2025-01-10   20           18
2025-01-13   12           12
2025-01-14   5            6
```

## Predictability

Team predictability metrics:

```bash
atlcli jira analyze predictability --board 123
```

Options:

| Flag | Description |
|------|-------------|
| `--board` | Board ID (required) |
| `--sprints` | Number of sprints to analyze (default: 10) |

Output:

```
Team Predictability Report (last 10 sprints)

Commitment Accuracy:  89%
  - Planned vs completed story points

Velocity Variance:    12%
  - Standard deviation across sprints

Completion Rate:      94%
  - Percentage of committed issues done

Scope Change:         8%
  - Issues added during sprints
```

### Scope Change Calculation

Scope change is calculated by tracking:

- `addedDuringSprint`: Issues added after sprint start
- `removedDuringSprint`: Issues removed during sprint
- `originalCommitment`: Issues at sprint start

## Sprint Report

Comprehensive sprint analysis:

```bash
atlcli jira sprint report 456
```

Options:

| Flag | Description |
|------|-------------|
| `--points-field` | Story points field ID (auto-detected) |
| `--json` | JSON output |

Output:

```
Sprint 14 Report
================
Duration: Jan 6 - Jan 17, 2025 (10 days)
Status: Active

SUMMARY
-------
Total Issues:     24
Completed:        18 (75%)
In Progress:       4 (17%)
Not Started:       2 (8%)

STORY POINTS
------------
Committed:        21
Completed:        16
Remaining:         5

SCOPE CHANGES
-------------
Added:            3 issues
Removed:          1 issue

TOP CONTRIBUTORS
----------------
Alice:            8 issues completed
Bob:              6 issues completed
Carol:            4 issues completed
```

### JSON Export

```bash
atlcli jira sprint report 456 --json > sprint-14-report.json
```

## JSON Output

All analytics commands support `--json`:

```bash
atlcli jira analyze velocity --board 123 --json
```

```json
{
  "schemaVersion": "1",
  "board": {
    "id": 123,
    "name": "Team Board"
  },
  "sprints": [
    {
      "id": 10,
      "name": "Sprint 10",
      "committed": 21,
      "completed": 18,
      "delta": -3
    }
  ],
  "averageVelocity": 20.4,
  "commitmentAccuracy": 0.91
}
```

## Best Practices

1. **Consistent estimation** - Use same story point scale across team
2. **Regular analysis** - Review velocity trends weekly
3. **Scope discipline** - Track scope changes to improve planning
4. **Historical data** - Analyze at least 5 sprints for meaningful trends

## Related Topics

- [Boards & Sprints](boards-sprints.md) - Sprint management
- [Fields](fields.md) - Story points field configuration
- [Time Tracking](time-tracking.md) - Worklog reports
