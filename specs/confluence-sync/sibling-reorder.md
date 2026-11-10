# Sibling Reordering Spec

## Overview

Enable reordering of sibling pages in the Confluence page tree via CLI, with user-friendly file-based references and bulk sorting operations.

---

## CLI Interface

### Basic Reordering

```bash
# Move page before a sibling (by file path)
atlcli page move ./docs/setup.md --before ./docs/introduction.md

# Move page after a sibling (by file path)
atlcli page move ./docs/advanced.md --after ./docs/basics.md

# Move page to be first child of parent
atlcli page move ./docs/quickstart.md --first

# Move page to be last child of parent
atlcli page move ./docs/appendix.md --last

# Move to specific position (1-indexed)
atlcli page move ./docs/chapter-3.md --position 3
```

### By Page ID (existing + extended)

```bash
# Move to new parent (existing behavior)
atlcli page move --id 12345 --parent 67890

# Move before/after sibling by ID
atlcli page move --id 12345 --before 11111
atlcli page move --id 12345 --after 22222

# Move to first/last position
atlcli page move --id 12345 --first
atlcli page move --id 12345 --last
```

### By Page Title

```bash
# Move by title within same space
atlcli page move --title "Setup Guide" --before --title "Introduction"
atlcli page move --title "Setup Guide" --after --title "Getting Started" --space DOCS
```

### Bulk Sorting Operations

```bash
# Sort all children of a page alphabetically (A-Z)
atlcli page sort ./docs/api-reference.md --alphabetical
atlcli page sort --id 12345 --alphabetical

# Sort reverse alphabetically (Z-A)
atlcli page sort ./docs/api-reference.md --alphabetical --reverse

# Sort by creation date (oldest first)
atlcli page sort ./docs/changelog.md --by created

# Sort by creation date (newest first)
atlcli page sort ./docs/changelog.md --by created --reverse

# Sort by last modified date
atlcli page sort ./docs/articles.md --by modified --reverse

# Sort by title numerically (for numbered chapters)
atlcli page sort ./docs/chapters.md --natural
# e.g., "Chapter 1", "Chapter 2", "Chapter 10" (not "Chapter 1", "Chapter 10", "Chapter 2")

# Preview sort without applying
atlcli page sort ./docs/api-reference.md --alphabetical --dry-run
```

### Interactive Reordering

```bash
# Interactive mode: shows current order, lets user rearrange
atlcli page sort ./docs/guide.md --interactive
```

Output:
```
Children of "User Guide" (5 pages):
  1. Introduction
  2. Getting Started
  3. Advanced Topics
  4. FAQ
  5. Troubleshooting

Enter new order (e.g., "3,1,2,4,5" or "swap 2 3"):
> 1,2,4,5,3

New order:
  1. Introduction
  2. Getting Started
  3. FAQ
  4. Troubleshooting
  5. Advanced Topics

Apply changes? [y/N]: y
Reordered 5 pages.
```

---

## File Path Resolution

### How It Works

When a user provides a file path instead of an ID:

1. **Read frontmatter** from the markdown file to get the `atlcli.id`
2. **Validate** the ID exists in Confluence
3. **Use the ID** for the API call

```markdown
---
atlcli:
  id: "623869955"
  title: "Setup Guide"
---
```

### Resolution Priority

For `--before`, `--after`, `--parent` targets:

1. If argument looks like a file path (contains `/` or ends in `.md`): resolve from file
2. If argument is numeric: treat as page ID
3. Otherwise: search by title in current space

### Error Handling

```bash
$ atlcli page move ./docs/missing.md --before ./docs/intro.md
Error: File not found: ./docs/missing.md

$ atlcli page move ./docs/untracked.md --before ./docs/intro.md
Error: File ./docs/untracked.md is not tracked (no atlcli.id in frontmatter)
Hint: Run 'atlcli docs add ./docs/untracked.md' first

$ atlcli page move ./docs/page.md --before ./other/page.md
Error: Pages must have the same parent for sibling reordering
  ./docs/page.md parent: "Documentation" (ID: 111)
  ./other/page.md parent: "Other Section" (ID: 222)
Hint: Use --parent to move to a different parent first
```

---

## API Implementation

### Move Page Endpoint

