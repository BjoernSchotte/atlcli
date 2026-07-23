# Export gap analysis: Confluence ADF notation to DOCX and PDF

Status: active implementation and progress register
Analysis date: 2026-07-22
Progress last reconciled: 2026-07-23
Repository baseline: `75b7379` (`main` at implementation-branch start)
Official schema baseline: `@atlaskit/adf-schema@56.1.13`, resolved from Atlassian's canonical ADF schema URL on 2026-07-22

## 1. Objective

This document maps the currently observable Confluence Cloud rich-content surface to atlcli's DOCX and Typst/PDF export paths. The long-term objective is the highest practical coverage of Confluence ADF semantics, with every loss or approximation made explicit and testable.

The analysis separates three layers that must not be conflated:

1. **Editor input notation** such as backticks, `:`, `[]`, or `<>`.
2. **Stored document semantics** such as an ADF `emoji` node or a `text` node with a `code` mark.
3. **Export rendering** in DOCX or PDF.

An exporter should normally consume stored semantics. It must not reinterpret arbitrary page text as editor shorthand. For example, raw `:warning:` text must remain literal unless Confluence has already turned it into an emoji node or another typed representation.

## 2. Executive finding

The implementation branch has replaced the original Cloud Storage-first
baseline with an **ADF-primary, version-bound source path** for the TypeScript
DOCX and Typst/PDF engines:

```text
Confluence atlas_doc_format -- validateAdf() --+
                                                |
Storage sidecar -- only for unresolved macros --+--> pageBodyToBlocks()
                                                     |
                                                     v
                                           ExportBlock[] + InlineNode[]
                                               |                 |
                                               v                 v
                                      TypeScript DOCX       Typst/PDF
```

The original baseline used `ConfluenceClient.getPage()` plus `body.storage`.
Cloud export-specific reads now request ADF, validate the pinned contract, and
decode through the representation-neutral `pageBodyToBlocks()` boundary.
Storage remains a compatibility adapter, the Data Center source, and a
version-matched sidecar for definitions that are not yet ADF-native. Durable
background-host integration remains a separate, explicitly open work package;
it must enter at the same source boundary and must not fork renderer behavior.
Third-party `adfExport` ingestion also remains incomplete. See [E1], [E2],
[E3], and [E4] for the original baseline evidence and `PLAN.md` for the
implementation evidence ledger.

Consequences:

- Coverage is now measurable against all 43 nodes and 17 marks in the pinned
  schema rather than being conditional on an undocumented ADF-to-Storage
  projection.
- Unsupported semantics are visible and diagnosed, but not every node,
  attribute, or mark yet has a native neutral-model representation.
- DOCX and PDF intentionally share parse/model semantics; target-specific gaps
  begin only after the shared model boundary.
- A defensible 100% target still requires the remaining matrix gaps plus a
  broader sanitized, observed Confluence corpus. Schema coverage alone is not a
  product-fidelity claim.

## 3. Scope and source policy

### In scope

- The 43 semantic node types and 17 marks in the pinned official full ADF schema.
- Confluence Cloud editor features explicitly documented by Atlassian.
- Current Storage-XHTML, `export_view`, `ExportBlock`, DOCX, and Typst/PDF behavior.
- Only the TypeScript DOCX and Typst/PDF engines, across CLI and isomorphic
  browser hosts; the retired Python export engine is not an acceptance path.
- Static export semantics, visual fidelity, fallback behavior, reporting, and test coverage.
- Core and third-party macros/extensions where they intersect with exported page content.

### Out of scope

- Treating the ADF superset as proof that every node is accepted in every Confluence context. Atlassian explicitly warns that schema members may not be valid in a particular product implementation.
- Comments, unpublished drafts, space selection, page ordering, headers/footers, and other document-scope behavior except where it changes content-node fidelity.
- Reproducing interactive behavior in a static document. The requirement is a meaningful static representation plus an explicit report when behavior cannot survive.
- Data Center Storage XHTML parity. This analysis targets Confluence Cloud ADF semantics; Cloud and Data Center need distinct source adapters.

## 4. Status model

| Status | Meaning |
|---|---|
| **Native** | The semantic value is represented in the intermediate model and intentionally rendered by the target engine. |
| **Open** | The gap is technically actionable in this export project. Some content may already survive, but the row stays unchecked until the complete static-export contract and its evidence exist. |
| **Partial** | A proven subset is complete, but closure is blocked by a specifically named external contract or parallel work package. “Partial” is never a resting state for work that can be completed in this branch. |
| **Fallback** | The exporter emits plain text, a link, transparent body content, or a visible placeholder instead of native semantics. |
| **Missing** | No source-model and target-rendering contract exists. Content may disappear or survive only accidentally through transparent descent. |
| **Conditional** | Native-looking output depends on external resolution, assets, fonts, live app execution, or host wiring. |
| **N/A** | Structural wrapper only; no standalone visual output is expected. |

“Native” is not equivalent to “pixel-identical to Confluence.” Visual parity requires a render/golden test in addition to semantic preservation.

### 4.1 Progress tracking convention

This document is the live gap register. Every completed work package must
update both its matrix rows and the checklist below in the same commit:

- `[x]` means the named gap is closed with the applicable semantic, target,
  browser, report, and rendered evidence.
- `[ ]` plus **Open** means the complete native/static contract is technically
  actionable here and remains backlog.
- `[ ]` plus **Partial** is permitted only when the remaining sub-gap names its
  external contract or parallel-work dependency.

Current matrix orientation: **72 of 84 rows closed; 12 rows open.** This count
must change in the same commit as any row checkbox.
`scripts/adf-gap-register.test.ts` enforces the checkbox shape, reconciles
these counters with every progress-table row, and rejects an unchecked
`Partial` row unless it names an external or parallel dependency.

Current closed foundations and feature slices:

- [x] Pinned ADF schema, bounded validator, exhaustive coverage manifest, and
  non-blocking weekly upstream/observed-product drift watch.
- [x] ADF-primary Cloud source selection for the TypeScript DOCX and Typst/PDF
  CLI paths, with explicit Storage compatibility/sidecar behavior.
- [x] Shared Node/Bun and browser decoding/rendering shapes with packed
  conformance and direct/background artifact/report parity.
- [x] Ordered-list authored starts and independent nested restarts.
- [x] Nested bullet, numbered, and task lists retain parent ownership across
  direct ADF and `body.storage`, both TypeScript targets, composition, browser
  execution, and rendered artifacts.
- [x] Paragraph/heading alignment and indentation, plus schema-defined small
  paragraph text.
- [x] Standard panel kinds including distinct success/error semantics and
  palettes.
- [x] Custom panels retain local identity, canonical portable color, emoji
  short name, custom-emoji identity, and visible icon text. DOCX/PDF render
  portable color/icon presentation; non-portable color and ID-only icons stay
  retained and produce explicit fallback diagnostics.
- [x] Emoji identity, exact source text, deterministic short-name fallback, and
  typed fallback reporting.
- [x] Mention account/collection identity, exact optional source text, local
  identity, access scope, pinned user type, resolver behavior, and
  privacy-safe unresolved labels across both TypeScript targets.
- [x] Inline-code background treatment and exact token preservation in both
  targets, with a license-validated bundled JetBrains Mono face embedded into
  every DOCX that contains inline or block code.
- [x] Pinned-schema task lists, inline and block task items, nested tasks,
  decision lists/items, local identities, and exact states.
- [x] Pinned ADF layout sections/columns and documented Storage layout sections
  retain column ownership, proportions, vertical alignment, and available local
  identity through both static TypeScript targets.
- [x] Inline, block, embed, and datasource Smart Cards retain every pinned ADF
  attribute and opaque provider payload. Safe targets remain clickable,
  composition rewrites in-scope page targets, both engines render deterministic
  static card presentation, and supported datasource providers enter the
  existing live macro-resolution chain with the same static card as fallback.
- [x] Native ADF media captions retain inline content/local identity and remain
  attached to a numbered figure even when the media ID cannot be resolved.
  ADF `expand`/`nestedExpand` and Storage `expand` retain their recursive
  boundary, title, identity, and nesting context in a deterministic open static
  projection for DOCX/PDF.
- [x] Semantic dates, status lozenges, and template placeholders retain their
  pinned ADF identity through the neutral model. `body.storage` time/date,
  status, and placeholder forms map to the same contract; both targets localize
  dates in UTC, preserve status style/color semantics, and hide editor-only
  placeholder text.
- [x] Paragraph, heading, and ordinary list-item local identities survive
  validation, direct ADF and available Storage forms, composition, both
  renderer inputs, and packed direct/background source resolution without
  changing visible output.
- [x] Pinned ADF code blocks retain exact text, optional language, tri-state
  wrap intent, line-number policy, local identity, and unique identity.
  DOCX/PDF render syntax-colored, numbered, page-bounded code without clipping;
  an authored no-wrap preference is retained and explicitly reported when a
  static page must wrap it. Storage code/noformat defaults plus
  `linenumbers`/`firstline` are normalized separately.
- [x] Media `dataConsumer` marks retain every ordered mark boundary and exact
  source array as non-visual provenance. Both targets omit opaque source IDs
  from published content and the shared report states the bounded static
  projection without echoing those identifiers.
- [x] Pinned `bodiedSyncBlock` snapshots retain embedded block content, exact
  opaque identity, projection provenance, and breakout intent. Reference-only
  `syncBlock` nodes retain the same identity and render a deterministic
  unavailable-content projection. Both TypeScript targets keep the opaque IDs
  non-visual, and composition plus direct/background browser parity preserve
  the neutral contract.
- [ ] **Open:** `breakout` intent is retained on ADF layout sections and
  explicitly reported as page-bounded; breakout on other schema-valid block
  types and true wide/full-width section geometry remain open.
