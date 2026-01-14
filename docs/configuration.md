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
