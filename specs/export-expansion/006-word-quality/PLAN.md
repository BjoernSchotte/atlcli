# 006 — Word output quality: numbering, column widths, SVG, StyleRef

## Reference

- `specs/export-expansion/UMSETZUNGSPLAN.md` — Lane G (T1.13–T1.16): owner of
  `packages/docx/src/{serialize,ooxml,image}.ts`; starts after the Lane-C
  serializer landing (T1.5) merges, or coordinates via rebase.
- `specs/export-expansion/BASELINE-DESIGN.md` §6 "Cluster G — Word-Output-Qualität"
  (G1–G4) — task details, code sketches, and the recommended order
  G1 → G3+G2 (one golden-recapture PR) → G4 (parallel).
- Code owned by this folder:
  - `packages/docx/src/serialize.ts` — list rendering with literal marker runs
    (`serializeListItem`, line 519; `INDENT_STEP = 360`, line 118), table call
    without widths (line 396), `serializeTable` (line 568),
    `addParagraphProps` (line 200), `placeMarker` (line 215),
    `computeHeadingOffset` (line 243), `SerializeContext` (line 92).
  - `packages/docx/src/ooxml.ts` — `resolveHeadingStyleId` (line 46),
    `dataTable` with the even 9000-dxa split (lines 230–231), `tableCell`
    (line 247).
  - `packages/docx/src/image.ts` — SVG deferral throw (line 380),
    `embedSvg` (line 412), `svgBlip` emission in `inlineImageParagraph`
    (lines 257–261), `resolveTargetSize` (line 159), `isSvg` (line 136),
    `relsPathFor` (line 510), `maxExistingDrawingId` (line 529),
    `ensureContentTypeDefault` (line 479 call site).
  - `packages/docx/src/export.ts` — `parseStyleNames` use (line 236),
    field instructions left literal (comment at line 871),
    `ensureCodeStyle` (line 895), `ensureUpdateFields` (line 908),
    `imageSeam` (line 644), `diagramSeam` (line 713).
  - `packages/docx/src/fixtures.ts` — `buildDocx`, `stylesXml`,
    `headingStyle`, `para`, `fldSimpleResult`, `complexFieldResult`,
    `readPart`, `pngFixtureBytes`.
  - Shared with the PDF pipeline: `packages/pdf/src/prepare.ts` —
    `validateResolvedAsset` SVG safety regexes (lines 46–66);
    `packages/pdf/src/serialize.ts` — column-width honoring with the 1.05
    spread threshold (line 213), content-based `inferredTableTracks`
    fallback for near-equal/absent widths (lines 159–192), and
    `tableGrid`/`tableColumns` (lines 730/737).
  - Barrel exports G4's shared SVG policy must reach: `packages/confluence/src/index.ts`
    (Node barrel, unrestricted) and `packages/confluence/src/index.browser.ts`
    (explicit isomorphic allowlist — new modules are invisible to browser
    builds until added here); `packages/pdf/src/index.browser.ts` already
    re-exports `prepare.ts`, so the browser PDF path inherits the shared
    policy transitively once the confluence barrels are updated.
  - Host wiring G4 depends on but does not own: `apps/cli/src/commands/export.ts`
    (rasterizer gating, lines 811–830) and `apps/cli/src/commands/export-internals.ts`
    (`mightContainMermaid`, lines 162–166) — Lane K/CLI owns this file
    nominally; see the Dependencies section for the coordination note.
  - Competitor convention reference: `spec/scroll-word-exporter-features.md`
    (§3 "Styling Capabilities") — the authoritative source for the real
    `Scroll List …` / `Scroll Table …` style-name convention used below.
  - `specs/export-expansion/BASELINE-DESIGN.md` §"B9 — Tabellen-Stilquelle
    (DOCX)" (lines 330–342) and `specs/export-expansion/007-pdf-template-settings/PLAN.md`'s
    "Follow-ups" section — B9 is explicitly deferred out of Lane P to land
    with this folder's column-width work (see the new G3 task below; 007
    now cross-references this folder's G3b task by name instead of
    describing B9 as unimplemented).

## Goal & user value

Make the DOCX engine's output behave like a document authored *in* Word, not
merely one that looks similar. Four packages, all inside the pure
`@atlcli/docx` engine (serializer + zip surgery), so every host that drives
`exportDocx` via `ExportEnv` (`packages/docx/src/env.ts`) — CLI and browser
extension today — gets them with zero host code:

- **G2 — native list numbering.** Today lists are literal marker runs
  (`•`, `1.`, ☑/☐) plus manual `w:ind` indentation. Users cannot restyle
  lists through template list styles, numbers are dead characters (no
  renumber/continue when editing), and screen readers see no list structure.
  Job to be done: "I export to Word to *keep working* there — lists must
  behave like Word lists."