```
PUT /wiki/rest/api/content/{pageId}/move/{position}/{targetId}
```

**Position values:**
- `before` - place before targetId (same parent)
- `after` - place after targetId (same parent)
- `append` - place as child of targetId

### Position Attribute

The API returns position in `extensions.position`:

```json
{
  "id": "12345",
  "title": "My Page",
  "extensions": {
    "position": 175485145
  }
}
```

**Note:** Position may be `null` for:
- Migrated content
- Pages with deleted parents
- Legacy content

Fallback: alphabetical sort when position is null.

### New Client Methods

```typescript
// client.ts additions

/**
 * Move page to position relative to a sibling.
 *
 * PUT /content/{id}/move/{position}/{targetId}
 */
async movePageToPosition(
  pageId: string,
  position: "before" | "after" | "append",
  targetId: string
): Promise<ConfluencePage>;

/**
 * Get children with position information.
 *
 * GET /content/{parentId}/child/page?expand=extensions.position
 */
async getChildrenWithPosition(
  parentId: string,
  options?: { limit?: number }
): Promise<ConfluencePageWithPosition[]>;

/**
 * Reorder all children of a page.
 * Moves pages sequentially to achieve desired order.
 */
async reorderChildren(
  parentId: string,
  orderedChildIds: string[]
): Promise<void>;
```

### Reorder Algorithm

To reorder children to a specific order:

```typescript
async function reorderChildren(parentId: string, newOrder: string[]): Promise<void> {
  // Strategy: Move each page after the previous one
  // This minimizes API calls and handles any starting order

  for (let i = 1; i < newOrder.length; i++) {
    const pageId = newOrder[i];
    const afterId = newOrder[i - 1];
    await client.movePageToPosition(pageId, "after", afterId);
  }
}
```

For N pages, this requires N-1 API calls.

---

## Sorting Implementation

### Sort Strategies

```typescript
type SortStrategy =
  | { type: "alphabetical"; reverse?: boolean }
  | { type: "natural"; reverse?: boolean }      // Numeric-aware
  | { type: "created"; reverse?: boolean }
  | { type: "modified"; reverse?: boolean }
  | { type: "custom"; order: string[] };

async function sortChildren(
  parentId: string,
  strategy: SortStrategy
): Promise<{ oldOrder: Page[]; newOrder: Page[] }> {
  const children = await client.getChildrenWithPosition(parentId);

  let sorted: Page[];
  switch (strategy.type) {
    case "alphabetical":
      sorted = [...children].sort((a, b) =>
        a.title.localeCompare(b.title)
      );
      break;
    case "natural":
      sorted = [...children].sort((a, b) =>
        naturalCompare(a.title, b.title)
      );
      break;
    case "created":
      sorted = [...children].sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      break;
    case "modified":
      sorted = [...children].sort((a, b) =>
        new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime()
      );
      break;
    case "custom":
      sorted = strategy.order.map(id =>
        children.find(c => c.id === id)!
      );
      break;
  }

  if (strategy.reverse) {
    sorted.reverse();
  }

  return { oldOrder: children, newOrder: sorted };
}
```

### Natural Sort

For numbered content like "Chapter 1", "Chapter 2", "Chapter 10":

```typescript
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
```

---

## Output Formats

### Default (Human-Readable)

```bash
$ atlcli page move ./docs/setup.md --before ./docs/intro.md
Moved "Setup Guide" before "Introduction"

$ atlcli page sort ./docs/guide.md --alphabetical
Sorted 5 children of "User Guide" alphabetically:
  1. Advanced Topics
  2. FAQ
  3. Getting Started
  4. Introduction
  5. Troubleshooting
```

### JSON Output

