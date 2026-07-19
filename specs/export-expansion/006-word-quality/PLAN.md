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
    spread threshold (line 213) and `tableGrid`/`tableColumns`
    (lines 730/737).

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
  captured; DOCX just drops it.
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

## Architecture

All four packages respect the engine's existing patterns:

- **Pure serializer, stateful allocation via context.** The serializer emits
  strings; anything that needs export-wide state (image relationship ids,
  and now numbering ids) lives in an allocator object threaded through
  `SerializeContext` — the established `ImageEmbedder` pattern. G2 adds a
  pure `NumberingAllocator` (new file `packages/docx/src/numbering.ts`).
- **Zip surgery after render.** Parts that must exist in the final package
  (`word/numbering.xml`, content-type overrides, relationships) are ensured
  post-render in `export.ts`, in the mold of `ensureCodeStyle` /
  `ensureUpdateFields`, reusing `ensureContentTypeDefault` and
  `relsPathFor` from `image.ts`. Existing template ids are respected by
  parsing the current maxima and allocating above them (the
  `maxExistingDrawingId` pattern).
- **Template style-name chains.** Style resolution follows the
  `resolveHeadingStyleId` chain semantics: prefer the established template
  style-name convention (`Scroll List Bullet <level>` /
  `Scroll List Number <level>` — these are literal style *names* found in
  user templates, matched via `parseStyleNames` against `word/styles.xml`),
  then the builtin names (`List Bullet` / `List Number`), then
  `ListParagraph`. Visual control (font, spacing) stays in the template;
  indent and number format live in the synthesized `w:lvl` definitions.
- **One SVG policy for both engines.** The sanitizing regexes currently in
  `packages/pdf/src/prepare.ts` (`validateResolvedAsset`) become
  `assertSafeSvg(source)` in `packages/confluence/src/svg-safety.ts`; PDF
  and DOCX import the same function and produce the same error text.
- **Word format limits, documented not discovered.** `w:ilvl` is capped at
  8 (9 levels, ilvl 0–8): deeper Confluence nesting clamps to ilvl 8 and
  keeps only visual indentation. Word caps numbering definitions at 2047
  `w:num` instances per document; since we allocate above the template's
  existing maximum and each top-level ordered list consumes one instance
  (restart-at-1 semantics), roughly 2046 ordered lists per export can get
  their own restart instance — beyond the cap the allocator reuses the last
  instance and emits a report note instead of producing an invalid file.
  Both limits are asserted in unit tests and stated in `docs/`.

## Tasks

### G2 native numbering (T1.13)

- [ ] Create `packages/docx/src/numbering.ts`: pure `NumberingAllocator`
      constructed with a base `{ abstractNumId, numId }` above the template
      maxima. `acquire(ordered)` returns a shared `numId` for all bullet
      lists and a fresh `numId` **per top-level ordered list** (with
      `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>` so each
      `<ol>` restarts at 1 — the Confluence behavior; without it Word
      numbers document-wide). `toXml()` yields one bullet `abstractNum`
      (`numFmt="bullet"`, symbol `lvlText`, Symbol `rFonts`) and one
      decimal `abstractNum` (decimal / lowerLetter / … cycle), each with 9
      `w:lvl` entries (ilvl 0–8, `w:ind w:left` stepping 720 dxa with 360
      hanging), plus the `w:num` instances. Enforce and test the limits:
      ilvl clamped at 8, `numId` allocation stops at Word's 2047-instance
      cap (~2046 usable above a fresh template) with a report-note
      degradation.
- [ ] `packages/docx/src/serialize.ts`: thread the allocator through
      `SerializeContext` (line 92). `serializeList` (line 504) calls
      `ctx.numbering.acquire(list.ordered)` once per top-level list and
      passes the `numId` down all levels; `serializeListItem` (line 519)
      replaces the literal marker run + `w:ind` indent with
      `<w:pPr><w:pStyle …/><w:numPr><w:ilvl w:val="N"/><w:numId w:val="…"/></w:numPr></w:pPr>`.
      Continuation blocks of an item (second paragraph, code block) and
      nested non-list blocks (callout inside an item) get **no** `numPr`,
      only a level-matched `w:ind w:left` via the existing
      `addParagraphProps` (line 200). Items that start with a block that
      cannot carry a marker (`placeMarker` special case, line 215 — e.g.
      callout table first) get an empty numbered paragraph before the
      block. Task-list items keep the ☑/☐ rendering (Word has no native
      checkbox numbering) but adopt the resolved list paragraph style for
      consistent indentation.
- [ ] `packages/docx/src/ooxml.ts`: add `resolveListStyleId(styleNames,
      ordered, level)` next to `resolveHeadingStyleId` (line 46), chain:
      `scroll list bullet <level>` / `scroll list number <level>` →
      `list bullet` / `list number` → `ListParagraph` (case-insensitive
      name lookup against `parseStyleNames` output, id returned).
