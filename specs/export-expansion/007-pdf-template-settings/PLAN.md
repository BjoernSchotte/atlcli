# 007 — PDF template settings & template library

Status: Plan, 2026-07-19. Folder `specs/export-expansion/007-pdf-template-settings`.

## Reference

- `specs/export-expansion/UMSETZUNGSPLAN.md` — Lane P (owner: `packages/pdf`),
  tasks T2.1 (settings threading + contract), T2.2 (Level-A settings),
  T2.3 (watermark), T2.4 (TemplateLibrary + `.atlcli-template` container).
  T2.1 and T2.4 are listed under "immediately and independently startable".
- `specs/export-expansion/BASELINE-DESIGN.md` §2 Cluster B — B2 (global vs.
  space templates), B3 (`.atlcli-template` container for both engines),
  B5 (font upload — engine seam only in this folder), B6 (stationery /
  backgrounds — follow-up), B7 (watermark), B8 (page size/orientation +
  section toggles), B9 (table style source, DOCX — smaller follow-up
  package), B10 (settings/timezone/presets — smaller follow-up package).
- `specs/pdf-template-editor/TEMPLATE-UX.md` — product levels A/B/C, §7
  minimal template contract `render(meta, body, settings)` as
  `atlcli.pdf-template/v1`, §9 security and reproducibility rules.
- Explicitly **out of scope** for this folder: A6, A7, and B4, plus every
  host UI surface (settings forms, library admin screens, upload dialogs).
  This folder delivers engine and library capabilities consumed identically
  by CLI, extension, and further hosts.

Code baselines (verified on branch `export-expansion`):

- `packages/pdf/src/template.ts` — `createAtlcliTypstTemplate()`; today
  `atlcli-doc(meta: (:), body)` hard-codes `paper: "a4"` (line 71), an
  always-on cover block (line 116+), outline (line 142), and colophon/end
  page (line 146+); header/footer text is fixed to `meta.title`/`meta.space`.
- `packages/pdf/src/serialize.ts` — `serializePdfDocument` (line 827)
  builds `main.typ` with `#show: atlcli-doc.with(meta: (...))` (line 849);
  no `settings` reach the template today.
- `packages/pdf/src/types.ts` — `PdfSerializeOptions` (line 115) carries
  only `metadata`, `profile`, `theme`; `PdfAssetResolver` (line 26) is the
  existing port pattern to imitate for fonts and templates.
- `packages/pdf/src/run-export.ts` — `RunPdfExportInput` (line 22) and
  `PdfExportEnv` (line 33); `runPdfExport` passes serialize options at
  line 127.
- `packages/pdf/src/theme.ts` — `resolvePdfTheme` validation style
  (throw on invalid values) is the model for settings validation.
- `packages/pdf/src/validate.ts` — `validatePdfOutput` inspects raw PDF
  bytes via `latin1` decode + regex (`/Type /Page`, `/StructTreeRoot`,
  `/FontFile`); informs what compiled-PDF assertions can and cannot see.
- `packages/pdf-compiler-browser/src/compiler.ts` —
  `BrowserPdfCompilerAssets { wasm; fonts: Uint8Array[] }` (line 15);
  fonts enter the compiler via `builder.add_raw_font(font)` (line 43).
  `compiler.test.ts` already performs real WASM compiles under `bun test`.
- `packages/core/src/index.ts` / `index.browser.ts` — dual entry points;
  anything added to core for the library must be browser-safe (no `node:`
  imports) to keep the CI browser-build gate green.
- `packages/docx/src/scan.ts` — `MAX_TEMPLATE_BYTES = 20 MiB` (line 30)
  and PizZip usage; the container reuses the cap value and the zip
  dependency precedent.

## Goal & user value

Make PDF output configurable without a template studio, and make templates
shareable and centrally manageable:

1. **A stable template contract.** `atlcli.pdf-template/v1` with
   `render(meta, body, settings)` so the built-in template today — and
   imported Level-B packages later — consume the same versioned seam.
2. **Level-A settings.** "US customers need Letter, this document needs no
   cover, the footer must carry our legal line" — page size, orientation,
   cover/outline toggles, header/footer text, all as plain serializable
   values that every host (CLI flags, extension form, further hosts) can
   supply.