```bash
$ atlcli page move ./docs/setup.md --before ./docs/intro.md --json
{
  "schemaVersion": "1",
  "moved": {
    "id": "12345",
    "title": "Setup Guide"
  },
  "position": "before",
  "target": {
    "id": "67890",
    "title": "Introduction"
  }
}

$ atlcli page sort ./docs/guide.md --alphabetical --json
{
  "schemaVersion": "1",
  "parent": {
    "id": "11111",
    "title": "User Guide"
  },
  "strategy": "alphabetical",
  "changes": [
    { "id": "22222", "title": "Advanced Topics", "oldPosition": 3, "newPosition": 1 },
    { "id": "33333", "title": "FAQ", "oldPosition": 4, "newPosition": 2 },
    { "id": "44444", "title": "Getting Started", "oldPosition": 2, "newPosition": 3 },
    { "id": "55555", "title": "Introduction", "oldPosition": 1, "newPosition": 4 },
    { "id": "66666", "title": "Troubleshooting", "oldPosition": 5, "newPosition": 5 }
  ]
}
```

### Dry Run

```bash
$ atlcli page sort ./docs/guide.md --alphabetical --dry-run
Would reorder 5 children of "User Guide":

Current order:          New order:
  1. Introduction    →    1. Advanced Topics
  2. Getting Started →    2. FAQ
  3. Advanced Topics →    3. Getting Started
  4. FAQ             →    4. Introduction
  5. Troubleshooting →    5. Troubleshooting

Run without --dry-run to apply changes.
```

---

## Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `packages/confluence/src/reorder.ts` | Reorder logic and sort strategies |
| `packages/confluence/src/reorder.test.ts` | Unit tests |

### Modified Files

| File | Changes |
|------|---------|
| `packages/confluence/src/client.ts` | Add `movePageToPosition()`, `getChildrenWithPosition()` |
| `apps/cli/src/commands/page.ts` | Extend `move` command, add `sort` subcommand |
| `packages/confluence/src/index.ts` | Export reorder functions |

---

## Edge Cases

### Same Position (No-op)

```bash
$ atlcli page move ./docs/intro.md --before ./docs/setup.md
# If intro.md is already before setup.md:
No change needed: "Introduction" is already before "Setup Guide"
```

### Single Child

```bash
$ atlcli page sort ./docs/single-child-parent.md --alphabetical
Nothing to sort: "Parent Page" has only 1 child page
```

### Circular Reference Prevention

```bash
$ atlcli page move ./docs/parent.md --parent ./docs/parent/child.md
Error: Cannot move page under its own descendant
```

### Top-Level Page Warning

```bash
$ atlcli page move ./docs/page.md --before ./docs/space-home.md
Warning: Target is a top-level page. Moving here may make the page hard to find in the UI.
Continue? [y/N]:
```

---

## Implementation Order

1. **Phase 1: API Methods**
   - Add `movePageToPosition()` to client
   - Add `getChildrenWithPosition()` to client
   - Unit tests for new methods

2. **Phase 2: Basic Move Commands**
   - Extend `page move` with `--before`, `--after`, `--first`, `--last`
   - File path resolution
   - E2E tests

3. **Phase 3: Sort Command**
   - Add `page sort` subcommand
   - Implement sort strategies (alphabetical, natural, created, modified)
   - `--dry-run` support

4. **Phase 4: Interactive Mode**
   - Interactive reordering UI
   - Confirmation prompts

---

## Examples

### Organize API Documentation

```bash
# Sort all API endpoints alphabetically
atlcli page sort ./docs/api/endpoints.md --alphabetical

# Put "Overview" first, then sort rest alphabetically
atlcli page move ./docs/api/overview.md --first
atlcli page sort ./docs/api/endpoints.md --alphabetical
```

### Reorder Chapters

```bash
# Natural sort for numbered chapters
atlcli page sort ./docs/book.md --natural

# Result: Chapter 1, Chapter 2, ... Chapter 10, Chapter 11
# (not: Chapter 1, Chapter 10, Chapter 11, Chapter 2, ...)
```

### Changelog Ordering

```bash
# Sort changelog entries by creation date, newest first
atlcli page sort ./docs/changelog.md --by created --reverse
```

### Manual Reorder via Interactive

```bash
$ atlcli page sort ./docs/guide.md --interactive

Children of "Developer Guide" (4 pages):
  1. Installation
  2. Configuration
  3. Quick Start
  4. API Reference

Enter new order (comma-separated positions, e.g., "3,1,2,4"):
> 1,3,2,4

Reordering...
  Installation     (no change)
  Quick Start      moved from 3 → 2
  Configuration    moved from 2 → 3
  API Reference    (no change)

Done! Reordered 2 pages.
```
