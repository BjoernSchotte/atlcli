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

## What is supported

| PDF source feature | Import result |
|---|---|
| Tagged headings H1-H6 | Native headings when marked-content correlation is complete |
| Digital text | Native paragraphs with page/region provenance |
| Tagged or qualified lists | Native ordered/bullet lists; otherwise conservative paragraphs or a reported outcome |
| Safe `http`, `https`, and `mailto` links | Native links after scheme filtering |
| Tagged tables with proven cells/spans | Native tables |
| Simple qualified untagged grids | Native tables only above the geometry threshold |
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

There is no OCR fallback. Hidden OCR text is treated as evidence to validate,
not as permission to duplicate or invent visible content.

`--visual-fallback auto|inline|collapsed|appendix` is the clearer opt-in and
implies `--scan-policy page-image`. `auto` is recommended: localized unsafe
content becomes a labeled inline crop, while a whole-page visual backup is
placed in a collapsed **Original visual view** section. `inline` exposes the
whole-page backup directly, `collapsed` makes that choice explicit, and
`appendix` collects whole-page views under **Original visual views** at the end
of each generated wiki page. Region crops remain next to their source content
in every mode. Tiny degenerate tag boxes are reported without adding an image;
unclaimed visible text and unlocalizable loss still require a whole-page view.

## Figures, tables, and reading order

`--reading-order auto` uses valid tags first and conservative geometry for an
untagged document. `--reading-order tags` requires a tagged PDF and fails if
tags are absent. `--reading-order geometry` deliberately ignores tags and is
useful only after reviewing the changed order and confidence.

PDFium exposes text, geometry, tags, page objects, annotations, and rendering
primitives; it does not provide a native semantic table importer. AtlCLI emits
a native table only when tag/cell/span or qualified rectangular-grid evidence
passes its threshold. Borderless, nested, rotated, ambiguous, or continued
tables fall back or report instead of receiving invented cells.

Likewise, a PDF image object may be a mask, tile, background, or clipped layer.
AtlCLI correlates visible placement and structure evidence before native media
output. Composite and vector figures use a rendered crop when safe.

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
| Image-only page blocks publication | Default scan policy forbids silent empty output | Choose `page-image`, or use `report` plus both publication acknowledgements. |
| Too many wiki pages | Heading/range plan exceeds `--max-wiki-pages` | Increase the cap up to 200 or choose a larger `pages:N` target; review the new plan. |
| `--split off` is rejected | Source exceeds 40 pages or a hard editability budget | Use `auto`, heading, or page-range splitting. |
| Title conflict | Planned pages duplicate one another or existing space titles | Rename source headings/root title or use `--title-conflict rename`. |
| Override is stale | PDF digest or `sourceId` changed | Generate a new JSON preview and re-author the override. |
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
