---
title: "Environment Variables"
description: "Environment Variables - atlcli documentation"
---

# Environment Variables

Environment variables for configuring atlcli.

## Authentication

| Variable | Description |
|----------|-------------|
| `ATLCLI_SITE` | Atlassian instance URL (e.g., `https://company.atlassian.net`) |
| `ATLCLI_EMAIL` | Account email |
| `ATLCLI_API_TOKEN` | API token |
| `ATLCLI_PROFILE` | Default profile name |

## Configuration

| Variable | Description |
|----------|-------------|
| `ATLCLI_CONFIG` | Path to config file |
| `ATLCLI_LOG_LEVEL` | Log level (debug, info, warn, error) |

## Usage

### Shell Export

```bash
export ATLCLI_SITE="https://company.atlassian.net"
export ATLCLI_EMAIL="you@company.com"
export ATLCLI_API_TOKEN="your-api-token"
```

### Inline

```bash
ATLCLI_PROFILE=work atlcli jira search --assignee me
```

### .env File

Create a `.env` file (don't commit to Git):

```
ATLCLI_SITE=https://company.atlassian.net
ATLCLI_EMAIL=you@company.com
ATLCLI_API_TOKEN=your-api-token
```

Load with:

```bash
source .env
atlcli jira search --assignee me
```

## Precedence

Environment variables override config file settings but are overridden by command-line flags:

1. Config file (`~/.atlcli/config.json`)
2. Environment variables
3. Command-line flags

## CI/CD Examples

### GitHub Actions

```yaml
env:
  ATLCLI_SITE: ${{ secrets.ATLASSIAN_URL }}
  ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
  ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
```

### GitLab CI

```yaml
variables:
  ATLCLI_SITE: $ATLASSIAN_URL
  ATLCLI_EMAIL: $ATLASSIAN_EMAIL
  ATLCLI_API_TOKEN: $ATLASSIAN_TOKEN
```

### Docker

```bash
docker run -e ATLCLI_SITE -e ATLCLI_EMAIL -e ATLCLI_API_TOKEN atlcli jira search
```

## Related Topics

- [Authentication](../authentication.md) - Profile-based authentication
- [Configuration](../configuration.md) - Config file options
- [CI/CD Docs](../recipes/ci-cd-docs.md) - Using environment variables in CI/CD
