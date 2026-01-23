# Import/Export

Import and export issues in CSV and JSON formats.

::: toc

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
| `--format` | Output format (csv, json) |
| `-o` | Output file |
| `--fields` | Fields to include |

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
| `--file` | Input file |
| `--project` | Target project |
| `--dry-run` | Preview without creating |
| `--map-field` | Field mapping overrides |

## CSV Format

Required columns:

- `summary` - Issue title

Optional columns:

- `type` - Issue type
- `description` - Issue description
- `priority` - Priority name
- `labels` - Semicolon-separated labels
- `components` - Semicolon-separated components

## Field Mapping

Map CSV columns to Jira fields:

```bash
atlcli jira import --file data.csv --map-field "Title=summary" --map-field "Bug Type=issuetype"
```

## Related Topics

- [Issues](issues.md) - Work with individual issues
- [Bulk Operations](bulk-operations.md) - Batch updates
- [Search](search.md) - JQL for selecting issues to export
