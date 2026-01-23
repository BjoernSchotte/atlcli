---
title: "Jira"
description: "Jira - atlcli documentation"
---

# Jira

atlcli provides full issue lifecycle management, search, sprints, and analytics from the command line.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects for read, Edit Issues for write operations

## Overview

```bash
# Search issues
atlcli jira search --assignee me --status "In Progress"

# View an issue
atlcli jira issue get --key PROJ-123

# Create an issue
atlcli jira issue create --project PROJ --type Task --summary "Fix bug"

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
atlcli jira issue get --key PROJ-123

# Add a comment
atlcli jira issue comment --key PROJ-123 --body "Working on this"

# Transition status
atlcli jira issue transition --key PROJ-123 --to "In Progress"
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

## Related Topics

- [Authentication](../authentication.md) - Set up profiles and API tokens
- [Configuration](../configuration.md) - Global and project configuration options
- [Confluence Integration](../confluence/index.md) - Link issues to Confluence pages
- [Recipes](../recipes/index.md) - Real-world workflows combining Jira and Confluence
