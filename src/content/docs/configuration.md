---
title: "Configuration"
description: "Configuration - atlcli documentation"
---

# Configuration

atlcli can be configured through config files, environment variables, and command-line flags.

## Config File

Global configuration is stored at `~/.atlcli/config.json`:

```json
{
  "defaultProfile": "work",
  "logging": {
    "level": "info",
    "file": "~/.atlcli/atlcli.log"
  },
  "plugins": {
    "enabled": ["git"],
    "path": "~/.atlcli/plugins"
  }
}
```

## Settings

### Default Profile

Set the default authentication profile:

```json
{
  "defaultProfile": "work"
}
```

Override with `--profile` flag or `ATLCLI_PROFILE` environment variable.

### Logging

Configure logging behavior:

```json
{
  "logging": {
    "level": "debug",
    "file": "/var/log/atlcli.log"
  }
}
```

| Option | Values | Default |
|--------|--------|---------|
| `level` | `debug`, `info`, `warn`, `error` | `info` |
| `file` | Path to log file | None (stdout only) |

### Plugins

Configure the plugin system:

```json
{
  "plugins": {
    "enabled": ["git", "custom-workflow"],
    "path": "~/.atlcli/plugins"
  }
}
```

See [Using Plugins](plugins/using-plugins.md) for details.

### Storage

Configure the sync database backend:

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

| Option | Values | Default |
|--------|--------|---------|
| `adapter` | `sqlite`, `json` | `sqlite` |
| `sqlite.enableVectors` | Enable vector search | `false` |

See [Storage](confluence/storage.md) for details.

### Sync

Configure sync behavior:

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

### Audit

Configure content audit defaults:

```json
{
  "audit": {
    "staleThresholds": {
      "high": 12,
      "medium": 6,
      "low": 3
    },
    "defaultChecks": [
      "stale",
      "orphans",
      "broken-links"
    ]
  }
}
```

| Option | Description | Default |
|--------|-------------|---------|
| `staleThresholds.high` | Months for high-risk stale | - |
| `staleThresholds.medium` | Months for medium-risk stale | - |
| `staleThresholds.low` | Months for low-risk stale | - |
| `defaultChecks` | Checks to run by default | `[]` |

Valid `defaultChecks` values: `stale`, `orphans`, `broken-links`, `single-contributor`, `inactive-contributors`, `external-links`

See [Audit](confluence/audit.md) for details.

### Projects

Register projects for cross-project operations:

```json
{
  "projects": [
    {
      "path": "/home/user/docs/.atlcli",
      "space": "DOCS",
      "label": "Documentation"
    },
    {
      "path": "/home/user/wiki/.atlcli",
      "space": "TEAM",
      "label": "Team Wiki"
    }
  ]
}
```

| Option | Description |
|--------|-------------|
| `path` | Path to project's `.atlcli` directory |
| `space` | Confluence space key |
| `project` | Jira project key (optional) |
| `label` | Display label (optional) |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ATLCLI_BASE_URL` | Atlassian instance URL |
| `ATLCLI_EMAIL` | Account email |
| `ATLCLI_API_TOKEN` | API token |
| `ATLCLI_PROFILE` | Default profile |
| `ATLCLI_LOG_LEVEL` | Logging level |
| `ATLCLI_CONFIG` | Path to config file |

Environment variables override config file settings.

## Project Configuration

For Confluence sync, project-specific config is stored in `.atlcli.json` within the synced directory:

```json
{
  "space": "TEAM",
  "rootPageId": "12345",
  "ignorePaths": ["drafts/**", "*.tmp"],
  "syncOptions": {
    "deleteOrphans": false,
    "preserveLocalChanges": true
  }
}
```

## Precedence

Settings are applied in this order (later overrides earlier):

1. Built-in defaults
2. Global config file (`~/.atlcli/config.json`)
3. Project config file (`.atlcli.json`)
4. Environment variables
5. Command-line flags

## Examples

### CI/CD Optimized Config

```json
{
  "logging": {
    "level": "warn"
  }
}
```

### Development Config

```json
{
  "logging": {
    "level": "debug",
    "file": "~/.atlcli/debug.log"
  },
  "defaultProfile": "dev"
}
```

## Related Topics

- [Authentication](authentication.md) - Profile and credential setup
- [Using Plugins](plugins/using-plugins.md) - Plugin configuration
- [Environment Variables](reference/environment.md) - Full environment variable reference
