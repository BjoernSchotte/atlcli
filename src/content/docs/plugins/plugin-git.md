---
title: "Git Plugin"
description: "Git Plugin - atlcli documentation"
---

# Git Plugin

Git integration for Confluence sync.

## Prerequisites

- atlcli installed and configured
- Git repository initialized
- Git plugin enabled (`atlcli plugin enable git`)

## Overview

The Git plugin connects a docs directory that is also a Git repository with Confluence sync. It does two things:

- **Commit after pull:** after every `atlcli wiki docs pull`, it commits the files the pull changed, with a message like `sync(confluence): pull 3 page(s) from Confluence`.
- **Push after commit:** `atlcli git hook install` adds a Git `post-commit` hook that runs `atlcli wiki docs push` for the directory after each of your commits.

The plugin has no settings, and it adds no `wiki docs` subcommand: you commit with Git as usual.

## Installation

The Git plugin is bundled with atlcli and disabled by default:

```bash
atlcli plugin enable git
```

## Commands

| Command | What it does |
|---------|--------------|
| `atlcli git hook install [dir] [--force]` | Install the `post-commit` hook in the repository of `dir` (default: current directory). `--force` replaces an existing hook that atlcli did not write |
| `atlcli git hook status [dir]` | Show whether the hook is installed |
| `atlcli git hook remove [dir]` | Remove the hook |

The commit after pull needs no command; it runs whenever the plugin is enabled and the docs directory is inside a Git repository.

## The post-commit hook

After each commit, the hook pushes the docs directory to Confluence. It never blocks a commit:

- It skips the push while `atlcli wiki docs sync` runs (the daemon pushes itself).
- It skips directories without `.atlcli/`.
- A failed push prints `[atlcli-git] Push failed (non-blocking)`; the commit stays. Push refuses pages that changed in Confluence since your last pull, so run `atlcli wiki docs pull` or `sync` and commit again.

## Workflow

### Recommended Flow

```bash
# One-time setup
atlcli plugin enable git
atlcli git hook install ./docs

# 1. Pull latest; the plugin commits what changed
atlcli wiki docs pull ./docs

# 2. Edit locally
# ...

# 3. Commit; the hook pushes to Confluence
git add docs && git commit -m "Update user guide"

# 4. Push to the Git remote
git push
```

### Branch-Based Docs

Work on docs in a branch, and push to Confluence only from the branch you publish:

```bash
atlcli git hook remove ./docs     # no automatic push while on the branch
git checkout -b docs/api-update
# Edit docs...
git add . && git commit -m "API updates"
git push -u origin docs/api-update
# After review and merge on main:
git checkout main && git pull
atlcli wiki docs push ./docs
```

## Related Topics

- [Using Plugins](using-plugins.md) - Plugin management
- [Creating Plugins](creating-plugins.md) - Build custom plugins
- [Sync Workflow](../confluence/sync.md) - Confluence sync operations
