# Issues

Create, read, update, and delete Jira issues.

## Get Issue

```bash
atlcli jira get PROJ-123
```

Options:

| Flag | Description |
|------|-------------|
| `--fields` | Specific fields to return |
| `--expand` | Expand changelog, comments, etc. |

## Create Issue

```bash
atlcli jira create --project PROJ --type Task --summary "Fix login bug"
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Project key (required) |
| `--type` | Issue type (required) |
| `--summary` | Issue summary (required) |
| `--description` | Issue description |
| `--assignee` | Assignee account ID |
| `--priority` | Priority name |
| `--labels` | Comma-separated labels |

## Update Issue

```bash
atlcli jira update PROJ-123 --summary "Updated summary" --priority High
```

## Delete Issue

```bash
atlcli jira delete PROJ-123 --confirm
```

## Transition

Change issue status:

```bash
atlcli jira transition PROJ-123 --status "In Progress"
```

List available transitions:

```bash
atlcli jira transition PROJ-123 --list
```

## Comments

```bash
# Add comment
atlcli jira comment add PROJ-123 --body "Working on this"

# List comments
atlcli jira comment list PROJ-123
```

## Links

```bash
# Link issues
atlcli jira link PROJ-123 PROJ-456 --type "blocks"

# List links
atlcli jira links PROJ-123
```

## Watchers

```bash
# Add watcher
atlcli jira watch PROJ-123

# List watchers
atlcli jira watchers PROJ-123
```
