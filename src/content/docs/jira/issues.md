---
title: "Issues"
description: "Issues - atlcli documentation"
---

# Issues

Create, read, update, and delete Jira issues.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Jira permission**: Browse Projects for read, Edit Issues for write operations

## Get Issue

```bash
atlcli jira issue get --key PROJ-123
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--expand` | Expand: `changelog`, `comments`, `transitions` |
| `--format` | `json` (default) or `markdown`: a YAML front block plus the description as markdown |

### Examples

```bash
# Get issue with changelog
atlcli jira issue get --key PROJ-123 --expand changelog

# JSON output (includes descriptionMarkdown next to the raw ADF description)
atlcli jira issue get --key PROJ-123 --json

# Edit the description in your editor and write it back
atlcli jira issue get --key PROJ-123 --json | jq -r .issue.descriptionMarkdown > desc.md
$EDITOR desc.md
atlcli jira issue update --key PROJ-123 --description-file desc.md

# Same, keeping the key/summary/status header for context
atlcli jira issue get --key PROJ-123 --format markdown > desc.md
$EDITOR desc.md
atlcli jira issue update --key PROJ-123 --description-file desc.md
```

`--description-file` ignores the `---` header that `--format markdown` writes, so the header never ends up in the description. Edit the summary or status with their own flags.

## Markdown descriptions and comments

Descriptions, comments and worklog comments are written and read as markdown. atlcli converts them to and from Jira's rich-text format (ADF), using the same markdown dialect as Confluence sync.

| Markdown | Jira result |
|----------|-------------|
| `# Heading` … `######` | Heading 1–6 |
| `**bold**`, `*italic*`, `~~strike~~`, `` `code` `` | Text formatting |
| `[text](https://…)` | Link |
| `-` / `1.` lists, nested by indentation | Bullet / numbered list |
| `- [ ] open` / `- [x] done` | Action items (task list) |
| ```` ```ts ```` fenced code | Code block with language |
| GFM table with a header row | Table |
| `> quote`, `---` | Quote, divider |
| `@[Jane Doe](557058:abc…)` | Mention (account ID required) |
| `{jira:PROJ-123}` or a bare `…/browse/PROJ-123` URL | Issue smart link |
| `<https://…>` | Smart link |
| `{date:2026-12-31}` | Date |
| `{status:green}Done{status}` | Status lozenge (`grey`, `blue`, `green`, `yellow`, `red`, `purple`) |
| `:smile:` | Emoji |
| `:::info` / `:::note` / `:::warning` / `:::error` / `:::success` (`:::tip` = success) | Panel |
| `:::expand Title` | Expand |

### What markdown cannot hold

| Jira content | In markdown | Written back |
|--------------|-------------|--------------|
| Images and attachments, macros/extensions, layouts, tables without a header row or with merged cells | An invisible `<!--adf:…-->` marker | Unchanged. Leave the marker in place when editing. |
| Text colour, underline, sub/superscript | Text only | The formatting is lost |
| Card or embed appearance of a smart link | `<url>` | Becomes an inline smart link |
| Local images such as `![shot](./a.png)` | — | Kept as a link, with a warning. Upload the file with `jira issue attach`. |

:::note[Data Center]
Jira Data Center's API takes plain strings, not ADF. On Data Center atlcli sends your markdown text unchanged, so it shows up as typed.
:::

:::caution[Behaviour change]
`--description` and comment text used to be sent as one plain paragraph. They are now markdown, so `*`, `_`, `#` and backticks format text. Escape them with `\` if you mean the literal character.
:::

## Create Issue

```bash
atlcli jira issue create --project PROJ --type Task --summary "Fix login bug"
```

Options:

| Flag | Description |
|------|-------------|
| `--project` | Project key (required) |
| `--type` | Issue type (required) |
| `--summary` | Issue summary (required) |
| `--description` | Issue description (markdown) |
| `--description-file` | Read the description from a markdown file, or `-` for stdin. Not together with `--description`. |
| `--assignee` | Assignee account ID |
| `--priority` | Priority name |
| `--labels` | Comma-separated labels |
| `--parent` | Parent issue key (for subtasks) |
| `--field` | Set a custom field — `<id>=<value>`, repeatable |

### Examples

```bash
# Create with full details
atlcli jira issue create --project PROJ --type Bug \
  --summary "Login fails on mobile" \
  --description "Users report 500 error on iOS Safari" \
  --priority High \
  --labels bug,mobile,urgent

