---
title: "Audit Rules"
description: "Reference for the atlcli audit rules file: profiles, severities, thresholds, overrides, custom JQL rules and the baseline"
---

# Audit Rules

A rules file decides what [`atlcli audit jira`](audit.md) reports and how loudly. It can:

- switch rules off, which makes them silent;
- turn the severity up or down for whole projects, statuses or issue types;
- change thresholds;
- add your own checks as JQL.

A baseline accepts findings you already know about.

| Volume | How |
|---|---|
| **Loud** | `error`. Listed, and the audit exits 2 (`--fail-on error`). The digest shows these. |
| **Normal** | `warning` (or `info` with `minLevel: info`). Listed. |
| **Quiet** | Below `minLevel`. Counted in one line per rule, not listed. |
| **Silent** | `off`. Not computed. |

## Prerequisites

- [Jira Audit](audit.md) set up (audit feature flag enabled)
- A text editor; the file is YAML

## Where the rules come from

The first file found wins; files are not merged:

1. `--rules <file>`
2. `./.atlcli/audit-rules.yaml` in the current directory: the team's rules, checked into the repository
3. `~/.atlcli/profiles/<profile>/audit-rules.yaml`: your rules for one profile
4. `~/.atlcli/audit-rules.yaml`: your rules everywhere

Without a file, the built-in profile `default` applies. The report's `Rules:` line names the source.

The [digest](../digest.md) skips the file in the current directory: it runs from wherever you start it, and a rules file's JQL runs as you. It uses the profile file, then the global one.

## Steps

1. Start from a profile and change what does not fit:

   ```yaml
   # .atlcli/audit-rules.yaml
   extends: default
   rules:
     hygiene/no-parent: off            # we do not use epics
     hygiene/stale: { warning: 30d, error: 60d }
   ```

2. Run the audit; the `Rules:` line shows the file:

   ```bash
   atlcli audit jira --project ATLCLI
   ```

3. Accept today's findings into the baseline, so that only new ones are listed:

   ```bash
   atlcli audit jira --project ATLCLI --update-baseline
   ```

## Reference

### Top level

