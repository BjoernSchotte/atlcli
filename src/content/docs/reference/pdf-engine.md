---
title: "PDF Export Engine"
description: "Architecture, pinned runtime and verification for the browser PDF exporter"
---

# PDF Export Engine (`@atlcli/pdf`)

`packages/pdf` is the host-neutral preparation, Typst serialization, validation, and export
orchestration layer. It consumes the same structured Confluence `ExportBlock[]` tree as the
DOCX engine, but PDF and DOCX remain independent pipelines with format-specific ports, reports,
and output semantics.

The low-level Typst-WASM implementation lives in the private browser-only package
`@atlcli/pdf-compiler-browser`. A host injects it through `PdfCompilePort`; importing
`@atlcli/pdf` or `@atlcli/pdf/browser` does not pull compiler or WASM code into preparation-only
consumers. Authentication, worker/job topology, persistence, cancellation policy, download/save
behavior, and UI remain host-owned.

## Architecture

```text
Confluence storage -> ExportBlock[] -> @atlcli/pdf -> PdfCompilePort -> PDF bytes
                                           ^               |
                                           |               +-- browser: @atlcli/pdf-compiler-browser
                                           +-- assets/output supplied by the host
```

The extension implements `PdfCompilePort` over its offscreen document, dedicated worker, and
IndexedDB job store. The neutral Vite harness uses a direct module Worker and in-memory output
sink. These are intentionally different topologies exercising the same package contracts.

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

### Very wide tables

Tables with at least nine effective columns keep the standard A4 portrait page and the
existing column calculation, but use an adaptive inline policy for values that otherwise
behave like indivisible UI elements. Ordinary cell prose remains Source Sans 3 at 9 pt with
language-aware hyphenation. Dense cells reduce horizontal padding from 6 pt to 2 pt and use
Typst's simple line breaker; the optimized breaker can deliberately accept visibly overfull
lines at these extreme widths. Tables below the dense threshold retain optimized line breaking
and their existing 6 pt padding.

- A raw HTTP(S) URL first uses its complete visible form. If it does not fit, the renderer
  tries `hostname/…` and then a delimiter-aware, wrapping hostname. The PDF annotation always
  retains the complete original target. Custom human-readable link labels are never shortened.
- A status always remains a colored badge with its complete label. Badges use Source Code Pro
  Bold, try normal and reduced horizontal padding, and finally wrap the complete label inside
  the available cell width while retaining their background, foreground color, and radius.
- Mentions keep their complete display name. In dense cells, an invisible break opportunity
  after `@` and after safe account-ID delimiters prevents technical identifiers from painting
  into the next column. These break characters are rendering-only and do not change the source
  model.

The exporter does not automatically switch page orientation, clip a paragraph or table cell,
or shrink every table font. Landscape pages and user-configurable wide-table policies remain
outside the current standard template.

## Runtime matrix

| Component | Pinned value | Verification |
|-----------|--------------|--------------|
| Web compiler wrapper | `@myriaddreamin/typst-ts-web-compiler` 0.7.0 | Exact package version and Bun patch |
| Embedded Typst engine | 0.14.2 | PDF `Creator` metadata and compiler fixture |
| Compiler WASM | SHA-256 `1fc968438a672366dfec39c96c842c26ed29caff4eb1bcaab19a6c60867de5fd` | Build inventory gate |
| Source Sans 3 Regular / Italic / SemiBold / Bold | Adobe commit and SHA-256 values pinned in `ensure-fonts.ts` | Build fetch and inventory gates |
| Source Serif 4 Regular / Italic / SemiBold / Bold | Adobe commit and SHA-256 values pinned in `ensure-fonts.ts` | Build fetch and inventory gates |
| Source Code Pro Regular / Bold | Adobe commit and SHA-256 values pinned in `ensure-fonts.ts` | Build fetch and inventory gates |

Each production browser host artifact includes the 28.3 MB compiler WASM, ten static font files
and their shipped license texts. The build gates fail
if any runtime asset is absent, the WASM is unexpectedly small, or generated JavaScript
contains a known Manifest V3-incompatible dynamic-code constructor.

The TTF binaries are not stored in Git. `bun run build`, extension development, extension
typechecking and the PDF fixture first run `fonts:ensure`. It downloads missing files from
immutable Adobe commit URLs into the gitignored `packages/pdf/.fonts/` cache and installs a
file only after its SHA-256 value matches the manifest. A valid cache performs no network
request. OFL license texts remain tracked and ship in the extension. PDF export itself never
contacts Adobe, Google Fonts, Fontsource or another font service.

## Neutral export flow

1. Convert Confluence storage to exhaustive `ExportBlock[]` values.
2. Resolve approved assets through the host's `PdfAssetResolver` and render Mermaid through
   `@atlcli/diagram`.
3. Serialize deterministic `main.typ`, the pinned template, assets and nested source mappings.
4. Compile through the injected `PdfCompilePort` and normalized diagnostics contract.
5. Validate pages, tag structure and embedded font programs.
6. Emit through the host's `PdfOutputSink`, with an abort check before and after emission.

The extension adapter additionally stores binary jobs in IndexedDB, sends bounded control
messages, compiles FIFO in its offscreen worker, downloads as `application/pdf`, and removes job
state in `finally`. Those policies are not part of `@atlcli/pdf` or the compiler package.

The completion report shows total time together with preparation, compilation, and download
time. Preparation includes attachment resolution and Mermaid rendering, which makes network-
or asset-heavy exports distinguishable from compiler time.

Cancellation terminates an active compiler worker. A 60-second timeout also terminates it, so
the next attempt starts in a clean compiler and virtual filesystem rather than merely rejecting
an unresolved promise.

## Browser conformance harness

`apps/browser-export-harness` is a private vanilla Vite consumer that imports only public package
exports. Its production artifact is served below a nested path with a local CSP and exercised by
Playwright Chromium. The test performs a real Worker/WASM/font compile, verifies deterministic
warm output and abort-without-emission, and scans all JavaScript and assets for native-runtime or
extension leaks. This is package conformance evidence, not certification for every browser host.

## Verification fixture

Run the deterministic feature fixture locally:

```bash
bun run --cwd apps/extension pdf:fixture
pdfinfo tmp/pdfs/pdf-export-feature-zoo.pdf
pdftoppm -png tmp/pdfs/pdf-export-feature-zoo.pdf tmp/pdfs/pdf-export-feature-zoo
```

The fixed fixture produces an A4 document with title and author metadata, outline,
internal TOC links, semantic tags, embedded font programs, highlighted code, a native
vector Mermaid diagram, a normal four-column table, and a synthetic fourteen-column dense
table. The dense section covers full-target raw links, custom link labels, complete visual
status badges, mentions, and normal wrapping prose. A warm repeat compile is required to be
byte-identical.

## Known profile boundary

Standard export requires tagged output and rejects an untagged result. The pinned compiler does
not expose a PDF/UA-1 selector. Therefore the engine deliberately makes no PDF/UA or PDF/A claim;
adding either profile requires a separately validated implementation and independent conformance
evidence.

## Related topics

- [PDF Template Settings](pdf-template-settings.md)
- [PDF Template Contract](pdf-template-contract.md) — the `wiki.pdf-template/v1`
  render contract.
- [Template Pack Format](template-pack-format.md) — the `.wiki-pdf-template`
  sharing container.
- [DOCX and PDF Export](../confluence/export.md)
- [DOCX Export Engine](docx-engine.md)
