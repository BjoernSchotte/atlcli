# Team Docs Sync

Keep team documentation in sync between local files and Confluence.

## Use Case

Your team maintains documentation in a Git repository. You want to:

- Write docs in markdown with your favorite editor
- Version control with Git
- Publish to Confluence for stakeholders

## Setup

### 1. Initialize Directory

```bash
atlcli docs init ./team-docs --space TEAM
```

### 2. Pull Existing Content

```bash
atlcli docs pull ./team-docs
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
atlcli docs pull ./team-docs

# Check for changes
git status

# Edit locally...

# Push changes to Confluence
atlcli docs push ./team-docs

# Commit to Git
git add .
git commit -m "Update API documentation"
```

### Conflict Resolution

When both local and Confluence have changes:

```bash
# Pull will warn about conflicts
atlcli docs pull ./team-docs

# Review changes
git diff

# Choose resolution:
# Option 1: Keep local changes
atlcli docs push ./team-docs --force

# Option 2: Accept remote changes
atlcli docs pull ./team-docs --force
```

## Automation

### Git Pre-commit Hook

Sync before committing:

```bash
#!/bin/bash
# .git/hooks/pre-commit
atlcli docs push ./team-docs --dry-run
if [ $? -ne 0 ]; then
  echo "Docs sync would fail. Check changes."
  exit 1
fi
```

### Watch Mode

Auto-sync during editing:

```bash
atlcli docs sync ./team-docs --watch
```

## Tips

- Use `.gitignore` to exclude generated files
- Keep images in `./team-docs/images/`
- Use frontmatter for page metadata
- Review `git diff` before pushing to Confluence
