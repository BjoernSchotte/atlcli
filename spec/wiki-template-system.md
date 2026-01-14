# Wiki Template System - Implementation Plan

## Overview

Implement a hierarchical template system for Confluence pages with three levels of scope: global, profile, and space. Templates support Handlebars syntax with typed variables, built-in helpers, and import/export functionality for template packs.

---

## Design Decisions Summary

| Decision | Choice |
|----------|--------|
| Precedence | Most specific wins: Space > Profile > Global |
| Global storage | `~/.config/atlcli/templates/` (configurable via `ATLCLI_TEMPLATES_DIR`) |
| Profile storage | `~/.config/atlcli/templates/<profile>/` |
| Space storage | Both: `.atlcli/templates/` in docs folder (checked first) + config folder |
| Template format | Markdown with YAML frontmatter |
| Variable syntax | Handlebars `{{variable}}` with full logic support (if, unless, each, with) |
| Variable input | CLI flags `--var key=value` with interactive fallback for required vars |
| Variable types | string, number, date, boolean, select (enum) + validation |
| Variable defaults | Handlebars syntax: `{{author "Team"}}` |
| Required vars | Explicit `required: true` in frontmatter |
| Template naming | Slug-style: lowercase, hyphens only |
| Inheritance | No inheritance (standalone templates) |
| Commands | `wiki template <action>` |
| List display | Flat list with level indicator |
| Pack format | Directory with manifest.yml |
| Import mode | Merge by default, `--replace` to overwrite |
| Remote import | Git URLs + direct URLs (shallow fetch) |
| Template engine | handlebars.js library |
| Architecture | Core engine in `@atlcli/core` (Jira-ready) |

---

## Template Storage Locations

### Global Templates
```
~/.config/atlcli/templates/
├── meeting-notes.md
├── sprint-retro.md
└── decision-record.md
```

Override with `ATLCLI_TEMPLATES_DIR` environment variable.

### Profile Templates
```
~/.config/atlcli/templates/
├── work/                    # Profile: work
│   ├── standup.md
│   └── team-update.md
└── personal/                # Profile: personal
    └── journal.md
```

### Space Templates (Two Locations)

**Option 1: In synced docs folder (checked first)**
```
./my-docs/                   # Synced docs directory
└── .atlcli/
    └── templates/
        ├── page-template.md
        └── runbook.md
```

**Option 2: Under config (fallback)**
```
~/.config/atlcli/templates/
└── work/                    # Profile
    └── TEAM/                # Space key
        └── team-specific.md
```

---

## Template File Format

```yaml
---
name: meeting-notes
description: Template for recurring team meetings
author: Björn Schotte
version: 1.0.0
tags:
  - meeting
  - team
category: meetings
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
    required: false
    description: Comma-separated list of attendees
  - name: type
    type: select
    options:
      - standup
      - planning
      - retro
    required: true
---
# {{title}}

**Date:** {{date}}
**Type:** {{type}}
**Attendees:** {{attendees "TBD"}}

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

---

## Variable Types

| Type | Description | Validation |
|------|-------------|------------|
| `string` | Free text | None |
| `number` | Numeric value | Must be valid number |
| `date` | Date value | ISO 8601 or relative (today, tomorrow) |
| `boolean` | True/false | Accepts true/false, yes/no, 1/0 |
| `select` | Enum from options | Must match one of `options` |

### Built-in Variables

| Variable | Description | Format |
|----------|-------------|--------|
| `{{date}}` | Current date | Configurable (default ISO 8601) |
| `{{datetime}}` | Current date and time | ISO 8601 |
| `{{time}}` | Current time | HH:MM |
| `{{user}}` | Current user display name | From profile |
| `{{space}}` | Current space key | From context |
| `{{profile}}` | Current profile name | From context |
| `{{year}}` | Current year | YYYY |
| `{{month}}` | Current month | MM |
| `{{day}}` | Current day | DD |

Date format configurable via `--date-format` flag or config setting.

---

## Commands

### List Templates

```bash
# List all templates (flat with level indicators)
atlcli wiki template list

# Output:
# meeting-notes      [global]     Template for recurring team meetings
# standup           [profile:work] Daily standup template
# runbook           [space:TEAM]   Operations runbook template

# Filter by level
atlcli wiki template list --level global
atlcli wiki template list --level profile
atlcli wiki template list --level space

# Filter by tags
atlcli wiki template list --tag meeting

# Search
atlcli wiki template list --search retro

# JSON output
atlcli wiki template list --json
```

### Show Template

```bash
# Show metadata and content
atlcli wiki template show meeting-notes

