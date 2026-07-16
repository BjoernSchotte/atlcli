---
title: "PDF Export Engine"
description: "Architecture, pinned runtime and verification for the browser PDF exporter"
---

# PDF Export Engine (`@atlcli/pdf`)

`packages/pdf` is the browser-safe preparation and Typst serialization layer used by the
atlcli extension. It consumes the same structured Confluence `ExportBlock[]` tree as the
working Word exporter. Browser integration - authentication, IndexedDB jobs, worker lifecycle
and download - stays in `apps/extension`.

## Built-in document design

The standard template is a brand-neutral editorial A4 design. It bundles Source Serif 4 for
flowing body copy, Source Sans 3 for headings, tables, metadata and other structural text, and
Source Code Pro for code. Body copy uses 10 pt text, a relaxed 0.74 em leading value, and 10 pt
paragraph spacing. Heading levels use progressively larger separation so a heading remains
visually attached to the content it introduces while sections are easy to scan.

The Editorial Indigo cover uses a warm paper tone, a Source Serif title and a left-aligned
metadata rail. It is followed by the table of contents and does not display a page number.
The running header preserves the page title and space key above a fine horizontal rule;
the centered footer contains the page number. An automatically generated document-integrity
page closes every export with the document title, version, export date, final page count and a
clickable link to `atlcli.sh`; it does not repeat the running header. Unordered list levels use an en dash, filled
bullet and open bullet; ordered levels use `1.`, `a)` and `i.`. Task lists use standalone
checkbox markers without an additional bullet. Tables preserve meaningful authored column
widths. Equal default widths may be replaced by a
conservative content-aware ratio when one narrative column is substantially longer than the
remaining short status columns. Complex tables and balanced prose tables remain unchanged.

## Runtime matrix

| Component | Pinned value | Verification |
|-----------|--------------|--------------|
| Web compiler wrapper | `@myriaddreamin/typst-ts-web-compiler` 0.7.0 | Exact package version and Bun patch |
| Embedded Typst engine | 0.14.2 | PDF `Creator` metadata and compiler fixture |
| Compiler WASM | SHA-256 `1fc968438a672366dfec39c96c842c26ed29caff4eb1bcaab19a6c60867de5fd` | Build inventory gate |
| Source Sans 3 Regular / Italic / SemiBold / Bold | Adobe commit and SHA-256 values pinned in `ensure-fonts.ts` | Build fetch and inventory gates |
| Source Serif 4 Regular / Italic / SemiBold / Bold | Adobe commit and SHA-256 values pinned in `ensure-fonts.ts` | Build fetch and inventory gates |
| Source Code Pro Regular / Bold | Adobe commit and SHA-256 values pinned in `ensure-fonts.ts` | Build fetch and inventory gates |

The production extension artifact includes the 28.3 MB compiler WASM, ten static font files
and their shipped license texts. The build gate fails
if any runtime asset is absent, the WASM is unexpectedly small, or generated JavaScript
contains a known Manifest V3-incompatible dynamic-code constructor.

The TTF binaries are not stored in Git. `bun run build`, extension development, extension
typechecking and the PDF fixture first run `fonts:ensure`. It downloads missing files from
immutable Adobe commit URLs into the gitignored `packages/pdf/.fonts/` cache and installs a
file only after its SHA-256 value matches the manifest. A valid cache performs no network
request. OFL license texts remain tracked and ship in the extension. PDF export itself never
contacts Adobe, Google Fonts, Fontsource or another font service.

## Export flow

1. Convert Confluence storage to exhaustive `ExportBlock[]` values.
2. Resolve approved attachments with the active Atlassian session and render Mermaid through
   `@atlcli/diagram`.
3. Serialize deterministic `main.typ`, the pinned template, assets and nested source mappings.
4. Store the binary job in IndexedDB and send only `{ jobId }` control messages.
5. Compile FIFO in a dedicated worker hosted by the offscreen extension document.
6. Validate pages, tag structure and embedded font programs, then download as `application/pdf`.
7. Delete the job in `finally`; startup cleanup removes records older than 24 hours.

The completion report shows total time together with preparation, compilation, and download
time. Preparation includes attachment resolution and Mermaid rendering, which makes network-
or asset-heavy exports distinguishable from compiler time.

Cancellation terminates an active compiler worker. A 60-second timeout also terminates it, so
the next attempt starts in a clean compiler and virtual filesystem rather than merely rejecting
an unresolved promise.

## Verification fixture

Run the deterministic feature fixture locally:

```bash
bun run --cwd apps/extension pdf:fixture
pdfinfo tmp/pdfs/pdf-export-feature-zoo.pdf
pdftoppm -png tmp/pdfs/pdf-export-feature-zoo.pdf tmp/pdfs/pdf-export-feature-zoo
```

The fixed fixture produces an A4 document with title and author metadata, outline,
internal TOC links, semantic tags, embedded font programs, highlighted code and a native
vector Mermaid diagram. A warm repeat compile is required to be byte-identical.

## Known profile boundary

Standard export requires tagged output and rejects an untagged result. The pinned compiler does
not expose a PDF/UA-1 selector. Therefore the engine deliberately makes no PDF/UA or PDF/A claim;
adding either profile requires a separately validated implementation and independent conformance
evidence.

## Related topics

- [DOCX and PDF Export](../confluence/export.md)
- [DOCX Export Engine](docx-engine.md)
