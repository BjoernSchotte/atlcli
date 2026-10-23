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
| `--expand` | Comma-separated Jira expands, e.g. `changelog`, `renderedFields`, `names`, `transitions`. JSON output puts each one next to `issue` as Jira returns it (`changelog`, `renderedFields`, …); the text view adds `changelog` as a **History** section; the markdown view stays description-only and notes the rest on stderr |
| `--format` | `text` (default): a readable view; `json`; or `markdown`: a YAML front block plus the description as markdown |

Without `--json`, the issue prints as a readable view: fields, the description as markdown, links and the last three comments.

```
PROJ-123  Login fails on Safari

Status    In Progress
Type      Bug
Priority  High
Assignee  Ann Lee
Reporter  Bob Stone
Labels    mobile, urgent
Created   2026-10-01
Updated   2026-10-20
URL       https://example.atlassian.net/browse/PROJ-123

Description
  Users report a 500 error on iOS Safari.

Links (1)
  blocks PROJ-130  [To Do]  Release 2.4

Comments (last 3 of 5)
  Ann Lee · 2026-10-20
  Fixed in **v2**, please retest.
```

Content kept only for round trips (`<!--adf:…-->` markers) shows as `[…]` in this view. `--json` or `--format json` gives the JSON below.

### Examples

```bash
# Get issue with changelog
atlcli jira issue get --key PROJ-123 --expand changelog

# JSON output (includes descriptionMarkdown next to the raw ADF description)
atlcli jira issue get --key PROJ-123 --json

# Edit the description in $VISUAL/$EDITOR and write it back
atlcli jira issue update --key PROJ-123 --edit

# The same by hand, for scripts
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
| `@[Jane Doe](557058:abc…)` | Mention (account ID required; escape brackets in a name: `@[Max \[extern\]](…)`) |
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
| `--edit` | Write the description in `$VISUAL`/`$EDITOR` (needs a terminal) |
| `--assignee` | Assignee: `me`, an email, a name or an account ID (see [Users](#users)) |
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
  --assignee alice@example.com

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
| `--edit` | Edit the current description in `$VISUAL`/`$EDITOR`; nothing is written if it is unchanged |
| `--priority` | New priority |
| `--add-labels` | Add labels (comma-separated) |
| `--remove-labels` | Remove labels (comma-separated) |
| `--assignee` | New assignee (see [Users](#users)); `none` or `x` unassigns |
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

## Clone Issue

Create a copy of an issue:

```bash
atlcli jira issue clone PROJ-123
atlcli jira issue clone PROJ-123 --replace "v1:v2" --replace "Q3:Q4"
atlcli jira issue clone PROJ-123 --project OTHER --assignee me
```

The clone gets the source's summary, description, type and labels. In the same project it also gets the components and the parent. Priority, assignee, sprint, versions and custom fields are not copied: they may not fit the target project.

| Flag | Description |
|------|-------------|
| `--replace` | `find:replace` in summary and description, repeatable; split at the first colon |
| `--summary` | Summary instead of the source's (replacements still apply) |
| `--project` | Target project (default: the source's) |
| `--type` | Issue type (default: the source's) |
| `--priority` | Priority |
| `--labels` | Labels instead of the source's |
| `--parent` | Parent issue key |
| `--assignee` | Assignee (see [Users](#users)) |

## Delete Issue

```bash
atlcli jira issue delete --key PROJ-123 --confirm
```

Options:

| Flag | Description |
|------|-------------|
| `--key` | Issue key (required) |
| `--confirm` | Required to delete |
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

Output (Jira's transition objects, shortened):

```json
{
  "schemaVersion": "1",
  "transitions": [
    { "id": "21", "name": "Start", "to": { "id": "3", "name": "In Progress" } },
    { "id": "31", "name": "Done", "to": { "id": "10001", "name": "Done" } }
  ]
}
```

## Comments

Comment bodies are markdown (see [Markdown descriptions and comments](#markdown-descriptions-and-comments)).

```bash
# Add a comment (positional text, --body, --body-file or --edit)
atlcli jira issue comment --key PROJ-123 "Working on **this**"
atlcli jira issue comments add --key PROJ-123 --body-file notes.md
atlcli jira issue comments add --key PROJ-123 --edit

# Internal comment, hidden from customers (Jira Service Management)
atlcli jira issue comments add --key DESK-7 "Escalated to 2nd level" --internal

# List comments as JSON (bodies converted to markdown) or as readable markdown
atlcli jira issue comments list --key PROJ-123 --json
atlcli jira issue comments list --key PROJ-123 --format markdown

# Edit and delete by comment id
atlcli jira issue comments edit --key PROJ-123 --id 10042 --body "Fixed in **v2**"
atlcli jira issue comments delete --key PROJ-123 --id 10042 --confirm
```

| Command | Required flags | Notes |
|---------|----------------|-------|
| `comment` / `comments add` | `--key`, one of text / `--body` / `--body-file` / `--edit` | `--body-file -` reads stdin; `--internal` for JSM |
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

### Web Links

Attach a URL to an issue (Jira shows it under **Web links**):

```bash
atlcli jira issue link --key PROJ-123 --url https://example.com/spec --title "Spec"

