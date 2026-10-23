---
title: "Projects"
description: "Projects - atlcli documentation"
---

# Projects

View and create Jira projects, and manage their components and versions.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects (read), Administer Projects (components, versions), Jira administrator (create projects)

All commands on this page print JSON, pretty-printed even without `--json`.

## List Projects

```bash
atlcli jira project list
atlcli jira project list --query support --limit 10
```

Output:

```json
{
  "schemaVersion": "1",
  "projects": [
    {
      "id": "10000",
      "key": "PROJ",
      "name": "Main Project",
      "projectTypeKey": "software",
      "style": "classic"
    },
    {
      "id": "10001",
      "key": "SUPPORT",
      "name": "Customer Support",
      "projectTypeKey": "service_desk",
      "style": "classic"
    }
  ],
  "total": 2
}
```

Options:

| Flag | Description |
|------|-------------|
| `--query` | Filter by text in the project key or name |
| `--limit` | Maximum results (default 50) |

## Get Project Details

```bash
atlcli jira project get PROJ
atlcli jira project get --key PROJ
```

The key works positionally or with `--key`. Output:

```json
{
  "schemaVersion": "1",
  "project": {
    "id": "10000",
    "key": "PROJ",
    "name": "Main Project",
    "description": "Main product development project",
    "lead": { "accountId": "557058:1b2c3d4e", "displayName": "Alice Lee" },
    "url": "https://company.atlassian.net/rest/api/3/project/10000",
    "projectTypeKey": "software",
    "style": "classic"
  }
}
```

## Create Project

```bash
atlcli jira project create --key MOB --name "Mobile App"
atlcli jira project create --key DESK --name "Help Desk" --type service_desk \
  --description "Customer requests" --lead alice@company.com
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Project key (required) |
| `--name` | Project name (required) |
| `--type` | `software` (default), `service_desk` or `business` |
| `--template` | Jira project template key |
| `--description` | Project description |
| `--lead` | Project lead (see [Users](issues.md#users)) |

Prints `{schemaVersion, project}`.

:::note[Data Center]
`--lead` needs a Cloud account ID. On Data Center the lead is not set; set it in Jira.
:::

## Project Issue Types

List available issue types for a project:

```bash
atlcli jira project types PROJ
```

Output:

```json
{
  "schemaVersion": "1",
  "issueTypes": [
    { "id": "10001", "name": "Story", "description": "User story for feature work", "subtask": false, "hierarchyLevel": 0 },
    { "id": "10004", "name": "Epic", "description": "Large feature or initiative", "subtask": false, "hierarchyLevel": 1 },
    { "id": "10005", "name": "Sub-task", "description": "Subtask of another issue", "subtask": true, "hierarchyLevel": -1 }
  ]
}
```

This is useful when creating issues to know which types are available.

## Components

`--project` falls back to `defaults.project` from your config.

### List Components

```bash
atlcli jira component list --project PROJ
```

Output:

```json
{
  "schemaVersion": "1",
  "project": "PROJ",
  "components": [
    { "id": "10100", "name": "Backend", "description": "API and services", "lead": "Bob Kim" },
    { "id": "10101", "name": "Frontend", "lead": "Carol Diaz" }
  ],
  "total": 2
}
```

### Get Component

```bash
atlcli jira component get 10100
```

Prints `{schemaVersion, component}` with `id`, `name`, `description`, `lead`, `leadAccountId` and `assigneeType`.

### Create Component

```bash
atlcli jira component create --project PROJ --name "Mobile" --lead dave@company.com
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Project key (required) |
| `--name` | Component name (required) |
| `--lead` | Component lead (see [Users](issues.md#users)); Cloud only |
| `--description` | Component description |

### Update Component

```bash
atlcli jira component update 10100 --name "Backend API" --lead alice@company.com
```

Pass at least one of `--name`, `--description` or `--lead`.

### Delete Component

```bash
atlcli jira component delete 10100 --confirm
```

`--confirm` is required.

## Versions

`--project` falls back to `defaults.project` from your config.

### List Versions

```bash
atlcli jira version list --project PROJ
```

Output:

```json
{
  "schemaVersion": "1",
  "project": "PROJ",
  "versions": [
    { "id": "10200", "name": "v1.0", "released": true, "releaseDate": "2024-12-01", "archived": false },
    { "id": "10202", "name": "v2.0", "description": "Next major", "released": false, "startDate": "2025-01-15", "releaseDate": "2025-03-01", "archived": false }
  ],
  "total": 2
}
```

### Get Version

```bash
atlcli jira version get 10202
```

Prints `{schemaVersion, version}` with the same fields as `version list`.

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
| `--release-date` | Planned release date (`YYYY-MM-DD`) |
| `--start-date` | Development start date (`YYYY-MM-DD`) |

### Update Version

```bash
atlcli jira version update 10202 --name "v2.0.0" --release-date 2025-04-01
```

Takes the same `--name`, `--description`, `--start-date` and `--release-date` flags as `create`; pass at least one.

### Release Version

Mark a version as released. The release date is set to today:

```bash
atlcli jira version release 10202
```

To record another date, run `version update <id> --release-date <date>` afterwards.

### Delete Version

```bash
atlcli jira version delete 10202 --confirm
```

`--confirm` is required.

### Release Notes Page

Create or update a Confluence release notes page for a version, optionally exported to PDF or DOCX:

```bash
atlcli jira version notes "v2.0.0" --project PROJ --space DOCS --dry-run
atlcli jira version notes 10202 --space DOCS --group-by epic --export release-notes.pdf
```

See [Release Notes and Sprint Review Pages](report-pages.md) for options and templates.

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
# Check for unfinished issues, then release
atlcli jira search --jql 'fixVersion = "v2.0" AND statusCategory != Done'
atlcli jira version release 10202

# Create next version
atlcli jira version create --project PROJ --name "v2.1" --start-date $(date +%Y-%m-%d)
```

### Component Leads

```bash
atlcli jira component list --project PROJ --json | \
  jq -r '.components[] | "\(.name): \(.lead // "no lead")"'
```

## Related Topics

- [Issues](issues.md) - Work with issues in projects
- [Fields](fields.md) - Custom fields per project
- [Boards & Sprints](boards-sprints.md) - Boards associated with projects
