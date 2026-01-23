# Issue Triage

Efficiently triage and manage incoming issues.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Edit Issues, Assign Issues

## Use Case

Your team receives many issues. You need to:

- Review unassigned issues
- Set priorities
- Assign to team members
- Add labels for categorization

## Triage Script

```bash
#!/bin/bash
# triage.sh - Interactive issue triage
# Usage: ./triage.sh <project>

PROJECT=$1

echo "Fetching unassigned issues..."
ISSUES=$(atlcli jira search --jql "project = $PROJECT AND assignee is EMPTY AND status = Open" --json)

echo "$ISSUES" | jq -r '.issues[] | "\(.key): \(.fields.summary)"'

echo ""
echo "Enter issue key to triage (or 'q' to quit):"

while read -r KEY; do
  [ "$KEY" = "q" ] && break

  echo ""
  atlcli jira issue get --key $KEY

  echo ""
  echo "Actions: [a]ssign, [p]riority, [l]abel, [t]ransition, [s]kip"
  read -r ACTION

  case $ACTION in
    a)
      echo "Enter assignee account ID:"
      read -r ASSIGNEE
      atlcli jira issue update --key $KEY --assignee "$ASSIGNEE"
      ;;
    p)
      echo "Priority (Highest, High, Medium, Low, Lowest):"
      read -r PRIORITY
      atlcli jira issue update --key $KEY --priority "$PRIORITY"
      ;;
    l)
      echo "Labels to add (comma-separated):"
      read -r LABELS
      atlcli jira issue update --key $KEY --add-labels "$LABELS"
      ;;
    t)
      echo "Available transitions:"
      atlcli jira issue transitions --key $KEY
      echo "Enter status:"
      read -r STATUS
      atlcli jira issue transition --key $KEY --to "$STATUS"
      ;;
  esac

  echo ""
  echo "Next issue (or 'q' to quit):"
done
```

## Bulk Triage

For large batches, use bulk operations:

### Label by Type

```bash
# Label all bugs
atlcli jira bulk label add bug --jql "project = PROJ AND type = Bug AND labels is EMPTY"

# Label all stories
atlcli jira bulk label add feature --jql "project = PROJ AND type = Story AND labels is EMPTY"
```

### Set Default Priority

```bash
# Set medium priority for issues without priority
atlcli jira bulk edit --jql "project = PROJ AND priority is EMPTY" --set priority=Medium
```

### Auto-assign by Component

```bash
#!/bin/bash
# auto-assign.sh - Assign issues by component

# Backend issues to Alice
atlcli jira bulk edit \
  --jql "project = PROJ AND component = Backend AND assignee is EMPTY" \
  --set assignee=557058:alice-account-id

# Frontend issues to Bob
atlcli jira bulk edit \
  --jql "project = PROJ AND component = Frontend AND assignee is EMPTY" \
  --set assignee=557058:bob-account-id
```

## Scheduled Triage

Run triage automatically:

```bash
#!/bin/bash
# daily-triage.sh - Run by cron daily

# Move stale issues
atlcli jira bulk transition \
  --jql "project = PROJ AND status = Open AND updated < -30d" \
  --to "Needs Review"

# Notify about high-priority unassigned
COUNT=$(atlcli jira search \
  --jql "project = PROJ AND priority in (Highest, High) AND assignee is EMPTY" \
  --json | jq '.total')

if [ "$COUNT" -gt 0 ]; then
  echo "$COUNT high-priority issues need assignment" | \
    mail -s "Jira Triage Alert" team@company.com
fi
```

## Tips

- Use JQL filters to focus triage
- Create saved filters for common queries
- Set up notifications for high-priority items
- Review triage metrics periodically

## Related Topics

- [Jira Issues](../jira/issues.md) - Issue operations
- [Bulk Operations](../jira/bulk-operations.md) - Batch updates
- [Filters](../jira/filters.md) - Save JQL queries
