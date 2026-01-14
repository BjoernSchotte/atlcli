# Local Storage Redesign Plan

## Overview

Redesign local file handling to use:
1. **Frontmatter** for page ID (travels with file, rename-proof)
2. **`.atlcli/` directory** for config, state, and merge cache

## Directory Structure

```
my-docs/
├── .atlcli/
│   ├── config.json           # Space/project configuration
│   ├── state.json            # Sync state for all tracked pages
│   └── cache/                # Base versions for 3-way merge
│       ├── 623869955.md
│       └── 623936012.md
├── the-digital-companions.md # User-friendly filename
├── getting-started.md
└── guides/
    ├── index.md              # Parent page for this section
    └── advanced.md           # Child of guides/index.md
```

## File Formats

### Markdown with Frontmatter

```markdown
---
atlcli:
  id: "623869955"
  title: "The Digital Companions - A Poem"
---

# The Digital Companions

Content here...
```

**Notes:**
- `id` is required for tracked files
- `title` is optional (derived from Confluence, can override)
- Frontmatter is stripped before pushing to Confluence
- Frontmatter is added/updated when pulling from Confluence

### .atlcli/config.json

```json
{
  "schemaVersion": 1,
  "space": "DOCSY",
  "baseUrl": "https://mayflowergmbh.atlassian.net",
  "profile": "mayflowergmbh-atlassian-net",
  "settings": {
    "autoCreatePages": false,
    "preserveHierarchy": true,
    "defaultParentId": null
  }
}
```

### .atlcli/state.json

```json
{
  "schemaVersion": 1,
  "lastSync": "2026-01-10T17:52:00Z",
  "pages": {
    "623869955": {
      "path": "the-digital-companions.md",
      "title": "The Digital Companions - A Poem",
      "spaceKey": "DOCSY",
      "version": 4,
      "lastSyncedAt": "2026-01-10T17:52:00Z",
      "localHash": "sha256:abc123...",
      "remoteHash": "sha256:def456...",
      "baseHash": "sha256:789xyz...",
      "syncState": "synced",
      "parentId": null
    }
  },
  "pathIndex": {
    "the-digital-companions.md": "623869955",
    "guides/index.md": "623936012"
  }
}
```

**Notes:**
- `pathIndex` allows quick lookup by filename
- `syncState`: "synced" | "local-modified" | "remote-modified" | "conflict" | "untracked"

### .atlcli/cache/{id}.md

Base version of each page at last sync point (for 3-way merge).
Plain markdown without frontmatter.

## Commands

### `atlcli docs init <dir> --space <KEY>`

Initialize a directory for Confluence sync.

```bash
atlcli docs init ./my-docs --space DOCSY
```

Creates:
- `.atlcli/config.json` with space config
- `.atlcli/state.json` (empty)
- `.atlcli/cache/` directory

### `atlcli docs pull [dir]`

Pull pages from Confluence to local directory.

```bash
atlcli docs pull ./my-docs
# or from within initialized dir:
atlcli docs pull
```

Behavior:
1. Read config from `.atlcli/config.json`
2. Fetch all pages from configured space
3. For each page:
   - Generate clean filename from title (slugify)
   - Write markdown with frontmatter
   - Update state.json
   - Write base version to cache/

Options:
- `--page-id <id>` - Pull single page
- `--cql <query>` - Custom CQL filter
- `--force` - Overwrite local changes

### `atlcli docs push [files...]`

Push local changes to Confluence.

```bash
atlcli docs push                           # Push all modified
atlcli docs push ./the-digital-companions.md  # Push specific file
```

Behavior:
1. Find files with changes (compare localHash)
2. For each modified file:
   - Read frontmatter to get page ID
   - Strip frontmatter from content
   - Convert markdown to storage format
   - Update page in Confluence
   - Update state.json and cache

### `atlcli docs add <file> [--title <title>] [--parent <id>]`

Add a new local file to tracking (creates page in Confluence).

```bash
atlcli docs add ./new-page.md --title "My New Page"
atlcli docs add ./guides/intro.md --parent 623936012
```

