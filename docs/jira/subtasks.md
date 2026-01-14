# Subtasks

Create and manage subtasks for breaking down work into smaller pieces.

## Overview

Subtasks are child issues that belong to a parent issue. They're useful for:

- Breaking down stories into implementation tasks
- Tracking individual work items within a larger feature
- Parallel work assignment on a single issue

## List Subtasks

View subtasks of a parent issue:

```bash
atlcli jira subtask list PROJ-123
```

Output:

```
KEY         STATUS        ASSIGNEE      SUMMARY
PROJ-124    In Progress   alice         Implement API endpoint
PROJ-125    To Do         bob           Write unit tests
PROJ-126    Done          alice         Update documentation
```

Options:

| Flag | Description |
|------|-------------|
| `--format` | Output format: `table`, `json` |
| `--fields` | Fields to display |

## Create Subtask

Create a new subtask under a parent issue:

```bash
atlcli jira subtask create PROJ-123 --summary "Implement API endpoint"
```

Options:

| Flag | Description |
|------|-------------|
| `--summary` | Subtask summary (required) |
| `--description` | Detailed description |
| `--assignee` | Assignee email or account ID |
| `--priority` | Priority name (e.g., High, Medium, Low) |
| `--labels` | Comma-separated labels |

### Examples

```bash
# Create with full details
atlcli jira subtask create PROJ-123 \
  --summary "Write unit tests" \
  --description "Cover all edge cases for the new API" \
  --assignee alice@company.com \
  --priority High

# Create multiple subtasks
for task in "Design API" "Implement backend" "Write tests" "Update docs"; do
  atlcli jira subtask create PROJ-123 --summary "$task"
done
```

## Subtask Types

atlcli automatically detects the correct subtask issue type for your project. Different projects may use different names:

- Sub-task
- Subtask
- Technical Sub-task
- Sub-bug

The CLI handles this automatically - just use `subtask create` and it will find the right type.

## View Parent Issue

When viewing a subtask, the parent is shown:

```bash
atlcli jira get PROJ-124
```

Output includes:

```
Parent: PROJ-123 - Implement user authentication
```

## Move Subtask

Move a subtask to a different parent:

```bash
atlcli jira update PROJ-124 --parent PROJ-200
```

## Convert Issue to Subtask

Convert a standalone issue into a subtask:

```bash
atlcli jira update PROJ-150 --parent PROJ-123
```

!!! warning "Type Change"
    Converting to a subtask changes the issue type. Some fields may be lost if they're not available on the subtask type.

## Convert Subtask to Issue

Promote a subtask to a standalone issue:

```bash
atlcli jira update PROJ-124 --remove-parent
```

## JSON Output

```bash
atlcli jira subtask list PROJ-123 --json
```

```json
{
  "schemaVersion": "1",
  "parent": {
    "key": "PROJ-123",
    "summary": "Implement user authentication"
  },
  "subtasks": [
    {
      "key": "PROJ-124",
      "summary": "Implement API endpoint",
      "status": "In Progress",
      "assignee": {
        "displayName": "Alice",
        "email": "alice@company.com"
      },
      "priority": "High"
    }
  ],
  "total": 3
}
```

## Use Cases

### Sprint Planning Breakdown

```bash
# Break down a story into tasks
STORY="PROJ-100"

atlcli jira subtask create $STORY --summary "Database schema design" --assignee alice@company.com
atlcli jira subtask create $STORY --summary "API implementation" --assignee bob@company.com
atlcli jira subtask create $STORY --summary "Frontend integration" --assignee carol@company.com
atlcli jira subtask create $STORY --summary "End-to-end tests" --assignee alice@company.com
```

### Track Subtask Progress

```bash
# Get completion percentage
TOTAL=$(atlcli jira subtask list PROJ-123 --json | jq '.total')
DONE=$(atlcli jira subtask list PROJ-123 --json | jq '[.subtasks[] | select(.status == "Done")] | length')
echo "Progress: $DONE / $TOTAL subtasks done"
```

### Bulk Transition Subtasks

```bash
# Mark all subtasks as done when parent is resolved
atlcli jira subtask list PROJ-123 --json | \
  jq -r '.subtasks[] | select(.status != "Done") | .key' | \
  xargs -I {} atlcli jira transition {} --status Done
```

### Create Subtasks from Template

```bash
# Standard subtasks for a bug fix
BUG="PROJ-500"
SUBTASKS=("Reproduce issue" "Root cause analysis" "Implement fix" "Write regression test" "Code review")

for task in "${SUBTASKS[@]}"; do
  atlcli jira subtask create $BUG --summary "$task"
done
```
