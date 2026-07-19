# 011 — Quality gates: conformance, benchmarks, PDF/UA, security

Status: Plan, 2026-07-19. Covers Phase 4 tasks T4.3, T4.4, T4.6, T4.7, T4.8 and
the parked backlog T4.9 from `specs/export-expansion/UMSETZUNGSPLAN.md`. This
folder is cross-cutting: it does not add product features, it builds the
quality infrastructure that every other folder (001–008) lands into.

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
  caps for `.atlcli-template` — its own exported `MAX_TEMPLATE_PACK_BYTES`
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
| 007 (PDF templates, Lane P, T2.1–T2.4) | `settings` threading, watermark, `.atlcli-template` | PDF-settings case; container format is a T4.7 hardening target |
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
`packages/core/src/sanitize-svg.ts` or a second `.atlcli-template` cap. Where
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
both engines, 007 owns `.atlcli-template`/font archive validation. 011 does
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

- [ ] Create `packages/export-fixtures/` (private, browser-safe, no IO):
      move/extend `apps/browser-export-harness/src/fixture.ts` content into
      `packages/export-fixtures/src/index.ts`; keep a re-export shim in the
      harness so `docx-case.ts`/`pdf-case.ts` keep working.
- [ ] **T4.6 sync point (land before the first feature-lane case, i.e.
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
- [ ] One harness case per folder, registered in the `ConformanceCase`
      registry above, with its own `data-testid` result element, asserted
      via the generic Playwright loop in
      `apps/browser-export-harness/tests/exports.e2e.ts`. Concrete case list
      (**seven browser cases, 001–007**; case 008 is the CLI/Bun parity
      runner below and is deliberately not a browser case — see Definition
      of Done, which is corrected accordingly):
  - [ ] **Case 001 `blocks`** (`src/blocks-case.ts`): fixture using every new
        `ExportBlock` field (`caption`, `pageBreak`, `orientation`, `anchor`,
        enriched `unknown`) through both engines; asserts no unexpected note
        codes and warm-repeat determinism for the PDF side.
  - [ ] **Case 002 `scope`** (`src/scope-case.ts`): three-page fixture tree
        through `composeChapters` → both engines; asserts heading-level
        offsets, chapter page breaks, namespaced anchors resolve (no dangling
        link diagnostics), and PDF `pageCount`/outline growth via
        `validatePdfOutput`.
  - [ ] **Case 003 `content-compat`** (`src/content-case.ts`): storage
        fixture with `scroll-pagebreak`, `scroll-landscape`/`-portrait`,
        `scroll-title`→caption, scroll-only/-ignore (exporter-sensitive);
        asserts DOCX section/`w:br` output parts and PDF page count +
        orientation effect; includes the 200-row repeating-header table.
  - [ ] **Case 004 `macros`** (`src/macro-case.ts`): real
        `MacroRendererRegistry` + resolver pass with deterministic in-memory
        fetch ports (recorded Jira search payload, diagram preview PNG bytes,
        export_view HTML); asserts the full fallback chain ends in
        placeholder+report note for an unknown macro and that the Jira table
        renders as a real table block.
  - [ ] **Case 005 `placeholders`** (`src/placeholder-case.ts`): template
        built with `buildDocx` containing includepage + metadata
        placeholders; real resolver + document pass with an in-memory
        `getIncludedPage` port; asserts cycle protection note and resolved
        part text.
  - [ ] **Case 006 `docx-quality`** (`src/docx-quality-case.ts`): asserts
        `word/numbering.xml` exists with multilevel defs, `w:tblGrid` widths
        from `columnWidths`, an SVG attachment lands as svgBlip + PNG
        fallback media parts, and the StyleRef header field survives export.
  - [ ] **Case 007 `pdf-settings`** (`src/pdf-settings-case.ts`): compiles
        the same blocks twice with different `settings` (A4/portrait vs
        Letter/landscape, watermark on, cover/outline toggled); asserts the
        two outputs differ, each is deterministic, watermark text present,
        and a `.atlcli-template` container round-trips through the template
        library.
  - [ ] **Case 008** is not a browser case: it is the parity runner below.
- [ ] Extend each case result with output digests: sha256 for PDF bytes,
      per-part sha256 map for DOCX (via `unzipDocx` in-page); surface them in
      the JSON `*-result` elements. Also surface a canonical projection of
      the case's `ExportNote`s (code, severity, count, failure phase —
      excludes timing and host-specific free text) alongside the digests,
      so the parity gate below can compare reports, not only bytes.
