# DOCX Export (Headline) — Customer Word Template + Scroll Placeholder Compatibility

Status: **In progress — Task 7 (user E2E) is the only open gate** (2026-07-16). Tasks 1–5 implemented and merged to `main` in `40953db` (bundled into PR #30, whose title names only specs 002/003 — the DOCX engine lives in `apps/extension/utils/docx/`). Task 6 closed as **descoped with the fallback pinned** (see F2). Repo gates green on 2026-07-16: 1507 tests, typecheck, `check:browser` (5 isomorphic entrypoints), `check:extension-output`. Decisions: F1 ✅ docxtemplater free · F3 ✅ images deferred → spec 005 · F2 ⏸ mermaid deferred → after 005, awaiting ratification.

Spec ID: `004-docx-export`
Depends on: `003-page-detection-read-path` · `001-browser-ready-core` Task 8 (`specs/001-browser-ready-core/scroll-placeholder-mapping.md` — the normative placeholder table)
Related strategy: FAHRPLAN Phase 1 Task 1.3 · `TYPST-EXPORT-ANGLE.md` §2b, §7.5 Schritt 3 · `EXPORT-QUALITY-ANGLE.md` §2 (Word ceiling), §7 (quality proofs)
Origin: FAHRPLAN Phase 1 — "DOCX-Export (Headline)"

---

## 1. Overview

The headline feature: export the detected Confluence page to Word using a
**customer-provided .docx template**, with **Scroll Word Exporter placeholder
compatibility** so existing Scroll customers reuse their templates unchanged. Pure JS in
the side panel (no WASM, no offscreen document needed — templating libs are plain JS).

Two deliverables interleave:

1. **The engine spike (DONE — decision made):** `docx-templates` (MIT) vs
   `docxtemplater` (free). **Outcome (2026-07-16):** `docx-templates` is ruled out for the
   side-panel context — it evaluates template JS via `new Function`/`eval`, which our
   MV3 CSP (`script-src 'self' 'wasm-unsafe-eval'`, no `'unsafe-eval'`, verified against
   the built manifest) forbids; its MIT-native image support is itself an eval-gated
   command. **Chosen: `docxtemplater` free tier** (MV3-safe, `{@rawXml}` paragraph-level
   injection, structured errors, all-MIT with PizZip elected MIT). See `engine-decision.md`.
2. **The product path:** template upload + placeholder scan UI, placeholder resolution per
   the 001 mapping table, ADF/storage → intermediate export model → templating engine,
   images fetched as blobs and embedded, Word-native TOC/heading-style support.

Quality proofs from EXPORT-QUALITY §7 that belong in this spike (cheap, visible):
**Shiki → colored runs** code highlighting (beats Scroll) and — stretch —
**beautiful-mermaid** SVG diagrams (svgBlip + PNG@2x fallback).

### Goals

- User uploads a `.docx` template in the panel; it is stored locally (IndexedDB), scanned,
  and the panel previews which placeholders the template uses ("this template uses:
  `$scroll.title`, `$scroll.content`, …") including unsupported ones flagged.
- Export button produces a downloaded `.docx`: template styles/header/footer/cover
  untouched, `$scroll.content` replaced by the converted page body, all `direct` +
  `derivable` placeholders from the mapping table resolved.
- Headings emit the **`Scroll Heading 1–6` / template heading styles** so a native Word
  TOC field in the template populates on open (`w:updateFields` set — parity with Scroll,
  see EXPORT-QUALITY §2: this is the ceiling, not a bug).
- Callouts (info/note/warning/tip) render as styled single-cell tables; tables, lists,
  code blocks (colored via Shiki) render correctly.
- Engine decision documented in `engine-decision.md` in this spec dir.

**Image handling deferred to a follow-up (Björn, 2026-07-16):** v1 DOCX export ships
**without embedded images**. Image references produce a report line ("image skipped —
embedding not yet available") and are omitted from the body, not rendered broken. The
self-built OOXML image module (~1 day; relationship/content-type parts, EMU sizing;
prototyped in `specs/005-docx-image-module/image-module-prototype.ts`) becomes its own follow-up task **after** this spec's
export flow is proven. Rationale: images are orthogonal to the template/placeholder/body
core that this PoC must prove, and deferring them de-risks and shortens 004.

### Non-goals

- No page-tree/multi-page export, no cross-page TOC (Phase 2).
- No `unsupported (v1)` placeholder families (G1–G5 gaps: page owner, DC usernames, space
  logo, page properties, JSON content properties) — they render as **empty string + an
  export report line** ("3 placeholders not supported"), never as literal `$scroll.…`
  garbage in the document. `never` rows likewise.
- No template management beyond one-at-a-time upload/replace (central registries are
  Phase 2/5).
- No hybrid programmatic-body path (dolanmiu/docx) — that's the v1 refinement
  (EXPORT-QUALITY §7 item 5); the spike is pure templating. Exception: if the spike shows
  both templating engines fail a must-have (see §2.1 exit criteria), hybrid becomes the
  fallback and this spec is re-scoped.
- No corporate font embedding (fonts are referenced by the template, resolved by Word on
  the reader's machine — that's the strength of the DOCX path).
- No PDF (spec 007).

---

## 2. Architecture

### 2.1 Engine spike (Task 1) — comparison protocol

Fixture: one storage-format document exercising every feature (headings 1–4, callouts ×4,
merged-cell table, ordered/unordered/nested lists, code block, 3 images, links, status
macro) + one realistic template (mayflower-style: cover, header/footer with placeholders,
TOC field, styles).

Score both engines on:

| Criterion | Why |
|---|---|
| Image embedding — license & mechanics | **The license fork**: docxtemplater needs paid PRO module; docx-templates does it MIT-native |
| Free-form XML injection (for callout tables, colored code runs) | Quality proofs depend on raw OOXML insertion |
| Loop/conditional syntax collision with `$scroll.*` literal placeholders | Scroll templates must work **unmodified** — engine delimiters must not fight `$…` syntax |
| Error behavior on malformed templates | UX: user uploads arbitrary docx |
| Browser bundle size / perf on the fixture | < 10 s budget (006) |
| Header/footer placeholder replacement | Scroll parity requirement |

**Exit criteria:** an engine is viable iff it can (a) replace text placeholders in body
*and* header/footer, (b) embed images, (c) inject raw OOXML for code runs/callouts.

**License/image constraint (Björn, 2026-07-14, refined 2026-07-15):**
- docxtemplater **PRO is excluded** — only free tiers compete.
- **Image embedding is a mandatory spike criterion**, exercised hands-on for both engines
  in their free tiers (not assessed from docs).
- If docxtemplater is only competitive with a **self-built OOXML image module**
  (relationship parts, content types, EMU sizing, svgBlip+fallback), that build effort is
  **estimated and enters the Task-1 decision as an explicit cost item** — it is *not* a
  pre-commitment. A self-built image module can quietly become the actual DOCX project;
  the decision weighs that risk, it doesn't assume it away.

Decision + evidence → `engine-decision.md`; the final pick is Björn's call at the Task 1
gate based on the spike results incl. the cost item above. Expected winner per research:
`docx-templates` (MIT, native images); the spike verifies rather than assumes.

### 2.2 Placeholder resolution layer

```
resolvePlaceholders(ctx) : Map<string, ResolvedValue>
  ctx = { details: ConfluencePageDetails, space?: ConfluenceSpace,
          currentUser?: ConfluenceUser, template: TemplateMeta, exportDate: Date }
```

- Implements every `direct` and `derivable` row of `scroll-placeholder-mapping.md` §2 —
  that table is **normative**; each implemented row gets a fixture test.
- Derivable wiring closes gaps **G6** (fetch `getSpace(spaceKey)` when the template uses
  `$scroll.space.*`) and **G7** (`getCurrentUser()` for `$scroll.exporter*`; absent Cloud
  email → empty + report line) and **G8** (template name = uploaded filename,
  modificationdate = upload timestamp — pragmatic PoC definition).
- Date placeholders support Scroll's SimpleDateFormat argument syntax
  (`$scroll.exportdate.("dd.MM.yyyy")`) for the common patterns; unknown format tokens
  fall back to ISO + report line.
- **Lazy fetching:** space/user round-trips only happen when the scanned template actually
  uses those placeholders.

### 2.3 Content pipeline (storage → OOXML body)

The converter's markdown output is a lossy intermediate for Word purposes; the export
walks a **structured intermediate model** instead:

```
storage XML ──(existing converter internals / new walker)──▶ ExportBlock[]
  ExportBlock = heading | paragraph | list | table | codeBlock | callout
              | image | statusBadge | raw …
ExportBlock[] ──(engine-specific serializer)──▶ OOXML fragments at $scroll.content
```

- Reuse the converter's macro knowledge (KNOWN_MACROS, callout normalization) — the
  walker lives in `packages/confluence` (isomorphic, unit-testable in bun, also the future
  input for 005's Typst serializer). **One intermediate model feeds both export paths.**
- Style mapping: heading level → template heading style id (detected from the template's
  `styles.xml`, with `Scroll Heading N` → `Heading N` fallbacks); code/callout styles
  synthesized if the template lacks them.
- Images: `ri:attachment` → attachment download URL (003's metadata) → session fetch →
  blob → engine image API; PNG/JPEG/GIF pass-through, SVG attachments get svgBlip +
  PNG@2x fallback only if the spike proves it cheap, else rasterize note in report.
- Code blocks: Shiki (lazy-loaded, only when a code block exists) tokenizes → one `<w:r>`
  per token with color + mono font, on a shaded paragraph style.
- Mermaid (stretch): ```mermaid code blocks → beautiful-mermaid SVG (synchronous,
  headless — verified MV3-safe) → svgBlip+PNG. If deferred, mermaid renders as a plain
  code block (today's converter behavior) — never a broken image.

### 2.4 Template store + scan

- IndexedDB (`templates` store): `{ id, name, bytes: Blob, uploadedAt, scan }`.
- Scan = unzip (fflate or engine-provided), regex `\$scroll\.[a-zA-Z.]+(\(.*?\))?` +
  `\$adhocState` over `document.xml`, headers, footers; classify each hit against the
  mapping table → `{ supported[], unsupported[], never[] }`.
- Panel shows the scan result before export; export report reuses the same classification.

### 2.5 Export report

Every export yields a panel-side report: resolved placeholder count, unsupported
placeholders (by name), fetch failures (image X skipped), duration. This is the user's
trust surface and 006's measurement hook.

---

## 3. Task breakdown

### Task 1 — Engine spike + decision **[decision gate]**

- [x] Spike harness renders the §2.1 fixture through **both** engines (`specs/004-docx-export/spike/`, own package.json/lock outside the workspace globs — root install/test unaffected)
- [x] All six criteria scored with evidence (output .docx verified at the XML level by `spike/verify-outputs.ts`, `xmllint`-validated); **image embedding exercised hands-on in both free tiers**
- [x] Self-built OOXML image module effort estimated (~1 day) + prototyped in `specs/005-docx-image-module/image-module-prototype.ts` — recorded as a cost item; also surfaced the decisive MV3-CSP/`eval` finding that rules out docx-templates
- [x] `engine-decision.md` written: verdict, license consequence, cost items, raw-XML recipe for the winner
- [x] Decision made with Björn (2026-07-16): docxtemplater free; images deferred (see Decisions log)

### Task 2 — Intermediate export model (isomorphic, in `packages/confluence`)

- [x] `ExportBlock` model + storage→blocks walker covering: headings, paragraphs, marks (bold/italic/code/link), lists (nested), tables (incl. colspan/rowspan basics), code blocks (language preserved), callouts (4 kinds + generic panel w/ title), images (attachment + external), status macro; unknown macros → `raw`/skip with note — `packages/confluence/src/export-blocks.ts` (`storageToBlocks`); mentions are a distinct inline node carrying `accountId` + optional `displayName` (clean slot for display-name resolution); unknown macros emit an explicit `unknown` block + `ExportNote` (never raw XML)
- [x] Fixture tests per block type + one integration fixture (the §2.1 document) with snapshot — `packages/confluence/src/export-blocks.test.ts` (35 tests); includes the modern-Cloud `<colgroup>` + `ac:local-id` + `<p local-id>` table markup as a regression fixture
- [x] `bun run check:browser` includes the walker module (stays isomorphic) — exported from `index.browser.ts` (a gated entrypoint); browser build clean, reuses `stripTableColumnMetadata`/`KNOWN_MACROS` from `markdown.ts`

### Task 3 — Template upload + scan UI

- [x] Upload (.docx only, size cap 20 MB), stored in IndexedDB, survives panel reload; replace + delete actions — `apps/extension/utils/docx/template-store.ts` (native IDB, round-trip tested with `fake-indexeddb`), `entrypoints/sidepanel/TemplateSection.tsx` (mount re-read + replace/delete)
- [x] Placeholder scan per §2.4 incl. header/footer parts; unit tests with crafted minimal docx fixtures (supported/unsupported/never mixes) — `utils/docx/scan.ts` + `utils/docx/ooxml-text.ts` (run-normalized), `tests/docx/scan.test.ts` incl. a run-split placeholder
- [x] Panel renders scan: supported ✓, unsupported ⚠ (with "will be empty" note), never ✗ — `TemplateSection.tsx` `ScanView`
- [x] Corrupt/non-zip upload → clear error, nothing stored — `unzipDocx` validates (zip + `word/document.xml`) before persist; `scan.test.ts` covers not-zip/not-docx/too-large

### Task 4 — Placeholder resolver

- [x] Every `direct` + `derivable` mapping row implemented; table-driven test asserts each against a fixture context — `utils/docx/resolver.ts` (`resolveOne`), `tests/docx/resolver.test.ts` (24-row table). Deviation: `$scroll.includepage.*` (derivable in §2 but a cross-page-include Phase-2 non-goal) is classified `unsupported` in v1 → empty + report line, per PLAN Non-goals; documented in `placeholder-map.ts`.
- [x] Lazy `getSpace`/`getCurrentUser` fetching (mock-fetch test: not called when template doesn't need them) — `resolvePlaceholders` fires each round-trip only when the used set needs it, at most once; `resolver.test.ts` proves not-called + at-most-once
- [x] SimpleDateFormat subset (`yyyy`, `MM`, `dd`, `HH`, `mm`) + fallback behavior tested — `utils/docx/dateformat.ts`, `tests/docx/dateformat.test.ts` (incl. unknown-token → ISO + report)
- [x] Unsupported/never placeholders → empty string + report entries (never literal `$scroll.*` in output — pinning test) — `resolver.test.ts` pinning test + `export.test.ts` full-output pin

### Task 5 — Body serialization + export flow (docxtemplater free)

- [x] `$scroll.content` replaced with serialized `ExportBlock[]` OOXML via docxtemplater `{@rawXml}`; heading style mapping incl. fallback chain tested against a template with and without `Scroll Heading` styles — `utils/docx/export.ts` (`{@scrollContent}` splice + render), `utils/docx/serialize.ts` + `ooxml.ts` (`resolveHeadingStyleId` Scroll Heading N → Heading N → builtin); `tests/docx/{serialize,export}.test.ts`
- [x] `$scroll.*` preprocessor (engine-agnostic; run-normalisation so placeholders split across `<w:r>` runs are merged before replacement) resolves all non-content placeholders in body **and** header/footer parts — `export.ts` `preprocessScrollText` + `ooxml-text.ts` `rewriteParagraphText`; `export.test.ts` asserts resolved values in body + header + run-split footer
- [x] Images: **deferred (v1)** — an image block emits NO OOXML image and adds a report line ("image skipped — embedding not yet available"); export still succeeds (pinning test: output has no dangling relationship, no `$scroll.` literal, report lists each skipped image) — `serialize.ts` image case; `serialize.test.ts` + `export.test.ts` pins (no `<w:drawing>`, `skippedImages` counted)
- [x] Callout boxes as styled 1×1 tables (background + left accent border + title); code blocks via Shiki colored runs — both verified by unzipping the output in tests and asserting OOXML landmarks — `ooxml.ts` `calloutTable`/`codeLineParagraph`, `highlight.ts` (lazy fine-grained Shiki core, JS regex engine, curated per-language chunks); `serialize.test.ts` asserts fill/accent + colored runs
- [x] `w:updateFields` set in output `settings.xml` (TOC populates on open) — `export.ts` `ensureUpdateFields` (creates settings.xml + registers part when absent); `export.test.ts`
- [x] Export triggers a browser download `"<page-title>.docx"`; duration measured and shown in report — `TemplateSection.tsx` `download()` + `ReportView`; `export.ts` `toDownloadFilename` + `durationMs`; `export.test.ts` asserts sanitized filename
- [x] Full-pipeline test: fixture storage + fixture template → output docx that unzips, contains no `$scroll.` literals, has expected style refs, and (docxtemplater) throws no template error on the fixture template — `tests/docx/export.test.ts`

### Task 6 — Stretch: mermaid diagrams **[descoped — see F2]**

- [ ] ~~```mermaid blocks → beautiful-mermaid SVG → svgBlip + PNG@2x fallback embedded~~ — **descoped**: SVG embedding requires the OOXML image module, which is spec `005-docx-image-module`. Revisit as a 005 follow-up, not in 004.
- [x] Skipped cleanly if descoped (mermaid renders as code block — existing behavior, test pins it) — mermaid is deliberately absent from `highlight.ts`'s curated `LANG_LOADERS`, so it degrades via the uncurated-language path to an uncolored `AtlcliCode` block + a `code-highlight-skipped` report note. Pinned at both levels: `packages/confluence/src/export-blocks.test.ts` (a `language=mermaid` code macro stays a `codeBlock` carrying its source) and `apps/extension/tests/docx/serialize.test.ts` (the block renders as a code block with **no** `<w:drawing>`/`blip`/`r:embed` — the PLAN §2.3 "never a broken image" invariant; the test fails the moment a half-wired diagram path emits a drawing).

### Task 7 — Manual E2E **[E2E: user]**

Joint session (space `DOCSY`; create a dedicated test page with the full feature zoo, delete after):

- [ ] Upload a real mayflower Word template; scan output matches expectation
- [ ] Export the test page; open in Word: styles/cover/header/footer intact, placeholders resolved, TOC populates after field update prompt
- [ ] Callouts, tables, lists, code (colored) all visually correct in Word (images: v1 shows them as skipped-report lines, not embedded)
- [ ] A template using an unsupported placeholder exports with empty value + report warning
- [ ] Duration for the ~2,000-word page recorded (input to 006)

**Status (2026-07-16): a finding-generating run happened; a confirming run has not.**
The 2026-07-14 live session against the real Mayflower letterhead produced the six
`Known real-template case` entries in the Decisions log — text-box/drawing-adjacent
placeholders, SmartArt/chart/field shapes, empty TOC on a custom-heading template,
heading promotion, undecoded HTML entities, and the content-insertion display gap. Every
one was fixed **and** pinned with a regression test, and all repo gates are green
(1507 tests, typecheck, `check:browser`, `check:extension-output` — verified 2026-07-16).

But those fixes were verified *by test*, not by reopening the result in Word, and all of
them landed in the same squash (`40953db`) as the run that found them. Task 7's acceptance
instrument is explicitly "open in Word and look", so the boxes stay unchecked until one
confirming pass runs end-to-end on the **post-fix** build. That pass is small — it is
re-confirmation, not exploration:

1. The six fixed shapes render correctly in Word on the real template (they are the
   highest-risk items precisely because they were broken once).
2. Items 3 and 4 above have **no live record at all** — callout/table/code visual
   correctness and the unsupported-placeholder warning path were never exercised against
   real Word, only against OOXML landmark assertions.
3. Item 5 (duration) is **unrecorded**: `durationMs` is measured (`export.ts:200`) and
   shown in the report (`TemplateSection.tsx:361`), but no number for a ~2,000-word page
   has been captured — spec 008 needs that figure as its baseline.

---

## 4. Test plan

- **Unit:** walker per block type, resolver table-driven, scan classification, date formatting.
- **Integration:** full pipeline on fixtures with OOXML-landmark assertions (unzip in test); mock-fetch credential checks for image downloads; failure-injection (broken image, missing space perms) → report entries.
- **Spike artifacts** are evidence, not CI tests — they live in the spec dir.
- **Manual E2E (Task 7):** real template, real page, real Word. Word rendering can't be asserted in CI; the E2E checklist is the acceptance instrument, per-item.
- Regression: whole repo green (`bun test`, `typecheck`, `check:browser`, `build`).

## 5. Definition of done

- Tasks 1–5 ✅ + Task 6 ✅ (descoped, fallback pinned) + Task 7 ⬜ **open** — mermaid (F2) and image embedding (F3) are explicitly deferred as follow-up tasks with the skip behavior pinned by test.
- `engine-decision.md` committed; engine + image decisions made by Björn.
- E2E: a real DOCSY page exported through a real mayflower template opens clean in Word (text/styles/placeholders/callouts/tables/code; images appear as skip-report lines in v1).
- Export report shows no silent failures; unsupported placeholders + skipped images surfaced.
- Test resources cleaned up (test pages deleted).

## 6. Risks and open questions

1. **Both engines could fail the raw-XML criterion** → hybrid path (template as shell, programmatic body via dolanmiu/docx) becomes Plan B; that is a re-scope, decided at the Task 1 gate, not silently.
2. **Delimiter collision:** engines default to `{…}`/`{{…}}` delimiters — `$scroll.*` text replacement may need a custom preprocessor pass (find/replace at XML level) instead of the engine's data path for placeholders outside `$scroll.content`. The spike explicitly probes this.
3. **Merged-cell tables** are the known reef (EXPORT-QUALITY §6 "ehrlich"): v1 targets basic colspan/rowspan; deeply nested merges may degrade — report line, not corruption. Pin behavior with a fixture.
4. **Shiki bundle weight** (~grammars are heavy): lazy-load only needed languages; budget check in 006's `< 10 s` measurement.
5. **SVG attachments in Word** (svgBlip) have version-dependent support — PNG@2x fallback is mandatory whenever SVG is embedded.
6. **G8 pragmatics:** template mtime = upload time may differ from Scroll's semantics (file mtime); acceptable for PoC, documented in the report.

### Decisions log

- **F1 — templating engine**: ✅ (Björn, 2026-07-16) **docxtemplater free** (Option A, ratified over the no-engine Option C during the review-fix cycle). `docx-templates` ruled out by our MV3 CSP (uses `eval`/`new Function`; CSP has no `'unsafe-eval'` — verified against the built manifest). A chosen for robust zip/part handling + structured errors against arbitrary customer templates. All-MIT (docxtemplater core + PizZip **elected MIT** from its `MIT OR GPL-3.0` dual license + xmldom).
  - **#11 solved via PUA custom delimiters; docxtemplater retained.** The adversarial review's finding #11 (customer templates containing literal `{`, `}`, `{foo}` were parsed/mutated/thrown-on by docxtemplater's default `{…}` delimiters) is fixed **without removing the engine**: docxtemplater is configured with a Unicode Private-Use-Area delimiter pair (U+E000 … U+E001). docxtemplater scans the whole document for its delimiter pair, and a PUA pair cannot occur in any real Word template or in customer content, so the customer's literal braces (and guillemets `«…»`, `{{…}}`) are never tags — never parsed, never mutated, never throw. Finding #7 (page-authored `$scroll.*` in the body) stays fixed because the serialized page body is injected as the **value** of a free-tier `{@rawXml}` tag (`@scrollContent`), inserted verbatim without re-parsing. Non-content `$scroll.*` placeholders are resolved to text on the template parts (run-normalized preprocessor, findings #8/#9) **before** render, so the engine only ever sees resolved text plus the single rawxml tag. A residual docxtemplater render failure (not expected with PUA delimiters) is classified as a specific `DocxRenderError` with the engine's structured explanation, never a generic "Export failed". Implementation: `apps/extension/utils/docx/export.ts` (`renderContent`, `CONTENT_TAG_PARA`, PUA `DELIM_START`/`DELIM_END`); regression tests in `apps/extension/tests/docx/export.test.ts` (#7, #11, PUA-delimiter guillemets/braces, rawxml verbatim, DocxRenderError classification).
- **Known real-template case — text-box / drawing-adjacent `$scroll.title`** (live E2E, Mayflower letterhead, 2026-07-14): the placeholder replacement treated drawing/object/`mc:AlternateContent` regions as opaque and left literal `$scroll.title` unresolved when the title lived **inside a text box** (shape a — provided twice via `mc:AlternateContent`: DrawingML `wps:txbx` Choice + VML `v:textbox` Fallback, each with a NESTED `<w:p>`) or in a **clean `<w:t>` run that trails a picture run in the same paragraph** (shape b — footer logo). Root cause: the non-greedy paragraph regex stopped at the inner text-box `</w:p>`, desyncing boundaries so trailing runs fell outside the captured paragraph. **Fix:** `splitParagraphs` now does a balanced `<w:p>`-depth scan (top-level only); `extractTextboxes` masks each `<w:txbxContent>` region behind a sentinel so the enclosing paragraph tokenizes into flat runs, and `rewriteScrollText` resolves the top-level runs (including clean runs adjacent to a non-mergeable drawing run) then restores each text box with its inner paragraphs resolved recursively — in BOTH the Choice and Fallback copies. The scan (`collectParagraphTexts`) walks the same paragraph set so the panel's supported-list matches what is resolved (the bug had it reporting `$scroll.title ×2` while missing one). Findings #8 (no fuse across `<w:br/>`/drawing boundaries) and #9 (trailing period) preserved. Impl: `apps/extension/utils/docx/ooxml-text.ts` (`splitParagraphs`, `extractTextboxes`, `collectParagraphTexts`, `rewriteScrollText`), `export.ts` (`preprocessScrollText`), `scan.ts`; regression tests in `tests/docx/{ooxml-text,scan,export}.test.ts` (shape a, shape b, combined full-export zero-literal + well-formed, scan detection/count).
- **Known real-template cases — residual placeholder shapes (①②③)** (live E2E follow-up, 2026-07-14): three further real-template shapes flagged after the text-box/drawing-adjacent fix, extending the SAME mask+recurse + run-normalization mechanism. **① SmartArt / chart text** — `$scroll.*` can live in DrawingML `<a:t>` runs (SmartArt `word/diagrams/data*.xml`, chart `<c:tx><c:rich>` in `word/charts/chart*.xml`, or an inline shape) which sit OUTSIDE the `<w:p>`/`<w:t>` tree. Fix: `documentPartNames` now also enumerates `word/charts/chart*.xml` and `word/diagrams/(data|drawing)*.xml`; a new DrawingML pass (`rewriteDrawingText` / `collectDrawingTexts`) merges consecutive `<a:t>` within one `<a:p>` (an `<a:br/>` is a boundary, mirroring `<w:br/>`), resolves the placeholder, and touches ONLY `<a:t>` bodies — never geometry/style — so every modified part stays well-formed. `rewriteScrollText` runs a single top-level DrawingML sweep after the WML pass; `collectParagraphTexts` collects `<a:t>` text so the scan panel matches. **② Field-code placeholders** — `<w:fldSimple w:instr>` and complex `<w:fldChar>`/`<w:instrText>` fields. Correctness boundary: only the field's DISPLAYED RESULT `<w:t>` runs resolve (they are ordinary mergeable runs, already handled once the enclosing paragraph tokenizes; the split cached result even run-normalizes); the `w:instr` attribute and `<w:instrText>` are NEVER rewritten — a `$scroll.*` in field logic is intentionally left literal (`parseRunInfo` already treats an `instrText`/`fldChar` run as a non-mergeable boundary, and `paragraphText`/scan read `<w:t>` only, so instructions are neither resolved nor counted). **③ Placeholder split across a text-box (story) boundary** — physically impossible in real authoring (a text box is a separate story); the CORRECT behaviour is to NOT merge across the box boundary, which the mask+recurse design already guarantees (an outer `$scr` never fuses with an inner box `oll.title`). Documented as intentional (not a gap) with a defensive regression test; cross-boundary merging is deliberately NOT implemented. Impl: `apps/extension/utils/docx/ooxml-text.ts` (`rewriteDrawingText`, `collectDrawingTexts`, `rewriteScrollTextWml` split, story-boundary comment), `scan.ts` (`documentPartNames`), `export.ts` (`preprocessScrollText` doc); fixture builders `smartArtTitlePara`/`chartTitlePart`/`smartArtDataPart`, `fldSimpleResult`/`complexFieldResult`, `crossBoundarySplitPara` + `buildDocx` `extraParts`; regression tests in `tests/docx/{ooxml-text,scan,export}.test.ts` (per shape: targeted unit test + full-export zero-literal / instruction-untouched / well-formed).
- **Known real-template case — TOC collects nothing on a custom-heading-style template** (live E2E, 2026-07-14): a customer template's field was `TOC \o "1-3"`, which collects paragraphs by **outline level 1–3**, and the template defined only a custom heading style (`Heading1TOC`, no standard `Heading 1/2/3`). Our serializer mapped headings to a template style id via `resolveHeadingStyleId`, but that style carried no outline level, so `TOC \o` collected nothing → empty TOC on a heading-rich page. **Fix:** heading paragraphs now ALSO carry an explicit `<w:outlineLvl w:val="N"/>` (N = level−1, clamped to the OOXML 0–8 range) in their `<w:pPr>`, in addition to the style-id mapping (visual styling still comes from the template's heading style when present). Outline level is what `TOC \o` collects regardless of style name, so headings populate a native Word TOC across ANY template. Schema order preserved: `pStyle` precedes `outlineLvl` (and any `pBdr`/`ind` injected for quoted/list headings stays before `outlineLvl`). Impl: `apps/extension/utils/docx/serialize.ts` (`case "heading"`); regression tests in `tests/docx/serialize.test.ts` (levels 1→0 / 3→2, defensive clamp →8, custom-only heading style still outline-levelled) and `tests/docx/export.test.ts` (full export through a `Heading1TOC`-only template yields `<w:outlineLvl>` on H1/H2).
- **Known real-template case — heading-level normalization ("promotion") to match Scroll** (live E2E, 2026-07-14): a real Confluence page used **H2 (×8) + H3 (×30) with NO H1** — the page title is the implicit Heading 1, so body headings start at H2. Scroll Office promotes the **shallowest heading level in the document to Heading 1** (H2→Heading 1, H3→Heading 2); our export previously preserved levels (H2→Heading 2/Überschrift 2, H3→Heading 3), leaving the top TOC/outline level empty. **Fix:** the serializer computes ONE document-wide offset over the full block tree — `offset = minLevel − 1`, where `minLevel` is the smallest heading `level` anywhere (the scan recurses into callouts, blockquotes, list items and table cells so a single offset governs every heading). Each heading's EFFECTIVE level = `block.level − offset` (shallowest → 1), applied to BOTH the mapped style id (`resolveHeadingStyleId`, style level clamped 1..6) and the `<w:outlineLvl>` stamp (clamped 0..8). Edge cases: no headings → offset 0 (no-op); a document already starting at H1 → offset 0 (unchanged); a document whose shallowest heading is H3 → H3 becomes Heading 1. Impl: `apps/extension/utils/docx/serialize.ts` (`computeHeadingOffset`/`minHeadingLevel`, threaded via `InternalContext.headingOffset`, applied in `case "heading"`); regression tests in `tests/docx/serialize.test.ts` (RFP shape `[H2,H3,H2,H3]`→levels 1/2; `[H1,H2,H3]` unchanged; `[H3,H4]`→levels 1/2; no-heading no-op; plus updated lone-H2 style-mapping/blockquote/list tests reflecting promotion).
- **Known real-template case — named HTML entities survive undecoded into the DOCX** (live E2E, 2026-07-14): exported Word content showed literal `drei &uuml;berlappende` instead of `drei überlappende`. Confluence storage is XHTML and carries the full HTML5 named-entity set (`&uuml;`, `&auml;`, `&ouml;`, `&szlig;`, `&eacute;`, `&mdash;`, `&hellip;`, `&copy;`, …), but the export-block walker's `decodeEntities` only knew a dozen hand-listed names, so every other named entity passed through verbatim into the `<w:t>` runs (the same gap hit attribute values — image alt / link title — decoded via the same helper). **Fix:** added `entities` (npm, BSD-2-Clause, isomorphic — the decoder turndown/markdown-it already use) as a direct dependency of `@atlcli/confluence` and replaced the hand-maintained `NAMED_ENTITIES` table + regex body with `decodeHTML` from `entities`; `decodeEntities(text)` keeps its name/signature so both call sites (text at `pushText`, attributes at `parseAttributes`) resolve the full HTML5 named set + decimal/hex charrefs. Stays isomorphic — `check:browser` still passes clean (no `node:`/`bun:` leaks; export-blocks.ts is re-exported from `index.browser.ts`). Behavior note: `&nbsp;` decodes to a real non-breaking space (U+00A0) — this was already the old table's value (`nbsp: " "`), so no downstream change, and it is the correct char for Word. The markdown path (`storageToMarkdown`) was NOT affected — markdown-it/turndown already decode named entities (verified: `&uuml;` → `ü`). Impl: `packages/confluence/src/export-blocks.ts` (`decodeEntities` → `decodeHTML`), `packages/confluence/package.json`; regression tests in `packages/confluence/src/export-blocks.test.ts` (full named-set: umlauts/eszett/mdash/hellip/copy + decimal `&#252;` + hex `&#xFC;` + `&amp;&lt;&gt;`, asserting zero surviving `&…;` literals; attribute-value decode via image alt) and `apps/extension/tests/docx/serialize.test.ts` (storage→blocks→`serializeInline` round-trip yields real UTF-8 in `<w:t>`, no entity literals).
- **Display finding — content insertion point not surfaced** (live E2E, 2026-07-14): the scan panel listed only fillable placeholders (`$scroll.title`, …) and never showed `$scroll.content`, which is intentionally excluded from the placeholder list (it is the body anchor, not a fillable value) — a user read this as the content anchor being missing. **Fix (display only):** `ScanView` now renders a content-insertion line from the `hasContentPlaceholder` flag the `ScanResult` already carries — `Content insertion point: ✓ found ($scroll.content)` when present, else a note that the page body will be appended before the final section break (matching `export.ts`'s `no-content-placeholder` behavior). The placeholder-engine classification is unchanged (`$scroll.content` stays out of the supported/unsupported/never buckets). Impl: `apps/extension/entrypoints/sidepanel/TemplateSection.tsx` (`ScanView` + `ContentInsertionLine`); regression test `tests/docx/scan-view.test.tsx` (found + absent cases via react-dom/server).
- **F3 — image embedding**: ✅ (Björn, 2026-07-16) **deferred to a follow-up task**. v1 export omits images with a report line; the ~1-day self-built OOXML image module (prototyped in `specs/005-docx-image-module/image-module-prototype.ts`) is a separate task after the export flow is proven.
- **F2 — mermaid in scope**: ⏸ **deferred to after spec 005** (proposed 2026-07-16 — awaiting Björn's ratification, as F1/F3 were his calls). Not a budget call in the end but a dependency one: mermaid renders to SVG, and embedding SVG needs svgBlip + PNG@2x — i.e. the OOXML image module that F3 already deferred to `005-docx-image-module`. Doing mermaid in 004 would mean building the image module inside 004, which is exactly what F3 decided against. **Descope behavior is pinned, not merely absent** (Task 6): a mermaid block degrades to an uncolored `AtlcliCode` code block carrying its diagram source + a `code-highlight-skipped` report note, with no `<w:drawing>`/`blip`/`r:embed` emitted — the reader sees readable diagram source, never a broken image. Natural pickup point: a 005 follow-up, once media parts/relationships/EMU sizing exist and mermaid is "SVG → the same embed path".
