---
title: "Fields"
description: "Fields - atlcli documentation"
---

# Fields

Work with Jira custom and system fields.

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
| `--type` | Filter by field type |

Output:

```
ID                    NAME                TYPE        CUSTOM
summary               Summary             string      No
priority              Priority            priority    No
customfield_10001     Story Points        number      Yes
customfield_10002     Sprint              array       Yes
customfield_10003     Epic Link           any         Yes
```

## Search Fields

Search for fields by name:

```bash
atlcli jira field search "story"
```

Output:

```
ID                    NAME                TYPE
customfield_10001     Story Points        number
customfield_10016     Story point est.    number
```

This is useful for finding the field ID for custom fields like story points.

## Get Field

Get details about a specific field:

```bash
atlcli jira field get --id customfield_10001
```

Output:

```
Field: Story Points
ID:    customfield_10001
Type:  number
Custom: Yes
Schema: { "type": "number", "custom": "com.atlassian.jira.plugin.system.customfieldtypes:float" }
```

## Field Options

For select, multi-select, and cascading select fields, list available options:

```bash
atlcli jira field options --id customfield_10001
```

Output:

```
ID       VALUE
10001    Option A
10002    Option B
10003    Option C
```

## Using Fields in Issues

### Set Custom Fields

When creating or updating issues:

```bash
# Create with custom field
atlcli jira issue create --project PROJ --type Story --summary "Feature" \
  --set "customfield_10001=5"

# Update custom field
atlcli jira issue update --key PROJ-123 --set "customfield_10001=8"
```

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

## JSON Output

```bash
atlcli jira field list --json
```

```json
{
  "schemaVersion": "1",
  "fields": [
    {
      "id": "customfield_10001",
      "name": "Story Points",
      "type": "number",
      "custom": true,
      "schema": {
        "type": "number",
        "custom": "com.atlassian.jira.plugin.system.customfieldtypes:float"
      }
    }
  ]
}
```

## Related Topics

- [Issues](issues.md) - Set field values on issues
- [Bulk Operations](bulk-operations.md) - Set fields on multiple issues
- [Search](search.md) - Query by custom fields
- [Analytics](analytics.md) - Story points for velocity tracking
