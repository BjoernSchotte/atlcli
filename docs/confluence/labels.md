# Labels

Add, remove, and manage labels on Confluence pages.

## Overview

Labels help organize and categorize pages. Use them for:

- Content categorization (e.g., `api`, `tutorial`, `reference`)
- Review status (e.g., `needs-review`, `approved`)
- Team ownership (e.g., `team-backend`, `team-frontend`)

## List Labels

View labels on a page:

```bash
atlcli wiki page label list --id 12345
```

Output:

```
api
documentation
v2
```

## Add Labels

Add one or more labels (labels are positional arguments):

```bash
# Single label
atlcli wiki page label add api --id 12345

# Multiple labels
atlcli wiki page label add api documentation v2 --id 12345
```

## Remove Labels

```bash
atlcli wiki page label remove deprecated --id 12345
```

## Bulk Label Operations

Add or remove labels from multiple pages using CQL:

```bash
# Add label to pages matching CQL (preview first)
atlcli wiki page label add archived --cql "space=OLD" --dry-run

# Add label (requires --confirm)
atlcli wiki page label add archived --cql "space=OLD" --confirm

# Remove label from pages matching CQL
atlcli wiki page label remove draft --cql "label=draft AND space=DEV" --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Page ID for single-page operations |
| `--cql` | CQL query for bulk operations |
| `--dry-run` | Preview what would be affected |
| `--confirm` | Required for bulk operations |

## Find Pages by Label

Search for pages with specific labels:

```bash
# All pages with label
atlcli wiki search --label api

# In specific space
atlcli wiki search --label api --space TEAM

# Multiple labels (AND)
atlcli wiki search --label "api,v2"
```

## Sync Behavior

Labels are synced as part of page metadata:

### In Frontmatter

```markdown
---
atlcli:
  id: "12345"
  title: "API Reference"
  labels:
    - api
    - documentation
    - v2
---

# API Reference
...
```

### During Pull

Labels are included in frontmatter when pulling:

```bash
atlcli wiki docs pull ./docs
```

### During Push

Labels from frontmatter are synced to Confluence:

```bash
atlcli wiki docs push ./docs
```

!!! note "Label Changes"
    Removing a label from frontmatter will remove it from Confluence on push.

## JSON Output

```bash
atlcli wiki page label list --id 12345 --json
```

```json
{
  "schemaVersion": "1",
  "pageId": "12345",
  "labels": [
    {"name": "api", "prefix": "global"},
    {"name": "documentation", "prefix": "global"},
    {"name": "v2", "prefix": "global"}
  ],
  "total": 3
}
```

## Label Naming

- Labels are case-insensitive (`API` = `api`)
- Use hyphens for multi-word labels (`api-reference`)
- Avoid spaces (use hyphens instead)
- Maximum 255 characters

## Use Cases

### Content Lifecycle

```bash
# Mark for review
atlcli wiki page label add needs-review --id 12345

# After review
atlcli wiki page label remove needs-review --id 12345
atlcli wiki page label add approved --id 12345
```

### Team Organization

```bash
# Assign ownership
atlcli wiki page label add team-backend component-api --id 12345

# Find team's pages
atlcli wiki search --label team-backend --space DOCS
```

### Version Tracking

```bash
# Mark version-specific docs
atlcli wiki page label add v2.0 --id 12345

# Find all v2 docs
atlcli wiki search --label "v2.0"
```
