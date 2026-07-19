# 008 — PDF CLI & headless export

Status: Plan. Covers Lane K of `specs/export-expansion/UMSETZUNGSPLAN.md`
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
  wires into the CLI.

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
- **T3.2** depends on T3.1 (needs a working compile port).
- **T3.3** depends on **folder 002** (Lane A: `export-scope.ts`,
  `tree-fetch.ts`, `compose-document.ts`, label filters — T1.1–T1.3) and on
  T3.2. Flag names and semantics are agreed here; the wiring lands only after
  folder 002 merges.
- **T3.4** depends on T3.2 (extends its report/exit-code surface).
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
  plain `fetch`.
- `compiler`: the lazily imported `BrowserPdfCompiler` fed from
  `export-pdf-assets.ts` (lazy so non-export commands never pay wasm cost).
- `output`: a filesystem `PdfOutputSink` mirroring
  `packages/docx/src/node-adapters.ts:fileOutputSink`.

Pipeline per page: `client.getPageDetails` → `storageToBlocks(storage)`
(`packages/confluence/src/export-blocks.ts:330`) → `runPdfExport(input, env)` →
`PdfExportReport`. Validation (`validatePdfOutput`) already runs inside
`runPdfExport`; the CLI maps `PdfExportError.phase` to exit codes.

**Command surface** (extends, does not break, the existing DOCX command):

```
atlcli wiki export <page> --format pdf --output out.pdf
atlcli wiki export <page> --format pdf --scope tree --label-exclude internal --out-dir dist/
atlcli wiki export <page> --format docx --engine ts --template corporate -o out.docx
```

`--format` defaults to `docx` (backwards compatible). `--template` stays
DOCX-only for now (PDF templates arrive via Lane P / `atlcli.pdf-template/v1`);
passing it with `--format pdf` is a usage error rather than a silent ignore.

## Tasks

### Spike: WASM under Bun (T3.1)

Goal: a written go/no-go on running the patched typst.ts wasm in the CLI
process, with the port shape committed. Timebox: 2 days.

- [ ] Confirm the baseline: run `bun test packages/pdf-compiler-browser/src/compiler.test.ts`
      on Linux and macOS; record compile time and RSS for the smoke bundle
      (first data point for CI budget). Files: none (evidence in this
      folder's spike notes below the task list or in the PR description).
- [ ] Audit the load path for browser APIs: read the wasm-bindgen glue
      `node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs`
      (as patched by `patches/@myriaddreamin%2Ftypst-ts-web-compiler@0.7.0.patch`)
      and verify the `module_or_path: ArrayBuffer` branch reaches
      `WebAssembly.instantiate` without touching `document`, `window`,
      `URL`-relative script location, or `fetch`. Document which init branches
      (URL/Response) are browser-only and must never be used from the CLI.
- [ ] Build `apps/cli/src/commands/export-pdf-assets.ts`: `with { type: "file" }`
      imports for the typst wasm and the 10 fonts from `@atlcli/pdf/fonts/*`,
      `readFile` into `ArrayBuffer`/`Uint8Array[]`, parity check against
      `PDF_RUNTIME_ASSETS` (pattern: `apps/cli/src/commands/export-rasterizer.ts`,
      `apps/browser-export-harness/src/pdf-worker.ts`). Unlike the rasterizer,
      a load failure here is a hard error — PDF export cannot degrade.
- [ ] Verify the three run modes compile a minimal bundle to `%PDF-` bytes:
      source run (`bun run --cwd apps/cli src/index.ts`), built dist
      (`bun run build` then `bun ./dist/index.js`), and a
      `bun build --compile` binary (the Homebrew shape). Confirm the wasm
      `with { type: "file" }` import survives `bun build --target bun`
      bundling to `dist/` — if dist emits a broken asset path, fall back to
      `import.meta.resolve` + `readFile` for the dist path and keep the
      embedded import for `--compile`.
- [ ] Decide singleton lifecycle: one lazily created compiler per CLI process,
      `reset_shadow()` between pages (already inside `compile()`), `reset()`
      only on fatal diagnostics. Document memory expectations for tree exports
      (N pages through one instance).
- [ ] Write the fallback plan (do not build it unless the spike fails):
      `packages/pdf-compiler-node/` — a thin wrapper package implementing
      `PdfCompilePort` with the same `compile(bundle)` semantics, backed by a
      Node-targeted wasm-bindgen build of the same pinned typst.ts version, to
      be used only if Bun's wasm-bindgen support hits gaps (e.g. glue code
      requiring `TextEncoder` quirks, `performance` APIs, or worker-only
      globals). The CLI depends on the port type from `packages/pdf/src/compiler.ts`
      either way, so swapping implementations is a one-line env change.
