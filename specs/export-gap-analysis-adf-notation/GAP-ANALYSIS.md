# Export gap analysis: Confluence ADF notation to DOCX and PDF

Status: implementation baseline  
Analysis date: 2026-07-22  
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

The current Cloud export is **Storage-XHTML-first, not ADF-first**:

```text
Confluence body.storage
        |
        v
storageToBlocks() ---- optional live macro/export_view resolution
        |
        v
ExportBlock[] + InlineNode[]
        |                         |
        v                         v
DOCX/OOXML serializer        Typst/PDF serializer
```

`ConfluenceClient.getPage()` requests `body.storage`; DOCX and tree export then call `storageToBlocks()`. The parallel CLI job-runtime work keeps source resolution host-owned, but it still enters this Storage-first source path and is deliberately not part of this branch baseline. Third-party `adfExport` output reaches atlcli only indirectly after Confluence renders it to `export_view` HTML, which is parsed by a deliberately limited HTML-subset converter. See [E1], [E2], [E3], and [E4].

Consequences:

- Current coverage claims are conditional on Confluence's undocumented ADF-to-Storage projection.
- A feature can be valid ADF yet be unobservable, flattened, or transformed before atlcli sees it.
- `ExportBlock` cannot currently represent all 43 node types or all 17 marks in the pinned ADF schema.
- DOCX and PDF share most parse/model gaps because both consume the same intermediate model.
- Reaching a defensible 100% target requires a direct ADF decoder, a pinned-schema compatibility matrix, and a real Confluence fixture corpus. Serializer-only work cannot close this architecture gap.

## 3. Scope and source policy

### In scope

- The 43 semantic node types and 17 marks in the pinned official full ADF schema.
- Confluence Cloud editor features explicitly documented by Atlassian.
- Current Storage-XHTML, `export_view`, `ExportBlock`, DOCX, and Typst/PDF behavior.
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

The matrix covers every semantic node type in `@atlaskit/adf-schema@56.1.13`. “Source” describes the current Storage/export-view path, not a direct ADF decoder.

### 6.1 Root and basic content

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `doc` | No ADF root is parsed; Storage fragment becomes `ExportBlock[]`. | N/A | N/A | Add validated ADF document entry point with schema/version diagnostics. |
| `paragraph` | `<p>` or loose inline content becomes a typed paragraph. | Native | Native | Alignment, indentation, font size, local ID, and other ADF attributes are outside the model. |
| `heading` | `<h1>`…`<h6>` retains level and inline content. | Native | Native | Composed exports may rebase levels; alignment/indentation marks are missing. |
| `text` | Unicode text is retained and XML/Typst escaped. | Native | Native | Rendering still depends on target font glyph coverage. |
| `hardBreak` | `<br>` becomes `lineBreak`. | Native | Native | Add direct ADF fixture; Storage path is covered. |
| `rule` | `<hr>` becomes `divider`. | Native | Native | Add direct ADF fixture. |
| `blockquote` | Structured body becomes `blockquote`. | Native/approx. | Native/approx. | Static styling is exporter-owned rather than an ADF fidelity issue. |
| `codeBlock` | `<pre>` and `code`/`noformat` macros retain code; macro form may retain language. | Partial | Partial | ADF `wrap`, `hideLineNumbers`, and `uniqueId` are not modeled. Language is supported; code-block wrapping/line-number semantics are not. |

Evidence: [E2], [E5], [E6], [E7], [E8].

### 6.2 Lists, tasks, and decisions

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `bulletList` | `<ul>` becomes `list { ordered: false }`. | Native | Native | Maximum nesting and resource budgets remain exporter constraints. |
| `orderedList` | `<ol>` becomes `list { ordered: true }`. | Partial | Partial | ADF `order` / HTML `start` is not captured; every list effectively starts at 1. |
| `listItem` | Child blocks are recursively preserved. | Native | Native | Local IDs are not retained. |
| `taskList` | `<ac:task-list>` becomes an unordered list with checked items. | Partial | Partial | List identity, nesting rules, attribution, and task metadata are not modeled. |
| `taskItem` | Task status maps to a boolean `checked`. | Partial | Partial | Static checkbox only; local ID and assignment/due-date semantics are lost. |
| `blockTaskItem` | No distinct model variant. | Missing | Missing | Preserve block task content/state and nesting as a typed task variant. |
| `decisionList` | No model or dedicated Storage handler. | Missing/Fallback | Missing/Fallback | Text may survive transparent descent; decision grouping and marker do not. |
| `decisionItem` | No model or dedicated Storage handler. | Missing/Fallback | Missing/Fallback | Preserve state, marker, content, and local ID as a static decision block. |