# Output:
# Name:        meeting-notes
# Level:       global
# Description: Template for recurring team meetings
# Author:      Björn Schotte
# Version:     1.0.0
# Tags:        meeting, team
# Variables:
#   - title (string, required)
#   - date (date, required)
#   - attendees (string, optional)
#   - type (select: standup|planning|retro, required)
#
# --- Content ---
# # {{title}}
# ...
```

### Create Template

```bash
# From file
atlcli wiki template create meeting-notes --file ./my-template.md

# Opens $EDITOR if no file specified
atlcli wiki template create meeting-notes

# Interactive wizard
atlcli wiki template create --interactive
# Prompts: name → description → tags → opens editor for content

# Specify target level
atlcli wiki template create standup --file ./standup.md --profile work
atlcli wiki template create runbook --file ./runbook.md --space TEAM
```

### Init Template from Existing Page

```bash
# From page ID
atlcli wiki template init meeting-template --from-page 12345

# From page title
atlcli wiki template init meeting-template --from-page "Team Meetings"

# From local synced .md file
atlcli wiki template init meeting-template --from-page ./docs/meetings/weekly.md

# Specify target level
atlcli wiki template init retro --from-page 12345 --profile work
```

### Edit Template

```bash
# Opens in $EDITOR
atlcli wiki template edit meeting-notes

# Edit profile-level template
atlcli wiki template edit standup --profile work
```

### Delete Template

```bash
# Interactive confirmation
atlcli wiki template delete meeting-notes

# Force delete
atlcli wiki template delete meeting-notes --force

# Delete from specific level
atlcli wiki template delete standup --profile work --force
```

### Rename Template

```bash
atlcli wiki template rename old-name new-name

# Rename at specific level
atlcli wiki template rename standup daily-standup --profile work
```

### Copy Template

```bash
# Copy between levels
atlcli wiki template copy meeting-notes --from global --to profile:work

# Copy and rename
atlcli wiki template copy meeting-notes team-meeting --from global --to space:TEAM
```

### Validate Template

```bash
# Validate syntax, variables, Handlebars
atlcli wiki template validate meeting-notes

# Validate all templates
atlcli wiki template validate --all

# Validate template file before creating
atlcli wiki template validate --file ./my-template.md
```

### Render Template

```bash
# Render without creating page
atlcli wiki template render meeting-notes --var title="Sprint Planning" --var date=today

# Output to file
atlcli wiki template render meeting-notes --var title="Planning" > rendered.md
```

### Using Templates (Page Create)

```bash
# Create page from template
atlcli wiki page create --template meeting-notes \
  --var title="Sprint Planning" \
  --var date=2026-01-14 \
  --var type=planning \
  --space TEAM

# Interactive prompts for missing required variables
atlcli wiki page create --template meeting-notes --space TEAM
# Prompts: title? date? type?

# Dry run (preview)
atlcli wiki page create --template meeting-notes \
  --var title="Test" \
  --dry-run
```

---

## Import/Export

### Export Templates

```bash
# Export all templates to directory
atlcli wiki template export
# Creates: ./templates-export/

# Export to specific path
atlcli wiki template export ./my-templates

# Export single template to stdout
atlcli wiki template export meeting-notes
# Outputs template content to stdout

# Export single template to file
atlcli wiki template export meeting-notes -o ./meeting-notes.md

# Export from specific level
atlcli wiki template export --level global
atlcli wiki template export --profile work
atlcli wiki template export --space TEAM

# Export specific templates
atlcli wiki template export meeting-notes standup retro
```

### Export Directory Structure

```
./templates-export/
├── manifest.yml
├── global/
│   ├── meeting-notes.md
│   └── decision-record.md
├── profiles/
│   └── work/
│       └── standup.md
└── spaces/
    └── TEAM/
        └── runbook.md
```

### Manifest Format

```yaml
name: my-template-pack
version: 1.0.0
author: Björn Schotte
description: Collection of team templates
exported_at: 2026-01-14T16:00:00Z
templates:
  global:
    - meeting-notes
    - decision-record
  profiles:
    work:
      - standup
  spaces:
    TEAM:
      - runbook
```

### Import Templates

```bash
# Import from local directory
atlcli wiki template import ./templates-export

# Import from git URL (shallow fetch)
atlcli wiki template import https://github.com/user/template-pack

# Import from direct URL
atlcli wiki template import https://example.com/templates.tar.gz

# Import to specific level (overrides manifest)
atlcli wiki template import ./templates --global
atlcli wiki template import ./templates --profile work
atlcli wiki template import ./templates --space TEAM

# Replace existing (default is merge/skip)
atlcli wiki template import ./templates --replace