3. **Watermark.** "Drafts and confidential exports must be recognizable" —
   a rotated text layer under the content, an Artifact in the tagged PDF,
   and a cheap visible differentiator.
4. **Template library + sharing container.** One host-neutral library
   abstraction with global/space two-level resolution and sha256-verified
   bytes, plus a deterministic `.atlcli-template` zip so a template built
   in one place imports in another — for both the Typst and the DOCX
   engine.
5. **Font intake seam.** Corporate fonts flow as `Uint8Array[]` into the
   existing compiler constructor; the engine validates sfnt bytes and
   rejects WOFF2 with actionable guidance.

## Dependencies

- **T2.1 (settings threading) and T2.4 (template library + container) have
  no dependencies** and are parallel-safe against each other and against
  every other lane: T2.1 owns `packages/pdf/src/{template.ts, serialize.ts,
  types.ts, run-export.ts}`; T2.4 owns the new
  `packages/core/src/template-library.ts` and the new package
  `packages/template-pack/` — disjoint file sets.
- **File ownership inside Lane P:** `template.ts` and `serialize.ts` are
  the lane's hot files. T2.1 lands first; T2.2 (Level A) and T2.3
  (watermark) build on the threaded `settings` and land after it, in that
  order. No other lane touches these files (per UMSETZUNGSPLAN, the
  chapter-rendering interest from Lane A arrives only after T2.1).
- **E2E dependency (not a code dependency):** end-to-end verification of
  Level-A settings and watermark runs through the PDF CLI planned in
  folder 008 (`atlcli wiki export --format pdf`, Lane K T3.1/T3.2). Unit
  and compile-level tests in this folder do not wait for it.
- `packages/docx` is **not** modified here. The container format covers
  `engine.kind: "docx"`, but the DOCX import path (template scan on
  unpack) only calls the existing exported `scanTemplate` from
  `packages/docx/src/scan.ts` — no changes inside that package. The DOCX
  watermark counterpart (B7 DOCX header shape) is deferred with B9.

## Architecture (isomorphic)

Everything in this folder is host-neutral and must build for both entry
points of its package (`index.ts` and `index.browser.ts` where present):

```
settings (plain JSON-able object, host-supplied)
   │
   ▼
RunPdfExportInput.settings ──► PdfSerializeOptions.settings
   │                                   │  validate + normalize (resolvePdfSettings)
   ▼                                   ▼
serializePdfDocument ──► main.typ: #show: atlcli-doc.with(meta: (...), settings: (...))
                                       │
                                       ▼
                        atlcli.typ: #let atlcli-doc(meta: (:), settings: (:), body)
                        = the atlcli.pdf-template/v1 render surface
```

- **Contract:** `atlcli.pdf-template/v1` is the Typst-side function shape
  `render(meta, body, settings)` (TEMPLATE-UX §7). The built-in template's
  `atlcli-doc` becomes its first conforming implementation; `settings` is a
  Typst dictionary read defensively with `.at(key, default: ...)` so old
  callers and sparse dictionaries keep compiling.
- **Settings are data, not code.** Hosts never write Typst. The engine
  validates settings in TypeScript (same throw-on-invalid style as
  `resolvePdfTheme`) and emits them as a Typst dict with the existing
  `typstString` escaping from `packages/pdf/src/escape.ts`.
- **Template library** lives in `packages/core/src/template-library.ts`:
  pure types + pure `resolveTemplate` + an async sha256 verify helper on
  WebCrypto (`crypto.subtle`), available in browsers, Bun, and Node ≥ 18.
  Storage adapters (IndexedDB, `~/.atlcli/templates/`, attachment-backed)
  are host code and out of scope here.
- **Container** lives in a new isomorphic package
  `packages/template-pack/` (pure byte-in/byte-out functions, PizZip like
  `packages/docx`), shared by both engines: only the *container* is
  shared, never the render contract (TEMPLATE-UX §11).
- **Fonts** never get fetched by the engine. Hosts resolve bytes (via a
  `FontSource` port mirroring `PdfAssetResolver`) and construct
  `BrowserPdfCompiler` with `bundledFonts ∪ customFonts` — the compiler
  already accepts `fonts: Uint8Array[]`.

