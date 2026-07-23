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
| **Partial** | Meaningful content remains, but one or more documented attributes, layout semantics, interactions, or visual properties are lost or approximated. |
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
- `[ ]` plus **Partial** means a proven subset is complete and the remaining
  sub-gap is stated explicitly.
- `[ ]` plus **Open** means no complete native contract exists yet.

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
- [x] Emoji identity, exact source text, deterministic short-name fallback, and
  typed fallback reporting.
- [x] Inline-code background treatment and exact token preservation in both
  targets.
- [x] Pinned-schema task lists, inline and block task items, nested tasks,
  decision lists/items, local identities, and exact states.
- [x] Pinned ADF layout sections/columns and documented Storage layout sections
  retain column ownership, proportions, vertical alignment, and available local
  identity through both static TypeScript targets.
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
- [ ] **Partial:** `breakout` intent is retained on ADF layout sections and
  explicitly reported as page-bounded; breakout on other schema-valid block
  types and true wide/full-width section geometry remain open.
- [ ] **Partial:** annotation and fragment identities are validated and retained
  through the neutral model, composition, and packed-browser source resolution;
  native comments/PDF notes, separately fetched comment bodies, and a documented
  fragment-to-bookmark policy remain open. Applying a block export-control
  removes its marked wrapper by design and now emits an explicit residual note.

Current cross-cutting residuals:

- [ ] **Partial:** durable background-host source integration is deferred until
  synchronization with the parallel job-host work.
- [ ] **Partial:** the real sanitized Confluence corpus covers selected live
  slices, not yet every supported editor feature.
- [ ] **Partial:** guaranteed DOCX monospace embedding, complete emoji glyph
  coverage, custom panels, and custom-emoji assets remain open.

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

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `doc` | Cloud ADF version 1 is bounded and validated before decoding; Storage remains a separate compatibility adapter. | N/A | N/A | Native source contract is complete; observed-product corpus breadth remains tracked separately. |
| `paragraph` | `<p>` or loose inline content becomes a typed paragraph; direct ADF additionally retains logical alignment, indentation, and the schema-defined `small` font size. | Native | Native | Local ID and other ADF attributes remain outside the model. |
| `heading` | `<h1>`…`<h6>` retains level and inline content; direct ADF additionally retains logical alignment and indentation. | Native | Native | Composed exports may rebase levels; local ID remains outside the model. |
| `text` | Unicode text is retained and XML/Typst escaped. | Native | Native | Rendering still depends on target font glyph coverage. |
| `hardBreak` | ADF `hardBreak` and Storage `<br>` become `lineBreak`. | Native | Native | Closed with direct ADF and Storage coverage. |
| `rule` | ADF `rule` and Storage `<hr>` become `divider`. | Native | Native | Closed with direct ADF and Storage coverage. |
| `blockquote` | Structured body becomes `blockquote`. | Native/approx. | Native/approx. | Static styling is exporter-owned rather than an ADF fidelity issue. |
| `codeBlock` | `<pre>` and `code`/`noformat` macros retain code; macro form may retain language. | Partial | Partial | ADF `wrap`, `hideLineNumbers`, and `uniqueId` are not modeled. Language is supported; code-block wrapping/line-number semantics are not. |

Evidence: [E2], [E5], [E6], [E7], [E8].

