# Wiki Audit

Analyze your Confluence wiki for content health issues like stale pages, broken links, orphaned content, and contributor risks.

::: toc

## Overview

The `audit wiki` command helps you maintain documentation quality by detecting:

- **Stale content** - Pages not updated in months
- **Orphaned pages** - Pages with no incoming links
- **Broken links** - Internal links pointing to non-existent pages
- **Contributor risks** - Bus factor and inactive maintainer issues
- **External link health** - Broken external URLs
- **Compliance issues** - Missing labels, restricted pages, drafts
- **Editor format** - Pages using legacy vs new Confluence editor

## Quick Start

```bash
# Run all checks with 12-month stale threshold
atlcli audit wiki --all --stale-high 12

# Output as markdown report
atlcli audit wiki --all --stale-high 12 --markdown > AUDIT-REPORT.md

# Output as JSON for processing
atlcli audit wiki --all --json
```

## Prerequisites

Before running audits, you need:

1. **Enable the feature flag**: `atlcli flag set audit true --global`
2. Initialized `.atlcli` directory: `atlcli wiki docs init ./docs --space TEAM`
3. Synced content: `atlcli wiki docs pull ./docs`
4. Active profile: `atlcli auth login`

## Check Types

### Content Freshness

| Flag | Description |
|------|-------------|
| `--stale-high <months>` | Flag pages not edited in N+ months as high risk |
| `--stale-medium <months>` | Flag pages not edited in N+ months as medium risk |
| `--stale-low <months>` | Flag pages not edited in N+ months as low risk |

```bash
# Multi-tier stale detection
atlcli audit wiki --stale-high 12 --stale-medium 6 --stale-low 3
```

### Link Analysis

| Flag | Description |
|------|-------------|
| `--orphans` | Find pages with no incoming links |
| `--broken-links` | Find broken internal links |
| `--external-links` | List all external URLs (inventory) |
| `--check-external` | Verify external URLs via HTTP |

```bash
# Full link audit
atlcli audit wiki --orphans --broken-links --check-external
```

### Folder Structure

| Flag | Description |
|------|-------------|
| `--folders` | Check folder structure issues |

```bash
# Folder audit
atlcli audit wiki --folders
```

Folder checks detect:
- **FOLDER_EMPTY** - Folders with no child pages or subfolders
- **FOLDER_MISSING_INDEX** - Directories with pages but no folder index.md

