# Wiki Template System - Implementation Plan

## Overview

Implement a hierarchical template system for Confluence pages with three levels of scope: global, profile, and space. Templates support Handlebars syntax with typed variables, built-in helpers, and import/export functionality for template packs.

---

## Design Decisions Summary

| Decision | Choice |
|----------|--------|
| Precedence | Most specific wins: Space > Profile > Global |
| Global storage | `~/.config/atlcli/templates/global/` (base configurable via `ATLCLI_TEMPLATES_DIR`) |
| Profile storage | `~/.config/atlcli/templates/profiles/<profile>/` |
| Space storage | Both: `.atlcli/templates/` in docs folder (checked first) + `~/.config/atlcli/templates/spaces/<space>/` |
| Template format | Markdown with YAML frontmatter |
| Variable syntax | Handlebars `{{variable}}` with full logic support (if, unless, each, with) |
| Variable input | CLI flags `--var key=value` with interactive fallback for required vars |
| Variable types | string, number, date, boolean, select (enum) + validation |
| Variable defaults | Frontmatter `default:` field (custom helper `{{var "default"}}` also supported, frontmatter takes precedence) |
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
└── global/
    ├── meeting-notes.md
    ├── sprint-retro.md
    └── decision-record.md
```

Override base path with `ATLCLI_TEMPLATES_DIR` environment variable.

### Profile Templates
```
~/.config/atlcli/templates/
└── profiles/
    ├── work/                # Profile: work
    │   ├── standup.md
    │   └── team-update.md
    └── personal/            # Profile: personal
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
└── spaces/
    └── TEAM/                # Space key
        └── team-specific.md
```

> **Note**: The explicit `global/`, `profiles/`, and `spaces/` subdirectories prevent naming collisions between template names and profile/space names.
>
> **Space templates are space-scoped, not profile-scoped**: A Confluence space (e.g., TEAM) is the same regardless of which auth profile you use. Space templates in config are stored by space key only.

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
  - name: agenda
    type: string
    required: false
    description: Pre-filled agenda items (optional)
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

Built-in variables use the `@` prefix to distinguish them from user-defined variables (consistent with Handlebars' convention for special variables like `@index`, `@first`).

| Variable | Description | Format |
|----------|-------------|--------|
| `{{@date}}` | Current date | Configurable (default ISO 8601) |
| `{{@datetime}}` | Current date and time | ISO 8601 |
| `{{@time}}` | Current time | HH:MM |
| `{{@user}}` | Current user display name | From profile |
| `{{@space}}` | Current space key | From context |
| `{{@profile}}` | Current profile name | From context |
| `{{@year}}` | Current year | YYYY |
| `{{@month}}` | Current month | MM |
| `{{@day}}` | Current day | DD |

**Date format precedence** (highest to lowest):
1. `--date-format` flag on command
2. Profile config `templates.date_format`
3. Global config `templates.date_format`
4. Default: ISO 8601 (`YYYY-MM-DD`)

---

## Commands

### List Templates

```bash
# List all templates (flat with level indicators)
atlcli wiki template list

# Output:
# meeting-notes      [global]       Template for recurring team meetings
# standup            [profile:work] Daily standup template
# runbook            [space:TEAM]   Operations runbook template

# Filter by level (category filter)
atlcli wiki template list --level global            # Only global templates
atlcli wiki template list --level profile           # All profile templates (across all profiles)
atlcli wiki template list --level space             # All space templates (across all spaces)

# Filter to specific profile or space
atlcli wiki template list --profile work            # Only templates from profile "work"
atlcli wiki template list --space TEAM              # Only templates from space "TEAM"

# Note: --level is a category filter, --profile/--space are specific filters
# Using --profile or --space implies the corresponding level

# Show all levels including overridden templates
atlcli wiki template list --all
# Output shows shadowed templates:
# meeting-notes      [global]       Template for recurring team meetings
# meeting-notes      [space:TEAM]   (overrides global) Team-specific meeting notes

