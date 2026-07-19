# 007 — PDF template settings & template library

Status: Plan, 2026-07-19. Folder `specs/export-expansion/007-pdf-template-settings`.

## Reference

- `specs/export-expansion/UMSETZUNGSPLAN.md` — Lane P (owner: `packages/pdf`),
  tasks T2.1 (settings threading + contract), T2.2 (Level-A settings),
  T2.3 (watermark), T2.4 (TemplateLibrary + `.wiki-pdf-template` container).
  T2.1 and T2.4 are listed under "immediately and independently startable".
- `specs/export-expansion/BASELINE-DESIGN.md` §2 Cluster B — B2 (global vs.
  space templates), B3 (`.wiki-pdf-template` container for both engines),
  B5 (font upload — engine seam only in this folder), B6 (stationery /
  backgrounds — follow-up), B7 (watermark), B8 (page size/orientation +
  section toggles), B9 (table style source, DOCX — smaller follow-up
  package), B10 (settings/timezone/presets — smaller follow-up package).
- `specs/export-expansion/007-pdf-template-settings/TEMPLATE-UX.md` — only
  §7 (minimal template contract `render(meta, body, settings)` as
  `wiki.pdf-template/v1`) and §9 (security and reproducibility rules) are
  normative for this folder. The product-levels model (§5), the Level-B/C
  wireframes (§6), and the market comparison (§2) are vision, not this
  folder's scope — Level A + the `.wiki-pdf-template` container are this
  folder's actual commitment; the full design-token migration and a second
  curated template are `012-pdf-template-migration/PLAN.md`.
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
- `packages/docx/src/scan.ts` — `MAX_TEMPLATE_BYTES = 20 MiB` (line 30),
  `unzipDocx` (caps only compressed input bytes before decompressing
  parts, see the risk entry below), and PizZip usage; the container
  reuses the zip dependency precedent but sets its own, larger caps
  (see T2.4) since it wraps the DOCX cap rather than replacing it.

## Goal & user value

Make PDF output configurable without a template studio, and make templates
shareable and centrally manageable:

1. **A stable template contract.** `wiki.pdf-template/v1` with
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
   bytes, plus a deterministic `.wiki-pdf-template` zip so a template built
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
  **One acknowledged exception on `types.ts`**: `008-pdf-cli/PLAN.md`'s
  T3.3 needs a small additive `PdfAssetRef.pageId` field on `types.ts`
  (new optional field, no signature change to existing exports) for
  page-scoped attachment resolution in tree/space PDF exports; it lands
  strictly after this folder's T2.1 merges. `template.ts`/`serialize.ts`
  stay untouched by that change. **`run-export.ts` post-emit abort-check
  bug**: `runPdfExport` re-checks `input.signal` immediately after
  `env.output.emit()` returns (`run-export.ts:165-173`), so a signal
  firing in that narrow window turns an already-committed file rename
  into a reported failure — flagged by 008 (which depends on correct
  abort/failure semantics for its CLI output sink) since it owns
  `run-export.ts` but the fix is in this folder's file. Fix as part of
  T2.1: move the post-`emit()` abort check before the rename/commit point
  (or drop it once the sink has already committed), so a completed export
  is never reported as failed.
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
                        = the wiki.pdf-template/v1 render surface
```

- **Contract:** `wiki.pdf-template/v1` is the Typst-side function shape
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

- [x] `packages/pdf/src/types.ts`: add `PdfTemplateSettings` (all fields
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
      export interface PdfLogoAsset {
        bytes: Uint8Array;
        mediaType: "image/png" | "image/svg+xml";
        alt?: string;   // required when the logo is meaning-bearing, see T2.2
      }
      export interface PdfTemplateSettings {
        page?: "a4" | "letter";
        orientation?: "portrait" | "landscape";
        cover?: boolean;
        outline?: boolean;
        headerText?: string;
        footerText?: string;
        accentColor?: string;        // "#RRGGBB", default the built-in indigo
        organizationName?: string;
        logo?: PdfLogoAsset;
        watermark?: PdfWatermarkSettings;
      }
      ```
      `accentColor`, `organizationName`, and `logo` close the Level-A gap
      TEMPLATE-UX §5.1 describes (accent color, organization name, logo are
      part of the curated-template settings form) that earlier drafts of
      this folder left unaddressed; they are plain Level-A fields on the
      same fixed interface as the geometry/toggle settings above, not a
      manifest-driven Level-B mechanism.
      `PdfTemplateSettings` covers only the fixed Level-A built-in fields
      above — it is **not** the same shape as a template-pack manifest's
      `settings` map (T2.4), which is an open, arbitrarily-named,
      typed dictionary (`accent`, `logo`, font choices, …) for Level-B
      templates. This folder does not thread manifest-declared custom
      settings into the render call (that requires the host-side
      Level-B template-loading glue, out of scope here per the Goal
      section); record the boundary explicitly in the file header so a
      later folder doesn't silently conflate the two shapes — see the
      "Built-in vs. manifest settings" risk below.
- [x] `packages/pdf/src/types.ts`: add `PdfSettingsError` next to the
      existing `PdfExportError` in `run-export.ts` — fields
      `{ path: string; value: unknown; constraint: string }` — so a
      thrown validation failure names the exact offending field instead
      of a free-text message a host would have to parse.
