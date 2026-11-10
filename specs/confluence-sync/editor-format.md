# Editor Format Support

## Overview

Confluence Cloud has two editor formats:
- **Legacy editor** (v1): Full-width layout, grey callouts, older rendering
- **New editor** (v2): Centered layout, colored callouts, modern rendering

Pages created via API default to legacy editor. This feature adds support for:
1. Creating new pages in new editor format (default)
2. Tracking editor format in sync state
3. Converting pages between formats
4. Auditing editor format across pages

---

## 1. New Page Creation

### Behavior
- **Default**: Create pages in new editor format (v2)
- **Flag**: `--legacy-editor` to opt-out and use legacy format

### Implementation

After creating a page via API, set the editor property:

```typescript
// POST /wiki/rest/api/content/{id}/property/editor
await fetch(`${baseUrl}/wiki/rest/api/content/${pageId}/property/editor`, {
  method: "POST",
  headers: { "Authorization": auth, "Content-Type": "application/json" },
  body: JSON.stringify({ key: "editor", value: "v2" })
});
```

### Changes Required

| File | Change |
|------|--------|
| `packages/confluence/src/client.ts` | Add `setEditorVersion(pageId, version)` method |
| `apps/cli/src/commands/docs.ts` | Call `setEditorVersion` after `createPage` unless `--legacy-editor` |
| `apps/cli/src/commands/wiki.ts` | Add `--legacy-editor` flag to `page create` |

---

## 2. Track Editor Format on Pull

### Storage
Store editor version in sync database only (not frontmatter).

### Schema Change

```sql
ALTER TABLE pages ADD COLUMN editor_version TEXT DEFAULT NULL;
-- Values: 'v2', 'v1', or NULL (unknown/legacy)
```

### Detection
When pulling pages, query the editor property:

```typescript
// GET /wiki/rest/api/content/{id}?expand=metadata.properties.editor
const editorVersion = response.metadata?.properties?.editor?.value || null;
```

### Changes Required

| File | Change |
|------|--------|
| `packages/confluence/src/client.ts` | Add `getEditorVersion(pageId)` method |
| `packages/confluence/src/atlcli-dir.ts` | Add `editor_version` column to schema |
| `apps/cli/src/commands/docs.ts` | Store editor version during pull |
| `apps/cli/src/commands/sync.ts` | Store editor version during sync |

---

## 3. Conversion Command

### Commands

```bash
# Single page by ID
atlcli wiki page convert --id 12345 --to-new-editor
atlcli wiki page convert --id 12345 --to-legacy-editor

# Single page by file
atlcli wiki docs convert ./docs/page.md --to-new-editor

# Directory (all tracked pages)
atlcli wiki docs convert ./docs --to-new-editor --confirm

# Space-wide
atlcli wiki space convert SPACE --to-new-editor --confirm

# Dry-run (show what would be converted)
atlcli wiki docs convert ./docs --to-new-editor --dry-run
```

### Safety
- Bulk operations (directory, space) require `--confirm` flag
- `--dry-run` shows pages that would be converted without making changes
- JSON output includes list of converted/skipped pages

### Implementation

```typescript
async function convertEditorFormat(pageId: string, targetVersion: 'v2' | 'v1'): Promise<void> {
  const current = await client.getEditorVersion(pageId);
  if (current === targetVersion) {
    // Already in target format, skip
    return;
  }
  await client.setEditorVersion(pageId, targetVersion);
}
```

### Changes Required

| File | Change |
|------|--------|
| `packages/confluence/src/client.ts` | Add `setEditorVersion(pageId, version)` method |
| `apps/cli/src/commands/wiki.ts` | Add `page convert` subcommand |
| `apps/cli/src/commands/docs.ts` | Add `docs convert` subcommand |
| `apps/cli/src/commands/wiki.ts` | Add `space convert` subcommand |

---

## 4. Audit Integration

### Output

Add editor format to `docs audit` and `docs status` output:

```bash
$ atlcli wiki docs audit ./docs

Editor Format:
  New editor (v2):    45 pages
  Legacy editor (v1): 12 pages
  Unknown:             3 pages

Legacy pages:
  - ./docs/old-page.md (12345)
  - ./docs/another.md (67890)
  ...
```