# Filter by tags
atlcli wiki template list --tag meeting

# Search
atlcli wiki template list --search retro

# JSON output
atlcli wiki template list --json
```

**Context inference**: When run inside a synced docs folder, space templates from that folder are automatically included. Otherwise, use `--space` to specify.

**Shorthand**: Use `--space .` or `--profile .` to refer to the current context (inferred from synced docs folder or active profile).

### Show Template

```bash
# Show metadata and content (resolves by precedence: space > profile > global)
atlcli wiki template show meeting-notes

# Show from specific level
atlcli wiki template show meeting-notes --level global
atlcli wiki template show standup --profile work
atlcli wiki template show runbook --space TEAM

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

**Ambiguity handling**: Same as edit/delete - if name exists at multiple levels, prompts for selection.

### Create Template

```bash
# From file (default: global level)
atlcli wiki template create meeting-notes --file ./my-template.md

# Opens $EDITOR if no file specified
atlcli wiki template create meeting-notes

# Interactive wizard
atlcli wiki template create --interactive
# Prompts: name → description → tags → opens editor for content

# Specify target level
atlcli wiki template create standup --file ./standup.md --profile work
atlcli wiki template create runbook --file ./runbook.md --space TEAM

# Overwrite existing template
atlcli wiki template create meeting-notes --file ./updated.md --force
```

**Default level**: Global. Use `--profile` or `--space` to create at other levels. When run inside a synced docs folder, you can use `--space .` to create in the current space's templates.

**Overwrite behavior**: If template already exists at target level, fails with error unless `--force` is specified.

### Init Template from Existing Content

```bash
# From page ID (default: saves to global)
atlcli wiki template init meeting-template --from 12345

# From page title (requires --from-space to resolve the page)
atlcli wiki template init meeting-template --from "Team Meetings" --from-space TEAM

# From local synced .md file
atlcli wiki template init meeting-template --from ./docs/meetings/weekly.md

# Specify target level with --to-* flags
atlcli wiki template init retro --from 12345 --to-profile work
atlcli wiki template init runbook --from "Ops Guide" --from-space OPS --to-space TEAM
```

The `--from` flag auto-detects the source type:
- Numeric value → page ID
- Path with `/` or `.md` → local file
- Otherwise → page title (requires `--from-space` to resolve)

**Source flags**: `--from-space <key>` resolves page titles in that space.

**Target flags**: `--to-profile <name>` or `--to-space <key>` to save at specific level. Default: global.

**Variable identification**: The init command creates a template with the page content as-is (no automatic variable detection). After init, edit the template to:
1. Replace dynamic content with `{{variables}}`
2. Add variable definitions to frontmatter
3. Validate with `wiki template validate`

### Edit Template

```bash
# Opens in $EDITOR (resolves by precedence: space > profile > global)
atlcli wiki template edit meeting-notes

# Edit at specific level (required if same name exists at multiple levels)
atlcli wiki template edit meeting-notes --level global
atlcli wiki template edit standup --profile work
atlcli wiki template edit runbook --space TEAM
```

**Ambiguity handling**: If a template name exists at multiple levels and no level is specified, the command shows which levels have it and asks you to specify.

### Delete Template

```bash
# Interactive confirmation (resolves by precedence)
atlcli wiki template delete meeting-notes

# Force delete
atlcli wiki template delete meeting-notes --force

# Delete from specific level
atlcli wiki template delete standup --profile work --force
atlcli wiki template delete runbook --space TEAM --force
```

**Ambiguity handling**: Same as edit - if name exists at multiple levels, prompts for level selection unless `--level`, `--profile`, or `--space` is specified.

### Rename Template

```bash
# Rename (resolves by precedence if ambiguous)
atlcli wiki template rename old-name new-name

# Rename at specific level
atlcli wiki template rename standup daily-standup --profile work
atlcli wiki template rename meeting team-meeting --level global
atlcli wiki template rename runbook ops-runbook --space TEAM
```