- [ ] **Open:** annotation and fragment identities are validated and retained
  through the neutral model, composition, and packed-browser source resolution;
  native comments/PDF notes, separately fetched comment bodies, and a documented
  fragment-to-bookmark policy remain open. Applying a block export-control
  removes its marked wrapper by design and now emits an explicit residual note.

Current cross-cutting residuals:

- [ ] **Partial:** durable background-host source integration is deferred until
  synchronization with the parallel job-host work.
- [ ] **Open:** the real sanitized Confluence corpus covers selected live
  slices, not yet every supported editor feature.
- [ ] **Open — Storage compatibility only:** legacy code-macro `title` and
  `collapse` parameters still need a typed static projection. They are not
  attributes of the pinned ADF `codeBlock` node.
- [ ] **Partial:** complete emoji glyph coverage and custom-emoji assets are
  blocked on a documented, authorized Atlassian asset-resolution contract.

## 5. Official baseline and documentation drift

The official ADF structure page documents the root, block/inline distinction, a human-oriented node list, and a canonical JSON schema. It also states that schema members may not be valid in a given implementation. Confluence REST v2 officially exposes `atlas_doc_format` through the page `body-format` parameter, so an ADF-native read path is technically available.

The pinned full schema contains:

- **43 semantic nodes**;
- **17 marks**;
- schema variants that restrict context or allowed marks but do not introduce additional semantic node types.

The human node index and the machine-readable schema drift. For example, the human page currently mentions `multiBodiedExtension` and `extensionFrame`, while neither is in the pinned full schema. Conversely, the schema contains Confluence-relevant layouts, tasks, decisions, cards, extensions, captions, synced content, placeholders, and additional marks that the human index does not enumerate completely.

Therefore the coverage contract must pin both:

1. a canonical schema version; and
2. an observed Confluence Cloud feature corpus.

Neither alone is a complete Confluence export contract.

## 6. Complete ADF node matrix

The matrix covers every semantic node type in
`@atlaskit/adf-schema@56.1.13`. “Source” describes the current direct ADF path
plus the distinct Storage/export-view compatibility adapters.

### 6.1 Root and basic content

| Done | ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|---|
| [x] | `doc` | Cloud ADF version 1 is bounded and validated before decoding; Storage remains a separate compatibility adapter. | N/A | N/A | Native source contract is complete; observed-product corpus breadth remains tracked separately. |
| [x] | `paragraph` | `<p>` or loose inline content becomes a typed paragraph; direct ADF additionally retains local identity, logical alignment, indentation, and the schema-defined `small` font size. Storage paragraph identity is retained when the wrapper maps to one semantic paragraph. | Native | Native | Closed for the pinned schema; local identity remains non-visual metadata by design. |
| [x] | `heading` | `<h1>`…`<h6>` retains level, inline content, and local identity; direct ADF additionally retains logical alignment and indentation. | Native | Native | Closed for the pinned schema. Composed level rebasing remains an explicit document policy and does not discard source identity. |
| [x] | `text` | Unicode text is retained and XML/Typst escaped. | Native | Native | Closed semantically; target font fallback is a renderer/platform constraint tracked separately where a guaranteed bundled font is required. |
| [x] | `hardBreak` | ADF `hardBreak` and Storage `<br>` become `lineBreak`. | Native | Native | Closed with direct ADF and Storage coverage. |
| [x] | `rule` | ADF `rule` and Storage `<hr>` become `divider`. | Native | Native | Closed with direct ADF and Storage coverage. |
| [x] | `blockquote` | Structured body becomes `blockquote`. | Native static projection | Native static projection | Closed; target-owned static styling is not ADF notation loss. |
| [x] | `codeBlock` | Direct ADF retains exact code (including empty/final lines), optional language (including empty), tri-state `wrap`, normalized `hideLineNumbers`, `localId`, and `uniqueId`. Storage `<pre>`/`code`/`noformat` retain their separate no-gutter default; `linenumbers`, `firstline`, language, and macro local identity survive where present. | Native with page-bound no-wrap policy | Native with page-bound no-wrap policy | Closed for the node's pinned content/attribute contract. Both targets render syntax-highlighted code and authored line numbers; continuation lines align after the gutter. A requested no-wrap state remains in the neutral model and emits `code-nowrap-page-bounded` when bounded pages wrap instead of clipping. The separately classified root `breakout` mark and legacy Storage-only title/collapse remain explicit open rows/residuals. |

Evidence: [E2], [E5], [E6], [E7], [E8].

### 6.2 Lists, tasks, and decisions

| Done | ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|---|
| [x] | `bulletList` | ADF `bulletList` and Storage `<ul>` become `list { ordered: false }`; child lists remain inside the owning item. | Native | Native | Nested ADF/Storage differential fixtures, target structure tests, packed-browser assertions, and real render goldens are complete. Maximum nesting and resource budgets remain exporter constraints. |
| [x] | `orderedList` | Storage `<ol start>` and ADF `orderedList.order` become `list { ordered: true, start? }`; child lists remain inside the owning item. | Native | Native | Authored starts, including zero, survive the neutral model. DOCX emits a self-contained single-level numbering definition per ordered-list node; PDF emits Typst `enum(start:)`. Each nested node owns an independent restart, visual indent, and correctly indexed PDF source-map path. |
| [x] | `listItem` | Child blocks and exact optional local identity are recursively preserved for direct ADF and available Storage list markup. | Native | Native | Closed through nested composition and both renderer inputs. |
| [x] | `taskList` | ADF and Storage become a typed task list with list identity where exposed. ADF sibling task lists attach to the preceding owning item; Storage task lists inside `<ac:task-body>` remain child blocks of that task. | Native | Native | Paired ADF/Storage nesting, both target markers/indents, browser parity, and real render goldens are complete; any future observed product-specific attributes enter the drift lane. |
| [x] | `taskItem` | Required `localId`, exact `TODO`/`DONE` state, direct inline content, and checkbox projection are retained. | Native | Native | Closed with distinct open/done markers, composition, browser parity, and real render goldens. |
| [x] | `blockTaskItem` | Required identity/state and one-or-more block children remain a distinct typed task item. | Native | Native | Closed with block-content and nested-list coverage. |
| [x] | `decisionList` | Required list identity and decision grouping are retained directly from ADF. | Native | Native | Schema-only source contract; no equivalent Storage projection is claimed. |
| [x] | `decisionItem` | Required local identity, exact product-defined string state, and direct inline content are retained. | Native | Native | `DECIDED` uses a filled decision marker; nonstandard states remain visibly labeled rather than being collapsed. |

Evidence: [E2], [E5], [E7], [E8], [E9].

### 6.3 Tables

| Done | ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|---|
| [x] | `table` | Rows, widths, exact pinned presentation attributes, editor identity, and fragment identity become a typed table. An enabled numbered column is materialized once through a shared renderer helper. | Native bounded projection | Native bounded projection | Closed for the pinned schema. Positive authored width, alignment, display mode, numbered columns, and identity survive; invalid/non-portable geometry is bounded and reported, and physical-page bounds are an explicit static-target policy. |
| [x] | `tableRow` | Row order, cells, and exact optional local ID (including empty) are preserved. | Native | Native | Closed for the pinned schema. |
| [x] | `tableHeader` | ADF `tableHeader` / Storage `<th>`, identity, per-cell `colwidth`, background, spans, and vertical alignment are preserved. | Native | Native | Closed with bounded portable geometry. |
| [x] | `tableCell` | Content, identity, `colspan`, `rowspan`, background, exact `colwidth` vector (including zero/unfixed tracks), and `valign` are preserved. | Native | Native | Closed; pathological/non-portable geometry is safely clamped and reported rather than allowed to exhaust a renderer. |

The pinned table attribute contract is now complete through validation, neutral
model, composition, packed browser execution, and both TypeScript renderers.
Wide-table pagination and target page bounds remain document-layout concerns,
not silent ADF notation loss.

Evidence: [E10], [E11], [E12], [E27].

### 6.4 Layouts and containers

| Done | ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|---|
| [x] | `layoutSection` | ADF becomes a typed layout with exact optional local identity and retained breakout intent. Storage `ac:layout-section` maps the documented `single`, `two_*`, and `three_*` arrangements to explicit portable tracks; missing/mismatched geometry uses equal tracks with a source-located note. | Native for pinned columns | Native for pinned columns | DOCX uses a borderless fixed OOXML table and PDF uses a semantic-free Typst grid. The pinned ADF schema and documented Storage shapes are closed; Cloud editor layouts beyond the pinned schema remain in the drift/observed-product lane. |
| [x] | `layoutColumn` | Required ADF percentage width, optional exact local identity, top/middle/bottom alignment, and recursively nested content survive. Storage cells inherit the section's documented proportions. | Native | Native | Schema-valid zero-width tracks remain visible through a bounded minimum and are reported. Nested headings/anchors, mentions, macros, assets, lists/tasks, and export controls traverse the column rather than being flattened or skipped. |
| [x] | `panel` | ADF `info`, `note`, `warning`, `tip`, `success`, and `error` remain distinct callout kinds; Storage callouts use the same neutral model. Custom panels additionally retain exact optional local identity, emoji short name, custom-emoji identity, visible icon text, and a canonical portable color (including normalized short hex); non-portable source colors remain exact. | Native bounded projection | Native bounded projection | Closed for the pinned schema. Both targets use the authored portable color as an accent with a contrast-safe tinted background and prefer visible icon text over a short name. A non-portable color or ID-only custom emoji remains visible with source metadata plus a typed degradation note rather than silently claiming native rendering. |
| [x] | `expand` | ADF and Storage become a recursive `expand` block retaining exact optional title/local identity; Storage additionally retains macro identity. | Native static projection | Native static projection | Closed for static export: both targets render the full body visibly open and report that interaction/collapsed state is inapplicable. Storage and ADF are differentially tested. |
| [x] | `nestedExpand` | A distinct nested disclosure survives with title, local identity, body ownership, and nesting context. Storage expands inside table cells or another expand use the same neutral shape. | Native static projection | Native static projection | Closed for the pinned static-export contract; the editor's interactive toggle is intentionally not claimed. |
| [x] | `caption` | A pinned-schema ADF caption's direct inline children and exact optional local identity remain attached to its `mediaSingle`. Scroll `scroll-title` remains a separate Storage adapter. | Native | Native | Closed for native caption association and numbering. Unresolved media renders as a visible numbered fallback instead of detaching the caption; media layout/group semantics are covered by their own checked rows. |