# Remove it by the link id from the output above
atlcli jira issue unlink --key PROJ-123 --remote 10500
```

`--title` defaults to the URL. For Confluence pages, use [link-page](#cross-product-linking).

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
# Assign to a user, or to yourself
atlcli jira issue assign --key PROJ-123 --assignee alice@company.com
atlcli jira issue assign --key PROJ-123 --assignee me

# The project's default assignee
atlcli jira issue assign --key PROJ-123 --assignee default

# Unassign
atlcli jira issue assign --key PROJ-123 --assignee none
```

## Users

Every flag that takes a user (`--assignee` on create, update, assign, clone, `subtask create`, `template apply` and `bulk edit --set assignee=`, `--lead` on components and projects, `--user` on `filter share`) accepts:

| Value | Meaning |
|-------|---------|
| `me` | You |
| `alice@example.com` | The user with that email |
| `Alice Lee` | The user with that display name |
| `557058:1b2c…` | An account ID, used as is (Jira Cloud) |
| `none`, `x` | Nobody (unassign) |
| `default` | The project's default assignee (`issue assign` only) |

atlcli looks the user up with Jira's user search. An exact email or display name wins; otherwise the only active hit. If several users match, the command fails and lists them; use the email or the account ID. Jira hides some emails, depending on each user's profile visibility; then use the name.

On Data Center, `--lead` (components, projects) and `template apply --assignee` need a Cloud account ID, so atlcli leaves them unset there.

## Open in the Browser

```bash
atlcli jira open PROJ-123   # an issue
atlcli jira open PROJ       # a project
atlcli jira open            # defaults.project, or the site
```

The URL is printed first, so it also works over SSH. `atlcli jira issue open <key>` does the same for an issue.

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
| `--comment [text]` | Also post a comment on the issue: bare, "Linked to Confluence page: <link>"; with text, that text as Markdown |

### List Linked Pages

```bash
atlcli jira issue pages --key PROJ-123
```

Prints `{schemaVersion, issueKey, pages, total}`; each page has `id` (the link ID), `globalId`, `title`, `url` and `summary`.

### Unlink Page

```bash
# By Confluence page ID
atlcli jira issue unlink-page --key PROJ-123 --page 12345

# By link ID (the id from issue pages)
atlcli jira issue unlink-page --key PROJ-123 --link 10500
```

`unlink-page` needs `--key` and one of `--link <id>` or `--page <id>`.

### Examples

```bash
# Link a Confluence page to an issue
atlcli jira issue link-page --key PROJ-123 --page 12345

# Link it and leave a comment on the issue
atlcli jira issue link-page --key PROJ-123 --page 12345 --comment

# List all Confluence pages linked to an issue
atlcli jira issue pages --key PROJ-123

# Remove link
atlcli jira issue unlink-page --key PROJ-123 --page 12345
```

## JSON Output

Without `--json`, `issue get` prints a readable view and issue lists (`search`, `my`, `filter run`, board, sprint and epic issue lists) print a table; see [Search](search.md). Other issue commands print pretty JSON either way. With `--json`, every command prints JSON, errors included (see [Errors](#errors)).

```bash
atlcli jira issue get --key PROJ-123 --json
```

```json
{
  "schemaVersion": "1",
  "issue": {
    "id": "10001",
    "key": "PROJ-123",
    "summary": "Fix login bug",
    "status": "In Progress",
    "statusCategory": "indeterminate",
    "type": "Bug",
    "priority": "High",
    "assignee": "Alice Lee",
    "assigneeId": "557058:1b2c3d4e",
    "reporter": "Bob Kim",
    "created": "2025-01-14T10:00:00.000+0000",
    "updated": "2025-01-14T15:30:00.000+0000",
    "labels": ["bug", "critical"],
    "parent": "PROJ-100",
    "description": { "type": "doc", "version": 1, "content": [] },
    "descriptionMarkdown": "Users report a 500 error on iOS Safari."
  }
}
```

`description` is the raw value from Jira (ADF on Cloud, a string on Data Center); `descriptionMarkdown` is the same content as markdown.

## Errors

With `--json`, a failed command prints one error object on stdout and exits with code 1:

```json
{
  "error": {
    "code": "ATLCLI_ERR_NOT_FOUND",
    "message": "Jira API error (404): Not Found (response body omitted: logBody policy)",
    "details": { "status": 404 }
  }
}
```

| Code | Meaning |
|------|---------|
| `ATLCLI_ERR_USAGE` | Wrong or missing flags |
| `ATLCLI_ERR_AUTH` | Not logged in, or the token was rejected (401) |
| `ATLCLI_ERR_FORBIDDEN` | No permission (403) |
| `ATLCLI_ERR_NOT_FOUND` | Does not exist, or you cannot see it (404) |
| `ATLCLI_ERR_RATE_LIMIT` | Too many requests (429) |
| `ATLCLI_ERR_API` | Any other API error; `details.status` holds the HTTP status |

Without `--json`, the message goes to stderr.

## Related Topics

- [Search](search.md) - Find issues with JQL
- [Bulk Operations](bulk-operations.md) - Update multiple issues
- [Subtasks](subtasks.md) - Break down issues into subtasks
- [Epics](epics.md) - Organize issues into epics
