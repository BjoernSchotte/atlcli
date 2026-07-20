---
title: "DOCX and PDF Export"
description: "Export Confluence pages to Word or tagged PDF"
---

# DOCX and PDF Export

Export Confluence pages to Microsoft Word (DOCX) with customizable templates, or use
the browser extension to create a tagged PDF with the built-in atlcli document design.

## On this page

- [Browser extension: PDF export](#browser-extension-pdf-export)
- [CLI: DOCX quick start](#quick-start)
- [CLI: PDF export](#cli-pdf-export)
- [Rendering engines](#rendering-engines)
- [Tree and space export](#tree-and-space-export)
- [Templates](#templates)
- [Table of contents](#table-of-contents)
- [Template variables](#template-variables)
- [Troubleshooting](#troubleshooting)

## Browser extension: PDF export

The PDF path is additive: **Export to Word** and its template upload continue to work as
before. On a loaded Confluence page, select **Export to PDF**. The extension prepares
attachments and diagrams, compiles the page in a background worker, validates the result,
and downloads `<page-title>.pdf`.

The completion report separates preparation, compilation, and download time. Preparation
includes authenticated attachment fetching, so image-heavy pages can be distinguished from
a slow compiler without enabling debug logging.

PDF currently uses one built-in standard design. It includes a cover, computed table of
contents, promoted heading hierarchy, running header, page-number footer, callouts, status
badges, syntax-highlighted code, tables, images and vector Mermaid diagrams. Custom PDF
template upload is not available yet.

### PDF support and limits

| Area | Behavior |
|------|----------|
| PDF profile | Tagged PDF; no PDF/UA or PDF/A conformance claim |
| Fonts | Bundled Source Serif 4, Source Sans 3 and Source Code Pro; no system-font or CDN dependency |
| Attachments | PNG, JPEG, GIF, WebP and safe SVG; 25 MB per file, 50 MB total |
| External images | Not fetched; exported as a readable fallback with a report note |
| Mermaid | Supported diagrams remain vector SVG; failures become readable source code |
| Job storage | 64 MB per input/output and 128 MB total temporary browser storage |
| Compiler timeout | 60 seconds; the compiler worker is terminated and recreated |

The extension validates image magic bytes, rejects active or externally loaded SVG content,
and validates that the compiled PDF has pages, tags and embedded fonts before download.
Compilation, the template and fonts are fully local. Network requests during PDF export are
limited to the active `*.atlassian.net` tenant and authenticated attachment redirects to
`api.media.atlassian.com`.

The generated PDF is tagged by default, but tagged output is not the same as certified
PDF/UA. The pinned browser compiler does not expose PDF/UA-1 profile selection, so atlcli does
not make that claim.

## Prerequisites

- Authenticated profile (`atlcli auth login`)
- **Space permission**: View permission on pages to export
- Word-compatible template file (`.docx` or `.docm`)

## Quick Start

```bash
# Export a page using a template
atlcli wiki export 12345678 --template corporate --output ./report.docx

# Export using space:title format
atlcli wiki export "DOCS:Architecture Overview" -t report -o ./arch.docx
```

## CLI: PDF export

`--format pdf` produces a tagged, font-embedded PDF entirely headless — no browser, no
Python, no data leaving your runner. It uses the same built-in document design as the
browser extension (cover, computed table of contents, running header, page-number footer,
callouts, code, tables, images, and vector Mermaid diagrams). PDF templates are not yet
configurable from the CLI; `--template` and `--engine` are therefore **not** valid with
`--format pdf`.

### Prerequisites

- An authenticated profile (`atlcli auth login`) **or** the profile-free environment
  variables described under [Profile-free auth](#profile-free-auth-for-ci).
- View permission on the page(s) to export.

### Minimal example

```bash
# One page → a tagged PDF, with a machine-readable report on stdout
atlcli wiki export 12345678 --format pdf --output ./report.pdf --json
```

### Advanced example

```bash
# A whole page tree → ONE PDF (chapters), dropping internal pages, into a CI dir
atlcli wiki export 12345678 --format pdf --scope tree \
  --label-exclude internal --out-dir dist --report json --strict
```

`--scope tree|space` always yields **exactly one** PDF (chapters follow the page
hierarchy), never one file per page. `--output` names that single file; `--out-dir`
chooses a directory and derives a deterministic `<pageId|spaceKey>-<slug>.pdf` name.
Pass one or the other, never both.

### PDF options

| Option | Description |
|--------|-------------|
| `--output, -o <path>` | Output file path (or use `--out-dir`) |
| `--out-dir <dir>` | Write a derived filename into this directory |
| `--force` | Overwrite an existing **regular** file (never a symlink or directory) |
| `--strict` | Exit code `2` if the export completed with any warning |
| `--no-cache` | Do not persist downloaded assets across invocations |
| `--exported-at <ISO8601>` | Fix the export timestamp (reproducible builds; also honors `SOURCE_DATE_EPOCH`) |
| `--report json` | Synonym for `--json` |

All [scope and label options](#scope-options---engine-ts) work with `--format pdf` too.

The output is written atomically: the bytes go to an exclusive-create temp file in the
target directory and are renamed into place only on success, so a failed or cancelled run
never leaves a partial or clobbered file for a CI artifact step. By default an existing
file is **not** overwritten (`--force` opts in, for regular files only).

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Usage / config / local IO error |
| `2` | Completed with warnings (only under `--strict`) |
| `3` | Authentication error (401/403) |
| `4` | Remote/API error (page not found, fetch failed) |
| `5` | Compile / validation failure |
| `130` | Cancelled (Ctrl-C / SIGINT) |

These codes are derived from classified errors (HTTP status, compiler phase), not from
string-matching messages, and apply to the whole export command. Under `--json` /
`--report json`, stdout carries **exactly one** `atlcli.export-report/1` document; progress
goes to stderr.

### Profile-free auth (for CI)

Run with no `~/.atlcli/config.json` by supplying the base URL, auth type, and token
directly. The mode is **fail-closed** — a named `--profile` OR a full ephemeral set, never a
mix:

```bash
export ATLCLI_API_TOKEN="$CONFLUENCE_TOKEN"      # required
atlcli wiki export 12345678 --format pdf -o out.pdf \
  --base-url mysite.atlassian.net --email ci@example.com
```

| Input | Env var | Notes |
|-------|---------|-------|
| `--base-url <url>` | `ATLCLI_BASE_URL` | HTTPS required unless `--allow-http` (Data Center) |
| `--email <addr>` | `ATLCLI_EMAIL` | Required for `api-token`; forbidden for `bearer` |
| `--auth-type <kind>` | `ATLCLI_AUTH_TYPE` | `api-token` (default) or `bearer` |
| token | `ATLCLI_API_TOKEN` | Always from the environment |

A partially specified set (e.g. token + email but no base URL) is a usage error raised
before any config-file or keychain lookup — a gap is never silently filled from a local
profile. `oauth` and `session` auth are out of scope for ephemeral mode.

For a full CI job, see the [Export automation recipe](/recipes/export-automation/).

## Page Reference Formats

| Format | Example | Description |
|--------|---------|-------------|
| Page ID | `12345678` | Numeric Confluence page ID |
| Space:Title | `DOCS:My Page` | Space key and page title |
| URL | `https://...` | Full Confluence page URL |

## Options

| Option | Description |
|--------|-------------|
| `--template, -t` | Template name or path (required) |
| `--output, -o` | Output file path (required) |
| `--no-images` | Don't embed images from attachments |
| `--include-children` | Deprecated alias for `--scope tree` (with `--engine ts`); legacy child-merge with `--engine python` |
| `--no-merge` | Keep children as separate array for template loops (python engine) |
| `--no-toc-prompt` | Disable TOC update prompt in Word |
| `--engine` | Rendering engine: `python` (default) or `ts` (see [Rendering Engines](#rendering-engines)) |
| `--profile` | Use a specific auth profile |

### Scope options (`--engine ts`)

These flags turn a single-page export into a tree or whole-space export. They
require `--engine ts`; using them with `--engine python` is rejected with a clear
error. See [Tree and space export](#tree-and-space-export).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--scope` | `page` \| `tree` \| `space` | `page` | What to export |
| `--space <KEY>` | string | — | Export a whole space (implies `--scope space`); the homepage is the root chapter. Takes **no** positional page reference |
| `--max-depth <n>` | integer ≥ 0 | unbounded | Cap traversal depth (root = depth 0, so `0` exports the root page only) |
| `--max-pages <n>` | integer ≥ 1 | `500` | Hard page cap; the export aborts early with a suggestion when exceeded |
| `--max-folders <n>` | integer ≥ 1 | `200` | Hard folder cap; same early-abort behavior for folder-heavy trees |
| `--label-include <a,b>` | comma list | — | Keep only pages carrying **any** of these labels (OR) |
| `--label-exclude <c,d>` | comma list | — | Drop pages carrying **any** of these labels (OR) |
| `--label-exclude-mode` | `prune-subtree` \| `page-only` | `prune-subtree` | Whether an excluded page also removes its descendants |
| `--completeness` | `strict` \| `partial` | `strict` | `strict` aborts on an unreadable or changed page; `partial` renders a placeholder chapter and sets `complete: false` |

## Rendering Engines

`atlcli wiki export` can render through two engines:

| Engine | Templates | Requirements | Feature scope |
|--------|-----------|--------------|---------------|
| `python` (default) | Jinja2 variables (`{{ title }}`, …) | Python 3.12+ with `atlcli-export` | Single page + legacy `--include-children` merge, content-by-label |
| `ts` | Scroll placeholders (`$scroll.title`, `$scroll.content`, …) | None (runs in-process) | Single page **plus** page-tree / whole-space export with label filters, chapter merge, working TOC and cross-page links; embeds PNG/JPEG/GIF images (SVG not yet) |

The `ts` engine is the isomorphic [`@atlcli/docx` export engine](/reference/docx-engine/) — the exact
same code the atlcli browser extension uses for its "Export to Word" button, driven here with
filesystem adapters. Pick it when you have a Scroll-Word-Exporter-style template and want an export
with no Python dependency:

```bash
atlcli wiki export 12345678 --template scroll-corporate.docx --output out.docx --engine ts
```

The JSON result includes an export report: how many placeholders resolved, which are unsupported
(rendered empty), and how many images were embedded or skipped. Attachment and external images
embed inline at their intrinsic size (or the page-set width), capped to the content width; an
image that cannot be fetched or decoded becomes a warning note instead of failing the export.
`--no-images` disables embedding for this engine too.

### Mermaid diagrams

The `ts` engine renders fenced ```` ```mermaid ```` code blocks into real vector drawings
(SVG with an automatic PNG fallback for older Word versions) — in the CLI and in the browser
extension alike. Six diagram types are supported: **flowchart, state, sequence, class, ER, and
XY chart**. Any other type (Gantt, Pie, Mindmap, …) and any diagram that fails to render exports
as a readable source code block with a report note naming the reason — never a broken image.
The diagram source is carried as the drawing's alt text.

The CLI rasterizes the PNG fallback with a bundled WebAssembly build of
[resvg](https://github.com/yisibl/resvg-js) and bundled **Inter** and **JetBrains Mono** fonts
(the families the diagrams use), so rendering works identically on every platform with no
browser, system fonts, or other runtime dependencies — including the Homebrew and standalone
binaries. If the rasterizer cannot be loaded, the export still succeeds: mermaid blocks degrade
to source code blocks and the report says so in a note.

Diagram theming follows the export's brand colors when configured; the default is a neutral
light theme matching the code-block styling. Theme colors should be hex values (`#RRGGBB`).

### Migration: `ts` will become the default engine

Today `--engine` defaults to `python`. A future minor release will flip the default to the
in-process `ts` engine (no Python dependency). Nothing changes yet — this is advance notice:

- **Keep today's behavior** by passing `--engine python` explicitly. The python engine is
  not being removed; it stays available behind the flag.
- **Adopt the new default now** with `--engine ts`. It covers single-page **and** tree/space
  export, Scroll-style placeholders, image embedding, and Mermaid diagrams, and needs no
  Python install. Templates use Scroll placeholders (`$scroll.title`) rather than Jinja2
  variables (`{{ title }}`), so a python template must be adapted before switching.
- When `--engine` is omitted and the terminal is interactive, the CLI prints a one-line
  stderr notice about the upcoming change (never on stdout, so `--json` output is unaffected;
  silence it with `ATLCLI_SUPPRESS_ENGINE_NOTICE=1`).
- **Once flipped**, Python is no longer required for export unless you opt back in with
  `--engine python`.

**Flip criteria** (tracked; the flip is its own later PR): the python→ts parity checklist is
green including tree/space and native list numbering, and at least one release has shipped
carrying the deprecation notice above.

## Tree and space export

"Export this handbook" almost never means one page — documentation lives as a page
tree. With `--engine ts`, `atlcli wiki export` can turn a page tree, or a whole
space, into **one** DOCX: chapters follow the page hierarchy (page depth becomes
chapter level), with a working table of contents and working cross-page links.
Label filters curate the result — drop `internal` pages, or keep only `handbook`
ones — the standard migration pattern from established exporter workflows.

The same fetch → compose → serialize pipeline is the library API, and the CLI with
`--json` reports and deterministic exit codes is the automation interface: there is
no hosted job to poll and no data egress to third parties. Automation is the CLI.

### Prerequisites

- Authenticated profile (`atlcli auth login`)
- **View permission** on every page in the tree/space (see [Completeness](#completeness-strict-vs-partial))
- A Word-compatible template (`.docx`/`.docm`)
- `--engine ts` (the scope/label flags require it)

### Steps

1. Find the root page ID (for a tree) or the space key (for a space) — see [Pages](pages.md).
2. Choose a scope: `--scope tree <pageId>` or `--scope space --space <KEY>`.
3. Optionally curate with `--label-include` / `--label-exclude` and bound the walk with `--max-depth` / `--max-pages`.
4. Run the export; add `--json` for a machine-readable report.
5. Open the DOCX and update the TOC field (see [Table of Contents](#table-of-contents)).

### Minimal example

Export a page and all its descendants into one document:

```bash
atlcli wiki export 12345678 \
  --engine ts --scope tree \
  --template corporate --output ./handbook.docx
```

`--include-children` is a deprecated alias for `--scope tree` and still works.

### Advanced example

Export a whole space, drop everything labelled `internal` (and its subtrees),
keep only pages labelled `public`, cap the walk, and emit a JSON report for CI:

```bash
atlcli wiki export \
  --engine ts --scope space --space DOCSY \
  --label-exclude internal --label-exclude-mode prune-subtree \
  --label-include public \
  --max-pages 500 --completeness partial \
  --template corporate --output ./docsy.docx --json
```

### Completeness: strict vs partial

Long tree walks are not a point-in-time snapshot, and permission gaps are common.
The completeness contract makes "looks complete but silently isn't" impossible:

- `--completeness strict` (default) — the export **aborts** if any page is
  unreadable (401/403), returns an ambiguous 404 (deleted vs. no permission), or
  changes version mid-walk. The error names the affected pages.
- `--completeness partial` — each of those becomes a placeholder chapter and a
  structured note, and the report's top-level `complete` is set to `false`.

### JSON report and exit codes

With `--json`, **stdout carries exactly one JSON document** (schema
`atlcli.export-report/1` — the same unified schema the PDF path emits) and
nothing else; progress events go to **stderr** as JSONL (one event per line), and
the human page-count line is suppressed. This is what makes the command safe to
pipe in a headless job:

| Field | Meaning |
|-------|---------|
| `sourcePages` | One entry per exported page: `id`, `title`, compose/fetch notes |
| `outputDetails` / `outputs` | Per-artifact metrics: `embeddedImages`, `renderedDiagrams`, `skippedAssets` (and `pageCount` for PDF) |
| `issues` / `warnings` / `errors` | Structured problems; `notesByCode` is the per-code tally |
| `requestedScope` | The scope as requested (e.g. `space` + `spaceKey`) — `--scope tree`/`space` only |
| `resolvedScope` | The resolved scope (e.g. a `tree` rooted at the homepage id) — `--scope tree`/`space` only |
| `complete` | `false` when partial mode omitted content; present on every successful export |
| `placeholders` | ts-engine placeholder metrics (`resolved`, `unsupported`) — DOCX `--engine ts` only |
| `engine` | `python` or `ts` — DOCX only (the PDF path has a single engine) |
| `timings` | Per-phase wall clocks |
| `exitCode` | The process exit code, embedded for artifact archiving |

**Format parity.** For the same logical request, `--format docx` and
`--format pdf` emit the *same* top-level field set — including `complete` and the
`requestedScope`/`resolvedScope` traceability pair — so a CI job can branch on
`jq -r '.complete'` regardless of output format. The only documented exceptions
are `engine` and `placeholders`, which describe DOCX-engine specifics that have
no PDF equivalent. `requestedScope`/`resolvedScope` are omitted for single-page
exports on **both** formats: there is no scope resolution to trace.

Exit codes follow the [unified table](#exit-codes): `0` success · `1` usage/config ·
`2` warnings under `--strict` · `3` auth · `4` remote/API · `5` compile/validation ·
`130` cancelled.

> **Migration note (schema `atlcli.export-report/v1` → `/1`):** earlier releases
> emitted a DOCX tree/space report with schema string `atlcli.export-report/v1`
> and top-level `counts`/`notes`/`page` fields, and exited `1` on every failure.
> Those fields moved: per-artifact metrics now live in `outputDetails[]`, notes
> in `issues[]` (with `notesByCode` kept), the root page in `sourcePages[]`.
> `requestedScope`/`resolvedScope`/`complete` are unchanged. Exit codes are now
> classified per the table above.

### CI / headless recipe

Automation uses the CLI directly — no hosted job API, no polling. Parse the single
JSON document and branch on `complete` and the note counts:

```bash
#!/usr/bin/env bash
set -euo pipefail

report=$(atlcli wiki export \
  --engine ts --scope space --space DOCSY \
  --label-exclude internal --completeness strict \
  --template corporate --output ./docsy.docx --json)   # progress → stderr

# Fail the build if the export was incomplete.
complete=$(echo "$report" | jq -r '.complete')
if [ "$complete" != "true" ]; then
  echo "Export incomplete:" >&2
  echo "$report" | jq '.notesByCode' >&2
  exit 1
fi

pages=$(echo "$report" | jq -r '.sourcePages | length')
echo "Exported $pages pages to ./docsy.docx"
```

Ctrl-C (or `SIGINT` from a CI timeout) aborts discovery, body fetch, asset
download and the final write promptly; the output file is written atomically, so a
cancelled run never leaves a corrupt or partial `.docx` at the destination.

### Report notes you may see

Missing chapters are never a silent bug — they are always explained by a note:

| Code | Meaning |
|------|---------|
| `label-filtered` | Pages omitted by a label filter (with a count) |
| `root-filter-bypassed` | The root would have been filtered out but was kept as structure |
| `tree-cycle` | A cycle was detected and the repeated node skipped |
| `unsupported-child-type` | A whiteboard/database/embed child was skipped |
| `folder-position-unknown` | A folder has no UI position; ordered by title |
| `heading-depth-clamped` | A heading exceeded level 6 after the chapter shift |
| `link-outside-scope` | A cross-page link points outside the export; linked absolutely |
| `link-anchor-missing` / `link-target-ambiguous` | A link could not be resolved; rendered as text |
| `page-unreadable` / `subtree-unreadable` / `page-ambiguous-404` / `page-version-changed` | Completeness events (abort in `strict`, placeholder in `partial`) |

## Templates

### Template Resolution

Templates are resolved in order (first match wins):

1. Direct file path (if exists)
2. Project: `.atlcli/templates/confluence/<name>.docx`
3. Profile: `~/.atlcli/profiles/<profile>/templates/confluence/<name>.docx`
4. Global: `~/.atlcli/templates/confluence/<name>.docx`

atlcli supports both `.docx` and `.docm` (macro-enabled) templates.

### Template Management

```bash
# List available templates
atlcli wiki export template list

# Save a template
atlcli wiki export template save corporate --file ./template.docx --level global

# Delete a template
atlcli wiki export template delete old-template --confirm
```

### Template Levels

| Level | Location | Use Case |
|-------|----------|----------|
| `project` | `.atlcli/templates/confluence/` | Project-specific templates |
| `profile` | `~/.atlcli/profiles/<name>/templates/confluence/` | Instance-specific templates |
| `global` | `~/.atlcli/templates/confluence/` | Shared across all projects |

## Table of Contents

### Confluence TOC Macro

When a Confluence page contains a `:::toc` macro, it's converted to a Word-native TOC field:

```markdown
:::toc
:::
```

The exported TOC:
- Uses Word's built-in TOC functionality
- Includes heading levels 1-3 with hyperlinks
- Shows placeholder text until updated in Word

### TOC Update Behavior

By default, Word prompts to update fields when opening the document:

> "This document contains fields that may refer to other files. Do you want to update the fields in this document?"

Click **Yes** to populate the TOC with correct entries and page numbers.

### Disabling the Prompt

Use `--no-toc-prompt` to disable the update prompt:

```bash
atlcli wiki export 12345 -t report -o out.docx --no-toc-prompt
```

When using this option:
- Word opens without prompting
- TOC shows placeholder text
- Update manually: right-click TOC, select "Update Field"

## Template Variables

Templates use Jinja2 syntax. Available variables:

### Page Content

| Variable | Description |
|----------|-------------|
| `{{ title }}` | Page title |
| `{{ content }}` | Page content (as Word subdocument) |
| `{{ pageId }}` | Confluence page ID |
| `{{ pageUrl }}` | Full page URL |
| `{{ tinyUrl }}` | Short page URL |

### Author Information

| Variable | Description |
|----------|-------------|
| `{{ author }}` | Creator's display name |
| `{{ authorEmail }}` | Creator's email |
| `{{ modifier }}` | Last modifier's display name |
| `{{ modifierEmail }}` | Last modifier's email |

### Dates

| Variable | Description |
|----------|-------------|
| `{{ created }}` | Creation date (ISO format) |
| `{{ modified }}` | Last modified date (ISO format) |
| `{{ exportDate }}` | Export timestamp |

Use the `date` filter for formatting: `{{ modified | date('YYYY-MM-DD') }}`

### Space Information

| Variable | Description |
|----------|-------------|
| `{{ spaceKey }}` | Space key (e.g., "DOCS") |
| `{{ spaceName }}` | Space name |
| `{{ spaceUrl }}` | Space URL |

### Collections

| Variable | Description |
|----------|-------------|
| `{{ labels }}` | List of page labels |
| `{{ attachments }}` | List of attachments |
| `{{ children }}` | Child pages (with `--include-children --no-merge`) |

## Examples

### Basic Export

```bash
atlcli wiki export 12345678 --template basic --output ./page.docx
```

### Export with Children

```bash
# Merge children into single document
atlcli wiki export 12345 -t book -o book.docx --include-children

# Keep children separate for template loops
atlcli wiki export 12345 -t book -o book.docx --include-children --no-merge
```

### Export without Images

```bash
atlcli wiki export 12345 -t report -o report.docx --no-images
```

### Suppress TOC Prompt

```bash
atlcli wiki export 12345 -t report -o report.docx --no-toc-prompt
```

## Scroll Word Exporter Compatibility

atlcli supports templates created for Scroll Word Exporter. With the default `python` engine,
Scroll placeholders (`$scroll.title`, `$scroll.content`, etc.) are automatically converted to the
equivalent atlcli variables. With `--engine ts`, Scroll placeholders are resolved natively — the
template is scanned, supported placeholders are filled, unsupported ones are emptied and listed in
the export report, and the page body is injected at `$scroll.content`. The logo placeholders
`$scroll.spacelogo` and `$scroll.globallogo` embed the space logo as an image (optionally sized
via `.(height,width)` in px); on Confluence Cloud the global logo is not separately fetchable, so
`$scroll.globallogo` also resolves to the space logo (noted in the report). Default Cloud space
logos are SVGs, which are not embedded yet — upload a custom PNG/JPEG logo to the space for logo
embedding.

`$scroll.includepage.(Title | SPACE:Title | pageId)` embeds the body of another Confluence page
at the placeholder position (a central imprint or disclaimer, reused across exports). The same
target referenced in the body and a header/footer renders in every occurrence; only a page
including itself is blocked. Put the token on its own line — a token sharing a paragraph with
other text is left unexpanded (the surrounding text is preserved). See the
[DOCX engine reference](/reference/docx-engine/#included-pages--scrollincludepage) for argument
forms, budgets, and the full note-code list.

`$scroll.metadata.(key)` (Comala Metadata) is **unsupported**: the value lives in a third-party
app, so the token is emptied and listed in the report with the remedy — map the key to a
Confluence content property in the export settings. (The alias bridge itself is a follow-up; see
below.)

## Troubleshooting

### Word Can't Open the File

- Ensure the template is a valid `.docx` or `.docm` file
- Check that the template was created in Word 2007 or later
- Try opening the template itself to verify it's not corrupted

### TOC Not Updating

- Click inside the TOC
- Right-click and select "Update Field"
- Choose "Update entire table"

### Images Not Appearing

- Verify images are attached to the Confluence page
- Check that `--no-images` flag is not set
- Embedded images use the template's image placeholder styling

### An Included Page Renders Empty

`$scroll.includepage.(…)` blanks the token and adds a report note whenever the reference can't
be rendered. Check the note `code` (in `--json` under the report's `issues`/`notesByCode`):

- `includepage-invalid-context` — the token shares a paragraph with other text; put it on its
  own line.
- `includepage-unresolved` — the name matches no page, or the export credential can't read it
  (Cloud makes 403 and 404 indistinguishable). Verify the title/space or use the `(pageId)` form.
- `includepage-ambiguous-title` — several pages share the title; the first (id-sorted) rendered.
  Disambiguate with `SPACE:Title` or `(pageId)`.
- `includepage-auth-failed` / `includepage-rate-limited` / `includepage-transient-error` —
  credential, throttling, or network/5xx problem; fix the credential or retry the export.
- `includepage-cycle` — the reference resolved to the page being exported (self-include).
- `includepage-budget-exceeded` — more than 25 unique included pages (or 2 MiB of included
  storage); later new targets are blanked.

### "require --engine ts" Error

The scope, label, completeness and traversal flags are only implemented by the
`ts` engine. Add `--engine ts` (the `python` engine only does single-page export
and the legacy `--include-children` merge).

### "exceeds the maximum of N pages"

The tree/space is larger than `--max-pages` (default 500). Narrow the scope with
`--max-depth` or label filters, or raise `--max-pages`. The same guard exists for
folders (`--max-folders`, default 200).

### Export Aborted on an Unreadable Page

In the default `strict` mode a single unreadable/changed page aborts the export so
a document that *looks* complete can never silently omit content. Either fix the
permission gap, or re-run with `--completeness partial` to render a placeholder
chapter and continue (`complete` will be `false` in the report).

### A Space Has No Homepage

`--scope space` uses the space homepage as the root chapter. A folder-only space
root has no classic homepage; export a specific page tree with
`--scope tree <pageId>` instead.

### Missing Chapters

Missing pages are always explained by a report note (see
[Report notes](#report-notes-you-may-see)) — most often `label-filtered`. Check
the `--json` report's `notesByCode` before assuming a bug.

## Related Topics

- [Pages](pages.md) - Page operations and finding page IDs
- [Labels](labels.md) - Managing the labels that `--label-include`/`--label-exclude` filter on
- [Attachments](attachments.md) - Managing page attachments for export
- [Templates](templates.md) - Page templates (different from export templates)
- [DOCX Export Engine](../reference/docx-engine.md) - The reusable `@atlcli/docx` engine behind `--engine ts`
- [PDF Export Engine](../reference/pdf-engine.md) - Browser compiler, assets and verification
