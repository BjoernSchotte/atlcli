# Sync

Bidirectional synchronization between local markdown files and Confluence pages.

## Overview

atlcli provides powerful sync capabilities:

- **Pull**: Download Confluence pages as markdown
- **Push**: Upload local changes to Confluence
- **Watch**: Real-time synchronization
- **Conflict resolution**: Three-way merge with conflict detection

## Initialize

Set up a directory for sync:

```bash
atlcli wiki docs init ./docs --space TEAM
```

Options:

| Flag | Description |
|------|-------------|
| `--space` | Space key (required) |
| `--root-page` | Sync under specific page instead of space root |
| `--scope` | Sync scope: `space`, `tree`, `page` |

### Scope Options

```bash
# Sync entire space
atlcli wiki docs init ./docs --space TEAM --scope space

# Sync specific page tree
atlcli wiki docs init ./docs --space TEAM --root-page 12345 --scope tree

# Sync single page only
atlcli wiki docs init ./docs --space TEAM --root-page 12345 --scope page
```

## Pull

Download pages from Confluence to local markdown files:

```bash
atlcli wiki docs pull ./docs
```

Options:

| Flag | Description |
|------|-------------|
| `--space` | Filter by space key |
| `--page-id` | Pull specific page |
| `--version` | Pull specific version |
| `--label` | Filter by label |
| `--include` | Include only matching page titles |
| `--exclude` | Exclude matching page titles |
| `--include-comments` | Export comments to sidecar files |
| `--depth` | Maximum hierarchy depth |

### Examples

```bash
# Pull pages with specific label
atlcli wiki docs pull ./docs --label api-docs

# Pull specific page at version 3
atlcli wiki docs pull ./docs --page-id 12345 --version 3

# Pull with comments
atlcli wiki docs pull ./docs --include-comments

# Shallow pull (top-level pages only)
atlcli wiki docs pull ./docs --depth 1
```

## Push

Upload local changes to Confluence:

```bash
atlcli wiki docs push ./docs
```

Options:

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview changes without pushing |
| `--force` | Overwrite remote changes |
| `--message` | Version message for Confluence history |
| `--minor` | Mark as minor edit |
| `--auto-create` | Create pages for new local files |

### Examples

```bash
# Preview what would change
atlcli wiki docs push ./docs --dry-run

# Force push (overwrite remote)
atlcli wiki docs push ./docs --force

# Push with version message
atlcli wiki docs push ./docs --message "Updated API examples"

# Auto-create new pages
atlcli wiki docs push ./docs --auto-create
```

### Dry Run Output

```bash
atlcli wiki docs push ./docs --dry-run
```

```
Dry run - no changes will be made

Changes:
  UPDATE  api-reference.md → "API Reference" (12345)
  UPDATE  getting-started.md → "Getting Started" (12346)
  CREATE  new-guide.md → "New Guide" (new page)

Summary: 2 updates, 1 create, 0 deletes
```

## Watch Mode

Automatically sync changes in real-time using file watching and remote polling:

```bash
atlcli wiki docs sync ./docs --watch
```

Options:

| Flag | Description |
|------|-------------|
| `--watch` | Enable file watching |
| `--poll-interval` | Remote polling interval in ms (default: 30000) |
| `--no-poll` | Disable remote polling |
| `--debounce` | Debounce delay for local changes (default: 1000) |

### How Watch Mode Works

Watch mode combines two mechanisms:

1. **Local file watching**: Detects changes to local markdown files instantly
2. **Remote polling**: Periodically checks Confluence for remote changes

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Local Files │────▶│   atlcli    │◀────│ Confluence  │
│  (watched)  │     │  (sync)     │     │  (polled)   │
└─────────────┘     └─────────────┘     └─────────────┘
      │                    │                    │
      │  File changed      │                    │
      └───────────────────▶│                    │
                           │  Push to remote    │
                           │───────────────────▶│
                           │                    │
                           │  Poll for changes  │
                           │◀───────────────────│
                           │                    │
                           │  Pull if changed   │
      ◀────────────────────│                    │
