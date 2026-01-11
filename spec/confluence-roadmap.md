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

Pull/push page comments.

**Options:**
- As markdown footnotes in the page file
- As separate `page.comments.md` file
- As JSON metadata

**Features:**
- Inline comments (highlight-based)
- Page-level comments
- Reply threads

---

## 5. Page History & Diff

View and restore page versions.

```bash
atlcli page history <id> [--limit 10]
atlcli page diff <id> [--version 5]
atlcli page restore <id> --version 5
atlcli docs diff ./page.md  # local vs remote
```

---

## 6. Labels / Tags

Filter sync by labels, manage labels.

```bash
atlcli docs pull --label architecture
atlcli page label add <id> my-label
atlcli page label remove <id> old-label
atlcli page list --label api-docs
```

---

## 7. Search

Full-text search across Confluence.

```bash
atlcli search "API documentation" [--space KEY]
atlcli search --cql "label=architecture and lastModified > now('-7d')"
```

---

## 8. Page Tree Management

Move, copy, reorder pages.

```bash
atlcli page move <id> --parent <parent-id>
atlcli page copy <id> --space TARGET [--title "Copy of..."]
atlcli page reorder <id> --after <sibling-id>
```

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

`.atlcliignore` file to exclude files from sync.

```
# .atlcliignore
drafts/
*.draft.md
internal-*.md
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
3. **Labels** - Common organizational need
4. **Page History & Diff** - Safety and review
5. **Ignore Patterns** - Quality of life
6. ~~**Additional Macros** - Expanded compatibility~~ ✅ COMPLETE
7. **Search** - Discovery
8. **Comments** - Collaboration
9. **Others** - As needed
