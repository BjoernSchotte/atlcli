---
title: "Import/Export"
description: "Import/Export - atlcli documentation"
---

# Import/Export

Import and export issues in CSV and JSON formats.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects (export), Create Issues (import)

## Export

### Export to CSV

```bash
atlcli jira export --jql "project = PROJ" --format csv -o issues.csv
```

### Export to JSON

```bash
atlcli jira export --jql "project = PROJ" --format json -o issues.json
```

### Export Options

| Flag | Description |
|------|-------------|
| `--jql` | JQL query to select issues |
| `--format` | Output format: `json` (default) or `csv` |
| `-o`, `--output` | Output file |
| `--no-comments` | Skip comments |
| `--no-attachments` | Skip attachments |

Exported comments are markdown, so an export can be imported again without losing formatting.

### Incomplete exports

If the comments or attachments of an issue cannot be fetched, for example because of missing permissions, the export still writes the file but fails with exit code 1. Each gap is marked in the file, and a warning names it on stderr:

```json
{
  "key": "PROJ-123",
  "comments": [],
  "exportErrors": [{ "part": "comments", "message": "Jira API error (403): Forbidden" }]
}
```

An empty `comments` or `attachments` list without `exportErrors` means the issue has none.

## Import

### Import from CSV

```bash
atlcli jira import --file issues.csv --project PROJ
```

### Import from JSON

```bash
atlcli jira import --file issues.json --project PROJ
```

### Import Options

| Flag | Description |
|------|-------------|
| `--file` | Input file (required) |
| `--project` | Target project (required unless `defaults.project` is set) |
| `--dry-run` | Preview without creating |
| `--skip-attachments` | Do not upload attachments from a JSON export |
| `--map-field` | Rename a CSV column before mapping, `"CSV Column=field"`. Repeatable, CSV only. |

Import only creates issues; it never updates existing ones.

## CSV Format

Required columns:

- `summary` - Issue title

Optional columns:

- `issuetype` - Issue type name (default `Task`)
- `description` - Issue description, as markdown
- `priority` - Priority name
- `assignee` - Assignee account ID
- `labels` - Comma-separated labels, quoted as one cell: `"backend, urgent"`
- `components` - Comma-separated components, quoted as one cell
- Any other column is sent as a field with that name, for example `customfield_10028`

Quoted cells may contain commas, doubled quotes (`""`) and line breaks, so multi-line markdown descriptions work:

```csv
summary,description,labels
"Export drops tables","## Steps

1. Open export
2. Pick **PDF**","export, pdf"
```

## Field Mapping

Rename CSV columns to Jira field names:

```bash
atlcli jira import --file data.csv --project PROJ \
  --map-field "Title=summary" --map-field "Bug Type=issuetype" --map-field "Body=description"
```

A `--map-field` column that is not in the CSV header stops the import with an error, so a typo never silently drops data. `--map-field` with a JSON file is an error.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `--map-field column "X" is not in the CSV header` | Column name differs (case, spaces) | Copy the header exactly |
| A `*`, `_` or `#` in the description vanished or turned into formatting | Descriptions are markdown | Escape the character: `\*`, `\_`, `\#` |
| Issue created without the description | Column is not named `description` | Add `--map-field "Your Column=description"` |
| Export exits 1 and lists issues as incomplete | Comments or attachments could not be fetched | Check `exportErrors` in the file; fix the permission and export again |
| `--project is required for import` | No `--project` and no default project | Pass `--project <key>` |

## Related Topics

- [Issues](issues.md) - Work with individual issues
- [Bulk Operations](bulk-operations.md) - Batch updates
- [Search](search.md) - JQL for selecting issues to export
