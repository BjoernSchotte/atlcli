# Templates

Create Confluence pages from reusable templates with variable substitution and Handlebars syntax.

::: toc

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Space permission**: Edit permission to create pages from templates

## Overview

The template system provides:
- **Hierarchical storage**: Global, profile, and space-level templates
- **Precedence**: Space > Profile > Global (most specific wins)
- **Handlebars syntax**: Full logic support (if, unless, each, with)
- **Built-in variables**: Date, time, user, space, and more
- **Import/export**: Share template packs via directories, Git, or URLs

## Quick Start

```bash
# Create a template
atlcli wiki template create meeting-notes --file ./meeting.md

# List available templates
atlcli wiki template list

# Create a page from template
atlcli wiki page create --template meeting-notes \
  --var title="Sprint Planning" \
  --var date=2025-01-14 \
  --space TEAM

# Render template to stdout (preview)
atlcli wiki template render meeting-notes --var title="Test"
```

## Template File Format

Templates are Markdown files with YAML frontmatter:

```markdown
---
name: meeting-notes
description: Template for team meetings
author: Your Name
version: 1.0.0
tags:
  - meeting
  - team
variables:
  - name: title
    type: string
    required: true
    description: Meeting title
  - name: date
    type: date
    required: true
  - name: attendees
    type: string
    default: "TBD"
  - name: type
    type: select
    options:
      - standup
      - planning
      - retro
    required: true
---
# {{title}}

**Date:** {{@date}}
**Type:** {{type}}
**Attendees:** {{attendees}}

## Agenda

{{#if agenda}}
{{agenda}}
{{else}}
- Item 1
- Item 2
{{/if}}

## Notes

<!-- Add meeting notes here -->

## Action Items

| Owner | Action | Due |
|-------|--------|-----|
|       |        |     |
```

## Variable Types

| Type | Description | Validation |
|------|-------------|------------|
| `string` | Free text | None |
| `number` | Numeric value | Must be valid number |
| `date` | Date value | ISO 8601 or relative (today, tomorrow) |
| `boolean` | True/false | Accepts true/false, yes/no, 1/0 |
| `select` | Enum from options | Must match one of `options` |

## Built-in Variables

Built-in variables use the `@` prefix:

| Variable | Description | Example |
|----------|-------------|---------|
| `{{@date}}` | Current date | 2025-01-14 |
| `{{@datetime}}` | Date and time | 2025-01-14T10:30:00 |
| `{{@time}}` | Current time | 10:30 |
| `{{@year}}` | Current year | 2025 |
| `{{@month}}` | Current month | 01 |
| `{{@day}}` | Current day | 14 |
| `{{@weekday}}` | Day of week | Tuesday |
| `{{@user}}` | Current user | john.doe |
| `{{@space}}` | Space key | TEAM |
| `{{@profile}}` | Profile name | work |
| `{{@title}}` | Page title | From context |
| `{{@parent.id}}` | Parent page ID | 12345 |
| `{{@parent.title}}` | Parent page title | Parent Page |
| `{{@uuid}}` | Random UUID | 550e8400-e29b-... |

## Storage Locations

atlcli stores templates at three levels with precedence (space > profile > global):

### Global Templates
```
~/.atlcli/templates/global/
├── meeting-notes.md
└── decision-record.md
```

### Profile Templates
```
~/.atlcli/templates/profiles/
└── work/
    └── standup.md
```

### Space Templates
```
# In synced docs folder (checked first)
./my-docs/.atlcli/templates/
└── runbook.md

# Or under config
~/.atlcli/templates/spaces/TEAM/
└── team-specific.md
```

## Commands

### List Templates

```bash
# List all templates
atlcli wiki template list

# Filter by level
atlcli wiki template list --level global
atlcli wiki template list --profile work
atlcli wiki template list --space TEAM

# Filter by tag
atlcli wiki template list --tag meeting

# Search
atlcli wiki template list --search retro

# Include overridden templates
atlcli wiki template list --all

# JSON output
atlcli wiki template list --json
```

### Show Template

```bash
# Show template details and content
atlcli wiki template show meeting-notes

# Show from specific level
atlcli wiki template show standup --profile work
```

### Create Template

```bash
# From file
atlcli wiki template create meeting-notes --file ./template.md

# Open in $EDITOR
atlcli wiki template create meeting-notes

# Interactive wizard
atlcli wiki template create --interactive

# Create at specific level
atlcli wiki template create standup --profile work --file ./standup.md
atlcli wiki template create runbook --space TEAM --file ./runbook.md

# Overwrite existing
atlcli wiki template create meeting-notes --file ./updated.md --force
```

### Edit Template

```bash
# Opens in $EDITOR
atlcli wiki template edit meeting-notes

# Edit at specific level
atlcli wiki template edit standup --profile work
```

### Delete Template

