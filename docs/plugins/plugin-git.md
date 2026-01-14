# Git Plugin

Git integration for Confluence sync.

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
atlcli docs commit -m "Update API documentation"
```

This:
1. Stages all changes in the docs directory
2. Creates a Git commit
3. Pushes to Confluence

### Status

Show sync status with Git info:

```bash
atlcli docs status
```

Output includes:
- Local changes (Git status)
- Remote changes (Confluence modifications)
- Conflict markers

## Configuration

Configure in `~/.config/atlcli/config.json`:

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
atlcli docs pull ./docs
git status  # Check for remote changes

# 2. Edit locally
# ...

# 3. Commit and push
atlcli docs commit -m "Update user guide"
# This: stages, commits, pushes to Confluence

# 4. Push to Git remote
git push
```

### Branch-Based Docs

Work on docs in a branch:

```bash
git checkout -b docs/api-update
# Edit docs...
atlcli docs push ./docs
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
