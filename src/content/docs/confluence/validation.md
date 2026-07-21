---
title: "Validation"
description: "Validation - atlcli documentation"
---

# Validation

Validate Confluence pages before pushing to catch errors early.

## Prerequisites

- Initialized sync directory with `.atlcli/` folder
- Local markdown files to validate

## Overview

atlcli validates your local markdown files to detect issues before pushing to Confluence:

- Broken internal links
- Unclosed macro blocks
- Page size warnings
- Folder structure issues

## Check Command

Run validation on a sync directory:

```bash
atlcli wiki docs check ./docs
```

Output:

```
Checking 24 files...

getting-started.md
  line 45: ERROR - Broken link to "./setup.md" [LINK_FILE_NOT_FOUND]

api-reference.md
  line 12: ERROR - Unclosed macro ":::info" starting at line 12 [MACRO_UNCLOSED]

large-guide.md
  WARNING - Page size (485KB) exceeds 500KB limit [PAGE_SIZE_EXCEEDED]

Summary: 2 errors, 1 warning in 3 files (21 passed)
```

### Options

| Flag | Description |
|------|-------------|
| `--dir <path>` | Directory or file to check (same as the positional path; use it when running from elsewhere) |
| `--strict` | Treat warnings as errors (exit code 1 for warnings) |
| `--json` | Output results as JSON |

The path argument and `--dir` are interchangeable:

```bash
cd /anywhere
atlcli wiki docs check --dir ~/work/docs --strict
```

:::caution[An empty check is a failure, not a pass]
If the resolved path contains no markdown files, `check` exits **1** with
"nothing was validated" rather than printing "0 errors" and exiting 0. A path
that does not exist fails the same way. This keeps a mistyped CI path from
turning into a green gate that validated nothing.
:::

## Validation Rules

### Link Validation

Checks that internal links resolve to existing files:

```markdown
[Valid Link](./existing-page.md)     ✓ File exists
[Broken Link](./missing-page.md)     ✗ LINK_FILE_NOT_FOUND
[Untracked](./new-page.md)           ⚠ LINK_UNTRACKED_PAGE (warning)
```

| Code | Severity | Description |
|------|----------|-------------|
| `LINK_FILE_NOT_FOUND` | Error | Target file does not exist |
| `LINK_UNTRACKED_PAGE` | Warning | Target file exists but has no page ID in frontmatter |

### Macro Validation

Checks that macro blocks are properly closed:

```markdown
::: info
This panel is properly closed.
:::                                   ✓ Valid

::: warning
This panel is never closed...         ✗ MACRO_UNCLOSED
```

| Code | Severity | Description |
|------|----------|-------------|
| `MACRO_UNCLOSED` | Error | Macro opened with `:::name` but no closing `:::` |

### Size Validation

Warns when page content exceeds 500KB:

| Code | Severity | Description |
|------|----------|-------------|
| `PAGE_SIZE_EXCEEDED` | Warning | Page content exceeds 500KB |

### Folder Validation

Checks folder structure for issues:

| Code | Severity | Description |
|------|----------|-------------|
| `FOLDER_EMPTY` | Warning | Folder index.md exists but has no child pages |
| `FOLDER_MISSING_INDEX` | Warning | Directory contains .md files but no index.md |

## Strict Mode

Use `--strict` to fail on warnings (useful in CI):

```bash
atlcli wiki docs check ./docs --strict
```

Exit codes:

- `0` - No errors (and no warnings in strict mode)
- `1` - Errors found (or warnings in strict mode), no files to validate, or path not found

## JSON Output

```bash
atlcli wiki docs check ./docs --json
```

`--json` writes **exactly one JSON document** to stdout, so `JSON.parse(stdout)`
always works. The human-readable report is never printed in this mode.

Minimal example — validation passed:

```json
{
  "schemaVersion": "1",
  "passed": true,
  "totalErrors": 0,
  "totalWarnings": 0,
  "filesChecked": 24,
  "filesWithIssues": 0,
  "files": []
}
```

When the command exits non-zero, the error is folded into the **same** document
as an `error` field rather than emitted as a second document:

```json
{
  "schemaVersion": "1",
  "passed": false,
  "totalErrors": 1,
  "totalWarnings": 0,
  "filesChecked": 24,
  "filesWithIssues": 1,
  "files": [
    {
      "path": "getting-started.md",
      "issues": [
        {
          "severity": "error",
          "code": "LINK_FILE_NOT_FOUND",
          "message": "Broken link to \"./setup.md\"",
          "file": "getting-started.md",
          "line": 45
        }
      ]
    }
  ],
  "error": {
    "code": "ATLCLI_ERR_VALIDATION",
    "message": "Validation failed",
    "details": {}
  }
}
```

:::caution[`passed` is not the exit code]
`passed` reports whether any **errors** were found, not the exit code. In
`--strict` mode a run with warnings only has `passed: true`, an `error` field,
and exit code `1`. Branch on the exit code (or on the presence of `error`), not
on `passed`.
:::

## Pre-Push Validation

Use the `--validate` flag with push to run checks before pushing:

```bash
atlcli wiki docs push ./docs --validate
atlcli wiki docs push ./docs --validate --strict  # Fail on warnings
atlcli wiki docs push ./docs/api.md --validate    # Validates that one file
atlcli wiki docs push --page-id 12345 --validate  # Validates the resolved file
```

`--validate` covers exactly the files being pushed, not the whole tree: a single
file for a file/`--page-id` push, and the collected (ignore-filtered) set for a
directory push. An unrelated file's errors will not block your push, and the
flag works outside an initialized directory too - it validates the named file
rather than silently doing nothing.

With `--json`, an aborted push emits a single error document carrying the same
issue list under `error.details`:

```json
{
  "error": {
    "code": "ATLCLI_ERR_VALIDATION",
    "message": "Validation failed - push aborted",
    "details": {
      "passed": false,
      "totalErrors": 1,
      "totalWarnings": 0,
      "filesChecked": 24,
      "filesWithIssues": 1,
      "files": [{ "path": "getting-started.md", "issues": [] }]
    }
  }
}
```

If the push proceeds despite warnings, the warnings are reported under a
`validation` field on the normal push result document.

## CI Integration

### GitHub Actions

```yaml
- name: Validate Confluence docs
  run: atlcli wiki docs check ./docs --strict
```

### GitLab CI

```yaml
validate-docs:
  script:
    - atlcli wiki docs check ./docs --strict
  allow_failure: false
```

## Examples

### Validate Before Commit

```bash
# .git/hooks/pre-commit
#!/bin/bash
if git diff --cached --name-only | grep -q "^docs/"; then
  atlcli wiki docs check ./docs --strict
fi
```

### Validate Single File

```bash
atlcli wiki docs check ./docs/api-reference.md
```

### Validate and Push

```bash
atlcli wiki docs check ./docs --strict && atlcli wiki docs push ./docs
```

## Related Topics

- [Sync](sync.md) - Run validation before push with `--validate`
- [Macros](macros.md) - Supported macro syntax
- [Audit](audit.md) - Content health analysis beyond validation
