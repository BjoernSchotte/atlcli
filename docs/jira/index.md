# Jira

atlcli provides full issue lifecycle management, search, sprints, and analytics from the command line.

## Overview

```bash
# Search issues
atlcli jira search --assignee me --status "In Progress"

# View an issue
atlcli jira get PROJ-123

# Create an issue
atlcli jira create --project PROJ --type Task --summary "Fix bug"

# Track time
atlcli jira worklog timer start PROJ-123
```

## Key Features

- **Issue Management** - Create, update, transition, comment, link
- **JQL Search** - Full JQL support with convenient shortcuts
- **Boards & Sprints** - View boards, manage sprints, backlog operations
- **Time Tracking** - Log work with timer or direct entry
- **Epic Management** - Create epics, add/remove issues
- **Cross-Product Linking** - Link issues to Confluence pages bidirectionally
- **Analytics** - Velocity, burndown, predictability metrics
- **Bulk Operations** - Edit, transition, label multiple issues
- **Templates** - Save and reuse issue configurations

## Quick Start

### Search Issues

```bash
# Your in-progress issues
atlcli jira search --assignee me --status "In Progress"

# Open bugs
atlcli jira search --type Bug --status Open

# Using JQL
atlcli jira search --jql "sprint in openSprints() AND assignee = currentUser()"
```

### Work with Issues

```bash
# Get issue details
atlcli jira get PROJ-123

# Add a comment
atlcli jira comment add PROJ-123 --body "Working on this"

# Transition status
atlcli jira transition PROJ-123 --status "In Progress"
```

### Track Time

```bash
# Start timer
atlcli jira worklog timer start PROJ-123

# Stop and log
atlcli jira worklog timer stop PROJ-123

# Log directly
atlcli jira worklog add PROJ-123 --time 2h
```

## Sections

- [Issues](issues.md) - CRUD, transitions, comments, links
- [Search](search.md) - JQL search and shortcuts
- [Boards & Sprints](boards-sprints.md) - Board and sprint management
- [Time Tracking](time-tracking.md) - Worklogs and timer mode
- [Epics](epics.md) - Epic management
- [Analytics](analytics.md) - Velocity, burndown, metrics
- [Bulk Operations](bulk-operations.md) - Batch issue changes
- [Filters](filters.md) - Saved JQL filters
- [Templates](templates.md) - Issue templates
- [Import/Export](import-export.md) - CSV and JSON
- [Webhooks](webhooks.md) - Webhook server
- [Fields](fields.md) - Custom fields, components, versions
