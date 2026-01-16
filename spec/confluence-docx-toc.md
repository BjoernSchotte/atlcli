# Confluence DOCX Export: TOC State of Affairs

## Summary

- Word TOC fields live in the Word template.
- Confluence `:::toc` macro output is optional and rendered as a plain list (`--toc-macro`).
- The exported DOCX does not auto-update TOC fields.
- Users must update the TOC in Word to populate entries and page numbers.

## Why manual update is required

Word TOCs are implemented as **field codes**. The visible entries and page numbers
are a **cached result** that Word computes using its layout engine. Our export
pipeline builds the document structure but does **not** run a layout engine, so:

- We cannot reliably compute page numbers.
- We cannot populate the cached TOC entries without a layout engine.

Open XML does not include a layout engine, and we are not bundling LibreOffice
or any other external renderer at this time. This keeps the CLI lightweight and
fully open source.

## Expected UX in Word

When you open the exported file, Word may show a warning or prompt related to
updating fields. This is safe to accept.

If no prompt appears, update the TOC manually:

1) Click inside the TOC
2) Right-click and choose "Update Field"
3) Select "Update entire table"

## Confluence TOC macro vs Word TOC field

There are two distinct concepts:

1) **Word TOC field** (template-driven)
   - Native Word feature
   - Provides hyperlinks and page numbers
   - Requires Word to update fields

2) **Confluence `:::toc` macro output** (optional)
   - Rendered as a plain list with `--toc-macro`
   - No page numbers
   - Not a native Word TOC field

## Current behavior (by design)

- We keep the template's Word TOC field as-is.
- We do not trigger field updates automatically.
- We do not bundle LibreOffice or other renderers yet.

This avoids extra dependencies and keeps exports deterministic and fast.