```bash
# With confirmation
atlcli wiki template delete meeting-notes

# Force delete
atlcli wiki template delete meeting-notes --force

# Delete from specific level
atlcli wiki template delete standup --profile work --force
```

### Rename Template

```bash
atlcli wiki template rename old-name new-name
atlcli wiki template rename standup daily-standup --profile work
```

### Validate Template

```bash
# Validate specific template
atlcli wiki template validate meeting-notes

# Validate from file
atlcli wiki template validate --file ./template.md

# Validate all templates
atlcli wiki template validate --all
```

### Render Template

```bash
# Render to stdout
atlcli wiki template render meeting-notes --var title="Sprint Planning"

# With multiple variables
atlcli wiki template render meeting-notes \
  --var title="Planning" \
  --var date=today \
  --var type=planning

# Interactive prompts for missing variables
atlcli wiki template render meeting-notes --interactive

# Output to file
atlcli wiki template render meeting-notes --var title="Test" > output.md

# JSON output
atlcli wiki template render meeting-notes --var title="Test" --json
```

### Init Template from Existing Content

```bash
# From Confluence page ID
atlcli wiki template init meeting-template --from 12345

# From page title (requires --from-space)
atlcli wiki template init meeting-template --from "Team Meetings" --from-space TEAM

# From local file
atlcli wiki template init meeting-template --from ./docs/meetings.md

# Save to specific level
atlcli wiki template init retro --from 12345 --to-profile work
```

### Copy Template

```bash
# Copy between levels
atlcli wiki template copy meeting-notes --from-level global --to-profile work

# Copy with rename
atlcli wiki template copy meeting-notes team-meeting --from-level global --to-space TEAM
```

## Import/Export

### Export Templates

```bash
# Export all to directory
atlcli wiki template export -o ./my-templates

# Export single template to stdout
atlcli wiki template export meeting-notes

# Export single to file
atlcli wiki template export meeting-notes -o ./meeting-notes.md

# Export from specific level
atlcli wiki template export --profile work -o ./work-templates
```

**Export directory structure:**
```
./my-templates/
├── manifest.yml
├── global/
│   └── meeting-notes.md
├── profiles/
│   └── work/
│       └── standup.md
└── spaces/
    └── TEAM/
        └── runbook.md
```

### Import Templates

```bash
# From local directory
atlcli wiki template import ./my-templates

# From Git URL
atlcli wiki template import https://github.com/user/template-pack

# From tar.gz URL
atlcli wiki template import https://example.com/templates.tar.gz

# Flatten to single level
atlcli wiki template import ./templates --to-profile work

# Replace existing (default: skip)
atlcli wiki template import ./templates --replace

# Import specific templates only
atlcli wiki template import ./templates meeting-notes standup
```

### Update from Remote

```bash
# Update all tracked templates
atlcli wiki template update

# Update specific templates
atlcli wiki template update meeting-notes standup

# Update from specific source
atlcli wiki template update --source https://github.com/user/template-pack
```

## Using Templates with Page Create

```bash
# Create page from template
atlcli wiki page create --template meeting-notes \
  --var title="Sprint Planning" \
  --var date=2025-01-14 \
  --space TEAM

# Interactive prompts for variables
atlcli wiki page create --template meeting-notes --space TEAM

# Dry run (preview)
atlcli wiki page create --template meeting-notes \
  --var title="Test" \
  --dry-run
```

## Handlebars Syntax

Templates support full Handlebars syntax:

### Conditionals

```handlebars
{{#if attendees}}
**Attendees:** {{attendees}}
{{else}}
**Attendees:** TBD
{{/if}}

{{#unless draft}}
This is published content.
{{/unless}}
```

### Loops

```handlebars
{{#each items}}
- {{this}}
{{/each}}

{{#each tasks}}
- [ ] {{this.title}} ({{this.assignee}})
{{/each}}
```

### With Context

```handlebars
{{#with author}}
**Author:** {{name}} ({{email}})
{{/with}}
```

### Default Values

```handlebars
{{attendees "TBD"}}
```

## Tips

1. **Use built-in variables** for dynamic content like dates and user info
2. **Define required variables** in frontmatter to ensure pages are complete
3. **Use tags** to organize templates by category
4. **Export templates** to share with your team or back up
5. **Track sources** with import to enable easy updates

## Troubleshooting

### Variable Not Replaced

**Symptom**: `{{variable}}` appears literally in output.

**Causes**:
- Variable name typo
- Variable not passed with `--var`
- Missing `@` prefix for built-in variables

**Fix**: Check variable names match frontmatter definitions. Use `--interactive` to see prompts.

### Template Not Found

**Symptom**: `Error: Template 'name' not found`

**Cause**: Template doesn't exist at any storage level.

**Fix**: List available templates with `atlcli wiki template list --all` and check the name.

## Related Topics

- [Pages](pages.md) - Create pages from templates with `--template` flag
- [Macros](macros.md) - Use macros within template content
- [Configuration](../configuration.md) - Template storage paths
