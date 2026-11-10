# Partial Sync Specification

## Overview

Enable granular sync control: single pages, page trees (parent + descendants), or entire spaces.

**Implementation Status: COMPLETE**

All phases have been implemented:
- Phase 1: Hierarchical Directory Structure ✅
- Phase 2: Scope Options for Pull ✅
- Phase 3: Scope Options for Init ✅
- Phase 4: Single File Push ✅
- Phase 5: Sync & Watch Updates ✅

**Current State (after implementation):**
- `docs init` supports `--page-id`, `--ancestor`, `--space` scope options
- `docs pull` and `docs push` support all scope options
- `docs sync` uses config scope as default, can be overridden with flags
- Nested directory structure matches Confluence hierarchy
- Page moves are detected and local files are moved automatically

**Goal (ACHIEVED):**
- Unify scope options across `pull`, `push`, `sync`, and `watch`
- Support mixed-scope directories (pages from different spaces/trees)
- Maintain backwards compatibility

---

## Scope Types

### 1. Single Page (`--page-id`)

Sync exactly one page by ID.

```bash
# Pull single page
atlcli docs pull ./docs --page-id 12345

# Push single page (by file or ID)
atlcli docs push ./docs/my-page.md
atlcli docs push --page-id 12345
```

**Use cases:**
- Quick edits to one page
- Testing sync on a single page
- CI/CD updating a specific doc

### 2. Page Tree (`--ancestor`)

Sync a page and all its descendants.

```bash
# Pull entire tree under parent
atlcli docs pull ./docs --ancestor 12345

# Tree is preserved in directory structure
./docs/
├── parent-page.md
├── child-a/
│   ├── index.md
│   └── grandchild.md
└── child-b.md
```

**Use cases:**
- Department/team documentation
- Project-specific docs
- Subset of a large space

### 3. Full Space (`--space`)

Sync all pages in a space (current behavior).

```bash
atlcli docs pull ./docs --space TEAM
```

### 4. Multiple Scopes (Future)

Sync multiple specific pages or trees.

```bash
atlcli docs pull ./docs --page-id 111 --page-id 222 --ancestor 333
```

---

## Command Changes

### `docs init`

Add optional scope parameters:

```bash
# Current (space-only)
atlcli docs init ./docs --space TEAM

# New options
atlcli docs init ./docs --page-id 12345
atlcli docs init ./docs --ancestor 12345
atlcli docs init ./docs --space TEAM  # unchanged
```

**Config changes (`.atlcli/config.json`):**

```json
{
  "scope": {
    "type": "tree",
    "ancestorId": "12345"
  },
  "space": "TEAM"
}
```

### `docs pull`

```bash
# Pull using initialized scope
atlcli docs pull ./docs

# Override scope for this pull
atlcli docs pull ./docs --page-id 12345
atlcli docs pull ./docs --ancestor 12345
atlcli docs pull ./docs --space TEAM

# Pull specific file (uses frontmatter ID)
atlcli docs pull ./docs/specific-page.md
```

### `docs push`

```bash
# Push all tracked files
atlcli docs push ./docs

# Push specific file
atlcli docs push ./docs/my-page.md

# Push by page ID
atlcli docs push --page-id 12345
```

### `docs sync`

Already supports scope - no changes needed.

### `docs status`

Show scope info:

```bash
atlcli docs status ./docs

# Output:
# Scope: tree (ancestor: 12345 "Architecture Docs")
# Space: TEAM
# Files: 15 synced, 2 modified, 1 conflict
```

---

## Directory Structure

**Decision:** Nested hierarchy matching Confluence tree structure.

```
./docs/
├── .atlcli/
├── parent-page.md
└── parent-page/
    ├── child-a.md
    ├── child-a/
    │   └── grandchild.md
    └── child-b.md
```

**Rules:**
- Page file: `{slug}.md`
- Child pages go in: `{slug}/` directory (same name as parent file without .md)
- Root pages (no parent in scope) go in sync root
- Space home page becomes `index.md` or `{space-key}.md` at root

**Example for space TEAM:**
```
./docs/
├── .atlcli/
├── index.md                    # Space home page
├── architecture/
│   ├── index.md                # "Architecture" page
│   ├── api-design.md
│   └── database/
│       ├── index.md            # "Database" page
│       └── schema.md
└── guides/
    ├── index.md
    └── getting-started.md
```

**Handling moves:** When a page moves in Confluence, the local file is moved to match.

---

## State Management

### Current State Structure

```json
{
  "schemaVersion": 1,
  "space": "TEAM",
  "pages": {
    "12345": {
      "path": "page-title.md",
      "title": "Page Title",
      "version": 5
    }
  }
}
```

### Proposed State Structure

```json
{
  "schemaVersion": 2,
  "scope": {
    "type": "tree",
    "ancestorId": "12345"
  },
  "space": "TEAM",
  "pages": {
    "12345": {
      "path": "page-title.md",
      "title": "Page Title",
      "version": 5,
      "parentId": null,
      "ancestors": []
    },
    "12346": {
      "path": "child-page.md",
      "title": "Child Page",
      "version": 3,
      "parentId": "12345",
      "ancestors": ["12345"]
    }
  }
}
```

---

## API Usage

### Single Page

```typescript
// Pull single page
const page = await client.getPage(pageId);
```

### Page Tree

