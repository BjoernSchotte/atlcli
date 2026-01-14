# CLI Commands

Quick reference for all atlcli commands.

## Global Options

| Flag | Description |
|------|-------------|
| `--profile <name>` | Auth profile to use |
| `--json` | Output as JSON |
| `--no-log` | Disable logging for this command |
| `--help` | Show help |
| `--version` | Show version |

## Authentication

```bash
# Interactive setup
atlcli auth init                        # Initialize default profile
atlcli auth init --profile work         # Initialize named profile

# Non-interactive login
atlcli auth login --site <url> --email <email> --token <token>
atlcli auth login --profile work --site <url>

# Profile management
atlcli auth status                      # Show current profile status
atlcli auth list                        # List all profiles
atlcli auth switch <name>               # Switch active profile
atlcli auth rename <old> <new>          # Rename profile

# Cleanup
atlcli auth logout                      # Clear active profile credentials
atlcli auth logout <name>               # Clear specific profile credentials
atlcli auth delete --profile <name>     # Delete profile entirely
atlcli auth delete --profile <name> --confirm  # Skip confirmation
```

## Confluence

### Sync

```bash
atlcli wiki docs init <dir> --space <key>    # Initialize sync directory
atlcli wiki docs pull <dir>                  # Pull from Confluence
atlcli wiki docs pull <dir> --page-id <id>   # Pull specific page
atlcli wiki docs pull <dir> --version <n>    # Pull specific version
atlcli wiki docs pull <dir> --label <name>   # Pull pages with label
atlcli wiki docs push <dir>                  # Push to Confluence
atlcli wiki docs push <dir> --dry-run        # Preview changes
atlcli wiki docs push <dir> --force          # Force overwrite
atlcli wiki docs sync <dir> --watch          # Watch and sync
atlcli wiki docs status <dir>                # Show sync status
atlcli wiki docs add <dir> --template <name> # Add page from template
atlcli wiki docs diff <dir>                  # Show local vs remote diff
atlcli wiki docs resolve <dir>               # Resolve sync conflicts
atlcli wiki docs check <dir>                 # Validate docs
atlcli wiki docs preview <dir>               # Preview markdown rendering
```

### Pages

```bash
atlcli wiki page list --space <key>          # List pages in space
atlcli wiki page list --cql <query>          # Filter with CQL
atlcli wiki page list --label <name>         # Filter by label
atlcli wiki page get --id <id>               # Get page content
atlcli wiki page get --id <id> --version <n> # Get specific version
atlcli wiki page create --space <key> --title <title> --body <file>
atlcli wiki page create --space <key> --title <title> --body <file> --parent <id>
atlcli wiki page update --id <id> --body <file>
atlcli wiki page update --id <id> --body <file> --title <title>
atlcli wiki page delete --id <id> --confirm
atlcli wiki page delete --cql <query> --dry-run  # Bulk delete preview
atlcli wiki page delete --cql <query> --confirm  # Bulk delete
atlcli wiki page move --id <id> --parent <id>
atlcli wiki page move <file> --before <target>   # Position before sibling
atlcli wiki page move <file> --after <target>    # Position after sibling
atlcli wiki page move <file> --first             # First child position
atlcli wiki page move <file> --last              # Last child position
atlcli wiki page move --id <id> --position <n>   # Specific position
atlcli wiki page copy --id <id> --title <title>
atlcli wiki page copy --id <id> --title <title> --space <key>
atlcli wiki page children --id <id>          # List child pages
atlcli wiki page children --id <id> --depth <n> --format tree
atlcli wiki page sort <file> --alphabetical
atlcli wiki page sort <file> --natural       # Natural sort (Chapter 2 < Chapter 10)
atlcli wiki page sort <file> --by created
atlcli wiki page sort --id <id> --by modified --reverse
atlcli wiki page archive --id <id> --confirm
atlcli wiki page archive --cql <query> --dry-run
```

### Page History

```bash
atlcli wiki page history --id <id>           # List versions
atlcli wiki page history --id <id> --limit <n>
atlcli wiki page diff --id <id> --version <n>  # Compare with current
atlcli wiki page diff --id <id> --from <n> --to <n>
atlcli wiki page restore --id <id> --version <n>
atlcli wiki page restore --id <id> --version <n> --message <text> --confirm
```

### Comments

```bash
# Footer comments
atlcli wiki page comments list --id <id>
atlcli wiki page comments add --id <id> "Comment text"
atlcli wiki page comments reply --id <id> --parent <comment-id> "Reply text"
atlcli wiki page comments update --id <id> --comment <comment-id> "Updated text"
atlcli wiki page comments delete --id <id> --comment <comment-id> --confirm
atlcli wiki page comments resolve --id <id> --comment <comment-id>
atlcli wiki page comments reopen --id <id> --comment <comment-id>

# Inline comments
atlcli wiki page comments list --id <id> --inline
atlcli wiki page comments add-inline --id <id> --selection <text> "Comment"
```

### Labels