- [ ] **Shape-parity gate**: `apps/browser-export-harness/scripts/check-parity.ts`
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
- [ ] Wire into CI: add `bun run check:parity` (root `package.json` script)
      to the `browser-export-harness` job in `.github/workflows/ci.yml`
      after the Playwright step. Keep `scripts/check-output.ts` scanning the
      grown bundle (no remote/dynamic code, no native leaks).
- [ ] Tests for the infrastructure itself: unit tests for the digest
      comparison, report-projection comparison, and raster-content-metric
      logic in `apps/browser-export-harness/scripts/check-parity.test.ts`
      (pure functions over real zip/PNG bytes from `@atlcli/docx/fixtures`
      — no mocks); include a deliberately blank and a deliberately
      mis-cropped same-size PNG fixture pair and assert the raster check
      rejects both.

### Benchmarks

- [ ] Fixture generation strategy: `scripts/bench/generate-fixture.ts` —
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
- [ ] **M1 acceptance corpus** (new task, precedes the M1 milestone check):
      `scripts/bench/generate-m1-corpus.ts` — a versioned 50-page
      `ExportPageNode[]` tree (not raw blocks) assembled from the same
      fixture building blocks as harness cases 002/003/004/005 (labels on a
      subset of pages, `scroll-pagebreak`/`scroll-landscape`/`scroll-title`
      macros, a draw.io preview-PNG macro, a live-Jira-table macro, an
      includepage placeholder), committed to
      `packages/export-fixtures/src/m1-corpus.ts` so it is not tenant- or
      network-dependent. A new script
      `scripts/bench/run-m1-acceptance.ts` runs this corpus through
      `fetchExportTree`-shaped input → `composeChapters` → both engines, via
      **both** the browser harness (Playwright) and the CLI-side production
      path (T3.1), producing DOCX and PDF for each, and emits a
      machine-readable `m1-acceptance.json` record (`{corpusDigest, docx:
      {harness, cli}, pdf: {harness, cli}, digestsMatch, notes}`) as a CI
      artifact. The M1 milestone in UMSETZUNGSPLAN is only marked done once
      this record is green — a formally green M1 that never ran the
      integrated product story once is the failure mode this closes.
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
- [ ] Regression tests for the generator (determinism: same seed → identical
      JSON; page/block counts exact) in `scripts/bench/generate-fixture.test.ts`
      and `scripts/bench/generate-m1-corpus.test.ts`.
- [ ] Document the envelope in `src/content/docs/reference/` once measured —
      engine tier and end-to-end tier reported separately, each tier's scope
      stated explicitly (what it does and does not exercise); this is the
      precondition for any chapter-streaming work (parked, T4.9).

### PDF/UA

- [ ] veraPDF in CI over exported fixtures: new
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
- [ ] Ratchet, not aspiration, and precise enough to catch a growing
      regression: store failing verdicts in `scripts/verapdf/baseline.json`
      keyed by `{fixture, ruleId, failureCount, locationsDigest}`, not by
      rule ID alone — a rule ID staying in the baseline while its failure
      count rises on the same fixture (a regression that adds instances
      without adding a new rule) must fail the job, not pass silently. The
      job fails on any rule failure not in the baseline **or** any
      baselined key whose count increases; warns when a baselined key
      starts passing (so the baseline shrinks monotonically). Baseline
      changes are reviewed diffs.
- [ ] Alt-text audit task: emit a dedicated note code (e.g.
      `pdf-image-missing-alt`) from `packages/pdf/src/prepare.ts` when an
      image block has no `alt`; surface it in `PdfExportReport` and the CLI
      `--report json` (T3.4) so authors can fix source pages. Same audit in
      the DOCX path (`packages/docx/src/image.ts`).
- [ ] Language audit task: thread `PdfExportMetadata.language` into the Typst
      template (`packages/pdf/src/template.ts`, `set text(lang: ..)`) and
      verify a `/Lang` entry in the catalog; extend
      `packages/pdf/src/validate.ts` with a `hasLang` field and extend
      `packages/pdf/src/validate.test.ts` accordingly. Warn on export when
      metadata has no language.