### 6.2 Lists, tasks, and decisions

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `bulletList` | ADF `bulletList` and Storage `<ul>` become `list { ordered: false }`; child lists remain inside the owning item. | Native | Native | Nested ADF/Storage differential fixtures, target structure tests, packed-browser assertions, and real render goldens are complete. Maximum nesting and resource budgets remain exporter constraints. |
| `orderedList` | Storage `<ol start>` and ADF `orderedList.order` become `list { ordered: true, start? }`; child lists remain inside the owning item. | Native | Native | Authored starts, including zero, survive the neutral model. DOCX emits a self-contained single-level numbering definition per ordered-list node; PDF emits Typst `enum(start:)`. Each nested node owns an independent restart, visual indent, and correctly indexed PDF source-map path. |
| `listItem` | Child blocks are recursively preserved. | Native | Native | Local IDs are not retained. |
| `taskList` | ADF and Storage become a typed task list with list identity where exposed. ADF sibling task lists attach to the preceding owning item; Storage task lists inside `<ac:task-body>` remain child blocks of that task. | Native | Native | Paired ADF/Storage nesting, both target markers/indents, browser parity, and real render goldens are complete; any future observed product-specific attributes enter the drift lane. |
| `taskItem` | Required `localId`, exact `TODO`/`DONE` state, direct inline content, and checkbox projection are retained. | Native | Native | Closed with distinct open/done markers, composition, browser parity, and real render goldens. |
| `blockTaskItem` | Required identity/state and one-or-more block children remain a distinct typed task item. | Native | Native | Closed with block-content and nested-list coverage. |
| `decisionList` | Required list identity and decision grouping are retained directly from ADF. | Native | Native | Schema-only source contract; no equivalent Storage projection is claimed. |
| `decisionItem` | Required local identity, exact product-defined string state, and direct inline content are retained. | Native | Native | `DECIDED` uses a filled decision marker; nonstandard states remain visibly labeled rather than being collapsed. |

Evidence: [E2], [E5], [E7], [E8], [E9].

### 6.3 Tables

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `table` | Rows, widths, exact pinned presentation attributes, editor identity, and fragment identity become a typed table. An enabled numbered column is materialized once through a shared renderer helper. | Partial | Partial | Authored positive pixel width and logical alignment are native within the physical page; non-positive schema-valid widths produce a degradation note and portable fallback, while oversized `wide`/`full-width` tables remain page-bounded. `displayMode` is retained and `fixed` maps to Word fixed layout; responsive screen shrinking has no dynamic meaning in a static artifact. |
| `tableRow` | Row order, cells, and exact optional local ID (including empty) are preserved. | Native | Native | Closed for the pinned schema. |
| `tableHeader` | ADF `tableHeader` / Storage `<th>`, identity, per-cell `colwidth`, background, spans, and vertical alignment are preserved. | Native | Native | Portable geometry still uses the exporters' bounded table-shape limits. |
| `tableCell` | Content, identity, `colspan`, `rowspan`, background, exact `colwidth` vector (including zero/unfixed tracks), and `valign` are preserved. | Native | Native | Pathological/non-portable geometry is safely clamped and reported rather than allowed to exhaust a renderer. |

The pinned table attribute contract is now complete through validation, neutral
model, composition, packed browser execution, and both TypeScript renderers.
Wide-table pagination and target page bounds remain document-layout concerns,
not silent ADF notation loss.

Evidence: [E10], [E11], [E12], [E27].

### 6.4 Layouts and containers

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `layoutSection` | ADF becomes a typed layout with exact optional local identity and retained breakout intent. Storage `ac:layout-section` maps the documented `single`, `two_*`, and `three_*` arrangements to explicit portable tracks; missing/mismatched geometry uses equal tracks with a source-located note. | Native for pinned columns | Native for pinned columns | DOCX uses a borderless fixed OOXML table and PDF uses a semantic-free Typst grid. The pinned ADF schema and documented Storage shapes are closed; Cloud editor layouts beyond the pinned schema remain in the drift/observed-product lane. |
| `layoutColumn` | Required ADF percentage width, optional exact local identity, top/middle/bottom alignment, and recursively nested content survive. Storage cells inherit the section's documented proportions. | Native | Native | Schema-valid zero-width tracks remain visible through a bounded minimum and are reported. Nested headings/anchors, mentions, macros, assets, lists/tasks, and export controls traverse the column rather than being flattened or skipped. |
| `panel` | ADF `info`, `note`, `warning`, `tip`, `success`, and `error` remain distinct callout kinds; Storage callouts use the same neutral model. `custom` stays a visible generic panel with a degradation note. | Partial | Partial | Standard success/error semantics and distinct target palettes are native. Custom panel color/icon attributes still need a portable presentation contract. |
| `expand` | ADF and Storage become a recursive `expand` block retaining exact optional title/local identity; Storage additionally retains macro identity. | Partial: native static projection | Partial: native static projection | Both targets render a visibly open disclosure panel and emit `expand-static`; interactivity/collapsed state is inapplicable to a static artifact. Storage and ADF are differentially tested. |
| `nestedExpand` | A distinct nested disclosure survives with title, local identity, body ownership, and nesting context. Storage expands inside table cells or another expand use the same neutral shape. | Partial: native static projection | Partial: native static projection | Closed for the pinned static-export contract. The editor's interactive toggle is intentionally not claimed. |
| `caption` | A pinned-schema ADF caption's direct inline children and exact optional local identity remain attached to its `mediaSingle`. Scroll `scroll-title` remains a separate Storage adapter. | Native | Native | Closed for native caption association and numbering. Unresolved media renders as a visible numbered fallback instead of detaching the caption; broader media layout/crop/group semantics remain separate gaps. |

