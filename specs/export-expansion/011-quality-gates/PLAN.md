# 011 — Quality gates: conformance, benchmarks, PDF/UA, security

Status: Plan, 2026-07-19. Covers Phase 4 tasks T4.3, T4.4, T4.6, T4.7, T4.8 and
the parked backlog T4.9 from `specs/export-expansion/UMSETZUNGSPLAN.md`. This
folder is cross-cutting: it does not add product features, it builds the
quality infrastructure that every other folder (001–008) lands into.

**Round 1 (2026-07-20) — landed:** the shape-parity comparison core + real PNG
codec + infra tests; the `ConformanceCase` registry (T4.6 sync point) with a
generic app/Playwright loop and the `assert-case-manifest` drift guard; the
shared `@atlcli/export-fixtures` package; conformance **case 007
`pdf-settings`**; `check-parity.ts` (verified compiling real PDFs under Bun via
the same `BrowserPdfCompiler` the CLI uses); CI wiring (`assert:cases` +
`check:parity`); the seeded 500-page benchmark fixture generator + determinism
tests; and the adversarial SVG policy conformance gate (PDF side). Pending items
carry a one-line note below: feature-lane cases 001–006 land with their folders'
PR waves (002/003/004/001 startable now, 005/006 gated on unmerged specs); the
benchmark runner/M1-corpus/CI-trend, all PDF/UA tasks, the archive/`.docx`/
storage/link/compiler security tasks (several owned by 006/007 or coordinated
with 001/003), the E2E resource-discipline suite (live DOCSY tenant — orchestrator
only), and docs pages are unstarted this round.

**Round 2 (2026-07-20, after 005/006 merged) — landed:** rebased onto
origin/main; TIGHTENED the SVG ratchet — 006's shared `assertSafeSvg` +
BOM-aware `decodeSvgSource` closed every prior `pending-006` gap, so the CSS
`url()`/`@import`/`style`-attr cases and the UTF-16LE case flip from ratcheted
to hard `must-reject` (rules: `css-external-reference` and `blocked-element`);
WIRED the both-engines gate via the shared sanitizer the PDF and DOCX engines
both delegate to (no divergence possible).

