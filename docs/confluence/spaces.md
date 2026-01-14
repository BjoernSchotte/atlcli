# Spaces

Manage Confluence spaces.

## List Spaces

```bash
atlcli wiki space list
```

Options:

| Flag | Description |
|------|-------------|
| `--limit` | Maximum results |

Output:

```
KEY       NAME                 TYPE
TEAM      Team Documentation   global
DEV       Development          global
~alice    Alice's Space        personal
```

## Get Space

```bash
atlcli wiki space get --key TEAM
```

Output:

```json
{
  "schemaVersion": "1",
  "space": {
    "id": 12345,
    "key": "TEAM",
    "name": "Team Documentation",
    "type": "global",
    "url": "https://company.atlassian.net/wiki/spaces/TEAM"
  }
}
```

## Create Space

```bash
atlcli wiki space create --key NEWSPACE --name "New Documentation Space"
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Space key (required, uppercase) |
| `--name` | Space name (required) |
| `--description` | Space description |

### Example

```bash
atlcli wiki space create --key DOCS --name "Public Documentation" \
  --description "Customer-facing documentation"
```

## JSON Output

All commands support `--json`:

```bash
atlcli wiki space list --json
```

```json
{
  "schemaVersion": "1",
  "spaces": [
    {
      "id": 12345,
      "key": "TEAM",
      "name": "Team Documentation",
      "type": "global"
    },
    {
      "id": 12346,
      "key": "DEV",
      "name": "Development",
      "type": "global"
    }
  ]
}
```