Behavior:
1. Read markdown content
2. Create page in Confluence
3. Add frontmatter with new page ID
4. Update state.json

### `atlcli docs status [dir]`

Show sync status of all tracked files.

```bash
atlcli docs status

Output:
  synced:           3 files
  local-modified:   1 file
  remote-modified:  0 files
  conflict:         0 files
  untracked:        2 files

  Modified:
    guides/intro.md (local changes)

  Untracked:
    new-feature.md
    notes/draft.md
```

### `atlcli docs sync [dir] [options]`

Bidirectional sync with conflict detection.

```bash
atlcli docs sync ./my-docs --poll-interval 30000
atlcli docs sync --auto-create   # Auto-create pages for new .md files
```

Options:
- `--poll-interval <ms>` - Polling interval (default: 30000)
- `--auto-create` - Automatically create pages for untracked .md files
- `--watch` - Watch for local file changes
- `--no-poll` - Disable remote polling
- `--on-conflict <mode>` - prompt | local | remote | merge

## Implementation Phases

### Phase 1: Core Infrastructure

Files to create/modify:
- `packages/core/src/frontmatter.ts` - Parse/serialize frontmatter
- `packages/core/src/atlcli-dir.ts` - .atlcli/ directory management
- `packages/core/src/state.ts` - State file management

Functions:
```typescript
// frontmatter.ts
export function parseFrontmatter(markdown: string): {
  frontmatter: AtlcliFrontmatter | null;
  content: string;
}
export function addFrontmatter(content: string, frontmatter: AtlcliFrontmatter): string
export function stripFrontmatter(markdown: string): string

// atlcli-dir.ts
export function findAtlcliDir(startPath: string): string | null
export function initAtlcliDir(dir: string, config: AtlcliConfig): Promise<void>
export function readConfig(dir: string): Promise<AtlcliConfig>
export function readState(dir: string): Promise<AtlcliState>
export function writeState(dir: string, state: AtlcliState): Promise<void>

// state.ts
export function updatePageState(state: AtlcliState, pageId: string, update: Partial<PageState>): void
export function getPageByPath(state: AtlcliState, path: string): PageState | null
export function computeSyncState(localHash: string, remoteHash: string, baseHash: string): SyncState
```

### Phase 2: Command Updates

Update existing commands to use new infrastructure:

1. `docs init` - New command
2. `docs pull` - Use frontmatter, write to .atlcli/
3. `docs push` - Read frontmatter, update state
4. `docs add` - New command
5. `docs status` - Read from state.json
6. `docs sync` - Use new state management

### Phase 3: Migration

Handle migration from old format:
- Detect old `.meta.json` files
- Offer to migrate to new format
- `atlcli docs migrate` command

### Phase 4: Advanced Features

- Directory hierarchy → Confluence parent/child mapping
- `--auto-create` in sync mode
- Rename detection via content hashing

## Filename Generation

When pulling from Confluence:
1. Slugify title: "The Digital Companions - A Poem" → "the-digital-companions-a-poem"
2. Check for conflicts in directory
3. If conflict, append number: "the-digital-companions-a-poem-2"
4. Store mapping in state.json pathIndex

User can rename files freely - the frontmatter ID is the source of truth.

## Conflict Resolution

When both local and remote changed:
1. Load base version from `.atlcli/cache/{id}.md`
2. Perform 3-way merge
3. If auto-mergeable, apply and continue
4. If conflict, write conflict markers and set syncState to "conflict"
5. User resolves with `atlcli docs resolve <file> --accept local|remote|merged`

## Git Integration

Recommended `.gitignore`:
```
.atlcli/cache/
```

Keep tracked:
- `.atlcli/config.json` - Team shares space config
- `.atlcli/state.json` - Optional, depends on workflow

## Open Questions

1. Should we support multiple spaces in one directory?
2. How to handle page deletion (local vs remote)?
3. Should `docs add` auto-detect title from first H1?
4. How to handle attachments/images?
