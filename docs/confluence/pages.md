# Pages

Create, read, update, delete, move, copy, and organize Confluence pages.

::: toc

## Prerequisites

- Authenticated profile with Confluence access (`atlcli auth login`)
- **Space permission**: View for read operations, Edit for create/update/delete

## List Pages

List pages in a space:

```bash
atlcli wiki page list --space TEAM
```

Output:

```
ID        TITLE                    MODIFIED              AUTHOR
12345     Getting Started          2025-01-14 10:30      alice@company
12346     API Reference            2025-01-13 15:45      bob@company
12347     Configuration Guide      2025-01-12 09:00      alice@company
```

Options:

| Flag | Description |
|------|-------------|
| `--space` | Space key |
| `--cql` | CQL query to filter pages |
| `--label` | Filter by label |
| `--limit` | Maximum results |

## Get Page

View a specific page:

```bash
atlcli wiki page get --id 12345
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Page ID (required) |
| `--version` | Get specific version |
| `--expand` | Include: `body`, `version`, `ancestors` |
| `--format` | Output format: `markdown`, `html`, `json` |

## Create Page

Create a new page from a markdown file:

```bash
atlcli wiki page create --space TEAM --title "New Page" --body ./content.md
```

Options:

| Flag | Description |
|------|-------------|
| `--space` | Space key (required) |
| `--title` | Page title (required) |
| `--body` | Markdown file with page content (required) |

### Examples

```bash
# Create page from file
atlcli wiki page create --space TEAM --title "API Guide" --body ./api-guide.md

# Create under parent
atlcli wiki page create --space TEAM --title "Child Page" --body ./child.md --parent 12345
```

## Update Page

Update an existing page from a markdown file:

```bash
atlcli wiki page update --id 12345 --body ./updated-content.md
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Page ID (required) |
| `--body` | Markdown file with new content (required) |
| `--title` | Change title |

### Examples

```bash
# Update content from file
atlcli wiki page update --id 12345 --body ./updated-guide.md

# Change title too
atlcli wiki page update --id 12345 --body ./guide.md --title "New Title"
```

## Delete Page

Delete a single page:

```bash
atlcli wiki page delete --id 12345 --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Page ID |
| `--confirm` | Skip confirmation prompt |

### Bulk Delete

Delete multiple pages matching a CQL query:

```bash
atlcli wiki page delete --cql "space = TEAM AND label = deprecated" --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--cql` | CQL query to match pages |
| `--dry-run` | Preview without deleting |
| `--confirm` | Skip confirmation |

```bash
# Preview what would be deleted
atlcli wiki page delete --cql "space = ARCHIVE AND lastModified < now('-365d')" --dry-run

# Delete old archived pages
atlcli wiki page delete --cql "space = ARCHIVE AND lastModified < now('-365d')" --confirm
```

## Archive Page

Move pages to archive instead of deleting:

```bash
# Archive single page
atlcli wiki page archive --id 12345 --confirm

# Bulk archive via CQL
atlcli wiki page archive --cql "space = TEAM AND label = deprecated" --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Page ID |
| `--cql` | CQL query for bulk archive |
| `--dry-run` | Preview without archiving |
| `--confirm` | Skip confirmation |

## Copy Page

Duplicate a page:

```bash
atlcli wiki page copy --id 12345 --title "Copy of Page"
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Source page ID (required) |
| `--title` | Title for the copy |
| `--space` | Target space (default: same space) |
| `--parent` | Parent page for the copy |

### Examples

```bash
# Copy to same space
atlcli wiki page copy --id 12345 --title "Page Copy"

# Copy to different space
atlcli wiki page copy --id 12345 --title "Page Copy" --space DOCS
```

## List Children

Get child pages of a parent:

```bash
atlcli wiki page children --id 12345
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Parent page ID (required) |
| `--limit` | Maximum results |
| `--depth` | Include grandchildren (default: 1) |
| `--format` | Output format: `table`, `json`, `tree` |

### Tree View

```bash
atlcli wiki page children --id 12345 --depth 3 --format tree
```

```
├── Getting Started (12346)
│   ├── Installation (12350)
│   └── Configuration (12351)
├── API Reference (12347)
│   ├── Authentication (12352)
│   └── Endpoints (12353)
└── Troubleshooting (12348)
```

## Move Page

Move a page to a new location:

```bash
# Move under different parent
atlcli wiki page move --id 12345 --parent 67890
```

### Position Options

Control exact position among siblings using file paths or page IDs:

```bash
# Move before specific sibling
atlcli wiki page move ./docs/page.md --before ./docs/intro.md

# Move after specific sibling
atlcli wiki page move ./docs/page.md --after ./docs/setup.md

# Move to first position
atlcli wiki page move ./docs/appendix.md --first

# Move to last position
atlcli wiki page move ./docs/appendix.md --last

# Move to specific position (1-indexed)
atlcli wiki page move --id 12345 --position 3
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Page ID to move |
| `--parent` | New parent page ID |
| `--before` | Position before this page |
| `--after` | Position after this page |
| `--first` | Move to first child position |
| `--last` | Move to last child position |
| `--position` | Specific position index (1-based) |

## Sort Children

Reorder child pages:

```bash
# Alphabetical sort (using file path)
atlcli wiki page sort ./docs/api.md --alphabetical

