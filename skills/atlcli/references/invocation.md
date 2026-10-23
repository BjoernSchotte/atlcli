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
`research`, `chat`, `digest`, `pdf-template`, `log`, `models`, `plugin`,
`skill`, `update`, `version`, `release-info`, `audit`. `atlcli audit` needs
its `audit` feature flag (see
[auth-and-config.md](auth-and-config.md#feature-flags)).

Global options accepted anywhere: `--profile <name>`, `--json`, `--no-log`,
`--help`/`-h`, `--version`/`-v`. `--version` only prints the version when no
command is given. `--help` prints help and runs nothing, with two exceptions,
see below.

## Discovering the surface safely

Run the group or subgroup **with no arguments**:

```bash
atlcli jira issue        # prints the issue group help, makes no API call
atlcli jira subtask      # prints the subtask group help
atlcli wiki docs         # prints the docs group help
```

A bare group prints its help without touching the network or credentials and
exits **0**. With `--json` the help goes to stderr and stdout stays empty.

An unknown subcommand exits **1** with `ATLCLI_ERR_USAGE` and `Unknown
subcommand: <name>`, at every level (`atlcli bogus`, `atlcli wiki page bogus
--json`, `atlcli config bogus`). Without `--json` the group help is printed
as well. Two exceptions:

- Some `wiki` subtrees read the unknown word as an argument instead:
  `atlcli wiki publish bogus` fails on the missing project file and
  `atlcli wiki import bogus` on the file type, both with exit **1**.
- A plugin command (`atlcli git bogus`) prints `Unknown subcommand` and its
  help, and exits **0**.

### `--help`

`--help` (or `-h`) anywhere in argv prints help and runs nothing: the help of
the verb where the handler has its own, otherwise the help of the enclosing
group (`atlcli jira watch PROJ-101 --help` prints the `jira` help).
`atlcli audit jira --help` prints the `audit jira` help.

`release-info --help` prints the root help, and `version --help` prints the
version.

## Flag grammar

**The group help lists which arguments are positional.** Most targets are
named flags (`--key`, `--id`, `--page`). Under `jira issue`, an issue key as
the first argument works in place of `--key`: `atlcli jira issue get PROJ-102`
is `atlcli jira issue get --key PROJ-102`. `jira project get|types` take the
project key either way (`jira project types PROJ`, or `--key PROJ`, not
`--project`).

Examples that are positional:
`jira issue comment --key <key> <text>`, `jira issue attach <key> <file>`,
`jira issue open <key>`, `jira subtask create <parent> --summary ...`,
`jira epic get <key>`, `jira worklog add <issue> <time>`,
`jira field search <query>`, `jira version get <id>`, `wiki search <query>`,
`wiki docs pull <dir>`, `wiki page open <id>`.

Parser behaviour that bites:

- `--key=value` and `--key value` are the same. In the `=` form the value is
  everything after the first `=`, so `--jql='project = PROJ'` and
  `--set=field=value` arrive whole.
- In the space form a flag takes the next token as its value unless that token
  is itself a flag: one starting with `--`, or with `-` and a letter. So
  `--description '- first item'`, `--count -5` and `--description-file -`
  (stdin) work, while `--profile '-foo'` reads as the flags `-f` and `-o`. For
  such a value use the `=` form: `--summary='-foo repro only'`.
- Switches never take a value, so `--json`, `--confirm`, `--dry-run`,
  `--force`, `--yes`, `--no-log`, `--list`, `--all` and the `audit wiki`
  check flags can stand before a positional:
  `atlcli jira filter delete --confirm 10001` deletes filter 10001. A rarer
  on/off flag that is not on that list, such as `wiki my --contributed`,
  still takes a following positional as its value, so put positionals first
  when in doubt.
- Unrecognised flags are collected and never validated, so a flag a verb does
  not read is dropped without error and the run still reports success.
- `--field key=value` splits its value on the first `=` only:
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

Under `--json`, stdout carries only JSON documents; prose such as help,
progress lines and `Would delete: ...` goes to stderr. A command prints one
document, except `jira sprint review ... --export` and
`jira version notes ... --export`, which follow the page result with the
export report as a second document. Always pass `--json`: it is the way to get
a machine-readable result and the way to get a structured error.

`jira issue get` and `jira search` return a **flattened** issue, not the raw
REST shape. `summary`, `status`, `type`, `priority`, `assignee`, `reporter` are
plain strings; `assigneeId` carries the account ID. Do not reach for
`.fields.status.name`: it is not there. `description` is the exception and
stays raw ADF (an object). `jira issue get` also returns `descriptionMarkdown`,
the description as a Markdown string. `jira search` returns `total`, `hasMore`
and `nextPageToken` beside `issues`.

## Errors and exit codes

With `--json`, every error prints on stdout:

```json
{ "error": { "code": "ATLCLI_ERR_USAGE", "message": "--key is required.", "details": {} } }
```

Codes: `ATLCLI_ERR_USAGE`, `ATLCLI_ERR_AUTH`, `ATLCLI_ERR_API`,
`ATLCLI_ERR_IO`, `ATLCLI_ERR_CONFIG`, `ATLCLI_ERR_VALIDATION`,
`ATLCLI_ERR_FORBIDDEN`, `ATLCLI_ERR_NOT_FOUND`, `ATLCLI_ERR_RATE_LIMIT`. The
exit status is 1.

An HTTP error from Jira or Confluence takes the same shape. Its code follows
the status (401 `ATLCLI_ERR_AUTH`, 403 `ATLCLI_ERR_FORBIDDEN`, 404
`ATLCLI_ERR_NOT_FOUND`, 429 `ATLCLI_ERR_RATE_LIMIT`, any other
`ATLCLI_ERR_API`), and `details.status` holds the status. A network failure is
`ATLCLI_ERR_API` without a status. The message of a Confluence 401 can carry
the HTML of the login page.

Without `--json`, the message goes to stderr as a single bare line with no
stack trace. Exit status is `0` on success and non-zero on failure; classify
failures by `error.code` where it exists, not by the numeric status. One
exception: `atlcli audit jira` exits 2 when a finding reaches `--fail-on`,
which is a result, not a failure (see [jira-audit.md](jira-audit.md)).
`atlcli doctor` exits 1 when any check fails.

Error messages are worth reading rather than discarding: they name the missing
flag, or enumerate the valid values (`Transition "In Progress" not found.
Available: Start Progress, Resolve Issue, Close Issue`).

## Anti-patterns

- Reading `.fields.*` off a returned issue: the CLI already flattened it.
- Reading the numeric exit status alone. Classify failures by `error.code`.

See [safety.md](safety.md) before running anything that writes, and
[auth-and-config.md](auth-and-config.md) for profile and credential
resolution.
