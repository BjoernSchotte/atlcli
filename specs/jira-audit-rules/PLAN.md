# Jira audit rules: configurable severity, scope and suppression

Status: **Concept, decisions recorded** (2026-10-22). Plan only, nothing implemented.

## Problem

`atlcli audit jira` runs fixed rules with fixed severities. Real projects differ:

- A rule that matters for one team is noise for another. A kanban team has no use for `unestimated-in-sprint`; a marketing project does not care about `no-parent`.
- Some findings are *known and accepted*, such as an old backlog or an epic that stays open on purpose. Without a way to accept them, the report stays loud forever, and people stop reading it.
- Some findings should be *louder*: "a blocker has no assignee" is an error for one team and info for another.
- The `workflow` rule cannot tell a misplaced done status (GROW "Fertig") from issues that kept a resolution after reopening (ADMIN "Review"). The user decides which one applies, and should be able to record that decision.
- Team-specific checks, such as "bugs without a component" or "stories without acceptance criteria", are plain JQL today and have no place in the audit.

## Prior art (research summary, 2026-10-22)

- **Jira apps.**
  - Data Health for Jira and Harness SEI scope each rule by project, issue type, status and extra JQL.
  - Stale Work Guard and Time in Status use tiered thresholds (warning, critical).
  - Seatbelt runs query rules (SQL) whose hits are findings, with severities error, warning and info and categories integrity, policy and health.
  - Smart Admin runs JQL custom tests with manual overrides per item.
  - Time in Status supports snooze and ignore per issue.
  - ActionableAgile sets aging thresholds per workflow column, as percentile bands.
- **Linters.**
  - ESLint: `off`, `warn` and `error`, overrides by glob, inline disables, and a committed suppressions file with pruning.
  - Vale: `MinAlertLevel` separates "what is it" from "what do I show".
  - SonarQube: quality profiles, and "accepted" / "false positive" per finding.
  - PHPStan: a baseline file.
- **Gaps in atlcli** compared with these tools: overdue and due soon, flagged or blocked too long, required fields (priority, component, description), epic without fix version, sprint carry-over, and aging per status.

## Goals

1. Per rule: `off | info | warning | error`. `off` means silent (not computed). Below `minLevel` means quiet (computed and counted, not listed). `error` means loud (exit code 1 when present).
2. Thresholds per rule. Severity follows from tiered thresholds (`stale: { info: 30, warning: 60, error: 90 }`).
3. Scoped overrides by project, issue type, status or JQL. They are evaluated in order, and the last match wins.
4. Suppression in two places: a baseline file for existing findings, and overrides in the rules file (which also accept a misplaced workflow status per project).
5. Custom JQL rules: every hit is a finding, and the scope is ANDed in.
6. Report-only stays: atlcli never writes labels, transitions issues or edits workflows.
7. The digest shows loud (`error`) findings for its configured projects as an "Audit" section.

## Non-goals

- Notifications and scheduling. cron or CI combined with `--json` or the digest cover these.
- A rule DSL beyond JQL.
- Configuration audits (unused fields, automation owners). These would be a separate command, if ever.

## Config sketch

The rules live in `.atlcli/audit-rules.yaml` in the project directory (versioned with the team), with a fallback to `audit.jira.rules` in `~/.atlcli/config.json`. A `--rules <file>` flag overrides both.

