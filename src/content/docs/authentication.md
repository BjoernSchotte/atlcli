---
title: "Authentication"
description: "Manage API tokens and authentication profiles for Atlassian services"
---

# Authentication

atlcli uses Atlassian API tokens for authentication, supporting multiple profiles for different instances.

## Quick Start

```bash
# Initialize credentials (interactive)
atlcli auth init

# Check current status
atlcli auth status

# List all profiles
atlcli auth list
```

## API Tokens

### Creating a Token

1. Visit [Atlassian Account Settings](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Enter a label (e.g., "atlcli")
4. Copy the generated token immediately (it won't be shown again)

### Token Permissions

API tokens inherit your account permissions. For atlcli to work fully, your account needs:

- **Confluence**: Space admin or contributor permissions
- **Jira**: Project access for issues you want to manage

## Auth Commands

### Initialize (Interactive)

Interactive setup that prompts for all credentials:

```bash
atlcli auth init
atlcli auth init --profile work
```

### Login (Non-Interactive)

Login with credentials provided via flags or environment:

```bash
atlcli auth login --site https://company.atlassian.net --email you@company.com --token YOUR_TOKEN
atlcli auth login --profile work --site https://work.atlassian.net
```

Options:

| Flag | Description |
|------|-------------|
| `--site` | Atlassian instance URL |
| `--email` | Account email |
| `--token` | API token |
| `--profile` | Profile name to create/update |

### Status

Check current authentication status:

```bash
atlcli auth status
```

Output:

```
Profile: work (active)
Site:    https://company.atlassian.net
Email:   you@company.com
Status:  Authenticated ✓
```

### List Profiles

```bash
atlcli auth list
```

Output:

```
PROFILE     SITE                              EMAIL              ACTIVE
default     https://company.atlassian.net     you@company.com
work        https://work.atlassian.net        work@company.com   ✓
personal    https://personal.atlassian.net    me@gmail.com
```

### Switch Profile

Change the active profile:

```bash
atlcli auth switch work
atlcli auth switch personal
```

### Rename Profile

```bash
atlcli auth rename old-name new-name
```

### Logout

Clear credentials but keep the profile (for easy re-login):

```bash
atlcli auth logout
atlcli auth logout work
```

### Delete Profile

Remove a profile entirely:

```bash
atlcli auth delete old-profile
atlcli auth delete --profile staging --confirm
```

## Profiles

### Default Profile

Initialize the default profile:

```bash
atlcli auth init
```

Enter your instance URL, email, and API token when prompted.

### Named Profiles

Create profiles for multiple instances:

```bash
atlcli auth init --profile work
atlcli auth init --profile personal
atlcli auth init --profile client-acme
```

Use a profile with any command:

```bash
atlcli jira search --assignee me --profile work
atlcli wiki docs pull ./docs --profile client-acme
```

### Per-Command Override

```bash
# Use specific profile for one command
atlcli wiki page list --space TEAM --profile work
```

## Credential Storage

Credentials are stored at `~/.atlcli/credentials.json`:

```json
{
  "currentProfile": "work",
  "profiles": {
    "default": {
      "name": "default",
      "baseUrl": "https://company.atlassian.net",
      "email": "you@company.com",
      "apiToken": "ATATT3x..."
    },
    "work": {
      "name": "work",
      "baseUrl": "https://work.atlassian.net",
      "email": "work@company.com",
      "apiToken": "ATATT3x..."
    }
  }
}
```

:::caution[Security]
Protect this file with appropriate permissions:
```bash
chmod 600 ~/.atlcli/credentials.json
```
:::

## Environment Variables

Override credentials with environment variables:

| Variable | Description |
|----------|-------------|
| `ATLCLI_SITE` | Atlassian instance URL |
| `ATLCLI_EMAIL` | Account email |
| `ATLCLI_API_TOKEN` | API token |
| `ATLCLI_PROFILE` | Default profile name |

Environment variables take precedence over config files:

```bash
export ATLCLI_SITE="https://ci.atlassian.net"
export ATLCLI_EMAIL="ci@company.com"
export ATLCLI_API_TOKEN="$CI_ATLASSIAN_TOKEN"
atlcli jira search --jql "project = PROJ"
```

## Precedence

Credentials are resolved in this order (later wins):

1. Default profile in config
2. `ATLCLI_PROFILE` environment variable
3. `ATLCLI_SITE` / `ATLCLI_EMAIL` / `ATLCLI_API_TOKEN` env vars
4. `--profile` command flag

## CI/CD Usage

For CI/CD pipelines, use environment variables or secrets:

### GitHub Actions

```yaml
- name: Search Jira
  env:
    ATLCLI_SITE: ${{ secrets.ATLASSIAN_URL }}
    ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
    ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
  run: atlcli jira search --jql "fixVersion = ${{ github.ref_name }}"
```

### GitLab CI

```yaml
jira-update:
  script:
    - atlcli jira issue transition --key $ISSUE_KEY --to Done
  variables:
    ATLCLI_SITE: $ATLASSIAN_URL
    ATLCLI_EMAIL: $ATLASSIAN_EMAIL
    ATLCLI_API_TOKEN: $ATLASSIAN_TOKEN
```

### Jenkins

```groovy
environment {
    ATLCLI_SITE = credentials('atlassian-url')
    ATLCLI_EMAIL = credentials('atlassian-email')
    ATLCLI_API_TOKEN = credentials('atlassian-token')
}
```

### Docker

```bash
docker run -e ATLCLI_SITE -e ATLCLI_EMAIL -e ATLCLI_API_TOKEN atlcli jira search
```

## Troubleshooting

### Invalid Credentials

```
Error: Authentication failed (401)
```

- Verify your API token hasn't expired
- Check the instance URL includes `https://`
- Confirm email matches your Atlassian account
- Re-initialize: `atlcli auth init`

### Permission Denied

```
Error: You don't have permission (403)
```

- Check your account has access to the project/space
- For Jira, verify project permissions
- For Confluence, verify space permissions

### Wrong Profile

```bash
# Check which profile is active
atlcli auth status

# Switch if needed
atlcli auth switch correct-profile
```

### Token Expired

Atlassian API tokens can expire. Regenerate and update:

```bash
# Generate new token at https://id.atlassian.com/manage-profile/security/api-tokens
# Then update
atlcli auth init --profile work
```

## Related Topics

- [Getting Started](/getting-started/) - Initial setup and first commands
- [Configuration](/configuration/) - Config file options
- [Doctor](/reference/doctor/) - Diagnose authentication issues
