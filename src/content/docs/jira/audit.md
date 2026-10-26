---
title: "Jira Audit"
description: "atlcli audit jira: stuck, stale, overdue or flagged work and workflow gaps, under configurable rules"
---

# Jira Audit

`atlcli audit jira` checks a set of Jira issues for work that needs attention. It finds:
- items stuck in progress or aging in a status;
- unassigned work, overdue and flagged issues, stale issues;
- gaps such as missing epics or estimates;
- workflows whose done statuses sit in the wrong category.

It only reports. Changes happen only when you ask for them with `--fix`, as a plan you review first.

Every rule is a TypeScript script that runs read-only in the [script sandbox](../scripts.md). You can print a built-in rule, replace it with your own version, or add rules of your own: see [Custom Audit Rules](../audit-scripts.md).

Which findings are loud, quiet or silent is up to you: a [rules file](audit-rules.md) sets severities, thresholds and exceptions per project, status or issue type, and a baseline accepts findings you already know about.

Flow metrics answer "how fast do we deliver" ([Flow Metrics](flow-metrics.md)). The audit answers "what should we act on", and uses the same issue selection and status mapping.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects
- The audit feature flag, shared with [Wiki Audit](../confluence/audit.md):

  ```bash
  atlcli flag set audit true --global
  ```

## Steps

1. Audit a project with the built-in rules:

   ```bash
   atlcli audit jira --project ATLCLI
   ```

   Warnings and errors are listed. Info findings are only counted ("quiet"), and findings on issues nobody touched for 180 days are counted as legacy.

2. Accept what is there today, so that only new findings show up from now on:

   ```bash
   atlcli audit jira --project ATLCLI --update-baseline
   ```

3. Adjust the rules for your team in `.atlcli/audit-rules.yaml` (see [Audit Rules](audit-rules.md)), for example:

   ```yaml
   extends: default
   rules:
     hygiene/no-parent: off
   overrides:
     - match: { project: ATLCLI, status: Review }
       rules:
         workflow/resolved-not-done: off
   ```

4. Optional: add a rule of your own. `atlcli audit init` writes a skeleton to `./.atlcli/audit/`, and every rule there runs with the built-ins:

   ```bash
   atlcli audit init
   atlcli audit jira --project ATLCLI --list-rules
   ```

5. Use it in CI or cron: the audit exits 2 when an error-level finding remains.

   ```bash
   atlcli audit jira --board 42 --markdown > jira-audit.md || echo "audit errors"
   ```

## Rules

The audit reads the open issues of the selection and, for some rules, the issues done in the last 90 days. Each rule has an id `<category>/<name>`. `--list-rules` lists them with their source, and `--print-rule <id>` prints a rule's script.

| Rule | Default (profile `default`) | Finds |
|---|---|---|
| `workflow/resolved-not-done` | warning | A status holds resolved issues but sits outside the Done category. One finding per status. |
| `flow/stuck-wip` | warning above P85, error above P95 | In progress longer than the cycle time of the issues done in the last 90 days. |
| `flow/status-aging` | off | Longer in the current status than issues usually spend there (per-status P85/P95). |
| `flow/unassigned-wip` | warning | In progress without an assignee. |
| `hygiene/overdue` | warning from the due date, error after 14 days | Due date passed, not done. |
| `hygiene/due-soon` | info within 3 days | Due date close, not done. |
| `hygiene/flagged` | warning after 3 days, error after 10 | Flagged (impediment), counted from when the flag was set. |
| `hygiene/stale` | info 30, warning 60, error 90 days | Not updated; in-progress issues only unless `include: [todo, wip]` or `--all`. |
| `hygiene/no-parent` | info | Neither an epic nor a subtask, and no parent. |
| `hygiene/unestimated-in-sprint` | warning | In an open sprint without story points. |
| `hygiene/done-without-version` | info | Done in the last 90 days without a fix version, where the project has versions. |

Epics are left out of `flow/stuck-wip` and `flow/status-aging` and of their reference sets: an epic runs as long as its children.