```yaml
version: 1
minLevel: warning            # quiet: info findings only counted
extends: default             # built-in profile: default | strict | minimal

rules:
  workflow/resolved-not-done: warning
  flow/stuck-wip: { warning: p85, error: p95 }
  flow/unassigned-wip: warning
  hygiene/stale: { info: 30d, warning: 60d, error: 90d, include: [wip] }
  hygiene/no-parent: off
  hygiene/unestimated-in-sprint: warning
  hygiene/done-without-version: info
  hygiene/overdue: { warning: 0d, error: 14d }          # new: due date passed by N days
  hygiene/due-soon: { info: 3d }                        # new: due within N days
  hygiene/flagged: { warning: 3d, error: 10d }          # new: flagged (impediment) for N days
  flow/status-aging: { warning: p85, error: p95 }       # new: time in the current status vs. that status's history

custom:
  - id: team/bug-without-component
    jql: issuetype = Bug AND component IS EMPTY AND statusCategory != Done
    severity: warning
    message: Bug without a component.

overrides:
  - match: { project: GROW }
    rules:
      hygiene/no-parent: off
      flow/stuck-wip: { warning: 60d, error: 120d }     # absolute days instead of percentiles
  - match: { project: ADMIN, status: Review }
    rules:
      workflow/resolved-not-done: off                    # accepted: reopened issues keep a resolution
  - match: { jql: "priority = Highest" }
    rules:
      flow/unassigned-wip: error

baseline:
  olderThan: 180d            # default baseline, see "Baseline" below
```

## Behaviour

- **Rule ids** are stable, in the form `<category>/<rule>`. The old flat names (`stuck-wip`) remain aliases for `--checks`.
- **Severity resolution** for each finding:
  1. the base rule;
  2. `extends`;
  3. `rules`;
  4. every matching `override`, in order;
  5. the baseline;
  6. `minLevel` for display.
- **Matching overrides:**
  - `project`, `issueType` and `status` are matched in memory: by key or name (case-insensitive), or by id.
  - A `jql` match runs one extra search per distinct JQL and is matched by issue key. The report states this cost.
- **Baseline:**
  - **Location:** per profile, at `~/.atlcli/profiles/<profile>/audit-baseline.json`, next to the digest state.
  - **Accepted findings:** `--update-baseline` writes `{ rule, key, acceptedAt }` entries. Findings listed there are dropped from the report and counted under `suppressed.baseline`.
  - **Pruning:** `--prune-baseline` removes stale entries. A stale entry is reported as info, following ESLint.
  - **Per-status rules:** for rules such as `workflow`, the key is the status id.
  - **Default baseline, when no file exists:** a baseline lists concrete findings, so atlcli cannot ship one. The default is therefore an age cutoff: `olderThan: 180d`.
    - Findings on issues not updated for 180 days are treated as legacy. They are not listed one by one, only counted per rule as one quiet line ("41 legacy findings, older than 180 days; `--update-baseline` to accept, `--no-baseline` to list").
    - This keeps the first run on an old project short without hiding anything.
    - The cutoff does not apply to `workflow`, which reports statuses, nor to the `stale` error level at its own thresholds below 180 days.
    - The cutoff can be configured or switched off in the rules file (`baseline.olderThan: off`).
    - Once a baseline file exists, its entries apply in addition to the cutoff.
- **Status aging:**
  - Each status gets its own percentile bands, computed from the time issues done in the last 90 days spent in that status.
  - Five samples per status are needed; with fewer, the rule is skipped for that status with a note.
  - The time an open issue has spent in its current status is compared against these bands.
- **Digest:** the digest runs the rules for its `--project` / `digest.projects` and lists the remaining `error` findings in an "Audit" section. It skips the expensive rules (`stuck-wip`, `status-aging`) unless the rules file enables them for the digest (`digest: true` per rule).
- **Partial coverage:** when a search hits `--limit`, the affected rule is marked `partial` in the report, not only in a global note.
- **Exit code:** 1 if any `error` finding remains after suppression; `--fail-on warning` makes the check stricter.
- **Output:** JSON gains `rule`, `category`, `suppressed` counts per reason, and `partial`. Text and Markdown show the counts of quiet findings in one line.

## Workflow rule refinement

`resolved-not-done` should tell its two cases apart by itself, using one count per flagged status (`status = X` versus `status = X AND resolution IS NOT EMPTY`):

