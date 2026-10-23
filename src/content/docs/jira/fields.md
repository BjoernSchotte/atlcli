---
title: "Fields"
description: "Fields - atlcli documentation"
---

# Fields

Work with Jira custom and system fields. All field commands print JSON, pretty-printed even without `--json`.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects

## List Fields

```bash
atlcli jira field list
```

Options:

| Flag | Description |
|------|-------------|
| `--custom` | Show only custom fields |
| `--system` | Show only system fields |
| `--type` | Filter by schema type (`string`, `number`, `array`, …) |

Output:

```json
{
  "schemaVersion": "1",
  "fields": [
    { "id": "summary", "name": "Summary", "type": "string", "custom": false, "searchable": true, "clauseNames": ["summary"] },
    { "id": "customfield_10016", "name": "Story Points", "type": "number", "custom": true, "searchable": true, "clauseNames": ["cf[10016]", "Story Points"] }
  ],
  "total": 2
}
```

`type` is the field's schema type, or `unknown` when Jira reports none.

## Search Fields

Search for fields by name:

```bash
atlcli jira field search "story"
```

The query matches the field name, ID or JQL clause names, case-insensitively. Output:

```json
{
  "schemaVersion": "1",
  "query": "story",
  "fields": [
    { "id": "customfield_10016", "name": "Story Points", "type": "number", "custom": true, "clauseNames": ["cf[10016]", "Story Points"] }
  ],
  "total": 1
}
```

This is useful for finding the field ID for custom fields like story points.

## Get Field

Get details about a specific field:

```bash
atlcli jira field get customfield_10016
```

The ID works positionally or with `--id`. Output:

```json
{
  "schemaVersion": "1",
  "field": {
    "id": "customfield_10016",
    "key": "customfield_10016",
    "name": "Story Points",
    "custom": true,
    "type": "number",
    "customType": "com.atlassian.jira.plugin.system.customfieldtypes:float",
    "searchable": true,
    "orderable": true,
    "navigable": true,
    "clauseNames": ["cf[10016]", "Story Points"]
  }
}
```

## Field Options

For select, multi-select, and cascading select fields, list available options:

```bash
atlcli jira field options customfield_10077
```

Output:

```json
{
  "schemaVersion": "1",
  "field": { "id": "customfield_10077", "name": "Category" },
  "options": [
    { "id": "10001", "value": "Feature", "disabled": false },
    { "id": "10002", "value": "Bug", "disabled": false }
  ],
  "total": 2
}
```

Only custom fields have options. For a field without options, `options` is empty and `message` says why. Reading them needs Jira admin permission; without it the command fails with `ATLCLI_ERR_FORBIDDEN` and exit code 1, so an empty `options` list always means the field has none.

## Using Fields in Issues

### Set Custom Fields

Use the `--field <id>=<value>` flag on `issue create` and `issue update`. The flag is repeatable for multiple fields:

```bash
# Create with custom field
atlcli jira issue create --project PROJ --type Story --summary "Feature" \
  --field customfield_10001=5

# Update custom field
atlcli jira issue update --key PROJ-123 --field customfield_10001=8

# Set multiple fields at once
atlcli jira issue update --key PROJ-123 \
  --field customfield_10001=8 \
  --field customfield_10002='{"value":"Backend"}'
```

See [Issues → Custom Fields](issues.md#custom-fields) for full type coercion rules and examples.

### Query by Custom Fields

Use JQL to search by custom field values:

```bash
# By field ID
atlcli jira search --jql "cf[10001] > 3"

# By field name (if unique)
atlcli jira search --jql "'Story Points' > 3"
```

## Common Custom Fields

| Field | Typical ID | JQL |
|-------|------------|-----|
| Story Points | `customfield_10016` | `cf[10016] > 0` |
| Epic Link | `customfield_10014` | `'Epic Link' = PROJ-100` |
| Sprint | `customfield_10020` | `Sprint in openSprints()` |
| Team | `customfield_10017` | `Team = 'Backend'` |

:::note[Field IDs Vary]
Custom field IDs differ between Jira instances. Use `atlcli jira field search` to find the correct ID for your instance.

:::

## Related Topics

- [Issues](issues.md) - Set field values on issues
- [Bulk Operations](bulk-operations.md) - Set fields on multiple issues
- [Search](search.md) - Query by custom fields
- [Analytics](analytics.md) - Story points for velocity tracking
