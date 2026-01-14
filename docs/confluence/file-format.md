# File Format

Structure and format of local Confluence files.

## Frontmatter

Each file has YAML frontmatter with metadata:

```markdown
---
id: "12345"
title: "Page Title"
space: "TEAM"
parent: "67890"
version: 5
lastModified: "2025-01-14T10:00:00Z"
---

# Page Title

Content here...
```

### Required Fields

| Field | Description |
|-------|-------------|
| `id` | Confluence page ID (generated on create) |
| `title` | Page title |
| `space` | Space key |

### Optional Fields

| Field | Description |
|-------|-------------|
| `parent` | Parent page ID |
| `version` | Page version number |
| `lastModified` | Last modification timestamp |
| `labels` | Array of page labels |

## Directory Structure

```
docs/
├── .atlcli.json          # Project config
├── index.md              # Space home page
├── getting-started.md    # Top-level page
└── guides/
    ├── _index.md         # "Guides" parent page
    ├── installation.md   # Child page
    └── configuration.md  # Child page
```

Directories with `_index.md` create parent-child relationships.

## Naming Conventions

- Use lowercase with hyphens: `api-reference.md`
- `_index.md` becomes the parent page for a directory
- File names don't affect page titles (title comes from frontmatter)
