---
name: invocation
description: The atlcli calling convention: flag grammar, safe help discovery, JSON output, and error shapes.
metadata:
  tags: cli, flags, json, exit-codes, discovery
---

# Invocation rules

How to call `atlcli` so the command runs the first time.

## Contents

- [Command shape](#command-shape)
- [Discovering the surface safely](#discovering-the-surface-safely)
- [Flag grammar](#flag-grammar)
- [Output](#output)
- [Errors and exit codes](#errors-and-exit-codes)
- [Anti-patterns](#anti-patterns)

## Command shape

```
atlcli <group> [<subgroup>] <verb> [positional] [--flags]
```

Groups: `auth`, `completion`, `config`, `doctor`, `flag`, `wiki`, `jira`,
`research`, `chat`, `pdf-template`, `log`, `models`, `plugin`, `update`,
`version`, `release-info`. `atlcli audit` is absent from the root help until
the `audit` feature flag is set (see
[auth-and-config.md](auth-and-config.md#feature-flags)).

Global options accepted anywhere: `--profile <name>`, `--json`, `--no-log`,
`--help`/`-h`, `--version`/`-v`. `--version` only prints the version when no
command is given. `--help` is only safe in some places, see below.

## Discovering the surface safely

Run the group or subgroup **with no arguments and no `--help`**:

```bash
atlcli jira issue        # prints the issue group help, makes no API call
atlcli jira subtask      # prints the subtask group help
atlcli wiki docs         # prints the docs group help
```

A bare group prints its help without touching the network or credentials and
exits **0**. With `--json` the help is printed as one JSON string.

An unknown subcommand behaves differently per tree:

- Under `jira` it exits **1** with `ATLCLI_ERR_USAGE` and `Unknown subcommand:
  <name>` (`atlcli jira bogus --json`, `atlcli jira issue bogus --json`).
- Under `wiki` (`atlcli wiki bogus`, `atlcli wiki page bogus`) it prints the
  group help and exits **0**.

So the exit status alone does not tell help from success under `wiki`. Read
the output.

### Why `--help` on a verb is unsafe

`atlcli --help` and a bare group's `--help` print help. Below that,
`--help` anywhere in argv re-dispatches the command with a flags object that
holds only `help: true`: every named flag you typed is discarded, while
**positional arguments are kept**.
Whether that is harmless depends on whether the handler checks for `help`
itself:

| Tree | What `--help` on a verb does |
| --- | --- |
| `wiki page`, `wiki docs`, `wiki space`, `wiki search`, `wiki export`, `wiki template`, `wiki import`, `wiki publish`, `wiki sh`, `wiki mount`, `wiki vfs` | the handler checks `help` first and prints help |
| `doctor`, `update`, `models` | prints help |
| `jira` (every subtree) | **no help check**: the verb runs with its flags stripped |
| `auth`, `config`, `flag`, `log`, `plugin` | **no help check**: the verb runs with its positionals |

A `jira` verb whose target is a flag fails harmlessly on validation
(`--key is required.`). A verb whose target is positional runs for real:

- `atlcli jira watch PROJ-101 --help` adds a watcher and prints no help.
  `jira unwatch` likewise.
- `atlcli jira issue attach PROJ-101 ./file.png --help` attaches the file.
- `atlcli jira worklog add PROJ-101 1h --help` logs time.
- `atlcli jira version release 10001 --help` releases the version.
- `atlcli jira issue open PROJ-101 --help` opens the browser.
- `atlcli auth switch other --help` switches the active profile, and
  `atlcli config set global.project PROJ --help` writes the default.
- `atlcli jira webhook serve --help` starts the webhook server and blocks.
- `atlcli jira search --help` runs a live search with its flags gone, so it
  falls back to the configured default project or `ORDER BY created DESC`.

Never append `--help` to a verb in these trees. Use the bare group instead.

## Flag grammar

**Keys are named flags, not positionals.** `atlcli jira issue get PROJ-102`
fails with `--key is required.`; the correct form is
`atlcli jira issue get --key PROJ-102`. The same applies to
`jira project types --key PROJ` (`--key`, not `--project`).

The documented positional arguments are the exception, and they are listed
per verb in the group help. Examples that are positional:
`jira issue comment --key <key> <text>`, `jira issue attach <key> <file>`,
`jira issue open <key>`, `jira subtask create <parent> --summary ...`,
`jira epic get <key>`, `jira worklog add <issue> <time>`,
`jira field search <query>`, `jira version get <id>`, `wiki search <query>`,
`wiki docs pull <dir>`, `wiki page open <id>`.

Parser behaviour that bites:

- **Never use `--key=value` for a value that itself contains `=`.** The parser
  splits the token on `=` keeping two fields, so everything from the value's
  first internal `=` onward is discarded: `--jql='project = PROJ'` reaches Jira
  as `project `. Nearly every JQL and CQL expression contains `=`, so write
  those as `--jql 'project = PROJ'`. On a *write* the same truncation is silent
  and lands wrong data: `--title='Q1=Q2 plan'` creates a page titled `Q1`.
- `--key value` consumes `value` only if it does **not** start with `-`, or is
  exactly `-` (stdin/stdout, as in `--description-file -`). Any other value that
  starts with `-` is discarded **silently**: the flag becomes boolean `true`,
  nothing is reported, and the command runs as though the flag were absent
  (`--profile '-foo'` runs on the default profile). For such a value use the `=`
  form, which is immune to the leading `-`: `--summary='-1 repro only'`. A value
  that both starts with `-` and contains `=` has no clean form; for a query,
  prefix one space (`--jql ' -x = 1'`), which survives to the API and is
  insignificant in JQL and CQL. Never prefix a space on a value stored verbatim,
  such as `--summary` or `--title`.
- **Every long flag takes the next non-dash token as its value, booleans
  included.** `atlcli jira filter delete --confirm 10001` sets
  `confirm=10001` and leaves the id missing, and `--dry-run PROJ-101` swallows
  the key. Put boolean flags (`--confirm`, `--dry-run`, `--force`, `--json`,
  `--no-log`) after the positionals or last on the line.
- Unrecognised flags are collected and never validated, so a flag a verb does
  not read is dropped without error and the run still reports success.
- `--field key=value` is unaffected, because `--field` and its value are separate
  tokens and the value is split on its first `=` only:
  `--field description="$(cat desc.adf.json)"` is safe. The same holds for
  `--set key=value` and `--var key=value`.
- Repeating a flag collects an array. This is what makes `--field` repeatable:
  `--field customfield_10028=5 --field customfield_10077='{"value":"Bug"}'`.
- Clustered short flags are booleans: `-abc` sets `a`, `b`, and `c` to true.
  `-o out.json` works because a single-letter flag takes the next token.

Pass structured values as a single argv element rather than escaping quotes
through the shell. Rich text for `jira issue create|update` and comments goes
through `--description-file <path|->` or `--body-file <path|->`, which read a
file or stdin.

## Output

Structured commands print pretty-printed JSON **with or without** `--json`:

```json
{ "schemaVersion": "1", "issue": { ... } }
```

Commands that print prose (`Would delete: ...`, progress lines, table
renderers) do so only when `--json` is absent. A few emit more than one
document under `--json`: `wiki page delete --id <id> --dry-run --json` prints
a JSON string (`"Would delete: ..."`) and then the JSON object, and
`jira sprint review ... --export` follows the page result with an export
report. Read stdout as a stream of documents when a command can do that. Always
pass `--json`: it is the way to get a machine-readable result and the way to
get a structured error.

`jira issue get` and `jira search` return a **flattened** issue, not the raw
REST shape. `summary`, `status`, `type`, `priority`, `assignee`, `reporter` are
plain strings; `assigneeId` carries the account ID. Do not reach for
`.fields.status.name`: it is not there. `description` is the exception and
stays raw ADF (an object). `jira issue get` also returns `descriptionMarkdown`,
the description as a Markdown string. `jira search` returns `total`, `hasMore`
and `nextPageToken` beside `issues`.

## Errors and exit codes

Usage, validation, auth, config and IO errors raised by the command itself
print, with `--json`, on stdout:

```json
{ "error": { "code": "ATLCLI_ERR_USAGE", "message": "--key is required.", "details": {} } }
```

Codes: `ATLCLI_ERR_USAGE`, `ATLCLI_ERR_AUTH`, `ATLCLI_ERR_API`,
`ATLCLI_ERR_IO`, `ATLCLI_ERR_CONFIG`, `ATLCLI_ERR_VALIDATION`. The exit status
is 1.

**HTTP failures from Jira or Confluence are not structured.** An API error
that a client throws (`Jira API error (404): ...`, `Confluence API error (401):
...`) is caught at the top level of the CLI: stdout stays empty, stderr gets the
bare message, and the exit status is 1, with or without `--json`. A Confluence
401 message carries the full HTML of the login page. Handle both shapes: parse
stdout when it holds `error.code`, and otherwise read stderr.

Without `--json`, the message goes to stderr as a single bare line with no
stack trace. Exit status is `0` on success and non-zero on failure; classify
failures by `error.code` where it exists, not by the numeric status.
`atlcli doctor` exits 1 when any check fails.

Error messages are worth reading rather than discarding: they name the missing
flag, or enumerate the valid values (`Transition "In Progress" not found.
Available: Start Progress, Resolve Issue, Close Issue`).

## Anti-patterns

- Reading `.fields.*` off a returned issue: the CLI already flattened it.
- Gating discovery on exit status. Group help and real errors are not
  distinguishable that way under `wiki`.
- Parsing stdout as JSON after an API failure. It is empty.
- Putting `--confirm` or `--dry-run` directly before a positional.

See [safety.md](safety.md) before running anything that writes, and
[auth-and-config.md](auth-and-config.md) for profile and credential
resolution.
