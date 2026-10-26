---
name: confluence-audit
description: Auditing a synced Confluence docs directory for stale pages, orphans, broken links and contributor risk with audit wiki.
metadata:
  tags: confluence, audit, stale, links, content-health
---

# Wiki audit

`atlcli audit wiki` reports content health for the pages of a local
`wiki docs` directory as findings under rules (`<category>/<name>`). Every rule
is a TypeScript script run read-only in the script sandbox; the rules file,
baseline and report are the same as for `audit jira`. `atlcli audit wiki --help`
lists every rule and option, also with the feature flag off.

## Contents

- [Prerequisites](#prerequisites)
- [Read-only runs](#read-only-runs)
- [Rules](#rules)
- [Fixes write](#fixes-write)
- [Pitfalls](#pitfalls)

## Prerequisites

1. `atlcli flag set audit true --global` (without it the command prints
   `Audit feature is not enabled`). Changing a flag edits
   `~/.atlcli/config.json`, so ask first.
2. A directory initialised and pulled with `wiki docs init` and
   `wiki docs pull`. Results describe the last pull. See
   [confluence-docs-sync.md](confluence-docs-sync.md).

## Read-only runs

```bash
atlcli audit wiki --json                          # rules file, else profile "default"
atlcli audit wiki ./docs --all --json             # older "all checks" set, min level info
atlcli audit wiki --stale-high 12 --orphans --json
atlcli audit wiki --checks links --fail-on warning
atlcli audit wiki --all --label documentation --exclude-label archived --markdown
atlcli audit wiki --output audit.csv               # findings as CSV file
atlcli audit wiki --format jsonl > findings.jsonl
atlcli audit wiki --list-rules
```

- Exit codes: 0 ran, 1 error, 2 a listed finding reached `--fail-on`
  (default `error`). Use `--fail-on never` when only reading.
- `--json` is `schemaVersion: "3"`, `product: "confluence"`; each finding has
  `rule`, `severity`, `target: { kind: "page", key, url }`, `key` (page id),
  `summary` (title), `assignee` (last editor), `detail`, `fixable`.
- Older check flags (`--stale-high|medium|low <months>`, `--orphans`,
  `--broken-links`, `--single-contributor`, `--inactive-contributors`,
  `--external-links`, `--check-external`, `--missing-label <l>`,
  `--restricted`, `--drafts`, `--archived`, `--high-churn <N>`, `--folders`)
  run only the named rules and list every finding. Months count 30 days.
- Scope: `--label`, `--under-page <pageId>`, `--exclude-label`.
- Network: `--include-remote`, `--refresh-users` and `--fix` call the API
  (need a profile); `--check-external` requests every external URL. Neither
  external check is part of `--all`.
- Baseline: `--update-baseline`, `--prune-baseline`, `--no-baseline`; stored
  in `.atlcli/audit-baseline.json` of the synced directory. No legacy cutoff.
- Reports: `--markdown`, `--template <file.j2>`, a rule's
  `report(model, out)` export. `--output <file>` writes the report (replaced
  only once complete); `--format md|json|jsonl|csv` (default from the
  `--output` extension; without `--output` to stdout); `--report <file>` =
  `--format md --output <file>`. Markdown-only options with `--format
  json|jsonl|csv` are a usage error. Details as for `audit jira`, see
  [jira-audit.md](jira-audit.md#report-files-and-formats).

## Rules

| Rule | Default profile | Older flag |
| --- | --- | --- |
| `content/stale` | info 90 d, warning 180 d, error 365 d | `--stale-*` |
| `links/orphan` | warning | `--orphans` |
| `links/broken` | warning | `--broken-links` |
| `links/external`, `links/external-broken` | off | `--external-links`, `--check-external` |
| `people/single-contributor` | info | `--single-contributor` |
| `people/inactive-contributors` | warning (run `--refresh-users` first) | `--inactive-contributors` |
| `content/missing-label` | off (option `label`) | `--missing-label` |
| `content/restricted`, `content/archived` | info | `--restricted`, `--archived` |
| `content/draft` | info | `--drafts` |
| `content/high-churn` | off | `--high-churn` |
| `structure/folders` | warning | `--folders` |
| `content/unsynced` | off | `--include-remote` |

Rules file: `confluence:` section of `.atlcli/audit-rules.yaml` (`extends`,
`minLevel`, `rules`, `scripts`). Custom rules: `atlcli audit init --product
confluence` writes a skeleton to `.atlcli/audit/`; a rule gets an `AuditPage`
per page and returns `rule.finding({ detail })`. Rules must not write.

## Fixes write

`--fix` plans the `fix` exports of the listed findings and changes nothing:

| Rule | Planned change |
| --- | --- |
| `content/stale` | archive pages not edited for 730+ days; label other error-level pages (`--fix-label`, default `needs-review`) |
| `links/orphan` | trash orphans not edited for a year |
| `content/missing-label` | add the missing labels |

```bash
atlcli audit wiki --fix                          # show the plan
atlcli audit wiki --fix --plan-out fixes.json    # save it
atlcli script apply fixes.json                   # apply after the user approved
```

`--fix --apply` asks before applying; `--yes` skips the question. Show the
plan to the user and get approval before `--apply --yes` or `script apply`.
Archive and trash are visible to everyone in the space. `--dry-run` no
longer exists: the plan is the preview.

## Pitfalls

- With no check flag the default profile runs, and errors exit 2.
- `--all` includes stale pages with the profile thresholds; combined with
  `--fix` that labels or archives many pages. Read the plan.
- Confluence archives in the background; a page can read as current briefly.
- A page can appear under both contributor rules.

Related: [confluence-docs-sync.md](confluence-docs-sync.md),
[safety.md](safety.md).
