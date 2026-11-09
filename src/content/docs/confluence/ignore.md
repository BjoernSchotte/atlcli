---
title: "Ignore Patterns"
description: "Ignore Patterns - atlcli documentation"
---

# Ignore Patterns

Control which files are excluded from Confluence sync.

## Overview

atlcli supports ignore patterns to exclude files from sync operations:

- `.atlcliignore` - atlcli-specific ignore file
- `.gitignore` - Automatically respected

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
| `*.md` | All .md files in current directory |
| `**/*.md` | All .md files recursively |
| `drafts/` | Directory named "drafts" |
| `!important.md` | Negation - don't ignore this file |
| `docs/*.md` | .md files in docs/ only |
| `**/temp/*` | Any file in any "temp" directory |

### Examples

```
# Ignore all files starting with underscore
_*

# Ignore test files
**/test-*.md
**/*.test.md

# Ignore specific directories
archive/
old-versions/

# But keep specific files in ignored directories
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
.git/              # Git directory
.gitignore         # Git ignore file
node_modules/      # Node dependencies
```

These cannot be overridden.

## .gitignore Integration

By default, `.gitignore` patterns are also respected:

```bash
# Uses both .atlcliignore and .gitignore
atlcli wiki docs pull ./docs
```

## Pattern Priority

Patterns are evaluated in order:

1. Default ignores (always applied)
2. `.gitignore`
3. `.atlcliignore`

Later patterns can override earlier ones (for example with a `!pattern`
negation in `.atlcliignore`), except for default ignores.

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
# (ignore everything, then un-ignore what you want)
*
!getting-started/
!tutorials/
!reference/
```

## Related Topics

- [Sync](sync.md) - Sync configuration and behavior
- [File Format](file-format.md) - Directory structure conventions
- [Configuration](../configuration.md) - Global ignore settings