```

### Polling Scopes

Polling efficiency depends on your sync scope:

| Scope | Checks | Best For |
|-------|--------|----------|
| `page` | Single page only | Editing one document |
| `tree` | Page and descendants | Working on a section |
| `space` | Entire space | Full documentation sync |

```bash
# Poll single page (most efficient)
atlcli wiki docs sync ./docs --watch --scope page --page-id 12345

# Poll page tree
atlcli wiki docs sync ./docs --watch --scope tree --root-page 12345

# Poll entire space (default)
atlcli wiki docs sync ./docs --watch
```

### Polling Events

The poller detects three types of changes:

| Event | Description |
|-------|-------------|
| `created` | New page added in scope |
| `changed` | Page content or title updated |
| `deleted` | Page removed from scope |

### Configuring Poll Interval

Adjust polling frequency based on your needs:

```bash
# Fast polling (every 10 seconds) - more API calls
atlcli wiki docs sync ./docs --watch --poll-interval 10000

# Slow polling (every 2 minutes) - fewer API calls
atlcli wiki docs sync ./docs --watch --poll-interval 120000

# Disable remote polling (local changes only)
atlcli wiki docs sync ./docs --watch --no-poll
```

**Note**: Lower intervals mean faster remote change detection but more API requests. The default (30 seconds) balances responsiveness with API usage.

### With Webhooks

For instant remote change detection without polling overhead, use webhooks:

```bash
atlcli wiki docs sync ./docs --watch \
  --webhook-port 8080 \
  --webhook-url https://your-server.com:8080/webhook
```

Options:

| Flag | Description |
|------|-------------|
| `--webhook-port` | Local webhook server port |
| `--webhook-url` | URL to register with Confluence |

**Webhooks vs Polling:**

| Feature | Polling | Webhooks |
|---------|---------|----------|
| Latency | 0-30s (configurable) | Instant |
| Setup | None | Requires public URL |
| API usage | Regular requests | On-demand only |
| Reliability | Always works | Requires connectivity |

For local development, use polling. For production servers with public URLs, webhooks provide better performance.

## Conflict Resolution

### Detection

atlcli detects conflicts when:
- Local file was modified since last sync
- Remote page was modified since last sync

```
Conflict detected: docs/api.md
  Local:  Modified 2025-01-14 10:30 (version 5 → local changes)
  Remote: Modified 2025-01-14 10:35 (version 5 → version 6)
```

### Resolution Strategies

Control how conflicts are handled:

```bash
atlcli wiki docs sync ./docs --on-conflict <strategy>
```

| Strategy | Behavior |
|----------|----------|
| `prompt` | Ask user for each conflict (default) |
| `merge` | Attempt three-way merge |
| `local` | Keep local version |
| `remote` | Keep remote version |

### Three-Way Merge

With `--on-conflict merge`, atlcli attempts automatic merging:

1. Uses the common ancestor (base) version
2. Computes diffs from both local and remote
3. Merges non-conflicting changes
4. Marks conflicting sections with markers

```markdown
<<<<<<< LOCAL
Your local changes here
=======
Remote changes here
>>>>>>> REMOTE
```

### Conflict Markers

When merge cannot auto-resolve, conflict markers are inserted:

```markdown
## API Reference

<<<<<<< LOCAL
This endpoint returns user data in JSON format.
=======
This endpoint returns user data. Response format is JSON.
>>>>>>> REMOTE

### Authentication
```

Resolve manually by editing the file, then push:

```bash
# Edit file to resolve conflicts
vim docs/api.md

# Push resolved version
atlcli wiki docs push ./docs
```

## Status

Check sync status:

```bash
atlcli wiki docs status ./docs
```

Output:

```
Space: TEAM
Root:  12345 (Documentation)
Scope: tree

