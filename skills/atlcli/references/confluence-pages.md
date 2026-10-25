---
name: confluence-pages
description: Confluence page and space operations (read, create, update, move, label, comment, history, diff, tasks to Jira issues, CQL search).
metadata:
  tags: confluence, pages, spaces, cql, labels, comments, history, diff
---

# Confluence pages and spaces

Direct page operations against the API. For editing a whole tree as local
Markdown, use [confluence-docs-sync.md](confluence-docs-sync.md) instead.

## Contents

- [Finding pages](#finding-pages)
- [Reading a page](#reading-a-page)
- [Creating and updating](#creating-and-updating)
- [Structure: parents, order, copies](#structure-parents-order-copies)
- [Labels](#labels)
- [Comments](#comments)
- [History, diff and restore](#history-diff-and-restore)
- [Page tasks to Jira issues](#page-tasks-to-jira-issues)
- [Jira links](#jira-links)
- [Spaces](#spaces)
- [Anti-patterns](#anti-patterns)

## Finding pages

```bash
atlcli wiki search 'getting started' --space DEV --json
atlcli wiki search --space DEV,DOCS --modified-since 7d --json
atlcli wiki search --label api,documentation --json
atlcli wiki search --creator me --created-since thisMonth --json
atlcli wiki search --cql 'type=page AND space=DEV AND lastModified >= startOfWeek()' --json
```

Filters: `--space` (comma-separated), `--type page|blogpost|comment|all`
(default `page`), `--label` (comma-separated, all must match), `--title`,
`--creator` (`me` works), `--ancestor <pageId>`, `--modified-since`,
`--created-since`, `--limit` (default 25), `--start`, `--format table|compact`.
`--cql` overrides all other filters. `--verbose` prints the CQL that was built,
which is the quickest way to debug an unexpected result set. A configured
default space applies when `--space` is absent.

`--label a --label b` and `--label a,b` mean the same: every label must match.
Other filters do not combine when repeated: a second `--space` is ignored, so
write `--space DEV,DOCS`.

Date expressions: `7d`, `30d`, `1w`, `1m`, `today`, `yesterday`, `thisWeek`,
`thisMonth`, `2026-01-15`.

CQL fields: `text`, `title`, `space`, `type`, `label`, `creator`, `created`,
`lastModified`, `ancestor`. Operators `=`, `!=`, `~`, `!~`, `>`, `<`, `>=`,
`<=`, `IN`, `NOT IN`. Functions `currentUser()`, `now()`, `startOfDay()`,
`startOfWeek()`, `startOfMonth()`.

Also available:

```bash
atlcli wiki my --json                       # pages you created
atlcli wiki my --contributed --json         # pages you contributed to
atlcli wiki recent --days 14 --space DEV --json
```

With `--json`, the results of `wiki search`, `wiki my` and `wiki recent` carry
`creator`, `creatorId`, `lastModifiedBy` and `lastModifiedById` when Confluence
returns them; a missing key means the value is unknown. `wiki search
--format compact` carries none of them.

Both accept `--space`, `--label` (one label) and `--limit`. `recent` looks back
7 days unless `--days` says otherwise.

## Reading a page

```bash
atlcli wiki page get --id 12345 --json
atlcli wiki page list --space DEV --limit 50 --json
atlcli wiki page list --label architecture --json
atlcli wiki page list --cql 'type=page AND label=draft' --json
atlcli wiki page children --id 12345 --limit 100 --json
```

`wiki page get` returns the body as Confluence storage XHTML under
`page.storage`, not Markdown. See the update caveat below before planning an
edit around it. Every page verb identifies its target with `--id`. Page IDs come from
`wiki search`, `wiki page list`, or the `atlcli.id` frontmatter of a synced
Markdown file.

`wiki page list --label` adds its labels (repeated or comma-separated, all
must match) to `--cql` or `--space`: `--label api --cql 'space = DOCS'` asks
for `(space = DOCS) AND label = "api"`. `--cql` replaces `--space`.

## Creating and updating

```bash
atlcli wiki page create --space DEV --title 'API Authentication' --body ./auth.md --json
atlcli wiki page update --id 12345 --body ./auth.md --title 'API Auth' --json
```

`--body` is a **path to a Markdown file**, not inline text, and `-` does not
read stdin. The file is converted to Confluence storage format before upload, so
Markdown headings, lists, tables, and code fences all survive; write the content
to a file first. `create` also takes `--parent <pageId>`. Without `--space` the
configured default space applies.

`update` replaces the whole body, and the `wiki page` group cannot round-trip
an edit: `wiki page get` returns Confluence storage XHTML, `--body` accepts only
a Markdown file, and no verb in this group converts one to the other.
(`wiki template init <name> --from <page>` does convert a page to Markdown, but
it writes a local template, not a page copy, and writes Jira issue macros as the
deprecated `{jira:KEY}` form. Do not use it to fake a sync path.) To
change text that already exists on a page, use the Markdown workspace:
`atlcli wiki docs init ./page --page-id 12345`, then pull, edit, push. Use
`wiki page update` only to replace a whole body with Markdown you already hold.

`create` also has a template mode: `--template <name> --title <title>` renders
a stored template (with `--var key=value`, repeatable) instead of reading
`--body`, and applies the template's labels. `--dry-run` prints the rendered
Markdown without creating anything. See
[confluence-templates.md](confluence-templates.md).

To change an existing page's editor version:

```bash
atlcli wiki page convert --id 12345 --to-new-editor --json
atlcli wiki page convert --id 12345 --to-legacy-editor --json
```

Exactly one of the two flags is required.

## Structure: parents, order, copies

```bash
atlcli wiki page move --id 12345 --parent 67890 --json
atlcli wiki page move ./docs/setup.md --before ./docs/intro.md --json
atlcli wiki page move ./docs/appendix.md --after ./docs/intro.md --json
atlcli wiki page move ./docs/index.md --first --json
atlcli wiki page move ./docs/glossary.md --last --json
atlcli wiki page move --id 12345 --position 3 --json
atlcli wiki page sort ./docs/api.md --alphabetical --dry-run --json
atlcli wiki page sort ./docs/chapters.md --natural --json
atlcli wiki page sort ./docs/changelog.md --by created --reverse --json
atlcli wiki page copy --id 12345 --title 'Copy of Page' --space DEV --parent 67890 --json
atlcli wiki page copy --id 12345 --title 'Retro {{sprint}}' --var sprint=42 --json
atlcli wiki page copy --id 12345 --tree --title 'Audit {{year}}' --vars-file audit.yml --plan-out pages.json
```

`copy` copies the attachments too (`--no-attachments` leaves them out); title
and body are templates (`{{source.title}}`, `{{@today}}`, `--var`). `--tree`
copies all descendants as a plan (`--apply [--yes]` or `atlcli script apply`),
with `{{parent.title}}` for the rendered parent; a rendered title that already
exists fails the plan, and a re-plan after a partial apply reuses the copies
(content property `atlcli.copiedFrom`). See jira-issues.md for templating
rules and `atlcli template vars`.

`move` and `sort` accept either a page ID (`--id`) or a local file path inside
a synced workspace. `move` takes exactly one destination (`--parent`,
`--before`, `--after`, `--first`, `--last`, or `--position`) and errors if you
give none or several. `--before` and `--after` need pages with the same parent.
`sort` reorders a page's children; `--dry-run` shows the resulting order first.

```bash
atlcli wiki page children --id 12345 --limit 100 --json
atlcli wiki page delete --id 12345 --confirm --json
atlcli wiki page delete --cql 'label=to-delete' --dry-run --json
atlcli wiki page archive --id 12345 --confirm --json
atlcli wiki page open 12345
```

`delete` and `archive` need `--confirm` or `--dry-run`. `open` takes the ID
positionally and launches a browser.

## Labels

```bash
atlcli wiki page label list --id 12345 --json
atlcli wiki page label add architecture api-docs --id 12345 --json
atlcli wiki page label remove draft --id 12345 --json
atlcli wiki page label add archived --cql 'space=OLD' --dry-run --json
atlcli wiki page label add archived --cql 'space=OLD' --confirm --json
```

Labels are positional and variadic. The CQL form is a bulk write and needs
`--confirm`; preview it with `--dry-run` first.

## Comments

```bash
atlcli wiki page comments --id 12345 --json
atlcli wiki page comments add --id 12345 'Looks good!' --json
atlcli wiki page comments add --id 12345 --file ./comment.md --json
atlcli wiki page comments reply --id 12345 --parent 67890 'Thanks!' --json
atlcli wiki page comments add-inline --id 12345 --selection 'important text' 'Please clarify' --json
atlcli wiki page comments resolve --comment 67890 --json
atlcli wiki page comments delete --comment 67890 --confirm --json
```

Comment text is Markdown, converted to storage format; `--file` reads it from a
file. `--match-index <n>` selects which occurrence of `--selection` an inline
comment attaches to (default 0). `resolve` and `delete` target `--comment <id>`,
not `--id`, and treat the comment as a footer comment unless you pass
`--type inline`.

## History, diff and restore

```bash
atlcli wiki page history --id 12345 --limit 5 --json
atlcli wiki page diff --id 12345 --version 3 --json
atlcli wiki page diff --id 12345 --from 3 --to 5 --format unified --context 5
atlcli wiki page diff --id 12345 --from 3 --to 5 --format text --word-diff
atlcli wiki page diff --id 12345 --from 3 --to 7 --format semantic --json
atlcli wiki page diff --id 12345 --from 3 --to 7 --format review --word-diff
atlcli wiki page restore --id 12345 --version 3 --confirm --json
```

`history` defaults to 10 versions. `diff` compares a version with the current
one (`--version 3`, or `--from 3` alone) or any two versions (`--from` and
`--to`; `--to` needs `--from`; `--version` cannot be combined with either).
Without a selection it compares the previous version with the current one.
Versions are positive integers and each flag may be given once.

Formats (`--format`):

- `unified` (default) and `text`: Markdown line diff. `--context <n>` sets
  context lines (default 3), `--word-diff` marks changed words inline.
- `semantic`: plain-language structural changes (headings, lists, images). JSON
  carries one `changeSet` document. `--context` and `--word-diff` are rejected.
- `review`: the semantic view followed by the Markdown text changes. JSON
  carries `changeSet` and `textDiff`.

`--no-color` (or `NO_COLOR`) turns ANSI colors off. A semantic result with
`Coverage: degraded` has opaque or unmatched parts and is not a complete
review.

`restore` creates a new version with the old content; it does not erase
history, but it does change what readers see. Confirm before running it.

## Page tasks to Jira issues

```bash
atlcli wiki page tasks-to-issues --id 12345 --project PROJ --json
atlcli wiki page tasks-to-issues --id 12345 --project PROJ --type Task \
  --label meeting --confirm --json
atlcli wiki page tasks-to-issues --id 12345 --sync --json
atlcli wiki page tasks-to-issues --id 12345 --sync --confirm --json
```

Without `--confirm` the command writes nothing and prints the plan: per task
`create` or a `skip:` reason (`linked`, `ledger`, `done`, `empty`). With
`--confirm` it creates one issue per open task, adds a Confluence remote link to
each issue, and rewrites the page so each converted task links its issue.
Options: `--type` (default `Task`), `--label` (repeatable), `--parent <key>`,
`--include-done`, `--no-link` (skip the remote link), `--no-mark` (leave the
page tasks unannotated). `--id` must be the numeric page ID.

`--sync` ticks tasks whose linked issues are all done, and unticks a task only
if an earlier sync ticked it and an issue reopened. A task ticked by hand while
its issue is open is reported, not changed. Both steps are Jira and Confluence
writes: preview first, then confirm with the user.

## Jira links

```bash
atlcli wiki page link-issue --id 12345 --issue PROJ-101 --comment --json
atlcli wiki page issues --id 12345 --project PROJ --json
atlcli wiki page unlink-issue --id 12345 --issue PROJ-101 --json
```

`unlink-issue` accepts `--link <linkId>` in place of `--id`; `--issue` stays required. The mirror image
lives on the Jira side as `jira issue link-page`. See
[jira-issues.md](jira-issues.md#links-and-confluence-pages).

## Spaces

```bash
atlcli wiki space list --json
atlcli wiki space get --key DEV --json
```

`space list` takes `--limit` (default 25).

`atlcli wiki space create --key <key> --name <name>` creates a space. That is a
site-level act, only on an explicit request.

## Anti-patterns

- Passing page content inline to `--body`. It is a file path; inline Markdown
  is read as a filename and fails with an IO error.
- Calling `wiki page update` with a partial body. It replaces the whole page.
- Running `tasks-to-issues --confirm` before reading the preview. It creates
  Jira issues and edits the page.
- Running the `--cql` form of `delete`, `archive`, or `label` without
  `--dry-run` first, because the query decides how many pages are touched.
- Giving `wiki my` or `wiki recent` more than one label. They take one: a
  second `--label` is ignored, and `a,b` is read as one label name.
- Using `--id` for `comments resolve` or `comments delete`. Those take
  `--comment`.

Related: [confluence-docs-sync.md](confluence-docs-sync.md),
[confluence-templates.md](confluence-templates.md),
[safety.md](safety.md).