- [ ] Record the spike verdict + measurements in this file (append a
      "Spike results" subsection) before starting T3.2.

### CLI command --format pdf (T3.2)

- [ ] Add `--format docx|pdf` parsing to `apps/cli/src/commands/export.ts`
      (`handleExport`): default `docx`; unknown values
      `fail(opts, 1, ERROR_CODES.USAGE, …)`; `--format pdf` + `--template` is
      a usage error; `--format pdf` + `--engine` is a usage error (PDF has one
      engine).
- [ ] New `apps/cli/src/commands/export-pdf.ts`: `exportPdf()` host wiring —
      page resolution reuses the existing `resolvePageId`, then
      `getPageDetails` → `storageToBlocks` → `runPdfExport` with the CLI
      `PdfExportEnv`. Metadata mapping: `title`, `space` (spaceKey), `version`,
      `author`, `exporter: "atlcli"`, `exportedAt`, locale via
      `normalizePdfLocale`.
- [ ] Implement the CLI `PdfAssetResolver` in
      `apps/cli/src/commands/export-internals.ts` (extend, don't fork): reuse
      `createAssetByteCache` + the attachment-listing `downloadUrl` resolution
      from `tokenAssetFetcher`; adapt its return shape to
      `PdfResolvedAsset { bytes, mediaType, filename }`.
- [ ] Implement `filePdfOutputSink(path)` (either in `export-pdf.ts` or shared
      in `apps/cli/src/commands/export-internals.ts`): `mkdir -p` parent,
      write bytes; mirror `packages/docx/src/node-adapters.ts:fileOutputSink`.
- [ ] Add `@atlcli/pdf` and `@atlcli/pdf-compiler-browser` to
      `apps/cli/package.json` dependencies (workspace:*). Keep both imports
      lazy inside the `--format pdf` branch so `atlcli wiki page list` never
      loads wasm.
- [ ] Success output via `output(data, opts)`: `{ success, format: "pdf",
      output: <abs path>, page: { id, title, space }, report: <PdfExportReport
      fields> }` — human-readable summary line in text mode, full object in
      `--json`.
- [ ] Error mapping: `PdfExportError.phase` → message prefix; compile
      diagnostics printed via `formatPdfCompilerDiagnostics`
      (`packages/pdf/src/compiler.ts`); exit codes per T3.4 table.
- [ ] Update help text: `exportHelp()` in `apps/cli/src/commands/export.ts`
      and the `export` line in `wikiHelp()` (`apps/cli/src/commands/wiki.ts`,
      currently "Export page to DOCX with Word templates" → "Export page to
      DOCX or PDF").
- [ ] Docs: extend `src/content/docs/confluence/export.md` with a PDF section
      (minimal + advanced example per the docs standards in `CLAUDE.md`).

### Scope & label flags (T3.3)

Blocked on folder 002 (Lane A, T1.1–T1.3). Agree flag names now; wire after
its merge.

- [ ] Flags in `apps/cli/src/commands/export.ts`: `--scope page|tree|space`
      (default `page`), `--label-include <label>` and `--label-exclude <label>`
      (repeatable — `parseArgs` in `packages/core/src/utils.ts` already
      collects repeated flags into `string[]`; include = OR semantics,
      exclude prunes the subtree, matching folder 002's filter contract).
- [ ] Wire `--scope tree|space` for `--format pdf`: folder 002's tree fetch +
      chapter composition (`packages/confluence/src/export-scope.ts`,
      `tree-fetch.ts`, `compose-document.ts` — names per UMSETZUNGSPLAN T1.1)
      feed the composed block list into the same `runPdfExport` call;
      single-file output per export (chapters, not one file per page).
- [ ] Wire the same flags for `--format docx --engine ts` through the composed
      blocks path in `apps/cli/src/commands/export.ts:exportWithTsEngine`;
      `--scope tree|space` with `--engine python` is a usage error pointing at
      `--engine ts` (the python engine is frozen; see T3.5).
- [ ] Replace the ts-engine `--include-children` limitation note ("not
      supported by the ts engine yet", `export.ts:760`) with `--scope tree`;
      keep `--include-children` as a deprecated alias for the python engine
      only.
- [ ] Progress reporting for multi-page scopes: surface `onPhase` +
      per-page progress on stderr (stdout stays clean for `--report json`).
- [ ] Docs: scope/label section in `src/content/docs/confluence/export.md`
      cross-linking the tree-export feature guide owned by folder 002.

### CI/CD DX & docs (T3.4)

- [ ] `--report json`: print a versioned report object to **stdout** as the
      only stdout output. Schema (v1) in a new
      `apps/cli/src/commands/export-report.ts`:
      `{ schema: "atlcli.export-report/1", format, engine?, pages: [{ id,
      title, output, pageCount?, embeddedImages, renderedDiagrams,
      skippedAssets, notes }], outputs: string[], warnings, errors,
      timings, exitCode }` — a stable projection over `PdfExportReport`
      (`packages/pdf/src/types.ts:128`) and the ts DOCX report; additive
      changes only, breaking changes bump the schema string (A5: "CLI report
      schema versioned and stable").
- [ ] Deterministic exit codes, documented in help + docs and asserted in
      tests: `0` success; `1` usage/config error; `2` completed with warnings
      under `--strict` (new flag: any `warning`-level note fails the build);
      `3` auth error; `4` remote/API error (page not found, fetch failed);
      `5` compile/validation failure. Implement as a single mapping in
      `export-report.ts` used by both DOCX and PDF paths (today everything
      exits `1` via `fail()`; extend `fail`'s call sites, not
      `packages/core`).
- [ ] `--out-dir <dir>`: alternative to `--output` for multi-page scopes;
      deterministic slugified filenames (`<pageId>-<slug>.pdf`), collision
      handling, `--output` with `--scope tree|space` is a usage error.
      Files: `apps/cli/src/commands/export-pdf.ts`, `export.ts`.
- [ ] Profile-free token mode for CI: allow running without
      `~/.atlcli/config.json` by accepting `--base-url` (or `ATLCLI_BASE_URL`)
      + `--email` (or `ATLCLI_EMAIL`) + the existing `ATLCLI_API_TOKEN`
      (already highest-priority in `packages/core/src/auth.node.ts:resolveToken`).
      Implement as an ephemeral in-memory `Profile` in the shared `getClient`
      path (`apps/cli/src/commands/export.ts`) so all export formats get it;
      document that keychain lookup is skipped when all three are provided.
- [ ] Recipe docs (Starlight, `src/content/docs/recipes/`): new page
      `export-automation.md` — GitHub Actions job and GitLab CI job that
      install atlcli, set the token from secrets, run
      `atlcli wiki export … --format pdf --report json --out-dir dist`,
      parse the report with `jq`, and upload artifacts; link from
      `src/content/docs/recipes/index.md` and follow the existing
      `ci-cd-docs.md` page conventions (minimal + advanced example,
      troubleshooting section, related topics).
- [ ] Positioning line in the docs per A5: automation = CLI/CI recipe; no
      hosted job API exists or is needed (no polling, no data egress).

### ts-engine default preparation (T3.5)

Scope here is measurement + migration path; the flip itself is a later
one-line change gated on parity.

- [ ] Build the parity checklist python→ts as a runnable comparison:
      `apps/cli/src/commands/engine-parity.test.ts` exporting the same
      fixture pages through both engines and diffing observable features
      (headings, tables, lists incl. numbering once T1.13 lands, images,
      links, placeholders, TOC behavior); document intentional differences.
- [ ] Close the flag gap: every python-engine flag either works on ts
      (`--include-children` → `--scope tree`, T3.3) or has a documented
      migration; `--no-toc-prompt` and `--no-merge` decisions recorded.
- [ ] Add a deprecation notice path: when `--engine` is omitted and the python
      engine is selected by default, print a one-line stderr note announcing
      the upcoming default change and the `--engine python` escape hatch
      (behind a version gate, coordinated with a minor release).
- [ ] Migration note in `src/content/docs/confluence/export.md`: what changes
      when ts becomes default, how to pin the old engine, Python no longer
      required once flipped.
- [ ] Flip criteria written down (parity test green incl. T1.3/T1.13
      features, one release with the deprecation notice shipped); the actual
      default change is its own follow-up PR.

### Tests (no mocking)

Hard rule: no mocks, no stubbed compilers, no fake clients. Unit tests use the
real wasm; E2E tests use the real Confluence (profile `mayflower`, space
`DOCSY` per `CLAUDE.md`), and clean up what they create.

- [ ] Unit — compile-port smoke under `bun test`:
      `apps/cli/src/commands/export-pdf-assets.test.ts` — load wasm + fonts
      through the CLI asset module (the real load path, not the test-only
      `import.meta.resolve` variant), compile a minimal fixture
      `PdfSourceBundle` (reuse the shape from
      `packages/pdf-compiler-browser/src/compiler.test.ts`), assert the
      result starts with `%PDF-` and `validatePdfOutput` passes
      (`pageCount >= 1`, `tagged`, `embeddedFontFiles > 0`). Real wasm, no
      network (fonts pre-materialized via `ensurePdfFonts` in `beforeAll`,
      exactly as `compiler.test.ts` does).
- [ ] Unit — report schema and exit codes:
      `apps/cli/src/commands/export-report.test.ts` — build reports from real
      `runPdfExport` runs against the fixture bundle (memory sink, pattern:
      `apps/browser-export-harness/src/pdf-case.ts`) and assert the v1 schema
      shape and the error→exit-code mapping table (feed real
      `PdfExportError`s produced by an invalid Typst source, not constructed
      fakes).
- [ ] E2E — single page (run before committing T3.2, per CLAUDE.md workflow):
      script/checklist against profile `mayflower`: create a DOCSY test page
      with a heading, table, and an image attachment; run
      `bun run --cwd apps/cli src/index.ts wiki export <id> --format pdf -o /tmp/atlcli-e2e.pdf --report json`;
      assert file exists, `validatePdfOutput` on the bytes reports
      `pageCount >= 1` and an outline for the heading, the JSON report parses
      and matches schema v1 with `embeddedImages >= 1`; then delete the test
      page. Automate as `apps/cli/src/commands/export-pdf.e2e.test.ts` gated
      on an env flag (e.g. `ATLCLI_E2E=1`) so `bun test` stays offline by
      default.
- [ ] E2E — tree scope (after T3.3): reuse folder 002's E2E test tree in
      DOCSY (cross-reference its PLAN's fixture naming; do not build a second
      tree) — export root with `--scope tree --label-exclude internal
      --out-dir`, assert chapter ordering matches the tree, excluded page
      absent, one report entry per exported page, exit code 0; cleanup of any
      pages this test created itself (the shared tree is owned and cleaned by
      folder 002's tasks).
- [ ] E2E — failure modes: nonexistent page id → exit 4 and a JSON report
      with `errors` populated when `--report json` is set; bad token
      (`ATLCLI_API_TOKEN=wrong`) → exit 3; assert nothing is written to
      `--out-dir` on failure.
- [ ] Regression guard: extend
      `packages/pdf-compiler-browser/src/compiler.test.ts`'s "no
      host-specific imports" idea with a CLI-side test asserting
      `export-pdf.ts`/`export-pdf-assets.ts` import the compiler only lazily
      (a static-import scan, same technique as `compiler.test.ts:75`).
- [ ] `bun run typecheck` covers the new files (root `typecheck` already
      includes the pdf-compiler-browser project reference).

## Definition of Done

- Spike verdict recorded; compile port runs under Bun in source, dist, and
  compiled-binary modes on Linux + macOS (or `packages/pdf-compiler-node`
  exists with the same `PdfCompilePort` contract and the reason documented).
- `atlcli wiki export <page> --format pdf` produces a tagged PDF that passes
  `validatePdfOutput`, with images resolved through token auth; DOCX behavior
  unchanged for existing invocations.
- `--scope`/`--label-*` work for `--format pdf` and `--format docx --engine ts`
  once folder 002 is merged; usage errors are precise for unsupported
  combinations.
- `--report json` emits schema `atlcli.export-report/1` as the sole stdout
  output; exit codes match the documented table; profile-free token mode
  works with only env vars set.
- Docs updated in the same PRs: `src/content/docs/confluence/export.md`
  (PDF, scope, migration note) and `src/content/docs/recipes/export-automation.md`
  (GitHub Actions + GitLab CI), following the repo docs standards.
- All unit tests pass via `bun test` offline; E2E performed against
  DOCSY/`mayflower` with all created test resources deleted; `bun run
  typecheck` green.

## Risks & open questions

- **Bun wasm-bindgen gaps** (risk, spike-owned): the pinned glue may touch an
  API Bun lacks or implements differently (streaming instantiation, encoder
  quirks). Mitigation: ArrayBuffer-only init path + the `pdf-compiler-node`
  fallback wrapper; the port interface keeps the CLI agnostic.
- **`bun build` asset handling for `with { type: "file" }` into `dist/`**
  (risk): verified for `--compile` binaries by the rasterizer precedent, but
  the plain `--target bun` dist bundle must be re-verified for a multi-MB
  wasm; fallback is `import.meta.resolve` + `readFile` for the dist path.
- **Memory/time budget for space-scope exports** (open): one compiler
  instance across hundreds of pages is unmeasured; the spike measures a
  single page, T4.3 (benchmark suite) owns the large-scale numbers. Interim:
  document a soft page-count guidance in the docs rather than promise.
- **Exit-code contract vs. existing `fail()` behavior** (open): today every
  failure exits 1; changing export's codes is additive for CI users but a
  behavioral change for anyone asserting `== 1`. Decide whether the new codes
  apply only under `--report json`/`--strict` or unconditionally — proposal:
  unconditionally for the export command, noted in CHANGELOG.
- **Folder 002 API drift** (dependency risk): T3.3 task names
  (`export-scope.ts`, `compose-document.ts`) follow UMSETZUNGSPLAN T1.1; if
  folder 002 lands different seams, only the wiring tasks here change — flags
  and semantics are the CLI contract and stay as specified.
- **Profile-free auth surface** (open): which of `--base-url`/`--email` also
  get env-var forms, and whether bearer/PAT (`auth.type: "bearer"`) needs the
  same treatment for Data Center users in CI.
- **PDF theming flags** (deliberately out of scope): `PdfThemeOptions` exists
  (`packages/pdf/src/types.ts:79`) but CLI exposure waits for Lane P's
  settings contract to avoid inventing a second configuration surface.