# Natural sort (handles numbers correctly)
atlcli wiki page sort ./docs/chapters.md --natural

# Sort by creation date
atlcli wiki page sort ./docs/changelog.md --by created

# Sort by last modified, reversed
atlcli wiki page sort ./docs/changelog.md --by modified --reverse

# Sort using page ID
atlcli wiki page sort --id 12345 --alphabetical --dry-run
```

Options:

| Flag | Description |
|------|-------------|
| `--alphabetical` | Sort A-Z by title |
| `--natural` | Natural sort ("Chapter 2" before "Chapter 10") |
| `--by` | Sort by: `created`, `modified` |
| `--reverse` | Reverse sort order |
| `--dry-run` | Preview without applying |

### Natural Sort Example

```
Before (alphabetical):     After (natural):
Chapter 1                  Chapter 1
Chapter 10                 Chapter 2
Chapter 2                  Chapter 10
Chapter 3                  Chapter 3
```

## Cross-Product Linking

Link Confluence pages to Jira issues for bidirectional traceability.

### Link Issue to Page

```bash
atlcli wiki page link-issue --id 12345 --issue PROJ-123
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Page ID (required) |
| `--issue` | Jira issue key (required) |
| `--comment` | Add comment to the linked issue |

### List Linked Issues

```bash
atlcli wiki page issues --id 12345
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Page ID (required) |
| `--project` | Filter by Jira project |

### Unlink Issue

```bash
atlcli wiki page unlink-issue --id 12345 --issue PROJ-123
```

### Examples

```bash
# Link a Jira issue to a page
atlcli wiki page link-issue --id 12345 --issue PROJ-123

# Link with comment on the issue
atlcli wiki page link-issue --id 12345 --issue PROJ-456 --comment

# List all Jira issues linked to a page
atlcli wiki page issues --id 12345

# Filter by project
atlcli wiki page issues --id 12345 --project PROJ

# Remove link
atlcli wiki page unlink-issue --id 12345 --issue PROJ-123
```

## JSON Output

All commands support `--json`:

```bash
atlcli wiki page list --space TEAM --json
```

```json
{
  "schemaVersion": "1",
  "pages": [
    {
      "id": "12345",
      "title": "Getting Started",
      "space": {"key": "TEAM", "name": "Team Docs"},
      "url": "https://company.atlassian.net/wiki/spaces/TEAM/pages/12345",
      "version": 5,
      "lastModified": "2025-01-14T10:30:00Z",
      "author": {
        "displayName": "Alice",
        "email": "alice@company.com"
      }
    }
  ],
  "total": 24
}
```

## Use Cases

### Reorganize Documentation

```bash
# Move all API docs under new parent
for id in $(atlcli wiki page list --space TEAM --json | jq -r '.pages[] | select(.title | startswith("API")) | .id'); do
  atlcli wiki page move --id $id --parent 99999
done
```

### Bulk Cleanup

```bash
# Archive pages not modified in 6 months
atlcli wiki page archive --cql "space = TEAM AND lastModified < now('-180d')" --dry-run

# If looks good, execute
atlcli wiki page archive --cql "space = TEAM AND lastModified < now('-180d')" --confirm
```

### Clone Documentation Structure

```bash
# Copy page to new space
atlcli wiki page copy --id 12345 --title "API Docs" --space NEW_SPACE
```

### Standardize Page Order

```bash
# Sort all sections alphabetically
for parent in 12345 12346 12347; do
  atlcli wiki page sort --id $parent --natural --dry-run
done
```

## Troubleshooting

### Page Not Found

**Symptom**: `Error: Page 12345 not found`

**Causes**:
- Page was deleted or moved to trash
- Page ID is incorrect
- You don't have View permission for the page

**Fix**: Verify the page exists in Confluence and you have access.

### Cannot Delete Page

**Symptom**: `Error: Cannot delete page with children`

**Cause**: The page has child pages that must be deleted first.

**Fix**: Delete child pages first, then delete the parent:
```bash
# List children
atlcli wiki page children --id 12345

# Delete children first, then parent
atlcli wiki page delete --id <child-id> --confirm
atlcli wiki page delete --id 12345 --confirm
```

## Related Topics

- [Sync](sync.md) - Bidirectional sync between local files and Confluence
- [Folders](folders.md) - Organize pages with folders (Cloud only)
- [Labels](labels.md) - Tag and filter pages with labels
- [History](history.md) - View and restore page versions
- [Attachments](attachments.md) - Manage page attachments
