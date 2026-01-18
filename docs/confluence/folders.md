# Folders

Confluence Cloud introduced folders in September 2024 as a way to organize content without creating additional pages. atlcli supports syncing folders bidirectionally with your local filesystem.

## How Folders Work

Folders in Confluence are organizational containers that can hold pages, other folders, whiteboards, and databases. Unlike pages, folders have no content body - they exist purely for organization.

### Local File Structure

atlcli represents folders using the **index pattern**:

```
docs/
├── my-folder/                    # Confluence folder
│   ├── index.md                  # Folder metadata (type: folder)
│   ├── page-in-folder.md         # Page inside folder
│   └── nested-folder/            # Nested folder
│       ├── index.md              # Nested folder metadata
│       └── another-page.md
```

### Folder Frontmatter

Folder `index.md` files contain frontmatter with `type: folder`:

```yaml
---
atlcli:
  id: "123456789"
  title: "My Folder"
  type: "folder"
---
```

The file has no content body - only frontmatter.

## Pulling Folders

When you pull a space containing folders, atlcli:

1. Detects folders by analyzing the page hierarchy
2. Creates directory structure matching the Confluence hierarchy
3. Creates `index.md` files with folder frontmatter
4. Places child pages inside the folder directories

```bash
# Pull a space with folders
atlcli wiki docs pull ~/docs
```

### Folder Renames (Pull)

If a folder is renamed in Confluence, pull detects this and moves the entire local directory:

```
Renamed folder: old-name → new-name
```

All child pages are moved automatically with the directory.

## Pushing Folders

!!! warning "API Limitation: Folder Rename Not Supported"

    **The Confluence Cloud API does not support renaming folders.** The v2 Folder API only provides Create, Get, and Delete operations - there is no Update endpoint.

    This is a known gap tracked by Atlassian:

    - [CONFCLOUD-80566: Support missing V2 REST API for folders](https://jira.atlassian.com/browse/CONFCLOUD-80566)
    - [RFC-52: Folders as a New Confluence Content Type](https://community.developer.atlassian.com/t/rfc-52-folders-as-a-new-confluence-content-type/80001)
    - [Community discussion on folder API limitations](https://community.atlassian.com/forums/Confluence-questions/Question-about-Confluence-API-to-retrieve-folder-title/qaq-p/2945631)

    **Workaround:** Rename folders in the Confluence UI, then pull to sync locally.

When you attempt to rename a folder locally and push, atlcli will show:

```
Warning: Folder rename not supported by Confluence API.
Rename "Old Name" in Confluence UI, then pull.
```

### What Works

- **Creating pages in folders**: Push new pages inside folder directories
- **Updating pages in folders**: Content changes sync normally
- **Folder structure**: The hierarchy is preserved

### What Doesn't Work

- **Renaming folders via push**: Must be done in Confluence UI
- **Creating new folders via push**: Not yet implemented
- **Moving folders via push**: Not yet implemented

## Recommended Workflow

For the best experience with folders:

1. **Create and rename folders in Confluence UI** - The web interface fully supports folder operations
2. **Pull to sync folder structure locally** - Folder renames are detected and directories move automatically
3. **Create and edit pages locally** - Push page changes as normal
4. **Use pull regularly** - Keep your local structure in sync with Confluence

## Technical Details

### API Endpoints Used

| Operation | API | Endpoint |
|-----------|-----|----------|
| Get folder | v2 | `GET /wiki/api/v2/folders/{id}` |
| List folder children | v2 | `GET /wiki/api/v2/folders/{id}/direct-children` |
| Move page to folder | v1 | `PUT /wiki/rest/api/content/{id}/move/append/{folderId}` |

### Folder Detection

Since the v2 API's `getSpaceFolders` endpoint is unreliable, atlcli detects folders by:

1. Fetching all pages in the space
2. Identifying parent IDs that aren't in the page set
3. Fetching those IDs as potential folders via the folder API

This ensures folders are discovered even when nested or when API endpoints behave unexpectedly.

## Sync Mode

Folders are fully supported in watch mode (`docs sync`):

```bash
atlcli wiki docs sync ./docs --space TEAM
```

### How Sync Handles Folders

| Event | Detection | Action |
|-------|-----------|--------|
| Folder created remotely | Polling detects new folder ID | Creates directory + index.md |
| Folder renamed remotely | Polling detects title change | Moves entire directory |
| Page moved into folder | Polling detects parent change | Moves local file to folder directory |
| Page moved out of folder | Polling detects parent change | Moves local file to new location |

### Example Sync Output

```
[poll] Detected folder rename: "Old Name" → "New Name"
[sync] Moving directory: old-name/ → new-name/
[sync] Moved 5 files with directory
```

## Diffing Folders

Compare a folder's local metadata with Confluence:

```bash
atlcli wiki docs diff ./docs/my-folder/index.md
```

Since folders have no content body, diff only compares the **title**:

```
Folder: "My Folder"
  No changes (folder has no content to diff)
```

If the title differs:

```
Folder: "My Folder"
  Title mismatch:
    Local:  "My Folder"
    Remote: "My Renamed Folder"
```

### JSON Output

```bash
atlcli wiki docs diff ./docs/my-folder/index.md --json
```

```json
{
  "schemaVersion": "1",
  "file": "./docs/my-folder/index.md",
  "pageId": "123456789",
  "title": "My Folder",
  "type": "folder",
  "hasChanges": false,
  "localTitle": "My Folder",
  "remoteTitle": "My Folder"
}
```

## Validating Folders

The `docs check` command validates folder structure:

```bash
atlcli wiki docs check ./docs
```

### Folder Validation Codes

| Code | Severity | Description |
|------|----------|-------------|
| `FOLDER_EMPTY` | Warning | Folder index.md exists but has no child pages or subfolders |
| `FOLDER_MISSING_INDEX` | Warning | Directory contains .md files but has no index.md (not a synced folder) |

### Example Output

```
Validating 24 files...

WARNINGS (2):
  empty-folder/index.md:1 - Folder "Empty Folder" has no children [FOLDER_EMPTY]
  orphan-dir - Directory "orphan-dir" contains pages but has no folder index.md [FOLDER_MISSING_INDEX]

Validation complete: 0 errors, 2 warnings
```

### Audit Integration

Folder validation is also available in the audit command:

```bash
atlcli audit wiki --folders
```

This adds folder structure issues to the audit report alongside stale pages, orphans, and broken links.

## See Also

- [Sync Documentation](sync.md) - Full sync workflow details
- [Validation](validation.md) - All validation rules
- [Wiki Audit](audit.md) - Content health analysis
- [File Format](file-format.md) - Frontmatter specification
- [Atlassian: Use folders to organize your work](https://support.atlassian.com/confluence-cloud/docs/use-folders-to-organize-your-work/)
