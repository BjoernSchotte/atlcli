---
title: "Page History"
description: "Page History - atlcli documentation"
---

# Page History

View version history, compare changes, and restore previous versions.

## On this page

- [Prerequisites](#prerequisites)
- [View history](#view-history)
- [Compare versions](#compare-versions-diff)
- [Restore a version](#restore-version)
- [JSON output](#json-output)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Space permission**: View to see history, Edit to restore versions

## Overview

Confluence tracks every edit as a version. atlcli provides:

- Version history listing
- Content comparison (diff)
- Version restoration

## View History

List all versions of a page:

```bash
atlcli wiki page history --id 12345
```

Output:

```
VERSION   AUTHOR              DATE                  MESSAGE
5         Alice               2025-01-14 10:30      Updated API examples
4         Bob                 2025-01-13 15:45      Fixed typos
3         Alice               2025-01-12 09:00      Added authentication section
2         Alice               2025-01-10 14:20      Initial draft
1         Alice               2025-01-10 14:00      Created page
```

Options:

| Flag | Description |
|------|-------------|
| `--limit` | Number of versions to show |
| `--json` | JSON output |

## Compare Versions (Diff)

### Compare with Current

```bash
# Compare version 3 with current
atlcli wiki page diff --id 12345 --version 3
```

Output:

```diff
--- Version 3 (2025-01-12)
+++ Current (Version 5)
@@ -10,6 +10,10 @@
 ## Authentication

 Use API tokens for authentication.
+
+### Token Scopes
+
+Tokens can have limited scopes for security.
```

### Compare Two Versions

```bash
atlcli wiki page diff --id 12345 --from 2 --to 4
```

Reverse comparisons are valid and describe changes toward the requested target:

```bash
atlcli wiki page diff --id 12345 --from 7 --to 3
```

### Semantic Diff

The default `unified` format converts Storage content to Markdown and prints a
line-oriented patch. `text` is an explicit alias for that format. Add
`--word-diff` to pair changed lines and mark removed words as `[-old-]` and
added words as `{+new+}`; this is a review presentation, not an applicable
patch. Opt into `semantic` for an end-user review of structural
changes. Terminal output describes headings, paragraphs, images, lists and
other blocks in plain language; AST paths, raw node JSON and private media IDs
remain available only in the machine-readable ChangeSet:

```bash
# Human-readable tree diff
atlcli wiki page diff --id 12345 --from 3 --to 7 --format semantic

# Exactly one JSON document containing atlcli.change-set/1
atlcli wiki page diff --id 12345 --from 3 --to 7 --format semantic --json
```

Repeated unlabeled changes are grouped, for example `Added 7 images` or
`Added 4 empty paragraphs`. When Confluence does not expose enough stable
metadata to match media safely, the terminal reports one grouped review item
instead of guessing or printing attachment internals. `Coverage: degraded`
means that review item must be resolved before treating the result as a
complete SafeOps approval.

### Diff Options

| Flag | Description |
|------|-------------|
| `--version` | Compare this version with current |
| `--from` | Start version for comparison |
| `--to` | End version for comparison |
| `--format` | `unified` (default), `text`, or `semantic` |
| `--context` | Text/unified diff context lines (default: 3); invalid with `semantic` |
| `--word-diff` | Mark changed words inline in text/unified output |
| `--no-color` | Disable colored output |
| `--json` | Emit one JSON document; semantic mode returns `changeSet` |

`--to` requires `--from`. Do not combine `--version` with `--from` or `--to`.
Versions must be positive integers.

With `--json`, text/unified mode always retains the applicable `unified` patch.
When `--word-diff` is present, the JSON document also contains the ANSI-free
`wordDiff` review presentation.

### Cloud and Data Center

- **Cloud:** atlcli requests both exact versions as ADF plus exact Storage
  sidecars. It uses ADF only when both ADF reads are trustworthy; otherwise it
  uses exact Storage for both sides and reports the fallback.
- **Data Center:** atlcli uses exact Storage versions only and does not call the
  Cloud v2 API. This path is contract-tested, but is not project-live-certified.

Malformed bodies, permission failures, version mismatches, and parse-budget
failures stop the comparison. They are never presented as a complete no-op.

For larger bodies, semantic diff automatically switches to a bounded temporary
spill lane. ADF is validated in top-level batches; Storage releases each parsed
top-level subtree after writing its canonical record. Baseline and target are
processed one version at a time, and the private temporary store is removed
before terminal or JSON output is emitted. A spill, alignment, digest, or
cleanup failure stops the command; atlcli does not retry through the
higher-memory tree path.

## Restore Version

Restore a page to a previous version:

```bash
atlcli wiki page restore --id 12345 --version 3 --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--version` | Version number to restore |
| `--message` | Restore commit message |
| `--confirm` | Skip confirmation prompt |

:::caution[Restoration Creates New Version]
When you restore, atlcli creates a new version (e.g., v6) with the old content. atlcli preserves the full history.

:::

### Restore with Message

```bash
atlcli wiki page restore --id 12345 --version 3 --message "Reverting breaking changes" --confirm
```

## JSON Output

```bash
atlcli wiki page history --id 12345 --json
```

Semantic diff JSON uses a different, review-oriented envelope:

```json
{
  "schemaVersion": "1",
  "changeSet": {
    "schema": "atlcli.change-set/1",
    "subject": { "provider": "confluence", "kind": "page", "id": "12345" },
    "baseline": {
      "revision": "3",
      "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "representation": "atlas_doc_format",
      "deployment": "cloud",
      "acquisition": "rest-v2"
    },
    "target": {
      "revision": "7",
      "digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "representation": "atlas_doc_format",
      "deployment": "cloud",
      "acquisition": "rest-v2"
    },
    "completeness": { "status": "complete", "diagnostics": [] },
    "summary": { "inserts": 0, "deletes": 0, "modifies": 0, "moves": 0, "opaque": 0, "noOp": true },
    "operations": [],
    "limits": { "truncated": false, "emittedOperations": 0 }
  }
}
```

Snapshot objects also contain canonical-source digests, deployment, and
acquisition provenance. Operations contain bounded before/after values; the
envelope never repeats a complete source document.

```json
{
  "schemaVersion": "1",
  "pageId": "12345",
  "title": "API Reference",
  "versions": [
    {
      "number": 5,
      "author": {
        "displayName": "Alice",
        "email": "alice@company.com"
      },
      "created": "2025-01-14T10:30:00Z",
      "message": "Updated API examples",
      "minorEdit": false
    },
    {
      "number": 4,
      "author": {
        "displayName": "Bob",
        "email": "bob@company.com"
      },
      "created": "2025-01-13T15:45:00Z",
      "message": "Fixed typos",
      "minorEdit": true
    }
  ],
  "total": 5
}
```

## Sync Integration

### Pull Specific Version

```bash
# Pull a page at a specific version
atlcli wiki docs pull ./docs --page-id 12345 --version 3
```

### Version in Frontmatter

atlcli tracks the current version in frontmatter:

```markdown
---
atlcli:
  id: "12345"
  title: "API Reference"
  version: 5
  lastModified: "2025-01-14T10:30:00Z"
---
```

## Use Cases

### Audit Trail

```bash
# See who changed what
atlcli wiki page history --id 12345 --json | \
  jq '.versions[] | "\(.created): \(.author.displayName) - \(.message)"'
```

### Recover Deleted Content

```bash
# Find when content was removed
atlcli wiki page diff --id 12345 --from 1 --to 5 | grep "^-"

# Restore if needed
atlcli wiki page restore --id 12345 --version 3 --confirm
```

### Review Changes Before Merge

```bash
# See what changed in latest version
atlcli wiki page diff --id 12345 --version $(atlcli wiki page history --id 12345 --json | jq '.versions[1].number')
```

### Batch History Export

```bash
# Export history for all pages in space
for id in $(atlcli wiki page list --space TEAM --json | jq -r '.pages[].id'); do
  atlcli wiki page history --id "$id" --json > "history-$id.json"
done
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `--to requires --from` | The target version was supplied without a baseline | Add `--from <n>` or omit `--to` to compare with current |
| `page-version-mismatch` | Confluence returned a different version than requested | Retry after edits finish; do not rely on the partial result |
| `invalid-adf-response` or Storage parse failure | The source is malformed or exceeds a safety budget | Inspect the error details; atlcli intentionally does not emit a complete-looking diff |
| `Coverage: degraded` | An opaque construct, missing stable media metadata, fallback, or limit affected interpretation | Review the grouped warnings and machine-readable opaque operations before using the output as a SafeOps check |

## Related Topics

- [Pages](pages.md) - Page operations
- [Sync](sync.md) - Version tracking in frontmatter
- [Audit](audit.md) - Analyze contributor history
