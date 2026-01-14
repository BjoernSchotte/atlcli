# Sync

Bidirectional synchronization between local files and Confluence pages.

## Commands

```bash
# Pull pages from Confluence
atlcli docs pull ./docs

# Push local changes to Confluence
atlcli docs push ./docs

# Watch mode - sync on file changes
atlcli docs sync ./docs --watch
```

## Pull

Download pages from Confluence to local markdown files:

```bash
atlcli docs pull ./docs
```

Options:

| Flag | Description |
|------|-------------|
| `--space` | Filter by space key |
| `--include` | Include only matching pages |
| `--exclude` | Exclude matching pages |

## Push

Upload local changes to Confluence:

```bash
atlcli docs push ./docs
```

Options:

| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would be pushed |
| `--force` | Overwrite remote changes |

## Conflict Detection

When both local and remote have changed, atlcli warns:

```
Conflict: docs/api.md was modified both locally and on Confluence
Use --force to overwrite, or pull first to merge
```

## Watch Mode

Automatically sync changes:

```bash
atlcli docs sync ./docs --watch
```

Changes are debounced and batched for efficiency.