**Ambiguity handling**: Same as show/edit/delete - if name exists at multiple levels, prompts for selection.

### Copy Template

```bash
# Copy between levels (same name)
atlcli wiki template copy meeting-notes --from-level global --to-profile work

# Copy with rename (new-name is optional second positional arg)
atlcli wiki template copy meeting-notes team-meeting --from-level global --to-space TEAM

# Copy to global from profile
atlcli wiki template copy standup --from-profile work --to-level global
```

**Syntax**: `wiki template copy <source-name> [<target-name>] --from-X --to-Y`

Flag patterns for source:
- `--from-level global` - from global level
- `--from-profile <name>` - from specific profile
- `--from-space <key>` - from specific space

Flag patterns for target:
- `--to-level global` - to global level
- `--to-profile <name>` - to specific profile
- `--to-space <key>` - to specific space

### Validate Template

```bash
# Validate syntax, variables, Handlebars (resolves by precedence)
atlcli wiki template validate meeting-notes

# Validate at specific level
atlcli wiki template validate meeting-notes --level global
atlcli wiki template validate standup --profile work

# Validate all templates
atlcli wiki template validate --all

# Validate template file before creating
atlcli wiki template validate --file ./my-template.md
```

**Ambiguity handling**: Same as other commands - prompts for level if name exists at multiple levels.

### Render Template

```bash
# Render without creating page (outputs to stdout, resolves by precedence)
atlcli wiki template render meeting-notes --var title="Sprint Planning" --var date=today

# Render from specific level
atlcli wiki template render meeting-notes --level global --var title="Planning"

# Output to file
atlcli wiki template render meeting-notes --var title="Planning" > rendered.md

# Render with interactive variable prompts
atlcli wiki template render meeting-notes --interactive
```

> **Note**: `render` outputs rendered markdown. For previewing with page context (parent, space), use `wiki page create --template X --dry-run` instead.

**Ambiguity handling**: Same as other commands - prompts for level if name exists at multiple levels.

### Using Templates (Page Create)

```bash
# Create page from template (resolves by precedence if ambiguous)
atlcli wiki page create --template meeting-notes \
  --var title="Sprint Planning" \
  --var date=2026-01-14 \
  --var type=planning \
  --space TEAM

# Use template from specific level
atlcli wiki page create --template meeting-notes --template-level global \
  --var title="Planning" --space TEAM

# Interactive prompts for missing required variables
atlcli wiki page create --template meeting-notes --space TEAM
# Prompts: title? date? type?

# Dry run (preview)
atlcli wiki page create --template meeting-notes \
  --var title="Test" \
  --dry-run
```

**Template resolution**: Uses same precedence as other commands (space > profile > global). Use `--template-level` to select specific level if same name exists at multiple levels.

---

## Import/Export

### Export Templates

```bash
# Export all templates to directory
atlcli wiki template export
# Creates: ./templates-export/

# Export to specific path
atlcli wiki template export -o ./my-templates

# Export single template to stdout (resolves by precedence if ambiguous)
atlcli wiki template export meeting-notes
# Outputs template content to stdout

# Export single template from specific level
atlcli wiki template export meeting-notes --level global
atlcli wiki template export standup --profile work

# Export single template to file
atlcli wiki template export meeting-notes -o ./meeting-notes.md

# Export from specific level only
atlcli wiki template export --level global
atlcli wiki template export --profile work
atlcli wiki template export --space TEAM

# Export specific templates (multiple → always directory)
atlcli wiki template export meeting-notes standup retro
# Creates: ./templates-export/ with only those templates

# Export specific templates to custom directory
atlcli wiki template export meeting-notes standup -o ./my-pack
```

**Output behavior**:
- No template names + no `-o` → `./templates-export/` directory
- Single template name + no `-o` → stdout
- Single template name + `-o file.md` → single file
- Single template name + `-o ./dir/` (trailing slash) → file in directory (`./dir/meeting-notes.md`)
- Multiple template names → always directory (default or `-o path`)
- `--level/--profile/--space` filters → always directory