The layout renderers intentionally use target-owned static geometry. They do
not claim browser-responsive behavior, and `wide`/`full-width` breakout cannot
extend beyond the physical DOCX/PDF page. That residual is explicit rather
than a silent column loss.

Evidence: [E2], [E5], [E7], [E8], [E13], [E28].

### 6.5 Inline semantic content

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `date` | ADF epoch-millisecond timestamp/local identity and Storage `<time>` or legacy `date` macro values become one typed date. | Native | Native | Both targets render a neutral date chip with document-locale formatting in UTC. Invalid but schema-valid timestamps remain exact visible source text and emit `date-invalid`; units are never guessed. |
| `emoji` | ADF and Storage both retain `shortName`, optional service `id`, the exact optional source text (including empty text), and whether the visible run came from text or the short-name fallback. Raw colon text is never reinterpreted. | Partial/Conditional | Partial/Conditional | Unicode text and deterministic text fallback are native in the shared model and both TS engines; custom/Atlassian emoji still lack a documented portable asset resolver and full emoji-font guarantee. |
| `mention` | Storage user links become `mention { accountId, displayName? }`. | Partial/Conditional | Partial/Conditional | Static text only; display name needs host resolution, team/user distinction and profile-link policy are absent. |
| `status` | ADF text, exact semantic color, optional local identity/style, and Storage status macros become one typed status. | Native static projection | Native static projection | The pinned ADF color enum is validated; `mixedCase` preserves casing and other styles use Confluence-style uppercase. Both targets have explicit neutral/purple palettes plus deterministic legacy/unknown-color fallback. |
| `placeholder` | ADF text/local identity and Storage `<ac:placeholder>` text/type become a typed editor instruction. | Native hidden projection | Native hidden projection | Confluence hides template placeholders in published view, so both targets intentionally emit no visible text while the neutral model retains identity for tooling/composition. No degradation is reported for this correct projection. |

Evidence: [E2], [E5], [E7], [E8], [E14], [E23], [E30].

### 6.6 Cards and links

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `inlineCard` | Usually degrades to a normal hyperlink if Storage exposes `<a>`. | Partial | Partial | Card title, provider, icon, resolved metadata, and appearance are lost. |
| `blockCard` | Usually becomes a paragraph link. Datasource links are a special live-rendered path. | Partial/Conditional | Partial/Conditional | Model card appearance and stable title/URL fallback independently of datasource rendering. |
| `embedCard` | No typed model. URL/body may survive through a link or `export_view`. | Fallback | Fallback | Define poster/thumbnail/title/URL representation and report unrenderable embeds. |

Link behavior is not uniform: external safe URLs are clickable; composed in-scope page links can become internal anchors; unresolved page/attachment links may be styled text rather than live links. Card semantics must not be inferred solely from link survival.

Evidence: [E5], [E7], [E8], [E15], [E16].