- **G3 — table column widths.** Carefully tuned Confluence tables (narrow
  status column, wide description) arrive as an even 9000-dxa split, while
  the PDF export of the same page honors the widths — the two outputs
  contradict each other. The data (`ExportBlock.columnWidths`) is already
  captured; DOCX just drops it. Bundles B9 (table *style* source —
  `packages/docx/src/ooxml.ts` currently forces `TableGrid` + hard-coded
  borders, ignoring a template's house table style): BASELINE-DESIGN and
  PLAN 007 both name this folder, alongside the column-width work, as B9's
  landing spot.
- **G4 — SVG attachment embedding.** SVG attachments are currently rejected
  ("SVG images are not embedded yet (spec 005 deferral)") — architecture
  diagrams disappear from the exported document. The complete `svgBlip`
  path already exists for mermaid diagrams; reuse it so SVGs are
  vector-sharp in modern Word with a mandatory PNG fallback elsewhere.
- **G1 — StyleRef verification.** Templates conventionally put the current
  chapter heading into the running header via a `STYLEREF` field. We believe
  this already works (we emit template style ids, leave field instructions
  literal, and force field refresh), but it is unproven. This package is
  **test-only**: no engine feature, just a three-stage verification that
  makes the compatibility claim safe to publish.

## Dependencies

- **Folder 001 (block model / serializer merge order).** Sync point 0
  (T0.1/T0.2) lands the `ExportBlock` extensions and compiling no-op
  renderings in both engines first. G2/G3 build on the post-T0.2 shape of
  `packages/docx/src/serialize.ts`; G4 and G1 have no block-model
  dependency and can start immediately (UMSETZUNGSPLAN lists T1.15/T1.16
  as start-anytime).
- **Coordination with folder 003 on `serialize.ts`.** Folder 003
  (Lane C: compatibility macros, T1.5 engine rendering — page breaks,
  section orientation, captions) also edits
  `packages/docx/src/serialize.ts`. Per the lane header in
  UMSETZUNGSPLAN, Lane G starts after the 003 serializer changes merge,
  or rebases daily onto them. Merge order for the hot file:
  001 (T0.2) → 003 (T1.5) → 006 (G2/G3).
- **Internal order within this folder.** G1 first (its fixture/test
  infrastructure and `styles.xml` assertions are prerequisites for G2's
  style-mapping tests, and G2 touches `styles.xml`-adjacent parts).
  G3 + G2 land together in a single golden-recapture PR (break the golden
  only once). G4 is file-disjoint (image.ts + export.ts seam +
  a new shared module) and runs in parallel.
- **Cross-package move (G4).** Extracting the SVG safety policy into
  `@atlcli/confluence` touches `packages/pdf/src/prepare.ts` (import path
  only). Both packages already depend on `@atlcli/confluence`; run PDF
  tests and `bun run typecheck` alongside.
- **CLI host touch (G4).** `apps/cli/src/commands/export.ts` only builds a
  rasterizer when `mightContainMermaid()` matches (`export-internals.ts:162`);
  that gate knows nothing about SVG attachments, so a page with only an
  SVG image and no mermaid macro degrades in the CLI even though the engine
  now supports it — the "zero host code" claim in Goal & user value is false
  for this one seam. `apps/cli` is nominally Lane K's file, but the fix is a
  small, file-disjoint addition (a second detector function) that this
  folder's own G4 E2E test depends on to pass; land it as part of G4 and
  flag the ownership note to whoever runs Lane K (see `crossPlanImpacts`).

## Architecture

All four packages respect the engine's existing patterns:

- **Pure serializer, stateful allocation via context.** The serializer emits
  strings; anything that needs export-wide state (image relationship ids,
  and now numbering ids) lives in an allocator object threaded through
  `SerializeContext` — the established `ImageEmbedder` pattern. G2 adds a
  pure `NumberingAllocator` (new file `packages/docx/src/numbering.ts`).
- **Numbering inventory happens before serialization, not after.** The
  render pipeline in `exportDocx` (`export.ts:201`) already unzips the
  template and reads `word/styles.xml` (`styleNames`, line 236) *before*
  calling `serializeBlocks` (line 264) — `serializeBlocks` is where
  `ctx.numbering.acquire(...)` will run, so the `NumberingAllocator`'s base
  `{abstractNumId, numId}` must be known by then too. Mirror the
  `styleNames` pattern exactly: a pure `inspectNumberingPart(zip)` runs
  alongside `parseStyleNames` (before line 264), parses any existing
  `word/numbering.xml`'s `abstractNumId`/`numId` maxima into the allocator's
  base. The post-render `ensureNumberingPart(zip, allocator)` (in the
  `ensureCodeStyle` mold, line 895) only *writes* the part/content-type/rel
  using ids the allocator already handed out — it does not (re-)compute the
  base. This is a hard ordering requirement, not a style choice: a
  post-render-only max-scan would hand out ids the body already rendered
  with, with no way to reconcile them after the fact.
- **List nesting is tracked separately from generic block depth.** The
  serializer's `depth` counter (`serializeBlock`, `serialize.ts:342`,
  starting at 0 in `serializeBlocks`, line 333) is incremented by *every*
  container — callouts and blockquotes (`depth + 1`, lines 388/399) and,
  distinctly, reset to `1` for table cells (line 617) — and today feeds
  `serializeList`'s `level` parameter only for a *top-level* list block
  (`case "list": return serializeList(block, ctx, notes, depth)`, line 393).
  A list that is the first block inside a callout or a table cell therefore
  starts at `level 1`, not `0`, even though it is visually and semantically
  the list's own top level. G2 introduces a **separate** `listLevel` counter
  that starts at 0 for every list, independent of container depth: `depth`
  keeps governing indentation of non-list wrapper content, `listLevel`
  (used for `w:ilvl` and the `NumberingAllocator`) only increments when
  `serializeList` recurses into a nested `"list"` block
  (`serializeListItem`, line 537). Continuation blocks and non-list nested
  blocks inside an item keep using `depth`-derived visual indent as today.
- **`numId` is acquired per list-node, not per top-level list.** A single
  Confluence page routinely nests `<ul><ol>…</ol></ul>` or places two
  independent `<ol>`s side by side; the block model already models this
  correctly — every nesting level is its own `{ type: "list"; ordered;
  items }` node (`packages/confluence/src/export-blocks.ts:102-109`), and
  `serializeListItem`'s `block.type === "list"` branch already recurses per
  nested node (`serialize.ts:535-538`). `ctx.numbering.acquire(ordered)`
  therefore runs once per **list node** encountered (top-level or nested),
  not once for the outermost list with the id threaded unchanged through
  inner levels of a different type — a nested `<ol>` inside a `<ul>` must
  get its own decimal `numId`, or Word renders it with the outer bullet
  format. Two logically separate `<ol>`s at the same nesting position (not
  one continuing the other) each get their own `numId` for the same reason
  restart-per-list already requires (Architecture, "Word format limits"
  below).
- **Zip surgery after render.** Parts that must exist in the final package
  (`word/numbering.xml`, content-type overrides, relationships) are ensured
  post-render in `export.ts`, in the mold of `ensureCodeStyle` /
  `ensureUpdateFields`, reusing `ensureContentTypeDefault` and
  `relsPathFor` from `image.ts`. Existing template ids are respected by
  parsing the current maxima and allocating above them (the
  `maxExistingDrawingId` pattern) — see the numbering-inventory-ordering
  bullet above for *when* that parse must happen.
