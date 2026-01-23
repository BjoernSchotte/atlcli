# Git Plugin

Git integration for Confluence sync.

::: toc

## Prerequisites

- atlcli installed and configured
- Git repository initialized
- Git plugin enabled (`atlcli plugin enable git`)

## Overview

The Git plugin adds Git-aware features to Confluence sync:

- Commit messages on push
- Branch-based sync
- Conflict detection using Git status

## Installation

The Git plugin is bundled with atlcli:

```bash
atlcli plugin enable git
```

## Commands

### Commit

Commit synced docs with a message:

```bash
atlcli wiki docs commit -m "Update API documentation"
```

This:
1. Stages all changes in the docs directory
2. Creates a Git commit
3. Pushes to Confluence

### Status

Show sync status with Git info:

```bash
atlcli wiki docs status
```

Output includes:
- Local changes (Git status)
- Remote changes (Confluence modifications)
- Conflict markers

## Configuration

Configure in `~/.atlcli/config.json`:

```json
{
  "plugins": {
    "git": {
      "autoCommit": false,
      "commitPrefix": "[docs] ",
      "branch": "main"
    }
  }
}
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `autoCommit` | Auto-commit after push | `false` |
| `commitPrefix` | Prefix for commit messages | `""` |
| `branch` | Branch for sync operations | `main` |

## Workflow

### Recommended Flow

```bash
# 1. Pull latest
atlcli wiki docs pull ./docs
git status  # Check for remote changes

# 2. Edit locally
# ...

# 3. Commit and push
atlcli wiki docs commit -m "Update user guide"
# This: stages, commits, pushes to Confluence

# 4. Push to Git remote
git push
```

### Branch-Based Docs

Work on docs in a branch:

```bash
git checkout -b docs/api-update
# Edit docs...
atlcli wiki docs push ./docs
git add . && git commit -m "API updates"
git push -u origin docs/api-update
# Create PR
```

## Hooks

The Git plugin adds hooks:

- **pre-push**: Checks for uncommitted changes
- **post-pull**: Shows Git status after pull

Disable hooks:

```json
{
  "plugins": {
    "git": {
      "hooks": false
    }
  }
}
```

## Related Topics

- [Using Plugins](using-plugins.md) - Plugin management
- [Creating Plugins](creating-plugins.md) - Build custom plugins
- [Sync Workflow](../confluence/sync.md) - Confluence sync operations
