# Authentication

atlcli uses Atlassian API tokens for authentication, supporting multiple profiles for different instances.

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
atlcli docs pull ./docs --profile client-acme
```

### List Profiles

```bash
atlcli auth list
```

### Delete a Profile

```bash
atlcli auth delete --profile old-profile
```

## Credential Storage

Credentials are stored at `~/.config/atlcli/credentials.json`:

```json
{
  "profiles": {
    "default": {
      "baseUrl": "https://company.atlassian.net",
      "email": "you@company.com",
      "apiToken": "ATATT3x..."
    },
    "personal": {
      "baseUrl": "https://personal.atlassian.net",
      "email": "you@gmail.com",
      "apiToken": "ATATT3x..."
    }
  }
}
```

!!! warning "Security"
    Protect this file with appropriate permissions:
    ```bash
    chmod 600 ~/.config/atlcli/credentials.json
    ```

## Environment Variables

Override credentials with environment variables:

| Variable | Description |
|----------|-------------|
| `ATLCLI_BASE_URL` | Atlassian instance URL |
| `ATLCLI_EMAIL` | Account email |
| `ATLCLI_API_TOKEN` | API token |
| `ATLCLI_PROFILE` | Default profile name |

Environment variables take precedence over config files:

```bash
export ATLCLI_BASE_URL="https://ci.atlassian.net"
export ATLCLI_EMAIL="ci@company.com"
export ATLCLI_API_TOKEN="$CI_ATLASSIAN_TOKEN"
atlcli jira search --jql "project = PROJ"
```

## CI/CD Usage

For CI/CD pipelines, use environment variables or secrets:

### GitHub Actions

```yaml
- name: Search Jira
  env:
    ATLCLI_BASE_URL: ${{ secrets.ATLASSIAN_URL }}
    ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
    ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
  run: atlcli jira search --jql "fixVersion = ${{ github.ref_name }}"
```

### GitLab CI

```yaml
jira-update:
  script:
    - atlcli jira transition $ISSUE_KEY --status Done
  variables:
    ATLCLI_BASE_URL: $ATLASSIAN_URL
    ATLCLI_EMAIL: $ATLASSIAN_EMAIL
    ATLCLI_API_TOKEN: $ATLASSIAN_TOKEN
```

## Troubleshooting

### Invalid Credentials

```
Error: Authentication failed (401)
```

- Verify your API token hasn't expired
- Check the instance URL includes `https://`
- Confirm email matches your Atlassian account

### Permission Denied

```
Error: You don't have permission (403)
```

- Check your account has access to the project/space
- For Jira, verify project permissions
- For Confluence, verify space permissions