Evidence: [E2], [E5], [E7], [E8], [E9].

### 6.3 Tables

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `table` | Rows, `colgroup` widths, and cell data become a typed table. | Partial | Partial | ADF `layout`, `displayMode`, `width`, and `isNumberColumnEnabled` are not modeled. |
| `tableRow` | Row order and cells are preserved. | Native | Native | Local ID is omitted. |
| `tableHeader` | `<th>` becomes `header: true`. | Native | Native | Cell vertical alignment and source column semantics are omitted. |
| `tableCell` | Content, `colspan`, `rowspan`, background, and column widths are preserved. | Partial | Partial | ADF `valign`, full `colwidth`, and metadata are incomplete; each engine applies its own geometry clamps. |

The current table model is materially stronger than a Markdown intermediary, but it is not yet an ADF-complete table contract. Wide-table behavior and static pagination are document-layout concerns and should be measured separately from node parsing.

Evidence: [E10], [E11], [E12].

### 6.4 Layouts and containers

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `layoutSection` | Storage layout wrappers are traversed transparently. | Partial | Partial | Multi-column layout is linearized; section width/layout mode is lost. |
| `layoutColumn` | Cell content survives in document order. | Partial | Partial | Width and vertical alignment are lost. |
| `panel` | `info`, `note`, `warning`, `tip`, and generic `panel` become callouts. | Partial | Partial | ADF `error`, `success`, and `custom` semantics plus icon/color attributes are not represented generically. |
| `expand` | Known macro body is emitted transparently. | Partial | Partial | Title and collapsed/expanded affordance are lost. |
| `nestedExpand` | No distinct mapping; content may survive transparent descent. | Fallback | Fallback | Preserve title and nesting context; choose a deterministic static disclosure treatment. |
| `caption` | No native ADF-caption input mapping. Scroll `scroll-title` can attach an exporter caption. | Partial workaround | Partial workaround | Implement native caption node and media association; keep Scroll compatibility as a separate source adapter. |

Evidence: [E2], [E5], [E7], [E8], [E13].

### 6.5 Inline semantic content

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `date` | `<time>` becomes raw `datetime` or visible text. | Partial | Partial | Retain timestamp semantically and format by document locale/time policy. |
| `emoji` | `<ac:emoticon>` becomes plain text from `ac:emoji-fallback`, otherwise `ac:name`; raw Unicode remains text. | Partial/Conditional | Partial/Conditional | No ADF `id`/`shortName` model, custom-emoji asset path, fallback policy, or emoji-font guarantee. No dedicated regression test. |
| `mention` | Storage user links become `mention { accountId, displayName? }`. | Partial/Conditional | Partial/Conditional | Static text only; display name needs host resolution, team/user distinction and profile-link policy are absent. |
| `status` | Status macro becomes typed text + color. | Native/approx. | Native/approx. | Pin ADF color/style mapping and unknown-color fallback; current output is a static badge. |
| `placeholder` | No typed model; unknown inline wrappers are traversed. | Missing/Fallback | Missing/Fallback | Preserve placeholder identity/text and emit explicit fallback rather than accidental text-only behavior. |