## Tasks

### Settings threading & contract (T2.1)

- [ ] `packages/pdf/src/types.ts`: add `PdfTemplateSettings` (all fields
      optional, plain JSON-able) and `PdfWatermarkSettings`; extend
      `PdfSerializeOptions` with `settings?: PdfTemplateSettings`.
      ```ts
      export interface PdfWatermarkSettings {
        text: string;
        color?: string;    // default "#DE350B"
        opacity?: number;  // 0..1, default 0.08
        angle?: number;    // degrees, default -54
        size?: number;     // pt, default 96
      }
      export interface PdfTemplateSettings {
        page?: "a4" | "letter";
        orientation?: "portrait" | "landscape";
        cover?: boolean;
        outline?: boolean;
        headerText?: string;
        footerText?: string;
        watermark?: PdfWatermarkSettings;
      }
      ```
- [ ] `packages/pdf/src/settings.ts` (new): `resolvePdfSettings(options?)`
      → fully-defaulted internal settings, throwing on invalid values
      (unknown page size, opacity outside 0..1, empty watermark text) in
      the `resolvePdfTheme` style; plus `typstSettingsDict(resolved)`
      emitting the Typst dictionary literal via `typstString`.
- [ ] `packages/pdf/src/serialize.ts`: `serializePdfDocument` emits the
      settings dict next to `meta` —
      `#show: atlcli-doc.with(meta: (...), settings: (...))` — and passes
      `options.settings` through `resolvePdfSettings`. Omitted settings
      must produce byte-identical `main.typ` semantics to today (defaults
      = current behavior).
- [ ] `packages/pdf/src/template.ts`: change the signature to
      `#let atlcli-doc(meta: (:), settings: (:), body)`; every settings
      read uses `settings.at("...", default: ...)`. Document in the file
      header that this function is the `atlcli.pdf-template/v1` surface:
      `render(meta, body, settings)` with the required `meta` keys from
      TEMPLATE-UX §7 (`title`, `space`, `version`, `author`, `language`,
      `exported-at`) — renaming `atlcli-doc` is not required, the contract
      names the shape, not the symbol.
- [ ] `packages/pdf/src/run-export.ts`: `RunPdfExportInput.settings?:
      PdfTemplateSettings`, forwarded to `serializePdfDocument` (line 127);
      `PdfExportReport` gains no new fields (settings are inputs, not
      outcomes).
- [ ] Export the new types from `packages/pdf/src/index.ts` and
      `index.browser.ts`.
- [ ] Docs: extend `docs/` PDF export reference with the settings table
      (type, default, constraints) per the docs standards in `CLAUDE.md`.

### Level-A settings (T2.2)

- [ ] `packages/pdf/src/template.ts` — page geometry: replace the fixed
      `paper: "a4"` with
      ```typst
      set page(
        paper: settings.at("page", default: "a4"),
        flipped: settings.at("orientation", default: "portrait") == "landscape",
        /* fill, margin, header, footer as before */
      )
      ```
      v1 supports exactly `a4 | letter` (Level A per TEMPLATE-UX §5.1);
      `legal`/`a3` from B8 stay behind the same validation switch and can
      be enabled later without a contract change.
- [ ] `packages/pdf/src/template.ts` — section toggles: wrap the cover
      block in `#if settings.at("cover", default: true) [ ... #pagebreak() ]`
      and the outline in `#if settings.at("outline", default: true) { ... }`.
      The colophon/end page keeps rendering unconditionally in this task
      (a `colophon` toggle is a one-line B8 follow-up once product naming
      is settled — see open questions).
- [ ] `packages/pdf/src/template.ts` — header/footer text:
      `settings.at("header-text", default: none)` replaces the
      `meta.title` / `meta.space` grid when set;
      `settings.at("footer-text", default: none)` renders left of the
      centered page number. Emission maps `headerText` → `header-text`
      (kebab-case keys on the Typst side, consistent with
      `exported-label`).
- [ ] `packages/pdf/src/settings.ts`: validation for the Level-A fields
      (page enum, orientation enum, header/footer length cap of 200
      chars to keep the header grid sane).
