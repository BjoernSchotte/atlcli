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

Templates support hierarchical storage at three levels:

| Level | Location | Scope |
|-------|----------|-------|
| `global` | `~/.atlcli/templates/jira/` | Available everywhere |
| `profile` | `~/.atlcli/profiles/<name>/templates/jira/` | Available when using profile |
| `project` | `.atlcli/templates/jira/` | Available in project directory |

### Save to Specific Level

```bash
# Save globally (default)
atlcli jira template save my-template --issue PROJ-123

# Save to profile
atlcli jira template save my-template --issue PROJ-123 --level profile

# Save to project
atlcli jira template save my-template --issue PROJ-123 --level project
```

### List Shows All Levels

```bash
atlcli jira template list
```

Output:

```
NAME              TYPE    FIELDS  LEVEL            DESCRIPTION
bug-report        Bug     5       [global]         Standard bug report
feature-request   Story   4       [profile:work]   Team feature template
sprint-task       Task    3       [project:PROJ]   Project-specific task
```

### Resolution Order

When applying a template, atlcli searches in order:
1. Project level (`.atlcli/templates/jira/`)
2. Profile level (`~/.atlcli/profiles/<name>/templates/jira/`)
3. Global level (`~/.atlcli/templates/jira/`)

The first match wins, allowing project-specific overrides of global templates.

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