Evidence: [E2], [E5], [E7], [E8], [E14].

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
| `media` | Only image-shaped Storage (`<ac:image>`) has a typed source. | Partial | Partial | General file/link media, collection/id lookup, occurrence key, crop, link/border marks, and non-image media are absent. |
| `mediaGroup` | No grouping model. | Missing/Fallback | Missing/Fallback | Preserve attachment/gallery grouping and define a static file-list/gallery representation. |
| `mediaSingle` | Image reference, alt, and numeric width/height reach `ExportBlock`. | Partial | Partial | Container layout, percent/pixel width type, crop, and native caption association are lost; PDF currently ignores carried width/height at emission. |
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
| `code` | `<code>` -> `code`. | **Partial** | **Partial** | Both engines render monospace/raw, but neither automatically applies the expected inline-code background/padding. DOCX sets only run fonts; PDF's styled raw rule applies only to block raw. |
| `subsup` | `<sub>`/`<sup>` -> separate sub/sup marks. | Native | Native | Preserve ADF enum exactly and test combinations. |
| `textColor` | Span CSS color -> normalized RGB. | Native | Native | Theme-token mapping is intentionally flattened to static print color; add contrast policy. |
| `backgroundColor` | Span CSS background -> normalized RGB. | Native | Native | ADF disallows some combinations such as code; validate rather than synthesize invalid combinations. |
| `fontSize` | No `InlineMark` variant or source mapping. | Missing | Missing | Add a bounded, theme-aware size model and prevent pathological sizes. |
| `link` | HTML/Confluence link -> typed target. | Partial | Partial | Page/attachment/card links are not uniformly resolvable/clickable; collection/media attributes are lost. |
| `annotation` | Not modeled. | Missing | Missing | Preserve annotation identity separately from comment-export policy; underlying text must remain. |
| `alignment` | Not modeled. | Missing | Missing | Add block alignment and target-specific paragraph alignment. |
| `indentation` | Not modeled. | Missing | Missing | Add bounded block indentation distinct from list nesting. |
| `breakout` | Not modeled. | Missing | Missing | Map wide/full-width intent to page/section/table policy with deterministic static fallback. |
| `border` | Not modeled. | Missing | Missing | Preserve media border color/size where the target supports it. |
| `dataConsumer` | Not modeled. | Missing | Missing | Preserve structured data provenance or explicitly report it as non-visual metadata. |
| `fragment` | Not modeled as an ADF mark. Separate anchor macros exist. | Missing | Missing | Preserve named fragment/local ID and connect it to bookmark/link composition. |

Evidence: [E2], [E5], [E7], [E8], [E20], [E21].

## 8. Editor notation mapping

Official Confluence documentation describes these input shortcuts. They are editor transformations, not syntax the exporter should parse from arbitrary stored text.

| Editor input | Intended stored semantic result | Current export outcome | Gap/acceptance fixture |
|---|---|---|---|
| `**Bold**` | `strong` | Native after Confluence materializes it. | ADF + live Storage fixture. |
| `*Italic*` | `em` | Native after materialization. | ADF + live Storage fixture. |
| `~~Strike~~` | `strike` | Native after materialization. | ADF + live Storage fixture. |
| Backtick-delimited text | `text` + `code` mark | Semantics partial; visual treatment incomplete. | Preserve underscores/spaces exactly; assert gray background, mono font, adjacency, escaping, links/annotations. |
| `# ` … `###### ` | `heading.level` | Native after materialization. | H1-H6 corpus plus composed-export level policy. |
| `1. ` | `orderedList` | Partial. | Preserve non-1 start/order and nested restart semantics. |
| `* ` | `bulletList` | Native. | Mixed nested ordered/unordered corpus. |
| `> ` | `blockquote` | Native/approx. | Static styling golden. |
| Triple backticks + space | `codeBlock` | Partial. | Language, wrap, line numbers, long lines, empty/final newline. |
| `--- ` | `rule` | Native. | Semantic and visual golden. |
| `[title](URL)` | link mark or Smart Link transform | Link native/partial; card appearance lost. | Plain, inline-card, block-card, embed, unsafe URL, page, attachment. |
| `[] ` | task item | Partial. | TODO/DONE, assignee, date, nested/block task. |
| `<> ` | decision item | Missing. | Decision list/item marker, state, nested content. |
| `:` / emoji picker | `emoji` node or text | Partial/conditional. | Unicode, Atlassian emoji, site custom emoji, missing asset, fallback text. |
| `:)` auto-conversion | Emoji/editor transformation | Works only if Confluence materializes a glyph/fallback; exporter does no conversion. | Live editor fixture with shortcuts enabled/disabled. |
| Raw `:shortname:` text | Not a stable documented ADF contract | Remains literal unless Confluence converted it first. | Never reinterpret ordinary text in exporter. |
| `@ ` | `mention` | Partial/conditional. | User/team/deactivated/unresolved mentions and profile-link policy. |
| `!` | media picker | Partial. | Image/file/video/audio, inline/block, dimensions, alt, layout, crop. |
| `{` | macro autocomplete | `extension*` or legacy macro projection | Conditional/fallback. | Core, Forge `adfExport`, Connect/migrated, unknown, offline. |
| `//` | `date` | Partial. | Locale/time-zone formatting policy and deterministic snapshot. |
| `/...` | Selected node/macro | Depends on result type. | Coverage is judged by the resulting ADF node, not the slash string. |

