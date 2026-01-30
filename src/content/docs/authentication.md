---
title: "Authentication"
description: "Manage API tokens and authentication profiles for Atlassian services"
---

# Authentication

atlcli supports authentication for both Atlassian Cloud and Server/Data Center installations, with multiple profiles for different instances.

## Quick Start

```bash
# Initialize credentials (interactive)
atlcli auth init

# Check current status
atlcli auth status

# List all profiles
atlcli auth list
```

## Cloud vs Server/Data Center

atlcli supports both Atlassian deployment types with different authentication methods:

| Deployment | Auth Method | Token Type |
|------------|-------------|------------|
| Cloud (`*.atlassian.net`) | Basic Auth | API Token |
| Server / Data Center | Bearer Auth | Personal Access Token (PAT) |

**Cloud** instances use your email address and an API token for authentication. This is the default mode.

**Server/Data Center** instances use Bearer authentication with a Personal Access Token (PAT). Use the `--bearer` flag when logging in.

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

Login with credentials provided via flags or environment.

#### Cloud (Default)

```bash
atlcli auth login --site https://company.atlassian.net --email you@company.com --token YOUR_TOKEN
atlcli auth login --profile work --site https://work.atlassian.net
```

#### Server/Data Center

Use the `--bearer` flag for PAT authentication:

```bash
# With token provided directly
atlcli auth login --bearer --site https://jira.company.com --token YOUR_PAT

# With keychain lookup (macOS)
atlcli auth login --bearer --site https://jira.company.com --username myuser
```

Options:

| Flag | Description |
|------|-------------|
| `--site` | Atlassian instance URL |
| `--email` | Account email (Cloud) |
| `--token` | API token (Cloud) or PAT (Server/DC) |
| `--bearer` | Use Bearer auth with PAT (for Server/DC) |
| `--username` | Username for keychain lookup (Server/DC) |
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

## Token Storage

### Config File

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

For Server/Data Center profiles using Bearer auth, the profile includes `authType: "bearer"` and may include a `username` for keychain lookup.

:::caution[Security]
Protect this file with appropriate permissions:
```bash
chmod 600 ~/.atlcli/credentials.json
```
:::

### Mac Keychain (macOS)

On macOS, you can store tokens securely in the system Keychain instead of the config file. When you provide a `--username` during login, atlcli stores the token in Keychain and looks it up automatically:

```bash
# Store token in Keychain during login
atlcli auth login --bearer --site https://jira.company.com --username myuser --token YOUR_PAT

# Token is now stored in Keychain - subsequent logins can use keychain lookup
atlcli auth login --bearer --site https://jira.company.com --username myuser
```

The token is stored with:
- **Service**: `atlcli`
- **Account**: Your username

### Token Resolution Priority

Tokens are resolved in this order (first found wins):

1. `ATLCLI_API_TOKEN` environment variable
2. Mac Keychain (if username is configured in profile)
3. Config file (`~/.atlcli/credentials.json`)

### Checking Token Source

Use `--json` to see where your token is coming from:

```bash
atlcli auth status --json
```

The output includes:
- `hasEnvToken`: Token is set via environment variable
- `hasKeychainToken`: Token is available from Keychain
- `hasPatInConfig`: Token is stored in config file

## Environment Variables

Override credentials with environment variables:

| Variable | Description |
|----------|-------------|
| `ATLCLI_SITE` | Atlassian instance URL |
| `ATLCLI_EMAIL` | Account email (Cloud) |
| `ATLCLI_API_TOKEN` | API token (Cloud) or PAT (Server/DC) |
| `ATLCLI_PROFILE` | Default profile name |

:::tip
`ATLCLI_API_TOKEN` works for both Cloud API tokens and Server/Data Center Personal Access Tokens. The authentication method is determined by the profile's `authType` setting.
:::

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

### Server/Data Center Auth Failures

```
Error: Authentication failed (401)
```

For Server/Data Center instances:

- Verify you used `--bearer` flag when logging in
- Check that your PAT hasn't expired (Server/DC PATs have expiration dates)
- Confirm the PAT has the required permissions in your Atlassian admin settings
- Ensure the instance URL is correct and accessible

To re-authenticate:

```bash
atlcli auth login --bearer --site https://jira.company.com --token YOUR_NEW_PAT
```

### Keychain Issues (macOS)

If Keychain lookup fails:

- Verify the token was stored: `security find-generic-password -s atlcli -a <username>`
- Re-store the token: `atlcli auth login --bearer --site <url> --username <user> --token <pat>`
- Check Keychain Access app for any access issues

## Related Topics

- [Getting Started](/getting-started/) - Initial setup and first commands
- [Configuration](/configuration/) - Config file options
- [Doctor](/reference/doctor/) - Diagnose authentication issues
