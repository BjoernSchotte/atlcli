---
title: "Ignore Patterns"
description: "Exclude local files from Confluence sync with .atlcliignore and .gitignore"
---

# Ignore Patterns

Control which local files are excluded from Confluence sync.

## Overview

`wiki docs push`, `wiki docs status` and `wiki docs sync` skip local files that match an ignore pattern. Patterns come from two files in the sync root (the directory that contains `.atlcli/`):

- `.atlcliignore` - atlcli-specific ignore file
- `.gitignore` - Automatically respected

`wiki docs sync` reads them from the directory you pass to it. Ignore files in subdirectories are not read. Patterns only apply to local files: `wiki docs pull` still writes every remote page in scope, and pushing a single file by path skips the check.

## .atlcliignore File

Create a `.atlcliignore` file in your sync directory:

```
# Drafts folder
drafts/

# Work in progress files
*.wip.md
*.draft.md

# Local notes
notes/
TODO.md

# Build artifacts
_build/
.cache/
```

### Pattern Syntax

Uses gitignore-style patterns:

| Pattern | Matches |
|---------|---------|
| `*.md` | All .md files, at any depth |
| `/*.md` | .md files in the sync root only |
| `drafts/` | Any directory named "drafts", with everything in it |
| `!important.md` | Negation - don't ignore this file |
| `docs/*.md` | .md files directly in the root's `docs/` |
| `**/temp/*` | Everything below any "temp" directory |

A file below an ignored directory cannot be re-included. To keep one file, ignore the directory's contents (`archive/*`) instead of the directory (`archive/`).

### Examples

```
# Ignore all files starting with underscore
_*

# Ignore test files
**/test-*.md
**/*.test.md

# Ignore a directory completely
old-versions/

# Ignore a directory's contents, but keep one file
archive/*
!archive/index.md

# Ignore files with specific extensions
*.tmp
*.bak
*.swp

# Ignore hidden files (except .atlcliignore itself)
.*
!.atlcliignore
```

## Default Ignores

atlcli always ignores these patterns:

```
.atlcli/           # State directory
*.meta.json        # Metadata files
*.base             # Legacy merge-base files
.git/              # Git directory
node_modules/      # Node dependencies
```

The three directories cannot be re-included. Sync only handles `.md` files, so the two file patterns matter only for names such as `notes.meta.json.md`.

## .gitignore Integration

The `.gitignore` in the sync root is always read as well; there is no flag to turn it off:

```bash
# Uses both .atlcliignore and .gitignore
atlcli wiki docs push ./docs
```

To sync a file that `.gitignore` excludes, re-include it in `.atlcliignore` (`!generated.md`).

## Pattern Priority

Patterns are evaluated in order:

1. Default ignores (always applied)
2. `.gitignore`
3. `.atlcliignore`

Later patterns override earlier ones (for example with a `!pattern`
negation in `.atlcliignore`), except below an ignored directory.

## Use Cases

### Development Workflow

```
# .atlcliignore for development
drafts/
*.local.md
scratch/
TODO.md
NOTES.md
```

### Multi-Environment

```
# .atlcliignore
# Staging-only pages
staging-*.md

# Test content
test/
fixtures/
```

### Large Repository

```
# .atlcliignore for performance
# Ignore large asset directories
assets/videos/
assets/archives/

# Ignore generated docs
api-docs/generated/
```

### Selective Sync

```
# Only sync specific sections
# (ignore everything in the root, then un-ignore what you want)
/*
!/getting-started/
!/tutorials/
!/reference/
```

## Related Topics

- [Sync](sync.md) - Sync configuration and behavior
- [File Format](file-format.md) - Directory structure conventions
- [Configuration](../configuration.md) - Directory config in `.atlcli/config.json`