The layout renderers intentionally use target-owned static geometry. They do
not claim browser-responsive behavior, and `wide`/`full-width` breakout cannot
extend beyond the physical DOCX/PDF page. That residual is explicit rather
than a silent column loss.

Evidence: [E2], [E5], [E7], [E8], [E13], [E28], [E33].

### 6.5 Inline semantic content

| Done | ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|---|
| [x] | `date` | ADF epoch-millisecond timestamp/local identity and Storage `<time>` or legacy `date` macro values become one typed date. | Native | Native | Both targets render a neutral date chip with document-locale formatting in UTC. Invalid but schema-valid timestamps remain exact visible source text and emit `date-invalid`; units are never guessed. |
| [ ] | `emoji` | ADF and Storage both retain `shortName`, optional service `id`, the exact optional source text (including empty text), and whether the visible run came from text or the short-name fallback. Raw colon text is never reinterpreted. | Partial/Conditional | Partial/Conditional | **Partial — external contract:** Unicode text and deterministic fallback are native, but custom/Atlassian emoji require a documented, authorized portable asset resolver and complete glyph policy. |
| [x] | `mention` | ADF retains exact account-or-collection ID, optional source text (including empty), local identity, access level, and pinned `DEFAULT`/`SPECIAL`/`APP` user type. Storage retains its available identity/name form. Host resolution may enrich the visible display name without replacing source metadata. | Native static projection | Native static projection | Closed for the pinned schema. Both targets render the source/resolved name; unresolved or deactivated identities use deterministic `Unknown user`/`Unknown app` labels and never leak the raw ID. No profile hyperlink is invented because the pinned ADF node carries no profile URL. Product-specific attributes enter the drift lane. |
| [x] | `status` | ADF text, exact semantic color, optional local identity/style, and Storage status macros become one typed status. | Native static projection | Native static projection | The pinned ADF color enum is validated; `mixedCase` preserves casing and other styles use Confluence-style uppercase. Both targets have explicit neutral/purple palettes plus deterministic legacy/unknown-color fallback. |
| [x] | `placeholder` | ADF text/local identity and Storage `<ac:placeholder>` text/type become a typed editor instruction. | Native hidden projection | Native hidden projection | Confluence hides template placeholders in published view, so both targets intentionally emit no visible text while the neutral model retains identity for tooling/composition. No degradation is reported for this correct projection. |

Evidence: [E2], [E5], [E7], [E8], [E14], [E23], [E30], [E34].

### 6.6 Cards and links

| Done | ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|---|
| [x] | `inlineCard` | Typed Smart Card retains exact URL/data/local identity, derives a stable title only from the schema-opaque data payload, and creates a target only after the shared scheme gate. | Native static projection | Native static projection | Closed for the pinned schema: both targets render a clickable inline chip; unsafe URLs remain visible and non-clickable with a warning. Opaque provider metadata is retained without speculative interpretation or network execution. |
| [x] | `blockCard` | Typed Smart Card retains every URL/data/datasource/layout/width/local attribute. Supported datasource providers enter the existing live macro chain; unknown/offline providers keep the complete static card. | Native static/live projection | Native static/live projection | Closed for the pinned schema and current provider registry. Static bordered cards are deterministic in both targets, and live datasource resolution reuses the existing bounded macro renderer/fallback/report path rather than forking behavior. |
| [x] | `embedCard` | Typed Smart Card retains exact URL, layout, width, original dimensions, and local identity. | Native static projection | Native static projection | Closed for the pinned schema: both targets render a bordered, labeled, clickable embed placeholder. Poster/thumbnail/provider fetches are not pinned ADF attributes; opaque future attributes enter the drift lane instead of becoming an invented export contract. |

Plain ADF link marks are uniform and clickable across text, page, attachment,
and media placements. Composed in-scope page links become internal anchors;
otherwise the exact safe source href remains the external fallback. Smart-card
card semantics are now retained independently from link marks; provider-owned
opaque data is preserved but never executed or fetched by the static renderer.

Evidence: [E5], [E7], [E8], [E15], [E16], [E38].

### 6.7 Media

| Done | ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|---|
| [x] | `media` | The exact pinned file/link/external union, Media Services identity, alt/dimensions, annotations, border/link marks, and correlated attachment metadata survive. Official v2 MIME/UI/download metadata distinguishes images from files; images enter the bounded asset pipeline, non-images become named clickable static attachment cards, and unresolved identities remain visible without guessing or fetching. | Native/Conditional | Native/Conditional | Closed for the complete pinned node. Conditional byte availability is an asset-resolution outcome, not lost ADF syntax; the pinned schema contains no crop attribute. |
| [x] | `mediaGroup` | Every child retains its exact group index/size boundary. Both targets render a deterministic shaded attachment/gallery cluster while preserving each image, file card, link, border, and diagnostic independently. | Native | Native | Closed with multi-item decoder, target, packed-browser, and visual-fixture coverage. |
| [x] | `mediaSingle` | Layout, exact optional local identity, percent/pixel width and width type, child dimensions, caption, link, and border survive. DOCX uses native inline/anchored drawings with square left/right text wrapping. Typst has no native contour/text-wrap layout: PDF therefore keeps source order and projects a wrap layout plus its directly following paragraph into an authored-width side-by-side grid; without a following paragraph it preserves the requested side alignment. Wide/full-width use the bounded target content width. | Native | Approximation | Closed for every pinned layout/geometry attribute and for the strongest deterministic static PDF projection the selected Typst engine supports. A real render proves that PDF media never floats ahead of earlier headings/content. Native PDF contour wrapping is an explicit renderer dependency, not locally omitted ADF decoding. The pinned schema and official node contract expose no crop attribute. |
| [x] | `mediaInline` | A true typed inline-media node retains file/link/image type, Media Services and local identity, opaque data, alt, dimensions, annotations, border, safe link, and correlated image source. Image bytes enter the same bounded, deduplicated asset pipeline as block media; file/link/unresolved variants remain deterministic inline chips. | Native/Conditional | Native/Conditional | Closed for the complete pinned node. DOCX emits a real paragraph-local drawing run with authored size, picture-shape border/alpha, alt text, and hyperlink. PDF emits a baseline-aligned Typst `box(image(...))` with authored size, border, alt text, and hyperlink. Asset-resolution failure preserves the typed chip and emits the shared image diagnostic rather than changing paragraph order. |

Image byte support, SVG rasterization, external-asset policy, missing-alt
reporting, and visible failure fallbacks now cover the operational side of the
pinned media contract; unavailable bytes remain a conditional host outcome,
not an unchecked syntax gap.

Evidence: [E2], [E7], [E8], [E17], [E39], [E40].

### 6.8 Extensions, macros, and synced content

| Done | ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|---|
| [ ] | `extension` | ADF and Storage retain extension/macro identity, structured parameters, body where present, fragments, and source page context before the live renderer chain. | Open/Conditional | Open/Conditional | **Open:** define native/fallback projection for generic extension output and complete `adfExport` ingestion; registry or `export_view` resolution remains conditional. |
| [ ] | `inlineExtension` | ADF retains inline placement, extension identity/parameters/fragments, and a visible label; export controls are consumed semantically. | Open/Fallback | Open/Fallback | **Open:** render a richer inline body/text fallback without splitting the paragraph and integrate third-party `adfExport`. |
| [ ] | `bodiedExtension` | ADF/Storage identity, rich/plain body, structured parameters, fragments, and source context are retained before resolution. | Open/Conditional | Open/Conditional | **Open:** complete generic native/fallback presentation and third-party `adfExport` ingestion independent of live registry success. |
| [x] | `syncBlock` | The reference-only node retains exact resource/local identity, projection kind, and optional breakout intent as non-visual provenance. Because the pinned contract carries no embedded body and no public resolver contract is documented, both targets render a deterministic unavailable-content callout without exposing opaque IDs. | Approximation | Approximation | Closed for every pinned attribute and its strongest safe static projection; executing Confluence-internal synchronization is outside the documented ADF export contract. |
| [x] | `bodiedSyncBlock` | Exact resource/local identity, embedded snapshot blocks, projection kind, and optional breakout intent survive validation, decoding, composition, CLI/browser resolution, and both static targets. Synchronization is not executed; the embedded ADF body is the exported snapshot. | Approximation | Approximation | Closed for every pinned attribute and embedded child. Both targets visibly label the snapshot, preserve its rich body, keep opaque IDs non-visual, and report page-bounded breakout behavior. |

The async registry currently covers TOC, Jira/JiraIssues, Confluence datasource lists, draw.io/Gliffy, multiexcerpt include, Scroll table layout, children, include/excerpt, page-properties report, and then an `export_view` catch-all. Every other macro falls to a visible placeholder with preserved body where available. This is good loss visibility, but it is not generic ADF extension support.

Forge macros may provide an `adfExport` function for `pdf`, `word`, or `other`. That output should ultimately be ingested as ADF, not only as flattened `export_view` HTML.

Evidence: [E2], [E3], [E4], [E18], [E19], [E42].

### 6.9 Schema/documentation drift watchlist

These types are mentioned by the human ADF documentation or may appear in product-specific/legacy payloads, but are not semantic node types in the pinned full schema:

| Done | Type/family | Current handling | Required policy |
|---|---|---|---|
| [ ] | `multiBodiedExtension` | No typed model; may arrive as wrapper/macro/export-view content. | **Partial — external observation:** keep a product-corpus fixture and support behind an observed-version gate if Confluence emits it. |
| [ ] | `extensionFrame` | No typed model. | **Partial — external observation:** preserve visible body and extension identity if the observed-product corpus proves that Confluence emits it. |
| [ ] | `unsupportedBlock` / `unsupportedInline` and `ac:adf-node` wrappers | Storage wrappers are traversed transparently. | **Open:** preserve original type/attributes in a typed unsupported node plus warning and visible fallback. |

## 7. Complete ADF mark matrix

This covers all 17 marks in the pinned schema.

| Done | ADF mark | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|---|
| [x] | `strong` | Direct ADF and `<strong>`/`<b>` become `bold`. | Native | Native | Closed with direct-ADF, Storage, and serializer fixtures. |
| [x] | `em` | Direct ADF and `<em>`/`<i>` become `italic`. | Native | Native | Closed with direct-ADF, Storage, and serializer fixtures. |
| [x] | `underline` | Direct ADF and `<u>` become `underline`. | Native | Native | Closed with direct-ADF, Storage, and serializer fixtures. |
| [x] | `strike` | Direct ADF and `<s>`/`<del>`/`<strike>` become `strike`. | Native | Native | Closed with direct-ADF, Storage, and serializer fixtures. |
| [x] | `code` | Direct ADF and `<code>` become an exact inline-code run. | Native | Native | Closed: exact text, adjacency, source-highlight precedence, code-plus-annotation retention, and separation from block code are fixture-pinned. DOCX embeds the bundled OFL JetBrains Mono face through the standard font-table relationship chain; PDF uses its bundled mono face and themed chip. |
| [x] | `subsup` | The exact ADF `sub`/`sup` enum and Storage tags become separate sub/sup marks. | Native | Native | Closed with direct-ADF coverage and deterministic target projection. |
| [x] | `textColor` | Direct ADF and Storage span color become normalized static RGB. | Native | Native | Closed for static export; flattening theme tokens to authored print color is intentional. |
| [x] | `backgroundColor` | Direct ADF and Storage span background become normalized static RGB. | Native | Native | Closed for schema-valid mark placement and static target color. |
| [x] | `fontSize` | The schema-defined paragraph value `small` becomes target-neutral block presentation. | Native | Native | Validation rejects other values; DOCX emits explicit 9 pt runs and PDF uses the template's `adfSmallText` role with a safe 9 pt fallback. |
| [x] | `link` | The exact safe href becomes a typed external/page/attachment/anchor target; optional `title`, `id`, `collection`, and `occurrenceKey` remain distinct provenance. Unsafe schemes keep visible content and a warning. | Native | Native | Closed for every pinned mark placement: text and media links are clickable in both targets, in-scope pages prefer collision-safe internal anchors, page/attachment/media fallbacks retain their exact safe href, DOCX uses `title` as a ScreenTip, and composition preserves the remaining ADF attributes. Smart-card nodes are complete in their separate checked rows. |
| [ ] | `annotation` | Required `id` and exact `inlineComment` type are validated and retained on text/media ranges. | Open | Open | **Open:** fetch/correlate comment bodies and implement native Word-comment/PDF-note output under an explicit export policy. |
| [x] | `alignment` | ADF `center`/`end` becomes target-neutral block presentation on paragraphs/headings. | Native | Native | DOCX emits logical `w:jc`; PDF emits Typst `align`. |
| [x] | `indentation` | ADF levels 1–6 become bounded target-neutral block indentation. | Native | Native | DOCX and PDF use target-owned, deterministic per-level steps distinct from list nesting. |
| [ ] | `breakout` | `wide`/`full-width` mode and optional numeric width are validated and retained on layout sections. Other schema-valid block placements still degrade visibly. | Open | Open | **Open:** generalize the retained mark to code/expand/sync blocks and define the target-owned page/section widening policy. |
| [x] | `border` | Exact pinned six/eight-digit color and size 1–3 are validated and retained on block/inline media. DOCX emits run/paragraph borders and PDF emits target-native strokes; alpha-bearing source colors retain their exact neutral value and use their portable RGB component for print. | Native | Native | Closed with invalid-shape, block, inline, group, DOCX, PDF, and packed-browser fixtures. |
| [x] | `dataConsumer` | The exact ordered mark boundaries and each non-empty source array are validated and retained on `media`/`mediaInline` identity. | Native non-visual provenance | Native non-visual provenance | Closed for the pinned schema: DOCX/PDF intentionally render no consumer binding or opaque source ID, while the shared source-located report states that product-internal execution is unavailable. Composition, PDF preparation, packed-browser parity, and a no-pixel-drift rendered golden prove retention without publication. |
| [ ] | `fragment` | Required non-empty `localId` and exact optional `name` are retained on inline/block extensions and tables. | Open | Open | **Open:** define documented fragment semantics and a collision-safe bookmark/link projection instead of leaving identity non-visual. |

Evidence: [E2], [E5], [E7], [E8], [E20], [E21], [E26].

## 8. Editor notation mapping

Official Confluence documentation describes these input shortcuts. They are editor transformations, not syntax the exporter should parse from arbitrary stored text.

| Done | Editor input | Intended stored semantic result | Current export outcome | Gap/acceptance fixture |
|---|---|---|---|---|
| [x] | `**Bold**` | `strong` | Native after Confluence materializes it. | Direct ADF, Storage, and target fixtures are complete. |
| [x] | `*Italic*` | `em` | Native after materialization. | Direct ADF, Storage, and target fixtures are complete. |
| [x] | `~~Strike~~` | `strike` | Native after materialization. | Direct ADF, Storage, and target fixtures are complete. |
| [x] | Backtick-delimited text | `text` + `code` mark | Exact text plus a distinct inline-code chip in both targets, with a portable embedded DOCX code face. | Closed after Confluence materializes the mark: exact token/underscore text, surrounding adjacency, source-highlight precedence, code-plus-annotation metadata retention, browser/job parity, and real rendering are pinned. Native comment output remains isolated to the separate `annotation` row. |
| [x] | `# ` … `###### ` | `heading.level` | Levels, content, and local identity survive natively. | Closed; composed-export level rebasing remains explicit and retains source identity. |
| [x] | `1. ` | `orderedList` | Native, including non-1 starts and nested restarts. | ADF/Storage differential, DOCX numbering-part, PDF source/source-map, packed-browser parity, and rendered-golden gates are closed. |
| [x] | `* ` | `bulletList` | Native, including nested bullet ownership and visual levels. | ADF/Storage differential, DOCX/PDF structure, packed-browser parity, and rendered-golden gates are closed. |
| [x] | `> ` | `blockquote` | Native static projection. | Closed with deterministic target-owned styling. |
| [x] | Triple backticks + space | `codeBlock` | Native for the pinned ADF result. | Exact text/language, tri-state wrap intent, line-number policy, local/unique identity, long-line page safety, and empty/final lines are covered through validation, both engines, packed browser parity, and real render goldens. |
| [x] | `--- ` | `rule` | Native. | Semantic and visual golden are complete. |
| [x] | `[title](URL)` | link mark or Smart Link transform | Plain link marks and inline/block/embed Smart Card outcomes are complete, including safe external/page/attachment/media/card targets and unsafe-scheme degradation. | Closed after Confluence materializes the editor input: exact link-mark provenance and all pinned Smart Card attributes survive, with deterministic clickable static output in both targets and datasource live-resolution reuse where supported. |
| [x] | `[] ` | task item | Native for pinned ADF/Storage semantics. | TODO/DONE, direct-inline and block tasks, nesting, identity, composition, and both target markers are covered; mentions/dates survive as ordinary inline semantics. |
| [x] | `<> ` | decision item | Native for the pinned ADF schema. | List/item identity and exact state survive; `DECIDED` and nonstandard states have deterministic static markers. |
| [ ] | `:` / emoji picker | `emoji` node or text | Partial/conditional. | **Partial — external asset contract:** Unicode/fallback is complete; Atlassian/site-custom assets and complete glyph coverage remain blocked. |
| [x] | `:)` auto-conversion | Emoji/editor transformation | Correctly consumes the materialized emoji/text result and performs no exporter-side editor emulation. | Closed exporter policy; the live corpus records enabled/disabled editor outcomes without reinterpreting raw text. |
| [x] | Raw `:shortname:` text | Not a stable documented ADF contract | Remains literal unless Confluence converted it first. | Closed invariant: never reinterpret ordinary text in the exporter. |
| [x] | `@ ` | `mention` | Native typed mention with source or host-resolved visible name. | Closed for the pinned ADF contract: identity/presentation metadata survives, unresolved/deactivated output is privacy-safe, and no unsupported profile URL is invented. |
| [x] | `!` | media picker | Block image/file/link/external media, static audio/video attachment cards, groups, inline images, authored dimensions/layout, alt text, captions, borders, and links are complete. | Closed for every pinned materialized media outcome: correlated block and inline images render as real target images; file/link/unresolved outcomes remain visible, typed, clickable where safe, and diagnostic. |
| [ ] | `{` | macro autocomplete | `extension*` or legacy macro projection | **Open/conditional:** core, Forge `adfExport`, Connect/migrated, unknown, and offline behavior. |
| [x] | `//` | `date` | Native localized static date chip. | UTC calendar semantics, locale formatting, invalid-value reporting, and deterministic browser/render fixtures are complete. |
| [x] | `/...` | Selected node/macro | Determined by the resulting typed ADF node, never by reparsing slash text. | Closed classification policy; the selected result remains tracked in its own checked row. |

## 9. Two high-signal visual gaps

### 9.1 Inline code — complete static export contract

The shared parser distinguishes inline code from code blocks and both targets now reproduce the visible inline-code treatment:

- DOCX emits a JetBrains Mono run with deterministic `w:shd` background. An
  explicit neutral-model background still overrides the default rather than
  creating nested fills. When any inline or block code is present, the exporter
  license-validates the committed OFL face, verifies its pinned SHA-256 digest,
  applies the ECMA-376 obfuscation transform, and adds the font part, font table,
  content type, and relationship chain. Code-free documents do not acquire the
  extra parts.
- PDF applies a non-block `raw` rule with the resolved template's code background, bounded horizontal/vertical inset, radius, bundled mono font, and code size. Block raw retains its separate full-width rule.
- Focused semantic tests pin underscores, exact token text, surrounding prose,
  default fill, source-fill precedence, code-plus-annotation retention,
  idempotent package mutation, corrupt/restricted font rejection, and the
  absence of font parts from code-free documents.
- Source, bundled CLI, compiled CLI, package, browser, and background-job paths
  all use the same committed face. The browser archive comparison includes the
  font binary and relationship parts, not only visible text.
- The synthetic ADF feature-zoo references were regenerated through real
  DOCX/LibreOffice and Typst/PDF/Poppler rendering. The render gate additionally
  checks the DOCX-converted PDF with `pdffonts`; the non-system JetBrains Mono
  face must be present and embedded. All pages were visually inspected without
  clipping, overlap, missing glyphs, or broken wrapping.

Required acceptance contract:

- [x] Embed the bundled DOCX mono font instead of relying on the recipient's host-font substitution.
- [x] Use the bundled mono font in PDF.
- [x] Apply a subtle target-appropriate background.
- [x] Add predictable horizontal padding where the target format allows it.
- [x] Preserve underscores, token-like identifiers, whitespace, punctuation, and adjacent line wrapping.
- [x] Preserve the pinned code-plus-annotation combination without letting one
  mark erase the other; native comment rendering remains scoped to the separate
  unchecked `annotation` row.
- [x] Keep separate regression coverage for inline code and block code.

### 9.2 Emoji and emoticons

Current behavior is explicit and source-neutral:

- Raw Unicode survives as visible text and retains its emoji metadata if the selected font/rendering stack has the glyph.
- ADF and Storage both retain the required `shortName`, optional ADF emoji-service `id`, exact optional text (including `""`), and `renderedFrom` provenance in `EmojiSemantics`.
- Non-empty source text is preferred. Missing or empty text falls back to `shortName`; colon-shaped source text and short-name fallbacks emit the stable `emoji-text-fallback` warning with page/block provenance.
- If Storage supplies a colon short name such as `:warning:` as `ac:emoji-fallback` (a shape already present in the repository fixtures), DOCX/PDF keeps that literal string and diagnoses it; it does not pretend to have resolved a glyph. See [E22].
- The exporter does not convert raw colon notation, which is the correct default for stored text.
- Custom and non-standard Atlassian emoji have a deterministic, visible, typed text fallback but no documented portable asset resolver.
- Dedicated ADF and Storage regressions cover Unicode, custom/missing text, empty text, metadata retention, note provenance, literal colon text, target-neutral parity, and both serializer paths.
- The PDF runtime bundles a symbol fallback but no color-emoji font; the DOCX recipient may also substitute fonts, so complete Unicode emoji coverage is not guaranteed.
- Atlassian's current Forge ADF renderer documents the same platform boundary: only standard Unicode emoji are supported there, not custom user-provided emoji [13].

Required acceptance contract:

1. Prefer ADF `text` when it contains a standard Unicode sequence.
2. **Completed fallback floor:** without usable Unicode `text`, emit the exact short name with a typed warning.
3. For site custom emoji, add an authorized host resolver only when Atlassian documents a stable asset route; until then retain the current visible text/short-name fallback and typed warning.
4. Define DOCX image-baseline and PDF inline-image sizing for custom emoji.
5. Test skin tone, ZWJ sequences, variation selectors, flags, missing glyphs, deleted custom emoji, and literal colon text.

## 10. Prioritized gap backlog

### P0 - Make coverage measurable

- [x] **ADF-native source adapter.** `adfToBlocks()` and
  `pageBodyToBlocks()` validate `doc.version` against the pinned schema while
  keeping Storage as a separate compatibility adapter.
- [ ] **Open — extend the neutral model before serializers.** Supported
  semantics use typed representations and every unsupported path has visible,
  bounded diagnostics; native representations for the open matrix rows remain.
- [x] **Versioned coverage manifest.** All pinned nodes and marks are
  classified, and CI rejects unreviewed schema/coverage drift.
- [ ] **Open — real Confluence feature corpus.** Sanitized observed fixtures
  exist for selected slices; broad editor-feature ADF/Storage pairs and build
  provenance remain open.
- [x] **Never-silent diagnostics.** Unknown nodes, marks, attributes,
  extensions, media kinds, and contract failures are bounded and
  source-located in export reports.

### P1 - Close user-visible core gaps

- [x] **Inline code.** Exact code-mark text, adjacency, highlight precedence,
  annotation coexistence, target-specific chip treatment, portable DOCX font
  embedding, PDF font use, browser/job parity, and real rendering are complete.
  Native comment output remains independently tracked by `annotation`.
- [ ] **Partial — external asset contract for emoji/custom emoji.** Identity, exact text, deterministic
  fallback, reporting, and both TS engines are complete; authorized custom
  assets and complete font/glyph coverage remain.
- [x] **Alignment, indentation, and small text.** Paragraph/heading alignment
  and indentation plus schema-defined small paragraph text are complete.
- [x] **Tasks and decisions.** Pinned-schema list/item identities, exact states,
  inline/block content, nested tasks, static markers, composition, browser
  parity, and both rendered targets are complete.
- [x] **Ordered-list starts.** Authored starts and independent nested restarts
  are complete.
- [x] **Nested list parity.** Bullet, numbered, and task children remain attached
  to their owning item in direct ADF and `body.storage`; DOCX, PDF, composition,
  browser execution, and real render artifacts preserve the hierarchy.
- [x] **Closed for static DOCX/PDF — table attributes.** Pinned layout, pixel
  width, display mode, numbered column, row/cell identity, exact per-cell
  column vectors, and vertical alignment survive the shared model. Both targets
  render the portable visible semantics; responsive viewport scaling is
  retained metadata but is not applicable to a static artifact.
- [x] **Layout columns for static DOCX/PDF.** Pinned ADF widths, vertical
  alignment, identity, and content ownership plus documented Storage layout
  shapes survive composition, macro/mention/asset traversal, browser execution,
  and both renderers.
- [ ] **Open — breakout.** Layout-section intent survives and is explicitly
  page-bounded; non-layout placements and actual wide/full-width page geometry
  remain open.
- [x] **Captions and nested expands for static DOCX/PDF.** Native ADF caption
  association/local identity and numbering are complete. ADF and
  `body.storage` disclosures retain title, identity, recursive ownership, and
  nesting; both targets render the body visibly open with an explicit report
  fact because static files cannot preserve the editor toggle.
- [x] **Dates, statuses, and placeholders.** ADF and `body.storage` share typed
  date/status/placeholder shapes; timestamps, identities, colors, and styles
  survive composition and browser/background execution. DOCX/PDF localize
  dates with a deterministic UTC policy, render status palettes/casing, and
  intentionally hide editor-only placeholder text.
- [x] **Core block identities.** Paragraph, heading, and ordinary list-item
  local IDs survive direct ADF, available Storage equivalents, composition,
  both renderer inputs, and packed direct/background source parity.
- [x] **Code blocks.** The full pinned ADF attribute/content contract reaches
  both static targets. Line numbers and long-line wrapping are visually proven;
  a no-wrap request uses an explicit non-clipping page-bound policy rather than
  a silent approximation.
- [x] **Cards and embeds.** Every pinned inline/block/embed attribute, opaque
  data/datasource payload, safe target, local identity, layout, and authored
  geometry survives. Both targets render deterministic static cards; supported
  datasource providers additionally reuse the existing live macro chain.
- [x] **Media family.** Pinned block media, attachment/file cards, external
  images, grouping, `mediaSingle` geometry/wrapping, captions, links, borders,
  and `mediaInline` are complete. Correlated inline images render at their
  paragraph position in both targets; unresolved/file/link variants retain the
  deterministic inline-chip floor.
- [x] **Page/attachment/media hyperlinks.** Exact safe href fallbacks,
  in-scope internal anchors, pinned ADF provenance, DOCX ScreenTips, and both
  targets' clickable text/image/fallback/card output are complete.

### P2 - Dynamic and advanced content

- [ ] **Open — ADF extensions.** Direct extension identities, parameters,
  visible fallbacks, and export controls are decoded; Forge `adfExport`
  ingestion before HTML fallback remains.
- [ ] **Open — sync-block snapshot/reference policy.**
- [ ] **Open — annotation and fragment marks.** Exact source identities,
  validation, composition, and browser parity are complete; comment-resource
  correlation, native target output, and fragment/bookmark policy remain.
- [ ] **Open — data-consumer and product metadata policy.**
- [x] **Schema-drift lane.** The pinned offline contract and non-blocking weekly
  upstream plus observed-product watchguard are complete.

## 11. Suggested implementation sequence

### Phase 0 - Contract and corpus

- [x] Pin schema and add schema-diff CI.
- [x] Add bounded `AdfDocument` validation and visible unknown-node/mark
  preservation with diagnostics.
- [ ] Expand paired ADF/Storage fixtures to the full observed Confluence editor
  corpus.
- [x] Generate and gate the coverage manifest from the pinned schema.

### Phase 1 - High-value inline fidelity

- [x] Inline code, including portable DOCX font embedding and retained
  code-plus-annotation combinations; native comment output remains a separate
  annotation gap.
- [ ] **Partial — external asset contract:** emoji/custom emoji assets and
  complete glyph coverage remain.