- [ ] `packages/docx/src/export.ts`: post-render `ensureNumberingPart(zip,
      allocator)` in the `ensureCodeStyle` mold (line 895): (1) create
      `word/numbering.xml` or merge into an existing one — parse existing
      `abstractNumId`/`numId` maxima first and base the allocator above
      them (pattern: `maxExistingDrawingId`, `image.ts:529`); (2) register
      the content-type override (reuse/extend `ensureContentTypeDefault`,
      `image.ts`); (3) add the `numbering` relationship to
      `word/_rels/document.xml.rels` (`relsPathFor`, `image.ts:510`).
      Only run when the allocator was actually used.
- [ ] Recapture `packages/docx/src/golden-extension-export.json`
      (`golden.test.ts` breaks intentionally); document in the PR that the
      diff is exactly: list markup change + new `word/numbering.xml` part +
      relationship/content-type entries.
- [ ] `docs/`: update the DOCX export feature guide — list style mapping
      table (template style names → behavior), the 9-level and ~2046-list
      limits, and the restart-per-list semantics.

### G3 column widths (T1.14)

- [ ] `packages/docx/src/serialize.ts:396`: pass `block.columnWidths`
      (captured by `tableColumnWidths`,
      `packages/confluence/src/export-blocks.ts:511`, block field at
      line 108) into `serializeTable` (line 568).
- [ ] `serializeTable`: after grid-column computation, add
      `columnWidthsDxa(columnWidths, gridCols)` — validate like the PDF
      side (length === gridCols, all finite and > 0, and apply the same
      1.05 spread threshold as `packages/pdf/src/serialize.ts:213` so
      near-equal widths keep the clean even split); otherwise return
      `undefined` → even distribution, never a broken grid. Scale
      proportionally to the fixed 9000 dxa table width with rounding
      remainder corrected on the last column (sum exactly 9000).
      Duplicate the threshold logic with a cross-reference comment to the
      PDF implementation instead of introducing a shared layout package
      (documented DX trade-off from BASELINE-DESIGN §6 G3).
- [ ] `packages/docx/src/ooxml.ts`: extend `dataTable(gridCols, rowsXml,
      widthsDxa?)` (lines 230–231) — emit real `<w:gridCol w:w="…"/>`
      values in `w:tblGrid` and add `<w:tblLayout w:type="fixed"/>` to
      `tblPr` so Word does not re-autofit; extend `tableCell` (line 247)
      with `widthDxa?` emitting `<w:tcW w:w="…" w:type="dxa"/>` as the
      first `tcPr` child (schema order: `tcW` before `gridSpan`).
- [ ] `serializeTable` passes each cell the sum of its spanned
      `gridCol` widths (`widthsDxa[col..col+colspan)`), including
      vMerge-continue and padding cells, so the fixed layout is not
      "repaired" by Word. `hasCarryFrom`/colspan logic stays untouched —
      widths are purely additive properties.
- [ ] Recapture goldens together with G2 (the fixture zoo contains tables;
      one recapture PR for both).

### G4 SVG embedding (T1.15)

