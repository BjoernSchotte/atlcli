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

## Share Filter

Share a filter with users or groups:

```bash
atlcli jira filter share 12345 --user alice@company.com
atlcli jira filter share 12345 --group developers
atlcli jira filter share 12345 --project PROJ
```

Options:

| Flag | Description |
|------|-------------|
| `--user` | Share with user (email or account ID) |
| `--group` | Share with group |
| `--project` | Share with project |
| `--role` | Share with project role |