# Create and assign
atlcli jira issue create --project PROJ --type Task \
  --summary "Update docs" \
  --assignee 557058:abc123

# Description from a markdown file
atlcli jira issue create --project PROJ --type Bug \
  --summary "Export drops tables" --description-file bug.md

# Description from stdin
printf '## Steps\n\n1. Open export\n2. Pick PDF\n' | \
  atlcli jira issue create --project PROJ --type Bug --summary "Export" --description-file -
```

:::tip[Adding to Epics or Sprints]
Use `atlcli jira epic add` or `atlcli jira sprint add` after creating the issue. For templates, use `atlcli jira template apply`.

:::

## Custom Fields

Use `--field <id>=<value>` to set custom fields when creating or updating issues. The flag can be repeated for multiple fields.

```bash
atlcli jira issue create --project PROJ --type Story --summary "My story" \
  --field customfield_10028=5 \
  --field customfield_10077='{"value":"Feature"}' \
  --field customfield_10194="As a user I want to..."

atlcli jira issue update --key PROJ-123 \
  --field customfield_10028=8 \
  --field customfield_10079=3
```

### Value Type Coercion

Values are automatically coerced to the correct type:

| Input | Resulting type | Example |
|-------|----------------|---------|
| Numeric string | `number` | `--field customfield_10028=5` |
| `null` | `null` | `--field customfield_10028=null` |
| Valid JSON | Parsed value | `--field customfield_10077='{"value":"Bug"}'` |
| Everything else | `string` | `--field customfield_10194="Some text"` |

Use JSON syntax for Jira option, multi-select, and array fields:

```bash
# Single select (option)
--field customfield_10077='{"value":"Feature"}'

# Multi-select (array of options)
--field customfield_10195='[{"value":"Goal A"},{"value":"Goal B"}]'

# User field
--field customfield_10050='{"accountId":"557058:abc123"}'
```

### Finding Field IDs

Use `atlcli jira field search` to look up the ID for a custom field:

```bash
atlcli jira field search "story points"
atlcli jira field options customfield_10077   # list allowed option values
```

:::note[Field availability]
Custom fields must be on the issue's create or edit screen in Jira. If you receive a "field cannot be set" error, the field is not configured for that issue type or project screen.

:::

## Update Issue

```bash
atlcli jira issue update --key PROJ-123 --summary "Updated summary"
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--summary` | New summary |
| `--description` | New description (markdown) |
| `--description-file` | New description from a markdown file, or `-` for stdin |
| `--priority` | New priority |
| `--add-labels` | Add labels (comma-separated) |
| `--remove-labels` | Remove labels (comma-separated) |
| `--assignee` | New assignee (account ID or `none` to unassign) |
| `--field` | Set a custom field — `<id>=<value>`, repeatable |

### Examples

```bash
# Update multiple fields
atlcli jira issue update --key PROJ-123 \
  --summary "New summary" \
  --priority Critical

# Modify labels
atlcli jira issue update --key PROJ-123 --add-labels reviewed,verified

# Unassign issue
atlcli jira issue update --key PROJ-123 --assignee none
```

## Delete Issue

```bash
atlcli jira issue delete --key PROJ-123 --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--confirm` | Skip confirmation prompt |
| `--delete-subtasks` | Also delete subtasks |

## Transitions

Change issue status:

```bash
atlcli jira issue transition --key PROJ-123 --to "In Progress"
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--to` | Target status name (required) |

### List Available Transitions

```bash
atlcli jira issue transitions --key PROJ-123
```

Output:

```
ID    NAME           TO STATUS
21    Start          In Progress
31    Done           Done
41    Review         In Review
```

## Comments

Comment bodies are markdown (see [Markdown descriptions and comments](#markdown-descriptions-and-comments)).

```bash
# Add a comment (positional text, --body or --body-file)
atlcli jira issue comment --key PROJ-123 "Working on **this**"
atlcli jira issue comments add --key PROJ-123 --body-file notes.md

# List comments as JSON (bodies converted to markdown) or as readable markdown
atlcli jira issue comments list --key PROJ-123 --json
atlcli jira issue comments list --key PROJ-123 --format markdown