See [Folders](folders.md#validating-folders) for details.

### Editor Format

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

#### Converting Editor Formats

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

!!! tip "New pages default to v2"
    Pages created with `atlcli wiki docs push` or `atlcli wiki docs add` automatically use the new editor. Use `--legacy-editor` flag to opt out.

### Contributor Analysis

| Flag | Description |
|------|-------------|
| `--single-contributor` | Find pages with only one contributor (bus factor) |
| `--inactive-contributors` | Find pages where all contributors are inactive |
| `--refresh-users` | Refresh user status from Confluence API first |

```bash
# Contributor risk analysis
atlcli audit wiki --single-contributor --inactive-contributors --refresh-users
```

### Content Status

| Flag | Description |
|------|-------------|
| `--missing-label <label>` | Find pages missing a required label |
| `--restricted` | Find pages with view/edit restrictions |
| `--drafts` | Find unpublished draft pages |
| `--archived` | Find archived pages |
| `--high-churn <N>` | Find pages with N+ versions |

```bash
# Content compliance check
atlcli audit wiki --missing-label "reviewed" --drafts --archived
```

### Remote Pages

| Flag | Description |
|------|-------------|
| `--include-remote` | Include unsynced pages from Confluence API |

```bash
# Audit including pages not synced locally
atlcli audit wiki --all --include-remote
```

## Scope Filtering

Limit the audit to specific pages:

| Flag | Description |
|------|-------------|
| `--label <label>` | Only audit pages with this label |
| `--under-page <pageId>` | Only audit pages under this ancestor |
| `--exclude-label <label>` | Exclude pages with this label |
| `--dir <path>` | Directory to audit (default: current) |

```bash
# Audit only documentation pages, excluding archived
atlcli audit wiki --all --label documentation --exclude-label archived

# Audit pages under a specific parent
atlcli audit wiki --all --under-page 123456789
```

## Output Formats

### Table (Default)

Human-readable summary with top issues:

```
Audit Report - TEAM Space
==================================================

STALE PAGES (25 pages)
  High risk:   5 pages
  Medium risk: 10 pages
  Low risk:    10 pages

High Risk (oldest first):
  - API Documentation (18 months, by John Smith)
  - Getting Started (14 months, by Jane Doe (inactive))
  ...

ORPHANED PAGES (3 pages) - No incoming links
  - Old Migration Guide (old-migration.md)
  ...

BROKEN LINKS (8 links)
  - API Reference:42 -> ./deprecated-api.md
  ...

Use --json for full details, --markdown for report format.
```

### JSON

Full structured output for processing:

```bash
atlcli audit wiki --all --json > audit.json
```

```json
{
  "space": "TEAM",
  "generatedAt": "2026-01-18T10:30:00Z",
  "summary": {
    "stale": { "high": 5, "medium": 10, "low": 10 },
    "orphans": 3,
    "brokenLinks": 8,
    "contributorRisks": 2,
    "externalLinks": 42,
    "folderIssues": 2
  },
  "editorFormat": {
    "v2": 25,
    "v1": 3,
    "unknown": 2
  },
  "legacyPages": [
    { "path": "old-page.md", "id": "123456", "title": "Old Page" }
  ],
  "stalePages": [...],
  "orphanedPages": [...],
  "brokenLinks": [...],
  "folderIssues": [
    { "file": "empty-folder/index.md", "code": "FOLDER_EMPTY", "message": "..." },
    { "file": "orphan-dir", "code": "FOLDER_MISSING_INDEX", "message": "..." }
  ]
}
```

### Markdown

Professional report format:

```bash
atlcli audit wiki --all --markdown > AUDIT-REPORT.md
```

```markdown
# Audit Report: TEAM Space

Generated: Mon Jan 18 2026 10:30:00 AM

## Summary

| Check | Count |
|-------|-------|
| Stale pages | 25 (High: 5, Med: 10, Low: 10) |
| Orphaned pages | 3 |
| Broken links | 8 |

## Stale Pages

| Page | Months Stale | Severity | Author |
|------|--------------|----------|--------|
| API Documentation | 18 | high | John Smith |
...
```

## Fix Mode

Automatically fix issues with `--fix`:

```bash
# Preview fixes without applying
atlcli audit wiki --all --stale-high 12 --fix --dry-run

# Apply fixes
atlcli audit wiki --all --stale-high 12 --fix
```

### Safe Actions (Auto-applied)

- Add "needs-review" label to high-risk stale pages
- Generate markdown report at `.atlcli/audit-report.md`

### Unsafe Actions (Prompted)

- Archive pages 24+ months old
- Delete orphaned pages 12+ months old

### Fix Options

| Flag | Description | Default |
|------|-------------|---------|
| `--fix` | Enable fix mode | false |
| `--dry-run` | Preview fixes only | false |
| `--fix-label <label>` | Label for stale pages | `needs-review` |
| `--report <path>` | Report output path | `.atlcli/audit-report.md` |

## Configuration

Set defaults in `~/.atlcli/config.json`:

```json
{
  "audit": {
    "staleThresholds": {
      "high": 12,
      "medium": 6,
      "low": 3
    },
    "defaultChecks": [
      "stale",
      "orphans",
      "broken-links",
      "single-contributor"
    ]
  }
}
```

| Option | Description |
|--------|-------------|
| `staleThresholds.high` | Months for high-risk stale |
| `staleThresholds.medium` | Months for medium-risk stale |
| `staleThresholds.low` | Months for low-risk stale |
| `defaultChecks` | Checks to run when no flags specified |

Valid `defaultChecks` values:
- `stale` - Use configured thresholds
- `orphans`
- `broken-links`
- `single-contributor`
- `inactive-contributors`
- `external-links`
- `folders` - Check folder structure issues

## Common Patterns

### Quarterly Documentation Review

```bash
# Generate comprehensive report
atlcli audit wiki --all \
  --stale-high 12 --stale-medium 6 --stale-low 3 \
  --markdown > quarterly-review.md
```

### Pre-Release Link Check

```bash
# Verify all links before release
atlcli audit wiki --broken-links --check-external
```

### Bus Factor Analysis

```bash
# Find knowledge silos
atlcli audit wiki --single-contributor --inactive-contributors --refresh-users
```

### Compliance Audit

```bash
# Check required labels and restrictions
atlcli audit wiki --missing-label "approved" --restricted --drafts
```

### Editor Migration

```bash
# Check current editor format status
atlcli wiki docs status ./docs

# Preview conversion to new editor
atlcli wiki docs convert ./docs --to-new-editor --dry-run

# Convert all pages to new editor
atlcli wiki docs convert ./docs --to-new-editor --confirm

# Verify migration
atlcli wiki docs pull ./docs
atlcli wiki docs status ./docs
```

### CI/CD Integration

```bash
# Fail pipeline if critical issues found
result=$(atlcli audit wiki --broken-links --json)
broken=$(echo "$result" | jq '.summary.brokenLinks')
if [ "$broken" -gt 0 ]; then
  echo "Found $broken broken links"
  exit 1
fi
```

### Export Link Graph

```bash
# Export for visualization tools
atlcli audit wiki --export-graph > knowledge-graph.json
```

## Advanced Options

| Flag | Description |
|------|-------------|
| `--rebuild-graph` | Re-extract links from markdown files |
| `--export-graph` | Export full link graph as JSON |
| `--local-only` | Only audit synced pages (default) |

## Troubleshooting

### "No sync.db found"

Run `atlcli wiki docs pull` first to create the sync database.

### External Link Timeouts

External link checking uses 10-second timeouts with 5 concurrent requests. For large wikis, this may take several minutes.

### "User status unknown"

Run with `--refresh-users` to fetch current user status from Confluence API.

### Stale Detection Not Working

Sync pages first with `atlcli wiki docs pull`. atlcli reads the `lastModified` date from Confluence metadata.

## Related Topics

- [Storage](storage.md) - How sync data is stored
- [Sync](sync.md) - Syncing pages with Confluence
- [Configuration](../configuration.md) - Global config options
