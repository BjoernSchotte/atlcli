# Epics

Manage epics and their child issues.

## List Epics

```bash
atlcli jira epic list --project ATLCLI
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Filter by project key |
| `--board` | Filter by board ID |
| `--done` | Include completed epics |

### Examples

```bash
# List epics in a project
atlcli jira epic list --project ATLCLI

# List epics on a board
atlcli jira epic list --board 123

# Include completed epics
atlcli jira epic list --project ATLCLI --done
```

## Get Epic

```bash
atlcli jira epic get ATLCLI-100
```

## Create Epic

```bash
atlcli jira epic create --project ATLCLI --summary "User Authentication"
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Project key (required) |
| `--summary` | Epic summary (required) |
| `--description` | Epic description |

## Epic Issues

List issues in an epic:

```bash
atlcli jira epic issues ATLCLI-100
```

Options:

| Flag | Description |
|------|-------------|
| `--status` | Filter by status |
| `--limit` | Maximum results |

## Add Issues to Epic

Add one or more issues to an epic:

```bash
atlcli jira epic add ATLCLI-101 ATLCLI-102 ATLCLI-103 --epic ATLCLI-100
```

The issue keys are positional arguments, and `--epic` specifies the target epic.

## Remove Issues from Epic

Remove issues from their epic:

```bash
atlcli jira epic remove ATLCLI-101
```

This removes the issue from its current epic.

## Epic Progress

View completion status:

```bash
atlcli jira epic progress ATLCLI-100
```

Output:

```
Epic: ATLCLI-100 - User Authentication
Progress: 60% complete

Issues: 10 total
  Done:        6
  In Progress: 2
  To Do:       2
```

## JSON Output

All commands support `--json`:

```bash
atlcli jira epic list --project ATLCLI --json
```

```json
{
  "schemaVersion": "1",
  "epics": [
    {
      "key": "ATLCLI-100",
      "summary": "User Authentication",
      "status": "In Progress",
      "issueCount": 10,
      "doneCount": 6
    }
  ]
}
```
