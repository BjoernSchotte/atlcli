# Recipes

Real-world workflows and use cases for atlcli.

## Workflows

- [Team Docs Sync](team-docs.md) - Sync team documentation with Confluence
- [Sprint Reporting](sprint-reporting.md) - Automated sprint reports
- [CI/CD Docs](ci-cd-docs.md) - Publish documentation from CI/CD
- [Issue Triage](issue-triage.md) - Bulk issue triage workflow

## Common Patterns

### Daily Standup Prep

```bash
#!/bin/bash
# standup.sh - Show what you worked on yesterday and today's plan

echo "=== Yesterday ==="
atlcli jira search --assignee me --updated 1d --status Done

echo "=== In Progress ==="
atlcli jira search --assignee me --status "In Progress"

echo "=== Time Logged ==="
atlcli jira worklog report --user me --from yesterday
```

### Release Notes

```bash
#!/bin/bash
# release-notes.sh - Generate release notes from fixed issues

VERSION=$1
atlcli jira search --jql "fixVersion = '$VERSION' AND status = Done" --json | \
  jq -r '.issues[] | "- \(.fields.summary) (\(.key))"'
```

### Sprint Health Check

```bash
#!/bin/bash
# sprint-health.sh - Check current sprint status

BOARD_ID=$1
atlcli jira analytics velocity --board $BOARD_ID
atlcli jira sprint list --board $BOARD_ID --state active
atlcli jira search --sprint current --status Open --json | jq '.total'
```
