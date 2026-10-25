---
title: "Wiki Audit"
description: "atlcli audit wiki: stale, orphaned, badly linked or single-maintainer pages in a synced space, under configurable rules"
---

# Wiki Audit

`atlcli audit wiki` checks the pages of a synced docs directory for content that needs attention:
- pages nobody edited for months;
- orphans and broken internal links, and external links that no longer answer;
- pages with one contributor or no active one (bus factor);
- missing labels, restrictions, drafts, archived pages, heavily edited pages and folder problems.

It reads the local sync database, so it describes the last pull. It only reports. Changes happen only when you ask for them with `--fix`, as a plan you review first.

Every check is a TypeScript rule script that runs read-only in the [script sandbox](../scripts.md). The same rules file, baseline and report format as [Jira Audit](../jira/audit.md) apply, and you can add or replace rules: see [Custom Audit Rules](../audit-scripts.md).

:::caution[Changes in this version]
- Output is the shared audit report (`--json` is `schemaVersion: "3"`, findings carry `target.kind: "page"`); the old per-check JSON and table layout are gone.
- Without any check flag the built-in profile `default` runs (before: an error unless `audit.defaultChecks` was set).
- The audit exits 2 when an error-level finding is listed. Pass `--fail-on never` to keep exit 0.
- `--fix` plans its changes for review instead of applying labels at once and prompting for archive and delete. `--dry-run` is gone: the plan is the preview. The "write a report" fix action is replaced by `--report <file>`.
- `--all` now includes stale pages with the profile thresholds (90 / 180 / 365 days) when no `--stale-*` flag is given.
- A page can show up under both contributor rules; the old report counted it once.
:::

## Prerequisites

- The audit feature flag, shared with Jira Audit: `atlcli flag set audit true --global`
- A directory set up with `atlcli wiki docs init` and pulled with `atlcli wiki docs pull` (see [Sync](sync.md))
- A profile for `--fix`, `--include-remote` and `--refresh-users`; the plain audit works offline

## Steps

1. Pull, then audit with the built-in rules:

   ```bash
   cd docs
   atlcli wiki docs pull
   atlcli audit wiki
   ```

   Warnings and errors are listed, info findings are counted as quiet.

2. Make inactive contributors known (reads user status from Confluence):

   ```bash
   atlcli audit wiki --refresh-users
   ```

3. Accept what is there today, so that only new findings show up:

   ```bash
   atlcli audit wiki --update-baseline
   ```

