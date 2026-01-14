# Filters

Save and manage JQL filters.

## List Filters

```bash
atlcli jira filter list
```

Options:

| Flag | Description |
|------|-------------|
| `--favorite` | Show only favorites |
| `--owner` | Filter by owner |

## Get Filter

```bash
atlcli jira filter get 12345
```

## Create Filter

```bash
atlcli jira filter create --name "My Open Bugs" --jql "assignee = currentUser() AND type = Bug AND status != Done"
```

Options:

| Flag | Description |
|------|-------------|
| `--name` | Filter name |
| `--jql` | JQL query |
| `--description` | Filter description |
| `--favorite` | Add to favorites |

## Update Filter

```bash
atlcli jira filter update 12345 --jql "assignee = currentUser() AND status = 'In Progress'"
```

## Delete Filter

```bash
atlcli jira filter delete 12345 --confirm
```

## Use Filter in Search

```bash
atlcli jira search --filter 12345
```

## Favorite Filters

```bash
# Add to favorites
atlcli jira filter favorite 12345

# Remove from favorites
atlcli jira filter unfavorite 12345
```
