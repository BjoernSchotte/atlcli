---
title: "PDF Import"
description: "Review and import digital PDFs as editable Confluence pages with bounded page-tree splitting"
---

# PDF Import

Import a digital PDF as native Confluence content. AtlCLI extracts text,
headings, qualified lists and tables, links, and figures; it shows a
digest-bound preview before any write and publishes only with `--confirm`.
Long PDFs become bounded page trees by default, so a 100-page PDF never becomes
one oversized wiki page.

> **Evidence status.** The PDF importer is experimental (`0.x`). Confluence
> Cloud is live-certified with neutral tagged, untagged, table, figure,
> fallback, restricted-source, bounded split-tree, and failure-injection cases.
> Data Center is implemented and contract-tested for one-page Storage imports,
> but is not project-live-certified.
> Browser Extension and Forge import UIs are not available. PDF.js remains the
> browser viewer; PDFium is used only by the import capability.

## On this page

- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Preview and confirmation](#preview-and-confirmation)
- [Source fidelity diagnostics](#source-fidelity-diagnostics)
- [What is supported](#what-is-supported)
- [Splitting long PDFs](#splitting-long-pdfs)
- [Scans and visual fallbacks](#scans-and-visual-fallbacks)
- [Figures, tables, and reading order](#figures-tables-and-reading-order)
- [Import from an attachment](#import-from-an-attachment)
- [Original PDF retention](#original-pdf-retention)
- [Correct extraction decisions](#correct-extraction-decisions)
- [Visibility and metadata](#visibility-and-metadata)
- [Options](#options)
- [Advanced example](#advanced-example)
- [Cloud and Data Center behavior](#cloud-and-data-center-behavior)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Related topics](#related-topics)

## Prerequisites

- A PDF with a valid `%PDF-` byte signature. Digital tagged or conservatively
  qualified untagged PDFs are the MVP input.
- A configured Confluence profile (`atlcli auth login`) for publishing, for
  attachment-source preview, or when the target space comes from the profile.
- Permission to create pages and attachments in the target space.
- For a fully offline local preview, pass a local file and an explicit
  `--space`; do not use `--from-page`.

Encrypted/password-protected PDFs are rejected. Passwords are never accepted
through command-line arguments. OCR is not included.

## Quick start

Preview a local PDF without changing Confluence:

```bash
atlcli wiki import handbook.pdf --space TEAM
```

Inspect the source/page classification, issue list, fallback decisions, page
tree, and plan digest. Then publish the reviewed plan explicitly:

```bash
atlcli wiki import handbook.pdf --space TEAM --confirm
```

The default title is the file name without `.pdf`. Override it with `--title`.

## Preview and confirmation

Without `--confirm`, `wiki import` creates no pages or attachments. The preview
binds these inputs into one plan digest:

- source PDF SHA-256 and page count;
- PDFium version, local WASM identity, and analyzer policy revision;
- extracted semantics, per-page outcomes, issues, and content assets;
- reading-order, scan, fallback, split, conflict, and override decisions;
- target space, parent, deployment capability, titles, and page assignments.

Use `--json` when you need stable source locators, confidence, outcomes, and
digests for review tooling:

```bash
atlcli wiki import handbook.pdf --space TEAM --json > import-preview.json
```

The confirmed run analyzes the same source again and publishes the resulting
review plan. Non-interactive use must pass `--confirm`; there is no implicit
write. `--dry-run` and `--confirm` are mutually exclusive.

## Source fidelity diagnostics

The preview separates two checks that answer different questions:

- **Extraction/source fidelity** checks whether every visible source character
  has exactly one semantic or fallback owner, and whether every material text
  boundary has explicit or sufficiently strong inferred evidence.
- **Confluence semantic readback** runs after publication and checks whether
  the projected headings, paragraphs, lists, tables, media, and links arrived
  intact. It is a transport-integrity check; it cannot prove that the original
  PDF was extracted correctly.

JSON review schema V3 reports body-free counts per source page. Boundary counts
distinguish authored whitespace (`explicitBoundaryCount`), deterministic
inference (`inferredBoundaryCount`), its separately visible dehyphenation
subset (`dehyphenatedBoundaryCount`), and ambiguity
(`unresolvedBoundaryCount`). Ownership counts distinguish tagged, geometry,
and visual-fallback owners, plus unowned characters and duplicate ownership
attempts. Repair-region count, fallback scope, and normalized fallback area
show how much non-native recovery was necessary.

The terminal preview prints the source page label, these counts, fallback
scope, and a body-free decision code. `pdf/source-fidelity-accounted` means the
page has neither unresolved boundaries nor ownership failures.
`pdf/text-boundary-unresolved` identifies a material spacing or joining
decision that evidence could not settle. `pdf/character-ownership-failed`
identifies an unowned visible character or a duplicate ownership attempt.
Neither diagnostic prints the affected source text.

On partially tagged pages, `auto` keeps verified tagged structures and repairs
only residual regions with qualified geometry. If a region cannot be repaired
safely, a localized visual fallback is preferred; a page fallback is the last
safe option. `--unsupported fail` blocks unresolved boundaries and ownership
failures even when the rest of the page looks plausible. Use
`--unsupported report` only with the existing explicit fallback/report
acknowledgments and after reviewing the affected page labels and locators.

## What is supported

| PDF source feature | Import result |
|---|---|
| Tagged headings H1-H6 | Native headings when marked-content correlation is complete |
| Digital text | Native paragraphs with page/region provenance |
| Tagged or qualified lists | Native ordered/bullet lists; otherwise conservative paragraphs or a reported outcome |
| Safe `http`, `https`, and `mailto` links | Native links after scheme filtering |
| Tagged tables with proven cells/spans | Native tables |
| Untagged tables with drawn borders, row rules, or clear column alignment | Native tables, including merged cells and continuation across pages |
| Tagged raster figures with visible placement | Native media with author alternative text when present |
| Composite/vector/ambiguous visible figures | Bounded rendered-region image fallback |
| Repeated page headers, footers, and page numbers | Suppressed only when repeated-region evidence qualifies |
| Page labels and outline | Evidence for navigation, headings, and split planning |
| JavaScript, launch actions, embedded files | Inventoried as inert issues; never executed or extracted |
| Encrypted PDF | Rejected |
| Image-only scan | Blocked, rendered as a page image, or explicitly reported according to `--scan-policy` |

Every recognized source construct receives one of `native`, `approximated`,
`attached`, `reported`, or `rejected`. A page cannot disappear silently: page
coverage and source locators are part of the review.

## Splitting long PDFs

PDF import defaults to `--split auto`:

- A safe, editable PDF with at most 20 source pages stays on one wiki page.
- A longer or complex PDF becomes a Cloud page tree with a root **Contents**
  page and bounded content pages.
- Content pages target 20 source pages and can never exceed 40 source pages.
- Every source page is assigned exactly once. A table, figure, list, or page
  image that crosses a nominal boundary moves the boundary instead of being
  split.
- The default total cap is 50 wiki pages, including the root index; the
  configurable hard maximum is 200.

Available split modes:

| Value | Behavior |
|---|---|
| `auto` | Default. One page only for short/editable inputs; otherwise use qualified headings and bounded page ranges. |
| `off` | Request one wiki page. Inputs over 40 source pages or hard editability budgets still fail; this never forces 100 pages onto one page. |
| `heading:1` … `heading:6` | Build hierarchy from qualified headings up to that level, subdividing oversized sections. Numeric `1` … `6` is an alias. |
| `pages:5` … `pages:40` | Use the requested source-page target while preserving atomic regions. |

For a neutral 100-page handbook with predictable 20-page ranges:

```bash
atlcli wiki import handbook.pdf --space TEAM \
  --split pages:20 --max-wiki-pages 25
```

The preview shows exact titles, source-page ranges, hierarchy, split reasons,
estimates, and assignments. Duplicate planned titles or existing titles fail
before mutation. `--title-conflict rename` selects deterministic ` (2)`,
` (3)` variants and rebuilds the root index and plan digest.

Data Center does not support PDF page trees in this version. A resolved tree is
rejected before any page is created; it is never flattened silently.

## Scans and visual fallbacks

The default `--scan-policy fail` blocks image-only pages and any page whose
editable semantics cannot be preserved safely. Choose an explicit alternative:

- `--scan-policy page-image` renders each affected page as a bounded PNG. The
  result preserves visible fidelity but is not editable or accessible text.
  Without `--visual-fallback`, this legacy spelling keeps full-page images
  inline for compatibility.
- `--scan-policy report` omits the affected page content with a visible issue.
  Publication additionally requires `--unsupported report` and
  `--accept-reported-pages`.

AtlCLI runs no OCR of its own. A scanned page whose image covers most of the
page stays a page image even when it carries an invisible OCR text layer: the
layer is the scanner's guess, not source text. With `--scan-policy page-image`
or `--visual-fallback`, that layer is attached after the page image as a
collapsed **Recognized text (OCR, unverified)** section, one paragraph per
line, so the page can be searched and copied from. The review reports it as
`pdf-import/ocr-text-attached` (info). A page image of visible text gets no
such section.

`--visual-fallback auto|inline|collapsed|appendix` is the clearer opt-in and
implies `--scan-policy page-image`. `auto` is recommended: localized unsafe
content becomes a labeled inline crop, while a whole-page visual backup is
placed in a collapsed **Original visual view** section. `inline` exposes the
whole-page backup directly, `collapsed` makes that choice explicit, and
`appendix` collects whole-page views under **Original visual views** at the end
of each generated wiki page. Region crops remain next to their source content
in every mode. Tiny degenerate tag boxes are reported without adding an image;
unclaimed visible text and unlocalizable loss still require a whole-page view.

A native table on an untagged page that falls back stays a native table next
to the page view, and a table continued from or onto that page stays one
table.

## Figures, tables, and reading order

`--reading-order auto` uses valid tags first and conservative geometry for an
untagged document. `--reading-order tags` requires a tagged PDF and fails if
tags are absent. `--reading-order geometry` deliberately ignores tags and is
useful only after reviewing the changed order and confidence.

For tagged PDFs, AtlCLI reads the document's structure tree as a whole
(not page by page), so every table, row, and cell keeps one identity across
pages. Structure only proposes rows and cells; every character still comes
from the PDF's own text layer, so structure can never add text.

A structure element with one child that cannot be resolved still keeps its
other children, in their original order; the unresolved child is reported as
`pdf-import/tagged-structure-kid-unresolved`. Children shown on another page
are skipped on this page. If text on the page belongs to no remaining element,
the page falls back as before. A paragraph or heading with an unresolved child
keeps its resolved text the same way. A list, figure, or table with an
unresolved child is never treated as complete: a missing child would shift
items or cells without leaving any text unclaimed.

A tagged table becomes one native Confluence table when its grid is complete:

| Case | Result |
|---|---|
| Table continues on the next page | One table; rows in source order |
| Header row repeated on every page | Kept once; the repetitions are recognized, not duplicated |
| Repeated header drawn as untagged text (LibreOffice) | Recognized directly above the continuation rows when every column matches; not duplicated |
| Row split by a page break | One row; each cell's text continues as one paragraph |
| Row or column span across a page break | Kept as a span |
| Intentionally empty cell | Native empty cell |
| Producer omitted an empty cell's tag | Placed by the cells' `Headers` references; the gap becomes an empty cell |
| Nested, rotated, or ambiguous table | Linearized text plus one rendered crop of the table region; the rest of the page stays editable |
| More than 5,000 rows in total | Each page keeps its own table; reported |

PDFium exposes text, geometry, tags, page objects, annotations, and rendering
primitives; it does not provide a native semantic table importer. For untagged
PDFs (for example Word for Mac's default **Save As PDF**), AtlCLI rebuilds
tables from the drawing itself, without learned models:

| Case | Result |
|---|---|
| Borders drawn on every cell | One native table; a missing separator merges cells into a span |
| No outer side borders (a common Word table style), or no top rule on a continued page | The open side is implied where every row rule or column rule ends; native table |
| Inside rules only (Word's "no outer border", any number of columns) | Native table with its first and last row; one table across pages |
| Row split by a page break, frame drawn but left open on both sides of the break | One row; each cell's text continues as one paragraph |
| Row split by a page break, frame drawn across the break (Word and LibreOffice by default), text continuing mid-sentence | One row: the rest fills only cells the row before fills, and each of its cells continues a cell that stops mid-sentence or starts in lowercase. Reported as `pdf-import/table-row-split-joined` (info) |
| Row split by a page break, frame drawn across the break, the rest starting a new sentence | Two rows: the rest leaves the finished cells blank. Reported as `pdf-import/table-row-split-unproven`, because a row left partly blank on purpose looks the same |
| Several text pieces on one line of a cell, one set slightly higher (another font size) | Read left to right in the line |
| Only horizontal rules between rows | Rows from the rules, columns from left text edges shared by several rows; wrapped cell text stays in its cell |
| No lines, three or more columns of single-line cells | Native table when every row has the same cells and the columns are clearly separated |
| Table continues on the next page with the same columns | One table; a repeated bold header row is kept once |
| Shading or a highlight behind text, or a filled text box on a slide | Background: the text stays editable, no image |
| Text that crosses a drawn cell edge, a frame open where its lines do not end evenly, two-column text | No table; the text stays in reading order or the page falls back |
| Aligned text that is not a proven table | Rows linearized as `cell \| cell` paragraphs plus a rendered crop of the region; the rest of the page stays editable. The page falls back only when other text lies inside that region |
| A page of a multi-page table falls back | The table's parts on the other pages are imported as their own table |

Headings on untagged pages come from font style: text set clearly larger than
the size most characters are set in. Each style, a size together with bold or
regular, gets one level: larger sizes rank higher, and at one size bold ranks
above regular. The size is read from the text matrix, so Word's scaled
one-point fonts get their set size; glyph heights estimate it only when the
PDF reports none.

A table of contents is set in the styles of the headings it lists. A line
that ends in a page number at the right and whose text stands again on a
later page is a contents line; three such lines with page numbers that never
decrease make a table of contents. An entry wrapped onto several lines is
proven by its joined lines, and between the first and last entry a line without
a page number whose text stands on a later page is an entry too. Its lines are
imported as paragraphs, not headings, and its page numbers, which name pages Confluence does not have,
are suppressed with evidence (`pdf/geometry-contents-page-number-suppressed`).

Section numbers are checked against the levels: headings numbered to one
depth (`2`, `3`) should share a level, and a deeper number (`2.1`) should sit
deeper. Headings that disagree are reported as
`pdf-import/heading-numbering-mismatch` and keep their font-style level.

The same compound and dehyphenation rules apply to tagged pages and table
cells.

Bold text is recognized from the font name when the PDF reports no bold
weight (macOS Quartz reports none, LibreOffice reports 400 for bold fonts). Clause numbers, terms, and table-of-contents page numbers beside
their text are read as part of the line, not as a second column.

Reading order on untagged pages:

| Case | Result |
|---|---|
| Full-width text above or below a two-column block (for example signature blocks) | Read in bands: the full-width text, then the left column, then the right column |
| Text from the left column running into right-column text on the same line | Page falls back (`column-overlap`) |
| Underscore inside a word (`neutral_field`) | Kept in its word; its flat glyph below the baseline is not a second line |
| Line ending in a digit, an underscore, or a symbol such as `+` | Joined with the next line by one space |
| Hyphen at a line end, next line starts with a capital (`Kunden-` / `Projekt`) | Hyphen kept: `Kunden-Projekt` |
| Hyphen at a line end, next line starts lowercase | Removed as a syllable break, unless the same compound appears with its hyphen inside a line elsewhere in the PDF (`end-to-end`); then kept. When neither the compound nor the joined word appears elsewhere, the removal is reported as `pdf-import/text-dehyphenation-unproven` (info) |
| Hyphen at the end of a cell line with the next cell's text on the same line | The two are kept apart |

### Optional table-structure model

Some untagged tables have no rules and no unambiguous alignment, for example
two columns of wrapped text or a header that spans columns without borders.
For these, you can opt in to a local
[Table Transformer](https://github.com/microsoft/table-transformer) model
(Microsoft, MIT). It runs on your machine; nothing is sent anywhere.

1. Install the model and its runtime once (pinned digests, about 200 MB
   download):

   ```bash
   atlcli models pull table-transformer
   ```

2. Import with the model:

   ```bash
   atlcli wiki import contract.pdf --space DOCS --table-model table-transformer
   # Use the GPU (CoreML on macOS, CUDA on Linux, DirectML on Windows):
   atlcli wiki import contract.pdf --space DOCS --table-model table-transformer --table-model-device gpu
   ```

The model only sees areas the deterministic pass could not turn into a table,
and only proposes rows, columns, header rows and spanning cells. AtlCLI accepts
a proposal only when every character of the area fits exactly one cell and
every row and column holds text; it never adds or changes text. Accepted and
rejected proposals appear as `pdf-import/table-model-proposal-accepted` and
`-rejected` in the preview. A CPU is fast enough (tens of milliseconds per
table); `--table-model-device gpu` is optional.

| Option | Values | Default | Notes |
|---|---|---|---|
| `--table-model` | `table-transformer` | off | Requires `atlcli models pull table-transformer` |
| `--table-model-device` | `auto`, `cpu`, `gpu` | `auto` (CPU) | `gpu` falls back to CPU for unsupported operations |
| `ATLCLI_MODELS_DIR` | path | `~/.atlcli/models` | Where models and the runtime are installed |

> **Tip.** Export PDFs from Word, LibreOffice, or a browser with tagging
> ("accessible PDF") enabled. Tagged exports keep tables, lists, and reading
> order far better than untagged ones. In LibreOffice, enable
> **File > Export as PDF > General > Universal Accessibility (PDF/UA)** or
> **Tagged PDF**. Word for Mac tags PDFs only with **Best for electronic
> distribution and accessibility**.

Likewise, a PDF image object may be a mask, tile, background, or clipped layer.
AtlCLI correlates visible placement and structure evidence before native media
output. Composite and vector figures use a rendered crop when safe. A browser
`<figure>` becomes one image with its caption once, even though the PDF nests
the image's own Figure inside it.

## Import from an attachment

Use an exact attachment name from an existing Confluence page:

```bash
atlcli wiki import --from-page 123456 \
  --attachment handbook.pdf --space TEAM
```

This source acquisition uses the selected profile, so the preview is no longer
offline. The downloaded bytes enter the same signature, budget, digest, and
review pipeline as a local file.

## Original PDF retention

The source PDF is **not attached by default**. This protects against copying
hidden metadata, inactive embedded content, or sensitive material that was not
visible in the extracted wiki body.

Use `--attach-source` only after reviewing that risk:

```bash
atlcli wiki import handbook.pdf --space TEAM --attach-source --confirm
```

The source attachment has a deterministic digest-derived file name, is kept
separate from extracted figure assets, and is downloaded after upload to verify
its exact byte length and SHA-256. Requested Cloud restrictions are applied
before sensitive source or content bytes are uploaded.

## Correct extraction decisions

When a heading, title, figure alternative text, or order needs correction, use
a source-digest-bound YAML/JSON override file. Obtain `sourceId` values and the
source SHA-256 from `--json` preview output.

```yaml
schema: atlcli.pdf-import-overrides/1
sourceSha256: 0000000000000000000000000000000000000000000000000000000000000000
operations:
  - kind: set-heading-level
    sourceId: pdf:p0:s2
    level: 2
  - kind: set-figure-alt
    sourceId: pdf:p3:o7
    alt: Quarterly revenue by product group
  - kind: move-before
    sourceId: pdf:p4:b2
    beforeSourceId: pdf:p4:b1
```

To add missing figure alternative text, let AtlCLI draft the file:

```bash
atlcli wiki import handbook.pdf --space DOCSY --dry-run \
  --overrides-template handbook-overrides.yaml
```

The draft has the source digest and one `set-figure-alt` entry with an empty
`alt` per published figure without alternative text, each labeled with its
source page. Fill in every `alt` or delete the entry, then pass the file with
`--overrides`. An empty `alt` is rejected, and an existing file is never
overwritten. A supplied alt text clears that figure's
`pdf-import/figure-alt-missing` issue, so `--unsupported fail` no longer
blocks on it.

Replace the example digest and source IDs with values from the same PDF
preview. A changed source digest, stale locator, unknown field, duplicate
decision, unsafe YAML alias, file over 256 KiB, or more than 200 operations
fails closed. Supported operations are `set-heading-level`, `set-figure-alt`,
`set-title-from`, and `move-before`.

## Visibility and metadata

Cloud PDF import uses the shared destination-governance controls:

```bash
atlcli wiki import handbook.pdf --space TEAM \
  --restriction explicit \
  --viewer group-id:team-readers \
  --editor group-id:team-editors \
  --staging-parent "Private PDF imports" \
  --label handbook \
  --content-property atlcli.owner=docs \
  --confirm
```

`--restriction` accepts `inherit`, `private`, or `explicit`. Explicit mode uses
repeatable `--viewer`/`--editor` values (`account:<id>` or `group-id:<id>`).
Labels and `atlcli.*` content properties are applied and read back on the root.
The optional staging parent is import-owned and private before child content is
uploaded.

Data Center currently supports labels but rejects restrictions, staging, and
content properties before mutation.

## Options

| Option | Type | Default | Constraints / effect |
|---|---|---|---|
| `--format` | `pdf` | inferred | Required for stdin (`-`) or extensionless input. |
| `--from-page` | page ID | none | Remote source page; requires exact `--attachment`. |
| `--attachment` | file name | none | Exact `.pdf` attachment name with `--from-page`. |
| `--space` | string | profile space | Required when the profile has no default. |
| `--title` | string | file stem | Root page title. |
| `--parent` | page ID | space root | Parent for the root page or staging parent. |
| `--split` | mode | `auto` | `auto`, `off`, `heading:1..6`, `pages:5..40`, or `1..6`. |
| `--max-wiki-pages` | integer | `50` | `1..200`, including the root index. |
| `--title-conflict` | enum | `fail` | `fail` or deterministic `rename`. |
| `--reading-order` | enum | `auto` | `auto`, `tags`, or `geometry`. |
| `--scan-policy` | enum | `fail` | `fail`, `page-image`, or `report`. |
| `--visual-fallback` | enum | none | `auto`, `inline`, `collapsed`, or `appendix`; opts into visual fallback and implies scan policy `page-image`. |
| `--unsupported` | enum | `report` | `report` or `fail` on lossy constructs. |
| `--accept-reported-pages` | boolean | off | Required to publish pages omitted under scan `report`. |
| `--attach-source` | boolean | off | Retain and byte-verify the original PDF. |
| `--overrides` | path | none | Digest-bound PDF override YAML/JSON. |
| `--overrides-template` | path | none | Write a draft override file with one alt-text entry per figure without one; fails if the file exists. |
| `--restriction` | enum | `inherit` | Cloud: `inherit`, `private`, or `explicit`. |
| `--viewer`, `--editor` | repeatable principal | none | Cloud explicit restriction principals. |
| `--staging-parent` | title | none | Cloud private import-owned staging parent. |
| `--label` | repeatable string | none | Root-page labels. |
| `--content-property` | repeatable `k=v` | none | Cloud `atlcli.*` root metadata. |
| `--profile` | profile name | active | Authentication profile. |
| `--json` | boolean | off | Machine-readable preview/result. |
| `--dry-run` | boolean | preview | Never prompt or write. |
| `--confirm` | boolean | off | Publish the reviewed plan. |

PDF import is single-file/create-only in this version. DOCX-only batch,
manifest, recipe, comment, style-map, tracked-revision, resume, and in-place
update flags are rejected for PDF rather than ignored.

## Advanced example

Review a long tagged source as a private, heading-led Cloud tree, fail on any
reported loss, rename destination conflicts deterministically, and retain the
approved source:

```bash
atlcli wiki import architecture-handbook.pdf \
  --profile production \
  --space ARCH \
  --parent 123456 \
  --title "Architecture Handbook" \
  --reading-order tags \
  --split heading:2 \
  --max-wiki-pages 35 \
  --title-conflict rename \
  --scan-policy fail \
  --unsupported fail \
  --restriction private \
  --label architecture \
  --content-property atlcli.import=pdf \
  --attach-source \
  --overrides architecture-handbook-overrides.yaml \
  --confirm
```

Run the same command without `--confirm` first and retain its JSON preview and
plan digest in your change review. Do not put tenant IDs, URLs, source text, or
document bytes into a public evidence artifact.

## Cloud and Data Center behavior

| Capability | Confluence Cloud | Data Center |
|---|---|---|
| Native body | ADF | Storage format |
| Safe one-page create | Implemented; neutral live matrix proven | Implemented; contract-tested |
| Bounded page tree | Implemented; neutral 100-page live case proven | Rejected before mutation |
| Figures/page-image assets | Attachment plus native media identity | Filename-based attachment media |
| Original source retention | Opt-in, byte-verified | Opt-in, byte-verified by contract |
| Restrictions/private staging | Implemented; restriction-before-bytes live-proven | Not supported; fails before mutation |
| Labels | Implemented/read back | Contract-tested |
| Content properties | Implemented/read back | Not supported for PDF import |
| Project live certification | Certified with neutral built-CLI cases | Not certified |

Publication creates owned shells first, applies requested protection before
sensitive bytes, uploads assets, writes final bodies, applies metadata, and
performs semantic readback. A failure rolls back only the exact page IDs owned
by that run, children before parents.

## Security and privacy

- Input is bytes-only; the core accepts no URL and performs no range/network
  fetch. PDFium WASM is exact-pinned, packaged locally, and never loaded from
  its upstream default CDN.
- The current hard limits include 100 MiB input, 500 pages, 120 seconds total,
  10 seconds per page, bounded object/text/structure counts, 300 DPI, and
  bounded decoded/rendered pixels and bytes.
- PDF JavaScript, launch/remote actions, embedded files, forms/XFA, and unsafe
  links are not executed. External links are scheme-allowlisted.
- Encrypted input is rejected; no password flag exists.
- Original PDF retention is opt-in. Embedded files are never extracted by
  default.
- Local preview reports digests and bounded evidence. Do not commit customer
  PDFs, extracted bodies, tenant identifiers, live URLs, or raw API receipts.
- Never commit a customer PDF or any derived body, crop, screenshot, fixture,
  digest, or diagnostic artifact that can identify or reconstruct its content.
- Hard cancellation in browser hosts is Worker termination. The CLI checks
  cancellation and deadlines between bounded PDFium operations and releases
  page/document/bitmap/structure resources in reverse ownership order.

The packaged PDFium wrapper/WASM has exact version, release/fork commit,
integrity, license, and checksum evidence. The selected upstream distribution
does not provide an SBOM or complete transitive third-party notice inventory;
that gap is explicitly recorded and must be reconciled before a production
release claim.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Format mismatch` | Extension/flag says PDF but bytes do not start with `%PDF-` | Select the correct file or pass the correct `--format`. |
| `--reading-order tags requires a tagged PDF` | The source has no usable structure tree | Use `auto`, review conservative geometry, or obtain a properly tagged source. |
| Words appear merged in preview | A source boundary was absent or inferred incorrectly | Inspect V3 page metrics and `reviewRegions`; do not publish if the exact neutral/source-authorized review is wrong. Prefer a corrected source PDF over text post-processing. |
| `pdf/text-boundary-unresolved` blocks publication | Geometry, tags, or text-run evidence cannot prove a material join or space | Keep `--unsupported fail`, obtain a better-authored PDF, or explicitly review a localized/page fallback under the report policy. |
| `pdf/character-ownership-failed` blocks publication | A visible character is unowned or has competing semantic owners | Review the page locator and fallback scope. Do not bypass the blocker without explicit reported/fallback coverage. |
| A tagged table becomes a page image or linearized text | The table nests another table, or a cell's text has an unresolved boundary or invalid Unicode | Check `pdf-import/table-tagged-linearized` and its `reason` in the JSON preview. Re-export with tagging enabled, or flatten the nested table in the source. |
| Issue `pdf-import/table-continuation-unjoined`: the table repeats on every page | One page part does not qualify as a grid, or the table exceeds 5,000 rows | Check the issue `reason`. Each page part stays a native table when it qualifies on its own. |
| `The table model is not installed` or `The table model runtime is not installed` | `--table-model` was given before the model was pulled | Run `atlcli models pull table-transformer`, or set `ATLCLI_MODELS_DIR` to the directory you pulled into. |
| Issue `pdf-import/table-row-split-unproven` | The first row after a page break leaves cells blank that the row before fills, its text starts a new sentence, and the table leaves other cells blank too | Open the page and check the two rows: if they are one split row, join them after import, or set **Allow row to break across pages** off in the source. |
| Issue `pdf-import/table-row-split-joined` | The rest of a split row continued the row before mid-sentence, or was the only partly blank row of a table with at least five filled rows, and was joined | Usually correct. If the two rows were meant to be separate, split the row after import. |
| Issue `pdf-import/heading-numbering-mismatch` | A heading's font style ranks it differently from its section number (for example a `2.1` heading set larger than `2`) | Check the listed headings; correct them with a `set-heading-level` override. |
| A table of contents arrives as headings | Fewer than three of its lines end in a page number, or its lines repeat no heading text, so nothing proves a contents line | Correct the levels with `set-heading-level` overrides, or delete the contents and add a Confluence **Table of Contents** macro. |
| Issue `pdf-import/text-dehyphenation-unproven` | A line-end hyphen before a lowercase word was removed without evidence elsewhere in the PDF | Usually correct (a split syllable). Check compound words such as `well-known` in the listed blocks. |
| An untagged table arrives as paragraphs | No drawn grid or row rules, fewer than three aligned columns, or text crossing a cell edge | Export with table borders, or as a tagged PDF. The text is complete and in reading order either way. |
| Issue `pdf-import/document-structure-unavailable` | The structure tree could not be read as a whole (damaged cross-references or budget) | Import continues with page-scoped structure; multi-page tables may fall back. Re-save the PDF from its producer. |
| Image-only page blocks publication | Default scan policy forbids silent empty output | Choose `page-image`, or use `report` plus both publication acknowledgements. |
| Too many wiki pages | Heading/range plan exceeds `--max-wiki-pages` | Increase the cap up to 200 or choose a larger `pages:N` target; review the new plan. |
| `--split off` is rejected | Source exceeds 40 pages or a hard editability budget | Use `auto`, heading, or page-range splitting. |
| Title conflict | Planned pages duplicate one another or existing space titles | Rename source headings/root title or use `--title-conflict rename`. |
| Override is stale | PDF digest or `sourceId` changed | Generate a new JSON preview and re-author the override. |
| `--unsupported fail` blocks on `pdf-import/figure-alt-missing` | The source figures have no author alternative text | Draft alt texts with `--overrides-template`, fill them in, and pass the file with `--overrides`. |
| Data Center tree rejected | Data Center PDF trees are not implemented | Import a safe one-page PDF or target Cloud; AtlCLI will not flatten it. |
| Encrypted PDF rejected | Password-protected input is outside V1 | Export an approved unencrypted copy through your document-governance process. |
| Browser/Forge command is missing | Only the reusable browser Worker capability exists | Use the CLI; product UI integration is a later gated feature. |

## Related topics

- [DOCX Import](/confluence/import-docx/)
- [Attachments](/confluence/attachments/)
- [Labels](/confluence/labels/)
- [Authentication](/authentication/)
- [Package asset contract](/reference/asset-contract/)
- [Troubleshooting](/reference/troubleshooting/)