- **Template style-name chains.** Style resolution follows the
  `resolveHeadingStyleId` chain semantics: prefer the established template
  style-name convention, then the builtin names (`List Bullet` /
  `List Number`), then `ListParagraph`. **The real Scroll naming convention
  is asymmetric, not `<name> <level>` for every level**
  (`spec/scroll-word-exporter-features.md` §3, "List Styles"): level 1
  (`ilvl 0`) is **suffixless** — `Scroll List Bullet` / `Scroll List Number`
  — and only levels 2–8 (`ilvl 1–7`) carry a numeric suffix — `Scroll List
  Bullet 2`…`Scroll List Bullet 8`. `resolveListStyleId` must special-case
  `ilvl 0` to the suffixless name, matching real Scroll templates so they
  migrate without a rename. These are literal style *names* found in user
  templates, matched via `parseStyleNames` against `word/styles.xml`.
  Visual control (font, spacing) stays in the template; indent and number
  format live in the synthesized `w:lvl` definitions.
- **One SVG policy for both engines, validated in the representation that
  gets embedded.** The sanitizing regexes currently in
  `packages/pdf/src/prepare.ts` (`validateResolvedAsset`) become
  `assertSafeSvg(source)` in `packages/confluence/src/svg-safety.ts`; PDF
  and DOCX import the same function and produce the same error text. The
  policy is extended to reject CSS-carried external references (`url(...)`
  / `@import` inside `<style>` elements or `style="…"` attributes), not
  just element/attribute `href`s — today's regexes only cover
  `href`/`xlink:href` (`prepare.ts:60-62`). `assertSafeSvg` validates a
  decoded UTF-8 string; the DOCX seam must embed the **same** string it
  validated (re-encode it for `embedSvg`), not the original pre-decode
  byte buffer — otherwise a source with an encoding Word/the rasterizer
  interprets differently than `TextDecoder`'s UTF-8 assumption (a BOM, a
  declared non-UTF-8 `<?xml encoding=…?>`) could pass the check on one
  byte sequence and embed a different one. Exported from **both**
  `@atlcli/confluence` barrels (`index.ts` and `index.browser.ts`, see
  Reference) so the browser extension's PDF *and* DOCX paths both get it.
- **Rasterization is budget-bounded, not just width-capped.**
  `resolveTargetSize` (`image.ts:159`) caps `widthPx` against
  `MAX_CONTENT_WIDTH_PX` but never caps `heightPx`, aspect ratio, or total
  pixel count, and performs no finite/safe-integer check; Confluence's
  `ac:width`/`ac:height` accept any positive integer
  (`export-blocks.ts:629-643`, `parsePositiveInt`) and an SVG's own
  `viewBox`/`width`/`height` are equally unbounded author input. The
  browser canvas rasterizer allocates its canvas directly at the resolved
  size with no guard (`browser-runtime.ts:107-108`,
  `canvas.width = widthPx; canvas.height = heightPx`). G4's new SVG-from-
  attachment path is the first place untrusted author/attachment
  dimensions reach the rasterizer at all (mermaid diagram size is
  render-determined, not author-typed), so it is the first place this
  matters. A shared size-budget guard runs before every rasterizer call
  (mermaid and SVG-attachment alike): reject non-finite/non-safe-integer
  axes, cap height symmetrically with width, cap the total pixel count,
  and degrade with a stable note code instead of invoking the rasterizer
  when the budget is exceeded.
- **Word format limits, documented not discovered.** `w:ilvl` (the semantic
  `listLevel`, not the container `depth` — see above) is capped at 8
  (9 levels, ilvl 0–8): deeper Confluence nesting clamps to ilvl 8 and
  keeps only visual indentation. Word caps numbering definitions at 2047
  `w:num` instances per document; since we allocate above the template's
  existing maximum and each ordered list *node* (top-level or nested,
  restart boundary) consumes one instance (restart-at-1 semantics),
  roughly 2046 ordered-list nodes per export can get their own restart
  instance — beyond the cap the allocator reuses the last instance and
  emits a report note instead of producing an invalid file. Both limits
  are asserted in unit tests and stated in `docs/`.

## Tasks

### G2 native numbering (T1.13)

- [x] Create `packages/docx/src/numbering.ts`: pure `NumberingAllocator`
      constructed with a base `{ abstractNumId, numId }`. `acquire(ordered)`
      returns a shared `numId` for all bullet lists (bullets never need
      distinct restart instances) and a fresh `numId` **per ordered list
      node** — every `{ type: "list"; ordered: true }` block, whether
      top-level or nested inside another list item, gets its own call (with
      `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>` so each `<ol>`
      restarts at 1 — the Confluence behavior; without it Word numbers
      document-wide). `toXml()` yields one bullet `abstractNum`
      (`numFmt="bullet"`, symbol `lvlText`, Symbol `rFonts`) and one
      decimal `abstractNum` (decimal / lowerLetter / … cycle), each with 9
      `w:lvl` entries (ilvl 0–8, `w:ind w:left` stepping 720 dxa with 360
      hanging), plus the `w:num` instances. Enforce and test the limits:
      ilvl clamped at 8, `numId` allocation stops at Word's 2047-instance
      cap (~2046 usable above a fresh template) with a report-note
      degradation. The allocator's base is **not** self-determined —
      see the export.ts task below for where it comes from.
- [x] `packages/docx/src/export.ts`: add pure `inspectNumberingPart(zip):
      { abstractNumId: number; numId: number }` next to `parseStyleNames`
      (line 236) — same "run before body serialization" position, parsing
      any existing `word/numbering.xml`'s current `abstractNumId`/`numId`
      maxima (pattern: `maxExistingDrawingId`, `image.ts:529`) so the
      `NumberingAllocator` constructed before `serializeBlocks` (line 264)
      already has the correct base. This fixes an ordering gap: allocation
      happens *during* `serializeBlocks`, so basing it on a maxima scan
      that only happens in the post-render write step (below) would hand
      out ids the body was already serialized with.
