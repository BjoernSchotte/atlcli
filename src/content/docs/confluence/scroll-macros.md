---
title: "Scroll compatibility macros"
description: "How atlcli honors scroll-* export-control, page-break, orientation, and caption macros when exporting Confluence pages to DOCX and PDF."
---

# Scroll compatibility macros

Pages migrated from Scroll-based exporters often carry `scroll-*` compatibility
macros that control what appears in an export and how it is laid out. When you
export a page to DOCX or PDF, atlcli honors these macros natively instead of
leaving them as `[macro not rendered]` placeholders.

Every macro that changes what you see in the output records a note in the export
report, so "why is section X missing?" always has an answer.

## In this guide

- [Prerequisites](#prerequisites)
- [Supported macros](#supported-macros)
- [Export-control macros (`scroll-only` / `scroll-ignore`)](#export-control-macros)
- [Page breaks](#page-breaks)
- [Orientation regions](#orientation-regions)
- [Captions](#captions)
- [Keeping ignored content for debugging](#keeping-ignored-content-for-debugging)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- A Confluence page that uses one or more `scroll-*` macros.
- A DOCX or PDF export route (CLI `atlcli wiki export`, or the browser
  extension panel).

## Supported macros

| Macro | Effect in export | Engines |
|-------|------------------|---------|
| `scroll-only` | Keep the body only for the matching exporter | DOCX, PDF |
| `scroll-ignore` | Drop the body (for the matching exporter) | DOCX, PDF |
| `scroll-only-inline` | Inline variant of `scroll-only` | DOCX, PDF |
| `scroll-ignore-inline` | Inline variant of `scroll-ignore` | DOCX, PDF |
| `scroll-pagebreak` | Insert a hard page break | DOCX, PDF |
| `scroll-landscape` | Lay the region out in landscape orientation | DOCX, PDF |
| `scroll-portrait` | Lay the region out in portrait orientation | DOCX, PDF |
| `scroll-title` | Attach a numbered caption to a figure/table/code | DOCX, PDF |

Any `scroll-*` macro atlcli does not recognize is preserved conservatively — its
content is kept and a warning note is added, never silently dropped.

## Export-control macros

`scroll-only` and `scroll-ignore` decide whether a block of content appears in a
given export. Each can carry an optional `exporter` parameter (`word` or `pdf`)
that scopes the rule to one target format.

The decision is made once, when the page is parsed, and is identical for the CLI,
the extension, and any other host.

### Truth table (apply mode)

The active exporter (`word` for DOCX, `pdf` for PDF) is matched against the
macro's `exporter` parameter:

| `exporter` param | `scroll-only` result | `scroll-ignore` result |
|------------------|----------------------|------------------------|
| absent | keep body | drop body + note |
| matches exporter | keep body | drop body + note |
| targets other exporter | drop body + note | keep body + note |
| unrecognized value | keep body + warning | keep body + warning |

A mismatch is the inverse of the match case, not a no-op: a `scroll-only` scoped
to a *different* exporter is exclusive to that other target, so its body is
dropped here; a `scroll-ignore` scoped to a different exporter is only meant to
hide from that other target, so its body is kept here.

An unrecognized `exporter` value fails safe: the content is always kept and a
warning explains why.

### Example (config-first)

Storage-format input on the page:

```xml
<ac:structured-macro ac:name="scroll-only">
  <ac:parameter ac:name="exporter">word</ac:parameter>
  <ac:rich-text-body><p>Only in the Word export.</p></ac:rich-text-body>
</ac:structured-macro>
```

- Exporting to **DOCX**: the paragraph appears; the report notes
  `scroll-only-applied`.
- Exporting to **PDF**: the paragraph is dropped; the report notes
  `scroll-only-skipped-other-exporter`.

## Page breaks

`scroll-pagebreak` inserts a hard page break.

- **DOCX**: a `<w:br w:type="page"/>` run.
- **PDF**: a `#pagebreak(weak: true)` (a weak break avoids blank pages at
  natural boundaries).

A page break inside a **table cell** or **callout** is suppressed (it would
split the row or box, not the page) and the report notes
`pagebreak-suppressed-in-container`. Surrounding content is preserved.

## Orientation regions

`scroll-landscape` and `scroll-portrait` lay a region of content out in the
given orientation — useful for wide tables and diagrams.

- **DOCX**: the region is wrapped in a section sandwich. The landscape section
  swaps the template's own page dimensions (Letter, A4, or whatever the template
  uses — never a hard-coded size) and keeps its margins and header/footer
  references.
- **PDF**: the region is wrapped in a block-scoped `#set page(flipped: …)`. A
  `scroll-portrait` region flips *back* to portrait even inside a document whose
  base orientation is landscape.

Orientation regions inside a table cell or callout are rendered without an
orientation change (a section break / page rule cannot live there) and the
report notes `orientation-suppressed-in-container`. The content is kept.

Both source shapes are recognized: a body-wrapped macro (the region content
sits inside the macro body) and the paired open/close marker form (a body-less
`scroll-landscape` orients everything up to the next body-less
`scroll-portrait`; an unclosed region ends at the end of its content with the
base orientation restored and an info note).

A nested orientation region collapses into its enclosing region (the outer
orientation wins) with a warning note — including regions nested deeper inside
lists, quotes, callouts, or table cells.

## Captions

`scroll-title` attaches a numbered caption to the first figure, table, or code
block in its body. Numbering is native to the target format, so it stays correct
as content moves:

- **DOCX**: a `Caption`-styled paragraph with a live `SEQ` field. Word
  renumbers captions when the document is opened.
- **PDF**: a `#figure(caption: …, kind: …)` with Typst's own figure counters.

Captions are placed **above** tables and **below** figures and code blocks.

### Caption kind

`scroll-title` may carry a `type` parameter (`figure`, `table`, `code`, and
common aliases). The declared kind wins so the DOCX label and PDF figure kind
agree — for example `type="table"` on an image labels it as a table in both
engines. An unknown kind falls back to the block's natural kind with a warning
note. `equation` is not supported yet.

### Locale (DOCX)

Caption labels are localized: `Figure`/`Table`/`Listing` (English) or
`Abbildung`/`Tabelle`/`Listing` (German). The label set comes from the export's
explicit caption-language option (a BCP-47 tag such as `de` or `de-DE`; the
primary language subtag decides) and defaults to English. A language without a
shipped label set falls back to English with a `caption-lang-fallback` warning
note in the report.

### Broken images

If a captioned image fails to embed, atlcli still emits a numbered placeholder
plus the caption, so a broken attachment never shifts the numbering of later
figures.

## Keeping ignored content for debugging

To inspect what an export normally drops, run the CLI export with
`--keep-ignored` (DOCX, `--engine ts`, single-page scope):

```bash
atlcli wiki export <page> --template mytemplate --output out.docx \
  --engine ts --keep-ignored
```

Both `scroll-only` and `scroll-ignore` bodies are kept, and the report records
`export-controls-passthrough` so you know the output is not representative of a
normal run. Page breaks and orientation regions still render. The flag is not
available for `--scope tree/space` or the Python engine yet.

> **Tip:** Passthrough is a debugging aid. Do not ship a passthrough export as
> the final document — it contains content the author marked for exclusion.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Content missing from the export | A `scroll-ignore` (or mismatched `scroll-only`) dropped it | Check the report for `scroll-ignore-applied` / `scroll-only-skipped-other-exporter`; use passthrough mode to confirm |
| A page break did nothing | The break sits inside a table cell or callout | See the `pagebreak-suppressed-in-container` note; move the break to body level |
| An orientation region did not flip | The region sits inside a table cell or callout | See the `orientation-suppressed-in-container` note |
| A caption is not numbered in Word | Word numbers `SEQ` fields on open/print preview | Open the document (fields refresh automatically) |
| A caption used the wrong label | The `scroll-title` `type` was unknown | See the `caption-kind-unknown` note; use `figure`, `table`, or `code` |

## Related topics

- [Macros](/confluence/macros/) — the full macro support matrix
- [Storage format](/confluence/storage/) — how storage XML maps to output
- [Pages](/confluence/pages/) — creating and exporting pages
