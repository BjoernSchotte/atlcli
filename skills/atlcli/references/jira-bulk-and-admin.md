---
name: jira-bulk-and-admin
description: Bulk JQL-scoped changes, projects, components, versions and release notes pages, custom fields, issue templates, watchers, and webhooks.
metadata:
  tags: jira, bulk, projects, components, versions, release-notes, fields, templates, webhooks
---

# Bulk changes and project administration

## Contents

- [Bulk operations](#bulk-operations)
- [Projects](#projects)
- [Components and versions](#components-and-versions)
- [Release notes pages](#release-notes-pages)
- [Custom fields](#custom-fields)
- [Issue templates](#issue-templates)
- [Watchers](#watchers)
- [Webhooks](#webhooks)
- [Anti-patterns](#anti-patterns)

## Bulk operations

Every `jira bulk` verb selects issues with exactly one of `--jql <query>` or
`--issues K1,K2,...` (the keys become `key in (...)`). Giving both, or
neither, is a usage error. The selection is the blast radius. Every verb
applies to at most `--limit` matches (default **1000**).

Always run `--dry-run` first and show the user the matches:

```bash
atlcli jira bulk transition --jql 'project = PROJ AND status = Open' \
  --to 'Start Progress' --dry-run --json
atlcli jira bulk transition --jql 'project = PROJ AND status = Open' \
  --to 'Start Progress' --json
```

```bash
atlcli jira bulk edit --jql 'project = PROJ AND type = Bug' --set priority=High --json
atlcli jira bulk edit --issues PROJ-101,PROJ-102 --set priority=High --set assignee=none --json
atlcli jira bulk label add sprint-47 --jql 'sprint IN openSprints()' --json
atlcli jira bulk label remove wip --jql 'project = PROJ' --json
atlcli jira bulk link-page --jql 'sprint IN openSprints()' --page 12345 --json
atlcli jira bulk move --jql 'project = PROJ AND status = Open' --sprint 456 --json
atlcli jira bulk move --issues PROJ-101,PROJ-102 --backlog --json
```

`bulk edit --set` is repeatable, and one value may hold several assignments
(`priority=High,assignee=none`). `priority=<name>`, `assignee=<accountId>` (or
`none`) and `labels=a,b,c` are mapped to the Jira field shapes. Any other
`name=value` is sent as a plain string under that field key, so it only works
for fields that accept a string. Note that `labels` **replaces** the whole
label set, unlike `jira issue update --add-labels`.

`bulk move` puts the matches into the sprint given by `--sprint <numeric id>`
or back into the backlog with `--backlog`. Exactly one of the two is required.
It moves in chunks of 50 and reports per-issue failures in the result.

`bulk link-page` adds a Confluence remote link to every match. `--page` is
required. `--comment` is read as a string value, so a bare
`--comment` at the end of the command, or followed by another flag, adds no
comment. Do not rely on it.

`jira bulk delete --jql … --confirm` deletes every match. Treat it as the most
dangerous command in the tool: run the identical query through `--dry-run`,
show the user the count and the keys, and only proceed on an explicit
instruction naming that deletion. `--dry-run` wins over `--confirm`, so the
dry run never deletes.

Transition names on `bulk transition` are matched per issue against the
transition name, the target status name, or the transition id, case
insensitive. See [jira-issues.md](jira-issues.md#transitions) for single
issues. An issue where the name is unavailable fails with the list of
available transitions, and the other issues still proceed. The result reports
`successful` and `failed` counts with per-key errors.

## Projects

```bash
atlcli jira project list --json
atlcli jira project list --query platform --limit 50 --json
atlcli jira project get --key PROJ --json
atlcli jira project types --key PROJ --json
```

`project get` and `project types` take `--key`, not `--project` and not a
positional. Run `project types` before every `issue create` against an
unfamiliar project: issue type names are site-specific (`Spike` and `Change
Request` exist on some projects and not others).

`jira project create --key <KEY> --name <name> [--type software|service_desk|business]
[--template <key>] [--description <text>] [--lead <accountId>]` creates a
project (type defaults to `software`). That is an administrative act with
site-wide visibility. Do not run it unless the user asked for exactly that.

## Components and versions

```bash
atlcli jira component list --project PROJ --json
atlcli jira component get 10001 --json
atlcli jira component create --project PROJ --name Backend --json
atlcli jira component update 10001 --description 'Backend services' --json
atlcli jira component delete 10001 --confirm --json

atlcli jira version list --project PROJ --json
atlcli jira version get 10001 --json
atlcli jira version create --project PROJ --name 1.0.0 --start-date 2026-08-01 \
  --release-date 2026-09-01 --json
atlcli jira version update 10001 --release-date 2026-09-15 --json
atlcli jira version release 10001 --json
atlcli jira version delete 10001 --confirm --json
```

IDs are positional on `get`, `update`, `release`, and `delete`; the project is
a flag on `list` and `create`. `component update` needs at least one of
`--name`, `--description`, `--lead`; `version update` needs at least one of
`--name`, `--description`, `--start-date`, `--release-date`. `version release`
sets the release date to today and marks the version released. It is a write,
not a query.

Run `atlcli jira component` or `atlcli jira version` with no arguments to see
the group help.

## Release notes pages

`jira version notes <id|name>` renders the issues of a version (`fixVersion =
<id>`) through a template and creates or updates a Confluence page. It is a
Confluence write.

```bash
atlcli jira version notes --list-templates --json
atlcli jira version notes 1.0.0 --project PROJ --space DOCS --dry-run --json
atlcli jira version notes 10001 --space DOCS --group-by epic --json
atlcli jira version notes 10001 --space DOCS --export notes.pdf --json
```

- A numeric argument is a version id. Anything else is a version name and
  needs `--project` (or `defaults.project`). Two versions with the same name
  fail; pass the id.
- `--space` is required unless `defaults.space` is set.
- `--group-by type` (default) or `epic` picks the bundled template
  `release-notes` or `release-notes-by-epic`. `--template <name>` overrides
  it; a template at global, profile or space level is found before a bundled
  one. `--print-template <name>` prints a bundled template.
- `--title` sets the page title (default `Release notes – <version name>`),
  `--parent <id>` the parent page, `--var name=value` (repeatable) adds
  template variables.
- Re-running updates the page it created. The result `action` is `create`,
  `update`, or `unchanged`. A page with the same title that atlcli did not
  create for this version fails unless `--force` is given.
- `--dry-run` reads Confluence and Jira, writes nothing, and returns the
  rendered markdown and the planned `action`. Always run it first.
- `--export <file>` also exports the page after the write: `.pdf` gives a PDF,
  any other extension a DOCX. `--export-template <name>` picks the export
  template.

## Custom fields

```bash
atlcli jira field search 'story point' --json
atlcli jira field list --custom --json
atlcli jira field list --type string --json
atlcli jira field get customfield_10016 --json
atlcli jira field options customfield_10001 --json
```

`field search` takes the query positionally and matches field name, id and JQL
clause names. `field options` lists the allowed values for a custom select or
multiselect field. It fails for system fields and returns an empty list with a
message when the field has no options or the account lacks admin permission.
Read it before setting one through `--field customfield_10077='{"value":"Bug"}'`,
because an invalid option is rejected by the API, not by the CLI.

## Issue templates

Templates are stored locally under `~/.atlcli/templates/jira/` at one of three
levels: `global/`, `profiles/<name>/`, or `projects/<KEY>/`.

```bash
atlcli jira template list --json
atlcli jira template list --type Bug --search login --json
atlcli jira template list --level project --project PROJ --expand
atlcli jira template get bug-report --json
atlcli jira template save bug-report --issue PROJ-101 --description 'Bug template' \
  --tags bug,triage --json
atlcli jira template apply bug-report --project PROJ --summary 'Login button broken' --json
atlcli jira template export bug-report -o /tmp/template.json --json
atlcli jira template import --file /tmp/template.json --project PROJ --json
atlcli jira template delete bug-report --confirm --json
```

`save`, `import`, `delete` and `list` choose the level by one rule, in order:

1. an explicit `--level global|profile|project`;
2. otherwise `--project <key>` selects project level;
3. otherwise `--profile <name>` selects profile level;
4. otherwise global.

`--profile` is also the auth-profile flag, so it is the weakest signal:
`save --level project --project PROJ --profile work` stores under `PROJ`. An
unknown `--level` value is a usage error. `--level profile` and `--level
project` take the profile or project from `--profile` / `--project`, falling
back to the active profile and `defaults.project`. Give `delete` the same level
flags the template was saved with, otherwise it looks in global storage and
reports not found.

`save` and `import` refuse to overwrite an existing template at the target
level unless `--force` is given. `list` shows the highest-precedence template
per name (project over profile over global); `--all` includes the overridden
ones. `get`, `apply` and `export` resolve the name across all levels the same
way. `import` requires `name`, `fields.issuetype` and `fields.summary` in the
file.

`template apply` creates a real issue and needs `--project` (or
`defaults.project`) and a summary, either `--summary` or one stored in the
template. It also takes `--description` and `--assignee <accountId>`. `save`
reads the source issue from Jira and writes the template locally. `import`,
`export`, and `delete` never touch the API.

## Watchers

```bash
atlcli jira watchers PROJ-101 --json
atlcli jira watch PROJ-101 --json
atlcli jira unwatch PROJ-101 --json
```

The issue key is positional on all three. `watch`/`unwatch` change the user's
own notification state; there is no verb to add another user as watcher.

## Webhooks

```bash
atlcli jira webhook list --json
atlcli jira webhook register --url https://example.ngrok.io/webhook \
  --events jira:issue_updated,comment_created [--jql 'project = PROJ'] --json
atlcli jira webhook refresh <id> --json      # registrations expire after 30 days
atlcli jira webhook delete <id> --json
```

`register` requires `--url` and `--events`; `--jql` is optional and defaults
to all issues. `refresh` and `delete` take one id or a comma-separated list.

`atlcli jira webhook serve [--port 8080] [--path /webhook] [--secret <s>]
[--projects PROJ,TEAM] [--events <list>]` starts a **blocking** local server
that prints events until SIGINT or SIGTERM. Never run it in a foreground shell
you need back; it does not return. Registering a webhook creates site-level
configuration pointing at a URL. Confirm both the URL and the event list with
the user first.

## Anti-patterns

- Running a `jira bulk` verb without a preceding `--dry-run` on the identical
  selection. The default `--limit` is 1000.
- Using `--set labels=…` to add a label. It replaces every label on every
  matching issue; `jira bulk label add <label>` is the additive form.
- Passing both `--jql` and `--issues`, or `--sprint` together with
  `--backlog`. Both are usage errors.
- Calling `jira project get PROJ` or `jira project types --project PROJ`. The
  flag is `--key`.
- Appending `--help` after a verb that takes a positional argument. The global
  `--help` handler re-dispatches the command with the positionals and without
  the other flags, and no `jira` verb checks for it: `jira watchers
  PROJ-101 --help` returns the watchers, and `jira version release 10001
  --help` would release the version. Run the group bare (`atlcli jira version`)
  to see its help.

Related: [safety.md](safety.md), [jira-search.md](jira-search.md),
[jira-issues.md](jira-issues.md).
