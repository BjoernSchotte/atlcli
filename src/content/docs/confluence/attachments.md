---
title: "Attachments"
description: "Attachments - atlcli documentation"
---

# Attachments

Sync images and files with Confluence pages.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Space permission**: View for pull, Edit for push operations

## Quick Start

```bash
# Pull pages (attachments included by default)
atlcli wiki docs pull ./docs

# Pull without attachments (faster)
atlcli wiki docs pull ./docs --no-attachments

# Push - atlcli automatically uploads new/changed attachments
atlcli wiki docs push ./docs
```

## Image References

Reference images in markdown:

```markdown
![Diagram](./images/architecture.png)
```

On push, atlcli uploads the image as an attachment and updates the reference.

## Pull Attachments

Attachments are downloaded by default during pull. To skip them:

```bash
atlcli wiki docs pull ./docs --no-attachments
```

Attachments are saved to a directory named after the page (e.g., `page-name/` alongside `page-name.md`).

### Local edits are protected

Pull hashes every attachment on disk and compares it against the hash recorded
at the last sync, exactly as it does for markdown. Three outcomes:

| Situation | What pull does |
|-----------|----------------|
| File unchanged since last sync | Downloads the remote version |
| File changed locally, remote unchanged | Keeps your file, prints `Skipping <path> (local modifications, use --force)` |
| File changed locally **and** remotely | Keeps your file, saves the remote copy next to it as a `.conflict` file |
| File exists but was never tracked (no recorded base) | Keeps your file, prints `Skipping <path> (untracked local file, use --force)` |

`--force` overrides all of these and writes the remote bytes.

**What this detection catches:** any byte-level change to a tracked attachment,
including edits that keep the same file size. It compares content hashes, not
timestamps, so touching a file without changing it is not treated as a
modification.

**What it cannot catch:** a modification to a file whose base hash was never
recorded - for example a tree pulled by a much older atlcli version, or an
attachment replaced in Confluence under a new attachment ID. Those cases are
reported as "untracked local file" and skipped rather than guessed at; pull
once with `--force` to adopt the remote version and re-establish the base.

## Push Attachments

New or modified local files are automatically uploaded on push.

## Check for Local Attachment Changes

`docs status` reports attachments separately from markdown files:

```bash
atlcli wiki docs status ./docs
```

```
Attachments:
  synced:          8
  local-modified:  1
  conflict:        0
  missing:         0
```

In `--json` output these live under `attachmentStats`, and each modified
attachment also appears in `modified` with the type `attachment local changes`.

## Supported Formats

- Images: PNG, JPG, GIF, SVG
- Documents: PDF, DOCX, XLSX
- Archives: ZIP

## Size Limits

Attachments are subject to your Confluence instance limits (typically 25MB per file).

## Examples

### Minimal: Add an Image to a Page

```markdown
# Architecture Overview

Here's our system diagram:

![System Architecture](./architecture.png)
```

On push, atlcli uploads `architecture.png` and converts the reference to a Confluence attachment link.

### Advanced: Organize Attachments in Subdirectories

```
docs/
├── api-reference.md
├── api-reference/
│   └── images/
│       ├── auth-flow.png
│       └── request-lifecycle.svg
└── getting-started.md
```

Reference with relative paths:

```markdown
# API Reference

## Authentication Flow

![Auth Flow](./api-reference/images/auth-flow.png)
```

atlcli preserves the directory structure and uploads all referenced files.

## Troubleshooting

### Attachment Not Uploading

**Symptom**: Image referenced in markdown not appearing in Confluence.

**Causes**:
- File path incorrect or file doesn't exist
- File exceeds size limit
- Unsupported format

**Fix**: Verify the file exists at the referenced path. Check file size and format.

### Broken Image After Pull

**Symptom**: Image shows as broken link after pulling.

**Cause**: Attachment was deleted in Confluence or pull ran with `--no-attachments`.

**Fix**: Run `atlcli wiki docs pull ./docs` to re-download attachments.

### Attachment Not Updated by Pull

**Symptom**: Pull prints `Skipping page.attachments/file.pdf (local modifications, use --force)` and the file keeps its old content.

**Cause**: The local file differs from the version recorded at the last sync, so pull refuses to discard your edits.

**Fix**: Check what changed with `atlcli wiki docs status ./docs`. Keep your version (do nothing), or take the remote one with `atlcli wiki docs pull ./docs --force`. To push your version instead, run `atlcli wiki docs push ./docs`.

## Related Topics

- [Sync](sync.md) - Pull and push with attachment handling
- [File Format](file-format.md) - Attachment directory structure
- [Export](export.md) - Include attachments in DOCX exports
