# Confluence Feature Roadmap

## Overview

Future enhancements for atlcli Confluence functionality.

---

## 1. Partial Sync (Priority: High)

**Status**: COMPLETE ✅

Granular control over which pages to sync - single pages, page trees, or full spaces.

See: [partial-sync.md](./partial-sync.md)

---

## 2. Attachments Support

**Status**: COMPLETE ✅

Sync images and file attachments with pages.

**Implemented Features:**
- Download attachments to `{page}.attachments/` alongside markdown
- Upload local images and files referenced in markdown
- Image embedding: `![alt](./page.attachments/image.png)` syntax
- Image sizing: `![alt](./page.attachments/img.png){width=600}` syntax
- File attachments: `[Report](./page.attachments/report.pdf)` for PDFs, Excel, etc.
- Automatic conversion between markdown and Confluence `ac:image`/`ac:link` macros
- Attachment versioning and state tracking
- Use `--no-attachments` flag to skip attachment sync

---

## 3. Page Templates

**Status**: COMPLETE ✅

Create pages from predefined templates with a powerful variable system.

**Implemented Features:**
- `atlcli template list [--source local|global|all]` - List available templates
- `atlcli template get --name <name>` - View template details
- `atlcli template create --name <name> [--from-file <file>]` - Create new template
- `atlcli template validate --name <name>` - Validate template syntax
- `atlcli template preview --name <name> [--var key=value]` - Preview rendered template
- `atlcli template delete --name <name> --confirm` - Delete a template
- `atlcli page create --template <name> --title <title> [--var key=value]` - Create page from template
- `atlcli docs add <file> --template <name>` - Add file with template

**Template Syntax:**
- Handlebars-style variables: `{{variable}}`, `{{user.name}}`
- Modifier chains: `{{name | upper | trim}}`, `{{date | date:'MMMM D, YYYY'}}`
- Conditionals: `{{#if condition}}...{{else}}...{{/if}}`, `{{#unless hidden}}...{{/if}}`
- Loops: `{{#each items}}{{this}}{{/each}}` with `@index`, `@first`, `@last`, etc.

**17 Built-in Variables:**
- Date/time: `{{NOW}}`, `{{TODAY}}`, `{{YEAR}}`, `{{MONTH}}`, `{{DAY}}`, `{{TIME}}`, `{{WEEKDAY}}`
- User: `{{USER.displayName}}`, `{{USER.email}}`, `{{USER.accountId}}`
- Context: `{{SPACE.key}}`, `{{SPACE.name}}`, `{{PARENT.id}}`, `{{PARENT.title}}`, `{{TITLE}}`
- Utility: `{{UUID}}`, `{{RANDOM:N}}`, `{{ENV.VAR_NAME}}`

**50+ Modifiers:**
- Date: `date`, `relative`, `add`, `subtract`, `startOf`, `endOf`
- String: `upper`, `lower`, `capitalize`, `titleCase`, `slug`, `camelCase`, `truncate`, `trim`, `pad`, `replace`, `escape`, `urlEncode`
- Number: `number`, `currency`, `percent`, `round`, `floor`, `ceil`, `abs`, `ordinal`, `bytes`
- Array: `join`, `first`, `last`, `sort`, `sortBy`, `unique`, `compact`, `slice`, `pluck`, `where`
- Conditional: `or`, `and`, `not`, `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between`, `in`, `empty`, `present`

**Template Storage:**
- Local templates: `.atlcli/templates/` in project
- Global templates: `~/.config/atlcli/templates/`
- YAML frontmatter for metadata with variable definitions

**Example Template:**
```markdown
---
template:
  name: meeting-notes
  description: Weekly meeting notes template
  variables:
    - name: meeting_date
      prompt: "Meeting date"
      type: date
      default: "{{TODAY}}"
    - name: attendees
      prompt: "Attendees"
      type: list
      required: true
  target:
    labels: ["meeting-notes"]
---
# {{TITLE}}

**Date:** {{meeting_date | date:'MMMM D, YYYY'}}
**Attendees:**
{{#each attendees}}
- {{this}}
{{/each}}

## Notes

*Created by {{USER.displayName}} on {{NOW | date:'YYYY-MM-DD HH:mm'}}*
```

---

## 4. Comments Sync

**Status**: COMPLETE ✅

Full comments support - pull and create/manage comments from CLI.

**Implemented Features:**
- `atlcli docs pull --comments` - Pull comments to `.comments.json` files
- `atlcli page comments --id <id>` - List comments for a page
- `atlcli page comments add --id <id> <text>` - Add a footer comment
- `atlcli page comments reply --id <id> --parent <cid> <text>` - Reply to a comment (threaded)
- `atlcli page comments add-inline --id <id> --selection <text>` - Add inline comment on text
- `atlcli page comments resolve --comment <id>` - Mark comment as resolved
- `atlcli page comments delete --comment <id> --confirm` - Delete a comment
- Footer (page-level) comments with reply threads
- Inline comments with text selection info
- Comment text supports full markdown (converted to Confluence storage format)
- JSON output with `--json` flag
- Uses Confluence API v2 for comments

