---
name: confluence-import
description: Importing Word (.docx) and PDF files as Confluence pages with wiki import, review-first, and the optional local table model.
metadata:
  tags: confluence, import, docx, pdf, word
---

# DOCX and PDF import

`atlcli wiki import` turns a `.docx` or a digital PDF into native Confluence
pages (headings, lists, tables, images), not an embedded file. It is the only
command that creates Confluence pages from Word or PDF input. For Markdown
content use [confluence-pages.md](confluence-pages.md) or
[confluence-docs-sync.md](confluence-docs-sync.md).

## Contents

- [Preview first, then confirm](#preview-first-then-confirm)
- [Sources](#sources)
- [DOCX options](#docx-options)
- [PDF options](#pdf-options)
- [Updating a page in place](#updating-a-page-in-place)
- [Batch import](#batch-import)
- [Data Center](#data-center)
- [Anti-patterns](#anti-patterns)

## Preview first, then confirm

Without `--confirm` the command parses the file, prints a preview (block
counts, outline, issues, page tree, content digest) and exits without creating
anything. `--confirm` publishes. `--confirm` together with `--dry-run` is
rejected.

```bash
atlcli wiki import handbook.docx --space TEAM --json
atlcli wiki import handbook.pdf  --space TEAM --json
```

A preview of a local file with an explicit `--space` makes no network call.
It does read the profile, and contacts Confluence, when `--space` is missing,
when the source is `--from-page`, or when `--update-page` is used.

Show the user the preview (title, space, parent, page count, issues) and get
approval for the exact `--confirm` command. The confirmed run analyses the
file again and publishes that result. If publication fails or the read-back
verification fails, the pages created by that run are deleted again.

`--json` on a preview prints `{"mode":"preview", ...}` for DOCX; the PDF
preview prints the review report with its plan digest.

Do not retry a failed `--confirm` run without reading the error: the run may
have rolled back its pages, or a title conflict may be waiting.

## Sources

```bash
atlcli wiki import handbook.docx --space TEAM --parent 12345 --title 'Handbook'
atlcli wiki import --from-page 123456 --attachment handbook.docx --space TEAM
cat handbook.pdf | atlcli wiki import - --format pdf --space TEAM
```

- Format is inferred from the extension. `--format docx|pdf` is required for
  stdin (`-`) and extensionless input.
- `--from-page` needs `--attachment <exact file name>` and downloads that
  attachment with the active profile. Give a local file or `--from-page`, not
  both.
- The binary `.doc` format is rejected, and so are encrypted PDFs.
- Without `--space` the profile's default space is used. Check
  `atlcli config list --json` first.

## DOCX options

| Option | Effect |
| --- | --- |
| `--title <t>` | Page title. Default: first Heading 1, else file name |
| `--parent <id>` | Parent page id |
| `--split <1..6>` | One page per heading down to that level, as a page tree |
| `--title-conflict fail\|rename` | Duplicate titles fail (default) or get ` (2)` suffixes |
| `--map-style <style>=<target>` | Map a Word style to `paragraph`, `heading-1..6`, `blockquote`, `code`. Repeatable |
| `--revisions accept\|reject` | Tracked changes. Default `accept` |
| `--unsupported report\|fail` | `fail` blocks a confirmed publish when a construct would be lost |
| `--comments auto\|inline\|footer\|skip` | Word comments become Confluence comments. Default `auto` |
| `--overrides <file>`, `--recipe <file>`, `--recipe-id <id>` | Policy files. Recipes: `wiki import recipe validate\|list\|show\|export` |
| `--restriction inherit\|private\|explicit` | Page visibility. `explicit` takes `--viewer` / `--editor` as `account:<id>` or `group-id:<id>` |
| `--staging-parent <title>` | Import below a new private parent page |
| `--label <name>` | Labels applied to the root page. Repeatable |
| `--content-property k=v` | `atlcli.*` page metadata. Repeatable |

With `--restriction private` or `explicit` the page is created empty, the
restriction is applied and read back, and only then does content land.
Labels and content properties are required outcomes: a failure rolls the import
back.

## PDF options

PDF defaults to `--split auto`: up to 20 source pages stay on one page, longer
files become a page tree with a root Contents page, capped at 50 wiki pages.

| Option | Effect |
| --- | --- |
| `--split auto\|off\|heading:<1..6>\|pages:<5..40>` | Split mode. `off` still fails for inputs over 40 source pages |
| `--max-wiki-pages <n>` | Tree cap, 1..200. Default 50 |
| `--scan-policy fail\|page-image\|report` | Image-only pages. Default `fail` blocks publication |
| `--visual-fallback auto\|inline\|collapsed\|appendix` | Rendered page images as fallback. Implies `page-image` |
| `--reading-order auto\|tags\|geometry` | `tags` fails on an untagged PDF |
| `--unsupported report\|fail` | As for DOCX |
| `--accept-reported-pages` | Needed with `--scan-policy report --unsupported report` |
| `--attach-source` | Also attach the original PDF. Off by default |
| `--overrides <file>` | Digest-bound corrections (heading level, figure alt text, order) |
| `--overrides-template <file>` | Writes a draft override file with one entry per figure without alt text. Never overwrites an existing file |
| `--table-model table-transformer` | Local model for untagged tables the geometry cannot resolve |

Findings in the preview with blockers stop `--confirm` before anything is
created (`PDF publication is blocked`). `--unsupported fail` also stops on
figures without alt text; draft them with `--overrides-template`.

The table model is optional and local. Install it once, then pass the flag:

```bash
atlcli models list
atlcli models pull table-transformer        # downloads about 30-116 MB model plus ~100 MB runtime
atlcli wiki import contract.pdf --space DOCS --table-model table-transformer
```

`models pull` downloads files into `~/.atlcli/models` (override with
`ATLCLI_MODELS_DIR`). Ask before running it.

PDF import is create-only. The DOCX-only flags (`--map-style`, `--revisions`,
`--comments`, `--recipe`, `--recipe-id`, `--manifest`, `--update-page`,
`--expect-version`, `--skip-existing`) are rejected for PDF.

## Updating a page in place

```bash
atlcli wiki import spec-v2.docx --update-page 123456 --json
atlcli wiki import spec-v2.docx --update-page 123456 --confirm --expect-version 7
```

- Only pages created by `wiki import` can be updated. The importer stores a
  baseline on the page when it creates it.
- If anyone edited the page since, the update stops with `target-diverged` and
  shows a diff. There is no force flag.
- Pages with inline comments need `--accept-anchor-loss`.
- Pass `--expect-version` with `--confirm`. The help text calls it required,
  the code checks it only when given.
- `--update-page` cannot be combined with `--split` or `--parent`.

## Batch import

```bash
atlcli wiki import ./exports --space TEAM --parent 123456 --json
atlcli wiki import a.docx b.docx --space TEAM --skip-existing --confirm
atlcli wiki import --manifest batch.yaml --confirm --resume
```

- A directory imports every `.docx` directly inside it. A `.zip` of `.docx`
  files works too.
- `--title` is rejected in batch mode. Titles come from each document.
- Each file is its own transaction. A failure rolls back that file only and
  the batch continues. The exit code is non-zero if any file failed.
- A killed batch is resumed with `--skip-existing` (skips existing titles) or,
  for a manifest, `--resume` (state file next to the manifest).

## Data Center

DOCX and PDF imports on Data Center create single pages (images and labels
work). `--split`, `--update-page`, `--restriction`, `--staging-parent`,
`--content-property` and comment import are rejected before anything is
created. A PDF that resolves to a page tree is rejected, not flattened. The
Data Center path is covered by contract tests, not certified against a live
installation.

## Anti-patterns

- Running `--confirm` without having shown the preview for the same inputs.
- Importing into the profile's default space by accident. Pass `--space`.
- Using `wiki import` for Markdown or for editing an existing page's text.
  Use `wiki docs` for that.
- Putting a customer PDF or its extracted text into logs or tickets.

Related: [confluence-pages.md](confluence-pages.md),
[confluence-export.md](confluence-export.md),
[safety.md](safety.md).