**Round 2b (2026-07-20, after every feature spec merged) — landed:** ALL SIX
browser conformance cases 001–006 (`blocks`, `scope`, `content-compat`,
`macros`, `placeholders`, `docx-quality`) with shared block-producing fixtures
in `@atlcli/export-fixtures` (so browser + CLI consume identical bytes),
registered via the round-1 registry/manifest, run through the generic Playwright
loop and the drift guard; the shape-parity gate (`check-parity.ts`) extended
from one case to FIVE PDF cases (all byte + report identical browser vs CLI);
the M1 acceptance corpus + offline `run-m1-acceptance` runner; the cross-plan
archive-policy conformance gate (007's `template-pack`); and a self-skipping
veraPDF PDF/UA ratchet (pattern: the LibreOffice smoke). Still pending: DOCX
per-part cross-host parity for 005/006, the benchmark runner/CI-trend, the
alt-text/language PDF/UA audits + docs (need feature-package source changes,
out of this lane), the remaining source-owned security tasks (raw `.docx`
budget, storage-parse/link-scheme, active-content — all in
`packages/{confluence,docx}` source, out of this lane), E2E discipline
(live-tenant, orchestrator only), and docs pages.

## Reference

- `specs/export-expansion/UMSETZUNGSPLAN.md` — Phase 4 table (T4.3–T4.9),
  milestone M1 acceptance ("CLI **and** harness", T4.6), critical-path note
  that T4.6's harness scaffold is startable immediately.
- `specs/export-expansion/BASELINE-DESIGN.md` — cluster designs A–G that the
  conformance cases must cover.
- Existing conformance host: `apps/browser-export-harness/` —
  `vite.config.ts` (browser-conditions resolve, ES-module worker,
  `assetsInlineLimit: 0`), `src/pdf-worker.ts` (real Typst-WASM compiler +
  pinned fonts in a module Worker, static-asset parity assert),
  `src/pdf-case.ts` (deterministic warm-repeat, structural inspection,
  diagnostic normalization, abort case), `src/docx-case.ts`,
  `src/fixture.ts`, `tests/exports.e2e.ts`, `playwright.config.ts`,
  `scripts/check-output.ts` (artifact scanner).
- Structural PDF gate: `packages/pdf/src/validate.ts`
  (`validatePdfOutput`: page count, `/StructTreeRoot`+`/MarkInfo`,
  `/Outlines`, embedded `/FontFile*`).
- SVG sanitizing (PDF-only today): `packages/pdf/src/prepare.ts`
  (`validateResolvedAsset` — magic-byte sniffing, media-type match, SVG
  script/foreignObject/on*/external-href rejection, 25 MB per-asset and
  50 MB total caps).
- Template scan caps: `packages/docx/src/scan.ts` (`MAX_TEMPLATE_BYTES`
  20 MB, `unzipDocx` validates zip + `word/document.xml` but not entry names,
  entry count, or decompressed size — **this specific gap, raw `.docx`
  uploads, is unclaimed by any feature lane and is this folder's to close**;
  see Security hardening).
- Font pinning: `packages/pdf/scripts/ensure-fonts.ts` (sha256-pinned
  download cache — the pattern folder 007's font-intake seam (B5) already
  commits to reusing for user font imports; see Dependencies).
- **Security ownership living elsewhere, consumed here, not duplicated**:
  `specs/export-expansion/006-word-quality/PLAN.md` (§G4) plans
  `packages/confluence/src/svg-safety.ts` (`assertSafeSvg`, extracted from
  `prepare.ts`'s regex plus new CSS-`url()`/`@import` rejection), shared by
  PDF and DOCX. `specs/export-expansion/007-pdf-template-settings/PLAN.md`
  (§T2.4 / Fonts intake) plans `packages/template-pack/src/{pack,unpack,
  validate}.ts` (path-traversal rejection, per-file/entry-count/total-size
  caps for `.wiki-pdf-template` — its own exported `MAX_TEMPLATE_PACK_BYTES`
  (30 MiB) and `MAX_TEMPLATE_PACK_UNCOMPRESSED_BYTES` (64 MiB) constants,
  **not** `packages/docx/src/scan.ts`'s unrelated `MAX_TEMPLATE_BYTES`
  (20 MB, raw `.docx` uploads — a different archive on a different code
  path, see Security hardening below) — this folder imports 007's constants
  rather than re-declaring its own numbers) and the B5
  font-intake seam (sha256 manifest, sfnt magic-byte check, 10 MB per-font
  cap). This folder does not re-implement any of that — it imports their
  negative fixtures and gates on both engines consuming the identical
  shared modules (see Dependencies, Architecture, Security hardening).
- CI: `.github/workflows/ci.yml` (jobs `docs`, `test`, `test-python`,
  `browser-export-harness` with Playwright Chromium); release workflows
  `release.yml`, `release-cli.yml`, `release-core.yml`, `docs.yml`.
- E2E rules: `CLAUDE.md` (profile `mayflower`, space `DOCSY`, project
  `ATLCLI`, cleanup discipline); docs live in `src/content/docs/`.

## Goal & user value

One promise: **what we ship behaves the same in every host and stays that
way.** Concretely:

- **Shape parity** — a capability that works in the CLI works identically in
  a browser host, proven per feature by the conformance harness, not by hope.
- **Honest performance envelope** — "exports a 500-page tree" is only claimed
  after the benchmark suite measures time and memory for it.
- **Honest accessibility statement** — tagged PDF output is continuously
  checked with veraPDF; docs state exactly what is and is not conformant
  (EU procurement / EAA relevance).
- **Trustworthy inputs** — imported templates and fonts cannot traverse the
  filesystem, smuggle active SVG content, carry Word macros/OLE/altChunk
  payloads, or exhaust memory or compile time; a malformed Confluence page or
  an unsafe link scheme degrades to a visible note, never a crash or a
  silent security hole; every release is preceded by a security review.
- **A clean test tenant** — E2E runs against the real Confluence/Jira cloud
  leave no residue and never run per-PR.

## Dependencies

This folder starts alongside 001 and grows a new conformance case as each
folder lands (UMSETZUNGSPLAN: "läuft ab Phase 1 mit, pro Lane ein Fall").
Folder names 001 and 004–008 are inferred from the lane structure; as of this
writing only `002-scope-orchestration/` and `003-content-features/` exist.

| Folder | Lane / tasks | What 011 consumes from it |
|---|---|---|
| 001 (block model, T0.1/T0.2) | Extended `ExportBlock` union | First new conformance case; fixtures exercise `caption`/`pageBreak`/`orientation`/`anchor`/enriched `unknown` |
| 002-scope-orchestration (Lane A, T1.1–T1.3) | Tree/space scope, chapter compose | Tree-compose case; the 500-page benchmark drives `composeChapters` |
| 003-content-features (Lane C, T1.4–T1.6) | Compat macros, table hardening | Compat-macro case (pagebreak/landscape/caption), 200-row table in bench fixture |
| 004 (macro registry, Lane E, T1.7–T1.10) | `MacroRendererRegistry`, Jira/diagram/export_view renderers | Macro-fallback case with deterministic fetch-port fixtures |
| 005 (placeholders, Lane D, T1.11–T1.12) | includepage + metadata resolvers | Placeholder case over a real template built with `@atlcli/docx/fixtures` |
| 006 (Word quality, Lane G, T1.13–T1.16) | numbering.xml, tblGrid, SVG embedding | DOCX-quality case; SVG path is where the shared sanitizer (T4.7) plugs in |
| 007 (PDF templates, Lane P, T2.1–T2.4) | `settings` threading, watermark, `.wiki-pdf-template` | PDF-settings case; container format is a T4.7 hardening target |
| 008 (CLI, Lane K, T3.1–T3.5) | Bun compile port, `wiki export --format pdf`, scope flags | The other half of shape parity: CLI runs the same fixtures as the harness |

Hard sequencing: each conformance case merges **in the same PR wave as its
feature folder** (it is that folder's acceptance test). The parity comparison
(harness vs CLI) needs 008/T3.1. veraPDF needs at least one real compiled
fixture PDF, i.e. T3.1 or the built harness. Benchmarks need 002 (T1.1) for
tree composition. Everything else in this folder is independently startable.

**Hard prerequisite for the Security hardening section: 006 and 007, not
011, own the shared sanitizer/archive-validator implementations.** 006's
T1.15 (`packages/confluence/src/svg-safety.ts`, `assertSafeSvg`) and 007's
T2.4/B5 (`packages/template-pack/src/{pack,unpack,validate}.ts`, font
sha256/size caps) must land before this folder's cross-plan security gate
tasks can close — 011 asserts both engines consume those exact modules and
supplies the adversarial negative fixtures, it does not build a competing
`packages/core/src/sanitize-svg.ts` or a second `.wiki-pdf-template` cap. Where
011 finds a genuinely unclaimed surface (raw `.docx` upload archive budget,
Confluence storage parse budget, link-scheme policy, compiler execution
budget — none of these appear in 001/003/005/006/007's plans), it owns the
task directly, coordinated with the hot file's existing landing order per
UMSETZUNGSPLAN (see Security hardening).

## Architecture

**Fixtures are the contract.** A new private workspace package
`packages/export-fixtures/` holds deterministic fixtures (blocks, storage
XHTML, template bytes built with `@atlcli/docx/fixtures`, recorded
fetch-port responses). Both consumers import it:

- the harness cases (`apps/browser-export-harness/src/*-case.ts`) run them
  through the **browser** exports (`@atlcli/docx/browser`,
  `@atlcli/pdf/browser`, real module Worker + Typst WASM), and
- a Bun-side parity runner runs the same fixtures through the **CLI-side**
  entry points (node adapters + T3.1 compile port).

**Parity = digest equality, not screenshots.** Each harness case exposes a
sha256 digest of its output bytes (PDF) or a per-zip-part digest map (DOCX,
computed in-page via `unzipDocx`) in its JSON result element. The Playwright
spec asserts case invariants as today; a follow-up parity script compares the
browser digests against the Bun-run digests. Equivalence definition:

- PDF: byte-identical (same wasm, same pinned fonts, deterministic clock —
  `pdf-case.ts` already proves warm-repeat byte-stability).
- DOCX: identical part list and identical bytes per part, **except**
  rasterized media parts (browser canvas vs resvg produce different PNG
  bytes) which compare by decoded-pixel content, not just presence/format/
  dimensions: nonblank check (not all-transparent, not all-one-color),
  alpha-channel presence, content-bounds (the drawn region isn't cropped or
  shifted), and a perceptual pixel-difference metric within a
  fixture-documented tolerance. A same-size blank or wrongly-cropped PNG
  must fail this check — proven by dedicated infrastructure tests that feed
  `check-parity.ts` a deliberately blank/mis-cropped fixture pair and assert
  rejection. OOXML relationships, alt text, and media-part naming stay
  exact-match (never fuzzy).

**Parity is a report contract too, not only output bytes.** Cases assert
`ExportNote`s (e.g. the alt-text audit, the macro-fallback chain) and large
tree/space exports live or die on whether a warning is traceable back to its
source page. `check-parity.ts` compares a canonical projection of both
engines' reports — codes, severity, counts, and failure phase — excluding
only timing and host-specific free text. This requires `ExportNote` to carry
stable source provenance (`pageId`, `pageTitle`, `pageUrl`, `blockPath`,
`assetName`) beyond today's `level`/`code`/`message`/`macroName`
(`packages/confluence/src/export-blocks.ts:115-122`); see Tasks and the
cross-plan note there — the type lives in the hot file sequenced
001→003→004, and the `source` field is owned by 003-content-features
(`003-content-features/PLAN.md`, Walker tasks), which lands it coordinated
with that sequence; 011 specifies and gates the contract, it does not
implement the type extension.

**Security ownership stays with the feature lane that imports the untrusted
input; 011 is the cross-plan gate.** 006 owns the SVG sanitizer consumed by
both engines, 007 owns `.wiki-pdf-template`/font archive validation. 011 does
not re-implement either — it supplies the adversarial fixture corpus (in
`packages/export-fixtures/`) both consume, and asserts the two engines never
diverge on a security verdict for the same input. For the surfaces no lane
claims (raw `.docx` upload archive budget and active-content policy,
Confluence storage parse budget, link-scheme policy, compiler execution
budget), 011 owns the task itself.

**Everything real, nothing mocked.** Ports (`TreeSource`, fetch adapters,
`PdfAssetResolver`, `OutputSink`) are fed deterministic in-memory fixture
implementations — that is the ports' designed seam, exactly as
`memory-output.ts` and `noAssets` do today. Engines, workers, WASM, zip, and
rasterizers are always the production code paths. veraPDF runs on really
compiled PDFs; benchmarks time real compile runs; the E2E sweeper talks to
the real DOCSY space.

**CI layering.** Blocking PR gates stay in `ci.yml` (typecheck, unit,
harness E2E incl. new cases, parity check). Trend/expensive jobs move to
scheduled workflows: `bench.yml` (nightly, non-blocking trend first),
`verapdf.yml` (nightly + release, ratchet on new rule failures),
`e2e-nightly.yml` (live-tenant sweep, nightly only).

## Tasks

### Conformance harness

- [x] Create `packages/export-fixtures/` (private, browser-safe, no IO):
      move/extend `apps/browser-export-harness/src/fixture.ts` content into
      `packages/export-fixtures/src/index.ts`; keep a re-export shim in the
      harness so `docx-case.ts`/`pdf-case.ts` keep working. *(Done: harness
      `fixture.ts` is now `export * from "@atlcli/export-fixtures"`.)*
- [x] **T4.6 sync point (land before the first feature-lane case, i.e.
      before 001/002 merge their harness cases — "startable immediately"
      per UMSETZUNGSPLAN's critical-path note)**: replace the current
      hand-wired `bindCase` calls in `apps/browser-export-harness/src/app.ts`
      (one `bindCase(...)` line + one HTML `<section>` per case today,
      `index.html:14-27`) with a typed `ConformanceCase` registry —
      `apps/browser-export-harness/src/conformance-registry.ts`: `{ id,
      folderTaskIds, engines: ("docx" | "pdf")[], runFixture,
      invariants, mediaPolicy }[]`. A single generic UI loop in `app.ts`
      renders one section/button/result-element per registered case (no
      per-case HTML edit) and a generic Playwright loop in
      `tests/exports.e2e.ts` iterates the registry instead of one
      hand-written `test(...)` per case. Each feature-lane PR then adds
      exactly one entry to the registry array plus its own `*-case.ts` —
      never touches `app.ts`/`index.html`/`main.ts` again. This is the fix
      for the hot-file conflict risk otherwise created by up to 7 parallel
      lanes (A, C, E, D, G, P — UMSETZUNGSPLAN's "peak parallelism") each
      landing a harness case into the same three files in the same window.
      An `apps/browser-export-harness/scripts/assert-case-manifest.ts`
      check (wired into the same CI job) fails the build if the registry's
      case-ID list doesn't exactly match the expected set for the folders
      that have landed — catching an unregistered or duplicated case
      before merge.
- [x] One harness case per folder, registered in the `ConformanceCase`
      registry above, with its own `data-testid` result element, asserted
      via the generic Playwright loop in
      `apps/browser-export-harness/tests/exports.e2e.ts`. Concrete case list
      (**seven browser cases, 001–007**; case 008 is the CLI/Bun parity
      runner below and is deliberately not a browser case — see Definition
      of Done, which is corrected accordingly). *(Round 2: all six feature-lane
      cases 001–006 landed. Shared block-producing fixtures live in
      `@atlcli/export-fixtures` so the browser case and the Bun/CLI parity
      runner consume the SAME bytes; 001–004 emit PDF digests + report
      projections into the shape-parity gate; 005/006 are DOCX-only.)*
  - [x] **Case 001 `blocks`** (`src/blocks-case.ts`): fixture using every new
        `ExportBlock` field (`caption`, `pageBreak`, `orientation`, `anchor`,
        enriched `unknown`) through both engines; asserts no unexpected note
        codes and warm-repeat determinism for the PDF side. *(Done. Caption is
        exercised on `table` + `codeBlock` (no image asset needed → both engines
        emit zero warning notes); DOCX asserts the table grid, landscape
        section, named bookmark and preserved unknown-macro placeholder.)*
  - [x] **Case 002 `scope`** (`src/scope-case.ts`): three-page fixture tree
        through `composeChapters` → both engines; asserts heading-level
        offsets, chapter page breaks, namespaced anchors resolve (no dangling
        link diagnostics), and PDF `pageCount`/outline growth via
        `validatePdfOutput`. *(Done. The fixture carries an in-page anchor +
        link so anchor namespacing is genuinely exercised; compose emits zero
        warnings; DOCX asserts ≥2 chapter page breaks + the namespaced anchor
        bookmark.)*
  - [x] **Case 003 `content-compat`** (`src/content-case.ts`): storage
        fixture with `scroll-pagebreak`, `scroll-landscape`/`-portrait`,
        `scroll-title`→caption, scroll-only/-ignore (exporter-sensitive);
        asserts DOCX section/`w:br` output parts and PDF page count +
        orientation effect; includes the 200-row repeating-header table.
        *(Done. DOCX consumes the storage directly; asserts the page break, the
        `w:orient="landscape"` section and ≥200 table rows; PDF grows past one
        page. scroll-only/-ignore left for a follow-up — the parser side is
        already unit-tested in `@atlcli/confluence`.)*
  - [x] **Case 004 `macros`** (`src/macro-case.ts`): real
        `MacroRendererRegistry` + resolver pass with deterministic in-memory
        fetch ports (recorded Jira search payload, diagram preview PNG bytes,
        export_view HTML); asserts the full fallback chain ends in
        placeholder+report note for an unknown macro and that the Jira table
        renders as a real table block. *(Done via `defaultRegistry` +
        `resolveMacroBlocks` with in-memory Jira + attachment ports: asserts the
        Jira JQL macro → real `table`, the draw.io + unknown macros → placeholder
        FLOOR with `macro-degraded`, and both engines serialize the result. The
        resolution notes ride into the PDF report as source notes so the parity
        gate checks them. Diagram→image PNG embedding is exercised at unit level
        in `@atlcli/export-macros`; the harness keeps the port asset-free for
        byte-stable parity.)*
  - [x] **Case 005 `placeholders`** (`src/placeholder-case.ts`): template
        built with `buildDocx` containing includepage + metadata
        placeholders; real resolver + document pass with an in-memory
        `getIncludedPage` port; asserts cycle protection note and resolved
        part text. *(Done. In-memory `getIncludedPage` via the production
        `buildGetIncludedPage`; asserts the included page text + `$scroll.title`
        resolve, a self-include triggers `includepage-cycle`, and
        `$scroll.metadata.*` degrades with `placeholder-unsupported`.)*
  - [x] **Case 006 `docx-quality`** (`src/docx-quality-case.ts`): asserts
        `word/numbering.xml` exists with multilevel defs, `w:tblGrid` widths
        from `columnWidths`, an SVG attachment lands as svgBlip + PNG
        fallback media parts, and the StyleRef header field survives export.
        *(Done. A nested ordered list forces multilevel numbering (≥9 `w:lvl`);
        `columnWidths: [300,100]` (spread 3.0) forces two real `w:gridCol`
        widths; a safe SVG attachment fed through the canvas rasterizer lands as
        `asvg:svgBlip` + a PNG media pair; the header STYLEREF survives with no
        unused-style warning (the level-1 heading emits the referenced style).)*
  - [x] **Case 007 `pdf-settings`** (`src/pdf-settings-case.ts`): compiles
        the same blocks twice with different `settings` (A4/portrait vs
        Letter/landscape, watermark on, cover/outline toggled); asserts the
        two outputs differ, each is deterministic, watermark text present,
        and a `.wiki-pdf-template` container round-trips through the template
        library. *(Done. "Watermark present" is proven robustly by asserting
        watermark-on vs watermark-off bytes differ rather than glyph-decoding.)*
  - [x] **Case 008** is not a browser case: it is the parity runner below.
        *(Round 2: `check-parity.ts` now proves byte + report parity for FIVE
        PDF cases — `pdf-settings`, `blocks`, `scope`, `content-compat`,
        `macros` — driven by the SAME `@atlcli/export-fixtures` block builders
        on both hosts. DOCX per-part parity for 005/006 stays pending — those
        are DOCX-only cases that assert their invariants in-case; wiring the
        cross-host DOCX per-part digest map is the remaining check-parity work.)*
- [x] Extend each case result with output digests: sha256 for PDF bytes,
      per-part sha256 map for DOCX (via `unzipDocx` in-page); surface them in
      the JSON `*-result` elements. Also surface a canonical projection of
      the case's `ExportNote`s (code, severity, count, failure phase —
      excludes timing and host-specific free text) alongside the digests,
      so the parity gate below can compare reports, not only bytes.
      *(Round 1: `pdf-settings` emits sha256 digests + a report-note projection.
      Round 2: cases `blocks`/`scope`/`content-compat`/`macros` (001–004) now
      emit sha256 PDF digests + report projections too (`emitsDigests: true`),
      all consumed by `check-parity.ts`. The DOCX per-part digest map for the
      DOCX-only cases (005/006) is still pending; the comparison primitives
      (`compareDocxParity`, per-part raster metric) are already built and
      unit-tested in `parity-compare.ts`.)*
- [x] **Shape-parity gate**: `apps/browser-export-harness/scripts/check-parity.ts`
      (Bun) — runs the same `packages/export-fixtures` fixtures through the
      node/Bun entry points (`@atlcli/docx` node adapters, T3.1 compile
      port), computes the same digests and report projection, and compares
      against the manifest the Playwright run writes to
      `apps/browser-export-harness/test-results/digests.json`. Failure output
      names the case and the first divergent part or report code. Two
      documented, distinct comparison strategies for rasterizer-divergent
      media parts (browser canvas vs resvg): OOXML relationships, alt text,
      and media naming compare exact; pixel content compares by decoding
      both PNGs to RGBA and checking nonblank, alpha-channel presence,
      content-bounds, and a perceptual difference metric within a
      fixture-documented tolerance — never by format/dimensions alone (a
      same-size blank or mis-cropped image must fail).
- [x] Wire into CI: add `bun run check:parity` (root `package.json` script)
      to the `browser-export-harness` job in `.github/workflows/ci.yml`
      after the Playwright step. Keep `scripts/check-output.ts` scanning the
      grown bundle (no remote/dynamic code, no native leaks). *(Done; also
      wired the `assert:conformance-cases` drift guard into the same job.)*
- [x] Tests for the infrastructure itself: unit tests for the digest
      comparison, report-projection comparison, and raster-content-metric
      logic in `apps/browser-export-harness/scripts/check-parity.test.ts`
      (pure functions over real zip/PNG bytes from `@atlcli/docx/fixtures`
      — no mocks); include a deliberately blank and a deliberately
      mis-cropped same-size PNG fixture pair and assert the raster check
      rejects both.

### Benchmarks

- [x] Fixture generation strategy: `scripts/bench/generate-fixture.ts` —
      seeded deterministic generator producing a 500-page tree as
      `ExportBlock[]` chapters (per page: ~3 headings, prose paragraphs,
      one list; every 10th page a 200-row table; every 25th page a code
      block and a small deterministic in-memory PNG asset). Emits JSON to
      `scripts/bench/out/fixture-500.json` (gitignored). No network, no
      tenant. This is the **engine tier**: it measures compose/serialize/
      compile only, starting from already-parsed `ExportBlock[]` — it does
      not exercise storage-XHTML parsing, macro resolution, or asset fetch,
      so it cannot alone back the Goal's "exports a 500-page tree" claim
      (UMSETZUNGSPLAN's M1 acceptance explicitly needs labels, `scroll-*`
      macros, draw.io diagrams, and a Jira table — see the M1 corpus task
      below, which is a distinct fixture from this one).
- [~] **M1 acceptance corpus** (new task, precedes the M1 milestone check):
      a versioned 50-page `ExportPageNode[]` tree (not raw blocks) assembled
      from the same fixture building blocks as harness cases 002/003/004/005
      (labels on a subset of pages, `scroll-pagebreak`/`scroll-landscape`/
      `scroll-title` macros, a draw.io preview macro, a live-Jira-table macro),
      committed to `packages/export-fixtures/src/m1-corpus.ts` so it is not
      tenant- or network-dependent. A new script
      `scripts/bench/run-m1-acceptance.ts` runs this corpus through
      `composeChapters` → both engines, producing DOCX and PDF, and emits a
      machine-readable `m1-acceptance.json` record. The M1 milestone in
      UMSETZUNGSPLAN is only marked done once this record is green — a formally
      green M1 that never ran the integrated product story once is the failure
      mode this closes.
      *(Round 2: the corpus + the CLI-side runner are DONE and green offline —
      `run-m1-acceptance` composes the 50-page tree and exports a byte-stable
      (deterministic, compiled-twice-identical) DOCX + real-Typst PDF, emitting
      `{version, corpusDigest, pages, blockCount, docx:{cli}, pdf:{cli},
      digestsMatch, notes}`. Pending: `includepage` sits in the DOCX template
      pass, not the block tree, so it is exercised by case 005, not the corpus;
      the browser-harness (Playwright) M1 leg + `digestsMatch` (browser vs CLI)
      and the diagram's PNG embedding are pending; the LIVE DOCSY acceptance run
      is orchestrator territory. Absolute PDF/DOCX bytes are NOT pinned across
      the repo (they track the Typst wasm/font versions — see Risks); the
      corpus structural digest IS pinned in `generate-m1-corpus.test.ts`.)*
- [ ] Runner: `scripts/bench/run-bench.ts` — phases measured separately with
      wall-clock ms: blocks→compose (002), DOCX serialize+zip, PDF
      serialize+compile (real Typst WASM via the T3.1 Bun port). **RSS
      methodology, made internally consistent**: `/usr/bin/time -v`
      measures one whole-process peak RSS per benchmark run and is recorded
      as `wholeProcessPeakRssBytes` on the run, not per phase — it cannot
      be a "source of truth" for per-phase memory, which the earlier draft
      implied while also claiming per-phase RSS. Per-phase memory instead
      runs each phase (compose, DOCX serialize+zip, PDF serialize+compile)
      in its own child process via `run-bench.ts --phase <name>`, and the
      parent aggregates `/usr/bin/time -v` output per child — this is what
      makes `peakRssBytes` a phase-scoped number rather than a running
      in-process sample contaminated by the previous phase's garbage.
      Output: one JSON record per phase
      (`{commit, date, phase, ms, peakRssBytes, outputBytes, pages}`) plus
      one whole-run record.
- [ ] **End-to-end tier** (extends the engine-only benchmark, addresses the
      parsing/resolver/transfer gap): `scripts/bench/run-e2e-bench.ts` — the
      500-page corpus generated as **storage XHTML** (not pre-parsed
      blocks), run through the real pipeline
      `TreeSource (in-memory fixture) → fetchExportTree → storageToBlocks →
      MacroRendererRegistry resolver pass → composeChapters →
      asset-preparation → engine`, in Bun, each phase in its own child
      process per the methodology above, cold and warm, median of 3 runs.
      A Chromium-hosted variant (browser heap, module-worker transfer cost)
      is explicitly **out of scope for this task** — recorded as an open
      question below, not silently dropped, since it needs Playwright
      wiring this folder doesn't otherwise require for benchmarks.
- [ ] CI thresholds as **non-blocking trend first**: new
      `.github/workflows/bench.yml`, nightly `schedule` + manual dispatch,
      `continue-on-error: true`; uploads the JSON as an artifact, restores
      the previous record via `actions/cache`, and emits `::warning::` when
      time regresses >20% or peak RSS >15% vs the rolling median. Datasets
      record fixture/runtime/compiler/font/OS/runner hashes so a regression
      localizes to a phase and an environment, not just a total. After ~2
      weeks of trend data, freeze absolute budgets in
      `scripts/bench/budgets.json` (placeholders to confirm: 500-page DOCX
      < 60 s / < 1.5 GB RSS; 500-page PDF compile < 180 s / < 2 GB RSS,
      engine tier and end-to-end tier budgeted separately) and flip the
      workflow to failing. Never a per-PR gate.
- [x] Regression tests for the generator (determinism: same seed → identical
      JSON; page/block counts exact) in `scripts/bench/generate-fixture.test.ts`
      and `scripts/bench/generate-m1-corpus.test.ts`. *(Both done:
      generate-m1-corpus.test.ts pins the corpus's page/block/label counts, a
      golden structural sha256, the integrated-story block coverage, and clean
      composition — all pure over the corpus JSON, no compile.)*
- [ ] Document the envelope in `src/content/docs/reference/` once measured —
      engine tier and end-to-end tier reported separately, each tier's scope
      stated explicitly (what it does and does not exercise); this is the
      precondition for any chapter-streaming work (parked, T4.9).

### PDF/UA

- [~] veraPDF in CI over exported fixtures: new
      `.github/workflows/verapdf.yml` (nightly + `workflow_dispatch` +
      release tags). Steps: build, compile the conformance corpus (the
      harness fixture set + the 50-page bench fixture, plus a fixed
      **canary PDF** produced from a minimal known-good fixture) to real
      PDFs with a Bun script `scripts/verapdf/compile-corpus.ts` (T3.1
      port, pinned fonts via `fonts:ensure`), then run the official veraPDF
      CLI **pinned by sha256 digest** (not just a version string — record
      the digest in `scripts/verapdf/verapdf.lock.json` and verify it
      before invoking the binary, same pattern as `ensure-fonts.ts`) with
      `--flavour ua1 --format json`. The canary PDF's expected pass/fail
      rule set is checked first and unconditionally fails the job with a
      distinct "veraPDF tool broken" message if it doesn't match — this
      catches a bad pin/silent-upgrade before it's mistaken for a baseline
      regression.
      *(Round 2: `scripts/verapdf/compile-corpus.ts` DONE and runnable offline
      (compiles a canary + `blocks` + `pdf-settings-a` to real tagged PDFs,
      deadline-wrapped); the self-skipping gate `verapdf.ratchet.test.ts` runs
      veraPDF `--flavour ua1 --format json`, does the canary "tool broken"
      self-check first, then ratchets — SKIPS when the binary is absent, same
      pattern as the LibreOffice smoke. Pending (needs the binary / CI): the
      sha256 `verapdf.lock.json` pin and the `verapdf.yml` workflow — authored
      only when a runner has veraPDF, since neither is verifiable offline.)*
- [~] Ratchet, not aspiration, and precise enough to catch a growing
      regression: store failing verdicts in `scripts/verapdf/baseline.json`
      keyed by `{fixture, ruleId, failureCount, locationsDigest}`, not by
      rule ID alone — a rule ID staying in the baseline while its failure
      count rises on the same fixture (a regression that adds instances
      without adding a new rule) must fail the job, not pass silently. The
      job fails on any rule failure not in the baseline **or** any
      baselined key whose count increases; warns when a baselined key
      starts passing (so the baseline shrinks monotonically). Baseline
      changes are reviewed diffs.
      *(Round 2: the ratchet CORE (`scripts/verapdf/ratchet.ts`) is DONE and
      unit-tested (`ratchet.test.ts`, no binary needed) with synthetic veraPDF
      JSON — proves it catches a NEW rule, a RISING count on a baselined rule
      (keyed by `{fixture, ruleId, failureCount, locationsDigest}`, not id
      alone), and warns on a shrinking baseline. `baseline.json` starts empty;
      it is populated from the first real veraPDF run (a reviewed diff).)*
- [x] Alt-text audit task: emit a dedicated note code (e.g.
      `pdf-image-missing-alt`) from `packages/pdf/src/prepare.ts` when an
      image block has no `alt`; surface it in `PdfExportReport` and the CLI
      `--report json` (T3.4) so authors can fix source pages. Same audit in
      the DOCX path (`packages/docx/src/image.ts`).
      *(Round 3: DONE. `pdf-image-missing-alt` is emitted from
      `preparePdfDocument` with spec 003 provenance (`source.pageId` /
      `blockPath` / `assetName`) — `walk` now threads a block path using the
      serializer's exact convention, so a note locates the offending image
      inside nested containers. Emitted from the SOURCE block before the fetch,
      so an image that fails to embed is audited too; whitespace-only alt counts
      as missing. `PreparePdfOptions.pageContext` lets a host supply the page
      identity external images/single-page exports don't carry, with the block's
      own attachment pageId winning. Reaches `PdfExportReport.notes` via
      prepare → serialize → report, hence `--report json`. DOCX equivalent
      (`image-missing-alt`): `auditImageAltText`/`isMissingAltText` in
      `packages/docx/src/image.ts` (identical whitespace rule, so the engines
      cannot disagree), wired through the image seam's existing outcome-`notes`
      channel in `export.ts` on BOTH the raster and svgBlip paths, reusing
      `budgetMeta`'s page-identity resolution. Only successfully embedded images
      are audited — a failed embed already reports `image-embed-failed`.
      Registry: three codes added to `EXPORT_NOTE_CODES`.)*
- [x] Language audit task: thread `PdfExportMetadata.language` into the Typst
      template (`packages/pdf/src/template.ts`, `set text(lang: ..)`) and
      verify a `/Lang` entry in the catalog; extend
      `packages/pdf/src/validate.ts` with a `hasLang` field and extend
      `packages/pdf/src/validate.test.ts` accordingly. Warn on export when
      metadata has no language.
      *(Round 3: DONE, and the Round-2 note above was STALE on one point:
      `template.ts` ALREADY threads `lang: meta.at("language", …)` /
      `region:` — `git log -S` attributes that to f8b1340 (#42, browser-native
      Typst export), NOT to spec 012 as an earlier draft of this note claimed.
      So NO template change was needed and
      **both pinned digests stay untouched** (`PRE_MIGRATION_DIGEST`,
      `ONE_PER_PAGE_PRE_REFINEMENT_DIGEST` both pass unchanged); no
      re-baselining. That the threading actually produces a catalog `/Lang` is
      proven against the REAL pinned compiler in
      `packages/pdf-compiler-browser/src/pdf-lang-catalog.test.ts` (de → `/Lang
      (de)`, en+GB → `/Lang (en-GB)`, absent → `/Lang (en)`), inspecting
      compiled bytes. `validatePdfOutput` gains `hasLang`, matched against the
      CATALOG object specifically — a `/Lang` on a structure element or an XMP
      `dc:language` packet is not the document-level declaration PDF/UA 7.2
      requires, and `validate.test.ts` pins both negatives.
      `auditPdfLanguage` in `run-export.ts` emits `pdf-language-missing` for
      two independent defects: no usable language on the request (the template
      then silently claims "en"), and no `/Lang` in the produced file — the
      second read from the real output bytes, so a report can never attest to a
      property the file lacks.)*
- [x] Honest conformance statement in docs: new page
      `src/content/docs/reference/pdf-accessibility.md` stating exactly:
      output is **Tagged PDF** with document language, outline, embedded
      fonts, and alt-text pass-through; it is **not certified PDF/UA-1**;
      list the open veraPDF rule gaps from `baseline.json` and link the
      audit note codes. No marketing language; update the page in the same
      PR whenever the baseline changes.
      *(Round 3: DONE, page written + registered in the Astro sidebar. Because
      it is a liability statement, every affirmative claim is PINNED against
      real compiled PDF bytes in
      `packages/pdf-compiler-browser/src/pdf-accessibility-claims.test.ts`
      (tagged + `/Suspects false`, catalog `/Lang`, `/Outlines` from headings,
      embedded `/FontFile*`, author alt → `/Alt` on a `/Figure`) — a template
      change that falsifies a sentence turns that file red. Three findings
      verified while writing and now documented, each a way an export can LOOK
      accessible without being so: (1) a missing alt becomes the FILENAME in
      `/Alt`, not an absent `/Alt`, so a presence-only checker passes while a
      screen reader reads "chart-final-v2.png"; (2) the `outline` setting
      controls the in-body Contents PAGE, not the PDF bookmark outline, which is
      emitted from headings either way; (3) `profile: "pdf-ua-1"` produces
      BYTE-IDENTICAL output to `"tagged"` and writes no `pdfuaid` identifier —
      it records what a host asked for, never what was achieved. The veraPDF
      gap list is honest about being EMPTY: `baseline.json` is `{}` because no
      run has happened (binary pin + workflow still pending), and the page
      states that this means "not yet measured", NOT "zero gaps".)*
- [x] HEAD-bound security attestation artifact: `scripts/security/
      attest.ts` emits `security-attestation.json` (`{commit, date,
      veraPdfDigestOk, veraPdfBaselineDelta, securityReviewNote, m1
      AcceptanceOk}`, unchanged shape) as a CI artifact on every push to
      `main` and on release tags — a machine-checkable summary a future
      release-gate job can `needs:` on. **Decided (was an open point in an
      earlier draft): 009-package-publishing owns the canonical release
      sign-off schema; this artifact is that schema's embedded `security`
      sub-object, not a second parallel file.** 009's "machine-checked
      release sign-off artifact" task (`009-package-publishing/PLAN.md`,
      "Deferred: npm registry publishing" appendix — registry publish, and
      with it this schema, is deferred pending the product-rename decision;
      see that folder's Goal) defines a superset schema (reviewed tarball
      SHA-512/SRI digests, a named reviewer, structured T4.7 scope/result)
      that would embed exactly this artifact's fields under a `security`
      key; this task's output file name/path follows whatever 009's schema
      specifies for that embedding, still produced on the same cadence
      (every `main` push and release tag) described above regardless of the
      deferred status. **Wiring this artifact as a hard `needs:` gate on
      every publish job would be 009's responsibility** once it owns a live
      consolidated release pipeline again; until then, 009's fail-closed
      publish classification (not this attestation gate) is what prevents
      any npm publish today, and this artifact becomes an enforced
      pre-publish gate only if/when that deferred work resumes; recorded as
      a cross-plan dependency, not built here (see Risks and
      crossPlanImpacts).
      *(Round 3: DONE — `scripts/security/attest.ts` + `attest.test.ts` (19
      tests) + `.github/workflows/security-attestation.yml` (push to `main`,
      `v*` tags, `workflow_dispatch`; `fetch-depth: 2` so the baseline delta has
      a parent to diff against; artifact uploaded even on failure). Design rule
      enforced by tests: NEVER attest to something unverified — every field is
      either an established fact or `null`, never collapsed to a
      passing-looking value, and a `checks[]` entry records why each field holds
      its value. That matters today, since the veraPDF binary is not yet pinned
      or present on any runner: the honest output is `veraPdfDigestOk: null`
      with a stated reason. Exit code follows the same line — a DETERMINED
      failure (digest mismatch, failed M1 run) is red, an unperformable check is
      not, because a permanently red job is one nobody reads. `date` is the
      commit's own committer date, not wall-clock, so re-running on one commit
      reproduces the same bytes. `veraPdfBaselineDelta` diffs
      `scripts/verapdf/baseline.json` against HEAD~1 keyed by
      `{fixture, ruleId}` with count/locations changes reported as `changed`.
      `m1AcceptanceOk` READS the benchmark lane's `m1-acceptance.json` rather
      than running the corpus — recording a result and producing one are
      different jobs. Still NOT a publish gate, per this bullet's own decision.)*

### Security hardening

**This section is a cross-plan gate on 006/007's shared modules for the
surfaces they own (SVG sanitizing, `.wiki-pdf-template`/font archive
validation — see Dependencies and Architecture), plus direct ownership of
the surfaces no feature lane claims (raw `.docx` upload archive budget,
Confluence storage parse budget, link-scheme policy, compiler execution
budget).**

- [x] **Cross-plan SVG policy conformance gate** (does not implement the
      sanitizer — 006 does): `packages/export-fixtures/src/svg-corpus.ts`,
      *(Done — 006 merged and this gate now covers BOTH engines with an EMPTY
      pending-gap list. Layer 1: every case runs through the real PDF pipeline
      (`preparePdfDocument`). Layer 2: every case runs through 006's shared
      `assertSafeSvg(decodeSvgSource(bytes))` — the exact function both engines
      delegate to (`packages/pdf/src/prepare.ts:77`,
      `packages/docx/src/export.ts:1121`), so one assertion proves the two
      engines never diverge on a verdict. Corpus verdicts (rule that fires):
      `script`/`foreignObject` → `blocked-element`; `on*` →
      `event-handler-attribute`; external-`href`/`xlink`/`javascript:`/
      `vbscript:` → `non-fragment-reference`; DTD/entity → `doctype-or-entity`;
      `utf8-bom-script` and `utf16le-bom-script` → `blocked-element` (006's
      BOM-aware `decodeSvgSource` decodes UTF-16LE BEFORE the scanner runs, so
      the sanitizer itself now catches it — no longer sniff-only); CSS
      `url()`/`@import` in a `<style>` body AND in a `style="…"` attribute →
      `css-external-reference`. No `pending-006` gaps remain.)*
      an adversarial SVG fixture set covering `script`/`foreignObject`/`on*`/
      external-`href` (today's regex baseline) **plus** CSS-carried
      references (`url(...)`/`@import` in `<style>` bodies and `style="…"`
      attributes), external DTD/entity declarations, BOM/UTF-16 encoding
      variants, and non-`https?`/`data` URI schemes (`javascript:`,
      `vbscript:`). A test in `packages/export-fixtures/src/
      svg-corpus.test.ts` runs every case through both
      `packages/pdf/src/prepare.ts` and `packages/docx/src/image.ts` (006's
      shared `assertSafeSvg`) and fails if either engine accepts a case the
      other rejects, or if any added case is accepted by either engine —
      the corpus is the forcing function for 006's sanitizer to close gaps
      a regex can't reliably close (see Risks: recommend 006 move to a real
      XML parser + canonical reserialization instead of regex if the corpus
      can't be closed safely).
- [x] **Cross-plan archive policy conformance gate** (does not implement
      the validator — 007 does): `packages/export-fixtures/src/
      archive-corpus.ts`, hand-built malicious `.wiki-pdf-template` zips
      (path traversal, symlink entries, declared-vs-actual size mismatch
      "zip bomb", entry-count flood) exercised through
      `packages/template-pack/src/unpack.ts` in a new
      `packages/export-fixtures/src/archive-corpus.test.ts`; fails on any
      case that unpacks successfully or exceeds the documented resource
      budget. *(Done — 007's `template-pack` merged with all caps
      (`too-large-archive`/`too-many-entries`/`path-traversal`/`symlink`/
      `file-too-large`/`uncompressed-too-large`). The corpus supplies 8
      adversarial archives (4 traversal shapes, a symlink, a per-file over-cap,
      a cumulative 90 MiB zip bomb, a 2049-entry flood) + a positive control;
      the gate asserts each is rejected with the EXACT typed kind — a case that
      unpacks, or trips a different guard, fails. The corpus is kept OFF the
      package barrel so its large buffers never load in the browser bundle.)*
- [x] Raw `.docx` template upload archive budget (unclaimed by any feature
      lane — `unzipDocx` in `packages/docx/src/scan.ts` today validates
      only the **compressed** input size against `MAX_TEMPLATE_BYTES`,
      never decompressed size, entry count, or entry names): add a shared
      `ArchiveBudget` (`maxEntryCount`, `maxUncompressedBytes`,
      `maxSingleEntryUncompressedBytes`) enforced during `unzipDocx` via
      declared-size accounting per entry **before** full decompression, and
      the same entry-name rejection rule 007 applies to `.wiki-pdf-template`
      (`..` segments, absolute paths, backslashes, drive prefixes) applied
      here too — a different code path, so not covered by 007's fix.
      Regression tests with hand-built PizZip archives (declared/actual
      size mismatch, path traversal, 100k-entry archive) in
      `packages/docx/src/scan.test.ts`.
      *(Round 3: DONE — `packages/docx/src/scan.ts`. `DOCX_ARCHIVE_BUDGET`
      (`maxEntryCount` 2048, `maxUncompressedBytes` 128 MiB,
      `maxSingleEntryUncompressedBytes` 64 MiB) is enforced by
      `assertArchiveBudget` from each entry's DECLARED central-directory size
      BEFORE any inflation, and `assertSafeDocxEntryName` mirrors 007's
      `assertSafePath` rule (`..`, absolute, backslash, drive prefix, ASCII
      control chars) with docx-local `path-traversal` / `invalid-path` kinds — a
      deliberate mirror, not an import, so `@atlcli/docx` takes no dependency on
      the PDF container format. Numbers are sized against the 20 MB compressed
      cap (~6.4x expansion headroom); rationale is in the constant's doc comment.
      Adversarial tests in `scan.test.ts` build REAL PizZip archives: a 70 MiB
      single-member bomb and a 3x50 MiB cumulative bomb (both well under
      `MAX_TEMPLATE_BYTES`, so only the new guard catches them), a
      `maxEntryCount + 1` flood, five traversal/absolute/backslash names, and
      newline + NUL names — each asserting the EXACT typed kind, plus positive
      controls (a real media-bearing template, an archive exactly at the entry
      cap, ordinary Word part names) and an assertion that the bomb is refused
      WITHOUT inflating it.)*
      *(Round 4, after review: the round-3 budget was DEFEATED BY A LYING CENTRAL
      DIRECTORY and the doc comment claiming "a bomb can never be inflated" was
      false. Declared sizes are attacker-controlled: an archive whose
      `word/document.xml` declared 1 KiB while its DEFLATE stream expanded to
      400 MiB passed every cap and was inflated (measured RSS +819 MiB in 227 ms),
      then failed with an UNTYPED `Error: Bug : uncompressed data size mismatch`.
      Fixed with `assertPlausibleCompression`, which bounds the declared:compressed
      ratio in BOTH directions from central-directory metadata only: an
      under-declaring member is provably lying (DEFLATE never expands its input,
      so `declared < compressed x 0.9` is impossible), and an over-declaring one
      is a sub-cap bomb. Re-probed: the same liar is now refused in 0 ms with
      +1 MiB RSS. The upper bound is 500:1, NOT the 100:1 first chosen —
      measurement showed a legitimate 20 000-identical-paragraph template
      compresses 304.9:1, so 100:1 rejected real templates; 4000-paragraph prose
      is 26.6:1 and incompressible media ~1:1. PizZip's inflate errors are now
      translated to a typed `corrupt-entry` `DocxError` via `readPartText`.
      Residual risk stated honestly in the source: an entry whose declared size is
      CONSISTENT with its compressed stream but whose data decodes to something
      else still inflates before PizZip's post-hoc length check; PizZip exposes no
      bounded inflate, so that spike is bounded by `MAX_TEMPLATE_BYTES` rather
      than eliminated.)*
- [x] Active-content policy for imported `.docx` templates: reject-on-import
      (a new `DocxError` kind, never a silent strip) when the archive
      contains `word/vbaProject.bin`, an `word/activeX/*` OLE/ActiveX
      control part, or an `<w:altChunk>` reference in `document.xml`.
      Audit (surface, don't silently pass) field instructions containing
      `INCLUDETEXT`/`INCLUDEPICTURE`/`DDE`/`DDEAUTO` as a
      `template-field-instruction-risk` note — `preprocessScrollText`
      (`packages/docx/src/export.ts`) intentionally leaves field
      instructions untouched while `ensureUpdateFields` sets
      `<w:updateFields w:val="true"/>`, and that combination is exactly
      what lets a malicious template's field instruction execute on open in
      Word. Real hand-crafted fixture templates (VBA-bearing, altChunk,
      DDEAUTO field) in `packages/docx/src/scan.test.ts` and
      `packages/docx/src/export.test.ts`.
      *(Round 3: DONE — a new `active-content` `DocxError` kind, thrown by
      `assertNoActiveContent` inside `unzipDocx`: REJECT, never strip (a silent
      strip would return a document that looks like the user's template but is
      not, and would make the control invisible). Covers `word/vbaProject.bin`
      and `word/vbaData.xml` (case-insensitive — `word/VBAProject.BIN` is the
      same part to Word), `word/activeX/*`, and `<w:altChunk>` in `document.xml`
      AND in header/footer parts (the spec named only `document.xml`; headers
      accept the element too, so leaving them out was a bypass). The field-
      instruction audit is `collectRiskyFieldInstructions` (reusing
      `collectStylerefFields`' run-split reassembly, so a `DDEA` + `UTO` split
      across `w:instrText` runs still matches); hits land on
      `ScanResult.riskyFieldInstructions` and `exportDocx` turns them into a
      `template-field-instruction-risk` warning. Fixtures: a real CFB/OLE2-
      signature `vbaProject.bin`, an ActiveX part with a real CLSID, altChunk in
      body and header, a run-split `DDEAUTO cmd.exe` field and an `INCLUDETEXT`
      UNC `fldSimple`; positive controls prove `activex-logo.png`, the literal
      text "w:altChunk", and ordinary `PAGE`/`STYLEREF`/`TOC` fields all pass.)*
      *(Round 4, after review: the round-3 path-based checks were BYPASSABLE, and
      all ten bypasses were reproduced against the built output before fixing.
      altChunk was accepted in `word/footnotes.xml`, `word/endnotes.xml`,
      `word/comments.xml` and `word/glossary/document.xml` (`CT_AltChunk` is in
      `EG_BlockLevelElts`, so it is valid in all of them — the same argument that
      justified adding headers applied verbatim and had been under-applied);
      `<x:altChunk>` under a non-`w` namespace prefix was accepted (XML binds
      namespaces by URI, not prefix); VBA was accepted at `word/macros/` and
      `customXml/`, ActiveX at `word/controls/`. Rewritten around OPC
      RELATIONSHIP TYPES, which is how Word actually resolves these parts and the
      only channel that cannot be evaded by relocating a file or renaming a
      prefix: `findActiveContentRelationship` matches `/aFChunk`, `/vbaProject`
      and `/control` in any `.rels` part. The element scan now covers every
      WordprocessingML part under ANY namespace prefix, and the path scan matches
      on basename/segment rather than exact location. `/oleObject` is a deliberate
      ALLOW (embedded charts and spreadsheets are legitimate in corporate
      templates) recorded in code and pinned by a test. Re-probed after the fix:
      all ten bypasses REJECTED, both positive controls still ACCEPTED.
      Additionally `DDE`/`DDEAUTO` moved from AUDIT to HARD REJECT — they have no
      legitimate use in an export template and `ensureUpdateFields` makes the
      exporter itself arm the trigger — while `INCLUDETEXT`/`INCLUDEPICTURE` stay
      audited. The rejection lives in `assertNoActiveContent` inside `unzipDocx`,
      so the guarantee no longer depends on which entry point a host uses.
      API: `ScanResult.riskyFieldInstructions` was made OPTIONAL to keep spec
      009's additive-only freeze; `DocxErrorKind` widening 3 -> 11 is a DELIBERATE
      break, safe because both consumers (`template-pack/validate.ts`, the
      extension upload panel) read `kind` non-exhaustively — the extension's
      fallback was fixed, as it told a user with a macro template "That template
      is too large.")*
- [x] Confluence storage parse budget (**cross-plan coordination note**:
      touches `packages/confluence/src/export-blocks.ts`, the hot file
      UMSETZUNGSPLAN sequences T0.1→T1.4→T1.8 — land as a small additive PR
      after T0.1 merges, coordinated with folder 001, not a solo 011
      change; this task specifies the requirement and gate, folder 001
      implements it): `parseXml` and its recursive walkers
      (`walkBlocks`/`walkInline`/`handleBlockElement`) have no node-count
      or nesting-depth limit — `maxPages` (002) bounds tree size, not a
      single pathological page's storage XML. Add a `StorageParseBudget`
      (max node count, max nesting depth, max expanded text length),
      throwing a typed, catchable error rather than risking a stack
      overflow. Malformed/deep-nesting/control-character storage fixtures
      (hand-authored) in `packages/confluence/src/export-blocks.test.ts`,
      run through both engines via a new harness/parity negative-fixture
      case owned by this folder.
      *(Round 3: DONE — the cross-plan sequencing constraint is SATISFIED and
      verified: 001 (#49), 003 (#54) and 004 (#55) are all merged into
      origin/main, so `export-blocks.ts` is no longer a contended hot file and
      this landed as the small additive PR the note asked for.
      `StorageParseBudget` (`maxNodes` 400 000, `maxDepth` 256, `maxTextLength`
      16 MiB, overridable via `StorageToBlocksOptions.parseBudget`) is enforced
      in `parseXml`, throwing the typed, catchable `StorageParseError`
      (`too-many-nodes` / `too-deep` / `text-too-long`). Capping DEPTH at the
      parse boundary is what makes the walkers safe — they recurse strictly along
      the tree `parseXml` produced, so `walkBlocks`/`handleBlockElement`/
      `walkInline` need no counter of their own. The control-character fixture
      the task asked for found a REAL bug: `&#x1;` survives storage and
      `encodeXmlText` does not escape it, so it reached `<w:t>` verbatim and
      produced a `.docx` Word refuses to open ("unreadable content"). Text nodes
      and attribute values are now stripped of XML-1.0-illegal characters at the
      same single boundary. Tests include a control proving the 50 000-deep
      nesting bomb IS a real `RangeError` once the depth cap is lifted, so the
      guard is demonstrably load-bearing, plus a test showing one bad page
      degrades while its neighbours still export.)*
      *(Round 4, after review: the round-3 budget REJECTED ORDINARY PAGES and
      nothing caught the error, so a normal page killed an entire tree export —
      an availability regression on real input, the opposite of the intent.
      Measured node density per storage shape: colour-span prose 56 375/MiB, rich
      text 74 415, nested lists 109 553, tables 126 333, dense 4-column tables
      177 029. Confluence Cloud accepts ~5 MB bodies, so the worst realistic page
      is 177 029 x 5 = 885 145 nodes — and `maxNodes: 400_000` sat BELOW the
      platform limit, measurably rejecting a 4 MiB table page. Raised to
      2 000 000 (~2.3x the worst realistic 5 MB page) with the derivation table in
      the constant's doc comment. Second half: `StorageParseError` was caught
      NOWHERE in production — in `tree-fetch.ts` it became a rejected
      `allSettled` entry that was re-thrown — so the "one bad page degrades"
      claim was true only of a hand-rolled loop in a test. `fetchExportTree` now
      catches it narrowly and routes it through the EXISTING completeness path:
      strict mode aborts with a typed `ExportCompletenessError`, partial mode
      renders a placeholder chapter and keeps going, and the note carries a
      `detail` so "page-unreadable" does not hide "exceeded the parse budget:
      too-deep". Reusing `page-unreadable` avoided widening `CompletenessCode`.
      Tests pin all three behaviours plus a control proving an unrelated error
      still propagates untouched.)*
- [x] Link-target scheme policy (**same cross-plan coordination note** —
      lands with folder 001/003, specified and gated here): `<a href>`/
      `ac:link` targets flow verbatim from Confluence storage into DOCX
      hyperlink fields (`packages/docx/src/serialize.ts`) and PDF
      `#link()` calls (`packages/pdf/src/serialize.ts`) with no scheme
      check today. Add a shared `sanitizeLinkHref(href)` — allow
      `https?:`, `mailto:`, and in-document anchors; degrade anything else
      (`javascript:`, `data:`, `file:`, `vbscript:`, embedded control
      characters) to visible text plus an `unsafe-link-skipped` note —
      consumed by both serializers. Malformed-URI fixtures run through both
      engines via the same negative-fixture case as the storage budget
      above.
      *(Round 3: DONE, and UNIFIED rather than added as a third implementation.
      The repo carried THREE answers to "is this href safe?": `isSafeLinkScheme`
      (confluence/html-to-blocks.ts, 004), `isSafeHyperlinkUrl`
      (docx/ooxml.ts, 004 — a hand-copied duplicate), and an inline
      `/^(https?:|mailto:)/i` in pdf/serialize.ts's `resolveLink` that silently
      DISAGREED with both (no control-character stripping; rejected the relative
      URLs the other two allowed). New canonical module
      `packages/confluence/src/link-safety.ts` (`isSafeLinkScheme`,
      `sanitizeLinkHref`, `normalizeLinkHref`, `UNSAFE_LINK_NOTE_CODE`) is now
      the single source of truth; all three delegate to it and the old names
      survive as thin wrappers so the published API is unchanged. The DEGRADATION
      moved up to the walkers (`export-blocks.ts` for storage `<a href>`,
      `html-to-blocks.ts` for export_view HTML), so both engines inherit it and
      the user sees an `unsafe-link-skipped` warning; the DOCX `hyperlinkField`
      and PDF `resolveLink` re-checks stay as defense in depth. PDF now
      distinguishes a blocked scheme (warning, `unsafe-link-skipped`) from a
      merely unrepresentable target (info, `pdf-link-unresolved`).
      `link-safety.test.ts` carries a 21-entry blocked corpus (javascript,
      vbscript, data, file, jar, ms-msdt, search-ms, plus tab/newline/CR/NUL/
      vertical-tab smuggling and case variants), an 11-entry allowed corpus as
      positive control, and a DRIFT GUARD asserting both walkers reach the
      identical verdict for every entry.)*
      *(Round 4, after review: `sanitizeLinkHref` validated the NORMALIZED href
      but returned the RAW one, so a caller could act on bytes the policy never
      examined. It now returns the control-character-stripped form (case and
      spaces preserved — only controls are removed). `normalizeLinkHref`'s
      character class was rewritten in explicit `\u0020` form instead of using a
      literal space as a range endpoint. `tel:` was added to the allowlist as a
      deliberate product call: contact and directory pages legitimately carry
      phone links and the scheme is inert (it hands a number to a dialler, it
      cannot execute or fetch). `sms:`/`callto:`/`skype:` stay blocked — rarer in
      enterprise wikis, no demonstrated need — and degrade to visible text with a
      note. Both decisions are pinned by tests.)*
- [~] Compiler execution budget: `BrowserPdfCompiler.compile()`
      *(Partial: `check-parity.ts`, `run-m1-acceptance.ts`, and
      `compile-corpus.ts` now all wrap every Bun-side compile in a wall-clock
      deadline that throws a stable `compile-timeout` code. The harness
      worker-terminate auto-deadline and the same wrapper on `run-bench.ts` are
      pending with that (unwritten) script.)*
      (`packages/pdf-compiler-browser/src/compiler.ts`) runs the WASM
      compile synchronously with no wall-clock or memory budget; folder
      008's own plan documents this as an "unchanged limitation... a true
      fix (worker/subprocess with a kill switch) is a larger change to the
      compiler package, out of scope here"
      (`specs/export-expansion/008-pdf-cli/PLAN.md:902-903`), and the
      harness's worker-terminate path
      (`apps/browser-export-harness/src/pdf-worker-client.ts`) only fires
      on an explicit `signal.abort()`, never automatically. Scoped to what
      011 already runs in CI (it does not sandbox arbitrary user-authored
      Typst — that is Level-B/future work per 007, out of scope until that
      feature ships, see Risks): add an automatic wall-clock deadline that
      triggers the harness's existing worker-terminate path, and an
      equivalent subprocess-with-timeout wrapper around every Bun-side
      compile call this folder's own scripts make
      (`check-parity.ts`, `compile-corpus.ts`, `run-bench.ts`,
      `run-m1-acceptance.ts`) so a pathological fixture never hangs CI. A
      stable `compile-timeout` error code, never a silent hang.
- [x] `/security-review` before releases *(Round 3: DONE — a "Security Review
      Before Every Release" section in `src/content/docs/contributing.md` with a
      surface/what-to-check/where table covering the raw `.docx` upload,
      `.wiki-pdf-template`, embedded SVG, storage parse budget, link schemes,
      font intake and any new network code, referenced from the Prerequisites
      list; and a pre-release checklist in `showDryRunPlan`
      (`scripts/release.ts`). The reminder is ADVISORY — the script does not
      block — so its only force is being printed, which is exactly why
      `release.test.ts` now regression-tests that the line and the named
      surfaces are present.)*: add a "Security review completed
      for this release" line to the release runbook section in
      `src/content/docs/contributing.md`, and make
      `scripts/release.ts --dry-run` print a reminder checklist item; the
      review covers exactly the import surfaces above plus new network
      code since the last tag. The stronger, blocking version of this gate
      (refusing to publish without a green `security-attestation.json`) is
      009's to wire once the canonical release pipeline lands — see PDF/UA
      above and Risks.

### E2E resource discipline

- [ ] Naming convention: every live test resource is named
      `atlcli-e2e-<feature>-<timestamp>` (epoch seconds; e.g.
      `atlcli-e2e-scope-tree-1789000000`) — Confluence pages in space
      `DOCSY`, Jira issues in project `ATLCLI` (summary prefix). Helper
      `makeE2eTitle(feature)` in a new shared test helper
      `apps/cli/src/e2e/resources.ts` used by all live E2E scripts
      (including `scripts/e2e-template-test.sh` successors).
- [ ] **Machine-readable ownership marker, not name/timestamp alone**: at
      creation, every E2E-created page also gets a content property
      (`atlcli-e2e-run-id` → the CI run ID or a local UUID) and every
      Jira issue gets an equivalent issue property. A visible-title prefix
      and a parsed timestamp prove neither test ownership nor protect
      against a same-named user page or two E2E runs racing in the same
      window — the property is the actual ownership proof a deletion path
      checks before deleting.
- [ ] **Per-test cleanup first, sweeper as recovery only**: each E2E test
      records the IDs it creates and deletes them itself in a `finally`
      block (`apps/cli/src/e2e/resources.ts`) — the tenant is clean after
      every single run, not just after the nightly sweep. This is on top
      of, not instead of, the existing "clean up test resources" workflow
      rule in `CLAUDE.md`.
- [ ] Cleanup helper task in the CLI test suite:
      `apps/cli/src/e2e/cleanup.ts` — using `ConfluenceClient`/`JiraClient`
      with profile `mayflower`, list `DOCSY` pages / `ATLCLI` issues that
      carry the `atlcli-e2e-run-id` marker property **and** whose title/
      summary matches the naming convention **and** are older than 24 h
      (parsed from the timestamp suffix, so a running E2E is never
      deleted) — all three conditions required, not name/timestamp alone.
      Fully paginate the listing (never stop at the first page). A
      **maximum-delete circuit breaker** (e.g. 50 resources per run):
      exceeding it aborts the whole sweep with a non-zero exit and no
      deletions past the limit, fail-closed, rather than let a bug in the
      query silently wipe the tenant. Dry-run by default; `--force`
      deletes. Unit-test the pure parts (title parsing, age filter,
      marker-match, circuit-breaker threshold) in
      `apps/cli/src/e2e/cleanup.test.ts`; the deletion path is exercised
      only against the live tenant.
- [ ] CI wiring, nightly only: `.github/workflows/e2e-nightly.yml`
      (`schedule` + `workflow_dispatch`, main branch only) runs the new
      scope/macro E2E cases (T4.8 scope) and then `cleanup.ts --force` as
      **recovery for whatever per-test cleanup missed** (a crashed run, a
      killed CI job) — not the primary cleanup mechanism. Rate/cost
      considerations, documented in the workflow header: live Cloud REST
      calls count against the tenant's rate limits and pollute space
      history, credentials are repo secrets that must not be exposed to
      fork PRs — therefore **never** per-PR, never on forks; the sweeper
      also runs even when the E2E step fails (`if: always()`).
- [ ] Documentation: add an "E2E resources" section to
      `src/content/docs/contributing.md` (naming convention, run-id marker
      property, 24 h TTL, per-test cleanup-in-`finally` expectation,
      sweeper usage `bun apps/cli/src/e2e/cleanup.ts`, circuit-breaker
      behavior, nightly workflow); cross-reference the CLAUDE.md workflow
      rules so local agent runs follow the same convention.

### Parked backlog

Listed as explicit **non-goals** of this folder and of Phase 4 (T4.9); each
would re-enter planning as its own numbered folder with its own conformance
case:

- [ ] Record in this folder's README-of-record (this PLAN) only — no code:
      RTL support; multi-space export; back-of-book index and
      table-of-figures/tables (C1/C2); named destinations (C7); the PDF
      placeholder system D4; chapter streaming (explicitly gated on T4.3
      benchmark data first).

## Definition of Done

- Every folder **001–007** has exactly one green harness case in
  `apps/browser-export-harness/`, registered via the `ConformanceCase`
  registry (no hand-edited `app.ts`/`index.html` per case), asserting its
  capability through the real browser pipeline (module Worker, Typst WASM,
  real fonts); case **008 is the CLI/Bun parity runner, not a browser
  case** — `check-parity.ts` proves digest-level equivalence *and*
  report-projection equivalence between harness and CLI outputs for the
  same fixtures in `ci.yml`, including a raster-content check (not just
  format/dimensions) for rasterizer-divergent media.
- The **M1 acceptance record** (`m1-acceptance.json`) is green: the 50-page
  labels/`scroll-*`/draw.io/Jira corpus runs through both CLI and harness,
  DOCX and PDF — this is the concrete evidence behind UMSETZUNGSPLAN's "CLI
  **and** harness" M1 acceptance line, not the engine-only bench fixture.
- `bench.yml` produces nightly trend records, separately for the engine
  tier and the end-to-end tier, with per-phase time and per-phase peak RSS
  measured in isolated child processes (never a single whole-process
  `/usr/bin/time -v` number presented as per-phase data); budgets are
  frozen in `scripts/bench/budgets.json` per tier after the trend window
  and the workflow enforces them (still not a per-PR gate).
- `verapdf.yml` runs a digest-pinned veraPDF binary (`--flavour ua1`) over
  really compiled corpus PDFs, self-checked against a canary PDF first; a
  checked-in shrinking baseline keyed by `{fixture, ruleId, failureCount,
  locationsDigest}` gates both new rule failures and rising failure counts
  on an already-baselined rule; the docs page
  `src/content/docs/reference/pdf-accessibility.md` states the honest
  conformance status and matches the current baseline; a
  `security-attestation.json` artifact is produced on every `main` push
  and release tag.
- 011 does not own a second SVG sanitizer or a second `.wiki-pdf-template`
  cap: the cross-plan SVG and archive conformance corpora
  (`packages/export-fixtures/src/{svg,archive}-corpus.ts`) pass against
  006's `svg-safety.ts` and 007's `template-pack`. For the surfaces no
  lane claims — raw `.docx` upload archive budget + active-content policy,
  Confluence storage parse budget, link-scheme policy, compiler execution
  timeout — the dedicated tasks in Security hardening are green with
  regression tests on real hand-built fixtures (never mocked). The release
  runbook and `release.ts --dry-run` reference the `/security-review` gate.
- Live E2E resources follow `atlcli-e2e-<feature>-<timestamp>` **and**
  carry a `atlcli-e2e-run-id` marker property; each test cleans up its own
  resources in `finally`; the nightly sweeper is recovery-only, fully
  paginated, marker-gated, and aborts fail-closed past its max-delete
  circuit breaker; the convention is documented in
  `src/content/docs/contributing.md`.
- `bun run typecheck` and `bun test` pass; no case, script, or workflow
  mocks engine internals — only designed ports receive fixture
  implementations.

## Risks & open questions

- **Folder naming drift**: folders 001 and 004–008 do not exist yet; the
  case list maps to lanes, not final folder names. Re-check the mapping when
  each folder's PLAN lands and rename case files to match.
- **DOCX determinism across runtimes**: parity assumes all non-media parts
  are byte-stable between Bun and browser zips (compression settings,
  timestamps). If PizZip output differs per platform, the parity script must
  normalize (store-only compression or per-part XML canonicalization) —
  decide at implementation of `check-parity.ts`.
- **PDF byte-parity vs compiler versions**: byte-identity holds only while
  CLI and harness pin the same compiler wasm and font bytes. The parity
  script must fail loudly on `compilerVersion` mismatch rather than
  producing a confusing byte diff.
- **veraPDF flavour**: whether to ratchet against `ua1` only or also `ua2`
  (ISO 14289-2); ua2 tooling is younger. Proposal: ua1 baseline now, ua2
  informational.
- **Typst tagging limits**: some PDF/UA rules may be unreachable without
  upstream compiler changes; the baseline will encode that honestly, but we
  need a policy for "wontfix upstream" entries (annotate with an issue link
  in `baseline.json`?).
- **Bench stability on shared runners**: GitHub-hosted runner variance may
  exceed the 20% warning threshold; if the trend is too noisy, switch to
  median-of-3 runs per night before freezing budgets.
- **Nightly tenant cost**: confirm the DOCSY space is dedicated to test
  residue and that nightly volume stays within the tenant's API rate
  budget; if not, reduce to twice-weekly.
- **Where does the parity runner live** once packages publish (T4.1)? If
  `packages/export-fixtures` would leak into published artifacts, keep it
  `private: true` and excluded from the publish pipeline — verify against
  the T4.1 folder's plan.
- **SVG sanitizer regex vs. structural parsing**: this folder's adversarial
  corpus (CSS `url()`/`@import`, DTD/entities, encoding variants, exotic
  URI schemes) may not be closeable by 006's regex-based `assertSafeSvg`
  without false positives on legitimate diagrams. If the corpus can't be
  closed safely, the recommendation — not a task owned here — is for 006 to
  move `assertSafeSvg` to a real XML parser with no DTD/entity resolution,
  an element/attribute/URI allowlist, and canonical reserialization of the
  bytes actually embedded, rather than pattern-matching on the source
  string. Flag to 006 as a design input, not a requirement enforced by this
  plan (see crossPlanImpacts).
- **Hot-file coordination for the storage-parse-budget and link-scheme
  tasks**: both touch `packages/confluence/src/export-blocks.ts` and the
  two serializers, sequenced by UMSETZUNGSPLAN as T0.1→T1.4→T1.8 (block
  model → content macros → macro registry). This folder specifies and
  gates the requirement; the actual PR must be coordinated with whichever
  of 001/003/004 is landing at the time, not merged as a solo 011 change
  that jumps the hot-file queue.
- **Compiler execution budget is a mitigation, not a sandbox**: the
  wall-clock/subprocess-timeout task here only protects the compile calls
  011's own CI scripts make. It does not sandbox arbitrary user-authored
  Typst templates in production — that capability (Level-B custom
  templates) doesn't exist yet per 007's own plan
  (`specs/export-expansion/007-pdf-template-settings/PLAN.md:332`, "Level-B
  follow-up work in the host"). When Level-B ships, its owning folder must
  design real worker/subprocess isolation with a kill switch for
  production compiles, not just CI; this folder's timeout wrapper is a
  useful pattern to reuse then, not a substitute for it.
- **Release-gate wiring depends on 009's consolidated pipeline**: this
  folder produces `security-attestation.json` and a finer-grained veraPDF
  ratchet, but making either a hard `needs:` blocker on every publish job
  (npm package publish via the retired/folded `release-core.yml`/
  `release-cli.yml`, and the CLI binary release via `scripts/release.ts` +
  `.github/workflows/release.yml`, which today pushes the tag and lets
  `release.yml` publish before any security/accessibility check runs) is
  009's to build, since 009 owns consolidating release authority and
  already commits to gating the first public `npm publish` on a T4.7
  security review. Recorded as a cross-plan dependency (see
  crossPlanImpacts), not implemented here.
- **End-to-end benchmark tier omits the browser/Chromium leg on purpose**:
  measuring browser heap and module-Worker transfer cost for the 500-page
  fixture would need Playwright wiring beyond what this folder's Bun-side
  benchmark scripts use elsewhere. Left as an explicit non-goal of the
  initial end-to-end tier rather than silently dropped; revisit if the
  500-page browser-host promise needs its own measured envelope.
