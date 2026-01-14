# Sprint Reporting

Generate automated sprint reports with atlcli.

## Use Case

At the end of each sprint, generate a report including:

- Completed work
- Velocity metrics
- Carry-over items
- Time logged

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
atlcli jira sprint get $SPRINT_ID

# Completed issues
echo ""
echo "## Completed"
atlcli jira search --jql "sprint = $SPRINT_ID AND status = Done" --json | \
  jq -r '.issues[] | "- [\(.key)] \(.fields.summary)"'

# Incomplete issues
echo ""
echo "## Carry-over"
atlcli jira search --jql "sprint = $SPRINT_ID AND status != Done" --json | \
  jq -r '.issues[] | "- [\(.key)] \(.fields.summary) (\(.fields.status.name))"'

# Velocity
echo ""
echo "## Velocity"
atlcli jira analytics velocity --board $BOARD_ID --sprints 1
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

$(atlcli jira sprint get $SPRINT_ID --json | jq -r '"- Start: \(.startDate)\n- End: \(.endDate)\n- Goal: \(.goal // "None")"')

## Metrics

### Velocity (Last 5 Sprints)
\`\`\`
$(atlcli jira analytics velocity --board $BOARD_ID)
\`\`\`

### Burndown
\`\`\`
$(atlcli jira analytics burndown --sprint $SPRINT_ID)
\`\`\`

## Completed Issues

$(atlcli jira search --jql "sprint = $SPRINT_ID AND status = Done" --json | \
  jq -r '.issues[] | "| \(.key) | \(.fields.summary) | \(.fields.issuetype.name) |"' | \
  { echo "| Key | Summary | Type |"; echo "|-----|---------|------|"; cat; })

## Carry-over

$(atlcli jira search --jql "sprint = $SPRINT_ID AND status != Done" --json | \
  jq -r '.issues[] | "| \(.key) | \(.fields.summary) | \(.fields.status.name) |"' | \
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
          ATLCLI_BASE_URL: ${{ secrets.ATLASSIAN_URL }}
          ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
          ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
        run: ./scripts/sprint-report.sh $BOARD_ID $SPRINT_ID > report.md
      - name: Upload Report
        uses: actions/upload-artifact@v3
        with:
          name: sprint-report
          path: report.md
```