| Key | Type | Default | Description |
|---|---|---|---|
| `version` | `1` | `1` | File format version |
| `extends` | `minimal`, `default`, `strict` | `default` | Built-in profile to start from |
| `minLevel` | `info`, `warning`, `error` | from the profile | Findings below this are quiet |
| `rules` | map rule id → setting | — | Changes to the profile, see [Rule settings](#rule-settings) |
| `custom` | list | `[]` | Your own JQL rules, see [Custom rules](#custom-rules) |
| `overrides` | list | `[]` | Settings for matching issues, see [Overrides](#overrides) |
| `baseline.olderThan` | days (`180d`) or `off` | from the profile | Legacy cutoff, see [Baseline](#baseline) |
| `flagged.field` | field id | auto-detected | The Flagged field for `hygiene/flagged` |
| `scripts` | list of file paths | `[]` | Rule scripts to load, relative to this file, see [Rule scripts](#rule-scripts) |

Unknown keys, rule ids and options are errors that name their path, e.g. `rules.hygiene/stale.warning: expected days (30d, 2w, 30) — got "soon"`.

### Profiles

| Rule | `minimal` | `default` | `strict` |
|---|---|---|---|
| `workflow/resolved-not-done` | warning | warning | error |
| `flow/stuck-wip` | off | warning p85 · error p95 | warning p85 · error p95 |
| `flow/status-aging` | off | off | warning p85 · error p95 |
| `flow/unassigned-wip` | warning | warning | error |
| `hygiene/overdue` | warning 7d · error 30d | warning 0d · error 14d | error 0d |
| `hygiene/due-soon` | off | info 3d | warning 3d |
| `hygiene/flagged` | warning 10d | warning 3d · error 10d | warning 1d · error 5d |
| `hygiene/stale` | error 90d | info 30d · warning 60d · error 90d | the same, to-do issues included |
| `hygiene/no-parent` | off | info | warning |
| `hygiene/unestimated-in-sprint` | off | warning | error |
| `hygiene/done-without-version` | off | info | warning |
| `minLevel` | warning | warning | info |
| `baseline.olderThan` | 180d | 180d | off |

- `minimal` lists only what needs action today.
- `default` adds the cheap rules and keeps info findings quiet.
- `strict` lists everything, for clean-ups and coaching.

### Rule settings

Rules are of two kinds.

**Flag rules** take a level: `off`, `info`, `warning` or `error`. These are `workflow/resolved-not-done`, `flow/unassigned-wip`, `hygiene/no-parent`, `hygiene/unestimated-in-sprint` and `hygiene/done-without-version`.

```yaml
rules:
  flow/unassigned-wip: error
```

**Threshold rules** take thresholds per severity. The most severe one passed wins. These are `flow/stuck-wip`, `flow/status-aging`, `hygiene/overdue`, `hygiene/due-soon`, `hygiene/flagged` and `hygiene/stale`.

```yaml
rules:
  hygiene/stale: { info: 30d, warning: 60d, error: 90d }
  hygiene/due-soon: { info: 5d, warning: 1d }   # days left: fewer is worse
  flow/stuck-wip: { warning: p85, error: 45d }  # percentile or days
```

| Value | Meaning |
|---|---|
| `30d`, `2w`, `30` | Days; inclusive (`>= 30`) |
| `p85` | Percentile of the done reference set; strict (`> P85`). Only `flow/stuck-wip` and `flow/status-aging`. |
| `off` | Remove that threshold, e.g. `{ info: off }` |

How settings combine:
- A settings object merges into what the profile set, so `{ error: 45d }` keeps the profile's warning threshold.
- A bare level on a threshold rule keeps only the mildest threshold, at that level: `hygiene/stale: error` means error from 30 days on.
- `off` switches the rule off.

Options for some rules:

| Option | Rule | Description |
|---|---|---|
| `include: [todo, wip]` | `hygiene/stale` | Categories that count (default `[wip]`) |
| `digest: true` | `flow/stuck-wip`, `flow/status-aging` | Also run in the digest (these read the done issues and their history, so the digest skips them by default) |

### Overrides

Overrides change rules for matching issues. They apply in order, and a later one wins:

```yaml
overrides:
  - match: { project: [GROW, VDS] }
    rules:
      hygiene/no-parent: off
      flow/stuck-wip: { warning: 60d, error: 120d }
  - match: { project: ADMIN, status: Review }
    rules:
      workflow/resolved-not-done: off
  - match: { issueType: Bug, jql: "priority in (Highest, High)" }
    rules:
      flow/unassigned-wip: error
```

| Match key | Type | Matches |
|---|---|---|
| `project` | key or list | Project key (case-insensitive) |
| `issueType` | name, id or list | Issue type |
| `status` | name, id or list | Current status. Prefer ids: Jira allows the same name in several workflows. |
| `jql` | JQL | Issues the query returns within the selection. This costs one extra search per override. |

All keys in one `match` must match.

### Custom rules

Your own checks as JQL. Each issue the query returns is a finding:

```yaml
custom:
  - id: team/bug-without-component
    jql: issuetype = Bug AND component IS EMPTY AND statusCategory != Done
    severity: warning
    message: Bug without a component.
```

| Key | Required | Description |
|---|---|---|
| `id` | yes | `<group>/<name>`, lower case, not a built-in id |
| `jql` | yes | Without `ORDER BY`; the selection (`--project`, `--board`, `--jql`) is ANDed in |
| `severity` | no | `off`, `info`, `warning` (default) or `error` |
| `message` | no | The finding's text; defaults to the id |

The query is used as written. Add `statusCategory != Done` yourself if done issues should not count. `--checks custom` runs only the custom rules, and overrides can change their level.

### Rule scripts

A check that JQL cannot express, or that should propose a fix, is a TypeScript rule script (see [Custom Audit Rules](../audit-scripts.md)). The rules file can load them:

```yaml
scripts:
  - audit/bug-without-component.ts
rules:
  team/bug-without-component: error
```

Scripts in `./.atlcli/audit/` and `~/.atlcli/audit/` load without being listed. A script's `meta.audit.defaults` and `profiles` take the place of the profile table above; `rules`, `overrides` and `--checks` treat its id like a built-in one. A script with a built-in rule's id replaces that rule.

### Baseline

The baseline lists accepted findings, as rule plus issue key, or rule plus `status:<id>` for workflow findings. It lives per profile in `~/.atlcli/profiles/<profile>/audit-baseline.json`.

| Command | Effect |
|---|---|
| `--update-baseline` | Accept every current finding, including quiet and legacy ones. Entries already there keep their date. |
| `--prune-baseline` | Remove entries that no current finding matches. The report also counts them. |
| `--no-baseline` | Ignore the baseline and the legacy cutoff for this run. |

**Legacy cutoff, the default baseline:**
- Findings on issues not updated for `baseline.olderThan` days (180 in `default` and `minimal`) count as legacy, with or without a baseline file. They are not listed one by one; the report prints one line per rule. `--no-baseline` turns the cutoff off for a run.
- The cutoff never hides `workflow/resolved-not-done`, which reports statuses.
- Once a baseline file exists, its entries apply in addition to the cutoff.

### The Flagged field

`hygiene/flagged` reads Jira's Flagged field. Its JQL name `Flagged` is the same on every site and in every language, so atlcli finds the field by that name.

The time an issue has been flagged comes from the issue history: the last time the field was set. Without that history entry, the last update stands in as a lower bound ("at least N d").

## Examples

Minimal: quiet down one rule for one project.

```yaml
overrides:
  - match: { project: MARKETING }
    rules:
      hygiene/unestimated-in-sprint: off
```

Advanced: a kanban team that runs the audit in CI.

```yaml
version: 1
extends: default
minLevel: warning

rules:
  hygiene/unestimated-in-sprint: off          # no sprints
  flow/status-aging: { warning: p85, error: p95 }
  hygiene/stale: { warning: 21d, error: 45d, include: [todo, wip] }
  hygiene/flagged: { warning: 2d, error: 5d }

custom:
  - id: team/bug-without-component
    jql: issuetype = Bug AND component IS EMPTY AND statusCategory != Done
    severity: warning
    message: Bug without a component.

overrides:
  - match: { issueType: Epic }
    rules:
      hygiene/stale: off
  - match: { jql: "priority = Highest" }
    rules:
      flow/unassigned-wip: error
      hygiene/overdue: { error: 0d }

baseline:
  olderThan: 90d
```

```bash
atlcli audit jira --board 42 --markdown > audit.md   # exits 2 when an error remains
```

## Troubleshooting

**`unknown rule "…"`.**
Use the full id, e.g. `hygiene/stale`. `atlcli audit jira --list-rules` lists all rule ids, your scripts included. A rule from a script is only known when the script is loaded: list it under `scripts:` or put it in `.atlcli/audit/`.

**`percentiles are only allowed for …`.**
Use days (`45d`) for rules other than `flow/stuck-wip` and `flow/status-aging`.

**An override does not apply.**
- Every key in `match` must match.
- `status` and `issueType` compare names case-insensitively, or ids exactly.
- A `jql` match only sees issues within the selection.

**`--checks` does not turn a rule on.**
`--checks` only narrows the active rules. Turn a rule on in the rules file, e.g. `flow/status-aging: { warning: p85 }`.

## Related topics

- [Jira Audit](audit.md)
- [Custom Audit Rules](../audit-scripts.md)
- [Flow Metrics](flow-metrics.md): status mapping and percentiles
- [Daily Digest](../digest.md): shows error-level audit findings for its projects
- [Configuration](../configuration.md)
