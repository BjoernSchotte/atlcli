---
title: "Macro compatibility"
description: "Which Confluence macros survive DOCX and PDF export, and which note each degradation records"
---

# Macro compatibility

One table to answer one question: **if this macro is on the page, what comes out
of the export?**

The answer depends on the output format, so every row below is split by format.
Where a macro degrades, the note code it records is named — a
missing section always has an explanation in the report, never silence.

## On this page

- [Prerequisites](#prerequisites)
- [The two render paths](#the-two-render-paths)
- [Compatibility macros](#compatibility-macros)
- [Structural macros](#structural-macros)
- [Dynamic macros](#dynamic-macros)
- [The fallback chain and the floor](#the-fallback-chain-and-the-floor)
- [Host differences: CLI and panel](#host-differences-cli-and-panel)
- [Note codes](#note-codes)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- An export route: `atlcli wiki export` or the
  [browser extension](/extension/export/).
- DOCX uses the TypeScript engine; PDF uses the Typst/WASM engine.

## The two render paths

| Path | How to get it | Pipeline |
|------|---------------|----------|
| **PDF** | `--format pdf`, or **Export to PDF** in the panel | Cloud ADF or Data Center/rollback Storage → `ExportBlock[]` → Typst |
| **DOCX** | default CLI format, or **Export to Word** in the panel | Cloud ADF or Data Center/rollback Storage → `ExportBlock[]` → OOXML |

**PDF and DOCX share the neutral block model.** Cloud uses validated ADF as the
primary body; Data Center and `ATLCLI_EXPORT_SOURCE=storage` use Body Storage.
Both targets therefore see the same decoded callouts and macro resolution; they
differ only in how a block is drawn.

## Compatibility macros

Macros that control what an export contains and how it is laid out. Full
behaviour in [Scroll compatibility macros](/confluence/scroll-macros/).

| Storage name | PDF | DOCX |
|--------------|-----|------|
| `scroll-only` | Keeps or drops the body per the `exporter` parameter (`pdf` matches) | Same rule, `word` matches |
| `scroll-ignore` | Drops the body (per `exporter`) | Same rule |
| `scroll-only-inline` | Inline variant of the above | Inline variant |
| `scroll-ignore-inline` | Inline variant of the above | Inline variant |
| `scroll-pagebreak` | `#pagebreak(weak: true)` | `<w:br w:type="page"/>` |
| `scroll-landscape` | Block-scoped `#set page(flipped: true)` | Section sandwich using the template's own page size |
| `scroll-portrait` | Flips back to portrait, even inside a landscape document | Section sandwich back to portrait |
| `scroll-title` | `#figure(caption: …, kind: …)` with Typst counters | `Caption`-styled paragraph with a `SEQ` field, numbered in document order |
| any other `scroll-*` | Content kept, warning note | Content kept, warning note |

Two engine differences are worth knowing rather than discovering:

- **Where a break or orientation change is impossible, it is suppressed, not
  faked.** Inside a table cell or a callout, both engines drop the effect and
  keep the content, recording `pagebreak-suppressed-in-container` or
  `orientation-suppressed-in-container`.
- **Caption numbering is native to each format.** PDF numbers through Typst's
  figure counters. DOCX writes a real `SEQ` field *and* caches the correct
  ordinal, so the exported document already reads "Table 1, Table 2, Table 3"
  before anyone presses F9 — while cross-references and a table of figures keep
  working because the field is still a field.

## Structural macros

Converted directly by the storage walker. These never reach the macro resolver
and never make a network call.

| Storage name | PDF | DOCX |
|--------------|-----|------|
| `info`, `note`, `warning`, `tip`, `panel` | Callout block | Callout block |
| `code`, `noformat` | Syntax-highlighted code block | Syntax-highlighted code block |
| `expand` | Body rendered inline (a document cannot collapse) | Body rendered inline |
| `status` | Status badge | Status badge |
| `anchor` | Link target | Bookmark |
| `multiexcerpt`, `multiexcerpt-macro` | Body rendered in place | Body rendered in place |
| `toc` | Computed outline | Word `TOC` field |
| `chart` | Shared TanStack vector SVG plus exact-value table | Shared TanStack SVG with PNG compatibility fallback plus exact-value table |
| ```` ```mermaid ```` fences | Vector SVG; unsupported types degrade to source | Vector SVG with a PNG fallback; unsupported types degrade to source |

The Confluence `chart` macro supports Pie, Bar, Line, Area, XY Area, XY Bar,
XY Line, XY Step, XY Step Area, Scatter, Time Series, and Gantt from Cloud ADF
or Data Center Storage. The table inside the macro is authoritative; a generated
image attachment is only a cache hint. See the [cross-output chart guide](/publishing/charts/)
for parameters, strict diagnostics, limits, and the Astro interaction profile.

Mermaid support covers **flowchart, state, sequence, class, ER and XY chart**.
Any other type, and any diagram that fails to render, becomes a readable source
block with a note — never a broken image.

Standard `info`, `note`, `warning`, and `tip` macros receive labelled graphical
icons in both formats. Body Storage `icon=false` suppresses that default. A
generic `panel` remains iconless unless it carries an explicit source icon.
Cloud ADF additionally has native `success` and `error` panel kinds; they use
the same color-independent icon contract. In the current live Cloud editor,
an authored tip was normalized to `info`; the shared model still supports
schema-valid ADF `tip` and the distinct Storage/DC `tip` macro. Explicit
custom-panel icons always take precedence over a semantic default.

## Dynamic macros

Macros whose content lives somewhere other than the page. "Live" renderers make
a request; "Pure" ones read only what has already been fetched. Full behaviour in
[Exporting pages with dynamic macros](/confluence/dynamic-macros/).

| Storage name | Kind | PDF | DOCX |
|--------------|------|-----|------|
| `jira`, `jiraissues` | Live | Issue table | Issue table |
| `data-datasource` links (issue tables, content lists) | Live | Themed table, 100-row cap | Themed table, 100-row cap |
| `drawio`, `inc-drawio`, `drawio-sketch`, `gliffy` | Live | Preview image | Preview image |
| `include` | Live | Included body | Included body |
| `excerpt-include` | Live | Included excerpt | Included excerpt |
| `excerpt` | Pure | Body in place | Body in place |
| `children` | Live | Child-page list | Child-page list |
| `detailssummary` | Live | Report table | Report table |
| `multiexcerpt-include-macro`, `multiexcerpt-include` | Live | Included body | Included body |
| `scroll-tablelayout`, `scroll-tablelayout-macro` | Pure | Applied to the table | Applied to the table |
| anything else | Live | `export_view` fallback, then placeholder | `export_view` fallback, then placeholder |

**Turning the live renderers off** makes an export deterministic and free of
additional Jira / `export_view` / attachment-lookup calls:

- CLI: `--no-live-macros`.
- Panel: clear **Resolve dynamic macros (contacts Jira/Confluence)**.

Pure renderers keep running either way, and neither switch is an offline mode —
the page body and its own attachments still load.

## The fallback chain and the floor

For every macro the walker did not convert natively, each stage is tried in
order and the first that produces content wins:

1. **A specific renderer** — the rows above. Full fidelity.
2. **`export_view`** — Confluence renders the macro server-side to HTML, and the
   supported subset of that HTML becomes real blocks. This is what transparently
   covers current-generation third-party apps that declare an export function.
3. **A visible placeholder plus a report note** — the guaranteed floor. The
   macro's preserved body or plain text is still rendered beneath the
   placeholder line.

Content is never silently dropped. If a macro produced nothing you can see, the
report says which stage it stopped at and why.

## Host differences: CLI and panel

Macro behaviour is a property of the engine, not the host — the panel and the
CLI resolve identically. What differs is the surrounding controls:

| Control | CLI | Panel |
|---------|-----|-------|
| Disable live renderers | `--no-live-macros` | **Resolve dynamic macros** toggle |
| Keep `scroll-only` / `scroll-ignore` bodies for debugging | `--keep-ignored` (DOCX, single page) | Not available |
| Read the note codes below | `--json` → `issues[]` / `notesByCode` | Report summary under the export button |

`--keep-ignored` is a debugging aid: it keeps content the author marked for
exclusion, marks the report with `export-controls-passthrough`, and bypasses
exporter routing entirely — both `scroll-only` and `scroll-ignore` bodies are
kept regardless of which exporter they target. Do not ship a passthrough export
as a final document.

## Note codes

The codes a macro degradation can put in the report:

| Code | Severity | Meaning |
|------|----------|---------|
| `macro-rendered-via` | `info` | Resolved by a renderer or by `export_view` — names which |
| `macro-degraded` | `warning` | Fell through to the placeholder floor, or a live call failed (e.g. a 403) |
| `macro-skipped-by-config` | `info` | Suppressed by `--no-live-macros`, the panel toggle, or a resolution deadline |
| `scroll-only-applied` / `scroll-ignore-applied` | `info` | An export-control macro decided what you see |
| `scroll-only-skipped-other-exporter` | `info` | The body belonged to the other output format |
| `pagebreak-suppressed-in-container` | `info` | A break inside a cell or callout was dropped; content kept |
| `orientation-suppressed-in-container` | `info` | An orientation region inside a cell or callout was flattened; content kept |
| `caption-kind-unknown` | `warning` | A `scroll-title` `type` was not recognised; the block's natural kind was used |
| `caption-lang-fallback` | `warning` | No caption labels ship for the requested language; English was used |
| `export-controls-passthrough` | `info` | `--keep-ignored` was in effect — the output is not representative |
| `unsupported-child-type` | `warning` | A whiteboard/database/embed child page was skipped |
| `datasource-*` | `info` / `warning` | A datasource table degraded; see [dynamic macros](/confluence/dynamic-macros/#datasource-smart-links) |

Read them from a CLI export with:

```bash
atlcli wiki export 12345678 --format pdf -o out.pdf --json \
  | jq -r '.issues[] | select(.code | startswith("macro") or startswith("scroll"))
           | "\(.severity)\t\(.code)\t\(.message)"'
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Content is missing and you cannot see why | A `scroll-ignore`, or a `scroll-only` aimed at the other format | Check the report for `scroll-*-applied`; confirm with `--keep-ignored` |
| A page break did nothing | It sits inside a table cell or callout | See `pagebreak-suppressed-in-container`; move it to body level |
| An orientation region did not flip | Same container restriction | See `orientation-suppressed-in-container` |
| A third-party macro is a placeholder | The app declares no `export_view` / ADF export | Placeholder plus note is the honest floor |
| A macro that used to render is now a placeholder | A live call failed — permissions, throttling, or the linked site | Read the `macro-degraded` message; it names the cause |
| Captions all read "1" in Word | The export ran with `--no-field-update-prompt` on an older release, or a template caption sequence collides with the export's | Press **Ctrl+A**, **F9**; see [Field update behavior](/confluence/export/#field-update-behavior) |

## Related topics

- [Scroll compatibility macros](/confluence/scroll-macros/) — the full semantics
  of the export-control, break, orientation and caption macros
- [Exporting pages with dynamic macros](/confluence/dynamic-macros/) — renderers,
  datasource tables, and the fallback chain in detail
- [DOCX and PDF Export](/confluence/export/) — the commands and their reports
- [Exporting from the panel](/extension/export/#dynamic-macros) — the panel's
  macro toggle
- [Macros](/confluence/macros/) — macro handling in markdown *sync*, a different
  pipeline from export