- [x] `packages/pdf/src/settings.ts` (new): `resolvePdfSettings(options?)`
      → fully-defaulted internal settings, **rejecting** (never silently
      clamping) invalid values by throwing `PdfSettingsError` in the
      `resolvePdfTheme` style: unknown page size, opacity outside
      `(0, 1]` — `0`, `NaN`, and `Infinity` are explicit reject cases,
      not clamp targets (this supersedes any "clamped" wording under
      T2.3 below — reject is the one behavior for all range fields) —
      header/footer text over the 200-char cap, empty watermark text;
      plus `typstSettingsDict(resolved)` emitting the Typst dictionary
      literal via `typstString`.
- [x] `packages/pdf/src/run-export.ts`: call `resolvePdfSettings(input.settings)`
      as the **first** step of `runPdfExport`, before `env.assets` is
      touched — settings validation must not pay for asset fetches
      (network requests for attachments) it will end up discarding. Add
      a `"configuration"` phase ahead of `"preparing"` to both
      `PdfExportPhase` and `PdfExportErrorPhase`; a thrown
      `PdfSettingsError` is wrapped with `phase: "configuration"`,
      distinct from `"prepare"` (today the only failure phase covering
      this stage, per `run-export.ts:40-55` — reusing it would make
      settings typos indistinguishable from asset-fetch failures in the
      CLI/extension error UI). `RunPdfExportInput.settings?:
      PdfTemplateSettings`, the resolved value forwarded to
      `serializePdfDocument`; `PdfExportReport` gains no new fields
      (settings are inputs, not outcomes).
- [x] `packages/pdf/src/serialize.ts`: `serializePdfDocument` accepts the
      already-resolved settings and emits the settings dict next to
      `meta` — `#show: atlcli-doc.with(meta: (...), settings: (...))`.
      Omitted settings must produce byte-identical `main.typ` semantics
      to today (defaults = current behavior).
- [x] `packages/pdf/src/template.ts`: change the signature to
      `#let atlcli-doc(meta: (:), settings: (:), body)` — `settings: (:)`
      is itself the backward-compatible default, so old callers that
      never pass `settings` keep compiling; every settings read uses
      `settings.at("...", default: ...)`. Document in the file header
      that this function is the `wiki.pdf-template/v1` surface:
      `render(meta, body, settings)` with the required `meta` keys from
      TEMPLATE-UX §7 (`title`, `space`, `version`, `author`, `language`,
      `exported-at`) — renaming `atlcli-doc` is not required, the contract
      names the shape, not the symbol. **Freeze the full v1 import
      surface, not just `atlcli-doc`:** `serialize.ts` currently imports
      eight symbols from `atlcli.typ` — `atlcli-doc, callout,
      status-badge, table-par, dense-token, dense-link,
      dense-status-badge, task-item` (`serialize.ts:847`) — while
      TEMPLATE-UX §7 prohibits generated content depending on
      "undocumented template-local functions" and names only
      `atlcli-doc`/`callout`/`status-badge` as needing the boundary.
      Document all eight as the stable v1 hook set a conforming template
      must export (simplest cut for this folder — no Level-B loading
      glue exists yet to make relocating the other five worthwhile) and
      note in the same section that shrinking this set is a deliberate
      follow-up once a real external template needs to override fewer
      hooks.
- [x] Export the new types from `packages/pdf/src/index.ts` and
      `index.browser.ts`.
- [x] Docs: extend `docs/` PDF export reference with the settings table
      (type, default, constraints) per the docs standards in `CLAUDE.md`.

### Level-A settings (T2.2)

- [x] `packages/pdf/src/template.ts` — page geometry: replace the fixed
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
- [x] `packages/pdf/src/template.ts` — section toggles: each toggle must
      wrap its **own trailing `pagebreak()`**, not just its content — in
      the current source the cover's `pagebreak()` sits right after the
      cover block, but the outline's `pagebreak()` is a *separate*
      statement after `outline(...)` (`template.ts:142-144`), so a
      literal `#if outline [ outline(...) ]` would leave that
      `pagebreak()` running unconditionally and produce a blank page
      whenever `outline: false` (worst case with `cover: false` too: two
      stray blank pages before the body). Concretely:
      `#if settings.at("cover", default: true) [ ... #pagebreak() ]` and
      `#if settings.at("outline", default: true) { outline(title:
      contents-label, depth: 3); pagebreak() }` — the intervening
      `set page(fill: white)` stays unconditional (it only affects the
      *next* content, whichever section supplies it). The colophon/end
      page keeps rendering unconditionally in this task (a `colophon`
      toggle is a one-line B8 follow-up once product naming is settled —
      see open questions).
- [x] `packages/pdf/src/template.ts` — header/footer text:
      `settings.at("header-text", default: none)` replaces the
      `meta.title` / `meta.space` grid when set;
      `settings.at("footer-text", default: none)` renders left of the
      centered page number. Emission maps `headerText` → `header-text`
      (kebab-case keys on the Typst side, consistent with
      `exported-label`).
- [x] `packages/pdf/src/template.ts` — accent color, organization name,
      logo: `settings.at("accent-color", default: "#4B57A3")` replaces
      the hard-coded indigo accent wherever the template references it
      (cover rule, heading accent, table header); `settings.at(
      "organization-name", default: none)` renders next to the existing
      `meta.space`/title branding on cover and footer when set; a
      resolved `logo` settings entry places the raster/vector image on
      the cover (and header, if already reserved space allows) via
      `image(...)`, never widening the fixed layout grid — same
      `typstString`/asset-path emission pattern as the watermark and
      font seams elsewhere in this folder.