- [x] Alignment, indentation, and the schema-defined small paragraph font size.
- [x] Date/status/placeholder semantics and target projections.
- [x] Link/card identity and complete pinned Smart Card projection.
- [ ] **Open:** annotation/fragment identity is retained; native target
  semantics and comment-resource correlation remain.

### Phase 2 - Structural fidelity

- [x] Tasks and decisions.
- [x] Ordered-list authored starts and nested restarts.
- [x] Nested bullet/numbered/task parity across ADF and Storage.
- [x] Paragraph, heading, and ordinary list-item local identity preservation.
- [x] Complete pinned ADF code-block content/attribute preservation and
  page-bounded DOCX/PDF rendering.
- [x] Table attributes for static DOCX/PDF; page-bound wide-table layout remains
  a measured renderer policy rather than an ADF decoding gap.
- [x] Layout columns for pinned ADF and documented Storage shapes.
- [ ] Breakout beyond page-bounded layout-section intent.
- [x] Captions and nested expands for the pinned static-export contract.

### Phase 3 - Media and extensions

- [x] Full media family: pinned block media/group/single/inline, native
  correlated images, and static image/file/audio/video/link/external fallbacks.
- [ ] **Open:** ADF-native extension forms are decoded; Forge `adfExport`
  ingestion remains.
- [ ] Synced content policy.

### Phase 4 - Conformance and release gate

- [x] Cross-engine semantic parity fixtures and packed conformance registry.
- [x] DOCX OOXML assertions and rendered Word/LibreOffice goldens for completed
  feature slices.
- [x] Typst source assertions and rasterized PDF visual goldens for completed
  feature slices.
- [x] Browser-host and CLI-host parity for the shared TS engine shapes.
- [ ] **Open:** a persistent runtime-only feature tree now proves repeatable
  CLI DOCX/PDF subtree exports and real correlated `mediaInline` output without
  repository identifiers. Expand it to the remaining full feature-zoo corpus.

## 12. Definition of done per feature

A matrix row can be marked complete only when all applicable checks pass:

- [ ] Valid pinned-schema ADF fixture.
- [ ] Observed Confluence Cloud fixture or an explicit “schema-only” label.
- [ ] Direct ADF parse path.
- [ ] Storage compatibility fixture where Confluence exposes an equivalent projection.
- [ ] Typed neutral-model representation.
- [ ] DOCX semantic test and OOXML assertion.
- [ ] PDF semantic test and Typst assertion.
- [ ] Rendered DOCX/PDF visual golden where presentation matters.
- [ ] Browser and Node/Bun host coverage.
- [ ] Deterministic fallback and typed report note for unresolved dependencies.
- [ ] Resource-budget, cancellation, unsafe-link, and malformed-input coverage where applicable.
- [ ] Documentation and coverage-manifest update.

“The text is still visible” is insufficient for nodes whose identity, state, link target, asset, or layout is semantically relevant.

## 13. Test inventory and missing gates

Current tests cover the bounded ADF validator, one direct fixture for every
pinned node/mark, paired ADF/Storage projections, shared-model composition,
both serializers, real DOCX/PDF rendering, and packed browser conformance.
Observed Confluence breadth and the open matrix rows—not absence of an ADF
entry point—are now the limiting factors.

Closed gates:

- [x] Schema-derived enumeration classifies all 43 nodes and 17 marks.
- [x] Direct ADF-to-model fixtures cover every classified node and mark.
- [x] Emoji/emoticon decoding, both-engine semantics, packed browser parity,
  report parity, and deterministic render goldens.
- [x] Ordered-list non-1 starts and nested restarts.
- [x] Nested bullet/numbered/task ownership across paired ADF/Storage,
  composition, both serializers, packed browser execution, and real renders.
- [x] Task/decision identity, exact state, inline/block content, nested tasks,
  composition, both target markers, real render goldens, and packed browser
  parity.
- [x] Generic inline-extension placement and visible fallback.
- [x] Annotation/fragment attribute validation and identity preservation through
  decoding, composition, coverage classification, and packed-browser
  direct/background parity, plus explicit reporting when a consumed block
  export-control wrapper cannot retain its fragment.
- [x] Pinned ADF and documented Storage layout-column geometry, identity,
  vertical alignment, nested traversal, both target renderers, packed-browser
  parity, and real render goldens.
- [x] Pinned ADF code-block validation, exact decoding, composition,
  DOCX/PDF line-number and page-bound wrap projection, browser parity, and real
  long-line/final-newline render goldens.
- [x] Pinned standard/custom panel validation, complete custom attribute
  preservation, portable color/icon projection in both targets, packed-browser
  parity, typed non-portable fallbacks, and real render goldens.
- [x] Pinned mention validation, exact ADF metadata preservation, resolver and
  composition traversal, privacy-safe unresolved output, both target
  serializers, packed-browser parity, and real render goldens.

Focused missing gates:

- [x] Date localization and deterministic time-zone policy.
- [x] Generic inline/block/embed card metadata tests.
- [x] Layout width/column tests for pinned ADF and documented Storage shapes.
- [ ] Breakout rendering beyond the page-bounded layout-section approximation.
- [x] Media completeness tests: block/group/inline/file/link/external/border/
  layout coverage, bounded asset handling, target-native image output,
  browser/background parity, and persistent live CLI proof are complete.
- [x] Native ADF caption plus ADF/Storage expand/nested-expand validation,
  decoding, recursive traversal, both-target, browser-parity, and rendered
  golden tests.
- [x] Date/status/placeholder validation, ADF/Storage differential decoding,
  composition, both target renderers, packed-browser direct/background parity,
  and real render goldens with explicit placeholder-absence assertions.
- [ ] Sync-block snapshot/reference tests.
- [ ] Native annotation comment-body/target-rendering tests, documented
  fragment-to-bookmark policy tests, and data-consumer preservation tests.
- [ ] Broad paired live Confluence ADF-versus-Storage projection fixtures.

At the initial documentation-only analysis baseline, workspace dependencies were not installed and existing tests were inspected rather than freshly executed. Subsequent implementation evidence and current gates are recorded in `PLAN.md`.

## 14. Official sources

Accessed 2026-07-22 and 2026-07-23:

