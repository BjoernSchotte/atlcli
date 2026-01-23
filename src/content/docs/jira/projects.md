---
title: "Projects"
description: "Projects - atlcli documentation"
---

# Projects

View and manage Jira projects.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects (read), Administer Projects (create/update)

## List Projects

View all accessible projects:

```bash
atlcli jira project list
```

Output:

```
KEY       NAME                    LEAD              TYPE
PROJ      Main Project            alice@company     Software
SUPPORT   Customer Support        bob@company       Service Desk
INFRA     Infrastructure          carol@company     Software
```

Options:

| Flag | Description |
|------|-------------|
| `--type` | Filter by project type |
| `--limit` | Maximum results |
| `--json` | JSON output |

### Filter Projects

```bash
# Software projects only
atlcli jira project list --type software

# Search by name
atlcli jira project list --json | jq '.projects[] | select(.name | contains("Support"))'
```

## Get Project Details

View details of a specific project:

```bash
atlcli jira project get PROJ
```

Output:

```
Key:          PROJ
Name:         Main Project
Lead:         Alice (alice@company.com)
Type:         Software
URL:          https://company.atlassian.net/browse/PROJ
Description:  Main product development project

Issue Types:
  - Story
  - Task
  - Bug
  - Epic
  - Sub-task

Components:
  - Backend (lead: bob@company.com)
  - Frontend (lead: carol@company.com)
  - API (lead: alice@company.com)
```

Options:

| Flag | Description |
|------|-------------|
| `--expand` | Include additional data: `components`, `versions`, `issueTypes` |

## Project Issue Types

List available issue types for a project:

```bash
atlcli jira project types PROJ
```

Output:

```
ID      NAME          SUBTASK   DESCRIPTION
10001   Story         No        User story for feature work
10002   Task          No        General task
10003   Bug           No        Software defect
10004   Epic          No        Large feature or initiative
10005   Sub-task      Yes       Subtask of another issue
```

This is useful when creating issues to know which types are available.

## Components

### List Components

```bash
atlcli jira component list --project PROJ
```

Output:

```
ID      NAME        LEAD              ISSUES
10100   Backend     bob@company       45
10101   Frontend    carol@company     32
10102   API         alice@company     28
```

### Create Component

```bash
atlcli jira component create --project PROJ --name "Mobile" --lead dave@company.com
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Project key (required) |
| `--name` | Component name (required) |
| `--lead` | Component lead email |
| `--description` | Component description |

### Update Component

```bash
atlcli jira component update 10100 --name "Backend API" --lead alice@company.com
```

### Delete Component

```bash
atlcli jira component delete 10100 --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--move-to` | Move issues to another component |
| `--confirm` | Skip confirmation |

## Versions

### List Versions

```bash
atlcli jira version list --project PROJ
```

Output:

```
ID      NAME      STATUS      RELEASE DATE    ISSUES
10200   v1.0      Released    2024-12-01      45
10201   v1.1      Released    2025-01-01      32
10202   v2.0      Unreleased  2025-03-01      28
```

### Create Version

```bash
atlcli jira version create --project PROJ --name "v2.1" --release-date 2025-06-01
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Project key (required) |
| `--name` | Version name (required) |
| `--description` | Version description |
| `--release-date` | Planned release date |
| `--start-date` | Development start date |

### Release Version

Mark a version as released:

```bash
atlcli jira version release 10202
```

Options:

| Flag | Description |
|------|-------------|
| `--release-date` | Actual release date (defaults to today) |
| `--move-unfixed` | Move unfixed issues to another version |

### Update Version

```bash
atlcli jira version update 10202 --name "v2.0.0" --release-date 2025-04-01
```

### Delete Version

```bash
atlcli jira version delete 10202 --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--move-fix` | Move fix version issues to another version |
| `--move-affects` | Move affects version issues to another version |
| `--confirm` | Skip confirmation |

## JSON Output

```bash
atlcli jira project get PROJ --json
```

```json
{
  "schemaVersion": "1",
  "project": {
    "id": "10000",
    "key": "PROJ",
    "name": "Main Project",
    "projectTypeKey": "software",
    "lead": {
      "displayName": "Alice",
      "email": "alice@company.com"
    },
    "url": "https://company.atlassian.net/browse/PROJ",
    "issueTypes": [
      {"id": "10001", "name": "Story", "subtask": false},
      {"id": "10002", "name": "Task", "subtask": false},
      {"id": "10005", "name": "Sub-task", "subtask": true}
    ],
    "components": [
      {"id": "10100", "name": "Backend", "lead": "bob@company.com"}
    ],
    "versions": [
      {"id": "10200", "name": "v1.0", "released": true}
    ]
  }
}
```

## Use Cases

### Project Overview Script

```bash
# Get summary of all projects
atlcli jira project list --json | jq -r '.projects[] | "\(.key): \(.name) (\(.projectTypeKey))"'
```

### Find Available Issue Types

```bash
# Before creating an issue, check available types
atlcli jira project types PROJ --json | jq -r '.issueTypes[] | select(.subtask == false) | .name'
```

### Release Management

```bash
# Release a version and move incomplete issues
atlcli jira version release 10202 --move-unfixed 10203

# Create next version
atlcli jira version create --project PROJ --name "v2.1" --start-date $(date +%Y-%m-%d)
```

### Component Statistics

```bash
# Issues per component
atlcli jira component list --project PROJ --json | \
  jq -r '.components[] | "\(.name): \(.issueCount) issues"'
```

## Related Topics

- [Issues](issues.md) - Work with issues in projects
- [Fields](fields.md) - Custom fields per project
- [Boards & Sprints](boards-sprints.md) - Boards associated with projects
