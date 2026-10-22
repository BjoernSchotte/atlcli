---
name: confluence-audit
description: Auditing a synced Confluence docs directory for stale pages, orphans, broken links and contributor risk with audit wiki.
metadata:
  tags: confluence, audit, stale, links, content-health
---

# Wiki audit

`atlcli audit wiki` reports content health for pages in a local `wiki docs`
directory: stale pages, orphans, broken internal links, single or inactive
contributors, restricted, draft and archived pages. The command is hidden
until its feature flag is on, so the bare `atlcli` help does not list it.

## Contents

- [Prerequisites](#prerequisites)
- [Read-only checks](#read-only-checks)
- [Fix mode writes](#fix-mode-writes)
- [Pitfalls](#pitfalls)

## Prerequisites

1. `atlcli flag set audit true --global` (without it the command prints
   `Audit feature is not enabled`). Changing a flag edits
   `~/.atlcli/config.json`, so ask first.
2. A directory initialised and pulled with `wiki docs init` and
   `wiki docs pull`. Without `.atlcli/` or `sync.db` the command stops and says
   which of the two is missing. See
   [confluence-docs-sync.md](confluence-docs-sync.md).

## Read-only checks

```bash
atlcli audit wiki --all --stale-high 12 --json
atlcli audit wiki --stale-high 12 --stale-medium 6 --orphans --broken-links ./docs --json
atlcli audit wiki --all --label documentation --exclude-label archived --json
atlcli audit wiki --all --markdown > audit-report.md
atlcli audit wiki --export-graph > graph.json
```

The directory is the positional argument or `--dir`, default `.`. At least one
check is required: `--all`, or individual flags (`--stale-high|medium|low <months>`,
`--orphans`, `--broken-links`, `--single-contributor`,
`--inactive-contributors`, `--external-links`, `--check-external`,
`--missing-label <label>`, `--restricted`, `--drafts`, `--archived`,
`--high-churn <N>`, `--folders`). Without a check flag the command fails
unless `audit.defaultChecks` is set in `~/.atlcli/config.json`.
Scope filters: `--label`, `--under-page <pageId>`, `--exclude-label`.

By default only the pages in the local `sync.db` are audited
(`--local-only`). Pages that were never pulled do not appear.

What touches the network:

- `--include-remote` and `--refresh-users` call the Confluence API.
- `--check-external` makes HTTP requests to every external URL found in the
  pages. `--external-links` only lists them. `--all` does not include either.
- `--rebuild-graph` rebuilds the link graph from the local Markdown files.

## Fix mode writes

`--fix` is the only part that changes Confluence, and it does not wait for
confirmation on its "safe" actions:

| Action | When | Confirmation |
| --- | --- | --- |
| Add label (`--fix-label`, default `needs-review`) | to every high-risk stale page | none, applied automatically |
| Write a Markdown report (`--report`, default `.atlcli/audit-report.md`) | any issue found | none, local file |
| Archive page | stale 24 months or more | interactive y/n/all/skip prompt on stdin |
| Delete page | orphan not modified for 12 months or more | interactive prompt on stdin |

Preview with `--fix --dry-run`, which prints each action and applies nothing.
Run `--fix` without `--dry-run` only after the user approved the dry-run list.
The archive and delete prompts read stdin, so they cannot be answered from a
non-interactive agent shell. Do not pipe `yes` into them.

## Pitfalls

- `--all` with `--fix` includes every check, so the stale label lands on every
  page that is high risk by the configured threshold. Set `--stale-high`
  explicitly and read the dry run.
- Results describe the last pull, not the live wiki. Pull first if
  freshness matters.

Related: [confluence-docs-sync.md](confluence-docs-sync.md),
[safety.md](safety.md).