**Space template export**: When exporting space templates, exports from BOTH locations (docs folder and config folder). Templates from docs folder take precedence if same name exists in both.

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
# Import from local directory (respects manifest structure)
atlcli wiki template import ./templates-export

# Import from git URL (shallow fetch)
atlcli wiki template import https://github.com/user/template-pack

# Import from direct URL
atlcli wiki template import https://example.com/templates.tar.gz

# Flatten all to specific level (ignores manifest structure)
atlcli wiki template import ./templates --to-level global
atlcli wiki template import ./templates --to-profile work
atlcli wiki template import ./templates --to-space TEAM

# Replace existing (default is merge/skip)
atlcli wiki template import ./templates --replace

# Import specific templates only (positional args after source)
atlcli wiki template import ./templates meeting-notes standup
```

**Import behavior**:
- By default, respects manifest structure (global→global, profiles→profiles, etc.)
- With `--to-level/--to-profile/--to-space`, flattens ALL templates to that single level
- If profile in manifest doesn't exist locally, creates the profile directory (templates only, not auth profile)
- Source URL is stored in template metadata for `update` command

### Update from Remote

```bash
# Update all templates that have a tracked source
atlcli wiki template update

# Update from specific source (updates templates originally from that source)
atlcli wiki template update --source https://github.com/user/template-pack

# Update specific templates (uses their tracked source)
atlcli wiki template update meeting-notes standup

# Force update from new source (re-tracks source)
atlcli wiki template update meeting-notes --source https://github.com/other/pack --force

# Update template at specific level (if same name exists at multiple levels)
atlcli wiki template update meeting-notes --level global
atlcli wiki template update standup --profile work
```

**Ambiguity handling**: Same as other commands - if a template name exists at multiple levels, prompts for level selection unless `--level`, `--profile`, or `--space` is specified. When updating without specifying names, all tracked templates across all levels are updated.

**Source tracking**: When templates are imported from a remote URL, the source is stored in template metadata:
```yaml
---
name: meeting-notes
_source: https://github.com/user/template-pack
_source_version: 1.0.0
---
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
│           ├── validation.ts      # Schema validation
│           └── importer.ts        # Import/export logic (Jira-ready)
└── confluence/
    └── src/
        └── templates/
            ├── index.ts           # Confluence-specific exports
            └── commands.ts        # CLI command handlers
```

> **Note**: Import/export logic is in `@atlcli/core` so it can be reused for Jira templates in the future.

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
  // Source tracking (set by import, used by update)
  _source?: string;         // URL template was imported from
  _source_version?: string; // Version at time of import
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

export interface TemplateFilter {
  level?: 'global' | 'profile' | 'space';
  profile?: string;
  space?: string;
  tags?: string[];
  search?: string;
  includeOverridden?: boolean;  // For --all flag: include shadowed templates
}

export interface TemplateSummary {
  name: string;
  description?: string;
  level: 'global' | 'profile' | 'space';
  profile?: string;
  space?: string;
  tags?: string[];
  overrides?: TemplateSource;  // If this shadows another template
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  line?: number;
  column?: number;
  message: string;
  type: 'syntax' | 'variable' | 'handlebars';
}

export interface ValidationWarning {
  line?: number;
  message: string;
  type: 'unused-variable' | 'undeclared-variable' | 'deprecated';
}
```

### Template Engine

The template engine wraps Handlebars and registers custom helpers:

**Custom Helpers:**
- `{{varName "default"}}` - Inline default syntax: outputs variable value or fallback if undefined
- `{{formatDate date "YYYY-MM-DD"}}` - Format date values
- `{{lowercase str}}` / `{{uppercase str}}` - String case helpers

> **Note**: The inline default syntax `{{attendees "TBD"}}` is NOT standard Handlebars. It's implemented as a custom helper that checks if the variable is defined and falls back to the provided default. Frontmatter `default:` takes precedence over inline defaults.