# Import specific templates only
atlcli wiki template import ./templates --only meeting-notes,standup
```

### Update from Remote

```bash
# Re-import from original source
atlcli wiki template update --source https://github.com/user/template-pack

# Update specific templates
atlcli wiki template update meeting-notes --source https://github.com/user/template-pack
```

---

## Architecture

### Package Structure

```
packages/
├── core/
│   └── src/
│       └── templates/
│           ├── index.ts           # Public exports
│           ├── engine.ts          # Handlebars wrapper, rendering
│           ├── parser.ts          # Frontmatter parsing, validation
│           ├── types.ts           # Template types, variable types
│           ├── storage.ts         # Template storage abstraction
│           ├── resolver.ts        # Multi-level resolution (precedence)
│           ├── builtins.ts        # Built-in variables (date, user, etc.)
│           └── validation.ts      # Schema validation
└── confluence/
    └── src/
        └── templates/
            ├── index.ts           # Confluence-specific exports
            ├── commands.ts        # CLI command handlers
            └── importer.ts        # Import/export logic
```

### Core Types

```typescript
// packages/core/src/templates/types.ts

export type VariableType = 'string' | 'number' | 'date' | 'boolean' | 'select';

export interface TemplateVariable {
  name: string;
  type: VariableType;
  required?: boolean;
  default?: string;
  description?: string;
  options?: string[];  // For select type
}

export interface TemplateMetadata {
  name: string;
  description?: string;
  author?: string;
  version?: string;
  tags?: string[];
  category?: string;
  variables?: TemplateVariable[];
}

export interface Template {
  metadata: TemplateMetadata;
  content: string;
  source: TemplateSource;
}

export interface TemplateSource {
  level: 'global' | 'profile' | 'space';
  profile?: string;
  space?: string;
  path: string;
}

export interface TemplatePackManifest {
  name: string;
  version: string;
  author?: string;
  description?: string;
  exported_at?: string;
  templates: {
    global?: string[];
    profiles?: Record<string, string[]>;
    spaces?: Record<string, string[]>;
  };
}

export interface RenderContext {
  variables: Record<string, unknown>;
  builtins: Record<string, unknown>;
  dateFormat?: string;
}

export interface RenderResult {
  content: string;
  usedVariables: string[];
  missingVariables: string[];
}
```

### Template Engine

```typescript
// packages/core/src/templates/engine.ts

import Handlebars from 'handlebars';

export class TemplateEngine {
  private handlebars: typeof Handlebars;

  constructor() {
    this.handlebars = Handlebars.create();
    this.registerBuiltins();
  }

  private registerBuiltins(): void {
    // Register built-in helpers and variables
  }

  render(template: string, context: RenderContext): RenderResult {
    // Render template with context
  }

  validate(template: string): ValidationResult {
    // Validate Handlebars syntax
  }
}
```

### Storage Abstraction

```typescript
// packages/core/src/templates/storage.ts

export interface TemplateStorage {
  list(filter?: TemplateFilter): Promise<TemplateSummary[]>;
  get(name: string): Promise<Template | null>;
  save(template: Template): Promise<void>;
  delete(name: string): Promise<void>;
  exists(name: string): Promise<boolean>;
}

export class GlobalTemplateStorage implements TemplateStorage { }
export class ProfileTemplateStorage implements TemplateStorage { }
export class SpaceTemplateStorage implements TemplateStorage { }
```

### Resolver (Precedence)

```typescript
// packages/core/src/templates/resolver.ts

export class TemplateResolver {
  constructor(
    private global: TemplateStorage,
    private profile: TemplateStorage,
    private space: TemplateStorage,
  ) {}

  async resolve(name: string): Promise<Template | null> {
    // Space > Profile > Global
    return await this.space.get(name)
      ?? await this.profile.get(name)
      ?? await this.global.get(name);
  }

  async listAll(): Promise<TemplateSummary[]> {
    // Merge all levels, mark with source
  }
}
```

---

## CLI Integration

### Command Registration

```typescript
// apps/cli/src/commands/wiki.ts

// Add to wiki subcommands:
case "template":
  await handleTemplate(args.slice(1), flags, opts);
  return;
```

### Handler Structure

```typescript
// apps/cli/src/commands/wiki-template.ts

