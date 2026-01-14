# CLI Commands

Quick reference for all atlcli commands.

## Global Options

| Flag | Description |
|------|-------------|
| `--profile` | Auth profile to use |
| `--json` | Output as JSON |
| `--help` | Show help |
| `--version` | Show version |

## Authentication

```bash
atlcli auth init [--profile <name>]     # Initialize credentials
atlcli auth list                        # List profiles
atlcli auth delete --profile <name>     # Delete profile
```

## Confluence

### Sync

```bash
atlcli docs init <dir> --space <key>    # Initialize directory
atlcli docs pull <dir>                  # Pull from Confluence
atlcli docs push <dir>                  # Push to Confluence
atlcli docs sync <dir> --watch          # Watch and sync
atlcli docs status <dir>                # Show sync status
```

### Pages

```bash
atlcli docs create --space <key> --title <title>
atlcli docs update --page <id> --content <content>
atlcli docs delete --page <id> --confirm
atlcli docs move --page <id> --parent <id>
```

### Templates

```bash
atlcli docs template list
atlcli docs template save --page <id> --name <name>
atlcli docs template delete <name>
```

## Jira

### Issues

```bash
atlcli jira get <key>                   # Get issue
atlcli jira create --project <key> --type <type> --summary <text>
atlcli jira update <key> [--summary <text>] [--priority <name>]
atlcli jira delete <key> --confirm
atlcli jira transition <key> --status <status>
```

### Search

```bash
atlcli jira search --jql <query>
atlcli jira search --assignee me --status "In Progress"
atlcli jira search --project <key> --type Bug
```

### Comments

```bash
atlcli jira comment add <key> --body <text>
atlcli jira comment list <key>
```

### Worklogs

```bash
atlcli jira worklog add <key> --time <duration>
atlcli jira worklog list <key>
atlcli jira worklog timer start <key>
atlcli jira worklog timer stop <key>
atlcli jira worklog timer status
```

### Boards & Sprints

```bash
atlcli jira board list
atlcli jira board get <id>
atlcli jira sprint list --board <id>
atlcli jira sprint get <id>
atlcli jira sprint create --board <id> --name <name>
atlcli jira sprint start <id>
atlcli jira sprint complete <id>
```

### Epics

```bash
atlcli jira epic list --project <key>
atlcli jira epic get <key>
atlcli jira epic create --project <key> --name <name>
atlcli jira epic add <key> --issues <keys>
atlcli jira epic remove <key> --issues <keys>
```

### Templates

```bash
atlcli jira template list
atlcli jira template save <name> --issue <key>
atlcli jira template get <name>
atlcli jira template apply <name> --project <key> --summary <text>
atlcli jira template delete <name> --confirm
atlcli jira template export <name> -o <file>
atlcli jira template import --file <path>
```

### Bulk Operations

```bash
atlcli jira bulk edit --jql <query> [--set-labels <labels>]
atlcli jira bulk transition --jql <query> --status <status>
atlcli jira bulk delete --jql <query> --confirm
```

### Analytics

```bash
atlcli jira analytics velocity --board <id>
atlcli jira analytics burndown --sprint <id>
atlcli jira analytics predictability --board <id>
```

### Fields

```bash
atlcli jira field list [--custom]
atlcli jira field get <id>
atlcli jira field options <id>
```

## Plugins

```bash
atlcli plugin list
atlcli plugin enable <name>
atlcli plugin disable <name>
atlcli plugin install <path|url>
atlcli plugin remove <name>
```
