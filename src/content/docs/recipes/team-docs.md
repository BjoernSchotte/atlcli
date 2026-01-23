---
title: "Team Docs Sync"
description: "Team Docs Sync - atlcli documentation"
---

# Team Docs Sync

Keep team documentation in sync between local files and Confluence.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Confluence permission**: View Space (pull), Edit Pages (push)
- Git installed for version control

## Use Case

Your team maintains documentation in a Git repository. You want to:

- Write docs in markdown with your favorite editor
- Version control with Git
- Publish to Confluence for stakeholders

## Setup

### 1. Initialize Directory

```bash
atlcli wiki docs init ./team-docs --space TEAM
```

### 2. Pull Existing Content

```bash
atlcli wiki docs pull ./team-docs
```

### 3. Add to Git

```bash
cd team-docs
git init
git add .
git commit -m "Initial docs sync"
```

## Workflow

### Daily Workflow

```bash
# Pull latest from Confluence
atlcli wiki docs pull ./team-docs

# Check for changes
git status

# Edit locally...

# Push changes to Confluence
atlcli wiki docs push ./team-docs

# Commit to Git
git add .
git commit -m "Update API documentation"
```

### Conflict Resolution

When both local and Confluence have changes:

```bash
# Pull will warn about conflicts
atlcli wiki docs pull ./team-docs

# Review changes
git diff

# Choose resolution:
# Option 1: Keep local changes
atlcli wiki docs push ./team-docs --force

# Option 2: Accept remote changes
atlcli wiki docs pull ./team-docs --force
```

## Automation

### Git Pre-commit Hook

Sync before committing:

```bash
#!/bin/bash
# .git/hooks/pre-commit
atlcli wiki docs push ./team-docs --dry-run
if [ $? -ne 0 ]; then
  echo "Docs sync would fail. Check changes."
  exit 1
fi
```

### Watch Mode

Auto-sync during editing:

```bash
atlcli wiki docs sync ./team-docs --watch
```

## Tips

- Use `.gitignore` to exclude generated files
- Keep images in `./team-docs/images/`
- Use frontmatter for page metadata
- Review `git diff` before pushing to Confluence

## Related Topics

- [Confluence Sync](../confluence/sync.md) - Full sync documentation
- [File Format](../confluence/file-format.md) - Frontmatter and markdown
- [CI/CD Docs](ci-cd-docs.md) - Automated publishing
