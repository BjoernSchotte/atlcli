# Ignore Patterns

Control which files are excluded from Confluence sync.

## Overview

atlcli supports ignore patterns to exclude files from sync operations:

- `.atlcliignore` - atlcli-specific ignore file
- `.gitignore` - Automatically respected (can be disabled)

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

Disable gitignore integration:

```bash
atlcli wiki docs pull ./docs --no-gitignore
```

Or in config:

```json
{
  "sync": {
    "respectGitignore": false
  }
}
```

## Check Ignored Files

See which files are being ignored:

```bash
atlcli wiki docs status ./docs --show-ignored
```

Output:

```
Ignored files (12):
  drafts/new-feature.md       (.atlcliignore: drafts/)
  old-api.draft.md            (.atlcliignore: *.draft.md)
  node_modules/...            (default: node_modules/)
  .git/...                    (default: .git/)
```

## Sync-Specific Ignores

Ignore files only for specific operations:

```bash
# Ignore during pull only
atlcli wiki docs pull ./docs --ignore "generated/**"

# Ignore during push only
atlcli wiki docs push ./docs --ignore "local-only/**"
```

## Configuration

Configure ignores in `.atlcli/config.json`:

```json
{
  "sync": {
    "ignore": [
      "drafts/**",
      "*.wip.md",
      "local-notes/"
    ],
    "respectGitignore": true
  }
}
```

## Pattern Priority

Patterns are evaluated in order:

1. Default ignores (always applied)
2. `.gitignore` (if enabled)
3. `.atlcliignore`
4. Config file ignores
5. Command-line `--ignore` flags
6. Negation patterns (`!pattern`)

Later patterns can override earlier ones, except for default ignores.

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

## Debugging

Verbose output shows ignore processing:

```bash
atlcli wiki docs pull ./docs --verbose
```

```
[ignore] Checking: drafts/new-feature.md
[ignore]   Matched: drafts/ (.atlcliignore:3)
[ignore]   Result: IGNORED
[ignore] Checking: api-reference.md
[ignore]   No matches
[ignore]   Result: INCLUDED
```

## Validate Patterns

Test your ignore patterns:

```bash
# Check if a specific file would be ignored
atlcli wiki docs ignore-check ./docs "drafts/test.md"
# Output: IGNORED (matched: drafts/ in .atlcliignore:3)

atlcli wiki docs ignore-check ./docs "api-reference.md"
# Output: INCLUDED
```

## Related Topics

- [Sync](sync.md) - Sync configuration and behavior
- [File Format](file-format.md) - Directory structure conventions
- [Configuration](../configuration.md) - Global ignore settings
