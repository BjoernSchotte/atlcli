---
name: jira-audit
description: atlcli audit jira, hygiene and flow findings over Jira issues, its rules file, rule scripts, --fix plans, baseline, exit codes and JSON report.
metadata:
  tags: jira, audit, hygiene, rules, baseline
---

# Jira audit

`atlcli audit jira` reports findings over the open issues of a selection and
the issues done in it during the last 90 days: stuck or unassigned work,
stale and overdue issues, and hygiene gaps. It writes nothing to Jira unless
`--fix --apply` applies a reviewed plan (see [Rule scripts and fixes](#rule-scripts-and-fixes)).
Two flags write a local baseline file (see [Baseline](#baseline)).

## Contents

- [Enabling and help](#enabling-and-help)
- [Running it](#running-it)
- [Rules and the rules file](#rules-and-the-rules-file)
- [Rule scripts and fixes](#rule-scripts-and-fixes)
- [Baseline](#baseline)
- [Report files and formats](#report-files-and-formats)
- [Exit codes and JSON](#exit-codes-and-json)
- [Anti-patterns](#anti-patterns)

## Enabling and help

The command needs the `audit` feature flag. Without it, every `atlcli audit`
run exits 1 with `Audit feature is not enabled`. `FLAG_AUDIT=true` enables it
for one process without changing any config. Enabling the flag for good
(`atlcli flag set audit true --global`) edits `~/.atlcli/config.json`, so ask
first.

Read the help with `atlcli audit jira --help`, which works without the flag.

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
`overrides`, `baseline` (`olderThan`), `flagged` (`field`), `scripts` (rule
script paths relative to the file) and `confluence` (the wiki audit's rules). An unknown key
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

## Rule scripts and fixes

Every rule, built-in or custom, is a TypeScript script with
`export const meta = { audit: { id, product: "jira", … } }` and a default
export `(issue, rule) => rule.finding({ detail }) | undefined`. Rules run
read-only in the script sandbox; a write verb fails the run with
`permission-denied: audit rules only read`.

- Discovery, later wins on the same id: built-ins, `~/.atlcli/audit/*.ts`,
  `./.atlcli/audit/*.ts`, `scripts:` in the rules file, `--script <file>`.
  A script with a built-in's id replaces it (diagnostic "replaces the
  built-in rule").
- `--list-rules` lists ids, sources and which rules have `fix`/`report`;
  `--print-rule <id>` prints a rule's source. `atlcli audit init` writes a
  skeleton and `atlcli.d.ts` to `./.atlcli/audit/` (writes files: ask first).
- `--fix` runs each listed finding's `fix(finding, issue)` export and prints
  the plan; nothing changes. `--fix --plan-out f.json` saves it for
  `atlcli script apply f.json`; `--fix --apply` applies after a prompt
  (`--yes` skips it, so only with the user's go).
- Reports: `--markdown` (default Jinja template, `--print-template`),
  `--template file.j2`, or a rule's `export async function report(model, out)`
  (`--report-script <id>`, else the last rule with one). The export writes
  through `out` (`write`, `line`, `row`, `json`, `render`; no `close`, atlcli
  closes it) or returns the whole text. Neither is an error (`must write to out
  or return the report text`). With `meta.permissions` it needs `file:output`.
  Rule checks and `fix` cannot open output files (`audit rules write no files`).

Docs page: Custom Audit Rules (`/audit-scripts/`).

## Report files and formats

```bash
atlcli audit jira --project PROJ --output audit.csv          # format from the extension
atlcli audit jira --project PROJ --format jsonl > findings.jsonl
atlcli audit jira --project PROJ --template team.md.j2 --output report.md
```

- `--output <file>`: the report goes to the file, replaced only once complete
  (a failed run keeps the old file); parent directories are created. stderr:
  `Report written to <file> (<size>)`. With `--json`, stdout still gets the
  JSON report. Writing a file: say where before running it.
- `--format md|json|jsonl|csv`: default from the `--output` extension (`.json`,
  `.jsonl`/`.ndjson`, `.csv`, else Markdown); without `--output` it goes to
  stdout. `json` = the `--json` report; `jsonl` = one finding per line; `csv`
  columns `severity,rule,key,summary,status,assignee,detail,ageDays,url` (RFC
  4180, CRLF).
- `--report <file>` = `--format md --output <file>`.
- `--template`, `--markdown`, `--report-script` make Markdown only; with
  `--format json|jsonl|csv` they are a usage error.
- Reports stream (templates in chunks, JSON one finding at a time). A template
  error fails the audit instead of printing the template source.

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
`--no-baseline` ignores both the file and the cutoff.

## Exit codes and JSON

Exit 0: the audit ran. Exit 1: it failed or the arguments were wrong. Exit 2:
a listed finding reached `--fail-on` (default `error`; `info`, `warning`,
`never`). Suppressed findings (below `--min-level`, baselined or legacy) never
cause exit 2. Exit 2 is a result, not a failure; pass `--fail-on never` when
only the report is wanted.

`--json` prints `schemaVersion: "3"` with `product` (`jira`), `generatedAt`,
`query`, `rules` (`source`, `extends`, `minLevel`), `summary` (`total`,
`bySeverity`, `byRule`, `suppressed`), `findings` (each with `rule`,
`category`, `severity`, `target` (`kind`, `key`, `url`), `key`, `summary`,
`status`, `assignee`, `detail`, `ageDays`, `subject`, `fixable`), `quiet`,
`legacy`, `legacyDays`, `staleBaselineEntries`, `partial`, `diagnostics` and
`titles` (rule id → title). Version 3 replaced 2; every v2 field kept its
meaning. A non-empty `partial` names the queries cut at `--limit` (the lowest
keys are kept), so the counts are lower bounds even at exit 0. An unreadable
baseline file only adds a line to `diagnostics`. `--markdown` prints a
Markdown report.

## Anti-patterns

- Treating exit 2 as a failed run, or exit 0 as a complete one without
  reading `partial`.
- Running `--update-baseline` or `--prune-baseline` with a narrower
  selection or `--checks`: it deletes the other entries.
- A custom rule without `statusCategory != Done` when only open issues should
  count.
- Writing in a rule's default export instead of `fix`, or running
  `--fix --apply --yes` without the user having seen the plan.

Related: [jira-agile.md](jira-agile.md), [digest.md](digest.md),
[safety.md](safety.md).
