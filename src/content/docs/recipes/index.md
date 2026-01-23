---
title: "Recipes"
description: "Recipes - atlcli documentation"
---

# Recipes

Real-world workflows and use cases for atlcli.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- Appropriate Jira and/or Confluence permissions for the operations

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
atlcli jira search --jql "assignee = currentUser() AND updated > -1d AND status = Done"

echo "=== In Progress ==="
atlcli jira search --assignee me --status "In Progress"

echo "=== Time Logged ==="
atlcli jira worklog report --since 1d
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
atlcli jira analyze velocity --board $BOARD_ID
atlcli jira sprint list --board $BOARD_ID --state active
atlcli jira search --sprint current --status Open --json | jq '.total'
```

## Related Topics

- [Jira](../jira/index.md) - Full Jira CLI reference
- [Confluence](../confluence/index.md) - Full Confluence CLI reference
