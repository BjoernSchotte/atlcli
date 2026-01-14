# Templates

Save issue configurations as templates for quick reuse.

## List Templates

```bash
atlcli jira template list
```

## Save Template

Save an existing issue as a template:

```bash
atlcli jira template save bug-report --issue PROJ-123
```

Options:

| Flag | Description |
|------|-------------|
| `--issue` | Source issue key |
| `--description` | Template description |
| `--force` | Overwrite existing template |

## View Template

```bash
atlcli jira template get bug-report
```

## Apply Template

Create an issue from a template:

```bash
atlcli jira template apply bug-report --project PROJ --summary "Login fails on mobile"
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Target project (required) |
| `--summary` | Issue summary (required) |
| `--assignee` | Override assignee |

## Delete Template

```bash
atlcli jira template delete bug-report --confirm
```

## Export Template

Export to a JSON file:

```bash
atlcli jira template export bug-report -o ./templates/bug-report.json
```

## Import Template

Import from a JSON file:

```bash
atlcli jira template import --file ./templates/bug-report.json
```

## Template Storage

Templates are stored locally at `~/.config/atlcli/templates/jira/`.

## Captured Fields

Templates capture:

- Issue type
- Summary (as pattern)
- Description
- Priority (by ID)
- Labels
- Components
- Fix versions
- Custom fields

Templates never capture project, assignee, status, or system fields.