- [ ] Verify relative cover measurements (`v(37mm)`, `block(width: 90%)`
      in `template.ts` lines 116–139) on Letter/landscape; adjust to
      relative units where a fixed A4 assumption breaks (B8 risk note).

### Watermark (T2.3)

- [ ] `packages/pdf/src/template.ts`: add the watermark layer and wire it
      into the existing `set page(...)` call as `background:` — under the
      content, therefore automatically an Artifact in the tagged PDF
      (BASELINE-DESIGN B7; TEMPLATE-UX §8):
      ```typst
      #let watermark-layer(wm) = if wm == none { none } else {
        place(center + horizon, rotate(
          wm.at("angle", default: -54) * 1deg,
          text(
            font: "Source Sans 3",
            weight: "bold",
            size: wm.at("size", default: 96) * 1pt,
            fill: rgb(wm.at("color", default: "#DE350B"))
              .transparentize(100% - wm.at("opacity", default: 0.08) * 100%),
            wm.text,
          ),
        ))
      }
      // inside atlcli-doc:
      // set page(..., background: watermark-layer(settings.at("watermark", default: none)))
      ```
      Because Typst `set page` arguments cascade, the later
      `set page(fill: white)` / `set page(fill: cover-paper)` calls in the
      template keep the background rule — the watermark appears on cover,
      body, and end pages alike.
- [ ] `packages/pdf/src/settings.ts`: watermark validation — non-empty
      `text`, color normalized via the same `normalizeExportColor` path
      the theme uses, `opacity` clamped to (0, 1], `size` in 8..400 pt,
      `angle` in -180..180.
- [ ] Foreground layer is explicitly rejected (covers text, breaks
      copy/select); image watermarks are out of scope for v1 — record both
      in the docs page.

### Template library & container (T2.4)

- [ ] `packages/core/src/template-library.ts` (new, browser-safe, exported
      from `packages/core/src/index.ts` **and** `index.browser.ts`):
      ```ts
      export interface TemplateLibraryEntry {
        id: string; displayName: string; engine: "docx" | "typst";
        scope: "global" | "space"; spaceKey?: string;
        sha256: string; size: number; uploadedAt: string;
      }
      export interface TemplateLibrary {
        list(engine: TemplateLibraryEntry["engine"], spaceKey?: string): Promise<TemplateLibraryEntry[]>;
        getBytes(entry: TemplateLibraryEntry): Promise<Uint8Array>; // sha256-verified
      }
      export function resolveTemplate(
        entries: TemplateLibraryEntry[], id: string, spaceKey?: string
      ): TemplateLibraryEntry | undefined; // space entry beats global entry
      ```
      `resolveTemplate` is a pure function (two-level lookup: matching
      space-scoped entry wins over the global entry of the same id).
      Add `sha256Hex(bytes: Uint8Array): Promise<string>` on
      `crypto.subtle.digest` and `verifyTemplateBytes(entry, bytes)` that
      throws a typed mismatch error ("template was modified — re-upload",
      never a silent fallback). Scan verdicts for DOCX templates are
      **never** persisted in entries — always re-derived from bytes.
- [ ] `packages/template-pack/` (new isomorphic package, pure functions,
      PizZip dependency mirroring `packages/docx`):
      `src/manifest.ts` — manifest schema + `validateManifest(json)`:
      ```json
      {
        "schemaVersion": 1,
        "id": "com.acme.tech-doc",
        "name": "Acme Tech Doc",
        "version": "1.0.0",
        "engine": { "kind": "typst", "api": "atlcli.pdf-template/v1", "entry": "template.typ" },
        "settings": { "cover": { "type": "boolean", "default": true } },
        "provenance": { "sha256": "…", "createdWith": "atlcli 0.x" }
      }
      ```
      `engine.kind: "docx"` variant uses `api: "atlcli.docx-template/v1"`
      and `entry: "template.docx"`. Setting types are the bounded Level-A
      set: `text | boolean | choice | color | number | asset`.
