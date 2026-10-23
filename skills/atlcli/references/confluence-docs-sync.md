---
name: confluence-docs-sync
description: The Markdown workspace workflow: init, pull, edit, status, diff, validate, push, sync, and conflict handling.
metadata:
  tags: confluence, sync, markdown, frontmatter, conflicts, validation
---

# Markdown workspace sync

`wiki docs` mirrors a Confluence space, page tree, or single page into a local
Markdown directory, and pushes edits back. It is the right tool for editing
more than one page, or for any edit that wants review before it lands. For a
quick edit of one page without a local copy, see
[confluence-vfs.md](confluence-vfs.md).

## Contents

- [The loop](#the-loop)
- [What protects a push, and what does not](#what-protects-a-push-and-what-does-not)
- [Initialising a workspace](#initialising-a-workspace)
- [File format](#file-format)
- [Attachments](#attachments)
- [Macros in Markdown](#macros-in-markdown)
- [Validation](#validation)
- [Pushing](#pushing)
- [Conflicts](#conflicts)
- [Watch and sync](#watch-and-sync)
- [Editor conversion](#editor-conversion)
- [Anti-patterns](#anti-patterns)

## The loop

```bash
atlcli wiki docs pull ./docs --json            # refresh from Confluence first
#   … edit Markdown files …
atlcli wiki docs status ./docs --json          # what changed locally (no network)
atlcli wiki docs diff ./docs/api.md            # remote page vs local file
atlcli wiki docs check ./docs --strict --json  # validate links and macros
atlcli wiki docs push ./docs --validate --json # publish
```

Every subcommand takes the directory as a positional argument or as `--dir`.
Without either it uses the current directory and walks up to the nearest
`.atlcli/`.

With `--json`, `pull`, `push --validate`, `check` and `resolve` print exactly
one JSON document, failures included (a failed `check` carries an `error`
object in the report). `watch` and `sync` print one JSON object per line.

## What protects a push, and what does not

`docs push` and `docs watch` compare the page's current Confluence version
with the version of your last pull. When the page changed in Confluence since
then, the file is not pushed: `push` names it (`changed in Confluence since
your last pull (vN → vM); not pushed`), pushes the other files and exits 1
(with `--json`, under `error.details.conflicts`); `watch` reports it and
keeps watching. A file you did not edit locally is skipped without a message
in that case. `--force` overwrites the Confluence edit. Only `docs sync` runs a
three-way merge.

`docs status` makes no network call. Its `remote-modified` and `conflict`
counts only show what an earlier `sync` recorded, so a clean `status` says
nothing about the remote side.

When a push is refused, the Confluence edit has to get into the file first.
`pull` does not do that: it skips a locally modified file (`Skipping <path>
(local modifications, use --force)`) and counts it under `skipped`. Either the
user runs `atlcli wiki docs sync <dir>`, which merges or writes conflict
markers (see [Conflicts](#conflicts)) and keeps running until stopped, or you
work from `atlcli wiki docs diff <file>`, which diffs the current remote page
against the local file: carry the remote changes into the file until the diff
contains only your intended edits, show it to the user, then push that file
with `--force`.

`push` also has no dry run. It re-uploads every tracked file in the target, so
push the single file you edited (`push ./docs/api.md`) instead of the whole
directory.

## Initialising a workspace

```bash
atlcli wiki docs init ./team-docs --space TEAM
atlcli wiki docs init ./team-docs --ancestor 12345    # a page tree
atlcli wiki docs init ./team-docs --page-id 67890     # a single page
```

`init` fails if the directory already has an `.atlcli/`. `init`, `pull`, and
`sync` need a scope: `--space <key>`, `--ancestor <pageId>`, or `--page-id
<id>`. Passing more than one is not an error: `--page-id` wins over
`--ancestor`, which wins over `--space`, silently. `init` without a scope flag
falls back to the configured default space (`atlcli config set global.space
<key>`, or `profiles.<name>.space`). After `init` the scope is stored, so `pull` needs no scope flag unless overriding it for one
run. A `pull` into an uninitialised directory initialises it.

Pull options worth knowing:

| Flag | Effect |
| --- | --- |
| `--limit <n>` | Caps the number of pages pulled. Must be a positive integer. |
| `--label <l>` | Only pages with that label. |
| `--comments` | Writes `<page>.comments.json` next to pages that have comments. |
| `--no-attachments` | Skips attachment downloads. |
| `--force` | Overwrites local modifications, attachments included. Data loss: confirm first. |
| `--skip-user-check`, `--refresh-users`, `--fetch-contributors` | Control the user-status and contributor lookups stored in `sync.db`. |

`--page-id` pulls the page and the folders on the path to it, not the rest of
the space. Pages of a tree or space pull that the account cannot read (404) are
skipped; an unreadable `--page-id` target fails the pull.

State lives in `./.atlcli/`: `config.json`, `state.json`, `cache/`, `logs/`, and
`sync.db` after the first pull. Do not edit it.

## File format

Each page is a Markdown file with `atlcli`-namespaced YAML frontmatter:

```markdown
---
atlcli:
  id: "12345"
  title: "Page Title"
---

# Page Title

Content here…
```

`id` is required for a tracked page. `title` and `type` are optional. `pull`
writes `id` and `title`, and the page title on push comes from frontmatter
`title`, not from the filename or the H1. Changing `title` renames the page.
Version tracking lives in `.atlcli/`, not in the file.

Directory layout mirrors the Confluence hierarchy:

| Confluence | Local |
| --- | --- |
| Page without children | `page-name.md` |
| Page with children | `page-name/index.md`, children beside it in `page-name/` |
| Folder (Cloud only) | `folder-name/index.md` with `type: "folder"` |
| Page inside a folder | `folder-name/page-name.md` |

When a page gains children, `pull` moves `page-name.md` to
`page-name/index.md`. When syncing a space, the children of the space home page
sit at the root of the workspace. Moving a file to another directory moves the
page on the next push when the new directory's `index.md` carries an `id`.

A folder's `index.md` carries frontmatter only, no body. Folders cannot be
renamed through the API: `push` warns and skips. A directory without an
`index.md` gets a folder `index.md` auto-created on a directory `push` (and a
Confluence folder with it) unless `--no-auto-create-folders` is passed.

Exclude files with `.atlcliignore` (gitignore syntax); patterns from
`.gitignore` are merged in as well.

## Attachments

`pull` downloads attachments to a directory named after the page file, beside
it: `page-name.attachments/` for `page-name.md`, `index.attachments/` for an
`index.md`. Attachment names are flat; a name containing a path separator is
refused.

To add an image or file, put it in that directory and reference it with the
page-specific path:

```markdown
![Diagram](./page-name.attachments/diagram.png)
[Spec](./page-name.attachments/spec.pdf)
```

`push` uploads new and changed files that the Markdown references. Other
reference forms, such as `./diagram.png`, are not treated as attachments.
When a page still references at least one attachment, a tracked attachment
whose file is gone locally and which the Markdown no longer references is
deleted from Confluence on push.

`pull` protects local attachment edits like it does Markdown: a changed local
file is kept (`Skipping … (local modifications, use --force)`), a file edited on
both sides is kept and the remote copy is saved as `name-conflict.ext`, and an
untracked file at the destination is kept. `status` reports attachments in a
separate `attachmentStats` block and lists them in `modified`.

## Macros in Markdown

Confluence macros are written as fenced `:::` blocks and converted on push. The
macro name follows the colons with **no space**: `:::info` converts, `::: info`
does not. `wiki docs check` reports the spaced opener on its own line
(`write ":::name" without a space`) and the block's closing `:::` as an
unexpected close:

`````markdown
:::info
Text of the panel.
:::

:::info "Panel title"
Text of the panel.
:::

:::expand "Details"
Hidden content.
:::

:::toc minLevel=2 maxLevel=3
:::
`````

Common blocks: `info`, `note`, `warning`, `tip`, `panel` (with `title=`,
`bgColor=`, `borderColor=`), `expand`, `toc`, `toc-zone`, `children`,
`pagetree`, `recently-updated`, `content-by-label`. `wiki docs check` follows
the converter: a block it reports as unclosed or unexpected (`MACRO_UNCLOSED`)
would reach Confluence as literal `:::` text.

Multi-column layouts use `section` and `column`, which close with their own
end markers rather than a bare `:::`:

`````markdown
:::section
:::column
Left column.
:::column-end
:::column
Right column.
:::column-end
:::section-end
`````

A section or column closed with a bare `:::` fails `check`.

### Linking between pages

`check` and `status --links` understand a link to another synced page as a
relative path to its `.md` file, resolved from the linking file's own directory:

```markdown
See the [deployment runbook](./runbook.md) and the
[API guide](../api/index.md).
```

Links are classified by target: an anchor (`#section-name`), an external URL
(`http://`, `https://`, `mailto:`, `ftp://`), an attachment (any path containing
`.attachments/`), or a relative path (anything else, normally a `.md` file).
Only relative paths are resolved to page IDs, and only they can be reported as
broken. `check` reports a relative path with no matching file as an error and a
link to an untracked page as a warning; `status --links` compares the links in
your working copy against the ones recorded for the page.

The converter does not rewrite these links on push: the relative href is
uploaded to Confluence unchanged, and a Confluence URL to another page is
classified as external and never validated.

### What pull produces

A pulled file can contain syntax the sections above never ask you to write:

- A macro the converter does not model comes down as a `:::confluence <name>`
  block containing an `<!--raw … -->` comment holding the original storage XML,
  followed by a visible `*[<name> macro]*` label. Push restores the XML from
  that comment verbatim. **Do not tidy, reformat, or remove the `<!--raw … -->`
  comment**: without it, push replaces the whole macro with an
  `<!-- atlcli: <name> macro content lost -->` comment and the macro disappears
  from the page. The `*[<name> macro]*` line is a label, not content.
- Some constructs round-trip as inline syntax rather than `:::` blocks:
  `{date:2026-01-15}`, `{#anchor-name}`, `@[Display Name](accountId)` (pull
  writes the user's display name), `{color:red}…{color}`, and
  `{bg:yellow}…{bg}`, and `{status:green}Done{status}` for a status lozenge.
  Jira issue macros come back as ordinary Markdown links
  (`[PROJ-101](…/browse/PROJ-101)`); the legacy `{jira:PROJ-101}` form is
  deprecated on push, do not write it.

Authoring a `:::confluence` block by hand only works if you supply the storage
XML inside a `<!--raw … -->` comment.

`toc` and `toc-zone` pass their parameters (`minLevel=2 maxLevel=3`) through.
`expand` takes only a quoted title: `:::expand "Details" expanded=true` gets
the title `Details`, and `check` warns that `expanded` is ignored
(`MACRO_INVALID_PARAMS`). `panel` values are quoted: `:::panel title="Note"
bgColor="#eef" borderColor="#99c"`.

## Validation

`check` validates broken links (error), links to untracked pages (warning),
unclosed macros (error), ignored macro parameters (warning), and pages over
500KB (warning), and warns about folder problems. `--strict` promotes warnings to errors, which is what CI should use.
`check` fails when it finds no Markdown files, so a wrong directory cannot pass.
`push --validate` validates exactly the files the push will send and aborts on
errors (and on warnings with `--strict`).

## Pushing

```bash
atlcli wiki docs push ./docs/api.md --json            # one file (preferred)
atlcli wiki docs push --page-id 12345 --json          # one page, found by its id
atlcli wiki docs push ./docs --validate --json        # every tracked file in the tree
atlcli wiki docs add ./docs/new-page.md --title 'New Page' --parent 12345 --json
```

`--validate` runs the checks and aborts on errors: use it on every push.
`add` publishes a file that has no `atlcli.id` yet and writes the new ID back
into its frontmatter. The title is `--title`, else the first H1, else the
filename. The space comes from `--space` or the workspace config, the parent
from `--parent`. `--template <name>` with `--var key=value` renders a page
template first.

A file without an `atlcli.id` in a tracked workspace is also created by
`push`, with a title derived from its filename (not from frontmatter or the H1)
and no parent unless its directory has a folder `index.md` with an id. Use
`add` for new pages.

Two flags change destructive behaviour: `--delete-folders` *authorizes*
deletion of remote folders whose `index.md` was removed locally (there is no
further prompt), and `--no-auto-create-folders` stops atlcli creating folders
for directories that lack an `index.md`. Pages are created in the new editor
(v2) unless `--legacy-editor` is passed. `push` never deletes pages.

## Conflicts

Only `sync` writes conflict markers into pages (`push` refuses instead, and
`pull` can record attachment conflicts, writing a `*-conflict.*` copy next to
the attachment). When both sides changed a
page, its three-way merge either succeeds or writes conflict markers into the
file:

```text
<<<<<<< LOCAL
your text
=======
the Confluence text
>>>>>>> REMOTE
```

`status` then lists the file under `conflicts`. Two ways out:

- `atlcli wiki docs resolve <file> --accept local|remote` picks one side of
  every marker. When the page in Confluence still matches the `REMOTE` side,
  the file can be pushed as it is.
- Edit the file so that no markers remain, then run
  `atlcli wiki docs resolve <file> --accept merged` to clear the conflict.
  `--accept merged` refuses while markers are left.

`resolve` ends by naming the next step. After `--accept merged`, or when the
page has moved on in Confluence, the push base is still the version from
before the conflict, so a plain `push` is refused: run `sync` again, or
`push --force` once `atlcli wiki docs diff <file>` shows that the file already
holds the remote edit.

Show the diff to the user and let them choose; do not pick a side to make the
push succeed. Choosing `local` overwrites the Confluence edit.

## Watch and sync

```bash
atlcli wiki docs watch ./docs --space TEAM --debounce 2000
atlcli wiki docs sync ./docs --space TEAM --poll-interval 60000
atlcli wiki docs sync ./docs --space TEAM --dry-run --json
```

`watch` pushes a file each time it changes (default directory `./docs`,
`--debounce` in ms, default 500) and, like `push`, skips a page that changed in
Confluence since the last pull unless `--force` is given. `sync` is the
bidirectional daemon: it pulls remote changes by polling, pushes local changes
by file watching, and merges when both changed. Options:

| Flag | Effect |
| --- | --- |
| `--poll-interval <ms>` | 100 to 86400000, default 30000. |
| `--no-poll`, `--no-watch` | Local watch only, or polling only. |
| `--on-conflict merge\|local\|remote` | `merge` (default) writes markers when the merge fails, `local` overwrites the Confluence page, `remote` overwrites the local file. |
| `--auto-create` | Creates Confluence pages for new local files. |
| `--label <l>` | Only pages with that label. |
| `--dry-run` | Reports the plan and exits. Writes nothing, deletes nothing, creates no `.atlcli/`. |
| `--webhook-port`, `--webhook-url` | Real-time updates through a webhook. |

Both run until interrupted (apart from `sync --dry-run`) and emit JSON lines
with `--json`. They are long-running foreground processes: start them only
when the user asks for continuous sync, and never in a shell whose result is
needed. `sync --dry-run` is the only form that returns.

## Git plugin

The builtin `git` plugin is disabled by default (`atlcli plugin list`). Do not
enable it or install its hook unless the user asks.

- Enabled, it commits the pulled files after each `wiki docs pull` into a
  directory that is a git repository.
- `atlcli git hook install [dir]` writes a `.git/hooks/post-commit` script that
  runs `atlcli wiki docs push <dir> --quiet` after every git commit in that
  repository.
  A commit then writes to Confluence. The script skips the push when a `sync`
  daemon holds the lock, and a failed push, such as one refused because a page
  changed in Confluence, does not block the commit.
- `atlcli plugin disable git` does not remove the hook. The script is a plain
  file that calls `atlcli`, so it keeps pushing until `atlcli git hook remove`
  runs (or the file is deleted). `atlcli git hook status` shows whether it is
  installed. The `git` command itself only exists while the plugin is enabled.
- The plugin provides no `wiki docs commit` command. Commit with git.

## Editor conversion

```bash
atlcli wiki docs convert ./docs/page.md --to-new-editor --json
atlcli wiki docs convert ./docs --to-new-editor --dry-run --json
atlcli wiki docs convert ./docs --to-new-editor --confirm --json
atlcli wiki docs convert ./docs --to-legacy-editor --confirm --json
```

Exactly one of `--to-new-editor` / `--to-legacy-editor` is required. A single
file converts directly; a directory converts every tracked page in the
workspace and needs `--dry-run` first and then `--confirm`. The single-page
equivalent against the API is `wiki page convert` in
[confluence-pages.md](confluence-pages.md).

## Anti-patterns

- Passing `--force` to `push` or `watch` to get past a refused page. It
  overwrites the newer Confluence version; `sync` merges it instead.
- Pushing a whole directory to publish one edit. Every tracked file is sent.
- Treating a clean `status` as proof the remote has not changed. `status` is
  local only.
- Using `--force` on `pull` to clear a conflict. It overwrites local edits
  silently.
- Hand-editing `atlcli.id` in frontmatter, or committing `.atlcli/` changes as
  if they were content.
- Pushing without `--validate`. Broken links and unclosed macros reach
  Confluence as visible breakage.

Related: [confluence-pages.md](confluence-pages.md) for single-page API edits,
[confluence-vfs.md](confluence-vfs.md) for the shell and mount, and
[safety.md](safety.md).