- [x] `packages/docx/src/serialize.ts`: thread the allocator through
      `SerializeContext` (line 92). `serializeList` (line 504) calls
      `ctx.numbering.acquire(list.ordered)` **once per list node it
      serializes** — including nested list nodes reached through
      `serializeListItem`'s `block.type === "list"` recursion (line 535) —
      so a nested `<ol>` inside a `<ul>` (or a second, logically separate
      `<ol>` at the same position) gets its own `numId` matching its own
      `ordered` type, never the parent's; `serializeListItem` (line 519)
      replaces the literal marker run + `w:ind` indent with
      `<w:pPr><w:pStyle …/><w:numPr><w:ilvl w:val="N"/><w:numId w:val="…"/></w:numPr></w:pPr>`.
      `N` is the new **semantic `listLevel`** counter (Architecture, "List
      nesting is tracked separately from generic block depth") — it starts
      at 0 for every list and increments only across nested list recursion,
      never across callout/blockquote/table-cell container depth, so a
      list that happens to be the first block inside a callout or table
      cell still starts at `ilvl 0`. Continuation blocks of an item
      (second paragraph, code block) and nested non-list blocks (callout
      inside an item) get **no** `numPr`, only a level-matched `w:ind
      w:left` via the existing `addParagraphProps` (line 200). Items that
      start with a block that cannot carry a marker (`placeMarker` special
      case, line 215 — e.g. callout table first) get an empty numbered
      paragraph before the block. Task-list items keep the ☑/☐ rendering
      (Word has no native checkbox numbering) but adopt the resolved list
      paragraph style for consistent indentation.
- [x] `packages/docx/src/ooxml.ts`: add `resolveListStyleId(styleNames,
      ordered, ilvl)` next to `resolveHeadingStyleId` (line 46). The real
      Scroll naming convention is asymmetric (Architecture, "Template
      style-name chains"): `ilvl 0` → `scroll list bullet` /
      `scroll list number` (no suffix); `ilvl 1..7` → `scroll list bullet
      ${ilvl + 1}` / `scroll list number ${ilvl + 1}` (suffix 2..8); then
      the builtin fallback `list bullet` / `list number` → `ListParagraph`
      (case-insensitive name lookup against `parseStyleNames` output, id
      returned).
- [x] `packages/docx/src/export.ts`: post-render `ensureNumberingPart(zip,
      allocator)` in the `ensureCodeStyle` mold (line 895), run only when
      the allocator was actually used: (1) create `word/numbering.xml` or
      merge into an existing one, emitting the ids the allocator already
      handed out during body serialization (no re-basing — the maxima scan
      happened up front, see above); (2) register the content-type override
      (reuse/extend `ensureContentTypeDefault`, `image.ts`); (3) add the
      `numbering` relationship to `word/_rels/document.xml.rels`
      (`relsPathFor`, `image.ts:510`).
- [x] Recapture `packages/docx/src/golden-extension-export.json`
      (`golden.test.ts` breaks intentionally); document in the PR that the
      diff is exactly: list markup change + new `word/numbering.xml` part +
      relationship/content-type entries.
- [x] `docs/`: update the DOCX export feature guide — list style mapping
      table (template style names → behavior, including the suffixless
      level-1 name), the 9-level and ~2046-list limits, and the
      restart-per-list-node semantics.

### G3 column widths (T1.14)

`serializeTable` (`serialize.ts:568`) currently builds each row's cell XML
**inline**, in the same loop that discovers `gridCols` — a cell's XML string
exists before the final grid width is known
(`serialize.ts:583-660`, `rowCells: string[]` accumulated per row, `gridCols`
only reaching its final value via `Math.max` after the last row). Emitting a
per-cell `w:tcW` (which depends on the *final* `gridCols` and the width
array derived from it) is therefore not a drop-in addition to the existing
single pass — it requires deferring XML generation until widths are known.

- [x] `packages/docx/src/serialize.ts`: split `serializeTable` into a
      **layout phase** producing per-cell descriptors (`{ colStart, colspan,
      rowspan, kind: "source" | "carry" | "padding", …content }`) without
      emitting XML — this phase computes `gridCols` exactly as today — and a
      **render phase** that, once `gridCols` (and the width array from the
      task below) are final, calls `tableCell(...)` per descriptor.
      `hasCarryFrom`/colspan/rowspan bookkeeping logic is unchanged, only
      moved out of the XML-emitting loop.
- [x] Add budget guards in the layout phase, mirroring the confluence-side
      parse (`export-blocks.ts:610-612`, `parsePositiveInt` on `colspan`/
      `rowspan` currently accepts any positive integer with no upper
      bound): before allocating the `carry` array or looping
      `col += colspan`, reject non-finite/non-safe-integer or
      implausibly large `colspan`/`rowspan`/computed-`gridCols` values
      (stable caps, e.g. max 200 columns, max span 200) — degrade the
      offending row/cell with a report note instead of driving
      `Array.from({length: gridCols})` (`ooxml.ts:231`) or a carry-array
      write with an attacker- or malformed-content-controlled size.
- [x] `packages/docx/src/serialize.ts:396`: pass `block.columnWidths`
      (captured by `tableColumnWidths`,
      `packages/confluence/src/export-blocks.ts:511`, block field at
      line 108) into `serializeTable`.
- [x] In the render phase, add `columnWidthsDxa(columnWidths, gridCols)` —
      validate like the PDF side (length === gridCols, all finite and > 0,
      and apply the same 1.05 spread threshold as
      `packages/pdf/src/serialize.ts:213` so near-equal widths keep the
      clean even split); otherwise return `undefined` → even distribution,
      never a broken grid. Scale proportionally to the fixed 9000 dxa
      table width with rounding remainder corrected on the last column
      (sum exactly 9000). Duplicate the threshold logic with a
      cross-reference comment to the PDF implementation instead of
      introducing a shared layout package (documented DX trade-off from
      BASELINE-DESIGN §6 G3). **Parity scope, precisely stated**: PDF's
      `tableColumns` (`pdf/serialize.ts:159-192`) does not simply fall
      back to an even split below the 1.05 threshold — it tries
      `inferredTableTracks`, a content-length heuristic that can still
      widen a dominant narrative column for near-equal or absent source
      widths. DOCX's G3 does **not** port that heuristic (predictability
      over content-sniffing, matching the docx engine's existing
      philosophy of never reformatting from prose content). The DoD parity
      claim therefore covers **explicit, non-near-equal source column
      widths** only; near-equal/absent-width tables may legitimately
      render differently across engines — call this out as a documented
      divergence, not a bug, and add the cross-engine fixture below to
      pin it down.
- [x] `packages/docx/src/ooxml.ts`: extend `dataTable(gridCols, rowsXml,
      widthsDxa?)` (lines 230–231) — emit real `<w:gridCol w:w="…"/>`
      values in `w:tblGrid` and add `<w:tblLayout w:type="fixed"/>` to
      `tblPr` so Word does not re-autofit; extend `tableCell` (line 247)
      with `widthDxa?` emitting `<w:tcW w:w="…" w:type="dxa"/>` as the
      first `tcPr` child (schema order: `tcW` before `gridSpan`).
- [x] The render phase passes each cell descriptor the sum of its spanned
      `gridCol` widths (`widthsDxa[col..col+colspan)`), including
      vMerge-continue and padding cells, so the fixed layout is not
      "repaired" by Word.
- [x] Recapture goldens together with G2 (the fixture zoo contains tables;
      one recapture PR for both).

#### G3b table style source (B9)

Bundled here per BASELINE-DESIGN §6 ("Synergie mit G3 … im selben PR
lösen") and PLAN 007 lines 382–384 ("small package, lands with the
column-width work; … out of Lane P").

- [x] `packages/docx/src/ooxml.ts`: extend `dataTable(gridCols, rowsXml,
      opts)` (same call site as the widths change above) with
      `tableStyle?: { source: "template" | "confluence"; styleId?: string
      }`. `source: "confluence"` (default) keeps today's behavior
      unchanged — `w:tblStyle w:val="TableGrid"` + hard-coded
      `w:tblBorders` (`ooxml.ts:230-243`). `source: "template"` emits only
      `w:tblStyle w:val="${styleId}"` + `w:tblLook` (firstRow banding),
      omitting the inline borders and per-cell `w:shd` fills so a
      template's house table style actually controls appearance.
- [x] `ExportInput` (`export.ts`) gains `tableStyle?: { source; styleId? }`;
      resolve `styleId` against `word/styles.xml` via `parseStyleNames`
      (name `Scroll Table Normal` per `spec/scroll-word-exporter-features.md`
      §3, fallback to `TableGrid`/`source: "confluence"` with a report note
      when the named style is not defined in the template).
- [x] `serializeTable`'s render phase suppresses per-cell `w:shd`
      background fills (header shading, Confluence cell colors) when
      `tableStyle.source === "template"` — inline shading would otherwise
      override the template style exactly as it does for borders today.
- [ ] `scanZip`/`scanTemplate` (`scan.ts`) reports whether the configured
      table style name resolves in the template ("Template defines table
      style: Scroll Table Normal ✓" / missing → fallback note).
- [ ] Real Word-authored fixture template defining `Scroll Table Normal`;
      E2E/LibreOffice-and-Word acceptance that `source: "template"` tables
      pick up the template's borders/shading and `source: "confluence"`
      tables are byte-identical to pre-B9 output (no default-behavior
      regression).

### G4 SVG embedding (T1.15)

- [x] Extract the SVG safety policy: new
      `packages/confluence/src/svg-safety.ts` exporting
      `assertSafeSvg(source: string): void` with the regexes from
      `packages/pdf/src/prepare.ts:60-62` (`script`/`foreignObject`
      elements, `on*` event handlers, external `https?:`/`data:` hrefs)
      **plus** new regexes rejecting CSS-carried external references —
      `url(...)`/`@import` inside `<style>` element bodies or `style="…"`
      attribute values pointing at `https?:`/`data:` — and the single
      shared error text ("SVG contains active or externally loaded
      content"). Rewire `validateResolvedAsset` in `packages/pdf/src/prepare.ts`
      to import it. Export from **both** `packages/confluence/src/index.ts`
      and `packages/confluence/src/index.browser.ts` (the browser barrel is
      an explicit allowlist — omitting it here breaks the extension's
      browser build silently until `check:browser` catches it, which is
      exactly the check added to DoD below).
- [x] `packages/docx/src/image.ts`: add pure `parseSvgSize(source)` —
      width/height attributes from the opening `<svg>` tag (px or
      unitless), viewBox fallback, `null` when undeterminable (per the
      BASELINE-DESIGN §6 G4 sketch).
- [x] `packages/docx/src/image.ts`: add a pure `boundRasterTarget(size:
      TargetSize): TargetSize | null` guard used by both the mermaid and
      new SVG-attachment rasterizer calls — `resolveTargetSize` (line 159)
      caps only `widthPx`; this guard additionally rejects
      non-finite/non-safe-integer axes, caps `heightPx` symmetrically with
      `MAX_CONTENT_WIDTH_PX`, and caps total pixel count
      (`widthPx * heightPx`), returning `null` when the budget is
      exceeded (Architecture, "Rasterization is budget-bounded"). Wire it
      into `diagramSeam` (line 713) as well as the new SVG path below —
      not SVG-only, since author-supplied `block.width/height`
      (`export-blocks.ts:109`, `ac:width`/`ac:height`, unbounded positive
      integers) already flow into mermaid's `resolveTargetSize` call too.
- [x] `packages/docx/src/export.ts`: pass the rasterizer into `imageSeam`
      (line 644; today only `diagramSeam` gets it). In the seam, after the
      asset fetch and before `embedder.embed`: if `isSvg(bytes)` — without
      a rasterizer degrade with new note code `image-svg-no-rasterizer`
      (replacing the generic embed failure); otherwise decode to a
      canonical UTF-8 `source` string, call `assertSafeSvg(source)`, size
      via `parseSvgSize` with a 600×400 fallback plus an info note when the
      fallback is used, run author dimensions (`block.width/height`,
      `export-blocks.ts:109`) through `resolveTargetSize` (`image.ts:159`)
      then `boundRasterTarget` — oversized results degrade with note code
      `image-svg-oversized` instead of calling the rasterizer — rasterize
      the PNG fallback at 2×, and call `embedder.embedSvg(source, png,
      { alt, name, widthPx, heightPx, origin: "image" })` (`image.ts:412`,
      see the typed-outcome task below). **Pass the validated `source`
      string, not the original pre-decode `bytes`** — `embedSvg` must embed
      exactly what `assertSafeSvg` checked (Architecture, "One SVG policy
      for both engines"). Remove the deferral throw at `image.ts:380` for
      this path.
- [x] Typed SVG outcome + accurate counters: `embedSvg` (`image.ts:412`)
      currently always increments `diagramsEmbedded` regardless of caller,
      so an attachment SVG embedded via this new path would silently count
      toward `renderedDiagrams` — contradicting the reporting task below,
      which requires it to count as `embeddedImages`. Give `embedSvg` (or a
      thin `embedSvgImage` wrapper reusing its internals) an
      `origin: "image" | "diagram"` option that increments `embeddedCount`
      for `"image"` and `diagramsEmbedded` for `"diagram"` (mermaid's
      existing call site passes `"diagram"`, unchanged behavior). Add
      `image-svg-no-rasterizer` and `image-svg-oversized` to
      `IMAGE_SKIP_CODES` (`export.ts:423-430`) so they count toward
      `skippedImages` in the report — today only `image-embed-failed`
      (a generic code this new path was going to reuse) is covered.
- [x] Reporting: SVG-from-attachment embeds count as `embeddedImages` (it
      is an image, not a rendered diagram); success is silent, only
      degradations produce notes. DoD-testable: a page with one mermaid
      diagram, one successfully-embedded SVG attachment, and one SVG
      attachment with no rasterizer available yields exactly
      `renderedDiagrams=1`, `embeddedImages=1`, `skippedImages=1`.
- [x] CLI host gap: `apps/cli/src/commands/export.ts` only builds a
      rasterizer when `mightContainMermaid(details.storage)` matches
      (lines 811-829; the gate itself, `export-internals.ts:162-166`, only
      pattern-matches the mermaid macro's `ac:parameter name="language"`).
      A page with an SVG attachment and no mermaid macro therefore exports
      through the CLI with `rasterizer: undefined`, degrading with
      `image-svg-no-rasterizer` even though a rasterizer is available and
      would succeed. Extend the CLI's pre-scan with a second, conservative
      detector (e.g. `mightReferenceImage`/`mightNeedRasterizer` in
      `export-internals.ts`, matching any `<ac:image>`/attachment
      reference — cheap and deliberately over-triggering is fine, the
      rasterizer build is the optimization being protected) and build the
      rasterizer when *either* detector matches. This is the one change in
      G4 outside `packages/docx`; see Dependencies for the Lane K
      ownership note.
- [x] `docs/`: note host constraints (browser canvas rasterizer does not
      load external fonts referenced by the SVG — same limitation as
      mermaid today; LibreOffice and older Word render the PNG fallback).

### G1 StyleRef verification (T1.16) — test-only package

- [x] Stage 1, unit invariants: new `packages/docx/src/styleref.test.ts`
      using the fixture builders (`fixtures.ts`: `buildDocx`, `stylesXml`,
      `headingStyle`, `para`, `fldSimpleResult`, `complexFieldResult`).
      Build a template whose `word/header1.xml` contains
      `w:fldSimple w:instr=" STYLEREF "Scroll Heading 1" \* MERGEFORMAT "`
      with a stale result run; export via `exportDocx`; assert with PizZip:
      (1) the field instruction survives preprocessing + docxtemplater
      byte-exactly (`export.ts:871` leaves instructions literal),
      (2) `word/document.xml` headings carry the exact `w:pStyle` id whose
      style *name* the field references (`resolveHeadingStyleId`,
      `ooxml.ts:46`, against `parseStyleNames`, `export.ts:236`),
      (3) `word/settings.xml` contains `<w:updateFields w:val="true"/>`
      (`ensureUpdateFields`, `export.ts:908`). Cover both `fldSimple` and
      complex-field (`w:instrText`) forms, and a heading-promotion case
      (`computeHeadingOffset`, `serialize.ts:243`): a STYLEREF on
      "Scroll Heading 2" must be flagged when promotion can leave it
      dangling.
- [x] Name-vs-id trap, two distinct failure modes: extend
      `packages/docx/src/scan.ts` with a field inventory that only
      *records* each STYLEREF field's referenced style name — it must not
      decide pass/fail itself, because `scanZip` (`export.ts:216`) runs
      before `storageToBlocks`/`serializeBlocks` (`export.ts:264`) and so
      has no visibility into which heading styles the *page's own content*
      will actually emit after promotion (`computeHeadingOffset`,
      `serialize.ts:243`, shifts every heading's effective level by a
      document-wide offset — a template field naming "Scroll Heading 2"
      can end up referencing a style no heading in this particular export
      ever uses, even though the template defines the style). Validate the
      inventory in `exportDocx` (`export.ts`) **after** `serializeBlocks`
      returns, against the set of heading style ids the body actually
      emitted (`resolveHeadingStyleId` outputs, collected alongside the
      existing `body.xml` heading-style writes in `serialize.ts:361`).
      Two codes: `styleref-style-not-in-template` (`level: "info"` — the
      named style doesn't exist in `word/styles.xml` at all; covers the
      builtin-fallback case, `HeadingN` without a defined "Heading 1"
      style, localized Word names) and `styleref-style-unused-in-export`
      (`level: "warning"` — the style exists but promotion means no
      heading in this export ever carries it, so the field will resolve to
      the *previous* section's text or blank rather than "stale" per se).
      Cover complex fields whose instruction text is split across multiple
      `w:instrText` runs (not just single `fldSimple`/`w:instrText`
      elements) — same byte-preservation guarantee, but the inventory scan
      must reassemble run-split instruction text before matching the
      `STYLEREF "…"` pattern. This is diagnostics-only (report notes, no
      behavior change) but touches both `scan.ts` (inventory) and
      `export.ts` (validation) — not `scan.ts` alone.
- [ ] Check in a real Word-authored golden fixture template with STYLEREF
      in `header1.xml` under
      `packages/docx/test-fixtures/styleref-template.docx`; add a unit
      test exporting through it.
- [ ] Stage 2, LibreOffice render smoke (CI task): script that exports the
      fixture, runs `soffice --headless --convert-to pdf out.docx`,
      extracts text with `pdftotext`, and asserts the H1 chapter text
      appears on page ≥ 2. Documented as a CI job (needs
      `libreoffice`/`poppler-utils` in the runner image); skipped locally
      when `soffice` is absent.
- [ ] Stage 3, one-time manual Word protocol per release train: open in
      Word 365, confirm the header shows the last H1 per page after field
      refresh; record the checklist in `docs/` troubleshooting ("header
      shows [stale chapter]" → F9 / reopen refresh).

### Tests (no mocking)

Never mock — all tests exercise the real engine against real zips, real
fixtures, real Confluence, or real LibreOffice.

- [x] Unit (OOXML assertions on generated zips via PizZip, following the
      existing patterns in `packages/docx/src/golden.test.ts` (structural
      zip comparison, `goldenTemplateBytes`), `packages/docx/src/serialize.test.ts`
      (per-block serializer describes), and `packages/docx/src/image.test.ts`
      (`ensureContentTypeDefault`, embed invariants)):
  - G2: snapshot of synthesized `word/numbering.xml`; regression "two
    separate `<ol>` both start at 1" (distinct `numId` + `startOverride`);
    **mixed-nesting table-driven cases**: `<ul><ol>…` and `<ol><ul>…` each
    assign the nested list node its own type-correct `numId` and `ilvl 1`
    (not the parent's `numId`); two logically separate nested `<ol>`s at
    the same item depth each get a distinct `numId` and both restart at 1;
    a list as the first block inside a callout and inside a table cell
    both start at `ilvl 0` (not polluted by container `depth`);
    merge-into-existing-numbering test (template with `word/numbering.xml`
    — allocator bases above existing ids, via `inspectNumberingPart` run
    *before* serialization, not the post-render step); sparse-id-space
    template (existing ids far below any max) and near-2047-id template
    both produce collision-free references; a fully-occupied id space
    degrades with the report-note fallback instead of an invalid file;
    ilvl-clamp at 8 for 10-level nesting; 2047-instance cap degradation
    note; style-chain test with a fixture template built via `buildDocx` +
    `stylesXml` defining suffixless "Scroll List Bullet" (level 1) and
    "Scroll List Bullet 2".."Scroll List Bullet 8" (levels 2-8, table-driven
    over all nine levels, bullet and number) → `w:pStyle` uses their ids
    per level; fallback template without them → `ListParagraph`.
  - G3: ratios `[100, 300]` → `gridCol` 2250/6750 (mirror the PDF fixture
    numbers from `packages/pdf/src/serialize.test.ts:115` for cross-engine
    consistency); length mismatch → even split; near-equal widths
    (226/226) → even split (1.05 threshold); colspan cell `tcW` equals the
    sum of spanned columns; `tblLayout fixed` present; a single fixture
    combining ragged rows, rowspan carries, colspans, and padding cells
    together (not each in isolation) to exercise the layout/render-phase
    split; `colspan`/`rowspan` at/above the safe-integer and column-count
    budget caps degrade with a report note instead of driving an
    oversized allocation. G3b (B9): `source: "confluence"` output
    byte-identical to pre-B9; `source: "template"` with a defined
    `Scroll Table Normal` emits the style reference and omits inline
    borders/shading; undefined style name falls back with a scan note.
  - G4: `parseSvgSize` (width/height, viewBox-only, neither); seam test
    "SVG attachment + rasterizer → `asvg:svgBlip` in document.xml + SVG
    part + PNG part"; negative "`<script>` SVG → note, archive untouched";
    negative CSS-carried reference (`<style>` `url(https://…)`, `style=`
    attribute `url(...)`) → note, archive untouched; "no rasterizer →
    `image-svg-no-rasterizer` note"; extreme `viewBox`/author-dimension
    fixtures (huge height with small width, non-finite/negative values)
    assert the rasterizer is never invoked and `image-svg-oversized` is
    reported; counters test — one mermaid diagram + one successful SVG
    attachment + one no-rasterizer SVG on the same page yields exactly
    `renderedDiagrams=1`, `embeddedImages=1`, `skippedImages=1`;
    shared-policy test that `@atlcli/pdf` and `@atlcli/docx` reject the
    same hostile SVG (including the new CSS-reference fixtures) with the
    same message; browser-barrel import test that `assertSafeSvg` is
    reachable from `@atlcli/confluence/browser`.
  - G1: the three invariants above plus the promotion case, now asserted
    against `exportDocx`'s post-serialize validation (not a scan-time
    template-only check): a template defining "Scroll Heading 2" whose
    page content never produces an effective-level-2 heading (e.g. only
    H1/H2 source headings, promotion collapses them to effective level 1)
    emits `styleref-style-unused-in-export`; a template missing the named
    style entirely emits `styleref-style-not-in-template`; a complex field
    whose `STYLEREF "…"` instruction text is split across multiple
    `w:instrText` runs is still matched.
- [ ] E2E (workflow rules: profile `mayflower`, space `DOCSY`): create one
      test page containing a nested mixed list (ordered/unordered/task,
      4+ levels deep, including a nested `<ol>` inside a `<ul>` item), a
      wide table with explicit column widths (narrow + wide columns), and
      an SVG attachment referenced as an image **with no mermaid macro on
      the page** — this specifically exercises the CLI rasterizer-gating
      fix above; without it this page would degrade the SVG in the CLI
      export even though the engine supports it. Export with
      `bun run --cwd apps/cli src/index.ts wiki export <page> --engine ts
      --template <fixture> --output <path>`; open the result with PizZip
      in the test script and assert: `word/numbering.xml` exists and
      document.xml uses `w:numPr` with correct per-node `ilvl`/`numId` for
      the mixed nesting; `w:tblGrid` widths are non-uniform and sum to
      9000; an `image…svg` part exists with a matching `asvg:svgBlip`
      reference and PNG sibling; **no `image-svg-no-rasterizer` note is
      present in the report** (the CLI built a rasterizer despite no
      mermaid macro). Delete the test page and attachment afterwards
      (cleanup discipline).
- [x] Cross-engine width-parity fixture (3–8 columns, near-equal source
      widths, one column with dominant narrative-length text): assert PDF
      and DOCX intentionally diverge per the documented G3 parity scope
      (PDF may apply `inferredTableTracks`; DOCX always even-splits below
      the 1.05 threshold) — locks in the divergence as a tested decision
      rather than an unverified claim.
- [ ] LibreOffice smoke: the G1 CI task above; additionally run the G2/G3
      E2E output through the same `soffice --headless --convert-to pdf` +
      `pdftotext` pipeline and assert list numbers ("1.", "a.") and table
      text appear — proves the file is consumable by a second
      implementation, not just schema-plausible.
- [ ] Run `bun run typecheck`, `bun run check:browser`, the PDF test suite
      (the `svg-safety` move touches `@atlcli/pdf`), and confirm the
      browser extension and `apps/browser-export-harness` still build (the
      `@atlcli/confluence` browser-barrel addition is exactly the kind of
      change `check:browser` exists to catch).

## Definition of Done

- Lists in exported DOCX use `w:numPr` + synthesized `word/numbering.xml`;
  every ordered list *node* (top-level or nested, including two logically
  separate nested `<ol>`s) restarts at 1 with its own `numId`; `ilvl`
  reflects true list-nesting depth, unaffected by enclosing
  callout/blockquote/table-cell container depth; template list styles
  follow the real, asymmetric Scroll naming convention (suffixless level 1,
  numeric suffix for levels 2-8) and are honored when present; task lists
  keep checkbox glyphs with consistent indentation; the `NumberingAllocator`
  bases its ids on a template numbering-part scan performed *before* body
  serialization; limits (9 levels, ~2046 ordered-list-node instances)
  enforced with report notes and documented.
- Tables emit real `w:tblGrid`/`w:gridCol` and per-cell `w:tcW` from
  `columnWidths` via a layout/render two-pass build, proportionally scaled
  to 9000 dxa with `tblLayout fixed`; invalid or near-uniform widths fall
  back to the even split; oversized `colspan`/`rowspan`/column-count inputs
  degrade with a report note instead of driving unbounded allocation; DOCX
  and PDF agree on the same fixture **for explicit, non-near-equal source
  widths** — near-equal/absent-width divergence (PDF's content-based
  inference vs. DOCX's even split) is a documented, tested decision, not a
  parity claim. B9 table style source lands in the same PR: `tableStyle:
  { source: "template" | "confluence" }` resolves `Scroll Table Normal`
  (or a configured style) with template borders/shading honored in
  `"template"` mode and today's behavior unchanged as the `"confluence"`
  default.
- SVG attachments embed via the existing `svgBlip` dual-part path
  (SVG + 2× PNG fallback), guarded by the sanitizer now shared with the
  PDF pipeline (extended to CSS-carried external references, and
  validated against the same string representation that gets embedded,
  not a separately-decoded copy) and by a shared rasterization size
  budget (finite/safe-integer axes, height cap, total-pixel cap) applied
  to both the mermaid and SVG-attachment paths; hosts without a rasterizer
  degrade with a precise note; the CLI builds a rasterizer for SVG-only
  pages, not just mermaid pages, closing the CLI/extension behavior gap;
  the shared policy is exported from both `@atlcli/confluence` barrels and
  `bun run check:browser` plus the extension/harness builds are green;
  counters are exact (`embeddedImages`/`renderedDiagrams`/`skippedImages`)
  for a page mixing a diagram, a successful SVG attachment, and a
  no-rasterizer SVG attachment.
- StyleRef verified at all three stages: unit invariants green,
  LibreOffice smoke wired into CI, manual Word protocol executed once and
  recorded in `docs/`; the field inventory (scan-time) and its validation
  against actually-emitted heading styles (post-serialize, in `exportDocx`)
  are both implemented, distinguishing "style not in template" from
  "style in template but unused after promotion in this export."
- Goldens recaptured exactly once (G2+G3 PR) with a documented diff;
  all new behavior has regression tests; E2E resources in `DOCSY` cleaned
  up; `bun run typecheck` and full `bun test` green; `docs/` updated in
  the same PRs (docs are first-class).

## Risks & open questions

- **Golden recapture is the expensive part of G2/G3** — an intentional
  break. Mitigation: single combined recapture PR, diff reviewed
  part-by-part.
- **LibreOffice computes STYLEREF differently from Word** (known deviations
  with column layouts): the soffice smoke is necessary but not sufficient
  evidence; final truth remains the manual Word protocol.
- **Heading promotion vs. STYLEREF**: a template field referencing
  "Scroll Heading 2" can dangle after promotion (`computeHeadingOffset`).
  Resolved (no longer open): validated post-serialize against actually
  emitted heading styles, `warning`-level note
  (`styleref-style-unused-in-export`) since promotion is always active
  when it applies — distinct from the `info`-level
  `styleref-style-not-in-template` case, where the template itself is
  incomplete rather than the export's particular content.
- **`w:tblLayout fixed` clips very long unbreakable content** (URLs)
  instead of stretching — accepted, matches Confluence's own behavior.
- **Percent colgroups**: `parseColumnWidth` treats `%` as a proportional
  weight; emitting `w:type="pct"` is unnecessary since proportional
  scaling covers it — revisit only if user reports differ.
- **`data:` hrefs in SVGs** are rejected by the shared policy even though
  embedded raster images inside SVGs are legitimate. Any relaxation
  (allow `data:image/png;base64` only) must land in `svg-safety.ts` for
  **both** engines, as a follow-up decision — not unilaterally.
- **SVGs sized via CSS `style` attributes or `em` units** fall back to
  viewBox/default sizing with an info note — deliberately simple.
- **Open (G2)**: should checkbox items also map to a template task-list
  style name if one exists, beyond `ListParagraph`? Default: no, until a
  real template convention shows up.
- **Coordination risk**: if folder 003's `serialize.ts` changes slip, G2/G3
  must rebase rather than block — the lane owns the file after T1.5 lands.
- **CLI SVG-detection heuristic (G4) is over-triggering by design**: the
  new `mightReferenceImage`-style detector matches any attachment/image
  reference, not just SVG, so the CLI will sometimes build a rasterizer it
  ends up not needing. Accepted — the alternative (parsing storage XML
  deeply enough to know an attachment's file extension before fetching it)
  is not worth the complexity for what stays a cheap, overlappable
  pre-scan; a false negative (rasterizer not built when actually needed)
  is the failure mode worth avoiding, not a false positive.
- **Table budget caps (G3) may truncate exotic real-world tables**: the
  `colspan`/`rowspan`/column-count caps are chosen conservatively (well
  above any plausible authored table) specifically to catch malformed or
  pathological content, not to constrain normal Confluence usage — if a
  real page ever hits the cap, treat it as a signal to raise the constant
  and add a regression fixture, not as expected behavior.
- **Numbering-inventory ordering (G2) depends on an early, best-effort
  zip parse**: if `word/numbering.xml` in the template is malformed,
  `inspectNumberingPart` must degrade to "no existing part" (allocator
  base at a safe default) rather than throw — a broken template numbering
  part must not block the whole export, matching this codebase's existing
  "never let template-scan issues become fatal" posture elsewhere in
  `export.ts`.