```typescript
// Get all descendants of a page
const pages = await client.getDescendants(ancestorId);

// Or use CQL
const pages = await client.searchPages(`ancestor=${ancestorId}`);
```

### Check Confluence API

Need to verify:
- Does `GET /wiki/api/v2/pages/{id}/children` exist?
- Does `ancestor=X` CQL work recursively?
- Rate limits for large trees?

---

## Implementation Plan

### Phase 1: Hierarchical Directory Structure ✅ COMPLETE

**Goal:** Change from flat to nested directory structure.

1. **Add hierarchy utilities** (`packages/confluence/src/hierarchy.ts`) ✅
   - `computeFilePath(page, ancestors, rootDir)` → nested path
   - `parseFilePath(filePath, rootDir)` → extract hierarchy info
   - `moveFile(oldPath, newPath)` → move file + update state
   - `hasPageMoved(oldAncestors, newAncestors)` → detect hierarchy changes
   - `buildPathMap(pages)` → batch path computation

2. **Update `handlePull`** ✅
   - Fetch page ancestors from Confluence API
   - Compute nested path based on hierarchy
   - Create directories as needed
   - Update state with `parentId` and `ancestors`

3. **Update `handlePush`** ✅
   - Infer hierarchy from file path
   - Maintain parent relationships on create

4. **Handle page moves** ✅
   - On pull, detect if page's parent changed
   - Move local file to new location
   - Update state

### Phase 2: Scope Options for Pull ✅ COMPLETE

**Goal:** Add `--page-id` and `--ancestor` to `docs pull`.

1. **Parse scope flags in `handlePull`** ✅
   - Created `packages/confluence/src/scope.ts`
   - `parseScope(flags)` returns SyncScope

2. **Build CQL query from scope** ✅
   - `buildCqlFromScope(scope)` generates appropriate query
   - `page`: Direct fetch, no CQL
   - `tree`: `ancestor=${id} AND type=page` CQL
   - `space`: `space=${key} AND type=page` CQL

3. **Auto-detect space from page/ancestor** ✅
   - Fetches page to get spaceKey
   - Uses spaceKey for API calls

### Phase 3: Scope Options for Init ✅ COMPLETE

**Goal:** Initialize with any scope type.

1. **Add flags to `docs init`** ✅
   ```bash
   atlcli docs init ./docs --page-id 12345
   atlcli docs init ./docs --ancestor 12345 --space TEAM
   atlcli docs init ./docs --space TEAM
   ```

2. **Update config schema** ✅
   - Created `AtlcliConfigV2` with `scope` field
   - Backwards compatible with v1 config
   - `migrateConfigToV2()` for upgrades

3. **Auto-detect space from page/ancestor** ✅
   - Fetch page, extract spaceKey
   - Store in config for reference

### Phase 4: Single File Push ✅ COMPLETE

**Goal:** Push individual files by path.

1. **Detect file argument** ✅
   ```bash
   atlcli docs push ./docs/page.md  # single file
   atlcli docs push ./docs          # all tracked (current)
   ```

2. **Extract page ID from frontmatter** ✅
   - Read file, parse frontmatter
   - Use `atlcli.id` field

3. **Push regardless of scope** ✅
   - Single file push works even if page isn't in configured scope
   - Useful for quick edits

### Phase 5: Sync & Watch Updates ✅ COMPLETE

**Goal:** Ensure `docs sync` and `docs watch` work with new structure.

1. **Update `SyncEngine`** ✅
   - Uses nested paths based on page ancestors
   - Handles file moves during sync
   - Reads scope from config when no flags provided

2. **Update file watcher** ✅
   - Already watches nested directories via `collectDirs()`
   - Correctly maps paths to page IDs

---

## File Changes Summary

### New Files
- `packages/confluence/src/hierarchy.ts` - Path computation, file moves

### Modified Files
- `packages/confluence/src/client.ts` - Add `getAncestors(pageId)` method
- `apps/cli/src/commands/docs.ts` - Scope flags, nested paths
- `apps/cli/src/commands/sync.ts` - Nested path support
- `.atlcli/config.json` schema - Add `scope` field
- `.atlcli/state.json` schema - Add `parentId`, `ancestors` to pages

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Pull page not in scope | Warning, skip unless `--force` |
| Push page not in scope | Allow (page has ID in frontmatter) |
| Page moved in Confluence | Update parentId in state, optionally move file |
| Page deleted in Confluence | Mark as deleted in status, optionally remove local |
| Ancestor deleted | Error on pull, suggest re-init with new scope |
| Circular references | Shouldn't happen in Confluence, but detect and error |

---

## Decisions

1. **Mixed scopes in one directory?**
   - **No.** One scope per directory. Keeps it simple and predictable.

2. **Directory structure?**
   - **Nested hierarchy** matching Confluence tree. Applies to all scope types.

3. **Hierarchy changes?**
   - **Move local files** when pages move in Confluence.

4. **Single file push?**
   - **Yes**, works even if page isn't in initialized scope. Uses frontmatter ID.

---

## Migration

**From schemaVersion 1 to 2:**

1. If `config.space` exists, set `scope: { type: "space", spaceKey: space }`
2. Keep `space` field for backwards compat
3. No file changes needed

---

## Testing

- Unit tests for scope parsing
- Integration tests:
  - Pull single page, verify only that page synced
  - Pull tree, verify all descendants synced
  - Push single file, verify only that page updated
  - Init with different scopes
- E2E: Real Confluence instance
