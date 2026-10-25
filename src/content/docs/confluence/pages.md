---
title: "Pages"
description: "Pages - atlcli documentation"
---

# Pages

Create, read, update, delete, move, copy, and organize Confluence pages.

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
| `--space` | Space key (defaults to the profile's space) |
| `--cql` | CQL query to filter pages; takes precedence over `--space` |
| `--label` | Filter by label |
| `--limit` | Maximum results (default: 25) |

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
| `--json` | JSON output |

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

Duplicate a page with its attachments:

```bash
atlcli wiki page copy --id 12345 --title "Copy of Page"
```

The title and the body are [templates](/templating/) in Jinja syntax: `{{ sprint }}`
takes a value from `--var`, `{{ source.title }}` is the original's title,
`{{ today }}` today's date. Code blocks and code macros are copied as written.
Macro parameters render too, so a Jira macro with `project = {{ project }}`
points at the right project.

Options:

| Flag | Description |
|------|-------------|
| `--id` | Source page ID (required) |
| `--title` | Title for the copy, a template (default: `Copy of <title>`; with `--tree`: the root's own title) |
| `--space` | Target space (default: same space) |
| `--parent` | Parent page for the copy (default: the original's parent in the same space, the top level in another) |
| `--tree` | Copy the page and all its descendants, as a plan |
| `--no-attachments` | Leave the attachments out |
| `--var`, `--vars-file`, `--now`, `--strict` | Template values and checks; see [Templating](/templating/#variables) |
| `--apply`, `--yes`, `--plan-out`, `--print-script` | With `--tree`: as for [`atlcli script`](/reference/scripts/) |

### Copy a page tree

`--tree` copies the page and every descendant, parents first, siblings in
their order. Each title and body renders on its own; `{{ parent.title }}` is the
rendered title of the parent copy. Like [copy-issues](/jira/copy-issues/), the
result is a plan you review first:

```bash
atlcli wiki page copy --id 12345 --tree --title "Retro {{ sprint }}" --var sprint=42 --plan-out retro.json
atlcli script apply retro.json
```

- Titles must be unique in a space. A rendered title that is taken fails the
  plan before anything is written.
- Each copy carries the content property `atlcli.copiedFrom`. Planning again
  after a partial apply reuses the copies that exist and plans only the rest.
  Pass the plan's `--now` to get the same dates.

### Examples

```bash
# Copy to same space
atlcli wiki page copy --id 12345 --title "Page Copy"

# Copy to different space
atlcli wiki page copy --id 12345 --title "Page Copy" --space DOCS

# A meeting page from a template page, dated today
atlcli wiki page copy --id 12345 --title "Weekly {{ today }}" --parent 67890

# A handbook tree for this year's audit, failing on any unfilled variable
atlcli wiki page copy --id 12345 --tree --title "Audit {{ year }}" --vars-file audit-2026.yml --strict --apply
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
| `--json` | JSON output |

Output:

```
Child pages (3):
  12346  Getting Started
  12347  API Reference
  12348  Troubleshooting
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

### Turn Task Items into Jira Issues

`tasks-to-issues` reads the task items (`- [ ]` checkboxes) on a page, for example action items in meeting notes, and creates one Jira issue per open task. Without `--confirm` it only shows the plan.

```bash
# Preview
atlcli wiki page tasks-to-issues --id 12345 --project PROJ

# Create the issues
atlcli wiki page tasks-to-issues --id 12345 --project PROJ --label meeting --confirm
```

For each created issue atlcli:

- uses the task text as the summary and the task (as markdown) plus a link back to the page as the description,
- assigns the first person mentioned in the task (`@Name`) and sets the first date in the task as the due date,
- adds a Jira remote link to the page (skip with `--no-link`),
- puts a smart link to the new issue at the start of the task on the page (skip with `--no-mark`).

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--id` | page ID | required | Page with the tasks |
| `--project` | project key | required unless `--sync` alone | Project for new issues |
| `--type` | issue type | `Task` | Issue type for new issues |
| `--label` | string, repeatable | none | Labels for new issues |
| `--parent` | issue key | none | Parent (epic) for new issues |
| `--include-done` | flag | off | Also create issues for ticked tasks |
| `--no-link` | flag | off | Do not add a remote link on the issue |
| `--no-mark` | flag | off | Do not add the issue link to the task |
| `--sync` | flag | off | Tick tasks whose issues are done (see below) |
| `--confirm` | flag | off | Apply the plan; without it nothing is written |

#### Running it again

Running the command again creates nothing twice. A task that already links to an issue (the smart link atlcli added, or any link to `/browse/KEY` or a Jira macro you added yourself) is skipped. On Confluence Cloud atlcli also records each new issue in the page property `atlcli.tasks-to-issues` right after creating it, so a run that stops before updating the page still does not create the issue again. The issue links survive `atlcli wiki docs pull` and `push`.

#### Keep task status in sync

```bash
atlcli wiki page tasks-to-issues --id 12345 --sync --confirm
```

`--sync` follows Jira:

| Situation | Result |
|-----------|--------|
| Task open, all linked issues done | Task is ticked |
| Task ticked by `--sync`, an issue was reopened | Task is unticked |
| Task ticked by hand, issue still open | Reported as `report:ticked-but-open`; nothing changes, the issue is not transitioned |
| Linked issue missing or not visible | Reported as `report:missing` |

Combine `--project` and `--sync` to create issues for new tasks and update the status of the others in one run, for example from a scheduled job.

#### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Task shows `skip:empty` | The task holds only a mention or date | Add text to the task |
| Assignee not set | Jira Data Center, or the mentioned user cannot be assigned in the project | Assign in Jira |
| Warning about the ledger on Data Center | Page properties are written through the Cloud API | Nothing to do; the task links still prevent duplicates |
| Task was ticked by hand and stays ticked though its issue reopened | `--sync` only unticks what it ticked itself | Untick it by hand |

See the recipe [Meeting Notes to Jira](../recipes/meeting-notes-to-jira.md) for a full workflow.

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