### 6.7 Media

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `media` | Storage `<ac:image>` maps to a typed image. ADF media resolves only through exact host-proven file-ID correlation; otherwise a typed visible fallback retains media type/id/collection/occurrence/local identity, alt, dimensions, annotations, and any caption without attempting a fetch. | Partial/Conditional | Partial/Conditional | General file/link rendering, crop, link/border marks, and non-image media output remain absent. |
| `mediaGroup` | No grouping model. | Missing/Fallback | Missing/Fallback | Preserve attachment/gallery grouping and define a static file-list/gallery representation. |
| `mediaSingle` | Image reference, alt, numeric width/height, and native caption association reach `ExportBlock`; caption inline content and local identity survive. | Partial | Partial | Container layout, percent/pixel width type, crop, and PDF use of carried image dimensions remain open. |
| `mediaInline` | Inline image is either promoted to a block or replaced by alt text with a note. | Missing as inline | Missing as inline | Add true inline-media model and baseline/alignment/size rules. |

Image byte support, SVG rasterization, external-asset policy, and missing-alt reporting exist, but those operational strengths do not fill the missing ADF media semantics.

Evidence: [E2], [E7], [E8], [E17].

### 6.8 Extensions, macros, and synced content

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `extension` | Storage macro is captured as `unknown` with parameters/body/ID, then offered to the live renderer chain. | Conditional/Fallback | Conditional/Fallback | No generic ADF extension decoder; native output depends on registry renderer or `export_view`. |
| `inlineExtension` | Only status and Scroll inline controls are classified inline. Other macros risk block-shaped fallback. | Missing/Fallback | Missing/Fallback | Preserve inline placement and text/body fallback without splitting paragraphs. |
| `bodiedExtension` | Rich/plain body and structured parameters are retained on the unknown block. | Conditional/Fallback | Conditional/Fallback | Decode ADF parameters/body directly and retain extension identity regardless of live resolution. |
| `syncBlock` | No model or resolver. | Missing | Missing | Define snapshot/reference policy and stale/unavailable fallback. |
| `bodiedSyncBlock` | No model or resolver. | Missing/Fallback | Missing/Fallback | Preserve resource ID plus body and report whether the export used embedded or resolved content. |

The async registry currently covers TOC, Jira/JiraIssues, Confluence datasource lists, draw.io/Gliffy, multiexcerpt include, Scroll table layout, children, include/excerpt, page-properties report, and then an `export_view` catch-all. Every other macro falls to a visible placeholder with preserved body where available. This is good loss visibility, but it is not generic ADF extension support.

Forge macros may provide an `adfExport` function for `pdf`, `word`, or `other`. That output should ultimately be ingested as ADF, not only as flattened `export_view` HTML.

Evidence: [E2], [E3], [E4], [E18], [E19].

### 6.9 Schema/documentation drift watchlist

These types are mentioned by the human ADF documentation or may appear in product-specific/legacy payloads, but are not semantic node types in the pinned full schema:

| Type/family | Current handling | Required policy |
|---|---|---|
| `multiBodiedExtension` | No typed model; may arrive as wrapper/macro/export-view content. | Keep a product-corpus fixture and support behind an observed-version gate if Confluence emits it. |
| `extensionFrame` | No typed model. | Preserve visible body and extension identity if observed; never silently drop. |
| `unsupportedBlock` / `unsupportedInline` and `ac:adf-node` wrappers | Storage wrappers are traversed transparently. | Preserve original type/attributes in a typed unsupported node plus warning and visible fallback. |

## 7. Complete ADF mark matrix

This covers all 17 marks in the pinned schema.