- [ ] `packages/template-pack/src/pack.ts`: `packTemplate(files) →
      Uint8Array` — **deterministic zip**: entries sorted by path
      (manifest `atlcli-template.json` first), fixed DOS epoch timestamps,
      no platform extra fields; packing the same inputs twice yields
      byte-identical archives (this is what makes `provenance.sha256`
      meaningful).
- [ ] `packages/template-pack/src/unpack.ts`: `unpackTemplate(bytes) →
      { manifest, files }` with hard rejections: total size cap 20 MiB
      (reuse the `MAX_TEMPLATE_BYTES` value established in
      `packages/docx/src/scan.ts:30`; import the constant rather than
      duplicating the number if the dependency direction allows, otherwise
      define `MAX_TEMPLATE_PACK_BYTES` with a cross-reference comment),
      per-file cap, entry-count cap, **path-traversal rejection**
      (`..` segments, absolute paths, backslashes, drive letters), no
      symlink entries, `engine.entry` must exist in the archive, every
      archive file must be reachable from the manifest root (no
      out-of-tree references).
- [ ] `packages/template-pack/src/validate.ts`: `validatePack(bytes)` =
      unpack + manifest check + engine-specific hook: for
      `kind: "docx"` call `scanTemplate` from `@atlcli/docx` on the entry
      bytes and fail import on a rejecting verdict; for `kind: "typst"`
      structural checks only in this folder (compile-against-feature-zoo
      import gate is Level-B follow-up work in the host).
- [ ] `packages/template-pack/src/index.ts` + `index.browser.ts` exports;
      wire the package into the workspace + Turbo build.
- [ ] CLI surface `atlcli template pack|validate` (thin wrappers in
      `apps/cli/src/commands/`) may land here if cheap, otherwise moves to
      folder 008 with the other CLI work — the package API is the
      deliverable of this task.

### Fonts intake (B5 — engine seam only)

- [ ] `packages/pdf/src/types.ts`: add the port next to `PdfAssetResolver`:
      ```ts
      export interface FontAsset {
        family: string; style: "normal" | "italic"; weight: number;
        sha256: string;
        license?: { kind: "OFL" | "Apache-2.0" | "proprietary"; evidence: string };
      }
      export interface FontSource {
        list(): Promise<FontAsset[]>;
        getBytes(sha256: string): Promise<Uint8Array>;
      }
      ```
