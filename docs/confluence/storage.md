# Storage & Sync Database

atlcli uses SQLite to store sync state, enabling advanced features like link tracking, contributor analysis, and content auditing.

::: toc

## Overview

When you sync pages with Confluence, atlcli stores metadata in a local SQLite database (`.atlcli/sync.db`). This enables:

- **Fast queries** - Instant lookups without parsing JSON
- **Link graph** - Track internal and external links between pages
- **Contributor tracking** - Know who edited each page
- **User status** - Track active/inactive Confluence users
- **Audit capabilities** - Analyze content health efficiently

## Automatic Migration

If you're upgrading from a previous version of atlcli that used `state.json`, your data is automatically migrated to SQLite.

### How Migration Works

1. On first sync operation after upgrade, atlcli detects `state.json`
2. Creates a backup at `state.json.bak`
3. Migrates all data to `sync.db`
4. Removes the original `state.json`

### What Gets Migrated

| Data | Source | Destination |
|------|--------|-------------|
| Page metadata | `state.json` pages | `pages` table |
| Attachments | `state.json` attachments | `attachments` table |
| Sync state | `state.json` syncState | Preserved per page |
| Last sync time | `state.json` lastSync | `sync_meta` table |

### Migration is Transparent

You don't need to do anything - migration happens automatically during normal operations. After migration:

```
.atlcli/
├── sync.db          # New SQLite database
├── state.json.bak   # Backup of original (safe to delete after verifying)
└── config.json      # Unchanged
```

## Backup & Recovery

### Automatic Backup

Before migration, atlcli creates `state.json.bak`. Keep this until you've verified everything works.

### Manual Backup

Back up the SQLite database:

```bash
cp .atlcli/sync.db .atlcli/sync.db.backup
```

### Recovery from Backup

If you need to revert to the old JSON format:

```bash
# Remove SQLite database
rm .atlcli/sync.db

# Restore JSON state
cp .atlcli/state.json.bak .atlcli/state.json
```

Then use an older version of atlcli, or wait for a fix if there's an issue.

## What's Stored

### Pages Table

Core page metadata synced from Confluence:

| Field | Description |
|-------|-------------|
| `pageId` | Confluence page ID |
| `path` | Local file path |
| `title` | Page title |
| `spaceKey` | Confluence space |
| `version` | Confluence version number |
| `syncState` | synced, local-modified, remote-modified, conflict |
| `lastModified` | When page was last edited in Confluence |
| `createdBy` | User ID who created the page |
| `lastModifiedBy` | User ID who last edited |
| `contentStatus` | current, draft, archived |
| `isRestricted` | Has view/edit restrictions |

### Links Table

Internal and external links extracted from pages:

| Field | Description |
|-------|-------------|
| `sourcePageId` | Page containing the link |
| `targetPageId` | Linked page (if internal) |
| `targetPath` | Link URL or path |
| `linkType` | internal, external, attachment |
| `isBroken` | Whether target exists |
| `lineNumber` | Line number in markdown |

### Users Table

Confluence user information:

| Field | Description |
|-------|-------------|
| `userId` | Confluence account ID |
| `displayName` | User's display name |
| `email` | User's email (if available) |
| `isActive` | Whether user account is active |
| `lastCheckedAt` | When status was last verified |

### Contributors Table

Page authorship tracking:

| Field | Description |
|-------|-------------|
| `pageId` | Page ID |
| `userId` | Contributor's user ID |
| `contributionType` | creator, editor |

## Configuration

Configure storage in `~/.atlcli/config.json`:

```json
{
  "storage": {
    "adapter": "sqlite",
    "sqlite": {
      "enableVectors": false
    }
  }
}
```

| Option | Description | Default |
|--------|-------------|---------|
| `adapter` | Storage backend: `sqlite`, `json` | `sqlite` |
| `sqlite.enableVectors` | Enable vector search (experimental) | `false` |

## Sync Behavior

Configure sync-related settings:

```json
{
  "sync": {
    "userStatusTtlDays": 7,
    "skipUserStatusCheck": false,
    "postPullAuditSummary": false
  }
}
```

| Option | Description | Default |
|--------|-------------|---------|
| `userStatusTtlDays` | Days before re-checking user status | `7` |
| `skipUserStatusCheck` | Skip user status updates during pull | `false` |
| `postPullAuditSummary` | Show audit summary after pull | `false` |

## Database Location

atlcli stores the sync database at:

```
<project>/.atlcli/sync.db
```

This file should be:
- **Not committed to git** (add `.atlcli/` to `.gitignore`)
- **Backed up** if you have local-only changes
- **Recreatable** by running `atlcli wiki docs pull`

## Advanced Usage

### Inspecting the Database

You can query the database directly with SQLite tools:

```bash
sqlite3 .atlcli/sync.db "SELECT title, syncState FROM pages"
```

### Rebuilding from Scratch

If the database becomes corrupted:

```bash
# Remove database
rm .atlcli/sync.db

# Re-sync from Confluence
atlcli wiki docs pull
```

### Link Graph Rebuild

Re-extract links from local markdown files:

```bash
atlcli audit wiki --rebuild-graph
```

## Future: PostgreSQL Support

For team environments, PostgreSQL support is planned:

```json
{
  "storage": {
    "adapter": "postgres",
    "postgres": {
      "connectionString": "postgresql://user:pass@host/db",
      "schema": "atlcli"
    }
  }
}
```

This will enable:
- Shared sync state across team members
- Centralized audit dashboards
- Server-side link validation

## Related Topics

- [Audit](audit.md) - Content health auditing
- [Sync](sync.md) - Syncing pages with Confluence
- [Configuration](../configuration.md) - Global config options