| ADF mark | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `strong` | `<strong>`/`<b>` -> `bold`. | Native | Native | Add direct ADF fixture. |
| `em` | `<em>`/`<i>` -> `italic`. | Native | Native | Add engine-specific regression assertions. |
| `underline` | `<u>` -> `underline`. | Native | Native | Add direct ADF fixture. |
| `strike` | `<s>`/`<del>`/`<strike>` -> `strike`. | Native | Native | Add engine-specific regression assertions. |
| `code` | `<code>` -> `code`. | **Partial+** | **Native visual treatment** | DOCX now adds deterministic run shading and preserves explicit source shading; it still names a host font rather than embedding the bundled mono font. PDF renders a theme-colored inline chip with bounded padding/radius and the bundled mono font. Both retain exact token text. |
| `subsup` | `<sub>`/`<sup>` -> separate sub/sup marks. | Native | Native | Preserve ADF enum exactly and test combinations. |
| `textColor` | Span CSS color -> normalized RGB. | Native | Native | Theme-token mapping is intentionally flattened to static print color; add contrast policy. |
| `backgroundColor` | Span CSS background -> normalized RGB. | Native | Native | ADF disallows some combinations such as code; validate rather than synthesize invalid combinations. |
| `fontSize` | The schema-defined paragraph value `small` becomes target-neutral block presentation. | Native | Native | Validation rejects other values; DOCX emits explicit 9 pt runs and PDF uses the template's `adfSmallText` role with a safe 9 pt fallback. |
| `link` | HTML/Confluence link -> typed target. | Partial | Partial | Page/attachment/card links are not uniformly resolvable/clickable; collection/media attributes are lost. |
| `annotation` | Required `id` and exact `inlineComment` type are validated and retained on text/media ranges. | Partial | Partial | The underlying content remains visible, but comment bodies are separate Confluence resources and native Word-comment/PDF-note rendering is not implemented. |
| `alignment` | ADF `center`/`end` becomes target-neutral block presentation on paragraphs/headings. | Native | Native | DOCX emits logical `w:jc`; PDF emits Typst `align`. |
| `indentation` | ADF levels 1–6 become bounded target-neutral block indentation. | Native | Native | DOCX and PDF use target-owned, deterministic per-level steps distinct from list nesting. |
| `breakout` | `wide`/`full-width` mode and optional numeric width are validated and retained on layout sections. Other schema-valid block placements still degrade visibly. | Partial | Partial | Layout sections render page-bounded columns and emit a source-located approximation note. Generalize the retained mark to code/expand/sync blocks and define whether any target-owned page/section widening is safe. |
| `border` | Not modeled. | Missing | Missing | Preserve media border color/size where the target supports it. |
| `dataConsumer` | Not modeled. | Missing | Missing | Preserve structured data provenance or explicitly report it as non-visual metadata. |
| `fragment` | Required non-empty `localId` and exact optional `name` are retained on inline/block extensions and tables. | Partial | Partial | Identity survives composition, but it is not reinterpreted as a bookmark until Atlassian semantics and collision/link policy are documented. |

Evidence: [E2], [E5], [E7], [E8], [E20], [E21], [E26].

## 8. Editor notation mapping

Official Confluence documentation describes these input shortcuts. They are editor transformations, not syntax the exporter should parse from arbitrary stored text.

