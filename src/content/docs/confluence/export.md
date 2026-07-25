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
- [CLI: PDF export](#cli-pdf-export) and [document settings](#document-settings-are-not-cli-flags-yet)
- [ADF source selection and rollback](#adf-source-selection-and-rollback)
- [Rendering runtime](#rendering-runtime) and [migrating from the Python exporter](#migrating-from-the-python-exporter)
- [Export activity and recovery](#export-activity-and-recovery)
- [Tree and space export](#tree-and-space-export)
- [Note codes](#note-codes-are-shared-across-formats) and [migrating retired codes](#migrating-retired-note-codes)
- [Note severity and `--strict`](#note-severity-and---strict)
- [Templates](#templates)
- [Table of contents](#table-of-contents) and [caption numbering](#caption-numbering)
- [Template variables](#template-variables)
- [Troubleshooting](#troubleshooting)

## Browser extension: PDF export

On a loaded Confluence page, open the side panel and select **Export to PDF**. The
extension prepares attachments and diagrams, compiles the page in a background worker,
validates the result, and downloads `<page-title>.pdf`. **Export to Word** works the same
way with an uploaded `.docx` template.

The completion report separates preparation, compilation, and download time. Preparation
includes authenticated attachment fetching, so image-heavy pages can be distinguished from
a slow compiler without enabling debug logging.

PDF uses one built-in document design — cover, computed table of contents, promoted
heading hierarchy, running header, page-number footer, callouts, status badges,
syntax-highlighted code, tables, images and vector Mermaid diagrams. There is no PDF
template upload in any host; the design is configured through **settings** instead.

The panel does three things this page's CLI does not: it configures those
[document settings](/reference/pdf-template-settings/), it can
[preview](/extension/export/#preview) the PDF before downloading, and it runs exports in
the background so a whole-space export is something you can walk away from. See
[Exporting from the panel](/extension/export/) for the full walkthrough and
[Browser extension](/extension/) for installation.

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
- Optional Word-compatible template file (`.docx` or `.docm`). Without one,
  DOCX uses the [bundled default template](#the-bundled-default-template).

## Quick Start

```bash
# No template needed: DOCX falls back to its bundled default
atlcli wiki export 12345678 --output ./report.docx

# Export a page using a template
atlcli wiki export 12345678 --template corporate --output ./report.docx

# Export using space:title format
atlcli wiki export "DOCS:Architecture Overview" -t report -o ./arch.docx
```

## ADF source selection and rollback

Cloud DOCX (TypeScript engine) and PDF exports read Atlas Doc Format (ADF) as
their primary page body, validate it under bounded resource limits, and decode
it into the same neutral document model used by both renderers. Data Center
remains Storage-based. Storage is also retained as a Cloud sidecar for macros
and definitions that do not yet have an ADF-native equivalent.

Typed legacy emoji use one resolver in both source paths: Cloud ADF `emoji`
and Data Center/compatibility Body Storage `ac:emoticon` apply the same
portable catalog when the typed source has no usable Unicode text. Existing
source Unicode remains exact, so a platform-supplied display sequence can
differ from the catalog projection. Ordinary text that merely looks like a
shortcode remains literal. See
[Supported Emoticons](/confluence/macros/#supported-emoticons) for the complete
canonical and alias table, graphical projections, and custom emoji limits.

Standard callouts also share one renderer contract. The neutral model supports
`info`, `note`, `warning`, `tip`, `success`, and `error`; each receives a
deterministic graphical icon in DOCX and PDF. Current Cloud ADF live evidence
contains native `info`, `note`, `warning`, `success`, and `error` panels.
Although the pinned schema recognizes `tip`, the tested Cloud editor normalized
an authored tip to `info`; Body Storage retains a distinct `tip` macro. The
icon carries a target-native accessibility label (`descr` in DOCX and figure
`alt` in PDF); atlcli does not add a second visible kind label. An explicit
source icon wins, and a generic/custom panel stays iconless unless the source
supplies one.

Data Center and Storage rollback exports apply the same defaults to the
supported Body Storage `info`, `note`, `warning`, and `tip` macros. Their
documented `icon=false` parameter suppresses the default icon in both formats.
This keeps the source contract intact instead of inventing an icon that the
Confluence page explicitly disabled.

`ATLCLI_EXPORT_SOURCE` is the single deployment rollback switch. It changes
only the source adapter; it does not fork DOCX/PDF rendering, bypass version
checks, or become part of a durable export-job request.

| Variable | Type | Default | Required | Constraints |
|----------|------|---------|----------|-------------|
| `ATLCLI_EXPORT_SOURCE` | string enum | `adf` | No | Exactly `adf` or `storage`; any other value fails before a page read |

Minimal rollback example:

```bash
ATLCLI_EXPORT_SOURCE=storage atlcli wiki export 12345678 --format pdf -o report.pdf
```

Use `storage` only as an operational rollback while investigating an ADF source
regression. The export report emits `adf-storage-fallback`, making the policy
choice visible. Remove the variable (or set it to `adf`) to restore the default.

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
| `--strict` | Exit code `2` if the export completed with any **warning**- or **error**-severity issue (informational notes never trip it — see [Note severity](#note-severity-and---strict)) |
| `--no-cache` | Do not persist downloaded assets across invocations |
| `--exported-at <ISO8601>` | Fix the export timestamp (reproducible builds; also honors `SOURCE_DATE_EPOCH`) |
| `--report json` | Synonym for `--json` |

All [scope and label options](#scope-options) work with `--format pdf` too.

### Document settings are not CLI flags (yet)

Page size, orientation, cover and outline toggles, header/footer text, organization name,
accent color, a logo, and a watermark are all real, validated inputs to the PDF template —
documented in full under [PDF Template Settings](/reference/pdf-template-settings/) — and
the [browser panel](/extension/export/#document-settings-pdf) exposes every one of them.

**The CLI does not.** `atlcli wiki export --format pdf` always produces the default
document design. There is no `--page-size`, no `--watermark`, no `--accent-color`. If you
need a branded PDF from CI today, that is not yet possible from flags; the settings are
reachable from the [library API](/reference/export-api/) (`RunPdfExportInput.settings`) and
from the panel.

The output is written atomically: the bytes go to an exclusive-create temp file in the
target directory and are renamed into place only on success, so a failed or cancelled run
never leaves a partial or clobbered file for a CI artifact step. By default an existing
file is **not** overwritten (`--force` opts in, for regular files only).

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Usage / config / local IO error |
| `2` | Completed with warnings (only under `--strict`; [informational notes do not count](#note-severity-and---strict)) |
| `3` | Authentication error (401/403) |
| `4` | Remote/API error (page not found, fetch failed) |
| `5` | Compile / validation failure |
| `130` | Cancelled (Ctrl-C / SIGINT) |

These codes are derived from classified errors (HTTP status, compiler phase), not from
string-matching messages, and apply to the whole export command. Under `--json` /
`--report json`, stdout carries **exactly one** `atlcli.export-report/1` document; progress
goes to stderr.

### Note severity and `--strict`

Every entry in the report's `issues[]` carries a `severity`:

| Severity | Meaning | Counts toward `--strict`? |
|----------|---------|---------------------------|
| `error` | The export failed, or the produced artifact is wrong | Yes |
| `warning` | The export completed, but something in the output is not right — an image did not embed, a link did not resolve, an image has no alt text | Yes |
| `info` | An observation about a **correct** export — timings, a label filter doing exactly what you asked, a macro that rendered successfully | No |

`warnings` and `errors` are convenience views over `issues[]` filtered by severity. There is
deliberately no `infos` array: read informational entries off `issues[]` or `notesByCode`.

```bash
# Everything the export observed, grouped by how much you should care
jq -r '.issues[] | "\(.severity)\t\(.code)\t\(.phase)"' report.json
```

:::note[Behavior change: informational notes no longer fail `--strict`]
Earlier releases reported **every** note as `severity: "warning"`, whatever the exporter
actually said about it. Because the DOCX engine appends a `perf-timing` note to every
export, a DOCX `--strict` run exited `2` even on a completely clean run, while
`--format pdf` on the same page exited `0`.

`severity` now mirrors the note's own level. Notes that describe a correct export —
`perf-timing`, `label-filtered`, `root-filter-bypassed`,
`folder-position-unknown`, `link-outside-scope`, `macro-rendered-via`,
`macro-skipped-by-config`, `placeholder-substituted`, `image-skipped`,
`diagram-skipped`, `list-nesting-clamped`, `table-shape-approximated` and the other
`info`-level codes — are still reported in full, but no longer inflate `warnings[]` or
fail a `--strict` build. Genuine warnings (`image-unresolved`, `image-embed-failed`,
`image-missing-alt`, `tree-cycle`, `heading-depth-clamped`, `link-anchor-missing`,
`link-target-ambiguous`, `mention-unresolved`, the PDF/UA audits, …) are unchanged and
still exit `2` under `--strict`. Severity is per **occurrence**, not per code:
`macro-degraded`, for instance, is a warning when a macro could not be fetched and
informational when an include hit its own depth limit and emitted a placeholder.

The schema string stays `atlcli.export-report/1`; the only contract widening is the new
`info` member of the `severity` enum. If you validate the report against a **pinned copy**
of the JSON Schema, widen that enum. If you gate on `jq '.warnings | length'`, expect it to
drop — that is the fix, not a regression.
:::

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

## Export activity and recovery

Every CLI DOCX and PDF export is recorded as a durable job before the first
Confluence API read. The normal export command remains foreground: it claims its own job,
prints progress on stderr, writes the artifact atomically, and emits the existing final
report on stdout. There is no CLI daemon and no `--detach` mode.

The journal lets another terminal inspect or cancel the running export, and keeps terminal
history for diagnostics and replay:

```bash
# Inspect work across DOCX and PDF
atlcli wiki export jobs list
atlcli wiki export jobs show <job-id>
atlcli wiki export jobs watch <job-id>

# Request cancellation from another process
atlcli wiki export jobs cancel <job-id>

# Resume the same checkpointed row after its foreground process was lost
atlcli wiki export jobs resume <queued-job-id>

# Failed/cancelled jobs can be retried; successful jobs can be run again
atlcli wiki export jobs retry <job-id> --output ./retry.docx
atlcli wiki export jobs rerun <job-id> --output ./copy.pdf
```

`retry` and `rerun` create a new linked job; they never rewrite the source history row.
Without a new `--output`, the retained output policy applies again. A successful rerun does
not silently replace its earlier file: pass a new path, or explicitly authorize replacement
with `--force`.

Use `--json` with `list`, `show`, `cancel`, `retry`, `rerun`, or `clear`, and `--jsonl`
with `watch`. Non-TTY monitoring emits stable lines without ANSI control sequences.
Cleanup is confirmation-gated and touches terminal history only:

```bash
atlcli wiki export jobs clear --before 30d --confirm
```

State lives under `~/.atlcli/export-jobs/v1` with private directory/file modes. Set
`ATLCLI_EXPORT_JOBS_DIR` only when a managed host or isolated test needs a different
location. Requests and activity contain opaque auth references and operational metadata,
never tokens or source bodies. Jobs created with process-only ephemeral credentials cannot
be replayed later without submitting a new authenticated export.

`show` acknowledges a terminal job; `list` and `watch` do not. Artifacts remain protected
until delivery and are then retained for at least 24 hours. Full reports/events remain for
7 days, while compact history is bounded to the newest 100 jobs younger than 30 days.
See [Export Jobs & Operations](/reference/export-jobs/) for lifecycle states, retention,
storage layout, recovery, and incident diagnostics.

## Page Reference Formats

| Format | Example | Description |
|--------|---------|-------------|
| Page ID | `12345678` | Numeric Confluence page ID |
| Space:Title | `DOCS:My Page` | Space key and page title |
| URL | `https://...` | Full Confluence page URL |

## Options

| Option | Description |
|--------|-------------|
| `--format <fmt>` | `docx` (default) or `pdf`. With `pdf`, `--template` and `--engine` are not valid — see [CLI: PDF export](#cli-pdf-export) |
| `--template, -t` | Optional DOCX template name or path. Without it, DOCX uses the [bundled default template](#the-bundled-default-template) |
| `--output, -o` | Output file path (required) |
| `--no-images` | Don't embed images from attachments |
| `--include-children` | Deprecated alias for `--scope tree` |
| `--no-field-update-prompt` | Never ask Word to refresh fields on open (see [Field update behavior](#field-update-behavior)). Alias: `--no-toc-prompt` |
| `--keep-ignored` | Keep `scroll-only`/`scroll-ignore` bodies for debugging. Single page only; the report is marked `export-controls-passthrough` — see [Keeping ignored content](/confluence/scroll-macros/#keeping-ignored-content-for-debugging) |
| `--no-live-macros` | Deterministic export: skip live (Jira / `export_view` / attachment) macro rendering. Pure macros still render. This is **not** an offline mode — see [Deterministic exports](/confluence/dynamic-macros/#deterministic-exports) |
| `--engine ts` | Optional compatibility spelling for the only DOCX engine. Accepted so existing scripts keep working; `--engine python` fails with a migration message — see [Migrating from the Python exporter](#migrating-from-the-python-exporter) |
| `--profile` | Use a specific auth profile |
| `--json` / `--report json` | Emit exactly one `atlcli.export-report/1` document on stdout |

### Scope options

These flags turn a single-page export into a tree or whole-space export. See
[Tree and space export](#tree-and-space-export).

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

## Rendering runtime

DOCX uses the isomorphic TypeScript [`@atlcli/docx` export engine](/reference/docx-engine/).
PDF uses the Typst compiler packaged as WebAssembly. The CLI and browser hosts bind their
own storage, authentication and delivery adapters around these portable engines. Neither
format shells out to a second runtime, so `bun install` is the whole toolchain — there is
no Python to install on a developer machine or a CI runner.

DOCX templates use Scroll placeholders such as `$scroll.title` and
`$scroll.content`. The JSON report includes placeholder, image and diagram statistics.
Attachments embed inline at their intrinsic size, capped to the content width; a missing or
invalid image becomes a report issue instead of silently disappearing. `--no-images`
disables DOCX image embedding.

```bash
atlcli wiki export 12345678 --template scroll-corporate.docx --output out.docx
```

### Migrating from the Python exporter

atlcli used to ship a second DOCX exporter written in Python (`--engine python`). It has
been **removed**. If you still pass the flag, the export stops with a message pointing here
rather than quietly producing a different document.

**Step 1 — drop the flag.** `atlcli wiki export … --engine python` becomes
`atlcli wiki export …`. There is nothing to install in its place: the TypeScript engine is
built in. `--engine ts` is still accepted, so a script that already passes it needs no edit.

**Step 2 — port the template.** This is the only part that is not automatic. The Python
exporter used docxtpl/Jinja placeholders; the TypeScript engine fills `$scroll.*`
placeholders and deliberately does not evaluate executable template expressions.

| Python exporter (docxtpl/Jinja) | TypeScript engine |
|---|---|
| `{{ title }}` | `$scroll.title` |
| `{{p content }}` | `$scroll.content` |
| `{{ spaceName }}` | `$scroll.space.name` |
| `{{ spaceKey }}` | `$scroll.space.key` |
| `{{ author }}` | `$scroll.creator.fullName` |
| `{{ modified \| date('YYYY-MM-DD') }}` | `$scroll.modificationdate.(yyyy-MM-dd)` |
| `{{ exportDate \| date('…') }}` | `$scroll.exportdate` (optional `.(…)` format argument) |
| `{% if … %}` / `{% for … %}` | No equivalent — the engine does not run template logic |

[Template Variables](#template-variables) lists the full vocabulary, and
[Scroll Word Exporter Compatibility](#scroll-word-exporter-compatibility) covers what
carries over from Scroll templates.

:::caution[An unported template does not fail — it renders literally]
Left-over `{{ … }}` / `{% … %}` placeholders are carried into the finished document as
**visible literal text**. Nothing fills them. The export reports each one as a
`template-foreign-placeholders` **warning**, so [`--strict`](#exit-codes) turns a
half-migrated template into a failed CI run instead of a document nobody proofread.
:::

If you would rather not port the template at all, drop `--template`: the export falls back
to the [bundled default template](#the-bundled-default-template) and reports
`template-default-used`.

### Mermaid diagrams

The DOCX engine renders fenced ```` ```mermaid ```` code blocks into real vector drawings
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

## Tree and space export

"Export this handbook" almost never means one page — documentation lives as a page
tree. `atlcli wiki export` can turn a page tree, or a whole
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
  --scope tree \
  --template corporate --output ./handbook.docx
```

`--include-children` is a deprecated alias for `--scope tree` and still works.

### Advanced example

Export a whole space, drop everything labelled `internal` (and its subtrees),
keep only pages labelled `public`, cap the walk, and emit a JSON report for CI:

```bash
atlcli wiki export \
  --scope space --space DOCSY \
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
| `issues` / `warnings` / `errors` | Structured problems; `warnings`/`errors` are severity-filtered views over `issues`, and `notesByCode` is the per-code tally over **all** of them (see [Note severity](#note-severity-and---strict)) |
| `requestedScope` | The scope as requested (e.g. `space` + `spaceKey`) — `--scope tree`/`space` only |
| `resolvedScope` | The resolved scope (e.g. a `tree` rooted at the homepage id) — `--scope tree`/`space` only |
| `complete` | `false` when partial mode omitted content; present on every successful export |
| `placeholders` | DOCX placeholder metrics (`resolved`, `unsupported`) |
| `engine` | `ts` for DOCX; omitted for PDF |
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
  --scope space --space DOCSY \
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

Missing chapters are never a silent bug — they are always explained by a note. The
**Severity** column is what `--strict` reads (see [Note severity](#note-severity-and---strict)):

| Code | Severity | Meaning |
|------|----------|---------|
| `label-filtered` | `info` | Pages omitted by a label filter (with a count) — you asked for this |
| `root-filter-bypassed` | `info` | The root would have been filtered out but was kept as structure |
| `tree-cycle` | `warning` | A cycle was detected and the repeated node skipped |
| `unsupported-child-type` | `warning` | A whiteboard/database/embed child was skipped — content you asked for is missing from the export |
| `folder-position-unknown` | `info` | A folder has no UI position; ordered by title |
| `heading-depth-clamped` | `warning` | A heading exceeded level 6 after the chapter shift |
| `link-outside-scope` | `info` | A cross-page link points outside the export; linked absolutely |
| `link-anchor-missing` / `link-target-ambiguous` | `warning` | A link could not be resolved; rendered as text |
| `perf-timing` | `info` | Per-phase wall clocks for the run (DOCX; emitted on every export) |
| `template-foreign-placeholders` | `warning` | The template carries retired docxtpl/Jinja placeholders (`{{ … }}`, `{% … %}`); they stay in the document as literal text |
| `template-default-used` | `info` | No `--template` was given; the [bundled default template](#the-bundled-default-template) produced the document |
| `page-unreadable` / `subtree-unreadable` / `page-ambiguous-404` / `page-version-changed` | `error` / `warning` | Completeness events: `error` when `--completeness strict` aborts the export, `warning` when `--completeness partial` substitutes a placeholder and carries on |

### Note codes are shared across formats

A note code describes a **condition on your content**, not the file format you
asked for. Exporting the same page as DOCX and as PDF therefore produces the same
code for the same problem, and one `notesByCode` key works for both:

| Code | Severity | Emitted when |
|------|----------|--------------|
| `image-missing-alt` | `warning` | An image on the source page has no author-written alt text (PDF notes also carry a `blockPath`; DOCX notes do not) |
| `image-embed-failed` | `warning` | One named image could not be embedded — attachment missing, download failed, unsupported or unsafe bytes |
| `mention-unresolved` | `warning` | An `@mention` account id did not resolve to a display name; the technical id was kept |

Two neighbours are deliberately **not** the same fact, and no amount of similar
naming makes them one:

- `image-skipped` (`info`) means *the export had no image pipeline at all*, so
  every image degraded — e.g. `--no-images`. That is a request you made, not a
  defect, and it never happens on a PDF export (the PDF engine always has an
  image pipeline). Do not treat it as a synonym for `image-embed-failed`.
- `pdf-image-alt-fallback` (`warning`) is the PDF **renderer** reporting that it
  substituted the filename into the tagged `/Alt` entry. `image-missing-alt` is
  the source defect that caused it. The DOCX engine performs the same
  substitution into Word's `descr` silently, so there is nothing to unify.

### Migrating retired note codes

Earlier releases spelled three of these codes differently depending on which
engine — or which host — produced the report. They now use one spelling each:

| Retired code | Emitted today | Why they were the same fact |
|--------------|---------------|------------------------------|
| `pdf-image-missing-alt` | `image-missing-alt` | Both engines apply the identical "no author-written alt text" rule to the same source block, before any download |
| `pdf-image-skipped` | `image-embed-failed` | Both engines emit it at the same point, when one image's bytes could not be obtained. **Note the target:** *not* `image-skipped`, which means something else entirely (see above) |
| `pdf-mention-unresolved` | `mention-unresolved` | The browser extension's spelling of the code both CLI paths already used |

The report `schema` string stays `atlcli.export-report/1` — the shape of the
document has not changed, only three of the values inside it. Nothing emits both
the old and the new code: dual emission would double every affected
`notesByCode` tally and inflate `--strict` warning counts for a single fact.

**If your CI greps for a retired code, update the expression.** A transitional
form that accepts either spelling:

```bash
# Fail when the export left any image without alt text, old or new spelling
jq -e '[.notesByCode // {} | to_entries[]
        | select(.key == "image-missing-alt" or .key == "pdf-image-missing-alt")
        | .value] | add // 0 | . == 0' report.json
```

Programmatic consumers of `@atlcli/confluence` can resolve an old code instead of
matching on strings: `canonicalExportNoteCode("pdf-image-skipped")` returns
`"image-embed-failed"`, and `RETIRED_EXPORT_NOTE_CODES` is the whole table.

## Templates

### Template Resolution

Templates are resolved in order (first match wins):

1. Direct file path (if exists)
2. Project: `.atlcli/templates/confluence/<name>.docx`
3. Profile: `~/.atlcli/profiles/<profile>/templates/confluence/<name>.docx`
4. Global: `~/.atlcli/templates/confluence/<name>.docx`

atlcli supports both `.docx` and `.docm` (macro-enabled) templates.

### The bundled default template

You can omit `--template` entirely. The export then uses a **bundled default
template**: a title heading, an export-date line, the page body, and the Scroll heading styles.
It is built programmatically (no binary asset ships with atlcli) and is byte-deterministic, so
repeated exports of the same page produce the same document.

```bash
# Zero-config: no template to find, install, or maintain
atlcli wiki export 12345678 --output page.docx
```

The report records which template produced the document with a `template-default-used`
**info** note, and in text mode the CLI prints a one-line hint on stderr. Because the note is
informational, it does not fail `--strict`.

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

### Field update behavior

Word only fills in a table of contents, a caption number or a cross-reference when it
*refreshes fields*. The export asks it to, by writing `<w:updateFields w:val="true"/>` into
`word/settings.xml`; Word then prompts on open:

> "This document contains fields that may refer to other files. Do you want to update the fields in this document?"

Click **Yes** to populate the TOC with correct entries and page numbers.

**The prompt appears only when a refresh would change something.** The engine
inspects the finished document — every part, headers and footers included — and sets the flag
when it finds a field whose result is computed:

| Field | Prompt? | Why |
|-------|---------|-----|
| `TOC`, `INDEX`, `TOA`, `BIBLIOGRAPHY` | Yes | Generated from the document body, which the export replaces |
| `SEQ` (caption numbering) | **Only when the export did not number it** | See [Caption numbering](#caption-numbering) below |
| `REF`, `PAGEREF`, `NOTEREF`, `STYLEREF` | Yes | Resolve against content that only exists after the export |
| `INCLUDETEXT`, `INCLUDEPICTURE`, `LINK` | Yes | The cached copy is the template's |
| `FILENAME`, `FILESIZE`, `DATE`, `TIME` | Yes | Computed from the file or the clock |
| `HYPERLINK` | **No** | The link text is stored statically; a refresh changes nothing visible |
| `PAGE`, `NUMPAGES`, `SECTIONPAGES` | **No** | Word recomputes these during pagination on every open anyway |
| `USERNAME`, `ASK`, `FILLIN` | **No** | A refresh would rewrite the document with the *reader's* name or input |

So an ordinary page export — prose, headings, images and links — opens without any prompt, while
a document with a table of contents still gets one. If your template sets `<w:updateFields>`
itself, that setting is left in place.

### Caption numbering

A caption from a `scroll-title` macro is written as a real Word `SEQ` field — so
cross-references, a table of figures, and a manual **F9** all keep working — but the
export also **caches the correct ordinal in the field result**. A document with three
tables reads "Table 1", "Table 2", "Table 3" the moment it is opened, and any tool that
reads `<w:t>` without evaluating fields (a text extractor, a diff, a converter) sees the
same thing.

Because the numbers are already right, a refresh would change nothing, so those captions
alone **do not** earn the update prompt. Numbering is per sequence name and per export:
`code` and `equation` captions share Word's `Listing` sequence and count together, a
tree or space export numbers continuously across chapters, and two exports in the same
process never continue each other's count.

The prompt does come back when the export cannot vouch for the numbers:

- the **template** already contains its own `SEQ` fields of the same sequence name (a
  caption inserted with Word's own *Insert Caption*), which interleave with the exported
  ones and shift the count;
- an **included page** brings its own captions, which restart at 1;
- a `SEQ` field whose sequence name cannot be read, or any other computed numbering field
  (`LISTNUM`, `AUTONUM`, …).

In those cases the cached results are not trustworthy and Word is asked to refresh.

### Disabling the prompt

Use `--no-field-update-prompt` to suppress the refresh request entirely:

```bash
atlcli wiki export 12345 --template report -o out.docx --no-field-update-prompt
```

When using this option:

- Word opens without prompting.
- A TOC shows placeholder text and cross-references stay stale. Captions the export
  numbered itself are already correct (see [Caption numbering](#caption-numbering));
  captions inherited from the template or an included page are not.
- Update manually in Word: select all (**Ctrl+A**), then press **F9**. For a TOC alone,
  right-click it and choose **Update Field**.
- If the document did contain such fields, the export report carries a
  `field-refresh-suppressed` note saying so.

`--no-toc-prompt` is the original spelling of this flag and keeps working. The new name reflects
what the flag actually governs: the refresh covers caption numbering, cross-references and
running heads, not only tables of contents.

## Template Variables

DOCX templates use Scroll Word Exporter placeholders. Jinja/docxtpl syntax is
retired and remains literal text; see
[Jinja placeholders appear in the exported document](#jinja-placeholders-appear-in-the-exported-document).

### Page Content

| Variable | Description |
|----------|-------------|
| `$scroll.title` | Page title |
| `$scroll.content` | Page content insertion point |
| `$scroll.version` | Confluence page version |
| `$scroll.pageid` | Confluence page ID |
| `$scroll.pageurl` | Full page URL |
| `$scroll.tinyurl` | Short page URL |
| `$scroll.pagelabels` | Page labels |
| `$scroll.pagelabels.capitalised` | Capitalized page labels |

### People, Dates, Space, and Template

| Variable | Description |
|----------|-------------|
| `$scroll.creator` / `.fullName` / `.email` | Creator identity |
| `$scroll.modifier` / `.fullName` / `.email` | Last modifier identity |
| `$scroll.pageowner.fullName` | Current page owner |
| `$scroll.exporter` / `.fullName` / `.email` | Exporting user |
| `$scroll.creationdate`, `$scroll.modificationdate`, `$scroll.exportdate` | Dates; optional `.(...)` format argument |
| `$scroll.space.key`, `$scroll.space.name`, `$scroll.space.url` | Space identity |
| `$scroll.template.name`, `$scroll.template.modificationdate` | Template identity |
| `$scroll.spacelogo`, `$scroll.globallogo` | Space-logo image; optional `.(height,width)` in pixels |
| `$scroll.includepage.(Title\|SPACE:Title\|pageId)` | Included page body |

Cloud has no Data Center username value. The `.name` variants for people are
therefore empty with a report note; use `.fullName` or `.email`.

## Examples

### Basic Export

```bash
atlcli wiki export 12345678 --template basic --output ./page.docx
```

### Export with Children

```bash
# One document whose chapters follow the page tree
atlcli wiki export 12345 -t book -o book.docx --scope tree
```

### Export without Images

```bash
atlcli wiki export 12345 -t report -o report.docx --no-images
```

### Suppress the field update prompt

```bash
atlcli wiki export 12345 --template report -o report.docx --no-field-update-prompt
```

A document without computed fields never prompts in the first place — see
[Field update behavior](#field-update-behavior).

## Scroll Word Exporter Compatibility

atlcli supports templates created for Scroll Word Exporter. Scroll placeholders
(`$scroll.title`, `$scroll.content`, etc.) are resolved natively — the
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

### Jinja placeholders appear in the exported document

**Symptom.** The exported `.docx` shows literal `{{ title }}`, `{{ author }}`,
`{% for … %}` (or similar) where a value should be. The report contains:

```
warning  template-foreign-placeholders  prepare
```

**Cause.** The template uses placeholders from the removed docxtpl/Jinja exporter. The
TypeScript engine fills `$scroll.*` only and carries every other brace through untouched, so
Jinja placeholders
survive into the document.

**Fix — pick one:**

1. Rewrite the template's placeholders as `$scroll.*` — see
   [Migrating from the Python exporter](#migrating-from-the-python-exporter) for the
   equivalence table, or
2. drop `--template` and use the
   [bundled default template](#the-bundled-default-template) instead.

Add `--strict` to your CI invocation so this fails the build rather than shipping a document
with visible placeholders.

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

### "exceeds the maximum of N pages"

The tree/space is larger than `--max-pages` (default 500). Narrow the scope with
`--max-depth` or label filters, or raise `--max-pages`. The same guard exists for
folders (`--max-folders`, default 200).

The export **exits 5** before fetching any body, with a `max-pages` (or `max-folders`)
issue at the `fetch` phase carrying the limit in `details.limit`. Nothing is written, so
there is no partial file to clean up.

### "No page matched the include label filter"

**Symptom.** The export stops immediately with:

```
No page matched the include label filter (handbook); nothing to export.
```

Exit code `5`; the report carries an `empty-include-result` issue at the `fetch` phase.

**Cause.** `--label-include` is an OR filter over the labels *actually on the pages in
scope*. No page carried any of the labels you listed — usually a typo, a label applied to
a different space, or a scope that does not reach the labelled pages.

**Why it fails instead of producing an empty document.** A zero-page DOCX or PDF is
indistinguishable from a successful export of a tree that happens to be empty. Failing
loudly makes a mistyped label a build error rather than a silently empty artifact.

**Fix.** Check what a page actually carries with
[`atlcli wiki page label list --id <pageId>`](/confluence/labels/), or find the labelled
pages with `atlcli wiki search --label handbook`. Then widen the scope, or drop
`--label-include` and use `--label-exclude` instead. The related
`labels-unavailable` code means the label API could not be read at all — that is a
permission or connectivity problem, not a filter mistake.

### "Export aborted: embedded images total N MB, over the 50.0 MB limit"

**Symptom.** The export stops during preparation, and the message names the largest
offenders:

```
Export aborted: embedded images total 63.4 MB, over the 50.0 MB limit.
Largest: "architecture-poster.png" (page 12345678) 21.9 MB,
"screenshot-4k.png" (page 12345699) 14.1 MB, … .
Narrow the export with --max-depth or a label filter, or re-run with --no-images.
```

Exit code `5`; the report carries an `asset-budget-exceeded` issue at the `prepare` phase
with `details.totalBytes`, `details.limitBytes`, and a `details.offenders[]` array of
`{ filename, pageId, sizeBytes }` sorted largest-first.

**Cause.** Both engines share one budget: **25 MB per file and 50 MB per export**, counted
over *deduplicated* asset bytes, so the same image reused on ten pages counts once. The
export aborts the moment a new asset would cross the total — before any output is
committed — rather than degrading to a per-image warning, because a document silently
missing its largest diagrams is worse than no document.

**Fix — pick one:**

1. Narrow the export (`--max-depth`, `--label-exclude`) so the heaviest pages are out of
   scope,
2. downscale or remove the named attachments in Confluence, or
3. re-run with `--no-images` when the images are not the point of the document.

The offender list is identical on both engines, so a page that busts the budget as DOCX
busts it as PDF with the same names.

```bash
# The five biggest offenders, from a failed run's report
jq -r '.issues[] | select(.code == "asset-budget-exceeded")
       | .details.offenders[] | "\(.sizeBytes)\t\(.filename)"' report.json | head -5
```

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

- [Export template library](export-templates.md) - Which template an export uses, and why
- [Macro compatibility](macro-compatibility.md) - What each macro produces in each engine
- [Exporting from the panel](/extension/export/) - Scope, settings, preview and background exports
- [Browser extension](/extension/) - Install and limits
- [Pages](pages.md) - Page operations and finding page IDs
- [Labels](labels.md) - Managing the labels that `--label-include`/`--label-exclude` filter on
- [Attachments](attachments.md) - Managing page attachments for export
- [Templates](templates.md) - Page templates (different from export templates)
- [PDF Template Settings](../reference/pdf-template-settings.md) - The settings the panel exposes
- [DOCX Export Engine](../reference/docx-engine.md) - The reusable `@atlcli/docx` engine
- [PDF Export Engine](../reference/pdf-engine.md) - Browser compiler, assets and verification
