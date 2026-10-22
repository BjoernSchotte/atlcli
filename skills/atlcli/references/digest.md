---
name: digest
description: atlcli digest, one view of what changed since the last look and what waits on the user across Jira and Confluence, its last-run marker, output and failure handling.
metadata:
  tags: digest, standup, jira, confluence, mentions, sprint
---

# Digest

`atlcli digest` reads Jira and Confluence and prints one view: what waits on
the user, what changed on their issues and pages, and the active sprint. It
writes nothing to Jira or Confluence. It writes one local file, the last-run
marker.

## Contents

- [Running it](#running-it)
- [Sections](#sections)
- [The last-run marker](#the-last-run-marker)
- [Output and failures](#output-and-failures)
- [Summaries](#summaries)
- [Anti-patterns](#anti-patterns)

## Running it

```bash
atlcli digest --no-mark --json
atlcli digest --since 7d --only jira --json
atlcli digest --project PROJ,OPS --since 7d --json
atlcli digest --markdown --no-mark > standup.md
```

`--since` takes `lastrun` (the default), `<n>m`, `<n>h`, `<n>d`, `<n>w`,
`today`, `yesterday`, an ISO date or an ISO date-time. `m` means minutes.
`today`, `yesterday` and a plain date are midnight in the local time zone of
the machine running atlcli. `lastrun` without a previous run means the last
24 hours, and it starts five minutes before the previous run, so an item near
that boundary can show up in two runs. A start more than 30 days back is
clamped to 30 days with a warning; a start in the future is a usage error.

`--only jira` or `--only confluence` limits the run to one product. `--limit`
caps each section (default 10). `--markdown` prints Markdown for a standup
note, and `--verbose` prints every query and the request count on stderr.

The help names its defaults `defaults.space`, `defaults.board` and
`defaults.project`. Those are the profile's values, else `global.space`,
`global.board` and `global.project` (see
[auth-and-config.md](auth-and-config.md)).

## Sections

- Jira: waiting on the user, changed (the user's issues and watched ones), and
  the active sprint of `--board`. A kanban board has no sprint and is skipped.
- Projects, with `--project PROJ,OPS` or `digest.projects` in
  `~/.atlcli/config.json`: per project, the issues completed, created and
  changed by anyone in the window. "Completed" follows the status map
  (`--status-map`, `flow.statusMap`); so do the waiting list and the sprint
  counts. At most 200 changed issues are read for the overview.
- Audit, when the `audit` feature flag is on (from `FLAG_AUDIT`, the project
  `.atlcli/config.json` or the global config) and projects are given: the
  error-level findings of the audit rules for those projects (see
  [jira-audit.md](jira-audit.md)).
- Confluence: mentions, comments on the user's pages, open inline comments on
  them (the first `--max-pages`, default 10), the user's pages edited by
  others, watched pages changed, and pages recently changed in `--space`.
  Comments are looked up on the 50 most recently modified pages the user
  created.

The user's own changes and comments are left out of `jira.changed` and the
Confluence sections; the project overview keeps them. Pass `--include-own`
when the user asks about their own work. On Data Center, changed issues come
with an empty `changes` list, because atlcli reads no changelogs there.

## The last-run marker

A run with `--since lastrun` (the default) moves the marker in
`~/.atlcli/profiles/<profile>/digest-state.json`, one entry per product, for
every product none of whose sections failed. The user's next plain
`atlcli digest` then starts after that run, so a digest an agent reads for its
own purposes hides those changes from the user. Pass `--no-mark` unless the
user asks for their own digest. A run with any other `--since` never moves the
marker. With `--only`, only that product's marker can move.

A section cut at `--limit` does not hold the marker back: `truncated` names it,
and the marker still moves. To see the rest, rerun with an explicit `--since`
for the same window and a higher `--limit`, which does not move the marker.

## Output and failures

`--json` prints `schemaVersion: "1"` with `generatedAt`, `since`, `profile`,
`me`, `jira` (`waiting`, `changed`, `sprints`, and `projects` and `audit` when
they ran), `confluence` (`mentions`, `myPagesEdited`, `comments`,
`openInline`, `watched`, `recent`), `warnings`, `truncated`, `queries` and,
with `--summarize`, `summary`. With `--only`, the other product's key is
absent.

A section that fails is listed in `warnings` with its section name, the rest
still prints, and the exit code stays 0. The exit code is 1 only when no
section came back, and even then the digest is printed first. With projects
configured, the run exits 0 even when every section failed. Exit 0 therefore
does not mean every section succeeded: read `warnings` before saying a section
is empty. Argument and authentication errors print the usual
`{"error":{"code":"ATLCLI_ERR_…"}}` instead.

## Summaries

`--summarize` sends the rendered digest (keys, titles, statuses and names, no
page or comment bodies) to the Anthropic API in one call, after a notice on
stderr. It needs `ANTHROPIC_API_KEY` in the environment; atlcli refuses an API
key given as a flag. Without the key the digest prints with a warning and no
summary. Use it only when the user asks for it, as with `research` and `chat`.

## Anti-patterns

- Running a plain `atlcli digest` on the user's behalf without `--no-mark`. It
  moves their last-run marker.
- Reporting a section as empty without reading `warnings` and `truncated`.
- Taking exit code 0 as "every section succeeded".
- Adding `--summarize` without the user asking for it.

Related: [jira-agile.md](jira-agile.md), [jira-audit.md](jira-audit.md),
[auth-and-config.md](auth-and-config.md), [safety.md](safety.md).