```typescript
// packages/core/src/templates/engine.ts

import Handlebars from 'handlebars';

export class TemplateEngine {
  private handlebars: typeof Handlebars;

  constructor() {
    this.handlebars = Handlebars.create();
    this.registerBuiltins();
    this.registerDefaultHelper();
  }

  private registerBuiltins(): void {
    // Register built-in @variables (@date, @user, etc.)
  }

  private registerDefaultHelper(): void {
    // Register helper for inline defaults: {{varName "fallback"}}
  }

  render(template: string, context: RenderContext): RenderResult {
    // Render template with context
  }

  validate(template: Template): ValidationResult {
    // Validate Handlebars syntax and variable declarations
    // Checks: syntax errors, undeclared variables used, declared variables unused
  }

  validateContent(content: string): ValidationResult {
    // Validate Handlebars syntax only (for --file validation before create)
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
  directory: ~/.config/atlcli/templates  # Base directory for templates
  date_format: "YYYY-MM-DD"              # Default date format for {{date}}
  editor: code                           # Override $EDITOR for template editing
```

**Directory precedence** (highest to lowest):
1. `ATLCLI_TEMPLATES_DIR` environment variable
2. `templates.directory` in config.yml
3. Default: `~/.config/atlcli/templates`

### Profile Config

```yaml
# ~/.config/atlcli/profiles/work.yml
templates:
  date_format: "DD.MM.YYYY"  # German date format for this profile
```

---

## Flag Pattern Reference

Standardized flag patterns across all template commands:

| Purpose | Flag | Example |
|---------|------|---------|
| Filter/target global | `--level global` | `list --level global` |
| Filter/target profile | `--profile <name>` | `create --profile work` |
| Filter/target space | `--space <key>` | `delete --space TEAM` |
| Current context | `--profile .`, `--space .` | `create --space .` |
| Copy/init source | `--from-level`, `--from-profile`, `--from-space` | `copy X --from-level global` |
| Copy/init target | `--to-level`, `--to-profile`, `--to-space` | `init X --to-profile work` |
| Output path | `-o, --output` | `export -o ./dir` |
| Template level (page create) | `--template-level` | `page create --template X --template-level global` |
| Include all (list) | `--all` | `list --all` (shows overridden) |
| Apply to all (validate) | `--all` | `validate --all` (validates all templates) |
| Force overwrite | `--force` | `create X --force`, `delete X --force` |
| Replace on import | `--replace` | `import ./dir --replace` |

> **Note on `--all` flag**: Context determines meaning. For `list`, it includes shadowed/overridden templates. For `validate`, it validates all templates instead of a specific one.

---

## Error Handling

| Error | Message |
|-------|---------|
| Template not found | `Template 'xyz' not found. Run 'wiki template list' to see available templates.` |
| Variable required | `Required variable 'title' not provided. Use --var title=VALUE or run interactively.` |
| Invalid variable type | `Variable 'count' expects a number, got 'abc'.` |
| Invalid select value | `Variable 'type' must be one of: standup, planning, retro. Got 'invalid'.` |
| Template exists | `Template 'meeting' already exists at global level. Use --force to overwrite.` |
| Invalid Handlebars | `Template syntax error at line 15: Unexpected closing tag.` |
| Import failed | `Failed to import from URL: 404 Not Found` |
| Ambiguous template | `Template 'meeting' exists at multiple levels: global, space:TEAM. Specify level with --level, --profile, or --space.` |
| No tracked source | `Template 'xyz' has no tracked source. Use --source URL to specify.` |

---

## Future Considerations

1. **Jira Templates**: Same engine can power `jira template` commands
2. **Template Marketplace**: Community template repository
3. **Template Versioning**: Track changes to templates over time
4. **Template Inheritance**: Allow extends/partials if needed later
5. **Template Hooks**: Pre/post-render hooks for customization