export async function handleTemplate(
  args: string[],
  flags: Record<string, FlagValue>,
  opts: GlobalOptions
): Promise<void> {
  const action = args[0];

  switch (action) {
    case "list":
      await handleTemplateList(args.slice(1), flags, opts);
      break;
    case "show":
      await handleTemplateShow(args.slice(1), flags, opts);
      break;
    case "create":
      await handleTemplateCreate(args.slice(1), flags, opts);
      break;
    case "init":
      await handleTemplateInit(args.slice(1), flags, opts);
      break;
    case "edit":
      await handleTemplateEdit(args.slice(1), flags, opts);
      break;
    case "delete":
      await handleTemplateDelete(args.slice(1), flags, opts);
      break;
    case "rename":
      await handleTemplateRename(args.slice(1), flags, opts);
      break;
    case "copy":
      await handleTemplateCopy(args.slice(1), flags, opts);
      break;
    case "validate":
      await handleTemplateValidate(args.slice(1), flags, opts);
      break;
    case "render":
      await handleTemplateRender(args.slice(1), flags, opts);
      break;
    case "export":
      await handleTemplateExport(args.slice(1), flags, opts);
      break;
    case "import":
      await handleTemplateImport(args.slice(1), flags, opts);
      break;
    case "update":
      await handleTemplateUpdate(args.slice(1), flags, opts);
      break;
    default:
      showTemplateHelp();
  }
}
```

---

## Implementation Phases

### Phase 1: Core Foundation
- [ ] Add `handlebars` dependency to `@atlcli/core`
- [ ] Implement `TemplateEngine` with Handlebars wrapper
- [ ] Implement `TemplateParser` for frontmatter + content
- [ ] Implement built-in variables (date, user, space, etc.)
- [ ] Implement variable type validation
- [ ] Add template types to `@atlcli/core`

### Phase 2: Storage Layer
- [ ] Implement `GlobalTemplateStorage`
- [ ] Implement `ProfileTemplateStorage`
- [ ] Implement `SpaceTemplateStorage` (both locations)
- [ ] Implement `TemplateResolver` with precedence
- [ ] Add storage path configuration

### Phase 3: Basic Commands
- [ ] `wiki template list` with filters
- [ ] `wiki template show`
- [ ] `wiki template create` (from file + editor)
- [ ] `wiki template edit`
- [ ] `wiki template delete`
- [ ] `wiki template rename`
- [ ] `wiki template validate`

### Phase 4: Template Usage
- [ ] `wiki template render`
- [ ] Integrate `--template` flag into `wiki page create`
- [ ] Interactive variable prompts
- [ ] `--dry-run` preview support

### Phase 5: Advanced Commands
- [ ] `wiki template init` (from page)
- [ ] `wiki template copy` (cross-level)
- [ ] Interactive creation wizard

### Phase 6: Import/Export
- [ ] `wiki template export` (single + directory)
- [ ] Export manifest generation
- [ ] `wiki template import` (local directory)
- [ ] Git URL import (shallow fetch)
- [ ] Direct URL import
- [ ] `wiki template update` (re-import from source)

### Phase 7: Documentation
- [ ] Update docs/confluence/templates.md
- [ ] Add template examples to docs
- [ ] Document built-in variables
- [ ] Document Handlebars syntax support

---

## Dependencies

### New Dependencies

```json
// packages/core/package.json
{
  "dependencies": {
    "handlebars": "^4.7.8"
  }
}
```

### Optional Dependencies (for import)

```json
{
  "dependencies": {
    "tar": "^7.0.0",          // For .tar.gz extraction
    "simple-git": "^3.22.0"   // For git clone operations
  }
}
```

---

## Configuration

### Global Config

```yaml
# ~/.config/atlcli/config.yml
templates:
  directory: ~/.config/atlcli/templates  # Override with ATLCLI_TEMPLATES_DIR
  date_format: "YYYY-MM-DD"              # Default date format for {{date}}
  editor: code                           # Override $EDITOR for template editing
```

### Profile Config

```yaml
# ~/.config/atlcli/profiles/work.yml
templates:
  date_format: "DD.MM.YYYY"  # German date format for this profile
```

---

## Error Handling

| Error | Message |
|-------|---------|
| Template not found | `Template 'xyz' not found. Run 'wiki template list' to see available templates.` |
| Variable required | `Required variable 'title' not provided. Use --var title=VALUE or run interactively.` |
| Invalid variable type | `Variable 'count' expects a number, got 'abc'.` |
| Invalid select value | `Variable 'type' must be one of: standup, planning, retro. Got 'invalid'.` |
| Template exists | `Template 'meeting' already exists at global level. Use --replace to overwrite.` |
| Invalid Handlebars | `Template syntax error at line 15: Unexpected closing tag.` |
| Import failed | `Failed to import from URL: 404 Not Found` |

---

## Future Considerations

1. **Jira Templates**: Same engine can power `jira template` commands
2. **Template Marketplace**: Community template repository
3. **Template Versioning**: Track changes to templates over time
4. **Template Inheritance**: Allow extends/partials if needed later
5. **Template Hooks**: Pre/post-render hooks for customization
