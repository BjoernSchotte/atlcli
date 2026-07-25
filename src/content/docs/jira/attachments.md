---
title: "Attachments"
description: "Attachments - atlcli documentation"
---

# Attachments

Upload, download, and manage file attachments on Jira issues.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects (view), Create Attachments (upload), Delete Attachments (delete)

## List Attachments

View attachments on an issue:

```bash
atlcli jira issue attachments PROJ-123
```

Output:

```
ID     FILENAME          SIZE    CREATED
10001  screenshot.png    245 KB  2026-01-14
10002  debug.log         12 KB   2026-01-13
10003  requirements.pdf  1.2 MB  2026-01-10
```

The issue key can also be passed as `--key PROJ-123`. Columns are sized to the
widest row.

Use `--json` for JSON output.

## Upload Attachment

Attach one or more files to an issue:

```bash
# Single file
atlcli jira issue attach PROJ-123 ./screenshot.png

# Several files in one call
atlcli jira issue attach PROJ-123 ./file1.png ./file2.pdf ./logs.zip

# A glob the shell expands — every match is uploaded
atlcli jira issue attach PROJ-123 ./screenshots/*.png

# Upload and comment in one step
atlcli jira issue attach PROJ-123 ./error.log --comment "Error logs from production"
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key, if you prefer it over the positional form |
| `--comment` | Post a comment on the issue after the upload |
| `--json` | JSON output |

:::note[Partial failures]
Every path is checked before anything is uploaded, so a typo in one filename
uploads nothing. If a file is rejected by Jira mid-run, the remaining files are
still uploaded, the failures are reported, and the command exits non-zero — so a
script never mistakes a partial upload for a complete one.

The `--comment` text is posted only when at least one file uploaded.
:::

### Upload JSON Output

```bash
atlcli jira issue attach PROJ-123 ./a.png ./b.pdf --json
```

```json
{
  "schemaVersion": "1",
  "issue": "PROJ-123",
  "attached": [
    {
      "id": "20001",
      "filename": "a.png",
      "size": 250880,
      "mimeType": "image/png",
      "path": "./a.png"
    },
    {
      "id": "20002",
      "filename": "b.pdf",
      "size": 12288,
      "mimeType": "application/pdf",
      "path": "./b.pdf"
    }
  ],
  "total": 2
}
```

A run with failures adds a `failed` array (`[{ "path": "...", "error": "..." }]`),
and `--comment` adds `"comment": { "id": "30001" }`.

## Download Attachment

Download an attachment by ID or filename:

```bash
# By attachment ID
atlcli jira issue attachment download 10001 -o ./downloads/

# By filename from issue
atlcli jira issue attachment download PROJ-123 screenshot.png -o ./downloads/
```

Options:

| Flag | Description |
|------|-------------|
| `-o`, `--output` | Output directory or file path (default: current directory) |
| `--overwrite` | Overwrite existing files |

`-o` is treated as a **directory** when it already exists as one or ends in a
path separator (`./downloads/`); missing directories are created. Otherwise it
names the target file:

```bash
# Writes ./downloads/screenshot.png
atlcli jira issue attachment download 10001 -o ./downloads/

# Writes ./shot.png
atlcli jira issue attachment download 10001 -o ./shot.png
```

Without `--overwrite`, an existing file is left untouched and the command exits
with `ATLCLI_ERR_IO`.

:::note[Duplicate filenames]
Jira allows several attachments with the same name on one issue. Downloading by
filename fetches **all** matches and inserts the attachment ID before the
extension so nothing is overwritten:

```
screenshot.10001.png
screenshot.10003.png
```

:::

### Download All Attachments

```bash
# Download all attachments from an issue
atlcli jira issue attachments PROJ-123 --json | \
  jq -r '.attachments[].id' | \
  xargs -I {} atlcli jira issue attachment download {} -o ./downloads/
```

## Delete Attachment

Remove an attachment:

```bash
# By attachment ID
atlcli jira issue attachment delete 10001 --confirm

# By issue key + filename (deletes every match)
atlcli jira issue attachment delete PROJ-123 screenshot.png --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--confirm` | Required — deletion is not reversible |

## JSON Output

```bash
atlcli jira issue attachments PROJ-123 --json
```

```json
{
  "schemaVersion": "1",
  "issue": "PROJ-123",
  "attachments": [
    {
      "id": "10001",
      "filename": "screenshot.png",
      "size": 250880,
      "mimeType": "image/png",
      "created": "2026-01-14T10:00:00.000+0000",
      "author": {
        "displayName": "Alice",
        "email": "alice@company.com"
      },
      "content": "https://company.atlassian.net/secure/attachment/10001/screenshot.png"
    }
  ],
  "total": 1
}
```

## Supported File Types

Jira accepts most file types. Common attachments include:

- Images: PNG, JPG, GIF, SVG
- Documents: PDF, DOCX, XLSX, TXT
- Archives: ZIP, TAR.GZ
- Logs: LOG, TXT
- Code: Source files of any type

:::caution[Size Limits]
Jira Cloud has a default attachment size limit of 10 MB per file. Your administrator may have configured different limits.

:::

## Use Cases

### Attach Build Artifacts

```bash
# Attach build log after CI failure, with the explanation in one call
atlcli jira issue attach PROJ-123 ./build.log --comment "Build failed - see attached log"
```

### Bulk Export Attachments

```bash
# Export all attachments from issues matching JQL
for key in $(atlcli jira search --jql "project = PROJ AND attachments is not EMPTY" --json | jq -r '.issues[].key'); do
  mkdir -p "./attachments/$key"
  atlcli jira issue attachments $key --json | \
    jq -r '.attachments[].id' | \
    xargs -I {} atlcli jira issue attachment download {} -o "./attachments/$key/"
done
```

### Migrate Attachments Between Issues

```bash
# Download from source issue
atlcli jira issue attachments PROJ-100 --json | \
  jq -r '.attachments[].id' | \
  xargs -I {} atlcli jira issue attachment download {} -o /tmp/migrate/

# Upload to target issue — one call, every file
atlcli jira issue attach PROJ-200 /tmp/migrate/*
```

## Related Topics

- [Issues](issues.md) - Work with issues
- [Import/Export](import-export.md) - Bulk data operations
