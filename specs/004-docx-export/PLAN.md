# DOCX Export (Headline) — Customer Word Template + Scroll Placeholder Compatibility

Status: **Planned**

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

1. **The engine spike (decides a license question):** `docx-templates` (MIT) vs
   `docxtemplater` (image embedding is a paid PRO module). Both implement the same
   paradigm as atlcli's existing Python `docxtpl` path. The spike renders the *same
   fixture page through both* and produces a written decision.
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
- Images: attachment references resolved via session-auth fetch → embedded at correct
  intrinsic size (capped to page width).
- Callouts (info/note/warning/tip) render as styled single-cell tables; tables, lists,
  code blocks (colored via Shiki) render correctly.
- Engine decision documented in `engine-decision.md` in this spec dir.

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
- No PDF (spec 005).

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
*and* header/footer, (b) embed images without paid modules or with an acceptable license
cost (Björn decides), (c) inject raw OOXML for code runs/callouts. Decision + evidence →
`engine-decision.md`. Expected winner per research: `docx-templates` (MIT); the spike
verifies rather than assumes.

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

- [ ] Spike harness renders the §2.1 fixture through **both** engines (spike code under `specs/004-docx-export/spike/`, allowed to be throwaway)
- [ ] All six criteria scored with evidence (output .docx files kept next to the spike)
- [ ] `engine-decision.md` written: winner, license consequence, raw-XML injection recipe for the winner
- [ ] Decision reviewed with Björn (license/money question is his call) before Task 3 builds on it

### Task 2 — Intermediate export model (isomorphic, in `packages/confluence`)

- [ ] `ExportBlock` model + storage→blocks walker covering: headings, paragraphs, marks (bold/italic/code/link), lists (nested), tables (incl. colspan/rowspan basics), code blocks (language preserved), callouts (4 kinds + generic panel w/ title), images (attachment + external), status macro; unknown macros → `raw`/skip with note
- [ ] Fixture tests per block type + one integration fixture (the §2.1 document) with snapshot
- [ ] `bun run check:browser` includes the walker module (stays isomorphic)

### Task 3 — Template upload + scan UI

- [ ] Upload (.docx only, size cap 20 MB), stored in IndexedDB, survives panel reload; replace + delete actions
- [ ] Placeholder scan per §2.4 incl. header/footer parts; unit tests with crafted minimal docx fixtures (supported/unsupported/never mixes)
- [ ] Panel renders scan: supported ✓, unsupported ⚠ (with "will be empty" note), never ✗
- [ ] Corrupt/non-zip upload → clear error, nothing stored

### Task 4 — Placeholder resolver

- [ ] Every `direct` + `derivable` mapping row implemented; table-driven test asserts each against a fixture context
- [ ] Lazy `getSpace`/`getCurrentUser` fetching (mock-fetch test: not called when template doesn't need them)
- [ ] SimpleDateFormat subset (`yyyy`, `MM`, `dd`, `HH`, `mm`) + fallback behavior tested
- [ ] Unsupported/never placeholders → empty string + report entries (never literal `$scroll.*` in output — pinning test)

### Task 5 — Body serialization + export flow

- [ ] `$scroll.content` replaced with serialized blocks; heading style mapping incl. fallback chain tested against a template with and without `Scroll Heading` styles
- [ ] Images embedded via session fetch (mock-fetch integration test asserts `credentials: "include"` on attachment downloads); failed image → placeholder text + report line, export still succeeds
- [ ] Callout boxes as styled 1×1 tables (background + left accent border + title); code blocks via Shiki colored runs — both verified by unzipping the output in tests and asserting OOXML landmarks
- [ ] `w:updateFields` set in output `settings.xml` (TOC populates on open)
- [ ] Export triggers a browser download `"<page-title>.docx"`; duration measured and shown in report
- [ ] Full-pipeline test: fixture storage + fixture template → output docx that unzips, contains no `$scroll.` literals, has expected style refs

### Task 6 — Stretch: mermaid diagrams

- [ ] ```mermaid blocks → beautiful-mermaid SVG → svgBlip + PNG@2x fallback embedded; unsupported diagram types fall back to code block + report line
- [ ] Skipped cleanly if descoped (mermaid renders as code block — existing behavior, test pins it)

### Task 7 — Manual E2E **[E2E: user]**

Joint session (space `DOCSY`; create a dedicated test page with the full feature zoo, delete after):

- [ ] Upload a real mayflower Word template; scan output matches expectation
- [ ] Export the test page; open in Word: styles/cover/header/footer intact, placeholders resolved, TOC populates after field update prompt
- [ ] Callouts, tables, lists, code (colored), images all visually correct in Word
- [ ] A template using an unsupported placeholder exports with empty value + report warning
- [ ] Duration for the ~2,000-word page recorded (input to 006)

---

## 4. Test plan

- **Unit:** walker per block type, resolver table-driven, scan classification, date formatting.
- **Integration:** full pipeline on fixtures with OOXML-landmark assertions (unzip in test); mock-fetch credential checks for image downloads; failure-injection (broken image, missing space perms) → report entries.
- **Spike artifacts** are evidence, not CI tests — they live in the spec dir.
- **Manual E2E (Task 7):** real template, real page, real Word. Word rendering can't be asserted in CI; the E2E checklist is the acceptance instrument, per-item.
- Regression: whole repo green (`bun test`, `typecheck`, `check:browser`, `build`).

## 5. Definition of done

- Tasks 1–5 + 7 checked (6 checked or explicitly descoped with fallback pinned).
- `engine-decision.md` committed; license question answered by Björn.
- E2E: a real DOCSY page exported through a real mayflower template opens clean in Word.
- Export report shows no silent failures; unsupported placeholders surfaced.
- Test resources cleaned up (test pages deleted).

## 6. Risks and open questions

1. **Both engines could fail the raw-XML criterion** → hybrid path (template as shell, programmatic body via dolanmiu/docx) becomes Plan B; that is a re-scope, decided at the Task 1 gate, not silently.
2. **Delimiter collision:** engines default to `{…}`/`{{…}}` delimiters — `$scroll.*` text replacement may need a custom preprocessor pass (find/replace at XML level) instead of the engine's data path for placeholders outside `$scroll.content`. The spike explicitly probes this.
3. **Merged-cell tables** are the known reef (EXPORT-QUALITY §6 "ehrlich"): v1 targets basic colspan/rowspan; deeply nested merges may degrade — report line, not corruption. Pin behavior with a fixture.
4. **Shiki bundle weight** (~grammars are heavy): lazy-load only needed languages; budget check in 006's `< 10 s` measurement.
5. **SVG attachments in Word** (svgBlip) have version-dependent support — PNG@2x fallback is mandatory whenever SVG is embedded.
6. **G8 pragmatics:** template mtime = upload time may differ from Scroll's semantics (file mtime); acceptable for PoC, documented in the report.

### Decisions log

- **F1 — templating engine**: ❓ open — decided by Task 1 spike + Björn (license). 
- **F2 — mermaid in scope**: ❓ open — stretch; decide at Task 6 based on remaining budget.