| Editor input | Intended stored semantic result | Current export outcome | Gap/acceptance fixture |
|---|---|---|---|
| `**Bold**` | `strong` | Native after Confluence materializes it. | ADF + live Storage fixture. |
| `*Italic*` | `em` | Native after materialization. | ADF + live Storage fixture. |
| `~~Strike~~` | `strike` | Native after materialization. | ADF + live Storage fixture. |
| Backtick-delimited text | `text` + `code` mark | Exact text plus a distinct inline-code chip in both targets; DOCX font embedding remains open. | Preserve underscores/spaces exactly; assert gray background, mono font, adjacency, escaping, links/annotations. |
| `# ` … `###### ` | `heading.level` | Native after materialization. | H1-H6 corpus plus composed-export level policy. |
| `1. ` | `orderedList` | Native, including non-1 starts and nested restarts. | ADF/Storage differential, DOCX numbering-part, PDF source/source-map, packed-browser parity, and rendered-golden gates are closed. |
| `* ` | `bulletList` | Native, including nested bullet ownership and visual levels. | ADF/Storage differential, DOCX/PDF structure, packed-browser parity, and rendered-golden gates are closed. |
| `> ` | `blockquote` | Native/approx. | Static styling golden. |
| Triple backticks + space | `codeBlock` | Partial. | Language, wrap, line numbers, long lines, empty/final newline. |
| `--- ` | `rule` | Native. | Semantic and visual golden. |
| `[title](URL)` | link mark or Smart Link transform | Link native/partial; card appearance lost. | Plain, inline-card, block-card, embed, unsafe URL, page, attachment. |
| `[] ` | task item | Native for pinned ADF/Storage semantics. | TODO/DONE, direct-inline and block tasks, nesting, identity, composition, and both target markers are covered; mentions/dates survive as ordinary inline semantics. |
| `<> ` | decision item | Native for the pinned ADF schema. | List/item identity and exact state survive; `DECIDED` and nonstandard states have deterministic static markers. |
| `:` / emoji picker | `emoji` node or text | Partial/conditional. | Unicode, Atlassian emoji, site custom emoji, missing asset, fallback text. |
| `:)` auto-conversion | Emoji/editor transformation | Works only if Confluence materializes a glyph/fallback; exporter does no conversion. | Live editor fixture with shortcuts enabled/disabled. |
| Raw `:shortname:` text | Not a stable documented ADF contract | Remains literal unless Confluence converted it first. | Never reinterpret ordinary text in exporter. |
| `@ ` | `mention` | Partial/conditional. | User/team/deactivated/unresolved mentions and profile-link policy. |
| `!` | media picker | Partial. | Image/file/video/audio, inline/block, dimensions, alt, layout, crop. |
| `{` | macro autocomplete | `extension*` or legacy macro projection | Conditional/fallback. | Core, Forge `adfExport`, Connect/migrated, unknown, offline. |
| `//` | `date` | Partial. | Locale/time-zone formatting policy and deterministic snapshot. |
| `/...` | Selected node/macro | Depends on result type. | Coverage is judged by the resulting ADF node, not the slash string. |

## 9. Two high-signal visual gaps

### 9.1 Inline code — visual gap closed, DOCX font embedding remains

The shared parser distinguishes inline code from code blocks and both targets now reproduce the visible inline-code treatment:

- DOCX emits a monospace run with deterministic `w:shd` background. An explicit neutral-model background still overrides the default rather than creating nested fills.
- PDF applies a non-block `raw` rule with the resolved template's code background, bounded horizontal/vertical inset, radius, bundled mono font, and code size. Block raw retains its separate full-width rule.
- Focused semantic tests pin underscores, exact token text, surrounding prose, default fill, and source-fill precedence.
- The synthetic ADF feature-zoo references were regenerated through real DOCX/LibreOffice and Typst/PDF/Poppler rendering. All pages were visually inspected without clipping, overlap, missing glyphs, or broken wrapping.

Required acceptance contract:

- [ ] Embed or otherwise guarantee the DOCX mono font instead of relying on the recipient's host-font substitution.
- [x] Use the bundled mono font in PDF.
- [x] Apply a subtle target-appropriate background.
- [x] Add predictable horizontal padding where the target format allows it.
- [x] Preserve underscores, token-like identifiers, whitespace, punctuation, and adjacent line wrapping.
- [ ] Close annotation export before claiming the pinned code+annotation combination.
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
- [ ] **Partial — extend the neutral model before serializers.** Supported
  semantics use typed representations and every unsupported path has visible,
  bounded diagnostics; native representations for the open matrix rows remain.
- [x] **Versioned coverage manifest.** All pinned nodes and marks are
  classified, and CI rejects unreviewed schema/coverage drift.
- [ ] **Partial — real Confluence feature corpus.** Sanitized observed fixtures
  exist for selected slices; broad editor-feature ADF/Storage pairs and build
  provenance remain open.
- [x] **Never-silent diagnostics.** Unknown nodes, marks, attributes,
  extensions, media kinds, and contract failures are bounded and
  source-located in export reports.

