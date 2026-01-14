# Comments

Manage Confluence page comments - footer comments, inline comments, replies, and resolution.

## Overview

Confluence supports two types of comments:

- **Footer comments** - Appear at the bottom of the page
- **Inline comments** - Attached to specific text selections

atlcli fully supports both types with CRUD operations.

## Footer Comments

### List Comments

```bash
atlcli wiki page comments list --id 12345
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Page ID (required) |
| `--format` | Output format: `table`, `json` |

### Add Comment

```bash
# Using positional argument
atlcli wiki page comments add --id 12345 "Great documentation!"

# From a file
atlcli wiki page comments add --id 12345 --file ./comment.txt
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Page ID (required) |
| `--file` | Read comment text from file |

### Reply to Comment

```bash
atlcli wiki page comments reply --id 12345 --parent 67890 "Thanks for the feedback!"
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Page ID |
| `--parent` | Parent comment ID to reply to |
| `--file` | Read reply text from file |

## Inline Comments

Inline comments are attached to specific text in the page content.

### List Inline Comments

```bash
atlcli wiki page comments list --id 12345 --inline
```

### Add Inline Comment

```bash
# Match text in page and attach comment
atlcli wiki page comments add-inline --id 12345 --selection "text to match" "Consider rewording this"

# If text appears multiple times, use --match-index
atlcli wiki page comments add-inline --id 12345 --selection "common phrase" --match-index 2 "Comment on third occurrence"
```

Options:

| Flag | Description |
|------|-------------|
| `--id` | Page ID |
| `--selection` | Text string to match in page content |
| `--match-index` | Which occurrence to match (0-indexed, default: 0) |
| `--file` | Read comment text from file |

!!! tip "Text Matching"
    The `--selection` option matches the exact text string in the page. If your target text appears multiple times, use `--match-index` to specify which occurrence (0 = first, 1 = second, etc.).

## Comment Resolution

Mark comments as resolved (for review workflows):

```bash
# Resolve a footer comment
atlcli wiki page comments resolve --comment 67890

# Resolve an inline comment (specify type)
atlcli wiki page comments resolve --comment 67890 --type inline

# Reopen a resolved comment
atlcli wiki page comments reopen --comment 67890
```

Options:

| Flag | Description |
|------|-------------|
| `--comment` | Comment ID |
| `--type` | Comment type: `footer` (default), `inline` |

## Delete Comment

```bash
# Delete footer comment
atlcli wiki page comments delete --comment 67890 --confirm

# Delete inline comment
atlcli wiki page comments delete --comment 67890 --type inline --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--comment` | Comment ID |
| `--type` | Comment type: `footer` (default), `inline` |
| `--confirm` | Skip confirmation prompt |

## Sync Behavior

During `docs pull` and `docs push`:

- Comments are **not** synced by default (they're metadata, not content)
- Use `--include-comments` to export comments alongside pages
- Comment IDs are preserved in a `.comments.json` sidecar file when exported

### Export with Comments

```bash
atlcli wiki docs pull ./docs --include-comments
```

Creates files like:

```
docs/
├── my-page.md
└── my-page.comments.json
```

### Comments File Format

```json
{
  "pageId": "12345",
  "comments": [
    {
      "id": "67890",
      "type": "footer",
      "body": "Great documentation!",
      "author": "alice@company.com",
      "created": "2025-01-14T10:00:00Z",
      "resolved": false,
      "replies": []
    }
  ]
}
```

## JSON Output

All comment commands support `--json` for scripting:

```bash
atlcli wiki page comments list --id 12345 --json
```

```json
{
  "schemaVersion": "1",
  "comments": [
    {
      "id": "67890",
      "type": "footer",
      "body": "Great documentation!",
      "author": {
        "displayName": "Alice",
        "email": "alice@company.com"
      },
      "created": "2025-01-14T10:00:00Z",
      "resolved": false,
      "replies": []
    }
  ],
  "total": 1
}
```

## Use Cases

### Code Review Workflow

```bash
# List unresolved comments
atlcli wiki page comments list --id 12345 --json | jq '.comments[] | select(.resolved == false)'

# Resolve after addressing
atlcli wiki page comments resolve --comment 67890
```

### Bulk Comment Export

```bash
# Export all comments from a space
for page in $(atlcli wiki page list --space TEAM --json | jq -r '.pages[].id'); do
  atlcli wiki page comments list --id $page --json > "comments-$page.json"
done
```

### Find Pages with Unresolved Comments

```bash
# Check each page for unresolved comments
for page in $(atlcli wiki page list --space TEAM --json | jq -r '.pages[].id'); do
  COUNT=$(atlcli wiki page comments list --id $page --json | jq '[.comments[] | select(.resolved == false)] | length')
  if [ "$COUNT" -gt 0 ]; then
    echo "Page $page has $COUNT unresolved comments"
  fi
done
```
