# Validation

Validate Confluence pages before pushing to catch errors early.

## Overview

atlcli can validate your local markdown files to detect issues before pushing to Confluence:

- Broken internal links
- Invalid macro syntax
- Page size limits
- Missing required frontmatter
- Orphaned pages

## Validate Command

Run validation on a sync directory:

```bash
atlcli wiki docs validate ./docs
```

Output:

```
Validating 24 files...

ERRORS (2):
  getting-started.md:45 - Broken link: [Setup Guide](./setup.md) - file not found
  api-reference.md:12 - Invalid macro: ::: unknown-macro - unrecognized macro type

WARNINGS (3):
  large-guide.md - Page size 485 KB (limit: 500 KB) - consider splitting
  old-docs/legacy.md - Orphaned: not linked from any page
  config.md:78 - Deprecated macro: ::: note - use ::: info instead

Validation complete: 2 errors, 3 warnings
```

Options:

| Flag | Description |
|------|-------------|
| `--fix` | Auto-fix issues where possible |
| `--strict` | Treat warnings as errors |
| `--ignore` | Patterns to ignore |
| `--format` | Output format: `text`, `json` |

## Validation Rules

### Link Validation

Checks all internal links resolve to existing files:

```markdown
[Valid Link](./existing-page.md)     ✓
[Broken Link](./missing-page.md)     ✗ File not found
[Anchor Link](./page.md#section)     ✓ (if section exists)
```

Configure link checking:

```bash
# Skip external link validation
atlcli wiki docs validate ./docs --skip-external

# Check external links too (slower)
atlcli wiki docs validate ./docs --check-external
```

### Macro Validation

Validates macro syntax and parameters:

```markdown
::: info                             ✓ Valid panel
::: info "Title"                     ✓ Valid panel with title
::: unknown                          ✗ Unknown macro type
::: expand                           ✗ Missing required title
::: toc minLevel=abc                 ✗ Invalid parameter value
```

### Size Validation

Checks page content size against limits:

| Check | Default Limit |
|-------|---------------|
| Page content | 500 KB |
| Single code block | 100 KB |
| Total attachments | 10 MB |

Configure limits:

```bash
atlcli wiki docs validate ./docs --max-page-size 1MB --max-code-block 200KB
```

### Folder Validation

Checks folder structure for issues:

| Code | Severity | Description |
|------|----------|-------------|
| `FOLDER_EMPTY` | Warning | Folder index.md exists but has no child pages or subfolders |
| `FOLDER_MISSING_INDEX` | Warning | Directory contains .md files but has no index.md |

```
WARNINGS (2):
  empty-folder/index.md:1 - Folder "Empty" has no children [FOLDER_EMPTY]
  orphan-dir - Directory "orphan-dir" contains pages but has no folder index.md [FOLDER_MISSING_INDEX]
```

**FOLDER_EMPTY**: A folder exists in Confluence but has no content. Consider adding pages or removing the empty folder.

**FOLDER_MISSING_INDEX**: A local directory contains markdown files but isn't a synced Confluence folder. Either:
- Create an index.md with `type: folder` to make it a folder
- Move the files to an existing folder
- This may indicate pages that were moved but the folder wasn't synced

### Frontmatter Validation

Checks required YAML frontmatter:

```yaml
---
id: "12345"        # Required for existing pages
title: "Page Title" # Required
space: "TEAM"       # Optional, inherited from config
---
```

### Orphan Detection

Finds pages not linked from any other page:

```bash
atlcli wiki docs validate ./docs --check-orphans
```

## Auto-Fix

Some issues can be automatically fixed:

```bash
atlcli wiki docs validate ./docs --fix
```

Auto-fixable issues:

| Issue | Fix |
|-------|-----|
| Deprecated macro | Replace with current equivalent |
| Missing frontmatter title | Extract from first heading |
| Relative link case mismatch | Correct case |
| Trailing whitespace in links | Trim |

## Strict Mode

Fail on any issue (useful in CI):

```bash
atlcli wiki docs validate ./docs --strict
```

Exit codes:
- `0` - No errors
- `1` - Errors found
- `2` - Warnings found (in strict mode)

## Ignore Patterns

Skip certain files or rules:

```bash
# Ignore drafts folder
atlcli wiki docs validate ./docs --ignore "drafts/**"

# Ignore specific rules
atlcli wiki docs validate ./docs --ignore-rules orphan,deprecated-macro
```

Or configure in `.atlcli/config.json`:

```json
{
  "validation": {
    "ignore": ["drafts/**", "*.draft.md"],
    "ignoreRules": ["orphan"],
    "maxPageSize": "1MB"
  }
}
```

## JSON Output

```bash
atlcli wiki docs validate ./docs --json
```

```json
{
  "schemaVersion": "1",
  "valid": false,
  "files": 24,
  "errors": [
    {
      "file": "getting-started.md",
      "line": 45,
      "rule": "broken-link",
      "message": "Broken link: [Setup Guide](./setup.md) - file not found",
      "severity": "error"
    }
  ],
  "warnings": [
    {
      "file": "large-guide.md",
      "rule": "page-size",
      "message": "Page size 485 KB approaching limit (500 KB)",
      "severity": "warning"
    }
  ],
  "summary": {
    "errors": 2,
    "warnings": 3
  }
}
```

## Pre-Push Hook

Validate before pushing:

```bash
# In package.json or git hooks
atlcli wiki docs validate ./docs --strict && atlcli wiki docs push ./docs
```

## CI Integration

### GitHub Actions

```yaml
- name: Validate Confluence docs
  run: |
    atlcli wiki docs validate ./docs --strict --json > validation.json
    if [ $? -ne 0 ]; then
      echo "::error::Documentation validation failed"
      cat validation.json | jq -r '.errors[] | "::error file=\(.file),line=\(.line)::\(.message)"'
      exit 1
    fi
```

### GitLab CI

```yaml
validate-docs:
  script:
    - atlcli wiki docs validate ./docs --strict
  allow_failure: false
```

## Use Cases

### Pre-Commit Validation

```bash
# .git/hooks/pre-commit
#!/bin/bash
if git diff --cached --name-only | grep -q "^docs/"; then
  atlcli wiki docs validate ./docs --strict
fi
```

### Find All Issues

```bash
# Get complete report
atlcli wiki docs validate ./docs --json | jq '.errors + .warnings | sort_by(.file)'
```

### Validate Single File

```bash
# Check specific file
atlcli wiki docs validate ./docs/api-reference.md
```