## 9. Two high-signal visual gaps

### 9.1 Inline code

Current shared parsing correctly distinguishes inline code from a code block. The renderers do not yet reproduce a visually distinct inline-code chip:

- DOCX sets a monospace run font but no automatic run shading.
- PDF emits inline Typst `raw(...)`, while the template's background/inset/radius rule is scoped to `raw.where(block: true)`.
- Existing background-color support does not solve this: ADF inline code is a `code` mark and is not expected to carry an additional background-color mark.
- There is no focused DOCX/PDF regression test that pins inline-code shading, padding, and adjacent text behavior.

Required acceptance contract:

- monospace bundled font, not a host-dependent default;
- subtle theme-controlled background;
- predictable horizontal padding where the target format allows it;
- exact preservation of underscores, token-like identifiers, whitespace, punctuation, and adjacent line wrapping;
- safe combinations with link and annotation per the pinned schema;
- separate tests for inline code and block code.

### 9.2 Emoji and emoticons

Current behavior is passive:

- Raw Unicode survives as text if the selected font/rendering stack has the glyph.
- `ac:emoji-fallback` is preferred, otherwise `ac:name` is emitted literally.
- If Storage supplies a colon short name such as `:warning:` as `ac:emoji-fallback` (a shape already present in the repository fixtures), current DOCX/PDF output keeps that literal string; it does not resolve it to a glyph. See [E22].
- `ac:emoji-shortname`, ADF `id`, and ADF `shortName` are not modeled.
- The exporter does not convert raw colon notation, which is the correct default for stored text.
- Custom emoji have no asset resolver or deterministic missing-asset fallback.
- The production `ac:emoticon` path has no dedicated walker or engine regression test.
- The PDF runtime bundles text/code fonts but no emoji-specific font, so Unicode coverage is not guaranteed.

Required acceptance contract:

1. Prefer ADF `text` when it contains a standard Unicode sequence.
2. For standard emoji without `text`, resolve `shortName` through a pinned map or emit the short name with a warning.
3. For site custom emoji, resolve the asset when authorized and within budget; otherwise emit `text`/`shortName` plus a typed warning.
4. Define DOCX image-baseline and PDF inline-image sizing for custom emoji.
5. Test skin tone, ZWJ sequences, variation selectors, flags, missing glyphs, deleted custom emoji, and literal colon text.

## 10. Prioritized gap backlog

### P0 - Make coverage measurable

1. **Add an ADF-native source adapter.** Introduce `adfToBlocks()` beside `storageToBlocks()`, validate `doc.version`, pin the official schema, and keep Storage as a separate compatibility adapter.
2. **Extend the neutral model before serializers.** Every supported ADF node/mark needs a typed representation or an explicit `unsupported` representation carrying type, safe attributes, visible fallback, and source path.
3. **Create a versioned coverage manifest.** One row per node/mark with parse, DOCX, PDF, fallback, warning, unit, golden, and live-fixture status. CI must fail when the pinned schema adds an unmapped type.
4. **Build a real Confluence feature corpus.** Store sanitized ADF and Storage projections for editor-created examples. Record Confluence build/date and compare the two representations.
5. **Never-silent diagnostics.** Unknown node, mark, attribute, extension, media kind, or schema version must be counted and source-located in the export report.

### P1 - Close user-visible core gaps

