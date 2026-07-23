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
| `bulletList` | `<ul>` becomes `list { ordered: false }`. | Native | Native | Maximum nesting and resource budgets remain exporter constraints. |
| `orderedList` | `<ol start>` and ADF `order` become `list { ordered: true, start? }`. | Native | Native | Authored starts, including zero, survive the neutral model. DOCX emits a self-contained single-level numbering definition per ordered-list node; PDF emits Typst `enum(start:)`. Each nested node owns an independent restart and visual indent. |
| `listItem` | Child blocks are recursively preserved. | Native | Native | Local IDs are not retained. |
| `taskList` | ADF and Storage become a typed task list with list identity where exposed; nested ADF task lists attach to their owning item. | Native | Native | Closed for the pinned schema; any future observed product-specific attributes enter the drift lane. |
| `taskItem` | Required `localId`, exact `TODO`/`DONE` state, direct inline content, and checkbox projection are retained. | Native | Native | Closed with distinct open/done markers, composition, browser parity, and real render goldens. |
| `blockTaskItem` | Required identity/state and one-or-more block children remain a distinct typed task item. | Native | Native | Closed with block-content and nested-list coverage. |
| `decisionList` | Required list identity and decision grouping are retained directly from ADF. | Native | Native | Schema-only source contract; no equivalent Storage projection is claimed. |
| `decisionItem` | Required local identity, exact product-defined string state, and direct inline content are retained. | Native | Native | `DECIDED` uses a filled decision marker; nonstandard states remain visibly labeled rather than being collapsed. |

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
| `panel` | ADF `info`, `note`, `warning`, `tip`, `success`, and `error` remain distinct callout kinds; Storage callouts use the same neutral model. `custom` stays a visible generic panel with a degradation note. | Partial | Partial | Standard success/error semantics and distinct target palettes are native. Custom panel color/icon attributes still need a portable presentation contract. |
| `expand` | Known macro body is emitted transparently. | Partial | Partial | Title and collapsed/expanded affordance are lost. |
| `nestedExpand` | No distinct mapping; content may survive transparent descent. | Fallback | Fallback | Preserve title and nesting context; choose a deterministic static disclosure treatment. |
| `caption` | No native ADF-caption input mapping. Scroll `scroll-title` can attach an exporter caption. | Partial workaround | Partial workaround | Implement native caption node and media association; keep Scroll compatibility as a separate source adapter. |

Evidence: [E2], [E5], [E7], [E8], [E13].

### 6.5 Inline semantic content

| ADF node | Current source mapping | DOCX | PDF | Primary gap |
|---|---|---|---|---|
| `date` | `<time>` becomes raw `datetime` or visible text. | Partial | Partial | Retain timestamp semantically and format by document locale/time policy. |
| `emoji` | ADF and Storage both retain `shortName`, optional service `id`, the exact optional source text (including empty text), and whether the visible run came from text or the short-name fallback. Raw colon text is never reinterpreted. | Partial/Conditional | Partial/Conditional | Unicode text and deterministic text fallback are native in the shared model and both TS engines; custom/Atlassian emoji still lack a documented portable asset resolver and full emoji-font guarantee. |
| `mention` | Storage user links become `mention { accountId, displayName? }`. | Partial/Conditional | Partial/Conditional | Static text only; display name needs host resolution, team/user distinction and profile-link policy are absent. |
| `status` | Status macro becomes typed text + color. | Native/approx. | Native/approx. | Pin ADF color/style mapping and unknown-color fallback; current output is a static badge. |
| `placeholder` | No typed model; unknown inline wrappers are traversed. | Missing/Fallback | Missing/Fallback | Preserve placeholder identity/text and emit explicit fallback rather than accidental text-only behavior. |

