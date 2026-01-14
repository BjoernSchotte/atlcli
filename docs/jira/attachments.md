# Attachments

Upload, download, and manage file attachments on Jira issues.

## List Attachments

View attachments on an issue:

```bash
atlcli jira issue attachments PROJ-123
```

Output:

```
ID          FILENAME           SIZE      CREATED
10001       screenshot.png     245 KB    2025-01-14
10002       debug.log          12 KB     2025-01-13
10003       requirements.pdf   1.2 MB    2025-01-10
```

Options:

| Flag | Description |
|------|-------------|
| `--format` | Output format: `table`, `json` |

## Upload Attachment

Attach a file to an issue:

```bash
atlcli jira issue attach PROJ-123 ./screenshot.png
```

Upload multiple files:

```bash
atlcli jira issue attach PROJ-123 ./file1.png ./file2.pdf ./logs.zip
```

Options:

| Flag | Description |
|------|-------------|
| `--comment` | Add a comment with the attachment |

### Examples

```bash
# Upload with comment
atlcli jira issue attach PROJ-123 ./error.log --comment "Error logs from production"

# Upload all screenshots
atlcli jira issue attach PROJ-123 ./screenshots/*.png
```

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
| `-o`, `--output` | Output directory or file path |
| `--overwrite` | Overwrite existing files |

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
atlcli jira issue attachment delete 10001 --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--confirm` | Skip confirmation prompt |

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
      "created": "2025-01-14T10:00:00Z",
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

!!! warning "Size Limits"
    Jira Cloud has a default attachment size limit of 10 MB per file. Your administrator may have configured different limits.

## Use Cases

### Attach Build Artifacts

```bash
# Attach build log after CI failure
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

# Upload to target issue
atlcli jira issue attach PROJ-200 /tmp/migrate/*
```