6. Inline-code visual treatment and regression goldens.
7. Emoji/custom-emoji semantics, asset fallback, and font/glyph coverage.
8. Paragraph/heading alignment, indentation, and font size.
9. Decisions and full task semantics.
10. Ordered-list start and nested restart behavior.
11. Table layout/display mode/numbered column/vertical alignment/width.
12. Layout columns and breakout/wide/full-width behavior.
13. Native captions and nested expand title/static disclosure treatment.
14. Card/embed metadata and deterministic URL/title/poster fallback.
15. Media group, inline media, file/video/audio representation, crop, border, and link.
16. Uniform page and attachment hyperlink resolution.

### P2 - Dynamic and advanced content

17. Decode `extension`, `inlineExtension`, and `bodiedExtension` directly from ADF; ingest Forge `adfExport` as ADF before any HTML fallback.
18. Define sync-block snapshot/reference policy.
19. Preserve annotation, fragment, data-consumer, and product-specific metadata with explicit static-export policy.
20. Maintain a schema-drift lane for human-doc-only and observed product-specific node shapes.

## 11. Suggested implementation sequence

### Phase 0 - Contract and corpus

- Pin schema and add schema-diff CI.
- Add `AdfDocument` validation and an unknown-node/mark preservation shape.
- Create paired ADF/Storage fixtures from Confluence editor examples.
- Generate the coverage manifest from the schema rather than maintaining an unaudited hand list.

### Phase 1 - High-value inline fidelity

- Inline code.
- Emoji/custom emoji.
- Alignment, indentation, font size.
- Link/card identity and date semantics.

### Phase 2 - Structural fidelity

- Tasks, decisions, ordered-list start.
- Table attributes.
- Layouts/breakout.
- Captions/nested expands.

### Phase 3 - Media and extensions

- Full media family and static embed fallbacks.
- ADF-native extension forms and Forge `adfExport` ingestion.
- Synced content policy.

### Phase 4 - Conformance and release gate

- Cross-engine semantic parity fixtures.
- DOCX OOXML assertions and rendered Word/LibreOffice goldens.
- Typst source assertions and rasterized PDF visual goldens.
- Browser-host and CLI-host parity.
- Live Confluence feature-zoo E2E with resource cleanup.

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

Current tests already cover substantial Storage-to-model and serializer behavior, including basic marks/colors/line breaks, links/mentions, lists/tasks, tables, code blocks, captions, page breaks/orientation, and table layout. However, the suite is not an ADF conformance suite because it mostly begins with Storage XML or hand-built `ExportBlock` values.

Focused missing gates include:

- schema-derived enumeration asserting all 43 nodes and 17 marks are classified;
- direct ADF-to-model fixtures;
- emoji/emoticon walker and both-engine render tests;
- inline-code DOCX and PDF visual/semantic tests;
- date localization tests;
- decision list/item tests;
- ordered-list non-1 start tests;
- generic inline/block/embed card tests;
- layout width/column tests;
- media group/inline/file/video/audio tests;
- alignment/indentation/font-size tests;
- native ADF caption/nested-expand tests;
- sync-block tests;
- generic inline extension placement tests;
- annotation/fragment/data-consumer preservation tests;
- paired live Confluence ADF-versus-Storage projection fixtures.

The current checkout has no installed workspace dependencies, so the focused source tests could not be executed during this documentation-only analysis. Existing tests were inspected as evidence; they were not reported as freshly passing.

## 14. Official sources

Accessed 2026-07-22:

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

## 16. Review questions

1. Should the target be “100% of the pinned full ADF schema,” or “100% of a verified Confluence Cloud authoring corpus plus explicit schema-only fallbacks”? The latter is more defensible as a product promise.
2. Should direct ADF become the primary Cloud input with Storage retained as a compatibility/fallback adapter, or should both adapters remain first-class and be differentially tested?
3. For custom emoji, is authorized asset retrieval required for v1, or is short-name/text fallback with a warning acceptable initially?
4. For cards and embeds, is a stable title + URL representation sufficient for the first fidelity milestone, or are thumbnails/provider metadata required?
5. Should annotations/comments be exported as Word comments/PDF notes, or only preserved as metadata while the underlying text remains visible?
6. Which static representation is preferred for decisions, tasks, nested expands, synced blocks, audio, and video?
7. Is visual parity measured against a curated atlcli design system, Confluence's standard export appearance, or configurable target templates? Semantic parity can be target-independent; pixel parity cannot.
