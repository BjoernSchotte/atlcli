---
title: "Templates"
description: "Templates - atlcli documentation"
---

# Templates

Save issue configurations as templates for quick reuse.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects (to save from existing issues)

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
| `--issue` | Source issue key (required) |
| `--description` | Template description |
| `--tags` | Comma-separated tags |
| `--level` | Storage level: `global`, `profile` or `project` (see [Choosing a Level](#choosing-a-level)) |
| `--project` | Project key for project-level storage |
| `--force` | Overwrite existing template |

Placeholders in the source issue are kept, and every [template variable](/templating/)
the fields use is recorded in the template as a required string:

```json
{
  "name": "release",
  "fields": { "summary": "Release {{version}}", "labels": ["rel-{{version}}"] },
  "variables": [{ "name": "version", "type": "string", "required": true }]
}
```

Edit `variables` (in the file, or export, edit and import) to give a type,
a default, `select` options or a description. Older templates without
`variables` keep working; their variables are then only inferred.

## View Template

```bash
atlcli jira template get bug-report
```

The output includes the template's `variables`.

## Apply Template

Create an issue from a template:

```bash
atlcli jira template apply bug-report --project PROJ --summary "Login fails on mobile"
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Target project (required, or `global.project`) |
| `--summary` | Issue summary (default: the template's summary; required if the template has none) |
| `--description` | Description instead of the template's |
| `--assignee` | Assignee (see [Users](issues.md#users)) |
| `--var <name=value>` | Template variable, repeatable |
| `--vars-file <file>` | Values and declarations, see [Templating](/templating/#variables) |
| `--now <iso>` | Freezes `today`/`now` |
| `--strict` | Fails on any template warning, before the issue is created |

Summary, description, labels, the due date and other fields render as
templates; `--summary` and `--description` do too. At a terminal, atlcli asks
for required variables you didn't pass. Without one (CI, `--json`, `--yes`) it
fails and names them:

```bash
atlcli jira template apply release --project REL --var version=4.2
# Due in two weeks, from a template with  "duedate": "{{ today | dateAdd(14, \"d\") }}"
```

:::note[Data Center]
`--assignee` needs a Cloud account ID. On Data Center it is ignored; assign the issue afterwards with `issue assign`.
:::

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
| `global` | `~/.atlcli/templates/jira/global/` | Available everywhere |
| `profile` | `~/.atlcli/templates/jira/profiles/<name>/` | Available when using that profile |
| `project` | `~/.atlcli/templates/jira/projects/<key>/` | Available for that project |

The base directory can be relocated with the `ATLCLI_TEMPLATES_DIR` environment
variable.

### Choosing a Level

`save`, `import`, `delete` and `list` all pick a storage level with the same rule:

1. an explicit `--level <global|profile|project>` always wins;
2. otherwise `--project <key>` selects project storage;
3. otherwise `--profile <name>` selects profile storage;
4. otherwise global.

`--profile` is primarily the **auth-profile** flag, so it is the weakest storage
signal — passing it does not divert a template away from the level you asked for.
An unrecognised `--level` value is rejected rather than silently falling back to
another level.

:::tip[Use the same flags to save and to delete]
A template is only found again at the level it was written to. Whatever flag
combination you saved with, use it again for `delete`:

```bash
atlcli jira template save sprint-task --issue PROJ-123 --level project --project PROJ
atlcli jira template delete sprint-task --level project --project PROJ --confirm
```
:::

### Save to Specific Level

```bash
# Save globally (default)
atlcli jira template save my-template --issue PROJ-123

# Save to profile
atlcli jira template save my-template --issue PROJ-123 --level profile

# Save to project
atlcli jira template save my-template --issue PROJ-123 --level project --project PROJ

# --project on its own implies project level
atlcli jira template save my-template --issue PROJ-123 --project PROJ
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
1. Project level (`~/.atlcli/templates/jira/projects/<key>/`)
2. Profile level (`~/.atlcli/templates/jira/profiles/<name>/`)
3. Global level (`~/.atlcli/templates/jira/global/`)

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

## Related Topics

- [Issues](issues.md) - Create and manage issues
- [Projects](projects.md) - Project configuration