- [ ] Honest conformance statement in docs: new page
      `src/content/docs/reference/pdf-accessibility.md` stating exactly:
      output is **Tagged PDF** with document language, outline, embedded
      fonts, and alt-text pass-through; it is **not certified PDF/UA-1**;
      list the open veraPDF rule gaps from `baseline.json` and link the
      audit note codes. No marketing language; update the page in the same
      PR whenever the baseline changes.
- [ ] HEAD-bound security attestation artifact: `scripts/security/
      attest.ts` emits `security-attestation.json` (`{commit, date,
      veraPdfDigestOk, veraPdfBaselineDelta, securityReviewNote, m1
      AcceptanceOk}`, unchanged shape) as a CI artifact on every push to
      `main` and on release tags — a machine-checkable summary a future
      release-gate job can `needs:` on. **Decided (was an open point in an
      earlier draft): 009-package-publishing owns the canonical release
      sign-off schema; this artifact is that schema's embedded `security`
      sub-object, not a second parallel file.** 009's "machine-checked
      release sign-off artifact" task (`009-package-publishing/PLAN.md`,
      Versioning & release) defines a superset schema (reviewed tarball
      SHA-512/SRI digests, a named reviewer, structured T4.7 scope/result)
      that embeds exactly this artifact's fields under a `security` key;
      this task's output file name/path follows whatever 009's schema
      specifies for that embedding, still produced on the same cadence
      (every `main` push and release tag) described above. **Wiring this
      artifact as a hard `needs:` gate on every publish job is 009's
      responsibility** (it owns the consolidated release pipeline and
      already commits to refusing the first public `npm publish` without a
      T4.7 security review); recorded as a cross-plan dependency, not built
      here (see Risks and crossPlanImpacts).

### Security hardening

**This section is a cross-plan gate on 006/007's shared modules for the
surfaces they own (SVG sanitizing, `.atlcli-template`/font archive
validation — see Dependencies and Architecture), plus direct ownership of
the surfaces no feature lane claims (raw `.docx` upload archive budget,
Confluence storage parse budget, link-scheme policy, compiler execution
budget).**

- [ ] **Cross-plan SVG policy conformance gate** (does not implement the
      sanitizer — 006 does): `packages/export-fixtures/src/svg-corpus.ts`,
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
- [ ] **Cross-plan archive policy conformance gate** (does not implement
      the validator — 007 does): `packages/export-fixtures/src/
      archive-corpus.ts`, hand-built malicious `.atlcli-template` zips
      (path traversal, symlink entries, declared-vs-actual size mismatch
      "zip bomb", entry-count flood) exercised through
      `packages/template-pack/src/unpack.ts` in a new
      `packages/export-fixtures/src/archive-corpus.test.ts`; fails on any
      case that unpacks successfully or exceeds the documented resource
      budget.
- [ ] Raw `.docx` template upload archive budget (unclaimed by any feature
      lane — `unzipDocx` in `packages/docx/src/scan.ts` today validates
      only the **compressed** input size against `MAX_TEMPLATE_BYTES`,
      never decompressed size, entry count, or entry names): add a shared
      `ArchiveBudget` (`maxEntryCount`, `maxUncompressedBytes`,
      `maxSingleEntryUncompressedBytes`) enforced during `unzipDocx` via
      declared-size accounting per entry **before** full decompression, and
      the same entry-name rejection rule 007 applies to `.atlcli-template`
      (`..` segments, absolute paths, backslashes, drive prefixes) applied
      here too — a different code path, so not covered by 007's fix.
      Regression tests with hand-built PizZip archives (declared/actual
      size mismatch, path traversal, 100k-entry archive) in
      `packages/docx/src/scan.test.ts`.
- [ ] Active-content policy for imported `.docx` templates: reject-on-import
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
- [ ] Confluence storage parse budget (**cross-plan coordination note**:
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
- [ ] Link-target scheme policy (**same cross-plan coordination note** —
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
- [ ] Compiler execution budget: `BrowserPdfCompiler.compile()`
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
- [ ] `/security-review` before releases: add a "Security review completed
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
- 011 does not own a second SVG sanitizer or a second `.atlcli-template`
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
