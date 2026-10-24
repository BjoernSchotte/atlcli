---
title: "Environment Variables"
description: "Environment Variables - atlcli documentation"
---

# Environment Variables

Environment variables for configuring atlcli.

Every command runs against a **profile**. Environment variables do not replace one, with one exception: [`wiki export`](../confluence/export.md#profile-free-auth-for-ci) can build a temporary profile from them. Everywhere else, environment variables feed `atlcli auth login`, which creates the profile, and `ATLCLI_API_TOKEN` overrides the token a profile has stored.

## Authentication

| Variable | Read by | Effect |
|----------|---------|--------|
| `ATLCLI_API_TOKEN` | every command | Token for the active profile; wins over the macOS Keychain and the token stored in the profile. Also the default for `auth login --token` |
| `ATLCLI_SITE` | `auth login`, `auth init` | Default for `--site` |
| `ATLCLI_EMAIL` | `auth login`, `auth init`; `wiki export` without a profile | Default for `--email` |
| `ATLCLI_PROFILE` | every command | Profile to use when `--profile` is not given; overrides the current profile |
| `ATLCLI_BASE_URL`, `ATLCLI_AUTH_TYPE` | `wiki export` only | Profile-free export in CI; see [Profile-free auth](../confluence/export.md#profile-free-auth-for-ci) |

`ATLCLI_SITE` and `ATLCLI_EMAIL` have no effect on other commands. A command started without a profile fails with `No active profile found. Run atlcli auth login.`, whatever is set in the environment.

## Configuration

| Variable | Description |
|----------|-------------|
| `ATLCLI_CONFIG` | Path to the config file, instead of `~/.atlcli/config.json` |
| `ATLCLI_LOG_LEVEL` | Log level (`off`, `error`, `warn`, `info`, `debug`); overrides `logging.level` |
| `ATLCLI_MODELS_DIR` | Directory for optional local models (default `~/.atlcli/models`) |

## Usage

### Log in from the environment

Set the three variables, run `auth login` once, then use any command:

```bash
export ATLCLI_SITE="https://company.atlassian.net"
export ATLCLI_EMAIL="you@company.com"
export ATLCLI_API_TOKEN="your-api-token"

atlcli auth login
atlcli jira search --assignee me
```

`auth login` asks nothing when all values are present, so it also works without a terminal (CI, containers).

### Override the token of an existing profile

Keep the profile and supply the token per session, for example from a secret manager:

```bash
ATLCLI_API_TOKEN="$(op read op://work/atlassian/token)" atlcli jira search --assignee me
```

A stale `ATLCLI_API_TOKEN` overrides the stored token of **every** profile. It shows up as a 401 from whichever product the token cannot reach. `atlcli auth status --json` reports it as `hasEnvToken: true`.

### Pick a profile

```bash
ATLCLI_PROFILE=work atlcli jira search --assignee me
```

## Precedence

- **Profile:** `--profile` flag, else `ATLCLI_PROFILE`, else the current profile in the config file.
- **Token:** `ATLCLI_API_TOKEN`, else the macOS Keychain (Server/Data Center profiles logged in with `--username`), else the token stored in the profile.
- **Site and email:** always the profile's own values. `ATLCLI_SITE` and `ATLCLI_EMAIL` only matter when `auth login` creates or updates the profile, and there command-line flags win over them.

## CI/CD Examples

Each job logs in from secrets, then runs its commands. The login writes a profile to the runner's home directory, which is discarded with the runner.

### GitHub Actions

```yaml
- name: Search Jira
  env:
    ATLCLI_SITE: ${{ secrets.ATLASSIAN_URL }}
    ATLCLI_EMAIL: ${{ secrets.ATLASSIAN_EMAIL }}
    ATLCLI_API_TOKEN: ${{ secrets.ATLASSIAN_TOKEN }}
  run: |
    atlcli auth login
    atlcli jira search --jql "project = PROJ"
```

### GitLab CI

```yaml
jira-search:
  variables:
    ATLCLI_SITE: $ATLASSIAN_URL
    ATLCLI_EMAIL: $ATLASSIAN_EMAIL
    ATLCLI_API_TOKEN: $ATLASSIAN_TOKEN
  script:
    - atlcli auth login
    - atlcli jira search --jql "project = PROJ"
```

### Docker

```bash
docker run -e ATLCLI_SITE -e ATLCLI_EMAIL -e ATLCLI_API_TOKEN atlcli \
  sh -c 'atlcli auth login && atlcli jira search --assignee me'
```

## Troubleshooting

**`No active profile found. Run atlcli auth login.` although the variables are set.**
Only `auth login` reads `ATLCLI_SITE` and `ATLCLI_EMAIL`. Run it once in the same environment before the command.

**401 errors after switching profiles.**
`ATLCLI_API_TOKEN` is still set from another context and overrides the profile's token. `unset ATLCLI_API_TOKEN`, or check `atlcli auth status --json`.

## Related Topics

- [Authentication](../authentication.md) - Profiles, tokens and the Keychain
- [Configuration](../configuration.md) - Config file options
- [CI/CD Docs](../recipes/ci-cd-docs.md) - Publishing docs from CI/CD
- [Scripts in CI](../recipes/scripts-in-ci.md) - Automation scripts from CI/CD
