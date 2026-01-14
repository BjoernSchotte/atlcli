# Doctor

The `doctor` command diagnoses common issues with your atlcli setup, authentication, and connectivity.

## Quick Start

```bash
# Run all checks
atlcli doctor

# Auto-fix safe issues
atlcli doctor --fix

# JSON output for scripting
atlcli doctor --json
```

## What It Checks

| Check | Category | Description |
|-------|----------|-------------|
| Config exists | Config | Verifies `~/.atlcli/config.json` exists |
| Config valid | Config | Validates config file is proper JSON |
| Profile exists | Auth | At least one profile is configured |
| Active profile | Auth | Active profile has valid credentials |
| Confluence API | Connectivity | Tests Confluence authentication and latency |
| Jira API | Connectivity | Tests Jira authentication and latency |
| Log directory | Permissions | Verifies `~/.atlcli/logs/` is writable |

## Output

### Successful Run

```
atlcli doctor

  Config
    ✓ Config file exists
    ✓ Config file is valid JSON

  Authentication
    ✓ 1 profile(s) configured
    ✓ Active profile: work

  Connectivity
    ✓ Confluence API OK (245ms)
    ✓ Jira API OK (198ms)

  Permissions
    ✓ Log directory writable

  7 passed
```

### With Failures

```
atlcli doctor

  Config
    ✓ Config file exists
    ✓ Config file is valid JSON

  Authentication
    ✓ 1 profile(s) configured
    ✗ Active profile missing credentials
      → Run: atlcli auth login

  Connectivity
    ✗ Confluence auth failed
      → Run: atlcli auth login
    ✓ Jira API OK (198ms)

  Permissions
    ⚠ Log directory missing
      → Run: atlcli doctor --fix

  4 passed, 1 warning, 2 failed
```

## Options

### `--fix`

Automatically fix safe issues:

- Create missing config directory
- Create empty config file
- Create missing log directory

```bash
atlcli doctor --fix
```

Issues that require manual intervention (like invalid credentials) will still be reported but cannot be auto-fixed.

### `--json`

Output results as JSON for scripting and CI/CD integration:

```bash
atlcli doctor --json
```

Example output:

```json
{
  "schemaVersion": "1",
  "checks": [
    {
      "name": "config_exists",
      "category": "config",
      "status": "pass",
      "message": "Config file exists",
      "details": { "path": "~/.atlcli/config.json" }
    },
    {
      "name": "confluence_api",
      "category": "connectivity",
      "status": "pass",
      "message": "Confluence API OK (245ms)",
      "details": { "url": "https://acme.atlassian.net/wiki", "latencyMs": 245 }
    }
  ],
  "summary": {
    "passed": 7,
    "warnings": 0,
    "failed": 0
  }
}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All checks passed (or only warnings) |
| 1 | One or more checks failed |

Use exit codes in scripts:

```bash
if atlcli doctor --json > /dev/null 2>&1; then
  echo "atlcli is healthy"
else
  echo "atlcli has issues"
fi
```

## CI/CD Integration

Run doctor in your pipeline to verify atlcli is configured correctly:

```yaml
# GitHub Actions
- name: Check atlcli setup
  run: atlcli doctor --json
  continue-on-error: false
```

## Troubleshooting

### Config file missing

```
✗ Config file missing
  → Run: atlcli auth login
```

Run `atlcli auth login` to create a profile and config file.

### Credentials invalid

```
✗ Confluence auth failed
  → Run: atlcli auth login
```

Your API token may have expired or been revoked. Generate a new one at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) and run `atlcli auth login`.

### API slow (warning)

```
⚠ Confluence API slow (2500ms)
```

Response times over 2 seconds are flagged as warnings. This could indicate:
- Network latency
- Atlassian Cloud performance issues
- VPN or proxy overhead

### Log directory not writable

```
✗ Log directory not writable
  → Check permissions on ~/.atlcli/logs/
```

Fix permissions:

```bash
chmod 755 ~/.atlcli/logs/
```

Or let doctor create it:

```bash
atlcli doctor --fix
```
