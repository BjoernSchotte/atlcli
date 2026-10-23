---
name: jira-issues
description: Reading, creating, updating, transitioning, linking, and commenting on Jira issues, with Markdown descriptions and comments.
metadata:
  tags: jira, issues, markdown, comments, transitions, subtasks, attachments
---

# Jira issues

The issue lifecycle. Descriptions and comments are Markdown: atlcli converts
them to and from Jira's rich text (ADF) itself.

## Contents

- [Reading an issue](#reading-an-issue)
- [Creating an issue](#creating-an-issue)
- [Markdown descriptions and comments](#markdown-descriptions-and-comments)
- [Updating](#updating)
- [Transitions](#transitions)
- [Comments](#comments)
- [History](#history)
- [Subtasks](#subtasks)
- [Links and Confluence pages](#links-and-confluence-pages)
- [Attachments](#attachments)
- [Anti-patterns](#anti-patterns)

## Reading an issue

```bash
atlcli jira issue get --key PROJ-101 --json
atlcli jira issue get --key PROJ-101 --format markdown
```

`--id` is accepted as an alias for `--key`, and the key can also be the first
argument (`atlcli jira issue get PROJ-101`). Without `--json` or `--format`
the command prints a readable view. `--format markdown` prints a front block
(`key`, `summary`, `status`, `type`, `assignee`, `labels`) followed by the
description as Markdown. With `--json` (or `--format json`) the `--format`
value has no effect: the JSON response is flattened and carries the
description twice, as raw ADF in `description` and as Markdown in
`descriptionMarkdown`:

```json
{
  "schemaVersion": "1",
  "issue": {
    "id": "10123", "key": "PROJ-101",
    "summary": "…", "status": "To Do", "statusCategory": "new",
    "type": "Improvement", "priority": "Medium",
    "assignee": "Alex Rivera", "assigneeId": "5b10a2844c20165700ede21g",
    "reporter": "…", "created": "…", "updated": "…", "labels": [], "parent": "PROJ-100",
    "description": { "type": "doc", "version": 1, "content": [ … ] },
    "descriptionMarkdown": "…"
  }
}
```

Read the description from `descriptionMarkdown` or `--format markdown`, not
from the ADF.

`--expand <fields>` (for example `changelog`, `renderedFields`) is passed to
the Jira API, and with `--json` each expanded section appears as Jira sent it,
as a top-level key next to `issue`. The readable view shows only the changelog
(as History), and `--format markdown` shows none; both name the hidden
sections on stderr. `jira issue history` gives the changelog as flat rows.

## Creating an issue

```bash
atlcli jira issue create \
  --project PROJ --type Task \
  --summary 'Rotate the staging API token' \
  --description-file ./desc.md \
  --assignee 5b10a2844c20165700ede21g \
  --labels ops,security \
  --priority High \
  --json
```

`--project`, `--type`, and `--summary` are required (`--project` may come from
`global.project` in config). `--type` is the issue type **name**: resolve it
with `atlcli jira project types --key PROJ --json` rather than assuming `Task`
exists. `--assignee` takes `me`, an email, a display name or an account ID. A
name or email must match exactly one active user; several hits fail and list
the candidates, so use the email or account ID when a name is ambiguous.

`--parent <key>` places the new issue under an epic or parent issue. There is
no `--status` on `create`: creating and moving are two calls.

Custom fields go through `--field`, which is repeatable and coerces its value:
`null` becomes null, a numeric string becomes a number, valid JSON is parsed,
anything else stays a string:

```bash
atlcli jira issue create --project PROJ --type Bug --summary 'Login 500s' \
  --field customfield_10028=5 \
  --field customfield_10077='{"value":"Bug"}' \
  --json
```

Find field IDs with `atlcli jira field search "story point" --json`.

## Markdown descriptions and comments

`--description <md>` and `--description-file <path|->` (`-` reads stdin) take
Markdown on `create`, `update`, `subtask create` and `epic create`. Giving both
flags is a usage error. For anything longer than a line, write the text to a
file and pass `--description-file`, which avoids shell quoting.

Supported constructs:

| Markdown | Jira result |
|----------|-------------|
| `#` to `######` | Heading 1 to 6 |
| `**bold**`, `*italic*`, `~~strike~~`, `` `code` `` | Text marks |
| `<u>under</u>`, `H<sub>2</sub>O`, `x<sup>2</sup>` | Underline, subscript, superscript |
| `<span style="color: #ff5630">red</span>` | Text colour (a hex colour, exactly this form) |
| `[text](https://…)` | Link |
| `-` and `1.` lists, nested by indentation | Bullet and numbered list (a start number other than 1 is kept) |
| `- [ ] open`, `- [x] done` | Task list |
| fenced code block with optional language | Code block |
| GFM table | Table (first row becomes the header row) |
| `> quote`, `---` | Quote, rule |
| `@[Jane Doe](accountId)` | Mention (needs the account ID) |
| `{jira:PROJ-123}` | Smart link to the issue (a bare `/browse/PROJ-123` URL and `<https://…>` also become smart links) |
| `{date:2026-12-31}` | Date |
| `{status:green}Done{status}` | Status lozenge |
| `:smile:` | Emoji |
| `:::info`, `:::note`, `:::warning`, `:::error`, `:::success` (`:::tip` is success), closed by `:::` | Panel |
| `:::expand Title` … `:::` | Expand |

Behaviour to know:

- A single newline inside a paragraph becomes a space. Start a new paragraph
  with a blank line, or end the line with a backslash for a hard break.
- `:::` panels and expands are recognised at the top level only, outside code
  fences. One inside a list item is not converted.
- `*`, `_`, `#`, backticks, `{`, `<` and `~` format text. Escape them with `\`
  when a literal character is meant.
- A local image `![alt](./a.png)` becomes a link and prints a warning on
  stderr. Upload the file with `jira issue attach`.
- Raw HTML other than the underline, sub/superscript and colour tags above is
  kept as plain text, with a warning on stderr.
- Background colour and other marks without a Markdown form are dropped
  silently when a description is read as Markdown, and the rewrite loses them.
- Table cells that hold more than one block, merged cells, line breaks inside
  a cell, or a first row that is not all header cells do not fit a GFM table.
  They come back as a marker (below).

### Markers for content without a Markdown form

ADF nodes that Markdown cannot express are read as an `<!--adf:BASE64URL-->`
comment holding the node as JSON: media and attachments in the body, macros and
extensions, layouts, panels of a custom type, tables that do not fit GFM, and
any other unknown node. Writing the Markdown back decodes each marker into the
node it carries, so a `get --format markdown` then `update --description-file`
round trip keeps this content. Leave the markers in place when editing. A marker you
encode yourself (base64url of an ADF node's JSON) is inserted as that node.

### Edit a description

```bash
atlcli jira issue get --key PROJ-101 --format markdown > ./desc.md
# edit ./desc.md
atlcli jira issue update --key PROJ-101 --description-file ./desc.md --json
```

`--description-file` drops the front block that `--format markdown` writes, so
the edited file goes straight back. Change the summary, status and labels with
their own flags: edits to the front block are ignored.

### Verify the write

Read the description back and compare it with the source:

```bash
atlcli jira issue get --key PROJ-101 --format markdown
```

Cosmetic reflow is expected: `*` and `+` bullets come back as `-`, text is
re-escaped, and the table separator is written as `| --- |`. A marker that
appears where the source had none means Jira holds content the Markdown did not
describe. A list whose start number changed is a real difference.

### Data Center

On Data Center, atlcli sends the Markdown text unchanged as the description or
comment string, so no conversion happens and the text shows as typed.

## Updating

```bash
atlcli jira issue update --key PROJ-101 \
  --summary 'New summary' \
  --add-labels needs-review --remove-labels wip \
  --json
atlcli jira issue assign --key PROJ-101 --assignee none --json   # unassign
```

Labels are additive/subtractive here (`--add-labels`, `--remove-labels`),
unlike `jira bulk edit --set labels=a,b,c`, which replaces the whole set.
`--assignee none` clears the assignee, and `assign --assignee default` hands
the issue to the project's default assignee.

### Raw ADF

`--field description=<ADF JSON>` is parsed as JSON and sent as given, with no
Markdown conversion. It is the route for ADF that Markdown cannot describe,
such as background colour. On `create` it overrides `--description`. On
`update`, `--description` overrides it. Use one of the two per command, never
both.

## Transitions

Transition names are workflow **actions**, and they usually differ from the
status they produce. Always list first:

```bash
atlcli jira issue transitions --key PROJ-101 --json
atlcli jira issue transition --key PROJ-101 --to 'Start Progress' --json
```

`transitions[].name` is what `--to` takes (case-insensitive; the transition ID
also works); `transitions[].to.name` is the resulting status. Passing the
status name fails with the available actions listed, which reads like a
permissions problem but is not:

```
Transition "In Progress" not found. Available: Start Progress, Resolve Issue, Close Issue
```

## Comments

Comment bodies are Markdown, converted exactly like descriptions.

```bash
atlcli jira issue comments list --key PROJ-101 --json
atlcli jira issue comments list --key PROJ-101 --format markdown
atlcli jira issue comments add --key PROJ-101 --body-file ./comment.md --json
atlcli jira issue comments edit --key PROJ-101 --id 10042 --body-file ./comment.md --json
atlcli jira issue comments delete --key PROJ-101 --id 10042 --confirm --json
```

`comments list` returns `id`, `author`, `authorId`, `created`, `updated` and
`body` as Markdown, 100 comments by default (`--limit`). `--format markdown`
prints `## author · created · id <id>` headers and is ignored under `--json`.
`add` takes the text as a positional argument, `--body <md>` or
`--body-file <path|->`, one of the three. `edit` replaces the whole body and
takes `--body` or `--body-file`. `delete` needs `--confirm`.

`jira issue comment --key K '<text>'` is the same as `comments add`. The key
can also come first (`atlcli jira issue comment PROJ-101 'Done'`); every word
after it is comment text, so `atlcli jira issue comment --key PROJ-101 list`
posts a comment reading "list". Use `comments list`, with the plural, to read.

Comment writes are writes and need confirmation like any other.

## History

```bash
atlcli jira issue history --key PROJ-101 --json
atlcli jira issue history --key PROJ-101 --field status --limit 20 --json
```

Returns flattened changelog rows (`created`, `author`, `field`, `from`, `to`),
newest first, 100 by default. `--field` filters by field name.

## Subtasks

```bash
atlcli jira subtask create PROJ-101 --summary 'Write the migration' \
  --description-file ./desc.md --assignee 5b10a2844c20165700ede21g --json
atlcli jira subtask list PROJ-101 --json
```

The parent key is positional, and the subtask issue type is discovered from the
parent's project automatically. `subtask create` takes `--summary`,
`--description`, `--description-file`, `--assignee` and `--priority`. Like
`epic create`, it does not read `--field`: an unread flag is dropped without
error. Set custom fields afterwards with `jira issue update`.

## Links and Confluence pages

```bash
atlcli jira issue link --from PROJ-101 --to PROJ-102 --type Blocks --json
atlcli jira issue unlink --from PROJ-101 --to PROJ-102 --confirm --json
atlcli jira issue unlink --link 10500 --json
atlcli jira issue link-page --key PROJ-101 --page 12345 --comment --json
atlcli jira issue pages --key PROJ-101 --json
atlcli jira issue unlink-page --key PROJ-101 --link <linkId> --json
```

`unlink --from --to` looks up the link on the `--from` issue. Without
`--confirm` it prints what it would remove and fails. If several links connect
the two issues it fails and lists their IDs: narrow it with `--type <name>` or
pass `--link <id>`. `unlink --link <id>` deletes at once, with no `--confirm`.

`unlink-page` takes the link ID from `issue pages` as `--link <id>`, or
`--page <pageId>`, which removes the link by the page's global ID.

## Attachments

```bash
atlcli jira issue attach PROJ-101 ./report.pdf ./trace.log --comment 'Logs from prod' --json
atlcli jira issue attachments PROJ-101 --json
atlcli jira issue attachment download 10001 -o ./downloads/
atlcli jira issue attachment download PROJ-101 report.pdf -o ./downloads/
atlcli jira issue attachment delete PROJ-101 report.pdf --confirm
```

`attach` takes the key and any number of files. It checks all paths before
uploading anything, continues past a file Jira rejects, and exits non-zero if
any file failed. `--comment` is posted only if at least one file uploaded, and
it is Markdown, converted like any other comment. `download` takes an
attachment ID, or an issue key and filename. It refuses to overwrite an
existing file without `--overwrite`. `delete` takes `--confirm`.

## Anti-patterns

- Hand-assembling ADF JSON for something Markdown can say. Write Markdown.
- Deleting `<!--adf:…-->` markers while editing a description. The content they
  hold is gone after the update.
- Writing a literal `*`, `_`, `#` or backtick in a description without a
  backslash. It formats the text.
- Putting a `:::` panel inside a list item. It stays literal text.
- Passing both `--description` and `--description-file`, or both
  `--description` and `--field description=` on `update`.
- Running `jira issue comment … list` or `get` to work with comments. It posts
  the word. Use `comments list`.
- Transitioning by status name. The workflow exposes action names.
- Assuming `Task` or `Bug` exists in the project. Check `jira project types`.
- Re-running a failed create/transition pair from the start. The issue exists;
  retry the transition alone.

Related: [jira-search.md](jira-search.md) for finding issues,
[jira-agile.md](jira-agile.md) for sprints and epics,
[jira-bulk-and-admin.md](jira-bulk-and-admin.md) for mass changes,
[safety.md](safety.md) before any write.
