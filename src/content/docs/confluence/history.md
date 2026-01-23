---
title: "Page History"
description: "Page History - atlcli documentation"
---

# Page History

View version history, compare changes, and restore previous versions.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Space permission**: View to see history, Edit to restore versions

## Overview

Confluence tracks every edit as a version. atlcli provides:

- Version history listing
- Content comparison (diff)
- Version restoration

## View History

List all versions of a page:

```bash
atlcli wiki page history 12345
```

Output:

```
VERSION   AUTHOR              DATE                  MESSAGE
5         Alice               2025-01-14 10:30      Updated API examples
4         Bob                 2025-01-13 15:45      Fixed typos
3         Alice               2025-01-12 09:00      Added authentication section
2         Alice               2025-01-10 14:20      Initial draft
1         Alice               2025-01-10 14:00      Created page
```

Options:

| Flag | Description |
|------|-------------|
| `--limit` | Number of versions to show |
| `--json` | JSON output |

## View Specific Version

Get content at a specific version:

```bash
# View version 3
atlcli wiki page get 12345 --version 3

# Save to file
atlcli wiki page get 12345 --version 3 > old-version.md
```

## Compare Versions (Diff)

### Compare with Current

```bash
# Compare version 3 with current
atlcli wiki page diff 12345 --version 3
```

Output:

```diff
--- Version 3 (2025-01-12)
+++ Current (Version 5)
@@ -10,6 +10,10 @@
 ## Authentication

 Use API tokens for authentication.
+
+### Token Scopes
+
+Tokens can have limited scopes for security.
```

### Compare Two Versions

```bash
atlcli wiki page diff 12345 --from 2 --to 4
```

### Diff Options

| Flag | Description |
|------|-------------|
| `--version` | Compare this version with current |
| `--from` | Start version for comparison |
| `--to` | End version for comparison |
| `--context` | Lines of context (default: 3) |
| `--no-color` | Disable colored output |

## Restore Version

Restore a page to a previous version:

```bash
atlcli wiki page restore 12345 --version 3
```

Options:

| Flag | Description |
|------|-------------|
| `--version` | Version number to restore |
| `--message` | Restore commit message |
| `--confirm` | Skip confirmation prompt |

:::caution[Restoration Creates New Version]
When you restore, atlcli creates a new version (e.g., v6) with the old content. atlcli preserves the full history.

:::

### Restore with Message

```bash
atlcli wiki page restore 12345 --version 3 --message "Reverting breaking changes" --confirm
```

## JSON Output

```bash
atlcli wiki page history 12345 --json
```

```json
{
  "schemaVersion": "1",
  "pageId": "12345",
  "title": "API Reference",
  "versions": [
    {
      "number": 5,
      "author": {
        "displayName": "Alice",
        "email": "alice@company.com"
      },
      "created": "2025-01-14T10:30:00Z",
      "message": "Updated API examples",
      "minorEdit": false
    },
    {
      "number": 4,
      "author": {
        "displayName": "Bob",
        "email": "bob@company.com"
      },
      "created": "2025-01-13T15:45:00Z",
      "message": "Fixed typos",
      "minorEdit": true
    }
  ],
  "total": 5
}
```

## Sync Integration

### Pull Specific Version

```bash
# Pull a page at a specific version
atlcli wiki docs pull ./docs --page-id 12345 --version 3
```

### Version in Frontmatter

atlcli tracks the current version in frontmatter:

```markdown
---
atlcli:
  id: "12345"
  title: "API Reference"
  version: 5
  lastModified: "2025-01-14T10:30:00Z"
---
```

## Use Cases

### Audit Trail

```bash
# See who changed what
atlcli wiki page history 12345 --json | \
  jq '.versions[] | "\(.created): \(.author.displayName) - \(.message)"'
```

### Recover Deleted Content

```bash
# Find when content was removed
atlcli wiki page diff 12345 --from 1 --to 5 | grep "^-"

# Restore if needed
atlcli wiki page restore 12345 --version 3
```

### Review Changes Before Merge

```bash
# See what changed in latest version
atlcli wiki page diff 12345 --version $(atlcli wiki page history 12345 --json | jq '.versions[1].number')
```

### Batch History Export

```bash
# Export history for all pages in space
for id in $(atlcli wiki page list --space TEAM --json | jq -r '.pages[].id'); do
  atlcli wiki page history $id --json > "history-$id.json"
done
```

## Related Topics

- [Pages](pages.md) - Page operations
- [Sync](sync.md) - Version tracking in frontmatter
- [Audit](audit.md) - Analyze contributor history