- **Most** issues in the status are resolved: *the status probably means done*. The finding suggests fixing the workflow or the map.
- **Few** issues are resolved: *these issues kept a resolution after reopening*. The finding lists the keys and suggests clearing the resolution.

The threshold is configurable (`share: 0.5`).

## Tasks (rough)

1. Rule registry with ids, categories, defaults and aliases. Migrate the existing checks.
2. YAML loader with a JSON schema and validation, using clear errors with path and line. Built-in profiles.
3. Severity resolution: overrides, labels, baseline, `minLevel`. Pure, with table tests.
4. Custom JQL rules.
5. Baseline write and prune.
6. New rules: overdue, due-soon, flagged, status-aging.
7. Workflow rule refinement (the share split).
8. Digest "Audit" section (`error` only).
9. Docs: an audit-rules reference page with minimal and advanced examples. Live E2E on ATLCLI.

## Decisions (2026-10-22)

- **Rules file location:** both. The project file `.atlcli/audit-rules.yaml` wins over `~/.atlcli` (`audit.jira.rules`), and `--rules` wins over both.
- **Suppression:** a baseline file and overrides only. Jira labels are not used.
- **Digest:** an "Audit" section with `error` findings only.
- **New rules in the first stage:** overdue / due soon, flagged too long, aging per status. Epic without fix version is deferred.

- **Baseline:** per profile. Without a file, the default is the 180-day legacy cutoff.

## Built-in profiles (`extends`)

The proposal has three profiles. `default` applies when `extends` is not set:

| Rule | `minimal` | `default` | `strict` |
|---|---|---|---|
| `workflow/resolved-not-done` | warning | warning | error |
| `flow/unassigned-wip` | warning | warning | error |
| `hygiene/overdue` | warning 7d · error 30d | warning 0d · error 14d | error 0d |
| `hygiene/due-soon` | off | info 3d | warning 3d |
| `hygiene/flagged` | warning 10d | warning 3d · error 10d | warning 1d · error 5d |
| `flow/stuck-wip` | off | warning p85 · error p95 | warning p85 · error p95 |
| `flow/status-aging` | off | off (expensive) | warning p85 · error p95 |
| `hygiene/stale` | error 90d (wip) | info 30 · warning 60 · error 90 (wip) | the same, including to do |
| `hygiene/no-parent` | off | info | warning |
| `hygiene/unestimated-in-sprint` | off | warning | error |
| `hygiene/done-without-version` | off | info | warning |
| `minLevel` | warning | warning | info |
| default baseline | 180d | 180d | off |

- **`minimal`:** only what needs action today. It suits teams that should not be put off by the audit.
- **`default`:** today's rules plus the cheap new ones. Info findings are quiet, so they are counted but not listed.
- **`strict`:** everything on and everything listed, with no legacy cutoff. Use it for cleanups and coaching.

`default` changes today's behaviour in two ways: info findings become quiet, and the legacy cutoff applies. `--min-level info` and `--no-baseline` restore the full list.

## Flagged field

- **Live facts (verified 2026-10-22):**
  - The "Flagged" field is a custom field (`customfield_10021` on this site) of type multi-checkboxes, with the value "Impediment".
  - Its JQL clause name `Flagged` is stable across sites and languages. `Flagged is not EMPTY` returns issues.
- **Detection:**
  - Read `/field` once.
  - Pick the field whose `clauseNames` include `Flagged` and whose type is multicheckboxes.
  - Cache the id per run, the way `detectStoryPointsField` does.
- **Override:** `flagged.field: customfield_12345` in the rules file, or `--flagged-field`. This covers sites with their own "blocked" field.
- **Duration:** from the changelog, the last change of that field id (`fieldId`, not the localized `field` name) from empty to set. Without a changelog entry, the issue's `updated` is used as a lower bound, and the finding says so.
- **Without the field:** the rule is skipped with a note, not an error.

## Open questions

None at the moment. The plan is ready for review.