The profiles `minimal` and `strict` and every option are listed in [Audit Rules](audit-rules.md).

### Misconfigured workflows

`workflow/resolved-not-done` looks at categories and history, not names. Jira sets a resolution when work is finished. A status that holds resolved issues outside the Done category makes every category-based number count that work as open: flow metrics, `flow/stuck-wip`, and the digest's "Waiting on you".

The issue history shows which of two cases applies, and the finding says so:

- **The transition into the status set the resolution.** The workflow treats the status as done. If it means done, move it to the Done category in the workflow (preferred), or map it: `--status-map "Fertig=done"` or `flow.statusMap` (see [Status mapping](flow-metrics.md#status-mapping)). If the status does *not* mean done, for example a review status, the transition into it should not set a resolution.
- **The resolution was set elsewhere and kept.** The issues were resolved, then moved back into this status without clearing the resolution. Clear it on those issues.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `--project` | project key | `global.project` | Select the project's issues |
| `--board` | board id | `global.board` | Select the issues of the board's saved filter |
| `--jql` | JQL | — | Any JQL; wins over `--board` and `--project` |
| `--rules` | file path | first rules file found | Rules file to use, see [Audit Rules](audit-rules.md#where-the-rules-come-from) |
| `--checks` | comma-separated | all active rules | Only these: rule ids, categories (`workflow`, `flow`, `hygiene`, `custom`), or the older names `stuck-wip`, `unassigned-wip`, `stale`. Turns rules off; never on. |
| `--min-level` | `info`, `warning`, `error` | rules file `minLevel` | List findings from this level; lower ones are counted as quiet |
| `--fail-on` | `info`, `warning`, `error`, `never` | `error` | Exit 2 when a listed finding reaches this level |
| `--update-baseline` | flag | off | Accept every current finding into the profile's baseline |
| `--prune-baseline` | flag | off | Remove baseline entries no finding matches any more |
| `--no-baseline` | flag | off | Ignore the baseline and the legacy cutoff |
| `--all` | flag | off | Include to-do issues in `hygiene/stale` |
| `--stale` | `a,b,c` days, ascending | `30,60,90` | Stale thresholds for info / warning / error |
| `--status-map` | `"<status>=todo\|wip\|done,…"` | — | Override status categories (see [Flow Metrics](flow-metrics.md#status-mapping)) |
| `--points-field` | field id | auto-detected | Story points field for `hygiene/unestimated-in-sprint` |
| `--flagged-field` | field id | auto-detected | Flagged field for `hygiene/flagged` |
| `--limit` | integer ≥ 1 | `1000` | Most issues per query; hitting it marks the report partial |
| `--markdown` | flag | off | Markdown report with one table per rule (a Jinja template; `--print-template` prints it) |
| `--template` | file path | — | Render the report with your own [Jinja](../templating.md) template; other templates in its directory can be included |
| `--output` | file path | stdout | Write the report to this file, replaced only once complete; parent directories are created. See [Report files and formats](#report-files-and-formats) |
| `--format` | `md`, `json`, `jsonl`, `csv` | from the `--output` extension, else the text report | Report format; without `--output` it goes to stdout |
| `--report` | file path | — | Same as `--format md --output <file>` |
| `--report-script` | rule id | last rule with one | Build the report with this rule's `report` export |
| `--json` | flag | off | JSON report (`schemaVersion: "3"`) |
| `--script` | file path, repeatable | — | Add a rule script (see [Custom Audit Rules](../audit-scripts.md)) |
| `--list-rules` | flag | off | List the rules with their source, fix and report exports |
| `--print-rule` | rule id | — | Print a rule's script, built-ins included |
| `--fix` | flag | off | Plan the `fix` exports of the listed findings; nothing changes |
| `--apply` | flag | off | With `--fix`: apply the plan (asks first; `--yes` skips the question) |
| `--plan-out` | file path | — | With `--fix`: save the plan for `atlcli script apply` |
| `--concurrency` | 1–32 | `1` | With `--fix --apply`: operations in flight at once |

### Configuration

- **Rules:** see [Audit Rules](audit-rules.md).
- **Stale thresholds without a rules file:** `audit.jira.staleDays` in `~/.atlcli/config.json`, globally or per profile, still applies. `--stale` wins over it.

  ```json
  {
    "audit": { "jira": { "staleDays": [14, 30, 60] } }
  }
  ```

- **Status mapping:** comes from `flow.statusMap`, as for flow metrics.

## Report files and formats

`--output <file>` writes the report to a file. The file is replaced only once the report is complete, so a failed run keeps the old file. stderr says `Report written to <file> (<size>)`; with `--json`, stdout still gets the JSON report.

| Format | Content | Chosen by |
|---|---|---|
| `md` | Markdown, see below | `--format md`, `--report <file>`, or an `--output` file with any other extension |
| `json` | Exactly the `--json` report (`schemaVersion: "3"`) | `--format json` or `.json` |
| `jsonl` | One finding per line (JSON Lines) | `--format jsonl`, `.jsonl` or `.ndjson` |
| `csv` | One finding per row: `severity,rule,key,summary,status,assignee,detail,ageDays,url`; RFC 4180 quoting, CRLF | `--format csv` or `.csv` |

The Markdown report comes from the first of:

1. `--template <file>`: your [Jinja](../templating.md) template. Other templates in its directory (`.j2`, `.jinja`, `.md`, `.txt`, `.html`) can be included.
2. A rule's `report` export: `--report-script <id>`, or the last rule that has one (see [Custom Audit Rules](../audit-scripts.md#reports)).
3. The default template (`--markdown`; `--print-template` prints it).

`--template`, `--markdown` and `--report-script` only make Markdown: combining them with `--format json`, `jsonl` or `csv` is a usage error.

Reports stream: no format is built as one string in memory. Templates render in chunks and JSON is written one finding at a time, so large audits do not need large memory for the report. The findings themselves stay in memory for `--fail-on` and the baseline. A template error fails the audit; see [Templating: streamed rendering](../templating.md#streamed-rendering).

```bash
# Minimal: a spreadsheet of the findings
atlcli audit jira --project ATLCLI --output audit.csv

# Realistic: your team's Markdown report as a file, the findings as JSON Lines for a dashboard
atlcli audit jira --board 42 --template team.md.j2 --output reports/audit.md
atlcli audit jira --board 42 --format jsonl > findings.jsonl
```

## Examples

Minimal:

```bash
atlcli audit jira --project ADMIN
```

```
Jira audit: 12 finding(s) — 5 error, 7 warning, 0 info
Query: project = "ADMIN"
Rules: built-in profile default (extends default, min level warning)

Resolved outside Done — workflow/resolved-not-done (1)
  [warning] ADMIN-23794  Status "Review" (In Progress category) — 4 resolved issue(s); for 4 the transition into this status set the resolution (…). If the status means done, move it to Done in the workflow, or map it: --status-map "Review=done"; if not, stop that transition from setting a resolution.

Stuck in progress — flow/stuck-wip (6)
  [error] ADMIN-22432  Shut down the old website (Chris) — In progress for 94 d, above the cycle-time P95 (42.2 d).
  ...

Quiet: 21 finding(s) below warning (hygiene/no-parent 19, hygiene/done-without-version 2); --min-level info lists them.
Legacy: 41 finding(s) on issues not updated for 180 d (flow/stuck-wip 8, hygiene/stale 33); --update-baseline accepts them, --no-baseline lists them.
```

Advanced: one component, a team rules file, JSON for a dashboard, no exit code:

```bash
atlcli audit jira --jql "project = ATLCLI AND component = API" --rules team-rules.yaml --fail-on never --json
```

```json
{
  "schemaVersion": "3",
  "product": "jira",
  "generatedAt": "2026-10-22T08:00:00.000Z",
  "query": "project = ATLCLI AND component = API",
  "rules": { "source": "/work/atlcli/team-rules.yaml", "extends": "default", "minLevel": "warning" },
  "summary": {
    "total": 1,
    "bySeverity": { "error": 0, "warning": 1, "info": 0 },
    "byRule": { "flow/unassigned-wip": 1 },
    "suppressed": { "quiet": 3, "baseline": 2, "legacy": 0 }
  },
  "findings": [
    {
      "rule": "flow/unassigned-wip",
      "category": "flow",
      "severity": "warning",
      "target": { "kind": "issue", "key": "ATLCLI-12", "url": "https://example.atlassian.net/browse/ATLCLI-12" },
      "key": "ATLCLI-12",
      "summary": "Retry uploads",
      "status": "In Progress",
      "detail": "In progress without an assignee.",
      "subject": "ATLCLI-12"
    }
  ],
  "quiet": { "hygiene/no-parent": 3 },
  "legacy": {},
  "legacyDays": 180,
  "staleBaselineEntries": 0,
  "partial": [],
  "diagnostics": [],
  "titles": { "flow/unassigned-wip": "In progress without assignee" }
}
```

`subject` is what the baseline records: the issue key, or `status:<id>` for `workflow/resolved-not-done`. A finding of a rule with a `fix` export carries `"fixable": true`.

Advanced: plan the fixes of a team rule, review, then apply:

```bash
atlcli audit jira --project ATLCLI --checks team/bug-without-component --fix --plan-out fixes.json
atlcli script apply fixes.json
```

### Schema version 3

`schemaVersion` 3 replaced 2 when the rules became scripts. Version 3 adds `product`, `titles` and, per finding, `target` and `fixable`; `query` moved to the top. Everything version 2 had is still there with the same meaning.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The audit ran; no listed finding reached `--fail-on` |
| 1 | A request failed, or the arguments or the rules file were wrong |
| 2 | A listed finding reached `--fail-on` (default: an error) |

## Troubleshooting

**`--template, --markdown and --report-script make a Markdown report; drop --format or use --format md`.**
These options only produce Markdown. Drop `--format`, or write the other format in a second run.

**`Audit feature is not enabled`.**
Run `atlcli flag set audit true --global`.

**`flow/stuck-wip percentiles skipped: … need 5`.**
Fewer than 5 issues were done in the last 90 days with a known start. Day thresholds (`{ warning: 60d }`) still apply; the other rules run.

**`hygiene/unestimated-in-sprint skipped`.**
No story points field was found, or the site has no Jira Software sprints. Pass `--points-field`.

**`hygiene/flagged skipped: no Flagged field found`.**
The site has no field with the JQL name `Flagged`. Set `flagged.field` in the rules file, or pass `--flagged-field`.

**Everything shows up as stale or stuck.**
Check `workflow/resolved-not-done` first. A done status in the In Progress category keeps finished work "in progress". Map it with `--status-map "Released=done"`; the done reference set then includes that status (issues updated in the last 90 days).

**The rules file is ignored.**
Only the first file found is used: `--rules`, then `./.atlcli/audit-rules.yaml`, then the profile's, then the global one. The report's `Rules:` line names the file in use.

**`Audit rule … failed (permission-denied): audit rules only read`.**
A rule called a write verb such as `atlcli.jira.update`. Rules only read; move the change into `export async function fix(finding, issue)` and run with `--fix`.

**`… replaces the built-in rule`.**
A script in `.atlcli/audit/`, `~/.atlcli/audit/`, `scripts:` or `--script` has a built-in rule's id, so it runs instead of the built-in. That is how you adapt one; rename the id to run both.

**A finding I accepted is back.**
The baseline matches rule and issue (or rule and status). A finding under a renamed custom rule id is new. `--prune-baseline` removes entries that no longer match.

## Related topics

- [Audit Rules](audit-rules.md)
- [Custom Audit Rules](../audit-scripts.md)
- [Flow Metrics](flow-metrics.md)
- [Daily Digest](../digest.md): lists audit errors for its projects
- [Wiki Audit](../confluence/audit.md)
- [Bulk Operations](bulk-operations.md): act on findings, for example `jira bulk label`
