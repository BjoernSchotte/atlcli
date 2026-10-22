---
name: jira-audit
description: atlcli audit jira, report-only hygiene and flow findings over Jira issues, its rules file, baseline, exit codes and JSON report.
metadata:
  tags: jira, audit, hygiene, rules, baseline
---

# Jira audit

`atlcli audit jira` reports findings over the open issues of a selection and
the issues done in it during the last 90 days: stuck or unassigned work,
stale and overdue issues, and hygiene gaps. It writes nothing to Jira. Two
flags write a local baseline file (see [Baseline](#baseline)).

## Contents

- [Enabling and help](#enabling-and-help)
- [Running it](#running-it)
- [Rules and the rules file](#rules-and-the-rules-file)
- [Baseline](#baseline)
- [Exit codes and JSON](#exit-codes-and-json)
- [Anti-patterns](#anti-patterns)

## Enabling and help

The command needs the `audit` feature flag. Without it, every `atlcli audit`
call, help included, exits 1 with `Audit feature is not enabled`.
`FLAG_AUDIT=true atlcli audit jira help` reads the help for one process
without changing any config. Enabling the flag for good
(`atlcli flag set audit true --global`) edits `~/.atlcli/config.json`, so ask
first.

Read the help with `atlcli audit jira help`. `atlcli audit jira --help` prints
the root help instead.

## Running it

```bash
atlcli audit jira --project PROJ --json
atlcli audit jira --board 123 --checks flow --min-level info --json
atlcli audit jira --jql 'project = PROJ AND component = API' --fail-on never --json
```

The issues come from `--jql`, else `--board` (the board's saved filter), else
`--project`, else the default board, else the default project. `--checks`
limits the run to rule ids, categories (`workflow`, `flow`, `hygiene`,
`custom`) or the older names `stuck-wip`, `unassigned-wip` and `stale`.
`--stale 30,60,90` sets the stale thresholds in days, and `--all` counts to-do
issues as stale too. Status categories follow the status map (`--status-map`,
`flow.statusMap`). `--limit` (default 1000) caps each query separately.

`flow/stuck-wip`, `flow/status-aging`, `hygiene/flagged` and
`workflow/resolved-not-done` read changelogs: on Cloud in a bulk read, on Data
Center one request per issue, five at a time. On Data Center, narrow the
selection on large projects.

## Rules and the rules file

Rules (category/rule): `workflow/resolved-not-done`, `flow/stuck-wip`,
`flow/status-aging`, `flow/unassigned-wip`, `hygiene/overdue`,
`hygiene/due-soon`, `hygiene/flagged`, `hygiene/stale`, `hygiene/no-parent`,
`hygiene/unestimated-in-sprint`, `hygiene/done-without-version`.

The rules in effect come from the first of: `--rules <file>`,
`./.atlcli/audit-rules.yaml`, `~/.atlcli/profiles/<profile>/audit-rules.yaml`,
`~/.atlcli/audit-rules.yaml`. Without a file the built-in `default` profile
applies, and `audit.jira.staleDays` in the config still sets the stale
thresholds.

A rules file is YAML. Its top-level keys are `version` (1), `extends`
(`minimal`, `default` or `strict`), `minLevel`, `rules`, `custom`,
`overrides`, `baseline` (`olderThan`) and `flagged` (`field`). An unknown key
or value fails the run with the path inside the file.

```yaml
version: 1
extends: default
rules:
  hygiene/stale: { warning: 45d, error: 90d }
custom:
  - id: team/bug-without-component
    jql: issuetype = Bug AND component IS EMPTY AND statusCategory != Done
    message: Bug without component
overrides:
  - match: { issueType: [Epic] }
    rules:
      hygiene/no-parent: off
```

A custom rule's JQL is used as written, combined only with the selection: add
`statusCategory != Done` yourself when done issues should not count. A custom
id has the form `<group>/<name>` in lower case, and its JQL takes no
`ORDER BY`.

## Baseline

The baseline is one file per profile,
`~/.atlcli/profiles/<profile>/audit-baseline.json`, shared by every selection
and rule set. Findings it lists are not reported.

- `--update-baseline` rewrites the file to this run's findings, at every
  level and including the legacy ones. Entries this run did not see are
  dropped; entries it saw keep their accepted date.
- `--prune-baseline` keeps only the entries this run still found, and does
  nothing when no file exists.
- With both flags, only the update runs. The update writes even with
  `--no-baseline`.
- The report's count of entries that "no longer match" includes entries of
  other selections. Following its prune hint under another selection deletes
  them.

Run either flag only with the selection, `--checks` and rules the baseline was
built with, and ask first: both change what later runs report. The run that
updates the baseline still reports against the old one and can exit 2; the
diagnostics line `Baseline: N finding(s) accepted in <path>` shows the update
worked.

Independently of the baseline file, a finding on an issue not updated for the
legacy cutoff is counted per rule as legacy instead of listed: 180 days in the
`minimal` and `default` profiles, off in `strict`, and set by
`baseline.olderThan` in the rules file. Workflow findings are never legacy.
`--no-baseline` ignores both the file and the cutoff. The help says the cutoff
applies only without a baseline file; the code applies it either way.

## Exit codes and JSON

Exit 0: the audit ran. Exit 1: it failed or the arguments were wrong. Exit 2:
a listed finding reached `--fail-on` (default `error`; `info`, `warning`,
`never`). Suppressed findings (below `--min-level`, baselined or legacy) never
cause exit 2. Exit 2 is a result, not a failure; pass `--fail-on never` when
only the report is wanted.

`--json` prints `schemaVersion: "2"` with `generatedAt`, `rules` (`source`,
`extends`, `minLevel`), `summary` (`total`, `bySeverity`, `byRule`,
`suppressed`), `findings` (each with `rule`, `category`, `severity`, `key`,
`summary`, `status`, `assignee`, `detail`, `ageDays`, `subject`), `quiet`,
`legacy`, `legacyDays`, `staleBaselineEntries`, `partial`, `diagnostics` and
`query`. A non-empty `partial` names the queries cut at `--limit` (the lowest
keys are kept), so the counts are lower bounds even at exit 0. An unreadable
baseline file only adds a line to `diagnostics`. `--markdown` prints a
Markdown report.

## Anti-patterns

- `atlcli audit jira --help`: it prints the root help. Use
  `atlcli audit jira help`.
- Treating exit 2 as a failed run, or exit 0 as a complete one without
  reading `partial`.
- Running `--update-baseline` or `--prune-baseline` with a narrower
  selection or `--checks`: it deletes the other entries.
- A custom rule without `statusCategory != Done` when only open issues should
  count.

Related: [jira-agile.md](jira-agile.md), [digest.md](digest.md),
[safety.md](safety.md).