### JSON Output

```json
{
  "editorFormat": {
    "v2": 45,
    "v1": 12,
    "unknown": 3
  },
  "legacyPages": [
    { "path": "./docs/old-page.md", "id": "12345", "title": "Old Page" }
  ]
}
```

### Changes Required

| File | Change |
|------|--------|
| `apps/cli/src/commands/docs.ts` | Add editor stats to `handleDocsAudit()` |

---

## 5. API Methods

### New Methods in ConfluenceClient

```typescript
/**
 * Get the editor version for a page.
 * Returns 'v2' for new editor, 'v1' or null for legacy.
 */
async getEditorVersion(pageId: string): Promise<'v2' | 'v1' | null> {
  const data = await this.request(`/content/${pageId}?expand=metadata.properties.editor`);
  return data.metadata?.properties?.editor?.value || null;
}

/**
 * Set the editor version for a page.
 * Use 'v2' for new editor, 'v1' for legacy.
 */
async setEditorVersion(pageId: string, version: 'v2' | 'v1'): Promise<void> {
  // Check if property exists
  try {
    await this.request(`/content/${pageId}/property/editor`);
    // Property exists, update it
    await this.request(`/content/${pageId}/property/editor`, {
      method: 'PUT',
      body: { key: 'editor', value: version, version: { number: currentVersion + 1 } }
    });
  } catch {
    // Property doesn't exist, create it
    await this.request(`/content/${pageId}/property/editor`, {
      method: 'POST',
      body: { key: 'editor', value: version }
    });
  }
}
```

---

## 6. Database Schema Migration

```typescript
// Migration 7: Add editor_version column
{
  version: 7,
  up: async (db) => {
    db.run(`ALTER TABLE pages ADD COLUMN editor_version TEXT DEFAULT NULL`);
  }
}
```

---

## 7. CLI Flags Summary

| Command | Flag | Description |
|---------|------|-------------|
| `docs push` | `--legacy-editor` | Create new pages in legacy format |
| `docs add` | `--legacy-editor` | Create page in legacy format |
| `page create` | `--legacy-editor` | Create page in legacy format |
| `docs convert` | `--to-new-editor` | Convert to new editor format |
| `docs convert` | `--to-legacy-editor` | Convert to legacy format |
| `docs convert` | `--confirm` | Required for bulk operations |
| `docs convert` | `--dry-run` | Show what would be converted |
| `page convert` | `--to-new-editor` | Convert single page to new editor |
| `space convert` | `--to-new-editor` | Convert all pages in space |
| `space convert` | `--confirm` | Required for space-wide conversion |

---

## 8. Testing Strategy

### Unit Tests
- `client.getEditorVersion()` returns correct value
- `client.setEditorVersion()` creates/updates property
- Schema migration adds column correctly

### E2E Tests
```bash
# Create page, verify new editor
atlcli wiki page create --space DOCSY --title "Test" --content "Hello"
# Check editor version via API

# Create with legacy flag
atlcli wiki page create --space DOCSY --title "Test Legacy" --content "Hello" --legacy-editor
# Verify legacy editor

# Convert page
atlcli wiki page convert --id 12345 --to-new-editor
# Verify new editor

# Audit shows editor stats
atlcli wiki docs audit ./docs --json | jq '.editorFormat'
```

---

## 9. Implementation Order

1. **Phase 1: API Methods**
   - Add `getEditorVersion()` and `setEditorVersion()` to client
   - Add unit tests

2. **Phase 2: New Page Creation**
   - Set editor to v2 after creating pages
   - Add `--legacy-editor` flag
   - E2E test

3. **Phase 3: Pull/Sync Tracking**
   - Add database migration
   - Store editor version on pull
   - Update sync state

4. **Phase 4: Conversion Commands**
   - `page convert` command
   - `docs convert` command
   - `space convert` command
   - Dry-run and confirm flags

5. **Phase 5: Audit**
   - Add editor stats to audit output
   - List legacy pages

---

## Open Questions

None - all questions resolved via user input.
