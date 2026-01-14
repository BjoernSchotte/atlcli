# Environment Variables

Environment variables for configuring atlcli.

## Authentication

| Variable | Description |
|----------|-------------|
| `ATLCLI_BASE_URL` | Atlassian instance URL |
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
export ATLCLI_BASE_URL="https://company.atlassian.net"
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
ATLCLI_BASE_URL=https://company.atlassian.net
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

1. Config file (`~/.config/atlcli/config.json`)
2. Environment variables
3. Command-line flags

## CI/CD Examples

### GitHub Actions

```yaml
env:
  ATLCLI_BASE_URL: ${{ secrets.ATLASSIAN_URL }}
  ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
  ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
```

### GitLab CI

```yaml
variables:
  ATLCLI_BASE_URL: $ATLASSIAN_URL
  ATLCLI_EMAIL: $ATLASSIAN_EMAIL
  ATLCLI_API_TOKEN: $ATLASSIAN_TOKEN
```

### Docker

```bash
docker run -e ATLCLI_BASE_URL -e ATLCLI_EMAIL -e ATLCLI_API_TOKEN atlcli jira search
```
