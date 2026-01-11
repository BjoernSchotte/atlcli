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

Create pages from predefined templates.

```bash
atlcli page create --template meeting-notes --title "2024-01-15 Standup"
atlcli template list
atlcli template get <name>
```

**Features:**
- Built-in templates (meeting notes, decision log, runbook)
- Custom templates from local files or Confluence blueprints
- Variable substitution (`{{date}}`, `{{author}}`)

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

**Status**: COMPLETE ✅ (move, copy, children)

Move, copy, and list child pages.

**Implemented Features:**
- `atlcli page move --id <id> --parent <parent-id>` - Move page to new parent
- `atlcli page copy --id <id> [--space <key>] [--title <t>] [--parent <p>]` - Copy/duplicate page
- `atlcli page children --id <id> [--limit <n>]` - List direct child pages

**Planned:**
- Sibling reordering (requires design - Confluence API doesn't support it natively)

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

## 13. Link Checker

Find broken internal links.

```bash
atlcli docs check ./docs
# Output:
# page-a.md:15 - broken link to "Missing Page"
# page-b.md:42 - link to deleted page (id: 12345)
```

---

## 14. Bulk Operations

Batch operations on pages.

```bash
atlcli page archive --cql "lastModified < now('-1y')"
atlcli page label add --cql "space=OLD" archived
atlcli page delete --cql "label=to-delete" --confirm
```

---

## 15. Pre-push Validation

Hooks to validate content before pushing.

```bash
atlcli docs push --validate
# Checks:
# - Broken internal links
# - Invalid macro syntax
# - Required frontmatter fields
# - Maximum page size
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
10. **Others** - As needed
