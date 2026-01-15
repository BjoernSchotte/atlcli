# Updating atlcli

atlcli includes a built-in update mechanism that checks for new versions and can self-update.

## Quick Update

```bash
# Check for and install updates
atlcli update

# Check only (don't install)
atlcli update --check

# Install specific version
atlcli update v0.5.0
```

## Automatic Update Checks

By default, atlcli checks for updates once per day when running commands in an interactive terminal. If an update is available, you'll see a notification:

```
Update available: 0.5.1 → 0.6.0. Run: atlcli update
```

### When Auto-Check is Disabled

Auto-check is automatically disabled in these environments:

| Environment | Reason |
|-------------|--------|
| CI/CD pipelines | Avoid unnecessary API calls, keep logs clean |
| Non-interactive shells | Piped output, cron jobs, scripts |
| JSON output mode | Scripting mode (`--json` flag) |
| Explicit opt-out | `ATLCLI_DISABLE_UPDATE_CHECK=1` |

The `atlcli update` command itself always works regardless of environment.

### Disable Auto-Check

Set the environment variable:

```bash
export ATLCLI_DISABLE_UPDATE_CHECK=1
```

## Installation Method Detection

atlcli automatically detects how it was installed and provides appropriate update instructions:

### Install Script (curl)

Self-update is fully supported:

```bash
atlcli update  # Downloads and installs new version
```

### Homebrew

Shows Homebrew update instructions:

```bash
$ atlcli update
Update available: 0.5.1 → 0.6.0

Installed via Homebrew. To update, run:
  brew update && brew upgrade atlcli
```

### From Source

Shows source update instructions:

```bash
$ atlcli update
atlcli 0.5.1 is up to date.

Running from source. To update, run:
  git pull && bun run build
```

## Version Pinning

Install a specific version (useful for testing or rollback):

```bash
# Install specific version
atlcli update v0.5.0

# Or reinstall via install script
curl -fsSL https://atlcli.sh/install.sh | bash -s v0.5.0
```

## JSON Output

For scripting, use `--json`:

```bash
atlcli update --check --json
```

Output:

```json
{
  "schemaVersion": "1",
  "currentVersion": "0.5.1",
  "latestVersion": "0.6.0",
  "updateAvailable": true,
  "installMethod": "script"
}
```

## Security

Updates are downloaded from GitHub Releases and verified:

1. **HTTPS only** - All downloads use HTTPS
2. **Checksum verification** - SHA256 checksums verified before installation
3. **Backup** - Previous version backed up to `~/.atlcli/bin/atlcli.bak`
4. **Atomic replacement** - New binary verified before replacing old

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ATLCLI_DISABLE_UPDATE_CHECK` | Set to `1` to disable automatic update checks |

## Troubleshooting

### Update check fails

If update checks fail silently, verify network connectivity:

```bash
curl -fsSL https://api.github.com/repos/BjoernSchotte/atlcli/releases/latest
```

### Cannot self-update

If you see "Cannot determine installation method", reinstall using the install script:

```bash
curl -fsSL https://atlcli.sh/install.sh | bash
```

### Rollback after failed update

The previous version is saved at `~/.atlcli/bin/atlcli.bak`:

```bash
mv ~/.atlcli/bin/atlcli.bak ~/.atlcli/bin/atlcli
```
