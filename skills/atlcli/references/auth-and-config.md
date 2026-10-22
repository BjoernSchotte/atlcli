---
name: auth-and-config
description: Profiles, credential resolution, config defaults, feature flags, logs, updates, and diagnostics.
metadata:
  tags: auth, profiles, config, doctor, logging, keychain, update
---

# Authentication, profiles, and configuration

The environment is already authenticated. This file is for reading the current
state, targeting the right site, and recognising credential failures, not for
setting up a new profile.

## Contents

- [Inspecting the current state](#inspecting-the-current-state)
- [Credential resolution](#credential-resolution)
- [Defaults that change command behaviour](#defaults-that-change-command-behaviour)
- [Feature flags](#feature-flags)
- [Logs](#logs)
- [Doctor](#doctor)
- [Updates and version](#updates-and-version)
- [Anti-patterns](#anti-patterns)

## Inspecting the current state

```bash
atlcli auth status --json    # active profile, site, auth type, token sources
atlcli auth list --json      # all profiles, which one is active
atlcli config list --json    # defaults for project / space / board, logging
atlcli doctor --json         # config, credentials, Confluence + Jira reachability
```

`auth status` returns the site and where a token can come from. For a Cloud
profile (`authType` `apiToken`):

```json
{
  "profile": "example-atlassian-net",
  "site": "https://example.atlassian.net",
  "authType": "apiToken",
  "deploymentType": "cloud",
  "email": "user@example.com",
  "hasTokenInConfig": true,
  "hasEnvToken": false
}
```

A Server/Data Center profile (`authType` `bearer`) reports `username`,
`hasPatInConfig`, `hasKeychainToken` (macOS only, and only when a username is
set) and `hasEnvToken` instead. `tlsCaFile` and `tlsSkipVerify` appear when the
profile sets them. A profile of type `session` is rejected with `auth type
"session" is only supported in browser contexts` by the commands that talk to
Jira or Confluence (`wiki publish` skips that check); `config`, `auth status`,
`flag` and `log` still work.

Target a different site per command with `--profile <name>`; it is a global
flag and works on every command. The only other way to pick a profile is
`atlcli auth switch <name>`, which changes the stored active profile and is a
user decision. The environment variables `ATLCLI_PROFILE`, `ATLCLI_CONFIG` and
`ATLCLI_LOG_LEVEL` that the documentation site lists are not read by the
source; use `--profile` and `atlcli config`.

## Credential resolution

Priority, highest first:

1. `ATLCLI_API_TOKEN` environment variable
2. macOS Keychain entry, looked up by the profile's `username`. Cloud
   `apiToken` profiles have no `username`, so this step applies to Server/Data
   Center `bearer` profiles that were logged in with `--username`.
3. Token stored in the profile config (`token` for `apiToken`, `pat` for
   `bearer`)

`ATLCLI_API_TOKEN` wins for every profile, including one selected with
`--profile`. A stale or wrong value in the environment therefore overrides the
stored token of every profile and shows up as a 401 from whichever product the
token cannot reach. `auth status` reports it as `hasEnvToken: true`.

`ATLCLI_SITE` and `ATLCLI_EMAIL` are read only by `auth login` and
`auth init`.

A command that fails with

```
No token found. Set ATLCLI_API_TOKEN environment variable, store token in Mac
Keychain, or configure token in profile.
```

has no token from any of the three sources. With a Server/Data Center profile
that relies on the Keychain, the lookup can be refused for the process;
`atlcli auth status` then shows `"hasKeychainToken": false` and still lists
the site, since it checks no token. Do not "fix" it by
writing credentials anywhere. Ask the user to run the command in their own
shell, or to export `ATLCLI_API_TOKEN` for the session.

Credentials are never an argument you construct. `auth login`, `auth init`,
`auth logout`, `auth delete`, `auth rename` and `auth switch` change the
user's stored credentials and profiles. Leave them to the user.

## Defaults that change command behaviour

`atlcli config` stores defaults that silently fill in omitted flags:

| Key | Fills in |
| --- | --- |
| `global.project` / `profiles.<name>.project` | `--project` for Jira commands |
| `global.space` / `profiles.<name>.space` | `--space` for Confluence commands |
| `global.board` / `profiles.<name>.board` | `--board` |
| `logging.level` | `off`, `error`, `warn`, `info`, `debug` |
| `logging.global`, `logging.project` | whether logs are written |

These are the only keys `config set` accepts. Resolution: CLI flag > profile
config > global config.

This is why `atlcli jira search` with no `--project` may still be scoped, and
why a command can succeed on one machine and fail with "required" on another.
When a result looks unexpectedly narrow, check `atlcli config list --json`
before rewriting the query. `config set` and `config unset` change the user's
config; treat them as a user decision.

## Feature flags

```bash
atlcli flag list --json    # array of set flags with their source; "No flags set" when none
atlcli flag get <name> --json    # {"name": ..., "value": ..., "set": true|false}
```

Precedence: `FLAG_*` environment variables > project `.atlcli/config.json` >
global `~/.atlcli/config.json`. A flag name maps to its variable by upper-casing
it and turning dots into underscores (`uno.service` is `FLAG_UNO_SERVICE`).
`atlcli flag set <name> <value>` writes project-level config unless `--global`
is passed, and `flag unset <name>` removes one; both are user decisions.

Two commands are gated by a flag and never listed in the root help, set or
not: `audit` (flag `audit`; without it `atlcli audit` prints `Audit feature is
not enabled`) and `helloworld`. Check `atlcli flag list` when a documented
capability seems missing.

## Logs

```bash
atlcli log list --since 1h --level error --json
atlcli log list --type api --limit 50 --json
atlcli log show <id> --json
atlcli log tail -f
```

`log list --json` returns `{"schemaVersion": "1", "entries": [...]}`. Types:
`api`, `cli`, `sync`, `auth`, `error`. Levels: `error`, `warn`, `info`,
`debug`. `--since`/`--until` accept ISO dates or relative forms (`1h`, `7d`,
`30m`). `--global` and `--project` restrict a query to one log location.

`atlcli log list --type api --since 5m --json` is the fastest way to see what
a failing command actually sent. Every command also logs its flags, so a
`--jql` or `--summary` you passed appears in the log; token-like keys are
redacted. `--no-log` on a single command suppresses logging for that
invocation.

`log clear --confirm` deletes log files, all of them unless `--before <date>`
is given. It is a user decision.

## Doctor

`atlcli doctor --json` returns `{"schemaVersion", "checks": [...], "summary":
{"passed", "warnings", "failed"}}` and exits 1 when any check failed. The
checks are `config_exists`, `config_valid`, `profile_exists`,
`active_profile`, `confluence_api`, `jira_api` and `log_directory`. The two API
checks run only when the config checks before them pass, and each reports its
latency and warns above 2000 ms.

A failed API check carries the raw error in `details.error`. For a Confluence
401 that is the HTML of the login page; read `message` and `suggestion`
instead.

`atlcli doctor --fix` creates the log directory and, when
`~/.atlcli/config.json` is absent, writes a fresh one holding an empty
`profiles` object. It only fills in what is missing, but it is still a state
change, so mention it before running it.

State lives in `~/.atlcli/` (`config.json`, `logs/`, `templates/`, `plugins/`
and `plugins.json`, `timer.json` for the worklog timer, `vfs/` for the
`wiki sh` and `wiki mount` cache, `models/`) and, inside a synced workspace, in
`./.atlcli/` (`config.json`, `sync.db`). Project logs are written to
`./.atlcli/logs/` only when that directory already exists.

## Updates and version

```bash
atlcli version                 # version banner
atlcli release-info --json     # version, channel, build id, source sha
atlcli update --check --json   # currentVersion, latestVersion, updateAvailable, installMethod
```

`atlcli update` with no flags depends on how atlcli was installed. For a
Homebrew install (`installMethod: "homebrew"`) it only prints the command to
run (`brew update && brew upgrade atlcli`) and changes nothing. For a script
install it downloads and replaces the binary, and `atlcli update <version>`
installs that version for any install method. Both are user decisions; use
`--check` to look.

After an interactive command without `--json`, atlcli checks for updates at
most once a day and prints `Update available: ... Run: atlcli update` on stderr.
`ATLCLI_DISABLE_UPDATE_CHECK=1` turns that off.

## Anti-patterns

- Retrying a "No token found" failure with a different atlcli command. The
  credential lookup failed at the process level; every command will fail the
  same way.
- Writing a token into `~/.atlcli/config.json` or exporting one you were shown
  in conversation.
- Assuming an omitted `--project` means "all projects": a configured default
  may be scoping the result.
- Reading `auth status` with both token flags `false` as "the token is in the
  Keychain". A Cloud profile never uses the Keychain, so it has no usable token.
- Running `atlcli update` without `--check`.