```bash
atlcli wiki page label list --id <id>        # List labels on page
atlcli wiki page label add <label> [<label>...] --id <id>  # Add labels
atlcli wiki page label add <label> --cql <query> --dry-run  # Bulk add preview
atlcli wiki page label add <label> --cql <query> --confirm  # Bulk add
atlcli wiki page label remove <label> --id <id>
atlcli wiki page label remove <label> --cql <query> --confirm  # Bulk remove
```

### Search

```bash
atlcli wiki search <query>                   # Full-text search
atlcli wiki search <query> --space <key>     # Search in space
atlcli wiki search --cql <query>             # CQL search
atlcli wiki search --label <label>           # Search by label
atlcli wiki search --creator <email>         # Search by creator
atlcli wiki search --type page               # Filter by type
atlcli wiki search --ancestor <id>           # Search in page tree
atlcli wiki search --modified-since <duration>
atlcli wiki search --created-since <duration>
atlcli wiki search --title <text>            # Search titles only
atlcli wiki search --limit <n> --start <n>   # Pagination
atlcli wiki search --format compact          # Compact output
atlcli wiki search --verbose                 # Detailed output
```

### Spaces

```bash
atlcli wiki space list                       # List all spaces
atlcli wiki space list --limit <n>
atlcli wiki space get --key <key>            # Get space details
atlcli wiki space create --key <key> --name <name>
atlcli wiki space create --key <key> --name <name> --description <text>
```

### Templates

```bash
atlcli wiki docs template list               # List saved templates
atlcli wiki docs template get <name>         # Show template
atlcli wiki docs template save --page <id> --name <name>
atlcli wiki docs template apply <name> --space <key> --title <title>
atlcli wiki docs template delete <name>
atlcli wiki docs template export <name> -o <file>
atlcli wiki docs template import --file <path>
```

## Jira

### Issues

```bash
atlcli jira issue get --key <key>       # Get issue details
atlcli jira issue get --key <key> --expand all
atlcli jira issue create --project <key> --type <type> --summary <text>
atlcli jira issue create --project <key> --type <type> --summary <text> \
  --description <text> --assignee <email> --labels <labels>
atlcli jira issue update --key <key> --summary <text>
atlcli jira issue update --key <key> --priority <name>
atlcli jira issue update --key <key> --labels <labels>
atlcli jira issue update --key <key> --assignee <email>
atlcli jira issue update --key <key> --set <field>=<value>
atlcli jira issue delete --key <key> --confirm
atlcli jira issue transition --key <key> --to <status>
atlcli jira issue transitions --key <key>  # List available transitions
atlcli jira issue assign --key <key> --assignee <email>
atlcli jira issue assign --key <key> --assignee none  # Unassign
atlcli jira issue link --from <key> --to <key> --type <type>
atlcli jira issue attach --key <key> <file>  # Attach file
atlcli jira watch <key>                 # Watch issue
atlcli jira unwatch <key>               # Stop watching
atlcli jira watchers <key>              # List watchers
```

### Search

```bash
atlcli jira search --jql <query>        # JQL search
atlcli jira search --assignee me        # My issues
atlcli jira search --assignee <email>
atlcli jira search --status "In Progress"
atlcli jira search --project <key>
atlcli jira search --type Bug
atlcli jira search --type Bug,Task      # Multiple types
atlcli jira search --label <label>      # Filter by label
atlcli jira search --sprint <id>        # Filter by sprint
atlcli jira search --epic <key>
atlcli jira search --created-since <duration>
atlcli jira search --updated-since <duration>
atlcli jira search --limit <n> --start <n>
atlcli jira search --fields key,summary,status
```

### Comments

```bash
atlcli jira issue comment --key <key> "Comment text"
```

### Worklogs

```bash
atlcli jira worklog list --key <key>
atlcli jira worklog add --key <key> --time <duration>
atlcli jira worklog add --key <key> --time 2h --comment <text>
atlcli jira worklog add --key <key> --time 1h30m --started <datetime>
atlcli jira worklog add --key <key> --time 1h --round 15m
atlcli jira worklog update --key <key> --worklog-id <id> --time <duration>
atlcli jira worklog delete --key <key> --worklog-id <id> --confirm

# Timer mode
atlcli jira worklog timer start --key <key>
atlcli jira worklog timer start --key <key> --comment <text>
atlcli jira worklog timer stop           # Stop and log time
atlcli jira worklog timer stop --round 15m
atlcli jira worklog timer status         # Show running timer
atlcli jira worklog timer cancel         # Cancel without logging
```

### Boards

```bash
atlcli jira board list                  # List all boards
atlcli jira board list --project <key>
atlcli jira board list --type scrum     # Filter by type
atlcli jira board list --name <pattern>
atlcli jira board get --id <id>         # Get board details
atlcli jira board backlog --id <id>     # Get backlog issues
atlcli jira board issues --id <id>      # Get board issues
```

### Sprints

