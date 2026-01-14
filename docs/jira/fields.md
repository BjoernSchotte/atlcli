# Fields

Work with custom fields, components, and versions.

## Custom Fields

### List Fields

```bash
atlcli jira field list
```

Options:

| Flag | Description |
|------|-------------|
| `--type` | Filter by field type |
| `--custom` | Show only custom fields |
| `--search` | Search by name |

### Get Field

```bash
atlcli jira field get customfield_10001
```

### Field Options

For select/multi-select fields:

```bash
atlcli jira field options customfield_10001
```

## Components

### List Components

```bash
atlcli jira component list --project PROJ
```

### Create Component

```bash
atlcli jira component create --project PROJ --name "Backend" --lead john@company.com
```

### Update Component

```bash
atlcli jira component update PROJ/Backend --description "Backend services"
```

### Delete Component

```bash
atlcli jira component delete PROJ/Backend --confirm
```

## Versions

### List Versions

```bash
atlcli jira version list --project PROJ
```

### Create Version

```bash
atlcli jira version create --project PROJ --name "1.0.0" --release-date 2025-03-01
```

### Release Version

```bash
atlcli jira version release --project PROJ --name "1.0.0"
```

### Archive Version

```bash
atlcli jira version archive --project PROJ --name "0.9.0"
```

## Using Fields in Issues

Set custom field values when creating/updating:

```bash
atlcli jira create --project PROJ --type Story --summary "Feature" --field customfield_10001=5
```

Query by custom fields:

```bash
atlcli jira search --jql "cf[10001] > 3"
```
