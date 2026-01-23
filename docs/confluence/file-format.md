# File Format

Structure and format of local Confluence files.

::: toc

## Page Frontmatter

Each page file has YAML frontmatter under the `atlcli` namespace:

```markdown
---
atlcli:
  id: "12345"
  title: "Page Title"
---

# Page Title

Content here...
```

### Required Fields

| Field | Description |
|-------|-------------|
| `id` | Confluence page ID (set automatically on pull/create) |
| `title` | Page title |

### Optional Fields

| Field | Description |
|-------|-------------|
| `type` | Content type: `page` (default) or `folder` |
| `version` | Page version number |
| `lastModified` | Last modification timestamp |

## Folder Frontmatter

Folders use `index.md` files with `type: folder`:

```markdown
---
atlcli:
  id: "123456789"
  title: "My Folder"
  type: "folder"
---
```

Key differences from pages:

- **No content body** - folder index.md files contain only frontmatter
- **type field required** - must be `"folder"` to identify as folder
- **Directory structure** - the folder's children are sibling files and subdirectories

See [Folders](folders.md) for full details.

## Directory Structure

```
docs/
├── .atlcli/              # Sync state directory
│   ├── config.json       # Sync configuration
│   └── sync.db           # SQLite sync database
├── index.md              # Space home page
├── getting-started.md    # Top-level page
├── guides/               # Confluence folder
│   ├── index.md          # Folder metadata (type: folder)
│   ├── installation.md   # Page inside folder
│   └── configuration.md  # Page inside folder
└── api/                  # Nested folder
    ├── index.md          # Folder metadata
    └── endpoints.md      # Page inside folder
```

### Hierarchy Mapping

| Confluence | Local |
|------------|-------|
| Page | `page-name.md` |
| Page with children | `page-name.md` + `page-name/` directory |
| Folder | `folder-name/index.md` (type: folder) |
| Page in folder | `folder-name/page-name.md` |

## Naming Conventions

- Use lowercase with hyphens: `api-reference.md`
- Folder metadata is always `index.md` (not the page name)
- atlcli derives file names from page titles (sanitized)
- File names don't affect page titles (title comes from frontmatter)

## Examples

### Minimal: New Page

Create a file with basic frontmatter:

```markdown
---
atlcli:
  title: "Getting Started"
---

# Getting Started

Welcome to our documentation.
```

After push, atlcli adds the `id` field automatically.

### Advanced: Full Metadata

A synced page with all metadata:

```markdown
---
atlcli:
  id: "123456789"
  title: "API Authentication"
  version: 12
  lastModified: "2025-01-14T10:30:00Z"
  labels:
    - api
    - security
    - v2
---

# API Authentication

This guide covers authentication methods...
```

## Related Topics

- [Folders](folders.md) - Folder structure and index.md files
- [Sync](sync.md) - How atlcli syncs files with Confluence
- [Macros](macros.md) - Markdown syntax for Confluence macros
