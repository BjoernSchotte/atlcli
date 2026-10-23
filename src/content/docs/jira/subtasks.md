---
title: "Subtasks"
description: "Subtasks - atlcli documentation"
---

# Subtasks

Create and manage subtasks for breaking down work into smaller pieces.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Create Issues, Edit Issues

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

Output (pretty JSON, with or without `--json`):

```json
{
  "schemaVersion": "1",
  "parent": {
    "key": "PROJ-123",
    "summary": "Implement user authentication"
  },
  "subtasks": [
    { "key": "PROJ-124", "summary": "Implement API endpoint", "status": "In Progress", "type": "Sub-task" },
    { "key": "PROJ-125", "summary": "Write unit tests", "status": "To Do", "type": "Sub-task" }
  ],
  "total": 2
}
```

The parent key works positionally or with `--parent`.

## Create Subtask

Create a new subtask under a parent issue:

```bash
atlcli jira subtask create PROJ-123 --summary "Implement API endpoint"
```

Options:

| Flag | Description |
|------|-------------|
| `--summary` | Subtask summary (required) |
| `--description` | Description (markdown); `--description-file <path\|->` reads it from a file or stdin |
| `--assignee` | Assignee (see [Users](issues.md#users)) |
| `--priority` | Priority name (e.g., High, Medium, Low) |

Prints `{schemaVersion, created: {id, key, parent, summary}}`. To add labels, run `issue update --key <new key> --add-labels …` afterwards.

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

atlcli uses the first subtask issue type of the parent's project. Projects name it differently, for example:

- Sub-task
- Subtask
- Technical Sub-task
- Sub-bug

The CLI handles this automatically - just use `subtask create` and it will find the right type.

## View Subtask Details

View a subtask with its parent information:

```bash
atlcli jira issue get --key PROJ-124
```

Output includes the parent issue reference.

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
  xargs -I {} atlcli jira issue transition --key {} --to Done
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

## Related Topics

- [Issues](issues.md) - Parent issue operations
- [Projects](projects.md) - Subtask issue types per project
- [Boards & Sprints](boards-sprints.md) - Sprint planning with subtasks