Local changes:
  M  api-reference.md          Modified locally
  A  new-guide.md              New file (not on Confluence)

Remote changes:
  M  getting-started.md        Modified on Confluence

Conflicts:
  C  troubleshooting.md        Modified both locally and remotely

Summary: 2 local, 1 remote, 1 conflict
```

Options:

| Flag | Description |
|------|-------------|
| `--show-ignored` | Include ignored files |
| `--json` | JSON output |

## Directory Structure

After init and pull:

```
docs/
├── .atlcli/
│   ├── config.json         # Sync configuration
│   ├── state.json          # Sync state (versions, timestamps)
│   ├── .sync.lock          # Lock file for concurrent access
│   └── logs/               # Operation logs
├── getting-started.md
├── api-reference.md
├── guides/
│   ├── installation.md
│   └── configuration.md
└── .atlcliignore           # Ignore patterns
```

### State File

`.atlcli/state.json` tracks sync state:

```json
{
  "pages": {
    "12345": {
      "localPath": "api-reference.md",
      "remoteVersion": 5,
      "lastSyncHash": "abc123",
      "lastSyncTime": "2025-01-14T10:00:00Z"
    }
  }
}
```

### Lock File

`.atlcli/.sync.lock` prevents concurrent sync operations. It's automatically managed.

## File Format

Local files use YAML frontmatter:

```markdown
---
id: "12345"
title: "API Reference"
space: "TEAM"
parent: "12340"
labels:
  - api
  - reference
---

# API Reference

Content here...
```

See [File Format](file-format.md) for details.

## Advanced Options

### Label Filtering

Sync only pages with specific labels:

```bash
atlcli wiki docs init ./docs --space TEAM --label published
atlcli wiki docs pull ./docs --label published
```

### Hierarchy Handling

atlcli maps Confluence page hierarchy to directory structure:

```
Confluence:                    Local:
├── Parent Page               ├── parent-page.md
│   ├── Child A               ├── parent-page/
│   │   └── Grandchild        │   ├── child-a.md
│   └── Child B               │   ├── child-a/
                              │   │   └── grandchild.md
                              │   └── child-b.md
```

### Base Files

For three-way merge, atlcli stores base versions:

```
docs/
├── api-reference.md          # Current local
└── .atlcli/
    └── base/
        └── api-reference.md  # Base version for merge
```

## JSON Output

```bash
atlcli wiki docs status ./docs --json
```

```json
{
  "schemaVersion": "1",
  "space": "TEAM",
  "rootPageId": "12345",
  "scope": "tree",
  "local": [
    {"path": "api-reference.md", "status": "modified"}
  ],
  "remote": [
    {"path": "getting-started.md", "pageId": "12346", "status": "modified"}
  ],
  "conflicts": [
    {"path": "troubleshooting.md", "pageId": "12347"}
  ],
  "summary": {
    "localChanges": 2,
    "remoteChanges": 1,
    "conflicts": 1
  }
}
```

## Best Practices

1. **Pull before editing** - Always pull to get latest remote changes
2. **Use dry-run** - Preview push changes before committing
3. **Commit to Git** - Track markdown files in Git for version history
4. **Use labels** - Filter sync by labels for targeted updates
5. **Set up webhooks** - For faster real-time sync in watch mode

## Troubleshooting

### Lock File Issues

If sync fails due to lock:

```bash
# Check if another sync is running
atlcli wiki docs status ./docs

# Force remove stale lock (only if no sync is active)
rm ./docs/.atlcli/.sync.lock
```

### Merge Conflicts

If you get stuck in merge conflicts:

```bash
# Reset to remote version
atlcli wiki docs pull ./docs --force

# Or keep local version
atlcli wiki docs push ./docs --force
```

### Permission Errors

```
Error: You don't have permission to edit page 12345
```

Check your Confluence permissions for the space/page.