4. Adjust the rules in the `confluence:` section of `.atlcli/audit-rules.yaml` (see [Configuration](#configuration)).

5. Review and apply the proposed fixes:

   ```bash
   atlcli audit wiki --fix              # shows the plan, changes nothing
   atlcli audit wiki --fix --apply      # asks, then applies
   ```

## Rules

Each rule has an id `<category>/<name>`. `--list-rules` lists them with their source; `--print-rule <id>` prints a rule's script. The older check flags still select rules (last column).

| Rule | `minimal` / `default` / `strict` | Finds | Older flag |
|---|---|---|---|
| `content/stale` | error 365 d / info 90 d, warning 180 d, error 365 d / as default | Not edited for that long | `--stale-high/-medium/-low <months>` |
| `links/orphan` | off / warning / warning | No incoming links and no parent | `--orphans` |
| `links/broken` | warning / warning / error | Broken internal links, one finding per link | `--broken-links` |
| `links/external` | off | Inventory of external URLs | `--external-links` |
| `links/external-broken` | off | External URLs that fail over HTTP | `--check-external` |
| `people/single-contributor` | off / info / warning | Only one contributor | `--single-contributor` |
| `people/inactive-contributors` | off / warning / warning | No active contributor left | `--inactive-contributors` |
| `content/missing-label` | off | A required label is missing (option `label`) | `--missing-label <label>` |
| `content/restricted` | off / info / info | View or edit restrictions | `--restricted` |
| `content/draft` | off / info / warning | Unpublished drafts | `--drafts` |
| `content/archived` | off / info / info | Archived pages | `--archived` |
| `content/high-churn` | off | Many versions (thresholds count versions) | `--high-churn <N>` |
| `structure/folders` | warning | Empty folders, folders without `index.md` | `--folders` |
| `content/unsynced` | off | In Confluence but not synced | `--include-remote` |

### Selecting checks

- **No check flag:** the rules file's `confluence:` section, else the built-in profile `default`. `audit.defaultChecks` in `~/.atlcli/config.json`, if set, acts like the check flags.
- **Older check flags** (`--orphans`, `--stale-high 12`, …): only the named rules run, and every finding is listed (min level info). `--stale-*` months count as 30 days each and map to error (high), warning (medium) and info (low).
- **`--all`:** stale, orphans, broken links, both contributor rules, folders, restricted, drafts and archived, listed at min level info. The external-link rules are not included.
- **`--checks <list>`:** narrows the active rules to rule ids, categories (`content`, `links`, `people`, `structure`) or the older names. It turns rules off, never on.

`links/external-broken` makes an HTTP request to every external URL (5 at a time, 10 s timeout). `content/unsynced` and `--include-remote` list the space's pages through the API.

## Fixes

Three built-in rules propose fixes. `--fix` runs them for the listed findings only (not for quiet, legacy or baseline findings) and shows the plan:

| Rule | Fix |
|---|---|
| `content/stale` | Archives pages not edited for 730 days or more; adds a label to other error-level pages (`--fix-label`, or the rule option `label`; default `needs-review`) |
| `links/orphan` | Moves orphans not edited for a year to the trash |
| `content/missing-label` | Adds the missing labels |

```bash
atlcli audit wiki --fix                          # the plan
atlcli audit wiki --fix --apply                  # apply after a question (--yes skips it)
atlcli audit wiki --fix --plan-out fixes.json    # review, then: atlcli script apply fixes.json
```

Only synced pages are fixed. Confluence archives in the background, so an archived page can read as current for a moment. Deleting moves the page to the space trash.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `[dir]`, `--dir` | path | `.` | Synced directory to audit |
| `--rules` | file path | first rules file found | Rules file; its `confluence:` section is used |
| `--checks` | comma-separated | all active rules | Only these rules (ids, categories, older names) |
| `--all` | flag | off | The older "all checks" set, see [Selecting checks](#selecting-checks) |
| `--stale-high`, `--stale-medium`, `--stale-low` | months | — | Stale thresholds for error / warning / info |
| `--orphans`, `--broken-links`, `--single-contributor`, `--inactive-contributors`, `--external-links`, `--check-external`, `--restricted`, `--drafts`, `--archived`, `--folders` | flag | off | Run that rule |
| `--missing-label` | label | — | Run `content/missing-label` for this label |
| `--high-churn` | versions | — | Run `content/high-churn` from this many versions |
| `--label` | label | — | Only pages with this label |
| `--under-page` | page id | — | Only pages under this ancestor |
| `--exclude-label` | label | — | Leave out pages with this label |
| `--include-remote` | flag | off | Also pages in Confluence that are not synced |
| `--min-level` | `info`, `warning`, `error` | rules `minLevel` | List findings from this level |
| `--fail-on` | `info`, `warning`, `error`, `never` | `error` | Exit 2 when a listed finding reaches it |
| `--update-baseline` | flag | off | Accept every current finding into the baseline |
| `--prune-baseline` | flag | off | Remove baseline entries no finding matches |
| `--no-baseline` | flag | off | Ignore the baseline |
| `--markdown` | flag | off | Markdown report (a Jinja template; `--print-template` prints it) |
| `--template` | file path | — | Render the report with your own [Jinja](../templating.md) template |
| `--report` | file path | stdout | Write the Markdown report to a file |
| `--report-script` | rule id | last rule with one | Build the report with this rule's `report` export |
| `--json` | flag | off | JSON report (`schemaVersion: "3"`) |
| `--script` | file path, repeatable | — | Add a rule script |
| `--list-rules` | flag | off | List the rules with their source |
| `--print-rule` | rule id | — | Print a rule's script |
| `--fix` | flag | off | Plan the fixes of the listed findings |
| `--apply`, `--yes` | flag | off | With `--fix`: apply the plan; `--yes` skips the question |
| `--plan-out` | file path | — | With `--fix`: save the plan for `atlcli script apply` |
| `--fix-label` | label | `needs-review` | Label `content/stale` adds |

### Maintenance options

| Option | Description |
|---|---|
| `--refresh-users` | Refresh users' active/inactive status from the API (needs a profile) |
| `--rebuild-graph` | Re-extract links from the synced Markdown files |
| `--export-graph` | Print the link graph as JSON |

Run alone, `--refresh-users` and `--rebuild-graph` do only their job; add a check flag or `--checks` to audit in the same run.

## Configuration

Rules come from the `confluence:` section of the first rules file found: `--rules`, `./.atlcli/audit-rules.yaml`, `~/.atlcli/profiles/<profile>/audit-rules.yaml`, `~/.atlcli/audit-rules.yaml`. The grammar is the one of [Audit Rules](../jira/audit-rules.md); a Jira section in the same file is independent.

```yaml
confluence:
  extends: default            # minimal | default | strict
  minLevel: warning
  rules:
    content/stale: { warning: 120d, error: 365d }
    content/missing-label: { severity: warning, label: [owner] }
    people/single-contributor: off
  scripts:
    - audit/owner-label.ts    # relative to this file
```

| Key | Type | Default | Description |
|---|---|---|---|
| `extends` | `minimal`, `default`, `strict` | `default` | Built-in profile to start from |
| `minLevel` | `info`, `warning`, `error` | from the profile | Findings below are quiet |
| `rules` | map rule id → setting | — | Changes to the profile |
| `scripts` | list of paths | `[]` | Rule scripts to load |

**Baseline:** `.atlcli/audit-baseline.json` in the synced directory, so it belongs to the space and works without a profile. Wiki audits have no legacy cutoff: old pages are what the stale rule is for.

**Older settings** in `~/.atlcli/config.json` still work when no check flag is given:

```json
{
  "audit": {
    "defaultChecks": ["stale", "orphans", "broken-links"],
    "staleThresholds": { "high": 12, "medium": 6, "low": 3 }
  }
}
```

| Key | Type | Description |
|---|---|---|
| `defaultChecks` | list of older check names | Rules to run, like the check flags |
| `staleThresholds.high` / `.medium` / `.low` | months | Stale thresholds for error / warning / info |

## Examples

Minimal:

```bash
atlcli audit wiki
```

```
Wiki audit: 31 finding(s) — 0 error, 31 warning, 0 info
Scope: space DOCSY
Rules: built-in profile default (extends default, min level warning)

Stale pages — content/stale (30)
  [warning] 623870077  Neue Seite zum Syncen (Ann) — Not edited for 9 months (last 2026-01-10).
  ...

Orphaned pages — links/orphan (1)
  [warning] 623936140  Scratch notes (Ann) — No incoming links and no parent.

Quiet: 188 finding(s) below warning (content/stale 68, people/single-contributor 120); --min-level info lists them.
```

Advanced: one label, a strict profile, JSON for a dashboard, no exit code:

```bash
atlcli audit wiki --label documentation --rules team-rules.yaml --fail-on never --json
```

```json
{
  "schemaVersion": "3",
  "product": "confluence",
  "generatedAt": "2026-10-25T21:26:21.028Z",
  "query": "space DOCSY label documentation",
  "rules": { "source": "/work/docs/team-rules.yaml", "extends": "strict", "minLevel": "info" },
  "summary": {
    "total": 1,
    "bySeverity": { "error": 0, "warning": 1, "info": 0 },
    "byRule": { "content/stale": 1 },
    "suppressed": { "quiet": 0, "baseline": 0, "legacy": 0 }
  },
  "findings": [
    {
      "rule": "content/stale",
      "category": "content",
      "severity": "warning",
      "target": { "kind": "page", "key": "623870077", "url": "https://example.atlassian.net/wiki/pages/viewpage.action?pageId=623870077" },
      "key": "623870077",
      "summary": "Neue Seite zum Syncen",
      "status": "current",
      "assignee": "Ann",
      "detail": "Not edited for 9 months (last 2026-01-10).",
      "ageDays": 288,
      "subject": "623870077",
      "fixable": true
    }
  ],
  "quiet": {},
  "legacy": {},
  "legacyDays": null,
  "staleBaselineEntries": 0,
  "partial": [],
  "diagnostics": [],
  "titles": { "content/stale": "Stale pages" }
}
```

`assignee` is the page's last editor. `subject` is what the baseline records.

CI: fail on warnings in links, write the report as an artifact:

```bash
atlcli audit wiki --checks links --fail-on warning --report audit.md
```

## Editor format

The `docs status` command reports on Confluence editor formats:

```bash
# View editor format breakdown
atlcli wiki docs status ./docs
```

Output includes:

```
Editor format:
  new editor (v2):    25 pages
  legacy editor (v1): 3 pages
  unknown:            2 pages

Legacy/unknown editor pages:
  old-page.md
  imported-doc.md
```

| Format | Description |
|--------|-------------|
| **v2 (new editor)** | Pages using Confluence's new editor with colored callouts |
| **v1 (legacy)** | Pages explicitly set to legacy editor (grey callouts) |
| **unknown** | Pages without editor property (typically older pages) |

### Converting editor formats

Convert pages between editor formats:

```bash
# Convert a single page to new editor
atlcli wiki docs convert ./docs/old-page.md --to-new-editor

# Convert all pages in directory to new editor (preview first)
atlcli wiki docs convert ./docs --to-new-editor --dry-run

# Apply conversion to all pages
atlcli wiki docs convert ./docs --to-new-editor --confirm

# Convert back to legacy editor if needed
atlcli wiki docs convert ./docs/page.md --to-legacy-editor
```

| Flag | Description |
|------|-------------|
| `--to-new-editor` | Convert to v2 (new editor) |
| `--to-legacy-editor` | Convert to v1 (legacy editor) |
| `--dry-run` | Preview changes without applying |
| `--confirm` | Required for directory-wide conversion |

:::tip[New pages default to v2]
Pages created with `atlcli wiki docs push` or `atlcli wiki docs add` automatically use the new editor. Use `--legacy-editor` flag to opt out.

:::

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The audit ran; no listed finding reached `--fail-on` |
| 1 | No sync directory, a request failed, or the arguments or rules file were wrong |
| 2 | A listed finding reached `--fail-on` (default: an error) |

## Troubleshooting

**`No .atlcli directory found`.**
Run `atlcli wiki docs init <dir> --space KEY` and `atlcli wiki docs pull` first, or pass the directory.

**`User status never checked`.**
`people/inactive-contributors` needs user status. Run `atlcli audit wiki --refresh-users`.

**The audit exits 2 in a script that used to pass.**
Error-level findings now fail the run. Pass `--fail-on never`, or lower the rule in the rules file.

**`--fix` fails with `No active profile`.**
Fixes and rules that read through `atlcli.*` need a profile: `--profile <name>` or `atlcli auth login`.

**An archived page still shows as current.**
Confluence archives in the background. Pull again after a moment.

**External link checks take long.**
Each URL gets one request, 5 at a time with a 10-second timeout. Leave `--check-external` for scheduled runs.

**Stale pages look wrong.**
The audit reads `lastModified` from the last pull. Pull first.

## Related topics

- [Custom Audit Rules](../audit-scripts.md)
- [Audit Rules](../jira/audit-rules.md): rules-file grammar
- [Jira Audit](../jira/audit.md)
- [Folders](folders.md#validating-folders)
- [Sync](sync.md) and [Storage](storage.md)
- [Configuration](../configuration.md)
