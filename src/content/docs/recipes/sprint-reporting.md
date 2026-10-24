---
title: "Sprint Reporting"
description: "Sprint Reporting - atlcli documentation"
---

# Sprint Reporting

Generate automated sprint reports with atlcli.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects
- Board with sprint history

## Use Case

At the end of each sprint, generate a report including:

- Completed work
- Velocity metrics
- Carry-over items
- Time logged

## Sprint Review Page in One Command

`atlcli jira sprint review` writes the review straight to Confluence and can export it:

```bash
# Preview the page
atlcli jira sprint review 456 --space TEAM --dry-run

# Create or update the page under the team's sprint folder, export a PDF for stakeholders
atlcli jira sprint review 456 --space TEAM --parent 67890 --export sprint-456.pdf
```

Running it again updates the same page. To change the layout, start from the bundled template:

```bash
atlcli jira sprint review --print-template sprint-review > sprint-review.md
```

See [Release Notes and Sprint Review Pages](../jira/report-pages.md). For release notes per version, use `atlcli jira version notes`.

The scripts below build a fully custom markdown report instead.

## Sprint Summary Script

```bash
#!/bin/bash
# sprint-report.sh - Generate sprint summary
# Usage: ./sprint-report.sh <board-id> <sprint-id>

BOARD_ID=$1
SPRINT_ID=$2

echo "# Sprint Report"
echo ""

# Sprint info
echo "## Sprint Info"
atlcli jira sprint get --id $SPRINT_ID

# Completed issues
echo ""
echo "## Completed"
atlcli jira search --jql "sprint = $SPRINT_ID AND status = Done" --json | \
  jq -r '.issues[] | "- [\(.key)] \(.summary)"'

# Incomplete issues
echo ""
echo "## Carry-over"
atlcli jira search --jql "sprint = $SPRINT_ID AND status != Done" --json | \
  jq -r '.issues[] | "- [\(.key)] \(.summary) (\(.status))"'

# Velocity
echo ""
echo "## Velocity"
atlcli jira analyze velocity --board $BOARD_ID --sprints 1
```

## Detailed Report

For a more comprehensive report:

```bash
#!/bin/bash
# detailed-report.sh

BOARD_ID=$1
SPRINT_ID=$2
OUTPUT="sprint-report-$(date +%Y%m%d).md"

cat > $OUTPUT << EOF
# Sprint Report - $(date +%Y-%m-%d)

## Summary

$(atlcli jira sprint get --id $SPRINT_ID --json | jq -r '"- Start: \(.startDate)\n- End: \(.endDate)\n- Goal: \(.goal // "None")"')

## Metrics

### Velocity (Last 5 Sprints)
\`\`\`
$(atlcli jira analyze velocity --board $BOARD_ID)
\`\`\`

### Burndown
\`\`\`
$(atlcli jira analyze burndown --sprint $SPRINT_ID)
\`\`\`

## Completed Issues

$(atlcli jira search --jql "sprint = $SPRINT_ID AND status = Done" --json | \
  jq -r '.issues[] | "| \(.key) | \(.summary) | \(.type) |"' | \
  { echo "| Key | Summary | Type |"; echo "|-----|---------|------|"; cat; })

## Carry-over

$(atlcli jira search --jql "sprint = $SPRINT_ID AND status != Done" --json | \
  jq -r '.issues[] | "| \(.key) | \(.summary) | \(.status) |"' | \
  { echo "| Key | Summary | Status |"; echo "|-----|---------|--------|"; cat; })

EOF

echo "Report written to $OUTPUT"
```

## Scheduled Reports

### Cron Job

```bash
# Run every Friday at 5pm
0 17 * * 5 /path/to/sprint-report.sh 123 > /var/reports/sprint-$(date +%Y%m%d).md
```

### GitHub Actions

```yaml
name: Sprint Report
on:
  schedule:
    - cron: '0 17 * * 5'

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Generate Report
        env:
          ATLCLI_SITE: ${{ secrets.ATLASSIAN_URL }}
          ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
          ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
        run: |
          atlcli auth login
          ./scripts/sprint-report.sh $BOARD_ID $SPRINT_ID > report.md
      - name: Upload Report
        uses: actions/upload-artifact@v3
        with:
          name: sprint-report
          path: report.md
```

## Flow Metrics and Audit

Teams without sprints, or with sprints and a lot of carry-over, get more from flow metrics than from velocity:

```bash
# Cycle time and throughput of the last 30 days, and today's aging work
atlcli jira analyze flow --board 123 --since 30d
atlcli jira analyze aging --board 123

# What to raise in the retro: stuck, unassigned and stale work
atlcli audit jira --board 123 --markdown > retro-findings.md
```

Add them to the weekly report script:

```bash
echo "## Flow"
atlcli jira analyze flow --board "$BOARD_ID" --since 14d
echo
echo "## Needs attention"
atlcli audit jira --board "$BOARD_ID" --checks stuck-wip,unassigned-wip --fail-on never  # report only, no exit 2
```

## Related Topics

- [Analytics](../jira/analytics.md) - Velocity, burndown, predictability
- [Flow Metrics](../jira/flow-metrics.md) - Cycle time, throughput, aging work, cumulative flow
- [Jira Audit](../jira/audit.md) - Stuck, unassigned, stale and overdue work, under configurable rules
- [Boards & Sprints](../jira/boards-sprints.md) - Sprint management
- [CI/CD Docs](ci-cd-docs.md) - CI/CD pipeline integration
