---
name: confluence-export
description: Exporting Confluence pages, page trees and spaces to DOCX or PDF, the export report, exit codes, CI auth and export jobs.
metadata:
  tags: confluence, export, docx, pdf, word, report, jobs
---

# DOCX and PDF export

`atlcli wiki export` renders Confluence content into a Word or PDF file. It only
reads from Confluence and writes the output file plus a local job record. For
Confluence page templates, which are a separate store and an unrelated feature,
see [confluence-templates.md](confluence-templates.md).

## Contents

- [Exporting a page](#exporting-a-page)
- [Scope: tree and space](#scope-tree-and-space)
- [PDF](#pdf)
- [Report and exit codes](#report-and-exit-codes)
- [Word template resolution and management](#word-template-resolution-and-management)
- [Auth for CI](#auth-for-ci)
- [Export jobs](#export-jobs)
- [Anti-patterns](#anti-patterns)

## Exporting a page

```bash
atlcli wiki export 12345678 --output ./report.docx
atlcli wiki export 12345678 --template corporate --output ./report.docx
atlcli wiki export 'DOCS:Architecture' -t ./my-template.docx -o ./arch.docx
atlcli wiki export 12345 -t book -o ./book.docx --scope tree
atlcli wiki export 12345678 --format pdf -o ./report.pdf --json
```

The page reference is positional and accepts a page ID, `SPACE:Page Title`, or
a full Confluence URL. `--output` (`-o`) is required. `--format` is `docx`
(default) or `pdf`.

For DOCX, `--template` (`-t`) is optional. Without it the export uses a bundled
default template and the report carries the info note `template-default-used`.
The engine fills `$scroll.*` placeholders only. A template with docxtpl/Jinja
placeholders (`{{ ... }}`, `{% ... %}`) exports with those left as literal text
and a `template-foreign-placeholders` warning.

An existing DOCX output file is replaced without asking. Confirm the output path
and never overwrite a file the user did not name.

DOCX options:

- `--no-images`: skip embedding attachments (images embed by default).
- `--code-theme <id>`: Shiki theme for code blocks, default `github-light`
  (DOCX and PDF).
- `--no-field-update-prompt` (alias `--no-toc-prompt`): do not ask Word to
  refresh fields on open. A table of contents then shows placeholder text until
  refreshed in Word (select all, F9).
- `--no-live-macros`: skip live macro rendering (Jira, `export_view`,
  attachment macros). It is not an offline mode, the page body still fetches.
- `--keep-ignored`: keep `scroll-only` and `scroll-ignore` content, for
  debugging a single page.
- `--engine ts`: accepted, it is the only engine.
  `--engine python` fails.
- `--strict`: exit code 2 when the export has warnings (see below).

## Scope: tree and space

```bash
atlcli wiki export 12345678 --scope tree -t corporate -o ./handbook.docx
atlcli wiki export --scope space --space DOCS --label-exclude internal \
  --completeness partial -t corporate -o ./docs-space.docx --json
```

`--scope page|tree|space` (default `page`). Tree and space exports yield one
file with chapters following the page hierarchy. `--space <KEY>` implies
`--scope space`, uses the homepage as root and takes no page reference.
`--include-children` is a deprecated alias for `--scope tree`.

- `--max-depth <n>`: depth cap, the root is 0.
- `--max-pages <n>` (default 500), `--max-folders <n>` (default 200): hard caps,
  exceeding one fails with exit 5 before any body is fetched.
- `--label-include a,b` keeps only pages with any of these labels,
  `--label-exclude c,d` drops pages with any of them.
  `--label-exclude-mode prune-subtree` (default) or `page-only`. An include
  filter that matches nothing fails with exit 5.
- `--completeness strict` (default) aborts on an unreadable or changed page,
  `partial` writes a placeholder chapter and sets `complete: false`.

## PDF

`--format pdf` produces a tagged PDF with the built-in Editorial Indigo design:
cover, table of contents, running header, page numbers, closing page. Extra
options:

- `--out-dir <dir>` instead of `--output`: derived `<pageId>-<slug>.pdf` name.
  Never both.
- `--force`: overwrite an existing regular file. Without it an existing output
  file is kept and the export fails with "Output file already exists".
- `--no-cover`, `--no-toc`, `--no-closing-page`: leave a page out.
- `--template <pack>`: a verified `.wiki-pdf-template` file, or `report` for the
  built-in Report template (no cover or closing page, title block on page 1).
  The pack is validated before Confluence is contacted.
- `--pdf-standard <name>`: strict PDF/A or PDF/UA output (`a-1b`, `a-1a`,
  `a-2b`, `a-2u`, `a-2a`, `a-3b`, `a-3u`, `a-3a`, `a-4`, `a-4f`, `a-4e`, `ua-1`).
- `--pdf-images original|standard|print` and `--pdf-images-ppi <72-1200>`:
  downscale raster images. The PPI needs `standard` or `print`.
- `--exported-at <ISO8601>` (or `SOURCE_DATE_EPOCH`): fix the export date for
  reproducible output. `--no-cache`: do not keep downloaded assets between runs.
- `--engine` is invalid with PDF.

Page-size, header text, watermark and similar settings are not CLI flags. A
branded design comes from a template pack made with `atlcli pdf-template`, a
top-level command group that works on local files only:

```bash
atlcli pdf-template import ./brand.docx     # analyze a Word design into a project
atlcli pdf-template review ./brand-pdf-template
atlcli pdf-template preview ./brand-pdf-template
atlcli pdf-template build ./brand-pdf-template --output ./brand.wiki-pdf-template
```

`review` is interactive in a terminal; add `--apply-ready --non-interactive`
to apply only the changes it rates ready. `build` never overwrites an existing
output file. `pdf-template` is not `wiki template`. The full PDF options and
the template pack workflow are in [confluence-pdf.md](confluence-pdf.md).

## Report and exit codes

With `--json` (or `--report json`) stdout carries exactly one
`atlcli.export-report/1` document for DOCX and PDF alike, and progress goes to
stderr as JSONL. Useful fields: `sourcePages`, `outputs`, `issues` (each with
`code`, `severity`, `phase`), `warnings`, `errors`, `notesByCode`, `complete`,
`requestedScope`/`resolvedScope` (tree and space), `exitCode`.

Severity is `error`, `warning` or `info`. Only warnings and errors count for
`--strict`.

| Exit | Meaning |
|------|---------|
| 0 | Success |
| 1 | Usage, config or local IO error |
| 2 | Completed with warnings (only with `--strict`) |
| 3 | Authentication error (401/403) |
| 4 | Remote/API error |
| 5 | Compile or validation failure (tree limits, label filters, budgets) |
| 130 | Cancelled |

Missing chapters are always explained by an issue in the report, most often
`label-filtered`. Check `notesByCode` before assuming a bug. Embedded images
over 50 MB in total abort the export (`asset-budget-exceeded`); narrow the
scope or use `--no-images`.

## Word template resolution and management

`--template` names resolve in order, first match winning:

1. a direct file path
2. `.atlcli/templates/confluence/<name>.docx` in the project
3. `~/.atlcli/profiles/<profile>/templates/confluence/<name>.docx`
4. `~/.atlcli/templates/confluence/<name>.docx`

`.docm` works too.

```bash
atlcli wiki export template list
atlcli wiki export template save corporate --file ./template.docx --level global
atlcli wiki export template delete corporate --confirm
```

`--level` is `global` (default), `profile` or `project`. Both write verbs change
local files only.

## Auth for CI

Without a stored profile, pass the connection per call: `--base-url` (HTTPS
unless `--allow-http`), `--email` (api-token only), `--auth-type
api-token|bearer`, or the env vars `ATLCLI_BASE_URL`, `ATLCLI_EMAIL`,
`ATLCLI_AUTH_TYPE`. The token comes from `ATLCLI_API_TOKEN` only. Use a named
`--profile` or the full ephemeral set, never a mix. Jobs from ephemeral
credentials cannot be replayed later.

## Export jobs

Every export is recorded as a job under `~/.atlcli/export-jobs/v1` before the
first Confluence read. The command still runs in the foreground; `--detach` is
not supported. Another terminal can inspect it:

```bash
atlcli wiki export jobs list --status failed --since 7d --json
atlcli wiki export jobs show <id> --json
atlcli wiki export jobs watch <id> --jsonl
atlcli wiki export jobs cancel <id>
atlcli wiki export jobs resume <queued-id>
atlcli wiki export jobs retry <failed-id> --output ./retry.docx
atlcli wiki export jobs rerun <succeeded-id> --output ./copy.pdf
atlcli wiki export jobs clear --before 30d --confirm
```

`list` also takes `--format docx|pdf`. `retry` and `rerun` create a new linked
job and need a new `--output` or `--force` to replace the earlier file. `clear`
removes terminal history and needs `--confirm`.

## Anti-patterns

- Overwriting a DOCX the user did not name. DOCX replaces silently, PDF needs
  `--force`.
- Treating exit 0 as proof that nothing is missing. Under `--completeness
  partial` read `complete` and `notesByCode`.
- Mixing `--profile` with `--base-url`/`--email`. It fails.

Related: [confluence-pages.md](confluence-pages.md),
[confluence-templates.md](confluence-templates.md).