```bash
atlcli jira sprint list --board <id>
atlcli jira sprint get --id <id>
atlcli jira sprint create --board <id> --name <name>
atlcli jira sprint create --board <id> --name <name> \
  --start <date> --end <date> --goal <text>
atlcli jira sprint update --id <id> --name <name>
atlcli jira sprint start --id <id>
atlcli jira sprint complete --id <id>
atlcli jira sprint complete --id <id> --move-to <sprint-id>
atlcli jira sprint add --id <id> --issues <keys>
atlcli jira sprint remove --id <id> --issues <keys>
atlcli jira sprint report --id <id>     # Sprint metrics report
atlcli jira sprint report --id <id> --format markdown
```

### Epics

```bash
atlcli jira epic list --project <key>
atlcli jira epic list --board <id>
atlcli jira epic list --project <key> --done  # Include done epics
atlcli jira epic get <key>
atlcli jira epic create --project <key> --summary <text>
atlcli jira epic issues <key>           # List child issues
atlcli jira epic add <issues...> --epic <key>  # Add issues to epic
atlcli jira epic remove <issues...>     # Remove issues from epic
atlcli jira epic progress <key>         # Show completion progress
```

### Subtasks

```bash
atlcli jira subtask list --parent <key>
atlcli jira subtask create --parent <key> --summary <text>
atlcli jira subtask create --parent <key> --summary <text> \
  --assignee <email> --description <text>
```

### Components

```bash
atlcli jira component list --project <key>
atlcli jira component create --project <key> --name <name>
atlcli jira component create --project <key> --name <name> \
  --lead <email> --description <text>
atlcli jira component update --id <id> --name <name>
atlcli jira component delete --id <id> --confirm
```

### Versions

```bash
atlcli jira version list --project <key>
atlcli jira version create --project <key> --name <name>
atlcli jira version create --project <key> --name <name> \
  --start-date <date> --release-date <date>
atlcli jira version release --id <id>
atlcli jira version delete --id <id> --confirm
```

### Templates

```bash
atlcli jira template list
atlcli jira template get <name>
atlcli jira template save <name> --issue <key>
atlcli jira template apply <name> --project <key> --summary <text>
atlcli jira template apply <name> --project <key> --summary <text> \
  --variables "version=2.0,component=API"
atlcli jira template delete <name> --confirm
atlcli jira template export <name> -o <file>
atlcli jira template import --file <path>
```

### Bulk Operations

```bash
atlcli jira bulk edit --jql <query> --set "field=value"
atlcli jira bulk edit --jql <query> --set "priority=High"
atlcli jira bulk edit --jql <query> --dry-run --limit <n>
atlcli jira bulk transition --jql <query> --to <status>
atlcli jira bulk transition --jql <query> --to <status> --dry-run
atlcli jira bulk label add <label> --jql <query>
atlcli jira bulk label remove <label> --jql <query>
atlcli jira bulk delete --jql <query> --confirm
```

### Filters

```bash
atlcli jira filter list
atlcli jira filter get --id <id>
atlcli jira filter create --name <name> --jql <query>
atlcli jira filter update --id <id> --jql <query>
atlcli jira filter delete --id <id> --confirm
atlcli jira filter run --id <id>        # Execute filter
atlcli jira filter share --id <id> --user <email>
atlcli jira filter share --id <id> --group <name>
```

### Analytics

```bash
atlcli jira analyze velocity --board <id>
atlcli jira analyze velocity --board <id> --sprints <n>
atlcli jira analyze burndown --sprint <id>
atlcli jira analyze burndown --sprint <id> --ideal
atlcli jira analyze predictability --board <id>
```

### Fields

```bash
atlcli jira field list                  # List all fields
atlcli jira field list --custom         # Custom fields only
atlcli jira field list --system         # System fields only
atlcli jira field get --id <id>
atlcli jira field search <query>        # Search fields by name
atlcli jira field options --id <id>     # List field options
```

### Import/Export

```bash
atlcli jira export --jql <query> -o <file>.csv
atlcli jira export --jql <query> -o <file>.json
atlcli jira export --jql <query> --fields key,summary,status
atlcli jira import --file <path>.csv --project <key>
atlcli jira import --file <path>.json --project <key>
atlcli jira import --file <path> --dry-run
```

## Logging

```bash
atlcli log list                         # List recent entries
atlcli log list --limit <n>
atlcli log list --since <duration>
atlcli log list --since <date> --until <date>
atlcli log list --level error
atlcli log list --level warn
atlcli log list --type api
atlcli log list --type cli.command
atlcli log list --type sync

atlcli log tail -f                      # Follow logs
atlcli log tail -f --level error
atlcli log tail --project               # Project logs only

atlcli log show <id>                    # Show entry details

atlcli log clear --before <duration> --confirm
atlcli log clear --before <duration> --global --confirm
atlcli log clear --before <duration> --project --confirm
```

## Plugins

```bash
atlcli plugin list                      # List all plugins
atlcli plugin list --enabled
atlcli plugin enable <name>
atlcli plugin disable <name>
atlcli plugin install <path>            # Install from local path
atlcli plugin remove <name>
```