1. [Atlassian Document Format structure](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
2. [Canonical ADF JSON schema](https://go.atlassian.com/adf-json-schema) -> pinned for this analysis to [`@atlaskit/adf-schema@56.1.13`](https://unpkg.com/@atlaskit/adf-schema@56.1.13/dist/json-schema/v1/full.json)
3. [Confluence Cloud REST v2 Page API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/)
4. [Confluence: Format text](https://support.atlassian.com/confluence-cloud/docs/format-text/)
5. [Confluence: Add elements to a page or live doc](https://support.atlassian.com/confluence-cloud/docs/insert-elements-into-a-page/)
6. [Confluence: Keyboard shortcuts, Markdown, and autocomplete](https://support.atlassian.com/confluence-cloud/docs/keyboard-shortcuts-markdown-and-autocomplete/)
7. [Confluence: Symbols, emojis, and special characters](https://support.atlassian.com/confluence-cloud/docs/use-symbols-emojis-and-special-characters/)
8. [Confluence: Simplify data with tables](https://support.atlassian.com/confluence-cloud/docs/simplify-data-with-tables/)
9. [Confluence: Create and manage layouts](https://support.atlassian.com/confluence-cloud/docs/create-and-manage-layouts/)
10. [Confluence: Add action items and mentions](https://support.atlassian.com/confluence-cloud/docs/add-action-items-and-mentions/)
11. [Atlassian: Smart Link view options](https://support.atlassian.com/platform-experiences/docs/smart-link-view-options/)
12. [Forge macro manifest and `adfExport`](https://developer.atlassian.com/platform/forge/manifest-reference/modules/macro/)
13. [Forge ADF renderer](https://developer.atlassian.com/platform/forge/ui-kit/components/adf-renderer/)
14. [Confluence export Word/PDF/HTML/XML](https://support.atlassian.com/confluence-cloud/docs/export-content-to-word-pdf-html-and-xml/)
15. [Atlassian Design System typography scale](https://atlassian.design/foundations/typography/)
16. [ADF panel node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/panel/)
17. [ADF table node and attribute semantics](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/table/)
18. [Typst table and cell alignment](https://typst.app/docs/reference/model/table/)
19. [Typst alignment model](https://typst.app/docs/reference/layout/alignment/)
20. [Confluence Data Center storage format: page layouts](https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html)
21. [Typst grid](https://typst.app/docs/reference/layout/grid/)
22. [Microsoft: Working with WordprocessingML tables](https://learn.microsoft.com/en-us/office/open-xml/word/working-with-wordprocessingml-tables)
23. [ADF expand node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/expand/)
24. [ADF nestedExpand node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/nestedExpand/)
25. [Confluence: Display files and images](https://support.atlassian.com/confluence-cloud/docs/display-files-and-images/)
26. [ADF date node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/date/)
27. [ADF status node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/status/)
28. [Confluence: Edit a template](https://support.atlassian.com/confluence-cloud/docs/edit-a-template/)
29. [ADF codeBlock node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/codeBlock/)
30. [Confluence Code Block macro](https://confluence.atlassian.com/display/DOCM/Code%2BBlock%2BMacro)
31. [Typst raw text/code and `raw.line`](https://typst.app/docs/reference/text/raw/)
32. [ADF mention node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/mention/)
33. [ECMA-376 WordprocessingML embedded fonts](https://c-rex.net/samples/ooxml/e1/Part4/OOXML_P4_DOCX_Font_topic_ID0ERNCU.html)
34. [Microsoft Open Specifications: embedded font part](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/1663dabc-5d98-463f-889e-bcd9b77c3d34)
35. [Confluence REST v2 Attachment API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-attachment/)
36. [ADF media node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/media/)
37. [ADF mediaSingle node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/mediaSingle/)
38. [ADF mediaGroup node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/mediaGroup/)
39. [ADF mediaInline node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/mediaInline/)
40. [ADF border mark](https://developer.atlassian.com/cloud/jira/platform/apis/document/marks/border/)
41. [Typst `place` layout contract](https://typst.app/docs/reference/layout/place/)
42. [ADF document structure and inline-node ordering](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)
43. [Typst inline `box` layout and baseline contract](https://typst.app/docs/reference/layout/box/)
44. [Atlassian editor data-consumer plugin](https://www.npmjs.com/package/%40atlaskit/editor-plugin-data-consumer)

## 15. Repository evidence index

- **[E1] Storage-first page reads:** `packages/confluence/src/client.ts:722-744`, `packages/confluence/src/client.ts:818-835`
- **[E2] Shared model and Storage walker:** `packages/confluence/src/export-blocks.ts:36-235`, `packages/confluence/src/export-blocks.ts:947-998`, `packages/confluence/src/export-blocks.ts:1038-1206`
- **[E3] `export_view` fetch path:** `packages/confluence/src/client.ts:747-810`
- **[E4] Limited export-view HTML converter:** `packages/confluence/src/html-to-blocks.ts:1-29`, `packages/confluence/src/html-to-blocks.ts:170-298`
- **[E5] Inline Storage mapping:** `packages/confluence/src/export-blocks.ts:2109-2215`
- **[E6] DOCX Cloud entry:** `packages/docx/src/export.ts:384-395`
- **[E7] DOCX block/inline serialization:** `packages/docx/src/serialize.ts:228-280`, `packages/docx/src/serialize.ts:452-676`
- **[E8] PDF block/inline serialization:** `packages/pdf/src/serialize.ts:509-641`, `packages/pdf/src/serialize.ts:882-1177`
- **[E9] Lists/tasks:** `packages/confluence/src/export-blocks.ts:1378-1398`, `packages/docx/src/serialize.ts:796-874`, `packages/pdf/src/serialize.ts:973-998`
- **[E10] Table source model:** `packages/confluence/src/export-blocks.ts:1422-1538`
- **[E11] DOCX tables:** `packages/docx/src/serialize.ts:916-1071`, `packages/docx/src/ooxml.ts:547-614`
- **[E12] PDF tables:** `packages/pdf/src/serialize.ts:1000-1105`
- **[E13] Callouts/expand/Scroll captions:** `packages/confluence/src/export-blocks.ts:1581-1612`, `packages/confluence/src/export-blocks.ts:1979-2015`
- **[E14] Mention resolution:** `packages/confluence/src/resolve-mentions.ts:1-132`
- **[E15] Composition link rewrite:** `packages/confluence/src/compose-document.ts:493-565`
- **[E16] Datasource cards:** `packages/confluence/src/export-blocks.ts:1716-1814`, `packages/confluence/src/datasource.ts:325-345`, `packages/confluence/src/datasource.ts:642-683`
- **[E17] Image preparation/rendering:** `packages/confluence/src/export-blocks.ts:1549-1577`, `packages/docx/src/image.ts:41-71`, `packages/pdf/src/prepare.ts:236-307`, `packages/pdf/src/serialize.ts:939-963`
- **[E18] Unknown macro capture/fallback:** `packages/confluence/src/export-blocks.ts:1659-1709`, `packages/docx/src/serialize.ts:593-629`, `packages/pdf/src/serialize.ts:1110-1135`
- **[E19] Live macro registry:** `packages/export-macros/src/registry.ts:122-152`, `packages/export-macros/src/resolve.ts:138-261`
- **[E20] DOCX run properties:** `packages/docx/src/ooxml.ts:153-179`
- **[E21] PDF inline code vs block-code style:** `packages/pdf/src/serialize.ts:509-545`, `packages/pdf/src/template.ts:311-317`
- **[E22] Colon-shaped Storage emoji fallback fixture:** `packages/confluence/src/markdown.test.ts:214-225`
- **[E23] Shared emoji semantics, fallbacks, and parity:** `packages/confluence/src/export-blocks.ts:65-96`, `packages/confluence/src/export-blocks.ts:213-219`, `packages/confluence/src/export-blocks.ts:2266-2295`, `packages/confluence/src/adf-to-blocks.ts:394-418`, `packages/confluence/src/adf-to-blocks.test.ts:277-340`, `packages/confluence/src/export-blocks.test.ts:63-115`, `packages/export-fixtures/src/adf-fixtures.test.ts:49-65`, `apps/browser-export-harness/src/adf-source-case.ts:341-353`
- **[E24] Native task/decision semantics and target proof:** `packages/confluence/src/export-blocks.ts:117-130`, `packages/confluence/src/export-blocks.ts:270-281`, `packages/confluence/src/export-blocks.ts:1480-1507`, `packages/confluence/src/adf-validate.ts:142-159`, `packages/confluence/src/adf-to-blocks.ts:296-311`, `packages/confluence/src/adf-to-blocks.ts:819-872`, `packages/confluence/src/compose-document.ts:628-638`, `packages/docx/src/serialize.ts:872-934`, `packages/pdf/src/serialize.ts:772-797`, `packages/pdf/src/serialize.ts:1039-1074`, `packages/export-fixtures/src/adf-fixtures.test.ts:38-68`, `apps/browser-export-harness/src/adf-source-case.ts:327-332`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E25] Nested list parity across both source representations and targets:** `packages/confluence/src/export-blocks.ts:1460-1510`, `packages/confluence/src/adf-to-blocks.ts:270-311`, `packages/confluence/src/adf-to-blocks.ts:819-850`, `packages/confluence/src/page-body.test.ts:18-83`, `packages/confluence/src/compose-document.test.ts:254-350`, `packages/confluence/test-fixtures/adf-pairs/basic.adf.json`, `packages/confluence/test-fixtures/adf-pairs/basic.storage.xml`, `packages/docx/src/numbering.test.ts:190-230`, `packages/pdf/src/serialize.test.ts:129-230`, `packages/pdf/src/serialize.ts:860-870`, `packages/pdf/src/serialize.ts:1037-1074`, `packages/export-fixtures/src/index.ts:177-231`, `apps/browser-export-harness/src/adf-source-case.ts:320-343`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E26] Annotation/fragment identity preservation:** `packages/confluence/src/export-blocks.ts:235-248`, `packages/confluence/src/adf-validate.ts:225-247`, `packages/confluence/src/adf-to-blocks.ts:396-535`, `packages/confluence/src/adf-to-blocks.ts:965-999`, `packages/confluence/src/adf-validate.test.ts:139-172`, `packages/confluence/src/adf-to-blocks.test.ts:486-638`, `packages/confluence/src/adf-direct-fixtures.test.ts:143-218`, `packages/confluence/src/compose-document.test.ts:537-580`, `packages/export-fixtures/src/index.ts:128-263`, `packages/export-fixtures/src/adf-fixtures.test.ts:80-114`, `apps/browser-export-harness/src/adf-source-case.ts:315-377`, `apps/browser-export-harness/tests/exports.e2e.ts:90-95`
- **[E27] Complete pinned table-attribute preservation and static rendering:** `packages/confluence/src/export-blocks.ts`, `packages/confluence/src/adf-validate.ts`, `packages/confluence/src/adf-to-blocks.ts`, `packages/confluence/src/compose-document.ts`, `packages/docx/src/ooxml.ts`, `packages/docx/src/serialize.ts`, `packages/pdf/src/prepare.ts`, `packages/pdf/src/serialize.ts`, `packages/export-fixtures/src/index.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E28] Native layout columns and explicit breakout residual:** `packages/confluence/src/export-blocks.ts`, `packages/confluence/src/adf-validate.ts`, `packages/confluence/src/adf-to-blocks.ts`, `packages/confluence/src/compose-document.ts`, `packages/confluence/src/resolve-mentions.ts`, `packages/export-macros/src/resolve.ts`, `packages/docx/src/ooxml.ts`, `packages/docx/src/serialize.ts`, `packages/pdf/src/prepare.ts`, `packages/pdf/src/serialize.ts`, `packages/export-fixtures/src/index.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E29] Native captions and recursive static disclosures across ADF/Storage and both targets:** `packages/confluence/src/export-blocks.ts`, `packages/confluence/src/adf-validate.ts`, `packages/confluence/src/adf-to-blocks.ts`, `packages/confluence/src/page-body.test.ts`, `packages/confluence/src/compose-document.ts`, `packages/confluence/src/resolve-mentions.ts`, `packages/export-macros/src/resolve.ts`, `packages/docx/src/serialize.ts`, `packages/pdf/src/prepare.ts`, `packages/pdf/src/serialize.ts`, `packages/export-fixtures/src/index.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E30] Native date/status/placeholder semantics across ADF/Storage and both targets:** `packages/confluence/src/export-blocks.ts`, `packages/confluence/src/adf-validate.ts`, `packages/confluence/src/adf-to-blocks.ts`, `packages/confluence/src/page-body.test.ts`, `packages/confluence/src/compose-document.ts`, `packages/confluence/test-fixtures/adf-pairs/basic.adf.json`, `packages/confluence/test-fixtures/adf-pairs/basic.storage.xml`, `packages/docx/src/serialize.ts`, `packages/pdf/src/serialize.ts`, `packages/export-fixtures/src/index.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `apps/browser-export-harness/tests/exports.e2e.ts`, `scripts/adf-rendered-goldens.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E31] Paragraph/heading/ordinary-list-item local identity preservation:** `packages/confluence/src/export-blocks.ts`, `packages/confluence/src/adf-validate.ts`, `packages/confluence/src/adf-to-blocks.ts`, `packages/confluence/src/page-body.test.ts`, `packages/confluence/src/compose-document.ts`, `packages/confluence/test-fixtures/adf-pairs/basic.adf.json`, `packages/confluence/test-fixtures/adf-pairs/basic.storage.xml`, `packages/export-fixtures/src/index.ts`, `packages/export-fixtures/src/adf-fixtures.test.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `apps/browser-export-harness/tests/exports.e2e.ts`
- **[E32] Complete pinned ADF code-block semantics and static projection:** `packages/confluence/src/export-blocks.ts`, `packages/confluence/src/adf-validate.ts`, `packages/confluence/src/adf-to-blocks.ts`, `packages/confluence/src/compose-document.test.ts`, `packages/confluence/src/export-blocks.test.ts`, `packages/docx/src/highlight.ts`, `packages/docx/src/highlight.test.ts`, `packages/docx/src/ooxml.ts`, `packages/docx/src/serialize.ts`, `packages/pdf/src/prepare.ts`, `packages/pdf/src/serialize.ts`, `packages/pdf-compiler-browser/src/compiler.test.ts`, `packages/pdf-compiler-browser/src/template-migration-parity.test.ts`, `packages/export-fixtures/src/index.ts`, `packages/export-fixtures/src/adf-fixtures.test.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `apps/browser-export-harness/tests/exports.e2e.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E33] Complete pinned custom-panel semantics and static projection:** `packages/confluence/src/export-blocks.ts`, `packages/confluence/src/adf-validate.ts`, `packages/confluence/src/adf-to-blocks.ts`, `packages/confluence/src/compose-document.ts`, `packages/docx/src/ooxml.ts`, `packages/docx/src/serialize.ts`, `packages/pdf/src/types.ts`, `packages/pdf/src/template.ts`, `packages/pdf/src/serialize.ts`, `packages/export-fixtures/src/index.ts`, `packages/export-fixtures/src/adf-fixtures.test.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `apps/browser-export-harness/tests/exports.e2e.ts`, `scripts/adf-rendered-goldens.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E34] Complete pinned mention semantics and privacy-safe static projection:** `packages/confluence/src/export-blocks.ts`, `packages/confluence/src/adf-validate.ts`, `packages/confluence/src/adf-to-blocks.ts`, `packages/confluence/src/resolve-mentions.ts`, `packages/confluence/src/compose-document.ts`, `packages/docx/src/serialize.ts`, `packages/pdf/src/serialize.ts`, `packages/export-fixtures/src/index.ts`, `packages/export-fixtures/src/adf-fixtures.test.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `apps/browser-export-harness/tests/exports.e2e.ts`, `scripts/adf-rendered-goldens.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E35] Executable progress-register consistency guard:** `scripts/adf-gap-register.test.ts`
- **[E36] Portable inline/code-block font embedding across DOCX hosts:** `packages/docx/src/font-embedding.ts`, `packages/docx/src/font-embedding.test.ts`, `packages/docx/src/node-code-font.ts`, `packages/docx/src/export.ts`, `packages/docx/src/export.test.ts`, `packages/docx/src/golden.test.ts`, `apps/cli/src/commands/export-code-font.ts`, `apps/cli/src/commands/export-code-font-build-modes.test.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `apps/browser-export-harness/tests/exports.e2e.ts`, `scripts/adf-rendered-goldens.ts`, `scripts/adf-rendered-goldens.test.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E37] Complete pinned ADF link-mark semantics:** `packages/confluence/src/export-blocks.ts`, `packages/confluence/src/adf-to-blocks.ts`, `packages/confluence/src/adf-to-blocks.test.ts`, `packages/confluence/src/compose-document.ts`, `packages/confluence/src/compose-document.test.ts`, `packages/docx/src/ooxml.ts`, `packages/docx/src/serialize.ts`, `packages/docx/src/serialize.test.ts`, `packages/pdf/src/prepare.ts`, `packages/pdf/src/serialize.ts`, `packages/pdf/src/serialize.test.ts`, `packages/export-fixtures/src/index.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E38] Complete pinned Smart Card semantics and static/live projection:** `packages/confluence/src/export-blocks.ts`, `packages/confluence/src/adf-validate.ts`, `packages/confluence/src/adf-to-blocks.ts`, `packages/confluence/src/adf-validate.test.ts`, `packages/confluence/src/adf-to-blocks.test.ts`, `packages/confluence/src/compose-document.ts`, `packages/confluence/src/compose-document.test.ts`, `packages/confluence/src/datasource.ts`, `packages/docx/src/serialize.ts`, `packages/docx/src/serialize.test.ts`, `packages/pdf/src/prepare.ts`, `packages/pdf/src/serialize.ts`, `packages/pdf/src/serialize.test.ts`, `packages/export-fixtures/src/index.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E39] Complete pinned block-media/group/single/border semantics and typed inline-media boundary:** `packages/confluence/src/export-blocks.ts`, `packages/confluence/src/adf-validate.ts`, `packages/confluence/src/adf-to-blocks.ts`, `packages/confluence/src/client.ts`, `packages/confluence/src/adf-validate.test.ts`, `packages/confluence/src/adf-to-blocks.test.ts`, `packages/confluence/src/client-adf.test.ts`, `packages/confluence/src/compose-document.ts`, `packages/docx/src/image.ts`, `packages/docx/src/export.ts`, `packages/docx/src/serialize.ts`, `packages/docx/src/image.test.ts`, `packages/docx/src/export.test.ts`, `packages/docx/src/serialize.test.ts`, `packages/pdf/src/prepare.ts`, `packages/pdf/src/serialize.ts`, `packages/pdf/src/serialize.test.ts`, `packages/export-fixtures/src/index.ts`, `packages/export-fixtures/src/adf-fixtures.test.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E40] Native correlated `mediaInline` output and host parity:** `packages/docx/src/image.ts`, `packages/docx/src/serialize.ts`, `packages/docx/src/export.ts`, `packages/docx/src/image.test.ts`, `packages/docx/src/serialize.test.ts`, `packages/docx/src/export.test.ts`, `packages/pdf/src/types.ts`, `packages/pdf/src/prepare.ts`, `packages/pdf/src/serialize.ts`, `packages/pdf/src/prepare.test.ts`, `packages/pdf/src/serialize.test.ts`, `packages/export-fixtures/src/index.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `apps/browser-export-harness/src/pdf-job-parity-case.ts`, `apps/browser-export-harness/tests/exports.e2e.ts`, `scripts/adf-rendered-goldens.ts`, `scripts/adf-rendered-goldens.test.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E41] Complete pinned `dataConsumer` provenance without identifier publication:** `packages/confluence/src/adf-validate.ts`, `packages/confluence/src/adf-to-blocks.ts`, `packages/confluence/src/export-blocks.ts`, `packages/confluence/src/adf-coverage.ts`, `packages/confluence/src/adf-validate.test.ts`, `packages/confluence/src/adf-to-blocks.test.ts`, `packages/confluence/src/adf-direct-fixtures.test.ts`, `packages/confluence/src/compose-document.ts`, `packages/docx/src/serialize.test.ts`, `packages/pdf/src/serialize.test.ts`, `packages/export-fixtures/src/index.ts`, `packages/export-fixtures/src/adf-fixtures.test.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `apps/browser-export-harness/tests/exports.e2e.ts`, `scripts/adf-rendered-goldens.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`
- **[E42] Complete pinned synced-content identity and safe static projection:** `packages/confluence/src/adf-validate.ts`, `packages/confluence/src/adf-to-blocks.ts`, `packages/confluence/src/export-blocks.ts`, `packages/confluence/src/adf-coverage.ts`, `packages/confluence/src/adf-validate.test.ts`, `packages/confluence/src/adf-to-blocks.test.ts`, `packages/confluence/src/adf-direct-fixtures.test.ts`, `packages/confluence/src/compose-document.test.ts`, `packages/docx/src/serialize.test.ts`, `packages/pdf/src/serialize.test.ts`, `packages/export-fixtures/src/index.ts`, `packages/export-fixtures/src/adf-fixtures.test.ts`, `apps/browser-export-harness/src/adf-source-case.ts`, `apps/browser-export-harness/tests/exports.e2e.ts`, `scripts/adf-rendered-goldens.ts`, `scripts/adf-rendered-goldens.test.ts`, `packages/export-fixtures/test-fixtures/adf-rendered-golden/manifest.json`

## 16. Review questions

1. **Resolved for this migration:** target 100% of the verified Confluence
   Cloud authoring corpus while retaining explicit, never-silent handling for
   every pinned schema member. Schema-only support remains labeled as such.
2. **Resolved for this migration:** direct ADF is the primary Cloud input;
   Storage remains the Data Center/compatibility adapter and a temporary,
   differentially tested sidecar for unresolved definitions.
3. **Resolved for this migration:** short-name/text fallback with a typed warning is the portable floor; authorized asset retrieval waits for a documented Atlassian contract.
4. **Resolved for the pinned Smart Card schema:** retain all opaque
   provider-owned JSON, but render only documented stable title/URL/card
   semantics. Thumbnails/provider execution are not invented when the pinned
   node exposes no such contract; future observed attributes enter the weekly
   drift lane.
5. **Open:** annotation/fragment identities are
   preserved as metadata on retained source positions while underlying content
   remains visible; a consumed block export-control wrapper is explicitly
   reported rather than silently reassigned to an arbitrary child.
   Native Word comments/PDF notes still require a decision plus separately
   fetched comment bodies; fragment-to-bookmark rendering still requires a
   documented semantic and collision policy.
6. **Resolved for tasks and decisions:** target-appropriate open/done task
   markers and a distinct decision marker are the static floor; exact
   identities/states remain in the neutral model and nonstandard decision
   states are visibly labeled. Nested expands are resolved for the pinned
   static-export contract; synced blocks, audio, and video remain open.
7. Is visual parity measured against a curated atlcli design system, Confluence's standard export appearance, or configurable target templates? Semantic parity can be target-independent; pixel parity cannot.