# Edit and delete by comment id
atlcli jira issue comments edit --key PROJ-123 --id 10042 --body "Fixed in **v2**"
atlcli jira issue comments delete --key PROJ-123 --id 10042 --confirm
```

| Command | Required flags | Notes |
|---------|----------------|-------|
| `comment` / `comments add` | `--key`, one of text / `--body` / `--body-file` | `--body-file -` reads stdin |
| `comments list` | `--key` | `--limit` (default 100), `--format markdown` |
| `comments edit` | `--key`, `--id`, `--body` or `--body-file` | Replaces the whole body |
| `comments delete` | `--key`, `--id`, `--confirm` | |

## History

Show who changed which field, newest first:

```bash
atlcli jira issue history --key PROJ-123
atlcli jira issue history --key PROJ-123 --field status --limit 20 --json
```

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--field` | Only changes to this field (for example `status`, `assignee`, `summary`) |
| `--limit` | Maximum rows (default 100) |

Unlike `issue get --expand changelog`, `history` pages through the full change history.

## Links

```bash
# Link issues
atlcli jira issue link --from PROJ-123 --to PROJ-456 --type "blocks"
```

Options:

| Flag | Description |
|------|-------------|
| `--from` | Source issue key (required) |
| `--to` | Target issue key (required) |
| `--type` | Link type name (required) |

### Remove a Link

```bash
# By link id (from issue get --json, fields.issuelinks)
atlcli jira issue unlink --link 69875

# By the two issues; --type picks one when several links exist
atlcli jira issue unlink --from PROJ-123 --to PROJ-456 --type blocks --confirm
```

When the link is found by `--from`/`--to`, atlcli shows which link it would remove and needs `--confirm`. If several links connect the two issues, it lists them and asks for `--type` or `--link`.

### Link Types

Common link types:

| Type | Description |
|------|-------------|
| `blocks` | This issue blocks another |
| `is blocked by` | This issue is blocked by another |
| `duplicates` | This issue duplicates another |
| `relates to` | General relation |
| `clones` | This issue clones another |

## Watchers

Watcher commands are top-level jira commands:

```bash
# List watchers
atlcli jira watchers PROJ-123

# Add yourself as watcher
atlcli jira watch PROJ-123

# Remove yourself
atlcli jira unwatch PROJ-123
```

## Assign

```bash
# Assign to user
atlcli jira issue assign --key PROJ-123 --assignee alice@company.com

# Unassign
atlcli jira issue assign --key PROJ-123 --assignee none
```

## Cross-Product Linking

Link Jira issues to Confluence pages for bidirectional traceability.

### Link Page to Issue

```bash
atlcli jira issue link-page --key PROJ-123 --page 12345
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--page` | Confluence page ID (required) |

### List Linked Pages

```bash
atlcli jira issue pages --key PROJ-123
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--space` | Filter by Confluence space |

### Unlink Page

```bash
atlcli jira issue unlink-page --key PROJ-123 --page 12345
```

### Examples

```bash
# Link a Confluence page to an issue
atlcli jira issue link-page --key PROJ-123 --page 12345

# List all Confluence pages linked to an issue
atlcli jira issue pages --key PROJ-123

# Filter by space
atlcli jira issue pages --key PROJ-123 --space TEAM

# Remove link
atlcli jira issue unlink-page --key PROJ-123 --page 12345
```

## JSON Output

All commands support `--json`:

```bash
atlcli jira issue get --key PROJ-123 --json
```

```json
{
  "schemaVersion": "1",
  "key": "PROJ-123",
  "id": "10001",
  "summary": "Fix login bug",
  "status": {
    "name": "In Progress",
    "category": "indeterminate"
  },
  "priority": {
    "name": "High",
    "iconUrl": "..."
  },
  "assignee": {
    "displayName": "Alice",
    "emailAddress": "alice@company.com"
  },
  "reporter": {
    "displayName": "Bob",
    "emailAddress": "bob@company.com"
  },
  "created": "2025-01-14T10:00:00Z",
  "updated": "2025-01-14T15:30:00Z",
  "labels": ["bug", "critical"],
  "url": "https://company.atlassian.net/browse/PROJ-123"
}
```

## Related Topics

- [Search](search.md) - Find issues with JQL
- [Bulk Operations](bulk-operations.md) - Update multiple issues
- [Subtasks](subtasks.md) - Break down issues into subtasks
- [Epics](epics.md) - Organize issues into epics