- [ ] `packages/pdf/src/fonts.ts` (new, pure): `parseFontMeta(bytes)` —
      sfnt-only acceptance via magic bytes `00 01 00 00` (TrueType),
      `OTTO` (CFF), `ttcf` (collection); read the `name` table (IDs
      1/2/16/17) for family/subfamily; 10 MB per-font cap. **WOFF/WOFF2
      (`wOFF`/`wOF2` magic) is rejected with guidance** ("web-packaged
      font detected — the PDF compiler consumes TTF/OTF; export the
      desktop font from your font source"), because the pinned Typst
      compiler consumes sfnt only.
- [ ] Document the host wiring (no engine code): hosts construct
      `new BrowserPdfCompiler({ wasm, fonts: [...bundledFonts,
      ...customFonts] })` — `BrowserPdfCompilerAssets.fonts` is already
      `Uint8Array[]` and `add_raw_font` accepts arbitrary extra fonts;
      no change in `packages/pdf-compiler-browser` is needed.
- [ ] Template manifests reference approved fonts as a `choice` setting
      whose options a host generates from `FontSource.list()` — keeping
      Level A's "font choice from an approved set" without free-form font
      input. Upload UI, license attestation flow, and storage are host
      follow-ups, not part of this folder.

### Follow-ups B6/B9/B10 (recorded, not implemented here)

- [ ] **B6 stationery/backgrounds** (follow-up spec): manifest `page` +
      `backgrounds` geometry from TEMPLATE-UX §7, rendered via Typst
      `set page(background: ...)` + `place`/`image(..., fit: "cover")`
      with first/body/last page roles; SVG first (native `image()`), PDF
      page embedding behind a spike against the pinned compiler version.
      Depends on this folder's settings threading and container format —
      capture as `specs/export-expansion/00x-stationery/`.
- [ ] **B9 table style source (DOCX)**: `tableStyle: { source: "template" |
      "confluence"; styleId? }` in `packages/docx` — small package, lands
      with the column-width work it synergizes with; out of Lane P.
- [ ] **B10 timezone/presets**: shared `zonedParts` in
      `packages/core/src/zoned-date.ts`, `PdfExportMetadata.timeZone`, and
      preset bundles `{templateId, settings}` — smaller package after the
      settings contract from this folder exists; fixes today's UTC
      (`serialize.ts:817-825`) vs. local-time (DOCX) inconsistency.

### Tests (no mocking)

Rule for this folder: **never mock**. Pure functions get direct
input/output tests; anything touching the compiler compiles for real
(the pattern already exists in
`packages/pdf-compiler-browser/src/compiler.test.ts`, which runs the
actual WASM with the real bundled fonts under `bun test`); anything
touching zips uses real archives built by the code under test.

- [ ] **Settings → Typst source goldens** —
      `packages/pdf/src/serialize.test.ts` (extend, existing
      `toContain`-assertion style): no settings ⇒ `main.typ` contains
      `settings: (` with defaults only and semantics identical to today;
      Letter+landscape ⇒ dict contains `page: "letter"` and
      `orientation: "landscape"`; header/footer text is `typstString`-
      escaped (quote/backslash/`#{` injection attempts stay literal);
      watermark settings serialize with defaults filled.
      `packages/pdf/src/settings.test.ts` (new): `resolvePdfSettings`
      rejects invalid enum/range values, fills defaults, is stable
      (deterministic output for equal input).
- [ ] **Template source assertions** — `packages/pdf/src/template.test.ts`
      (extend): generated `atlcli.typ` contains `watermark-layer`,
      `settings.at("page"`, `flipped:`, and the cover/outline `#if`
      guards; the template string still contains no unescaped `${`
      leftovers.
- [ ] **Compiled-PDF checks** —
      `packages/pdf-compiler-browser/src/compiler.test.ts` (extend; real
      compile, no mocks):
      - compile a small document with `settings: { page: "letter",
        orientation: "portrait", watermark: { text: "DRAFT" } }` through
        `serializePdfDocument` + `BrowserPdfCompiler`; assert zero
        diagnostics and `validatePdfOutput(...).tagged === true`, page
        count unchanged vs. the A4 run (background layers must not add
        pages).
      - **page size**: search the raw bytes (same `latin1` technique as
        `validate.ts`) for `/MediaBox [0 0 612 792]` (Letter) vs.
        `[0 0 595` (A4); if the pinned compiler stores page dictionaries
        in compressed object streams, inflate `FlateDecode` streams with
        `node:zlib` in the test before matching — still real bytes, no
        mocking.
      - **watermark text**: honest feasibility note — Typst subsets fonts
        and draws glyph IDs, so a plain byte search for "DRAFT" in
        content streams is *not* reliable; the compiled test asserts the
        watermark compiles cleanly and page structure is unchanged, and
        may additionally assert the string via the ToUnicode CMap after
        inflating streams if that proves stable. Authoritative text
        assertion happens in E2E with `pdftotext` (below). Source-level
        goldens (above) pin the exact Typst emitted.
- [ ] **`resolveTemplate` pure-function tests** —
      `packages/core/src/template-library.test.ts` (new): space entry
      beats global; global fallback when the space has no override;
      `undefined` on unknown id; wrong-engine entries never resolve;
      `verifyTemplateBytes` accepts matching bytes and throws the typed
      mismatch error on a flipped bit (hash real byte arrays — WebCrypto,
      no fakes).
- [ ] **Container round-trip with real zips** —
      `packages/template-pack/src/pack.test.ts` / `unpack.test.ts` (new):
      pack → `sha256Hex` → unpack yields identical file bytes and parsed
      manifest; packing twice is byte-identical (determinism); unpack
      rejects real crafted archives (built with PizZip in the test)
      containing `../evil.typ`, absolute paths, backslash paths, a
      missing `engine.entry`, an over-cap file, and an over-cap total;
      a `kind: "docx"` pack containing a real minimal `.docx` passes
      `validatePack`, a corrupted one fails with the scan verdict.
- [ ] **E2E (via folder 008's PDF CLI, profile `mayflower`, space
      `DOCSY`, project `ATLCLI`):** create a small test page in DOCSY,
      run `atlcli wiki export --format pdf` with `--page-size letter
      --watermark "DRAFT" --footer-text "Acme Confidential"` (exact flag
      spelling owned by folder 008); assert on the produced file:
      `pdftotext out.pdf - | grep DRAFT` (fallback: byte search for the
      Letter `/MediaBox` as in the compile test) and Letter page size;
      then **delete the test page** (cleanup rule from `CLAUDE.md`).
      This E2E runs before commit of the final wiring, per workflow
      rules.

## Definition of Done

- `PdfTemplateSettings` threads host → `RunPdfExportInput` →
  `PdfSerializeOptions` → `main.typ` → `atlcli-doc`; omitted settings
  reproduce today's output; `bun run typecheck` and `bun test` green.
- `atlcli.pdf-template/v1` documented in code (`template.ts` header) and
  in `docs/` (contract page: required `meta` keys, `settings` dict,
  defensive-read rule), marked stable for Level-B packages.
- Level A works end to end: A4/Letter, orientation, cover/outline
  toggles, header/footer text — each with a serialize golden and one real
  compile smoke per page format.
- Watermark renders as a background text layer, remains an Artifact in
  the tagged output (`validatePdfOutput` still reports `tagged`), with
  validated settings and documented defaults.
- `resolveTemplate` + sha256 verification live browser-safe in
  `packages/core` (exported from both entry points); `.atlcli-template`
  pack/unpack/validate is deterministic, traversal-safe, size-capped, and
  proven by round-trip tests on real archives for both `engine.kind`
  values.
- Font seam: `FontSource`/`FontAsset` exported, `parseFontMeta` accepts
  TTF/OTF/TTC and rejects WOFF2 with guidance; a real custom font added
  to `BrowserPdfCompilerAssets.fonts` is visible via `getLoadedFonts()`
  in a compile test.
- E2E on DOCSY performed with cleanup; no mocks anywhere in the new
  tests; `docs/` updated in the same PRs (docs are first-class).

## Risks & open questions

- **A4-tuned layout constants.** Cover spacing (`v(37mm)`,
  `block(width: 90%)`) and the header grid were designed on A4; Letter
  and landscape need visual verification — mitigated by one compile
  smoke per format plus the E2E, but a design pass may still be needed.
- **Compressed PDF structures.** If the pinned compiler emits page
  dictionaries and ToUnicode maps only inside object streams, the
  compiled-PDF assertions need the inflate step; if even that proves
  brittle, page-size/watermark byte assertions live only in E2E
  (`pdftotext`) and the unit layer stays at Typst-source goldens.
- **Settings schema versioning.** The manifest carries `schemaVersion` +
  `engine.api` from day one; adding a settings key is non-breaking
  (defensive `at(..., default:)` reads), removing/renaming one bumps the
  api string — document this policy with the contract.
- **Deterministic zips with PizZip.** PizZip must be pinned to emit
  stable headers (fixed timestamps, no extra fields); if it cannot,
  switch `packages/template-pack` to `fflate` before the format ships —
  decide during implementation, the public API does not change.
- **Watermark contrast/policy.** Default opacity 0.08 is conservative for
  dark covers; whether a space policy can *enforce* a watermark
  (admin lock) is a host/governance question — out of scope, tracked for
  the library follow-up.
- **Colophon toggle naming.** B8 proposes `colophon: boolean`; product
  wording for the end page is unsettled, so this plan ships cover/outline
  toggles only — confirm the third toggle's name before adding it.
- **Font glyph coverage.** A custom corporate font may lack glyphs (e.g.
  CJK) present in the document; a cmap preflight is expensive — open
  question whether a sampled warning ships with the seam or with the
  host upload UI.
- **Cross-package cap constant.** Reusing `MAX_TEMPLATE_BYTES` from
  `@atlcli/docx` inside `template-pack` creates a dependency direction
  question (pack is engine-neutral); duplicating the value with a
  comment may be the cleaner cut — decide at implementation time.
- **Who may set global templates?** The permission model for writing
  global vs. space entries is host-side governance (library follow-up),
  not solvable in the pure library abstraction.