**Storage format:**
```json
{
  "pageId": "12345",
  "lastSynced": "2026-01-11T...",
  "footerComments": [...],
  "inlineComments": [...]
}
```

**Known Confluence API v2 Limitations:**
- Inline comments: `textSelection` not returned on GET requests, only on create. Comments display correctly in Confluence UI but CLI cannot show which text was selected.
  See: [API doesn't provide enough data to recreate inline comments](https://community.developer.atlassian.com/t/inline-comment-on-both-v-1-and-v-2-doesnt-provide-enough-data-to-recreate-the-inline-comment-using-post/68653)
- Footer comments: PUT updates require body and version fields; resolution status changes may not reflect immediately.
  See: [Update footer comment not working](https://community.developer.atlassian.com/t/update-footer-comment-confluence-api-v2-not-working/68485)

---

## 5. Page History & Diff

**Status**: COMPLETE ✅

View and restore page versions.

**Implemented Features:**
- `atlcli page history --id <id> [--limit <n>]` - View version history
- `atlcli page diff --id <id> [--version <n>]` - Compare versions with colored diff
- `atlcli page restore --id <id> --version <n> --confirm` - Restore to previous version
- `atlcli docs diff <file>` - Compare local file vs remote Confluence page
- JSON output support with `--json` flag
- Unified diff format with line addition/deletion counts

---

## 6. Labels / Tags

**Status**: COMPLETE ✅

Filter sync by labels, manage labels.

**Implemented Features:**
- `atlcli page label add <label>... --id <id>` - Add labels to a page
- `atlcli page label remove <label> --id <id>` - Remove a label from a page
- `atlcli page label list --id <id>` - List labels on a page
- `atlcli page list --label <label> [--space <key>]` - List pages with label
- `atlcli docs pull --label <label>` - Pull only pages with label
- `atlcli docs sync --label <label>` - Sync only pages with label

---

## 7. Search

**Status**: COMPLETE ✅

Full-text search across Confluence with CQL support.

**Implemented Features:**
- `atlcli search <query>` - Text search in page content
- `atlcli search --space <key>` - Filter by space (comma-separated for multiple)
- `atlcli search --label <name>` - Filter by label (comma-separated for multiple)
- `atlcli search --title <text>` - Filter by title containing text
- `atlcli search --creator <user>` - Filter by creator (use "me" for current user)
- `atlcli search --type <type>` - Content type: page, blogpost, comment, all
- `atlcli search --ancestor <pageId>` - Pages under a specific parent
- `atlcli search --modified-since <date>` - Modified after date (7d, 30d, today, thisWeek, YYYY-MM-DD)
- `atlcli search --created-since <date>` - Created after date
- `atlcli search --cql <query>` - Raw CQL query for advanced searches
- Output formats: table (default), compact, json
- Pagination with `--limit` and `--start`
- `--verbose` to show the generated CQL query

**Examples:**
```bash
atlcli search "API documentation"
atlcli search --space DEV,DOCS --modified-since 7d
atlcli search --label architecture --label api
atlcli search --creator me --created-since thisMonth
atlcli search --cql "type=page AND space=DEV AND lastModified >= startOfWeek()"
```

---

## 8. Page Tree Management

**Status**: COMPLETE ✅

Move, copy, reorder, and list child pages.

**Implemented Features:**
- `atlcli page move --id <id> --parent <parent-id>` - Move page to new parent
- `atlcli page move <file> --before <target>` - Move page before sibling
- `atlcli page move <file> --after <target>` - Move page after sibling
- `atlcli page move <file> --first` - Move page to first position
- `atlcli page move <file> --last` - Move page to last position
- `atlcli page move <file> --position <n>` - Move page to position (1-indexed)
- `atlcli page sort <file> --alphabetical` - Sort children A-Z
- `atlcli page sort <file> --natural` - Sort children (numeric-aware, e.g., Chapter 1, 2, 10)
- `atlcli page sort <file> --by <created|modified>` - Sort by date
- `atlcli page sort --reverse` - Reverse sort order
- `atlcli page sort --dry-run` - Preview sort without applying
- `atlcli page copy --id <id> [--space <key>] [--title <t>] [--parent <p>]` - Copy/duplicate page
- `atlcli page children --id <id> [--limit <n>]` - List direct child pages

See: [sibling-reorder.md](./sibling-reorder.md) for full specification.

---

## 9. Additional Macros

**Status:** COMPLETE

Expand markdown-to-storage conversion.

**Implemented:**
- `code` - Code block with syntax highlighting ✅
- `status` - Status lozenges (`{status:green}Done{status}`) ✅
- `jira` - Jira issue embed (`{jira:PROJ-123}`) ✅
- `children` - Child pages list (`:::children`) ✅
- `recently-updated` - Recent changes (`:::recently-updated`) ✅
- `include` - Content transclusion (`:::include page="id"`) ✅
- `panel` - Generic panel with colors ✅
- `excerpt` / `excerpt-include` - Content excerpts ✅
- `anchor` - Page anchors (`{#anchor-name}`) ✅
- `section` / `column` - Multi-column layouts ✅
- `pagetree` - Page tree navigation ✅
- `content-by-label` - Filter by labels ✅
- `gallery` - Image gallery ✅
- `attachments` - Attachment list ✅
- `multimedia` / `widget` - Media embeds ✅

---

## 10. Diagrams

Convert text-based diagrams to Confluence.

```markdown
​```mermaid
graph TD
    A --> B
​```
```

**Options:**
- Convert to Confluence draw.io macro
- Render as image and upload as attachment
- Use Confluence native diagram macros

---

## 11. Export Formats

Export pages to various formats.

```bash
atlcli page export <id> --format pdf -o page.pdf
atlcli page export <id> --format docx
atlcli page export <id> --format html
atlcli space export <key> --format pdf  # entire space
```

---

## 12. Ignore Patterns

**Status**: COMPLETE ✅

`.atlcliignore` file to exclude files from sync.

**Implemented Features:**
- Create `.atlcliignore` with gitignore-style patterns
- Patterns from `.gitignore` are automatically merged (lower precedence)
- `.atlcliignore` patterns can negate `.gitignore` with `!pattern`
- Applied to: `docs push`, `docs status`, `docs sync`, file watchers
- Default ignores: `.atlcli/`, `.git/`, `node_modules/`, `*.meta.json`, `*.base`

**Example .atlcliignore:**
```gitignore
# Drafts not ready for Confluence
drafts/
*.draft.md

# Internal documentation
internal-*.md
private/

# Keep this despite matching internal-*
!internal-api-docs.md
```

---

## 13. Link Checker & Pre-push Validation

**Status**: COMPLETE ✅

Find broken internal links and validate content before pushing.

**Implemented Features:**
- `atlcli docs check [path]` - Validate markdown files for issues
- `atlcli docs check --strict` - Treat warnings as errors
- `atlcli docs check --json` - JSON output for CI/agents
- `atlcli docs push --validate` - Run validation before push
- `atlcli docs push --validate --strict` - Fail push on warnings

**Validation Checks:**
| Code | Severity | Description |
|------|----------|-------------|
| `LINK_FILE_NOT_FOUND` | Error | Target file `./page.md` does not exist |
| `LINK_UNTRACKED_PAGE` | Warning | Target exists locally but not synced |
| `MACRO_UNCLOSED` | Error | `:::info` without closing `:::` |
| `PAGE_SIZE_EXCEEDED` | Warning | Content exceeds 500KB |

**Examples:**
```bash
# Check all files in directory
atlcli docs check ./docs

# Check with strict mode (warnings = errors)
atlcli docs check --strict

# JSON output for CI/agents
atlcli docs check --json

# Validate before pushing
atlcli docs push --validate

# Strict validation before push
atlcli docs push --validate --strict
```

---

## 14. Bulk Operations

**Status**: COMPLETE ✅

Batch operations on pages using CQL queries.

**Implemented Features:**
- `atlcli page delete --id <id> --confirm` - Delete a single page
- `atlcli page delete --cql <query> --confirm` - Delete pages matching CQL
- `atlcli page archive --id <id> --confirm` - Archive a single page
- `atlcli page archive --cql <query> --confirm` - Archive pages matching CQL
- `atlcli page label add --cql <query> <label> --confirm` - Add labels to pages matching CQL
- `atlcli page label remove --cql <query> <label> --confirm` - Remove label from pages matching CQL
- `--dry-run` flag to preview affected pages without executing
- Progress indicator during bulk operations
- Error collection with partial success support

**Examples:**
```bash
# Preview what would be deleted
atlcli page delete --cql "label=to-delete" --dry-run

# Delete pages matching CQL
atlcli page delete --cql "label=to-delete" --confirm

# Archive old pages
atlcli page archive --cql "lastModified < now('-1y')" --confirm

# Bulk add labels
atlcli page label add archived --cql "space=OLD" --confirm

# Bulk remove labels
atlcli page label remove draft --cql "space=DEV" --confirm
```

---

## Priority Order

1. ~~**Partial Sync** - Core functionality, day-0 requirement~~ ✅ COMPLETE
2. ~~**Attachments** - Essential for real-world docs~~ ✅ COMPLETE
3. ~~**Labels** - Common organizational need~~ ✅ COMPLETE
4. ~~**Page History & Diff** - Safety and review~~ ✅ COMPLETE
5. ~~**Ignore Patterns** - Quality of life~~ ✅ COMPLETE
6. ~~**Additional Macros** - Expanded compatibility~~ ✅ COMPLETE
7. ~~**Search** - Discovery~~ ✅ COMPLETE
8. ~~**Comments** - Collaboration~~ ✅ COMPLETE
9. ~~**Page Tree Management** - Move, copy, children~~ ✅ COMPLETE
10. ~~**Bulk Operations** - Delete, archive, label via CQL~~ ✅ COMPLETE
11. ~~**Link Checker & Pre-push Validation** - Content validation~~ ✅ COMPLETE
12. ~~**Page Templates** - Handlebars-style templates with variables~~ ✅ COMPLETE
13. **Others** - As needed