- [x] `packages/pdf/src/settings.ts`: validation for the Level-A fields
      (page enum, orientation enum, header/footer length cap of 200
      chars to keep the header grid sane), plus for the new fields:
      `accentColor` normalized via the same `normalizeExportColor` path
      the theme/watermark use; `organizationName` capped at 200 chars;
      `logo` validated against TEMPLATE-UX §9.5's stationery security
      rules, restated here as this folder's checkable Level-A criteria:
      PNG or **sanitized** SVG only (SVG runs through the existing
      svg-safety pipeline shared with 006's sanitizer — see
      `011-quality-gates/PLAN.md`'s cross-plan SVG conformance gate — no
      script/foreignObject/on*/external references survive), a hard
      5 MiB cap (reject, don't downscale), no externally-referenced
      assets (bundled bytes only, mirroring the font-intake seam's
      byte-in model), and a required, non-empty `alt` whenever the logo
      is not purely decorative (empty `alt` is only valid alongside an
      explicit `decorative: true`-equivalent marker in a future Level-B
      manifest; for this folder's fixed Level-A shape, a present `logo`
      always requires a present `alt`, rejected otherwise with a
      `PdfSettingsError`).
- [x] Verify relative cover measurements (`v(37mm)`, `block(width: 90%)`
      in `template.ts` lines 116–139) on Letter/landscape; adjust to
      relative units where a fixed A4 assumption breaks (B8 risk note).

### Watermark (T2.3)

- [x] `packages/pdf/src/template.ts`: add the watermark layer and wire it
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
- [x] `packages/pdf/src/settings.ts`: watermark validation — non-empty
      `text`, color normalized via the same `normalizeExportColor` path
      the theme uses, `opacity` **rejected** (not clamped — see T2.1's
      `resolvePdfSettings` bullet) outside `(0, 1]`, `size` in 8..400 pt,
      `angle` in -180..180 — all four throw the same `PdfSettingsError`
      shape as the Level-A fields.
- [x] Foreground layer is explicitly rejected (covers text, breaks
      copy/select); image watermarks are out of scope for v1 — record both
      in the docs page.

### Template library & container (T2.4)

- [x] `packages/core/src/template-library.ts` (new, browser-safe, exported
      from `packages/core/src/index.ts` **and** `index.browser.ts`; this
      folder owns this file and the new `packages/template-pack/`
      package — see the file-ownership note below for the sync point
      with folder 011, which also touches this path):
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
        entries: TemplateLibraryEntry[], id: string, engine: TemplateLibraryEntry["engine"], spaceKey?: string
      ): TemplateLibraryEntry | undefined; // space entry beats global entry
      export class TemplateResolutionConflictError extends Error {}
      export function resolveAndLoadTemplate(
        library: TemplateLibrary, id: string, engine: TemplateLibraryEntry["engine"], spaceKey?: string
      ): Promise<{ entry: TemplateLibraryEntry; bytes: Uint8Array }>;
      ```
      `resolveTemplate` is a pure function (two-level lookup: matching
      space-scoped entry wins over the global entry of the same id) that
      now takes `engine` explicitly rather than relying on callers to
      pre-filter `entries` — a caller that (accidentally or via a stale
      cache) passes a mixed-engine list must still never resolve a
      wrong-engine entry, matching the test in this folder's suite (see
      Tests below). Two same-scope, same-engine entries sharing an `id`
      are a data-integrity bug, not an ordering question: `resolveTemplate`
      throws `TemplateResolutionConflictError` rather than silently
      picking the first array match. Add `sha256Hex(bytes: Uint8Array):
      Promise<string>` on `crypto.subtle.digest`, `verifyTemplateBytes(entry,
      bytes)` that throws a typed mismatch error ("template was modified —
      re-upload", never a silent fallback), and the single public
      `resolveAndLoadTemplate` convenience path that performs selection,
      the entry's declared-`size` check, byte loading via
      `library.getBytes`, and `verifyTemplateBytes` as one inseparable
      call — so a host adapter cannot wire `getBytes` without going
      through verification by construction; `TemplateLibrary.getBytes`'s
      "sha256-verified" comment is a contract obligation on host
      implementers, `resolveAndLoadTemplate` is what removes the
      footgun for the common path. Scan verdicts for DOCX templates are
      **never** persisted in entries — always re-derived from bytes.
- [x] `packages/template-pack/` (new isomorphic package, pure functions,
      PizZip dependency mirroring `packages/docx`):
      `src/manifest.ts` — manifest schema + `validateManifest(json)`:
      ```json
      {
        "schemaVersion": 1,
        "id": "com.acme.tech-doc",
        "name": "Acme Tech Doc",
        "version": "1.0.0",
        "engine": { "kind": "typst", "api": "wiki.pdf-template/v1", "entry": "template.typ", "compilerRange": ">=0.14 <0.15" },
        "requiredFonts": [{ "family": "Source Sans 3", "style": "normal", "weight": 400 }],
        "settings": { "cover": { "type": "boolean", "default": true } },
        "provenance": { "payloadSha256": "…", "createdWith": "atlcli 0.x" }
      }
      ```
      `requiredFonts` is a declarative array (shape mirrors this folder's
      `FontAsset` sans `sha256`/`license` — just `family`/`style`/`weight`)
      documenting which faces a template needs; `validateManifest` only
      checks the field's shape in this folder, it does **not** cross-check
      availability against a `FontSource` or the bundled runtime fonts —
      that check needs the Level-B template-loading glue this folder
      doesn't build (see the Goal section and the "Built-in vs. manifest
      settings" risk). Declaring the field now, even unenforced, avoids a
      manifest `schemaVersion` bump the first time a later folder needs it.
      `engine.kind: "docx"` variant uses `api: "wiki.docx-template/v1"`
      and `entry: "template.docx"`. Setting types are the bounded Level-A
      set: `text | boolean | choice | color | number | asset`.
      `validateManifest` is the **import gate** (TEMPLATE-UX §9 "pinned
      template API and compiler compatibility range"), not just a shape
      check: it rejects an unknown `schemaVersion` (only `1` is
      recognized at ship time), an `engine.api` string that doesn't match
      a known `wiki.{pdf,docx}-template/v1` value, and — for the Typst
      engine — a `compilerRange` that the pinned compiler version
      (`PDF_BROWSER_COMPILER_VERSION` in
      `packages/pdf-compiler-browser/src/compiler.ts:12`) does not
      satisfy; each rejection carries a typed, actionable reason
      (`unknown-schema-version | unknown-api | compiler-range-mismatch`)
      rather than a generic parse error, so a host can render an
      upgrade/downgrade hint instead of a raw exception. Actually
      invoking the compiler to verify `compilerRange` (vs. just
      range-checking the pinned version string) stays a pure
      string/semver comparison in this folder — the "compile against the
      canonical feature zoo" gate from TEMPLATE-UX §9 remains the
      already-deferred Level-B host follow-up.
- [x] `packages/template-pack/src/pack.ts`: `packTemplate(files) →
      Uint8Array` — **deterministic zip**: entries sorted by path
      (manifest `wiki-pdf-template.json` first), fixed DOS epoch timestamps,
      no platform extra fields; packing the same inputs twice yields
      byte-identical archives. **`provenance.payloadSha256` must not be
      self-referential**: the manifest that ships inside the archive
      cannot contain the hash of that same archive's bytes (the field
      would have to be known before it's written). Define it precisely
      as the digest of a canonicalized payload description — sorted
      `(path, byteLength, sha256)` triples for every archive member
      *except* the manifest itself, newline-joined, then hashed — computed
      by `pack.ts` in one pass (no second pack round needed) and written
      into the manifest before the manifest entry is serialized.
      `TemplateLibraryEntry.sha256` (T2.4, entry metadata, not inside the
      archive) stays the separate, unambiguous "hash of the delivered
      archive bytes as stored" used for the integrity check on download —
      the two fields answer different questions and both must be
      documented as such.
- [x] `packages/template-pack/src/unpack.ts`: `unpackTemplate(bytes) →
      { manifest, files }` with hard rejections: total size cap **30 MiB**
      for the outer `.wiki-pdf-template` archive and **64 MiB** cumulative
      uncompressed payload (zip-bomb guard via declared-size accounting
      during extraction, not just compressed-byte counting) — these are
      the values folder 011's security-hardening task proposes for this
      exact reader
      (`specs/export-expansion/011-quality-gates/PLAN.md:271-275`); this
      folder is the canonical owner of the reader and exports the cap
      constants (`MAX_TEMPLATE_PACK_BYTES`, `MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES`)
      from `packages/template-pack`, 011 imports them rather than
      re-declaring its own numbers (see the file-ownership risk entry —
      011's current text also names `packages/core/src/template-library.ts`
      as the reader location, which this folder's split into
      `packages/template-pack` supersedes; 011 needs a matching update,
      tracked in `crossPlanImpacts`). Per-file cap, entry-count cap,
      **path-traversal rejection** (`..` segments, absolute paths,
      backslashes, drive letters), no symlink entries, `engine.entry`
      must exist in the archive, every archive file must be reachable
      from the manifest root (no out-of-tree references). The inner
      DOCX cap (`MAX_TEMPLATE_BYTES = 20 MiB` in
      `packages/docx/src/scan.ts:30`) is unrelated and unchanged — it
      still applies to `template.docx` once unpacked from a
      `kind: "docx"` container, and is itself smaller than the outer
      caps above so a compliant container can never smuggle an
      over-cap DOCX payload through size checks alone.
- [x] `packages/template-pack/src/validate.ts`: `validatePack(bytes)` =
      unpack + manifest check + engine-specific hook: for `kind: "docx"`,
      `scanTemplate` (`packages/docx/src/scan.ts`) returns classification
      buckets (`supported/unsupported/never`) and `hasContentPlaceholder`
      — it has **no** "rejecting verdict" concept to fail on. Define the
      actual import policy here instead of assuming one exists: a
      package-level failure (`DocxError` from `scanTemplate`/`unzipDocx`)
      is fatal to `validatePack`; `never`-classified placeholders are a
      **warning** in the returned report, not a rejection (the same
      placeholders are an accepted, silently-empty case in the live
      product per `apps/extension/entrypoints/sidepanel/TemplateSection.tsx:372-399`);
      a missing `hasContentPlaceholder` is **not** a rejection either —
      it is the documented append-before-final-section-break fallback
      the same component already surfaces, so `validatePack` must not
      invent a stricter rule than the existing scan/export path enforces.
      `validatePack` returns a typed `{ ok: boolean; manifest;
      scanReport?: ScanResult; issues: PackIssue[] }` result rather than
      throwing on anything but package corruption. For `kind: "typst"`,
      structural checks only in this folder (compile-against-feature-zoo
      import gate stays the deferred Level-B follow-up noted above).
- [x] `packages/template-pack/src/index.ts` + `index.browser.ts` exports;
      wire the package into the workspace + Turbo build.
- [x] CLI surface: commit to `atlcli template-pack pack|validate` (matching
      the package name) rather than either candidate already floating
      across the docs — plain `atlcli template pack|validate`
      (BASELINE-DESIGN §B3's generalization) collides in spirit with the
      existing, unrelated `atlcli wiki template` command (Confluence
      page/Word templates, `apps/cli/src/commands/template.ts`, already
      has its own `validate` subcommand); a user typing `atlcli template
      ...` would reasonably expect that system, even though the parser
      would not literally conflict. `atlcli pdf-template pack|validate`
      (TEMPLATE-UX §5.2) is wrong for the opposite reason: this task's
      `packTemplate`/`validatePack` cover **both** `engine.kind` values
      (`docx` and `typst`, per the manifest schema above), so naming the
      DOCX-container path "pdf-template" would mislabel it. Reserve
      `atlcli pdf-template init|preview|...` for the larger, still
      out-of-scope Level-B Typst-authoring workflow TEMPLATE-UX §5.2
      describes (that surface needs the compiler and the feature-zoo
      preview, neither of which this folder builds) — `pack`/`validate`
      may still be aliased there later without breaking
      `template-pack pack|validate`. Thin wrappers in
      `apps/cli/src/commands/` may land here if cheap, otherwise the
      command surface moves to folder 008 with the other CLI work —
      either way the namespace decision ships with this folder so 008
      has a fixed target instead of the open "likely `--pdf-template`"
      note it currently carries
      (`specs/export-expansion/008-pdf-cli/PLAN.md:807`; tracked in
      `crossPlanImpacts`). The `packages/template-pack` API is the
      deliverable of this task regardless of where the CLI wrapper lands.

### Hardcoding ledger, lite (T2.5)

This folder migrates a handful of Level-A values (page geometry, section
toggles, header/footer text, accent color, organization name, logo,
watermark) out of `template.ts`'s hardcoded literals; everything else this
folder touches — typography roles, color tokens, semantic palettes,
component spacing, cover/header/footer/closing-page layout — stays
hardcoded on purpose (that full migration is `012`'s scope, not this
folder's). Without a record of what's deliberately left behind, 012 would
have to rediscover it by re-reading `template.ts` line by line.

- [ ] A small, dated ledger — either a Markdown table in this folder
      (`specs/export-expansion/007-pdf-template-settings/HARDCODING-LEDGER.md`)
      or an equivalent comment block directly above the relevant constants
      in `packages/pdf/src/template.ts` (pick one, don't duplicate) —
      listing every design-relevant hardcoded value this folder's tasks
      leave in place: fonts/faces, page margins, typography sizes/weights,
      color tokens (indigo accent, ink, muted, border, code/table-header
      backgrounds, mention, task colors), semantic palettes (callouts,
      statuses), component spacing (paragraph/heading/list/code/callout/
      badge/table), and cover/header/footer/closing-page offsets. This is
      a **restatement** of what's already hardcoded after this folder
      lands — not new scope, not a migration — so it can be produced
      mechanically from a read-through of `template.ts` once T2.1–T2.4
      merge.
- [ ] A lint stub (heuristic, not a full parser):
      `packages/pdf/scripts/check-hardcoding-ledger.ts`, wired into
      `bun run typecheck` or a dedicated `bun run lint:pdf-ledger` script
      — greps `template.ts` for new bare hex-color literals
      (`#[0-9a-fA-F]{6}`), new bare `pt`/`mm`/`em` length literals, and new
      font-family string literals, and fails with a named line/column if
      one appears outside the ledger's recorded set and outside a narrow,
      commented allowlist (e.g. values that are structurally required by
      the engine, not presentation — mirrors the "engine invariant
      allowlist" idea `012` formalizes). False positives are acceptable
      (heuristic, not authoritative); the point is to make a new
      unledgered hardcoded value visible in review, not to block on every
      edge case.
- [ ] Reference `012-pdf-template-migration/PLAN.md` from both the ledger
      file/comment and the lint stub's own header comment: 012 starts from
      this ledger as its migration inventory rather than re-deriving it.

### Fonts intake (B5 — engine seam only)

- [x] `packages/pdf/src/types.ts`: add the port next to `PdfAssetResolver`:
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
- [x] `packages/pdf/src/fonts.ts` (new, pure): `parseFontMeta(bytes)` —
      sfnt-only acceptance via magic bytes `00 01 00 00` (TrueType),
      `OTTO` (CFF), `ttcf` (collection); read the `name` table (IDs
      1/2/16/17) for family/subfamily — for `ttcf` collections, parse
      *every* font entry in the collection header and return one
      `FontAsset`-shaped record per face (a TTC bundles multiple
      family/style faces under one file; treating it as a single face
      silently drops the others from the approved-font list); 10 MB
      per-font cap. **WOFF/WOFF2 (`wOFF`/`wOF2` magic) is rejected with
      guidance** ("web-packaged font detected — the PDF compiler
      consumes TTF/OTF; export the desktop font from your font source"),
      because the pinned Typst compiler consumes sfnt only. Negative
      tests cover truncated headers (magic bytes present, `name` table
      offset points past `bytes.length`), a `numTables`/table-directory
      value large enough to read out of bounds, and a zero-length
      buffer — `parseFontMeta` must reject cleanly, never throw an
      unrelated `RangeError` from an unchecked array read.
- [x] `packages/pdf/src/fonts.ts`: `verifyFontBytes(asset: FontAsset,
      bytes: Uint8Array): Promise<void>` — hashes `bytes` via
      `sha256Hex` (mirroring `verifyTemplateBytes`'s pattern from T2.4)
      and throws a typed mismatch error when it disagrees with
      `asset.sha256`. This is a **required** step between
      `FontSource.getBytes(sha256)` and constructing
      `BrowserPdfCompilerAssets.fonts`: today nothing ties the bytes a
      `FontSource` returns to the `sha256`/license record a host looked
      up before handing them to `add_raw_font`
      (`packages/pdf-compiler-browser/src/compiler.ts:43`), so a
      corrupted or swapped delivery would embed the wrong font under the
      approved font's license claim with no error. Document the call as
      mandatory host wiring next to the `BrowserPdfCompiler` construction
      note below.
- [x] Document the host wiring (no engine code): hosts construct
      `new BrowserPdfCompiler({ wasm, fonts: [...bundledFonts,
      ...(await Promise.all(customFonts.map(async (f) => { const bytes =
      await fontSource.getBytes(f.sha256); await verifyFontBytes(f,
      bytes); return bytes; })))] })` — `BrowserPdfCompilerAssets.fonts`
      is already `Uint8Array[]` and `add_raw_font` accepts arbitrary
      extra fonts; no change in `packages/pdf-compiler-browser` is
      needed.
- [x] Template manifests reference approved fonts as a `choice` setting
      whose options a host generates from `FontSource.list()` — keeping
      Level A's "font choice from an approved set" without free-form font
      input. Upload UI, license attestation flow, and storage are host
      follow-ups, not part of this folder.

### Follow-ups B6/B10 (recorded, not implemented here)

- [ ] **B6 stationery/backgrounds** (follow-up spec): manifest `page` +
      `backgrounds` geometry from TEMPLATE-UX §7, rendered via Typst
      `set page(background: ...)` + `place`/`image(..., fit: "cover")`
      with first/body/last page roles; SVG first (native `image()`), PDF
      page embedding behind a spike against the pinned compiler version.
      Depends on this folder's settings threading and container format —
      capture as `specs/export-expansion/00x-stationery/`.
- **B9 table style source (DOCX)**: no longer a recorded-only follow-up —
  `006-word-quality/PLAN.md`'s G3b task (`tableStyle: { source: "template" |
  "confluence"; styleId? }` in `packages/docx`) implements it directly,
  landing with 006's column-width work; out of Lane P, done there instead
  of here.
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

- [x] **Settings → Typst source goldens** —
      `packages/pdf/src/serialize.test.ts` (extend, existing
      `toContain`-assertion style): no settings ⇒ `main.typ` contains
      `settings: (` with defaults only and semantics identical to today;
      Letter+landscape ⇒ dict contains `page: "letter"` and
      `orientation: "landscape"`; header/footer text is `typstString`-
      escaped (quote/backslash/`#{` injection attempts stay literal);
      watermark settings serialize with defaults filled.
      `packages/pdf/src/settings.test.ts` (new): `resolvePdfSettings`
      rejects (never clamps) invalid enum/range values via
      `PdfSettingsError`, including boundary cases `0`, `NaN`, and
      `Infinity` for `opacity`; fills defaults; is stable (deterministic
      output for equal input); error objects carry `path`/`value`/
      `constraint`.
- [x] **Fail-fast ordering** — `packages/pdf/src/run-export.test.ts`
      (extend): `runPdfExport` with an invalid `settings` object throws
      `PdfSettingsError` with `phase: "configuration"` **and**
      `PdfAssetResolver.resolve` is never called (assert call count `0`
      on the real resolver test double already used in this file's
      other cases) — settings validation runs before any asset fetch.
- [x] **Template source assertions** — `packages/pdf/src/template.test.ts`
      (extend): generated `atlcli.typ` contains `watermark-layer`,
      `settings.at("page"`, `flipped:`, and the cover/outline `#if`
      guards, with each guard wrapping its trailing `pagebreak()` (assert
      the `pagebreak()` call sites are *inside* the `#if` block bodies,
      not just present in the file); the template string still contains
      no unescaped `${` leftovers.
- [x] **Compiled-PDF checks** —
      `packages/pdf-compiler-browser/src/compiler.test.ts` (extend; real
      compile, no mocks):
      - compile a small document with `settings: { page: "letter",
        orientation: "portrait", watermark: { text: "DRAFT" } }` through
        `serializePdfDocument` + `BrowserPdfCompiler`; assert zero
        diagnostics and `validatePdfOutput(...).tagged === true`, page
        count unchanged vs. the A4 run (background layers must not add
        pages).
      - **cover/outline page-count matrix**: compile all four
        combinations of `cover`/`outline` booleans against the same
        fixture document and assert the exact expected page count for
        each (`cover: true, outline: true` = today's baseline; disabling
        either or both must reduce the count by exactly one page per
        disabled section, never leave a blank page) — this is the
        regression test for the pagebreak-encapsulation fix above.
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
      - **watermark Artifact status**: honest feasibility note —
        `validatePdfOutput(...).tagged` only checks that
        `/StructTreeRoot` and `/MarkInfo` exist *somewhere* in the file
        (`validate.ts:15-20`), not that the watermark's own marked
        content is specifically tagged `/Artifact` with no MCID
        referenced from the struct tree. If a stable way to isolate and
        assert that from the raw/inflated bytes is found, add it here;
        otherwise this compiled test only proves "watermark renders,
        document stays tagged overall" — see the Definition of Done
        wording change and the corresponding risk entry below for what
        is and isn't proven at this layer.
- [x] **Font verification** — `packages/pdf/src/fonts.test.ts` (extend):
      `verifyFontBytes` accepts bytes matching `asset.sha256` and throws
      the typed mismatch error on a flipped bit (real bytes, WebCrypto —
      no fakes, mirroring the template-library hash tests); `parseFontMeta`
      returns one entry per face for a real multi-face `ttcf` fixture;
      negative tests (truncated header, out-of-range table offsets, empty
      buffer) reject cleanly without throwing an unrelated `RangeError`.
- [x] **`resolveTemplate` pure-function tests** —
      `packages/core/src/template-library.test.ts` (new): space entry
      beats global; global fallback when the space has no override;
      `undefined` on unknown id; a same-id entry of the *other* engine in
      the same (mixed-engine) `entries` array never resolves, even when
      it would otherwise be the only match; two same-scope/same-engine
      entries sharing an `id` throw `TemplateResolutionConflictError`
      instead of returning the first array match; `verifyTemplateBytes`
      accepts matching bytes and throws the typed mismatch error on a
      flipped bit (hash real byte arrays — WebCrypto, no fakes);
      `resolveAndLoadTemplate` against a real in-test `TemplateLibrary`
      returns verified bytes on a match and rejects on a byte/hash
      mismatch without ever exposing the un-verified bytes to the
      caller.
- [x] **Container round-trip with real zips** —
      `packages/template-pack/src/pack.test.ts` / `unpack.test.ts` (new):
      pack → `sha256Hex` → unpack yields identical file bytes and parsed
      manifest; packing twice is byte-identical (determinism);
      `provenance.payloadSha256` is stable across repacks and changes
      when any non-manifest file's bytes change, computed via the
      canonicalization defined above (fixed test vectors, not just
      "some hash changed"); unpack rejects real crafted archives (built
      with PizZip in the test) containing `../evil.typ`, absolute paths,
      backslash paths, a missing `engine.entry`, a file over the per-file
      cap, an archive over the 30 MiB outer cap, and a small compressed
      archive whose declared uncompressed sizes exceed the 64 MiB
      cumulative cap (zip-bomb case, assert extraction aborts on
      declared size before fully inflating); manifest fixtures for an
      unknown `schemaVersion`, an unrecognized `engine.api`, and a
      `compilerRange` the pinned compiler doesn't satisfy each fail
      `validateManifest` with the matching typed reason; a `kind: "docx"`
      pack containing a real minimal `.docx` passes `validatePack` with
      an empty `issues` array, one containing only `never`-classified
      placeholders passes with a non-empty warning `issues` array (not a
      rejection), and a corrupted inner `.docx` fails with `ok: false`
      and the package-level error surfaced in `issues`.
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
  reproduce today's output; invalid settings fail with `PdfSettingsError`
  at `phase: "configuration"` **before** any asset fetch runs;
  `bun run typecheck` and `bun test` green.
- `wiki.pdf-template/v1` documented in code (`template.ts` header) and
  in `docs/` (contract page: required `meta` keys, `settings` dict,
  defensive-read rule, and the full set of symbols `serialize.ts` imports
  from `atlcli.typ` — not just `atlcli-doc`), marked stable for Level-B
  packages.
- Level A works end to end: A4/Letter, orientation, cover/outline
  toggles, header/footer text, accent color, organization name, and logo
  — each with a serialize golden and one real compile smoke per page
  format; all four `cover`×`outline` toggle combinations produce the
  exact expected page count with no stray blank pages; logo settings
  reject non-PNG/unsanitized-SVG input, over-cap bytes, externally
  referenced assets, and a missing `alt` on a non-decorative logo, each
  with a negative test.
- Watermark renders as a background text layer, is placed via `set
  page(background: ...)` so it is a page Artifact by Typst's own
  page-background semantics (TEMPLATE-UX §8) and the document stays
  overall-tagged (`validatePdfOutput` still reports `tagged`), with
  validated settings and documented defaults. The compiled-PDF test
  layer does **not** independently prove the watermark's marked content
  carries no MCID in the struct tree — that remains an open
  verification gap, tracked below and as a candidate gate for folder
  011's veraPDF/PDF-UA work rather than an unqualified DoD claim here.
- `resolveTemplate` (engine-aware, conflict-checked) + `sha256Hex` +
  `verifyTemplateBytes` + `resolveAndLoadTemplate` live browser-safe in
  `packages/core` (exported from both entry points); `.wiki-pdf-template`
  pack/unpack/validate is deterministic, traversal-safe, size-capped
  (30 MiB archive / 64 MiB uncompressed, exported as named constants),
  schema/API/compiler-range-gated on import, and proven by round-trip
  tests on real archives for both `engine.kind` values, including a
  documented, unambiguous `provenance.payloadSha256` definition.
- Font seam: `FontSource`/`FontAsset` exported, `parseFontMeta` accepts
  TTF/OTF/TTC (all faces of a collection) and rejects WOFF2 with
  guidance, `verifyFontBytes` gates every custom font before it reaches
  the compiler; a real custom font added to
  `BrowserPdfCompilerAssets.fonts` is visible via `getLoadedFonts()` in
  a compile test.
- E2E on DOCSY performed with cleanup; no mocks anywhere in the new
  tests; `docs/` updated in the same PRs (docs are first-class).

## Risks & open questions

- **Settings become code injection.** `PdfTemplateSettings` values
  (`headerText`, `footerText`, `organizationName`, `watermark.text`,
  and any future free-text Level-A field) are host-supplied strings that
  reach generated Typst source. **STOP condition**: every settings value
  that reaches `main.typ` must go through `typstString` or another typed
  constructor in `packages/pdf/src/escape.ts` — a raw string
  concatenation of a settings value into the Typst source (an f-string,
  template literal, or `+`-join that isn't `typstString(...)`) is a
  blocker finding in review, not a style nit, regardless of whether a
  test happens to catch it. This mirrors the source contract's own
  "settings become code injection" STOP condition (PR #48 §14): settings
  are data, never code, and the boundary is enforced by construction
  (typed emitters), not by hoping every call site remembers to escape.
  The existing "Settings → Typst source goldens" test task already
  covers escaping for `headerText`/`footerText`/watermark text; extend
  the same goldens to `organizationName` and any other new free-text
  Level-A field as they land.
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
  `engine.api` + `engine.compilerRange` from day one and `validateManifest`
  rejects unknown/incompatible values at import (see T2.4); adding a
  settings key is non-breaking (defensive `at(..., default:)` reads),
  removing/renaming one bumps the api string — document this policy with
  the contract.
- **Deterministic zips with PizZip.** PizZip must be pinned to emit
  stable headers (fixed timestamps, no extra fields); if it cannot,
  switch `packages/template-pack` to `fflate` before the format ships —
  decide during implementation, the public API does not change.
- **Watermark contrast/policy.** Default opacity 0.08 is conservative for
  dark covers; whether a space policy can *enforce* a watermark
  (admin lock) is a host/governance question — out of scope, tracked for
  the library follow-up.
- **Watermark Artifact claim is a page-background inference, not a
  compiled-structure proof.** `validatePdfOutput` only asserts the
  document is tagged overall (`/StructTreeRoot` + `/MarkInfo` present
  anywhere); nothing in this folder's test layer parses the struct tree
  to confirm the watermark's own marked content carries no MCID. If the
  pinned Typst version's page-background handling doesn't guarantee this
  reliably, the DoD wording ("Artifact by page-background semantics")
  is the honest ceiling for this folder — a real structural proof
  belongs behind folder 011's veraPDF gate or a dedicated pinned struct
  inspector, not asserted here without evidence.
- **Colophon toggle naming.** B8 proposes `colophon: boolean`; product
  wording for the end page is unsettled, so this plan ships cover/outline
  toggles only — confirm the third toggle's name before adding it.
- **Built-in vs. manifest settings stay two separate shapes in v1.**
  `PdfTemplateSettings` (T2.1, fixed Level-A fields) and a template-pack
  manifest's `settings` map (T2.4, open typed dictionary for Level-B
  templates like `accent`/`logo`) are not merged or reconciled in this
  folder — there is no host-side glue yet that loads a Level-B template
  and threads its manifest-declared settings into the render call. This
  is intentional (the Goal section frames Level-B loading as future
  work). **Design answer for the eventual merge order (documented now,
  not built here):** once Level-B loading exists, resolution follows the
  order manifest defaults → persisted host values → per-export
  overrides → validation/normalization → application of declared
  bindings to the design copy → locale/label resolution → asset-slot
  resolution — the order this folder's contract predecessor settled on
  for the general case. The **bindings layer** (step 5, explicit
  setting→design-field mappings) stays out of scope for both this
  folder and the merge order above; it is Level-B/`012` work
  (`012-pdf-template-migration/PLAN.md`), not a T2.1/T2.4 deliverable —
  this folder's fixed `PdfTemplateSettings` fields are consumed
  directly by `template.ts`, with no binding indirection.
- **Font glyph coverage.** A custom corporate font may lack glyphs (e.g.
  CJK) present in the document; a cmap preflight is expensive — open
  question whether a sampled warning ships with the seam or with the
  host upload UI.
- **`.wiki-pdf-template` reader ownership and caps must be synced with
  folder 011.** This folder places the pack/unpack/validate reader in
  the new `packages/template-pack` package (not
  `packages/core/src/template-library.ts`, which stays resolution-only)
  and sets 30 MiB archive / 64 MiB uncompressed caps exported as named
  constants; `011-quality-gates/PLAN.md:261-275` currently names
  `packages/core/src/template-library.ts` as the reader location for the
  same size-cap task and proposes the same 30/64 MiB numbers
  independently. Both must agree on the file and the constants before
  011's security-hardening task lands — tracked in `crossPlanImpacts`.
- **Inner-DOCX decompression is not yet bounded for the nested-container
  case.** `unzipDocx` (`packages/docx/src/scan.ts:100-113`) caps only the
  compressed `.docx` byte length before `scanZip` decompresses each part
  via `asText()` with no declared-size accounting. Once a `.docx` is
  packed inside a `.wiki-pdf-template` archive (T2.4's `kind: "docx"`
  variant), the outer container's own cap does not protect against a
  small, highly-compressed inner `.docx` that decompresses to a large
  XML payload — a nested zip-bomb path this folder's `validatePack`
  cannot close on its own, since the fix (entry-count, declared
  uncompressed size, and compression-ratio checks inside `unzipDocx`/
  `scanZip`) is a change to `packages/docx`, which this folder's
  Dependencies section explicitly keeps out of scope ("packages/docx is
  not modified here"). Tracked as an open question for whichever lane
  picks up the `packages/docx` change (likely alongside 011's existing
  "size caps everywhere an untrusted file enters" task) — flagged in
  `crossPlanImpacts`.
- **Who may set global templates?** The permission model for writing
  global vs. space entries is host-side governance (library follow-up),
  not solvable in the pure library abstraction.