### P1 - Close user-visible core gaps

- [ ] **Partial — inline code.** Visual treatment, exact token preservation,
  serializer tests, and rendered goldens are complete; guaranteed DOCX
  monospace embedding and native comment output for code-plus-annotation remain.
- [ ] **Partial — emoji/custom emoji.** Identity, exact text, deterministic
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
- [ ] **Partial — breakout.** Layout-section intent survives and is explicitly
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
- [ ] **Partial — card/embed metadata.** Deterministic visible URL fallbacks
  exist; native title/provider/poster metadata remains.
- [ ] **Partial — media family.** Selected image/media paths exist; group,
  inline, file/video/audio, crop, border, and link coverage remains.
- [ ] **Partial — page/attachment hyperlinks.** Safe external and selected
  composed links work; uniform page and attachment resolution remains.

### P2 - Dynamic and advanced content

- [ ] **Partial — ADF extensions.** Direct extension identities, parameters,
  visible fallbacks, and export controls are decoded; Forge `adfExport`
  ingestion before HTML fallback remains.
- [ ] **Open — sync-block snapshot/reference policy.**
- [ ] **Partial — annotation and fragment marks.** Exact source identities,
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

- [ ] **Partial:** inline code; DOCX font guarantee and annotation combination
  remain.
- [ ] **Partial:** emoji/custom emoji; custom assets and complete glyph coverage
  remain.
- [x] Alignment, indentation, and the schema-defined small paragraph font size.
- [x] Date/status/placeholder semantics and target projections.
- [ ] Link/card identity.
- [ ] **Partial:** annotation/fragment identity is retained; native target
  semantics and comment-resource correlation remain.

### Phase 2 - Structural fidelity

- [x] Tasks and decisions.
- [x] Ordered-list authored starts and nested restarts.
- [x] Nested bullet/numbered/task parity across ADF and Storage.
- [x] Table attributes for static DOCX/PDF; page-bound wide-table layout remains
  a measured renderer policy rather than an ADF decoding gap.
- [x] Layout columns for pinned ADF and documented Storage shapes.
- [ ] Breakout beyond page-bounded layout-section intent.
- [x] Captions and nested expands for the pinned static-export contract.

### Phase 3 - Media and extensions

- [ ] Full media family and static embed fallbacks.
- [ ] **Partial:** ADF-native extension forms are decoded; Forge `adfExport`
  ingestion remains.
- [ ] Synced content policy.

### Phase 4 - Conformance and release gate

- [x] Cross-engine semantic parity fixtures and packed conformance registry.
- [x] DOCX OOXML assertions and rendered Word/LibreOffice goldens for completed
  feature slices.
- [x] Typst source assertions and rasterized PDF visual goldens for completed
  feature slices.
- [x] Browser-host and CLI-host parity for the shared TS engine shapes.
- [ ] **Partial:** live Confluence E2E with cleanup exists for selected slices;
  the full feature-zoo corpus remains.

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

Focused missing gates:

- [ ] Date localization and deterministic time-zone policy.
- [ ] Generic inline/block/embed card metadata tests.
- [x] Layout width/column tests for pinned ADF and documented Storage shapes.
- [ ] Breakout rendering beyond the page-bounded layout-section approximation.
- [ ] Media group/inline/file/video/audio completeness tests.
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

## 16. Review questions

1. Should the target be “100% of the pinned full ADF schema,” or “100% of a verified Confluence Cloud authoring corpus plus explicit schema-only fallbacks”? The latter is more defensible as a product promise.
2. Should direct ADF become the primary Cloud input with Storage retained as a compatibility/fallback adapter, or should both adapters remain first-class and be differentially tested?
3. **Resolved for this migration:** short-name/text fallback with a typed warning is the portable floor; authorized asset retrieval waits for a documented Atlassian contract.
4. For cards and embeds, is a stable title + URL representation sufficient for the first fidelity milestone, or are thumbnails/provider metadata required?
5. **Partially resolved for this migration:** annotation/fragment identities are
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