Evidence: [E2], [E5], [E7], [E8], [E14], [E23].

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
| `code` | `<code>` -> `code`. | **Partial+** | **Native visual treatment** | DOCX now adds deterministic run shading and preserves explicit source shading; it still names a host font rather than embedding the bundled mono font. PDF renders a theme-colored inline chip with bounded padding/radius and the bundled mono font. Both retain exact token text. |
| `subsup` | `<sub>`/`<sup>` -> separate sub/sup marks. | Native | Native | Preserve ADF enum exactly and test combinations. |
| `textColor` | Span CSS color -> normalized RGB. | Native | Native | Theme-token mapping is intentionally flattened to static print color; add contrast policy. |
| `backgroundColor` | Span CSS background -> normalized RGB. | Native | Native | ADF disallows some combinations such as code; validate rather than synthesize invalid combinations. |
| `fontSize` | The schema-defined paragraph value `small` becomes target-neutral block presentation. | Native | Native | Validation rejects other values; DOCX emits explicit 9 pt runs and PDF uses the template's `adfSmallText` role with a safe 9 pt fallback. |
| `link` | HTML/Confluence link -> typed target. | Partial | Partial | Page/attachment/card links are not uniformly resolvable/clickable; collection/media attributes are lost. |
| `annotation` | Not modeled. | Missing | Missing | Preserve annotation identity separately from comment-export policy; underlying text must remain. |
| `alignment` | ADF `center`/`end` becomes target-neutral block presentation on paragraphs/headings. | Native | Native | DOCX emits logical `w:jc`; PDF emits Typst `align`. |
| `indentation` | ADF levels 1–6 become bounded target-neutral block indentation. | Native | Native | DOCX and PDF use target-owned, deterministic per-level steps distinct from list nesting. |
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
| Backtick-delimited text | `text` + `code` mark | Exact text plus a distinct inline-code chip in both targets; DOCX font embedding remains open. | Preserve underscores/spaces exactly; assert gray background, mono font, adjacency, escaping, links/annotations. |
| `# ` … `###### ` | `heading.level` | Native after materialization. | H1-H6 corpus plus composed-export level policy. |
| `1. ` | `orderedList` | Native, including non-1 starts and nested restarts. | Keep ADF/Storage differential, DOCX numbering-part, PDF source, and packed-browser parity gates. |
| `* ` | `bulletList` | Native. | Mixed nested ordered/unordered corpus. |
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
  monospace embedding and the code-plus-annotation combination remain.
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
- [ ] **Open — table attributes.** Layout, display mode, numbered column,
  vertical alignment, and width remain.
- [ ] **Open — layout columns and breakout.**
- [ ] **Partial — captions and nested expands.** Visible fallbacks exist;
  native association, title, nesting, and static disclosure treatment remain.
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
- [ ] **Open — annotation, fragment, data-consumer, and product metadata
  policy.**
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
- [ ] Link/card identity and date semantics.

### Phase 2 - Structural fidelity

- [x] Tasks and decisions.
- [x] Ordered-list authored starts and nested restarts.
- [ ] Table attributes.
- [ ] Layouts/breakout.
- [ ] Captions/nested expands.

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
- [x] Task/decision identity, exact state, inline/block content, nested tasks,
  composition, both target markers, real render goldens, and packed browser
  parity.
- [x] Generic inline-extension placement and visible fallback.

Focused missing gates:

- [ ] Date localization and deterministic time-zone policy.
- [ ] Generic inline/block/embed card metadata tests.
- [ ] Layout width/column tests.
- [ ] Media group/inline/file/video/audio completeness tests.
- [ ] Native ADF caption/nested-expand tests.
- [ ] Sync-block snapshot/reference tests.
- [ ] Annotation/fragment/data-consumer preservation tests.
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

## 16. Review questions

1. Should the target be “100% of the pinned full ADF schema,” or “100% of a verified Confluence Cloud authoring corpus plus explicit schema-only fallbacks”? The latter is more defensible as a product promise.
2. Should direct ADF become the primary Cloud input with Storage retained as a compatibility/fallback adapter, or should both adapters remain first-class and be differentially tested?
3. **Resolved for this migration:** short-name/text fallback with a typed warning is the portable floor; authorized asset retrieval waits for a documented Atlassian contract.
4. For cards and embeds, is a stable title + URL representation sufficient for the first fidelity milestone, or are thumbnails/provider metadata required?
5. Should annotations/comments be exported as Word comments/PDF notes, or only preserved as metadata while the underlying text remains visible?
6. **Resolved for tasks and decisions:** target-appropriate open/done task
   markers and a distinct decision marker are the static floor; exact
   identities/states remain in the neutral model and nonstandard decision
   states are visibly labeled. Nested expands, synced blocks, audio, and video
   remain open.
7. Is visual parity measured against a curated atlcli design system, Confluence's standard export appearance, or configurable target templates? Semantic parity can be target-independent; pixel parity cannot.
