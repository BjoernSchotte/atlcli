# Bulk Operations

Perform batch operations on multiple issues.

## Bulk Edit

Update multiple issues at once:

```bash
atlcli jira bulk edit --jql "project = PROJ AND labels = cleanup" --set-labels backend,tech-debt
```

Options:

| Flag | Description |
|------|-------------|
| `--jql` | JQL to select issues |
| `--issues` | Comma-separated issue keys |
| `--set-labels` | Replace labels |
| `--add-labels` | Add labels |
| `--remove-labels` | Remove labels |
| `--set-priority` | Set priority |
| `--set-assignee` | Set assignee |

## Bulk Transition

Move multiple issues to a new status:

```bash
atlcli jira bulk transition --jql "project = PROJ AND status = 'To Do'" --status "In Progress"
```

## Bulk Label

Add or remove labels from multiple issues:

```bash
# Add label
atlcli jira bulk label --jql "sprint in openSprints()" --add release-1.0

# Remove label
atlcli jira bulk label --issues PROJ-1,PROJ-2,PROJ-3 --remove deprecated
```

## Bulk Delete

Delete multiple issues:

```bash
atlcli jira bulk delete --jql "project = PROJ AND labels = test" --confirm
```

!!! warning
    Bulk delete is irreversible. Always use `--dry-run` first.

## Dry Run

Preview changes without applying:

```bash
atlcli jira bulk edit --jql "..." --set-priority High --dry-run
```

Shows which issues would be affected.