- [ ] Extract the SVG safety policy: new
      `packages/confluence/src/svg-safety.ts` exporting
      `assertSafeSvg(source: string): void` with the regexes from
      `packages/pdf/src/prepare.ts:60-62` (`script`/`foreignObject`
      elements, `on*` event handlers, external `https?:`/`data:` hrefs)
      and the single shared error text ("SVG contains active or externally
      loaded content"). Rewire `validateResolvedAsset` in
      `packages/pdf/src/prepare.ts` to import it; export from the
      `@atlcli/confluence` index.
- [ ] `packages/docx/src/image.ts`: add pure `parseSvgSize(source)` —
      width/height attributes from the opening `<svg>` tag (px or
      unitless), viewBox fallback, `null` when undeterminable (per the
      BASELINE-DESIGN §6 G4 sketch).
- [ ] `packages/docx/src/export.ts`: pass the rasterizer into `imageSeam`
      (line 644; today only `diagramSeam` gets it). In the seam, after the
      asset fetch and before `embedder.embed`: if `isSvg(bytes)` — without
      a rasterizer degrade with new note code `image-svg-no-rasterizer`
      (replacing the generic embed failure); otherwise decode, call
      `assertSafeSvg`, size via `parseSvgSize` with a 600×400 fallback plus
      an info note when the fallback is used, run author dimensions
      (`block.width/height`, `export-blocks.ts:109`) through
      `resolveTargetSize` (`image.ts:159`), rasterize the PNG fallback at
      2×, and call `embedder.embedSvg(bytes, png, { alt, name, widthPx,
      heightPx })` (`image.ts:412`). Remove the deferral throw at
      `image.ts:380` for this path. `embedSvg` itself needs no change —
      dedup, relationship management, and the "no archive write before
      validation" invariant (spec 004 F3) already hold.
- [ ] Reporting: count these as `embeddedImages` (it is an image, not a
      rendered diagram); success is silent, only degradations produce
      notes.
- [ ] `docs/`: note host constraints (browser canvas rasterizer does not
      load external fonts referenced by the SVG — same limitation as
      mermaid today; LibreOffice and older Word render the PNG fallback).

### G1 StyleRef verification (T1.16) — test-only package

- [ ] Stage 1, unit invariants: new `packages/docx/src/styleref.test.ts`
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
- [ ] Name-vs-id trap: extend `packages/docx/src/scan.ts` with a field
      inventory, and emit report note `styleref-fallback-style`
      (`level: "info"`) when a STYLEREF field names a style that
      `parseStyleNames` does not find in the template — covers the
      builtin-fallback case (`HeadingN` without a defined "Heading 1"
      style; localized Word names) with progressive disclosure instead of
      a silently stale header. This is the only production-code touch in
      G1 and it is diagnostics-only.
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

- [ ] Unit (OOXML assertions on generated zips via PizZip, following the
      existing patterns in `packages/docx/src/golden.test.ts` (structural
      zip comparison, `goldenTemplateBytes`), `packages/docx/src/serialize.test.ts`
      (per-block serializer describes), and `packages/docx/src/image.test.ts`
      (`ensureContentTypeDefault`, embed invariants)):
  - G2: snapshot of synthesized `word/numbering.xml`; regression "two
    separate `<ol>` both start at 1" (distinct `numId` + `startOverride`);
    merge-into-existing-numbering test (template with `word/numbering.xml`
    — allocator bases above existing ids); ilvl-clamp at 8 for 10-level
    nesting; 2047-instance cap degradation note; style-chain test with a
    fixture template built via `buildDocx` + `stylesXml` defining
    "Scroll List Bullet" / "Scroll List Number" styles → `w:pStyle` uses
    their ids; fallback template without them → `ListParagraph`.
  - G3: ratios `[100, 300]` → `gridCol` 2250/6750 (mirror the PDF fixture
    numbers from `packages/pdf/src/serialize.test.ts:115` for cross-engine
    consistency); length mismatch → even split; near-equal widths
    (226/226) → even split (1.05 threshold); colspan cell `tcW` equals the
    sum of spanned columns; `tblLayout fixed` present.
  - G4: `parseSvgSize` (width/height, viewBox-only, neither); seam test
    "SVG attachment + rasterizer → `asvg:svgBlip` in document.xml + SVG
    part + PNG part"; negative "`<script>` SVG → note, archive untouched";
    "no rasterizer → `image-svg-no-rasterizer` note"; shared-policy test
    that `@atlcli/pdf` and `@atlcli/docx` reject the same hostile SVG with
    the same message.
  - G1: the three invariants above plus the promotion case.
- [ ] E2E (workflow rules: profile `mayflower`, space `DOCSY`): create one
      test page containing a nested mixed list (ordered/unordered/task,
      4+ levels deep), a wide table with explicit column widths (narrow +
      wide columns), and an SVG attachment referenced as an image. Export
      with `bun run --cwd apps/cli src/index.ts wiki export <page>
      --engine ts --template <fixture> --output <path>`; open the result
      with PizZip in the test script and assert: `word/numbering.xml`
      exists and document.xml uses `w:numPr`; `w:tblGrid` widths are
      non-uniform and sum to 9000; an `image…svg` part exists with a
      matching `asvg:svgBlip` reference and PNG sibling. Delete the test
      page and attachment afterwards (cleanup discipline).
- [ ] LibreOffice smoke: the G1 CI task above; additionally run the G2/G3
      E2E output through the same `soffice --headless --convert-to pdf` +
      `pdftotext` pipeline and assert list numbers ("1.", "a.") and table
      text appear — proves the file is consumable by a second
      implementation, not just schema-plausible.
- [ ] Run `bun run typecheck` and the PDF test suite (the
      `svg-safety` move touches `@atlcli/pdf`).

## Definition of Done

- Lists in exported DOCX use `w:numPr` + synthesized `word/numbering.xml`;
  each ordered list restarts at 1; template list styles (per the
  established `Scroll List …` style-name convention) are honored when
  present; task lists keep checkbox glyphs with consistent indentation;
  limits (9 levels, ~2046 ordered-list instances) enforced with report
  notes and documented.
- Tables emit real `w:tblGrid`/`w:gridCol` and per-cell `w:tcW` from
  `columnWidths`, proportionally scaled to 9000 dxa with `tblLayout fixed`;
  invalid or near-uniform widths fall back to the even split; DOCX and PDF
  agree on the same fixture.
- SVG attachments embed via the existing `svgBlip` dual-part path
  (SVG + 2× PNG fallback), guarded by the sanitizer now shared with the
  PDF pipeline; hosts without a rasterizer degrade with a precise note.
- StyleRef verified at all three stages: unit invariants green,
  LibreOffice smoke wired into CI, manual Word protocol executed once and
  recorded in `docs/`; `styleref-fallback-style` scan note implemented.
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
  Covered by a test plus the scan note; open whether the note should be
  `warning` instead of `info` when promotion is actually active.
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
