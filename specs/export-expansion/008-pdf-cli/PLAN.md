# 008 — PDF CLI & headless export

Status: **Implemented**, 2026-07-20 (PR #53). Merged to `main`; gated PDF E2E verified against DOCSY. Includes the deferred 002 PDF-CLI hand-off. Covers Lane K of `specs/export-expansion/UMSETZUNGSPLAN.md`
(T3.1–T3.5): the PDF compile port for Bun, `atlcli wiki export --format pdf`,
scope/label flags for both engines, CI/CD developer experience, and the
preparation to make the ts DOCX engine the CLI default.

## Reference

- `specs/export-expansion/UMSETZUNGSPLAN.md` — Lane K table (T3.1–T3.5),
  dependency graph (`K1[T3.1] --> K2[T3.2]`, `A --> K3[T3.3]`), and the
  "immediately startable, even before T0" list that names T3.1.
- `specs/export-expansion/BASELINE-DESIGN.md` §1 Cluster A, section A5
  (headless/library story): the zero-backend architecture cannot offer a
  hosted REST job API, so the CLI **is** the automation API — machine-readable
  report on stdout, documented exit codes, CI recipe docs, and (post-M1, T4.1)
  a published library surface. This folder implements the CLI leg of A5.
- Compiler seam (all verified on branch `export-expansion`):
  - `packages/pdf-compiler-browser/src/compiler.ts` — `BrowserPdfCompiler`
    implements `PdfCompilePort`; constructor takes
    `BrowserPdfCompilerAssets { wasm: ArrayBuffer | URL | Response; fonts: Uint8Array[] }`;
    init calls `initTypst({ module_or_path: this.assets.wasm })` then
    `TypstCompilerBuilder.add_raw_font()` per font.
  - `packages/pdf-compiler-browser/src/vendor.d.ts` — the pinned typst.ts
    0.7.0 surface we rely on (`add_source`, `map_shadow`, `compile`, …).
  - `packages/pdf-compiler-browser/src/compiler.test.ts` — already
    instantiates the compiler **under `bun test`** with real wasm bytes
    resolved via `import.meta.resolve("@myriaddreamin/typst-ts-web-compiler/wasm")`
    and fonts read from `@atlcli/pdf/fonts/*`.
  - `patches/@myriaddreamin%2Ftypst-ts-web-compiler@0.7.0.patch` — replaces the
    wasm-bindgen `new Function(...)` shims with static closures (allow-listed
    bodies); runtime-neutral, no browser API involved.
- Export pipeline: `packages/pdf/src/run-export.ts` (`runPdfExport`,
  `PdfExportEnv { assets, compiler, output }`, `PdfOutputSink`,
  `PdfExportError` with `phase`), `packages/pdf/src/types.ts`
  (`PdfAssetResolver`, `PdfExportReport`, `PdfExportMetadata`),
  `packages/pdf/src/validate.ts` (`validatePdfOutput` →
  `{ pageCount, tagged, hasOutline, embeddedFontFiles }`).
- Fonts: `packages/pdf/src/runtime-assets.ts` (canonical manifest,
  sha256-pinned), `packages/pdf/scripts/ensure-fonts.ts` (`ensurePdfFonts()`
  downloads into `packages/pdf/.fonts/`), root `package.json` scripts
  `fonts:ensure` / `prebuild` (fonts are guaranteed at build time; `@atlcli/pdf`
  maps the export subpath `./fonts/*` to `./.fonts/*`).
- Canonical browser load pattern: `apps/browser-export-harness/src/pdf-worker.ts`
  (fetch wasm + 10 fonts, `assertStaticAssetParity()` against
  `PDF_RUNTIME_ASSETS`, construct `BrowserPdfCompiler` once, reuse). Headless
  consumer pattern: `apps/browser-export-harness/src/pdf-case.ts`
  (`runPdfExport` with a memory sink and a no-asset resolver).
- CLI wiring today: `apps/cli/src/commands/wiki.ts` (dispatch, `export`
  subcommand), `apps/cli/src/commands/export.ts` (DOCX-only `handleExport`,
  `--engine ts|python`, `export template list|save|delete` subcommands),
  `apps/cli/src/commands/export-internals.ts` (`tokenAssetFetcher`,
  `createAssetByteCache` — the token-auth attachment resolution the PDF asset
  resolver must reuse), `apps/cli/src/commands/export-rasterizer.ts` (the
  precedent for shipping wasm+fonts in the compiled binary via
  `with { type: "file" }` imports).
- Sibling folder 002 (`specs/export-expansion/002-*`): Lane A scope & tree
  composition (T1.1–T1.3) — source of the scope/label/compose APIs that T3.3
  wires into the CLI, and the signal-aware `ConfluenceClient` HTTP helpers
  T3.2's cancellation task builds on (see Dependencies).
- Sibling folder 004 (`specs/export-expansion/004-macro-renderer/PLAN.md`):
  defines its own `ExternalAssetPolicy` port for `export_view`-sourced
  images on the same unrestricted fetch T3.2 hardens — coordinate rather
  than duplicate (see Dependencies).
- Sibling folder 007 (`specs/export-expansion/007-pdf-template-settings/PLAN.md`):
  claims exclusive ownership of `packages/pdf/src/{template.ts, serialize.ts,
  types.ts, run-export.ts}` for its T2.1 — this folder's T3.3 needs a small
  additive change to `types.ts`/`prepare.ts` after T2.1 lands (see
  Dependencies and File ownership).
- Sibling folder 009 (`specs/export-expansion/009-package-publishing/PLAN.md`):
  vendors the patched typst.ts wasm build behind a stable `./wasm` subpath;
  T3.1's `export-pdf-assets.ts` import needs revisiting once that lands
  (see Dependencies).
- Mention resolution: `packages/confluence/src/resolve-mentions.ts`
  (`resolveExportMentions`, `:100`), already wired into the extension's PDF
  path (`apps/extension/utils/pdf/run-export.ts:73,155-180,191-203`) but not
  into any CLI export path today — T3.2 closes that gap for both PDF and
  the existing `--engine ts` DOCX path.

## Goal & user value

"Export in my pipeline" without a hosted service: a team runs
`atlcli wiki export <page> --format pdf` on a Linux CI runner and gets a
tagged, font-embedded PDF plus a machine-readable JSON report — no browser, no
polling, no data leaving their runner. This folder delivers:

1. The **compile port** that runs the patched typst.ts wasm under Bun with no
   DOM (T3.1) — the critical path for everything PDF outside the browser.
2. The **`--format pdf`** single-page export command (T3.2).
3. **Scope and label flags** (`--scope tree|space`, `--label-include`,
   `--label-exclude`) for both the ts DOCX engine and PDF (T3.3).
4. **CI/CD DX**: stable `--report json` schema, deterministic exit codes,
   `--out-dir`, profile-free token auth, and recipe docs (T3.4).
5. Groundwork to make the **ts engine the DOCX default** (T3.5).

The CLI is the first consumer of the export baseline and the reference
"headless host" the future published packages (T4.1/A5) will mirror.

## Dependencies

- **T3.1 (spike): none — start immediately.** UMSETZUNGSPLAN explicitly lists
  it as startable before Sync-Punkt 0; it touches no shared hot file.
- **T3.2** depends on T3.1 (needs a working compile port). T3.2 also ships
  the minimal report/error-boundary kernel itself (see T3.2's first task,
  "Report/error-boundary kernel") rather than deferring it to T3.4: T3.2's
  own success-output task already commits to the `atlcli.export-report/1`
  shape and to real (not always-`1`) exit codes, so that minimal boundary
  has to exist before the rest of T3.2 can be implemented. This resolves
  what would otherwise be circular: UMSETZUNGSPLAN's Lane K table has
  T3.4 depend on T3.2, but the report schema and exit-code mapping T3.2
  needs for its own output live under the T3.4 heading below. T3.2 ships
  the minimal kernel early; T3.4 extends it (`--strict`, error
  classification, `--out-dir`, profile-free auth, CI recipes) without
  redefining it.
- **Deferred hand-off from folder 002** (002 implemented 2026-07-19, PR #51;
  DOCX(ts) scope/label/completeness CLI landed there): per 002's own clause
  ("if 008 has not merged, land DOCX(ts) first; the PDF wiring task is a
  follow-up commit on 008's seam, not a fork"), three 002 items are open and
  land **in this folder** once T3.2's `--format pdf` command exists:
  1. **PDF CLI wiring** of `--scope tree|space` / `--label-*` /
     `--completeness` onto `--format pdf` (T3.3 call site). The orchestration
     (`fetchExportTree` → `composeChapters`) and flag parsing
     (`parseExportRequest` → `ExportScope`/`LabelFilter`) are shared and
     already live; the engine side is fully ready — `runPdfExport` accepts
     composed blocks, renders sanitized/deduped Typst labels +
     `#pagebreak(weak: true)`, enforces the shared `AssetBudget`, and reports
     `sourceNotes` + `complete`. Only the CLI call site differs from DOCX.
  2. **PDF E2E variants** of 002's tree/label runs (assert one PDF, outline
     entries per chapter), reusing 002's DOCSY fixture-tree recipe.
  3. 002's DoD line "PDF path integrated on 008's seam" — tick it in
     `002-scope-orchestration/PLAN.md` when (1)+(2) are done.
  Already delivered by 002 for this folder: `signal` is threaded through
  `requestBinary` (asset downloads) — the cancellation-contract prerequisite
  below is met; `ImageSource.pageId` exists on the model/walker side.
- **File ownership conflict with folder 007**: T3.3 needs a small additive
  change to `packages/pdf/src/types.ts` (`PdfAssetRef.pageId`) and
  `packages/pdf/src/prepare.ts` (thread `pageId` through image
  resolution — see T3.3). `007-pdf-template-settings/PLAN.md` claims
  exclusive ownership of `packages/pdf/src/{template.ts, serialize.ts,
  types.ts, run-export.ts}` for its T2.1 ("no other lane touches these
  files"). Resolution for this folder: T3.3's `types.ts`/`prepare.ts`
  change lands strictly after 007's T2.1 has merged, as a small additive
  PR (new optional field, no signature change to existing exports) that
  never touches `template.ts`/`serialize.ts`. This still needs 007 to
  acknowledge the one shared-file exception — see crossPlanImpacts.
- **WASM asset path vs. folder 009**: T3.1's `export-pdf-assets.ts` loads
  the typst wasm from the current in-repo patched-dependency location.
  `009-package-publishing/PLAN.md` later vendors the same patched build
  into `packages/pdf-compiler-browser/vendor/` behind a stable `./wasm`
  subpath and retires `patches/` once in-repo consumers migrate. T3.1
  does not need to wait for 009, but `export-pdf-assets.ts`'s import is a
  permanent, load-bearing CLI packaging path and must be revisited once
  009 lands so it isn't left pointing at an unpinned upstream location
  after other consumers have moved off it — flagged for 009 as a
  consumer to migrate; see crossPlanImpacts.
- **`ExternalAssetPolicy` overlaps folder 004**: `004-macro-renderer/PLAN.md`
  independently defines an `ExternalAssetPolicy` port
  (`packages/export-macros/src/types.ts`) gating `export_view`-sourced
  images through the same unrestricted fetch T3.2 targets below
  (`apps/cli/src/commands/export-internals.ts:127-130` — both plans cite
  this exact call site, verified). T3.2's policy must be the same
  contract 004 defines (or import it) rather than a second, differently
  shaped gate on the same fetch path for ordinary page images vs. macro
  images — see T3.2's external-asset bullet; coordination needed with
  004, see crossPlanImpacts.
- **T3.3** depends on **folder 002** (Lane A: `export-scope.ts`,
  `tree-fetch.ts`, `compose-document.ts`, label filters — T1.1–T1.3) and on
  T3.2. **Flag-syntax ownership correction**: `002-scope-orchestration/PLAN.md`
  ("CLI" section) already adds `--scope`, `--space`, `--max-depth`,
  `--max-pages`, `--label-include`/`--label-exclude` (comma-separated),
  `--label-exclude-mode` to `apps/cli/src/commands/export.ts` and produces a
  serializable `ExportScope`/`LabelFilter`. This folder does **not** own or
  re-parse scope/label flags (an earlier draft here sketched a conflicting
  repeatable-flag syntax for the same flags on the same file); 008 only adds
  the `--format pdf` branch that consumes the `ExportScope`/`LabelFilter`
  value 002's parsing already produced. See T3.3 below and "Folder 002 API
  drift" in Risks.
- **T3.4** depends on T3.2 (extends its report/exit-code surface, which
  T3.2's own report kernel task already establishes; T3.4 adds `--strict`,
  error classification, `--out-dir`, profile-free auth, and CI recipes,
  it does not create the first version of the report shape).
- **T3.5** depends on Lane A engine integration (T1.3) and DOCX native
  numbering (T1.13) from their respective folders; only the measurement
  harness and migration note are owned here.
- File ownership: this folder owns `apps/cli/src/commands/export*.ts`, new
  `packages/pdf-compiler-node` (only if the fallback is needed), and its docs
  pages. No writes to `packages/confluence/src/export-blocks.ts` or
  `packages/pdf/src/{template,serialize}.ts` (owned by other lanes).

## Architecture

**The compiler is already runtime-agnostic; only asset loading is host-specific.**
`BrowserPdfCompiler` ("browser" names the wasm build target, not a DOM
dependency) touches no browser API in its load path: it feeds the constructor's
`ArrayBuffer` straight into wasm-bindgen's `initTypst({ module_or_path })`,
which for a buffer input goes through `WebAssembly.instantiate` — available in
Bun. The repo's own patch removed the only dynamic-code shims. The existing
`compiler.test.ts` proves compile-to-PDF-bytes under `bun test` today. What
remains for T3.1 is productizing that load path for the CLI (dev-mode source
runs, `bun build` dist output, and `bun build --compile` release binaries) and
documenting the fallback if a gap appears.

**Asset strategy mirrors the mermaid rasterizer.** `export-rasterizer.ts`
already ships resvg wasm + fonts via `with { type: "file" }` imports, which
resolve to `node_modules` paths under `bun run` and to embedded `$bunfs` paths
in compiled release binaries. A new `export-pdf-assets.ts` does the same for
the typst wasm (~`@myriaddreamin/typst-ts-web-compiler/wasm`) and the 10
canonical fonts (`@atlcli/pdf/fonts/*`, materialized at build time by the
existing `fonts:ensure`/`prebuild` scripts), with a parity assertion against
`PDF_RUNTIME_ASSETS` like the harness worker's `assertStaticAssetParity()`.

**The CLI is just another `PdfExportEnv`.** The command builds:

- `assets`: a `PdfAssetResolver` over `ConfluenceClient` — attachment refs
  (`{ kind: "attachment", filename }`) resolve through the REST attachment
  listing's `downloadUrl` (token-auth safe; same reasoning and cache as
  `tokenAssetFetcher`/`createAssetByteCache` in `export-internals.ts`, shared
  rather than duplicated), external refs (`{ kind: "external", url }`) via
  `fetch` under an `ExternalAssetPolicy` (timeouts, redirect re-checks,
  private-network blocklist — see T3.2).
- `compiler`: the lazily imported `BrowserPdfCompiler` fed from
  `export-pdf-assets.ts` (lazy so non-export commands never pay wasm cost).
- `output`: a filesystem `PdfOutputSink` mirroring
  `packages/docx/src/node-adapters.ts:fileOutputSink`.

Pipeline per page: `client.getPageDetails` → `storageToBlocks(storage)`
(`packages/confluence/src/export-blocks.ts:330`) → `resolveExportMentions`
(`packages/confluence/src/resolve-mentions.ts:100` — see T3.2's mention
resolution task; the extension already inserts this step, the CLI
currently does not) → `runPdfExport(input, env)` → `PdfExportReport`.
Validation (`validatePdfOutput`) already runs inside `runPdfExport`; the
CLI maps `PdfExportError.phase` to exit codes.

**Command surface** (extends, does not break, the existing DOCX command):

```
atlcli wiki export <page> --format pdf --output out.pdf
atlcli wiki export <page> --format pdf --scope tree --label-exclude internal --out-dir dist/
atlcli wiki export <page> --format docx --engine ts --template corporate -o out.docx
```

`--format` defaults to `docx` (backwards compatible). `--template` stays
DOCX-only for now (PDF templates arrive via Lane P / `wiki.pdf-template/v1`);
passing it with `--format pdf` is a usage error rather than a silent ignore.

## Tasks

### Spike: WASM under Bun (T3.1)

Goal: a written go/no-go on running the patched typst.ts wasm in the CLI
process, with the port shape committed. Timebox: 2 days.

- [x] Confirm the baseline: run `bun test packages/pdf-compiler-browser/src/compiler.test.ts`
      on Linux and macOS; record compile time and RSS for the smoke bundle
      (first data point for CI budget). Files: none (evidence in this
      folder's spike notes below the task list or in the PR description).
- [x] Audit the load path for browser APIs: read the wasm-bindgen glue
      `node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs`
      (as patched by `patches/@myriaddreamin%2Ftypst-ts-web-compiler@0.7.0.patch`)
      and verify the `module_or_path: ArrayBuffer` branch reaches
      `WebAssembly.instantiate` without touching `document`, `window`,
      `URL`-relative script location, or `fetch`. Document which init branches
      (URL/Response) are browser-only and must never be used from the CLI.
- [x] Build `apps/cli/src/commands/export-pdf-assets.ts`: `with { type: "file" }`
      imports for the typst wasm and the 10 fonts from `@atlcli/pdf/fonts/*`,
      `readFile` into `ArrayBuffer`/`Uint8Array[]`, parity check against
      `PDF_RUNTIME_ASSETS` (pattern: `apps/cli/src/commands/export-rasterizer.ts`,
      `apps/browser-export-harness/src/pdf-worker.ts`). Unlike the rasterizer,
      a load failure here is a hard error — PDF export cannot degrade.
- [x] Verify the three run modes compile a minimal bundle to `%PDF-` bytes:
      source run (`bun run --cwd apps/cli src/index.ts`), built dist
      (`bun run build` then `bun ./dist/index.js`), and a
      `bun build --compile` binary (the Homebrew shape). Confirm the wasm
      `with { type: "file" }` import survives `bun build --target bun`
      bundling to `dist/` — if dist emits a broken asset path, fall back to
      `import.meta.resolve` + `readFile` for the dist path and keep the
      embedded import for `--compile`.
- [x] Decide singleton lifecycle: one lazily created compiler per CLI process,
      `reset_shadow()` between pages (already inside `compile()`), `reset()`
      only on fatal diagnostics. Document memory expectations for tree exports
      (N pages through one instance).
- [x] Write the fallback plan (do not build it unless the spike fails):
      `packages/pdf-compiler-node/` — a thin wrapper package implementing
      `PdfCompilePort` with the same `compile(bundle)` semantics, backed by a
      Node-targeted wasm-bindgen build of the same pinned typst.ts version, to
      be used only if Bun's wasm-bindgen support hits gaps (e.g. glue code
      requiring `TextEncoder` quirks, `performance` APIs, or worker-only
      globals). The CLI depends on the port type from `packages/pdf/src/compiler.ts`
      either way, so swapping implementations is a one-line env change.
      **Not needed** — spike is a clear GO (see Spike results); the fallback
      package was not built.
- [x] Record the spike verdict + measurements in this file (append a
      "Spike results" subsection) before starting T3.2.

#### Spike results (T3.1) — verdict: **GO**, no `pdf-compiler-node` fallback needed

- **Baseline** (`bun test packages/pdf-compiler-browser/src/compiler.test.ts`,
  macOS arm64, Bun 1.3.8): 9 tests green in ~282 ms wall; peak RSS ~515 MB
  across the whole suite (many compiles incl. the 4-page settings matrix).
- **Load-path audit**: `initTypst({ module_or_path })` with an `ArrayBuffer`
  input takes the `else` branch of `__wbg_load` →
  `WebAssembly.instantiate(module, imports)` (glue
  `typst_ts_web_compiler.mjs:1163`), touching no `fetch`, `document`, `window`,
  or `Response`. The `Response`/string branches (`:1144-1161`, `:1606-1607`)
  and the `import.meta.url`-relative `importWasmModule` default (`:1602`) are
  browser-only. The CLI always passes a copied standalone `ArrayBuffer`, so
  only the runtime-neutral branch is ever reached.
- **Three run modes** all compile a minimal bundle to `%PDF-` (10 080 bytes,
  identical across modes): source run, `bun build --target bun` dist bundle,
  and `bun build --compile` binary — verified from a foreign CWD too. The one
  real gap the PLAN anticipated materialized: in the plain dist bundle the
  `with { type: "file" }` import yields a bundle-relative path
  (`./typst_ts_web_compiler_bg-<hash>.wasm`), which `readFile` resolved against
  the process CWD and failed. Fix: anchor relative asset paths to
  `import.meta.dir` (`assetFilePath()` in `export-pdf-assets.ts`) — this makes
  all three modes work without the browser-only `import.meta.resolve` fallback.
  These three modes are now a permanent CI gate
  (`export-pdf-build-modes.test.ts`), not a one-time note.
- **Single cold compile**: ~0.13 s wall incl. process start + wasm init + one
  compile; peak RSS ~348 MB for a single page. Lifecycle: one lazily created
  `BrowserPdfCompiler` per process (`getPdfCompiler()`), `reset_shadow()`
  between pages inside `compile()`; `reset()` only after a fatal load failure
  (the promise is cleared so a retry re-attempts). Tree/space exports reuse the
  single instance — large-scale RSS across hundreds of pages remains unmeasured
  (T4.3 owns the benchmark; see Risks).

### CLI command --format pdf (T3.2)

- [x] **Report/error-boundary kernel** (must land before the rest of T3.2;
      T3.4 only extends it — see Dependencies): today `fail()`
      (`packages/core/src/utils.ts:121-143`) emits an incompatible
      `{ error: {...} }` shape under `--json` and calls `process.exit()`
      directly, and any uncaught error falls through to `main()`'s catch
      (`apps/cli/src/index.ts:391-395`), which always exits `1` — neither
      path can produce the `atlcli.export-report/1` success/error report
      the rest of T3.2 and T3.4's exit-code table promise (both verified).
      Add `apps/cli/src/commands/export-report.ts` with the minimal v1
      report shape (full schema detailed under T3.4) and a single outer
      boundary in `export-pdf.ts`/`handleExport`: the export path itself
      never calls `fail()` or lets an error propagate past its own
      boundary — it returns a typed `{ ok: true, report }` or
      `{ ok: false, report, exitCode }` outcome, and exactly one call site
      (the command entry point) turns that into stdout output and the
      process exit code. T3.4 adds `--strict`, the auth modes,
      `--out-dir`, and the classified-error → exit-code table on top of
      this boundary; it does not introduce a second one.
- [x] Restructure `handleExport`'s validation order to be format-aware
      *before* adding `--format` parsing: today `--template`
      (`export.ts:86-88`) and `--output` (`export.ts:90-92`) are required
      unconditionally, and the template path is resolved
      (`resolveTemplatePath`, `export.ts:98`) before any engine/format
      branch runs (`export.ts:64-104`, verified). A naive `--format`
      addition would leave `--format pdf` failing on "--template is
      required" even though T3.2's contract says PDF has no template.
      Determine `format` first, then branch validation: DOCX requires
      `--template`; `--engine` stays **optional** and keeps defaulting to
      `"python"` (`export.ts:81`, verified) — do not make `--engine`
      required here, since that would be an unannounced breaking change
      for every existing formatless/engineless DOCX invocation, and T3.5
      explicitly keeps the default-engine flip as its own later, gated
      PR (see T3.5 below). PDF forbids both `--template` and `--engine`.
      Add a test matrix covering every allowed/forbidden flag combination,
      including: legacy call (no `--format`, no `--engine`) → DOCX/python
      unchanged; `--format docx` with no `--engine` → python default
      preserved; `--format docx --engine ts|python` → explicit engine
      honored; `--format pdf` with `--template` or `--engine` present →
      usage error (regression guard for the legacy cases).
- [x] New `apps/cli/src/commands/export-pdf.ts`: `exportPdf()` host wiring —
      page resolution reuses the existing `resolvePageId`, then
      `getPageDetails` → `storageToBlocks` → `runPdfExport` with the CLI
      `PdfExportEnv`. Metadata mapping: `title`, `space` (spaceKey), `version`,
      `author`, `exporter: "atlcli"`, `exportedAt`, locale via
      `normalizePdfLocale`. `exportedAt` accepts an override
      (`--exported-at <ISO8601>` or `SOURCE_DATE_EPOCH` env var, standard
      reproducible-builds convention) instead of always `new Date()` — the
      timestamp is baked into the Typst source and PDF metadata
      (`packages/pdf/src/serialize.ts:813-824,844-859`, verified) and byte-stable
      CI artifacts / goldens need a fixed value across runs.
- [x] Resolve mentions before compiling, matching the extension's pipeline
      (parity gap, verified): the pipeline above goes `storageToBlocks` →
      `resolveExportMentions` → `runPdfExport`, but nothing in the CLI does
      this today. The extension already runs `resolveExportMentions`
      between the walk and export
      (`apps/extension/utils/pdf/run-export.ts:73,155-180,191-203`), backed
      by the isomorphic `resolveExportMentions`
      (`packages/confluence/src/resolve-mentions.ts:100`). Without this
      step, `--format pdf` — and the existing `--engine ts` DOCX path,
      which has the identical gap today — prints raw Atlassian account IDs
      instead of names for any `@mention` whose `displayName` wasn't
      already inlined by Confluence. Call `resolveExportMentions(blocks,
      lookup)` after the walk for both `exportPdf()` (this task) and
      `exportWithTsEngine` (`export.ts`, both owned by this folder), with
      `lookup` backed by `ConfluenceClient.getUsersBulk()`; for tree/space
      scope (T3.3), dedupe account IDs across the whole document before the
      bulk call. CLI and extension must emit the same unresolved/failure
      note codes. DoD: a real Storage-format fixture with an
      account-id-only mention produces the identical display name (or
      identical degraded warning) from the CLI and from the extension
      harness.
- [x] Implement the CLI `PdfAssetResolver` in
      `apps/cli/src/commands/export-internals.ts` (extend, don't fork): reuse
      `createAssetByteCache` + the attachment-listing `downloadUrl` resolution
      from `tokenAssetFetcher`; adapt its return shape to
      `PdfResolvedAsset { bytes, mediaType, filename }`.
- [ ] External asset fetch policy for `{ kind: "external", url }` refs: the
      current CLI external-fetch path (`export-internals.ts:127-130`) is a
      bare `fetch()` with no timeout/abort and no host restriction, and the
      PDF size limit (`PDF_MAX_ASSET_BYTES`, `packages/pdf/src/prepare.ts:18-46`)
      only rejects bytes *after* the whole response is buffered — verified,
      both files. Add an `ExternalAssetPolicy`: HTTPS by default, reject
      loopback/private/link-local targets unless an explicit allowlist flag
      is set, re-check every redirect hop, apply connect/read timeouts and
      an abort on the actually-streamed byte count (not just the final
      buffer). This runs before Confluence-authenticated assets ever touch
      the process, so it protects CI runners against SSRF via page content
      an editor controls, not just malformed images. Use (or import) the
      same port shape `004-macro-renderer/PLAN.md` defines for its
      `export_view`-sourced-image gate on this identical call site, rather
      than a second, independently-shaped policy for macro images vs.
      ordinary page images — see Dependencies. Redact credentials from any
      resulting notes: error messages must never leak userinfo, query
      strings, fragments, or a raw signed URL into `notes`/`issues` (the
      report is a durable CI artifact) — log a scheme+host only on
      fetch failure, not the full URL.
- [ ] Bound authenticated Confluence attachment downloads the same way,
      not just external URLs: `ConfluenceClient.requestBinary()` buffers
      the entire response via `res.arrayBuffer()` before any size check
      (`packages/confluence/src/client.ts:1744-1751`, verified), and
      `validateResolvedAsset`'s `PDF_MAX_ASSET_BYTES` check
      (`packages/pdf/src/prepare.ts:46-50`) only runs once that full
      buffer already exists — so the size limit's intent (bound memory
      use) is not actually met for authenticated assets. Add a shared
      `readBoundedBody(response, { maxBytes, signal })` helper used by
      both the external-URL fetch above and the authenticated attachment
      path: pre-check `Content-Length`, and cap the actual streamed byte
      count so an oversized body is rejected before full buffering, not
      after. Separately, `listAttachments()` defaults to `limit: 100` with
      no pagination (`packages/confluence/src/client.ts:1448-1461`,
      verified), and `tokenAssetFetcher`'s `(pageId, filename)` lookup
      does a `.find()` over that single unpaginated page
      (`export-internals.ts:132-143`) — an attachment beyond the first
      100 on a page silently reports "attachment not found" instead of
      resolving. Paginate `listAttachments` fully (or filter server-side
      by filename) for the PDF/DOCX asset lookup path. DoD: a fixture
      with >100 attachments on one page resolves an attachment near the
      end of the list; a 25 MiB boundary fixture is rejected by streamed
      size, not post-buffer size.
- [x] Thread cancellation from the CLI process down to actual I/O, not
      just between `runPdfExport` phases: `PdfAssetResolver.resolve(ref)`
      (`packages/pdf/src/types.ts:26-28`, verified) takes no signal, and
      `preparePdfDocument` is called from `runPdfExport` without one
      (`packages/pdf/src/run-export.ts:125`, verified) — so an image
      fetch in flight when the user hits Ctrl-C keeps running, and its
      eventual `AbortError` is caught by the generic image-error handler
      (`packages/pdf/src/prepare.ts:218-243`, verified) and downgraded to
      a soft `pdf-image-skipped` note (renamed to `image-embed-failed` by
      spec 010's vocabulary unification) instead of aborting the export. Add
      `resolve(ref, { signal })` to `PdfAssetResolver`, thread `signal`
      through `preparePdfDocument`'s call sites, and have the image-error
      handler rethrow `AbortError` instead of swallowing it. Build the
      CLI `PdfAssetResolver`'s attachment path on top of folder 002's
      signal-aware `ConfluenceClient` HTTP helpers
      (`002-scope-orchestration/PLAN.md`, "Progress/abort" — that spec
      threads `signal` into `request`/`requestV2` and makes retry backoff
      abortable); if `requestBinary()` isn't covered by that work, extend
      it the same way here. Install SIGINT/SIGTERM handlers around the
      export command that abort the shared `AbortSignal` and are removed
      in `finally`; document exit code 130 for SIGINT. This still cannot
      interrupt an in-progress WASM compile (unchanged limitation, see
      Risks) — the fix here is stopping in-flight and future *fetches*,
      which today do not honor cancellation at all despite an earlier
      draft of the Risks entry implying they do.
- [ ] Bind the persistent asset disk cache to the active Confluence
      principal: `createAssetByteCache`'s cache key today only hashes
      `baseUrl` + asset identity (`export-internals.ts:36-38`) and returns
      cache hits before any authorized download (`export-internals.ts:76-90`,
      verified) — two profiles on the same OS account pointed at the same
      site (e.g. a restricted CI token profile vs. a personal elevated
      profile) would silently share cached bytes regardless of differing
      Confluence permissions. Add the profile/principal identity (not a
      secret — profile name or account id) into the cache key namespace, and
      add a `--no-cache` escape hatch for CI runs that should never persist
      assets across invocations.
- [x] Implement `filePdfOutputSink(path)` (either in `export-pdf.ts` or shared
      in `apps/cli/src/commands/export-internals.ts`): write to a temp file
      in the same target directory, then rename atomically into `path`
      (mirrors nothing in `packages/docx/src/node-adapters.ts:fileOutputSink`,
      which writes directly — verified `node-adapters.ts:29-38` — this sink
      is deliberately stricter). Concrete commit protocol: create the temp
      file with exclusive creation (`wx`-style) and a random suffix
      (collision-safe under concurrent invocations targeting the same
      directory) and restrictive permissions; refuse to write through a
      symlink, directory, or special file already at the target path;
      reject an `--out-dir`-derived filename (T3.4) that would escape the
      chosen directory; rename only via the platform's atomic no-replace
      primitive. `--force` deletes/overwrites only a regular file at the
      target path, never a symlink or directory. Clean up the temp file in
      a `finally` on any failure so a killed/failed export never leaves a
      partially written file at the target path for a CI artifact step to
      pick up. No-clobber by default. Note: `runPdfExport` re-checks
      `input.signal` immediately after `env.output.emit()` returns
      (`packages/pdf/src/run-export.ts:165-173`, verified) — a signal that
      fires in that narrow window turns an already-committed rename into a
      reported failure, the mirror-image problem of the DoD's "nothing
      partial on failure" guarantee (something *complete* gets reported as
      failed). That check lives in `packages/pdf/src/run-export.ts`, owned
      by folder 007's T2.1 (see Dependencies) — flag it there rather than
      patching it here; this folder's own sink still treats a successful
      rename as its commit point for cleanup bookkeeping. Test
      concurrency, symlink races, Unicode/empty filenames, and mid-rename
      signals on Linux, macOS, and Windows (all three ship release
      binaries, `.github/workflows/release.yml:17-22`).
- [x] Add `@atlcli/pdf` and `@atlcli/pdf-compiler-browser` to
      `apps/cli/package.json` dependencies (workspace:*). Keep both imports
      lazy inside the `--format pdf` branch so `atlcli wiki page list` never
      loads wasm.
- [x] Success output via `output(data, opts)` **is** the `atlcli.export-report/1`
      report object built by the report kernel above (`sourcePages[0]` for
      the exported page, `outputs[0]`/`outputDetails[0]` for the file path
      and its metrics — see T3.4's schema correction) — not a second ad hoc
      shape; see the `--json` vs `--report json` bullet under T3.4.
      Human-readable summary line in text mode, full report object in
      `--json`/`--report json`.
- [x] Error mapping: `PdfExportError.phase` → message prefix; compile
      diagnostics printed via `formatPdfCompilerDiagnostics`
      (`packages/pdf/src/compiler.ts`); exit codes per T3.4 table (uses
      T3.4's error-classification task for Confluence-side failures).
- [x] Update help text: `exportHelp()` in `apps/cli/src/commands/export.ts`
      and the `export` line in `wikiHelp()` (`apps/cli/src/commands/wiki.ts`,
      currently "Export page to DOCX with Word templates" → "Export page to
      DOCX or PDF").
- [x] Docs: extend `src/content/docs/confluence/export.md` with a PDF section
      (minimal + advanced example per the docs standards in `CLAUDE.md`).

### Scope & label flags (T3.3)

Blocked on folder 002 (Lane A, T1.1–T1.3), which owns the flag syntax (see
Dependencies above). Wire after its merge.

- [x] Do **not** re-implement scope/label flag parsing here: folder 002 owns
      `--scope page|tree|space`, `--space`, `--max-depth`, `--max-pages`,
      `--label-include`/`--label-exclude` (comma-separated),
      `--label-exclude-mode` in `apps/cli/src/commands/export.ts` and
      produces the serializable `ExportScope`/`LabelFilter`. If 002 lands a
      different shape than described here, only this bullet and the next
      one change — see "Folder 002 API drift" in Risks.
- [x] Wire `--scope tree|space` for `--format pdf`: folder 002's tree fetch +
      chapter composition (`packages/confluence/src/export-scope.ts`,
      `tree-fetch.ts`, `compose-document.ts` — names per UMSETZUNGSPLAN T1.1)
      feed the composed block list into the same `runPdfExport` call.
      **Artifact-cardinality contract**: `--scope tree|space` always produces
      exactly **one** output artifact (chapters, never one file per source
      page). `--output` names that single file; `--out-dir` (T3.4) only
      chooses its directory. This is the single authoritative rule — it
      resolves an internal ambiguity between this bullet and the earlier
      draft of `--out-dir`/the report schema, which read as "one file per
      page ID" (see T3.4 below, now corrected to match).
- [x] Thread page context through PDF asset resolution for multi-page scope:
      `PdfAssetRef` (`packages/pdf/src/types.ts:14`) has no `pageId` field
      today, and `preparePdfDocument`'s image case
      (`packages/pdf/src/prepare.ts:218-227`) resolves attachments by
      `filename` alone. Even once folder 002 adds a page-qualified
      `ImageSource.pageId` (`export-blocks.ts`), the PDF path would still
      collide on identically named attachments on different pages unless
      this is fixed here. Add `pageId?: string` to `PdfAssetRef`, thread
      `block.source.pageId` through `preparePdfDocument`'s resolve call, and
      pass it through the CLI `PdfAssetResolver` so `tokenAssetFetcher`'s
      existing `(pageId, filename)` lookup (`export-internals.ts:132-143`,
      already supports this) is actually used instead of a bare filename
      match. Test: two pages in one tree export with identically named but
      byte-different attachments must resolve to distinct bytes. Land this
      after folder 007's T2.1 has merged (per the file-ownership conflict
      noted in Dependencies) as a small additive `types.ts`/`prepare.ts`
      change, not a rework of either file.
- [x] Wire the same flags for `--format docx --engine ts` through the composed
      blocks path in `apps/cli/src/commands/export.ts:exportWithTsEngine`;
      `--scope tree|space` with `--engine python` is a usage error pointing at
      `--engine ts` (the python engine is frozen; see T3.5).
- [x] Replace the ts-engine `--include-children` limitation note ("not
      supported by the ts engine yet", `export.ts:760`) with `--scope tree`;
      keep `--include-children` as a deprecated alias for the python engine
      only.
- [x] Progress reporting for multi-page scopes: surface `onPhase` +
      per-page progress on stderr (stdout stays clean for `--report json`).
- [x] Docs: scope/label section in `src/content/docs/confluence/export.md`
      cross-linking the tree-export feature guide owned by folder 002.

### CI/CD DX & docs (T3.4)

- [x] `--report json`: print a versioned report object to **stdout** as the
      only stdout output. Schema (v1) in a new
      `apps/cli/src/commands/export-report.ts`:
      `{ schema: "atlcli.export-report/1", format, engine?, sourcePages: [{
      id, title, notes }], outputDetails: [{ output, pageCount?,
      embeddedImages, renderedDiagrams, skippedAssets }], outputs: string[],
      issues: Issue[], warnings, errors, timings, exitCode }`. Correction
      against an earlier draft: `pageCount`, `embeddedImages`,
      `renderedDiagrams`, `skippedAssets` are **not** per-`sourcePages[]`
      fields — both engines only produce them aggregated per compiled
      artifact (`PdfExportReport`, `packages/pdf/src/types.ts:128-138`;
      `runPdfExport`'s `counts = countPrepared(prepared.blocks)`,
      `packages/pdf/src/run-export.ts:136-185`; the DOCX report shape,
      `packages/docx/src/export.ts:84-105` — all verified), so a tree/space
      export with one artifact and many `sourcePages[]` entries has no
      real per-page breakdown to put there. Those metrics move to
      `outputDetails[]` (one entry per `outputs[]` path — `outputs.length`
      is 1 for every scope today, see T3.3's artifact-cardinality
      contract). `sourcePages[]` stays provenance/fetch-and-compose status
      only: id, title, and any compose/fetch `ExportNote`s for that page
      (`tree-cycle`, `label-filtered`, etc., per folder 002) — it has no
      per-entry `output` field, since per the artifact-cardinality
      contract that would either duplicate the single shared path
      (tree/space scope) or be redundant with `outputs[0]` (page scope).
      Introduce a shared `Issue { code, severity: "error" | "warning",
      phase, retryable, status?: number, sourcePageId?: string, path?:
      string, startLine?: number }` type reused for compose/fetch notes,
      PDF compiler diagnostics, and asset warnings — `warnings`/`errors`
      become convenience views over `issues` filtered by severity, not a
      second parallel shape. Crucially, `runPdfExport` today drops Typst
      compiler diagnostics on a *successful* compile —
      `compiled.diagnostics`/`formatPdfCompilerDiagnostics` are only
      consulted when `compiled.pdf` is missing
      (`packages/pdf/src/run-export.ts:148-152,176-185`, verified) — so a
      PDF with real compiler warnings reports zero issues today, which
      would make `--strict` below a no-op for that whole class of
      problem. Add `compiled.diagnostics` (even on a successful compile)
      to the report's `issues[]`. Ship a TypeScript type, a JSON Schema,
      golden fixture examples (one page scope, one tree scope with two
      source pages and compiler warnings), and schema validation in every
      subprocess/report test added under Tests below. A stable projection
      over `PdfExportReport` and the ts DOCX report; additive changes
      only, breaking changes bump the schema string (A5: "CLI report
      schema versioned and stable").
- [x] `--json` vs `--report json`: the CLI already has a generic `--json`
      flag (`apps/cli/src/index.ts:34`, toggles `opts.json` through
      `output()`/`fail()` in `packages/core/src/utils.ts`) that other
      commands use for ad hoc JSON echoes. For `wiki export`, make `--json`
      and `--report json` synonyms that both emit exactly the
      `atlcli.export-report/1` schema above — do not also keep T3.2's
      `{ success, format, output, page, report }` success shape as a
      separate JSON output; fold its fields into the v1 report instead
      (`page` → the single `sourcePages[0]`, `output` → `outputs[0]` plus
      `outputDetails[0]` for its metrics) so there is one JSON shape per
      invocation, not two competing ones.
- [x] Classify thrown errors for exit-code mapping instead of string-sniffing
      Confluence's plain `Error` messages: `ConfluenceClient` throws
      un-typed `Error`s embedding the HTTP status in the message text
      (`packages/confluence/src/client.ts:335`, `:1727`), so today nothing
      distinguishes a 401/403 (should map to exit `3`) from a 404/5xx
      (exit `4`) except regex-parsing `Confluence API error (\d+)`. Add a
      minimal `status?: number` (and `retryAfter?: number` for the 429 case)
      property on the thrown errors, or a small classifier in
      `export-report.ts` that reads it — either way, exit-code tests must
      assert against real thrown errors from a live-shaped fixture, not
      constructed fakes (per the no-mocking rule below).
- [x] Deterministic exit codes, documented in help + docs and asserted in
      tests: `0` success; `1` usage/config error; `2` completed with warnings
      under `--strict` (new flag: any `warning`-severity entry in `issues[]`
      fails the build — including compiler diagnostics captured on a
      successful compile per the schema task above, not just compose/fetch
      notes); `3` auth error; `4` remote/API error (page not found, fetch
      failed); `5` compile/validation failure. Implement as a single mapping in
      `export-report.ts` used by both DOCX and PDF paths (today everything
      exits `1` via `fail()`; extend `fail`'s call sites, not
      `packages/core`).
- [x] `--out-dir <dir>`: alternative to `--output` for choosing a directory
      instead of an exact path; a deterministic slugified filename is
      derived (`<pageId>-<slug>.pdf` for `--scope page`, `<rootPageId|
      spaceKey>-<slug>.pdf` for `--scope tree|space` — one file either way,
      per T3.3's artifact-cardinality contract). `--output` remains valid
      for every scope (it just names the one artifact); only passing both
      `--output` and `--out-dir` together is a usage error. Files:
      `apps/cli/src/commands/export-pdf.ts`, `export.ts`.
- [x] Profile-free token mode for CI: allow running without
      `~/.atlcli/config.json` by accepting `--base-url` (or `ATLCLI_BASE_URL`)
      + `--email` (or `ATLCLI_EMAIL`) + the existing `ATLCLI_API_TOKEN`
      (already highest-priority in `packages/core/src/auth.node.ts:resolveToken`).
      Implement as an ephemeral in-memory `Profile` in the shared `getClient`
      path (`apps/cli/src/commands/export.ts`) so all export formats get it.
      Fail-closed design (the real `AuthConfig` distinguishes `apiToken` vs.
      `bearer`, `packages/core/src/types.ts:8-29`, and `ATLCLI_API_TOKEN`
      silently overrides *any* loaded profile's token,
      `packages/core/src/auth.node.ts:20-50`, both verified): two disjoint
      auth modes only — named profile, or fully ephemeral — never a mix.
      Add `--auth-type api-token|bearer` (or `ATLCLI_AUTH_TYPE`), required
      whenever ephemeral mode targets a non-default deployment type;
      `api-token` requires `--email`/`ATLCLI_EMAIL`, `bearer` forbids it. A
      partially specified ephemeral set (e.g. token + email but no
      `--base-url`) is a usage error raised before any config file or
      keychain lookup is attempted — it must never silently fall back to
      filling the gap from a local profile. `--base-url`/`ATLCLI_BASE_URL`
      requires HTTPS by default (`normalizeBaseUrl` currently leaves an
      explicit `http://` scheme unchanged, `packages/core/src/utils.ts:153-157`,
      verified); allow plain HTTP only behind an explicit, documented
      Data Center opt-in flag. Derive the asset-cache principal (see this
      folder's cache-key task above) from the non-secret auth type plus
      normalized email/username, not from the synthetic profile name alone
      or from the token — a fixed CI profile name must not become a shared
      cache key across different real identities. Document that keychain
      lookup is skipped whenever all ephemeral fields are present.
- [x] Recipe docs (Starlight, `src/content/docs/recipes/`): new page
      `export-automation.md` — GitHub Actions job and GitLab CI job that
      install atlcli, set the token from secrets, run
      `atlcli wiki export … --format pdf --report json --out-dir dist`,
      parse the report with `jq`, and upload artifacts; link from
      `src/content/docs/recipes/index.md` and follow the existing
      `ci-cd-docs.md` page conventions (minimal + advanced example,
      troubleshooting section, related topics).
- [x] Positioning line in the docs per A5: automation = CLI/CI recipe; no
      hosted job API exists or is needed (no polling, no data egress).

### ts-engine default preparation (T3.5)

Scope here is measurement + migration path; the flip itself is a later
one-line change gated on parity.

- [x] Build the parity checklist python→ts as a runnable comparison:
      `apps/cli/src/commands/engine-parity.test.ts` exporting the same
      fixture pages through both engines and diffing observable features
      (headings, tables, lists incl. numbering once T1.13 lands, images,
      links, placeholders, TOC behavior); document intentional differences.
- [x] Close the flag gap: every python-engine flag either works on ts
      (`--include-children` → `--scope tree`, T3.3) or has a documented
      migration; `--no-toc-prompt` and `--no-merge` decisions recorded.
- [x] Add a deprecation notice path: when `--engine` is omitted and the python
      engine is selected by default, print a one-line stderr note announcing
      the upcoming default change and the `--engine python` escape hatch
      (behind a version gate, coordinated with a minor release).
- [x] Migration note in `src/content/docs/confluence/export.md`: what changes
      when ts becomes default, how to pin the old engine, Python no longer
      required once flipped.
- [x] Flip criteria written down (parity test green incl. T1.3/T1.13
      features, one release with the deprecation notice shipped); the actual
      default change is its own follow-up PR.

### Tests (no mocking)

Hard rule: no mocks, no stubbed compilers, no fake clients. Unit tests use the
real wasm; E2E tests use the real Confluence (profile `mayflower`, space
`DOCSY` per `CLAUDE.md`), and clean up what they create.

- [x] Unit — compile-port smoke under `bun test`:
      `apps/cli/src/commands/export-pdf-assets.test.ts` — load wasm + fonts
      through the CLI asset module (the real load path, not the test-only
      `import.meta.resolve` variant), compile a minimal fixture
      `PdfSourceBundle` (reuse the shape from
      `packages/pdf-compiler-browser/src/compiler.test.ts`), assert the
      result starts with `%PDF-` and `validatePdfOutput` passes
      (`pageCount >= 1`, `tagged`, `embeddedFontFiles > 0`). Real wasm, no
      network (fonts pre-materialized via `ensurePdfFonts` in `beforeAll`,
      exactly as `compiler.test.ts` does) — note `ensurePdfFonts()` itself
      does hit the network on a cold cache (`packages/pdf/scripts/ensure-fonts.ts:47-56`,
      verified: sha256-verified download on checksum mismatch), so the
      DoD's "`bun test` offline" claim holds only once the root
      `fonts:ensure`/`prebuild` step has already warmed `packages/pdf/.fonts/`
      — call that out as an explicit CI-ordering precondition, not an
      implicit assumption.
- [x] Regression guard — automate the T3.1 spike's three run-mode check as an
      ongoing CI gate, not a one-time manual verification: source run, `bun
      run build` + `bun ./dist/index.js`, and a `bun build --compile` binary
      each compile the same minimal `PdfSourceBundle` to `%PDF-` bytes, on
      both Linux and macOS runners. This turns the riskiest packaging
      assumption (wasm `with { type: "file" }` survives every build mode)
      into a permanent regression test instead of a spike note that can
      silently bit-rot after T3.1 closes.
- [x] Unit — report schema and exit codes:
      `apps/cli/src/commands/export-report.test.ts` — build reports from real
      `runPdfExport` runs against the fixture bundle (memory sink, pattern:
      `apps/browser-export-harness/src/pdf-case.ts`) and assert the v1 schema
      shape (including the `outputDetails[]`/`issues[]` split from the
      schema-correction task above, validated against the checked-in JSON
      Schema and golden examples) and the error→exit-code mapping table
      (feed real `PdfExportError`s produced by an invalid Typst source, not
      constructed fakes). Include a case with a real Typst *warning* on an
      otherwise successful compile and assert it surfaces in `issues[]`
      (regression for the diagnostics-dropped-on-success bug) and trips
      exit code `2` under `--strict`.
- [ ] Unit — mention resolution parity: a real Storage fixture with an
      account-id-only `@mention` run through both `exportPdf()` and
      `exportWithTsEngine`; assert both produce the same resolved display
      name (or the same degraded-warning note code) as
      `resolveExportMentions` run directly, and that a tree/space export
      with the same account ID on two pages issues exactly one bulk lookup
      call (dedup check).
- [ ] *(harness authored & gated `ATLCLI_E2E=1` in `export-pdf.e2e.test.ts`; live DOCSY run pending — orchestrator)* E2E — single page (run before committing T3.2, per CLAUDE.md workflow):
      script/checklist against profile `mayflower`: create a DOCSY test page
      with a heading, table, and an image attachment; run
      `bun run --cwd apps/cli src/index.ts wiki export <id> --format pdf -o /tmp/atlcli-e2e.pdf --report json`;
      assert file exists, `validatePdfOutput` on the bytes reports
      `pageCount >= 1` and an outline for the heading, the JSON report parses
      and matches schema v1 with `outputDetails[0].embeddedImages >= 1`;
      then delete the test page. Automate as
      `apps/cli/src/commands/export-pdf.e2e.test.ts` gated on an env flag
      (e.g. `ATLCLI_E2E=1`) so `bun test` stays offline by default.
- [ ] E2E — bounded/paginated attachments: create a DOCSY test page with
      more than 100 attachments (or a fixture that forces pagination),
      export it, and assert an attachment near the end of the listing
      resolves correctly (regression for the `listAttachments` pagination
      gap); assert a >25 MiB attachment fixture is rejected without fully
      buffering (streamed-size regression). Clean up all created
      attachments/pages.
- [ ] E2E — cancellation: start a tree export against DOCSY, send SIGINT
      mid-fetch, and assert no partial file lands at the target path, the
      process exits `130`, and no attachment listing/download calls are
      still in flight afterward (regression for the fetch-path
      cancellation task above).
- [ ] *(harness authored & gated `ATLCLI_E2E=1`, DOCSY-only, incl. artifact-cardinality + outline asserts; live run pending — orchestrator)* E2E — tree scope (after T3.3): reuse folder 002's E2E test tree in
      DOCSY (cross-reference its PLAN's fixture naming; do not build a second
      tree) — export root with `--scope tree --label-exclude internal
      --out-dir`, assert chapter ordering matches the tree, excluded page
      absent, exactly **one** entry in `outputs[]` (per T3.3's
      artifact-cardinality contract) and one `sourcePages[]` entry per
      exported page, exit code 0; cleanup of any pages this test created
      itself (the shared tree is owned and cleaned by folder 002's tasks).
- [ ] *(harness authored & gated `ATLCLI_E2E=1`; live run pending — orchestrator)* E2E — failure modes: nonexistent page id → exit 4 and a JSON report
      with `errors` populated when `--report json` is set; bad token
      (`ATLCLI_API_TOKEN=wrong`) → exit 3; assert nothing is written to
      `--out-dir` on failure.
- [x] Unit — `filePdfOutputSink` commit protocol:
      `apps/cli/src/commands/export-internals.test.ts` — concurrent writers
      targeting the same path never corrupt or partially overwrite each
      other (no-clobber holds under a race); writing through a pre-existing
      symlink at the target path is refused; a `--force` write never
      follows a symlink or deletes a directory; Unicode and empty-string
      filenames handled; a temp file left by a killed process is not
      picked up as a valid output on the next run. Run on Linux, macOS, and
      Windows (matches the platforms `.github/workflows/release.yml`
      ships binaries for).
- [x] Regression guard: extend
      `packages/pdf-compiler-browser/src/compiler.test.ts`'s "no
      host-specific imports" idea with a CLI-side test asserting
      `export-pdf.ts`/`export-pdf-assets.ts` import the compiler only lazily
      (a static-import scan, same technique as `compiler.test.ts:75`).
- [x] `bun run typecheck` covers the new files (root `typecheck` already
      includes the pdf-compiler-browser project reference).

## Definition of Done

- Spike verdict recorded; compile port runs under Bun in source, dist, and
  compiled-binary modes on Linux + macOS, verified by an automated CI gate
  (not only a manual spike note) (or `packages/pdf-compiler-node` exists with
  the same `PdfCompilePort` contract and the reason documented).
- `atlcli wiki export <page> --format pdf` produces a tagged PDF that passes
  `validatePdfOutput`, with images resolved through token auth and mentions
  resolved to display names identically to the extension's pipeline; DOCX
  behavior unchanged for existing legacy (no `--format`, no `--engine`)
  invocations — `--engine` remains optional and defaults to `python` for
  DOCX until T3.5's own follow-up PR flips the default.
- `--scope`/`--label-*` work for `--format pdf` and `--format docx --engine ts`
  once folder 002 is merged; usage errors are precise for unsupported
  combinations; `--scope tree|space` always yields exactly one output
  artifact (artifact-cardinality contract in T3.3), verified in the tree E2E.
- `--report json` (and its `--json` synonym) emit schema
  `atlcli.export-report/1` as the sole stdout output — no separate ad hoc
  success shape; per-artifact metrics live in `outputDetails[]`, not
  invented per-`sourcePages[]` fields; a successful compile with compiler
  warnings still surfaces them in `issues[]`; exit codes match the
  documented table and are derived from classified errors, not
  string-sniffed messages; profile-free token mode is fail-closed (named
  profile or fully ephemeral, never a mix) and works with only env vars
  set.
- Failure paths never leave a partial or clobbered file at the target path,
  and a successful commit is never later reported as a failure: the
  `filePdfOutputSink` commit protocol (exclusive temp creation, symlink/
  containment checks, atomic no-replace rename, `finally` cleanup) is
  covered by concurrency/symlink/signal tests on Linux, macOS, and Windows;
  the failure-mode E2E asserts nothing lands in `--out-dir` on error; and
  the `run-export.ts` post-emit-abort-check ordering bug (flagged for
  folder 007 in Risks) does not cause a completed CLI export to report
  failure.
- Authenticated attachment downloads are size-bounded by streamed byte
  count, not only after full buffering, and attachment lookups are not
  limited to the first 100 results per page; a Ctrl-C during fetch or
  discovery actually stops in-flight network I/O (not just future work)
  and exits with a documented code.
- Host adapters added here (`export-internals.ts`'s `PdfAssetResolver`,
  `export-pdf-assets.ts`, `filePdfOutputSink`) take no CLI `flags`/`opts`
  parameters — pure Node ports, consistent with the existing
  `tokenAssetFetcher`/`createAssetByteCache` shape — so their eventual
  extraction into `@atlcli/export-node` (A5(c), post-M1 per T4.1) is a
  mechanical move, not a rewrite.
- Docs updated in the same PRs: `src/content/docs/confluence/export.md`
  (PDF, scope, migration note) and `src/content/docs/recipes/export-automation.md`
  (GitHub Actions + GitLab CI), following the repo docs standards.
- All unit tests pass via `bun test` offline (font/wasm assets pre-warmed by
  `fonts:ensure`/`prebuild`, not fetched by the tests themselves); E2E
  performed against DOCSY/`mayflower` with all created test resources
  deleted; `bun run typecheck` green.

## Risks & open questions

- **Bun wasm-bindgen gaps** (risk, spike-owned): the pinned glue may touch an
  API Bun lacks or implements differently (streaming instantiation, encoder
  quirks). Mitigation: ArrayBuffer-only init path + the `pdf-compiler-node`
  fallback wrapper; the port interface keeps the CLI agnostic.
- **`bun build` asset handling for `with { type: "file" }` into `dist/`**
  (risk): verified for `--compile` binaries by the rasterizer precedent, but
  the plain `--target bun` dist bundle must be re-verified for a multi-MB
  wasm; fallback is `import.meta.resolve` + `readFile` for the dist path.
- **Font materialization is a BUILD-time precondition everywhere, not a
  Windows runtime gap** (investigated after a Windows CI failure, resolved):
  `packages/pdf/.fonts/` is gitignored and only materialized by
  `fonts:ensure`. When absent, Bun fails at module-resolution/bundle time with
  `Cannot find module '@atlcli/pdf/fonts/…'` — reproduced identically on
  macOS, so it is NOT Windows-specific. Consequences and fixes:
  (a) tests that transitively import `export-pdf-assets.ts` need fonts
  provisioned first — the sink/path logic was therefore split into the
  dependency-free `export-pdf-sink.ts` (enforced by a static-import scan) so
  the Windows CI sink job runs without fonts; (b) `release.yml` gained a
  `fonts:ensure` step — without it every target's `bun build --compile` fails
  LOUDLY at bundle time (verified: full CLI compile errors with
  `Could not resolve` sans fonts, succeeds and embeds with them), so a
  silently font-broken shipped binary is impossible; (c) shipped binaries
  (incl. windows-x64, cross-compiled from Ubuntu per `release.yml:17-22`)
  embed the assets at build time and never resolve fonts at runtime.
- **Memory/time budget for space-scope exports** (open): one compiler
  instance across hundreds of pages is unmeasured; the spike measures a
  single page, T4.3 (benchmark suite, Phase 4) owns the large-scale numbers.
  Interim: document a soft page-count guidance in the docs rather than
  promise. Note: UMSETZUNGSPLAN's M1 acceptance criterion explicitly requires
  a 50-page tree export from **both** CLI and harness, DOCX and PDF, with
  byte-stable goldens (`UMSETZUNGSPLAN.md:111-115`) — that is a materially
  smaller, sooner proof than T4.3's later 500-page benchmark, and no folder
  currently commits to producing it before M1 (008's own E2E tasks cover one
  page and folder 002's small fixture tree only). This gap is cross-lane
  (M1 is "all lanes merged"), not 008-specific — flagged for the M1
  conformance harness (T4.6/folder 011) to own; see crossPlanImpacts.
- **Exit-code contract vs. existing `fail()` behavior** (open): today every
  failure exits 1; changing export's codes is additive for CI users but a
  behavioral change for anyone asserting `== 1`. Decide whether the new codes
  apply only under `--report json`/`--strict` or unconditionally — proposal:
  unconditionally for the export command, noted in CHANGELOG.
- **Folder 002 API drift** (dependency risk): T3.3 task names
  (`export-scope.ts`, `compose-document.ts`) follow UMSETZUNGSPLAN T1.1;
  folder 002's own CLI task is the authoritative source for flag *syntax*
  (see Dependencies) — if it lands different flags/semantics than described
  there, only the wiring tasks here change; this folder's job is to consume
  whatever `ExportScope`/`LabelFilter` value 002 produces, not to define its
  shape.
- **Profile-free auth surface** (mostly resolved by T3.4's fail-closed task
  above: env-var forms for `--base-url`/`--email`, an explicit
  `--auth-type api-token|bearer` for Data Center/bearer CI users, and
  HTTPS-by-default are all specified there). Remaining open item: `oauth`
  and `session` (`AuthType`, `packages/core/src/types.ts:8`) stay out of
  scope for ephemeral mode — confirm that's acceptable for the CI JTBD or
  note it as a documented gap.
- **PDF theming flags** (deliberately out of scope, but not indefinitely):
  `PdfThemeOptions` exists (`packages/pdf/src/types.ts:79`) and Lane P
  delivers settings, page format, cover/outline and the template library
  before M1 (`UMSETZUNGSPLAN.md:94-100`) — CLI exposure waits for that
  contract to avoid inventing a second configuration surface, but a
  follow-up CLI-wiring task (dependent on T2.2/T2.4, likely `--pdf-template`
  / `--preset` surfacing exactly Lane P's `render(meta, body, settings)`
  contract) must be tracked once Lane P lands rather than left permanently
  implicit — otherwise PDF branding/settings stay unreachable from the CLI
  through the extension-integration phase, a visible gap against Scroll
  PDF Exporter.
- **Non-preemptible WASM compile; fetch-path cancellation is T3.2's job, not
  free** (open): `AbortSignal` reaches `PdfCompileContext`
  (`packages/pdf/src/compiler.ts:9-15`) but `BrowserPdfCompiler.compile`
  does not accept or check it (`packages/pdf-compiler-browser/src/compiler.ts`,
  verified — no context parameter). Independently, today neither
  `PdfAssetResolver.resolve()` nor `ConfluenceClient.request`'s retry sleep
  is signal-aware (`packages/pdf/src/types.ts:26-28`,
  `packages/confluence/src/client.ts`, verified) — so, correcting an
  earlier draft of this note, Ctrl-C today cannot actually abort an
  in-flight asset fetch, only skip starting new work between
  `runPdfExport` phases. T3.2's cancellation task (above) closes that
  fetch-path gap by threading `signal` through the resolver and reusing
  folder 002's signal-aware HTTP helpers. What remains genuinely out of
  reach after that task lands is the WASM compile itself: no way to
  interrupt it mid-flight. Document that residual limitation rather than
  promising full cancellation; a true fix (worker/subprocess with a kill
  switch) is a larger change to the compiler package, out of scope here.
- **Single-page complexity budget** (open, cross-lane): the memory/time
  risk above covers page *count* and compiler RSS across a tree, not one
  pathologically large or deeply nested single page fed straight into
  `storageToBlocks` (`packages/confluence/src/export-blocks.ts:330`, this
  folder's own Architecture pipeline). The block/table/inline walkers
  there recurse with no depth, node-count, or text-size budget
  (`export-blocks.ts:369-437,597-622,731-747`, verified) — one adversarial
  or corrupted Storage page could exhaust stack/heap on a CI runner
  regardless of tree size or page count. `export-blocks.ts` is owned by
  another lane (see Dependencies/File ownership above), so this folder
  cannot add the guard itself; flagged for the owning plan to add a
  shared `ExportComplexityBudget` (max storage bytes, XML nodes, nesting
  depth, cells, text bytes) at the `storageToBlocks` seam, with a hard,
  non-silent abort (pageId, measured value, limit) on overflow — see
  crossPlanImpacts.
- **Filesystem commit-point ordering bug — RESOLVED by folder 007's T2.1**
  (was: open, cross-lane): earlier drafts of `runPdfExport` re-checked
  `input.signal` immediately after `env.output.emit()` returned, so a signal
  firing in that window turned an already-committed rename into a reported
  failure. The merged `run-export.ts` deliberately has **no** post-emit abort
  re-check (the emit block's comment documents this: abort is honored *before*
  emit; once the sink has committed the bytes the export is never re-reported
  as failed). This folder's `filePdfOutputSink` treats a successful commit as
  its commit point for cleanup bookkeeping, consistent with that contract —
  nothing left to flag.
