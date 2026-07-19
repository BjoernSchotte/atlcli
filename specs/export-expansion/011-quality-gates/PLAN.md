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
  20 MB, `unzipDocx` validates zip + `word/document.xml` but not entry names).
- Font pinning: `packages/pdf/scripts/ensure-fonts.ts` (sha256-pinned
  download cache — the pattern to reuse for user font imports).
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
  filesystem, smuggle active SVG content, or exhaust memory; every release is
  preceded by a security review.
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
  bytes) which compare by presence, format, and pixel dimensions.

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
- [ ] One harness case per folder, registered in
      `apps/browser-export-harness/src/app.ts` / `src/main.ts` with its own
      `data-testid` result element, asserted in
      `apps/browser-export-harness/tests/exports.e2e.ts`. Concrete case list:
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
      the JSON `*-result` elements.
- [ ] **Shape-parity gate**: `apps/browser-export-harness/scripts/check-parity.ts`
      (Bun) — runs the same `packages/export-fixtures` fixtures through the
      node/Bun entry points (`@atlcli/docx` node adapters, T3.1 compile
      port), computes the same digests, and compares against a digest
      manifest the Playwright run writes to
      `apps/browser-export-harness/test-results/digests.json`. Failure output
      names the case and the first divergent part. Rasterizer-divergent media
      parts compare by format + dimensions (documented allowlist in the
      script).
- [ ] Wire into CI: add `bun run check:parity` (root `package.json` script)
      to the `browser-export-harness` job in `.github/workflows/ci.yml`
      after the Playwright step. Keep `scripts/check-output.ts` scanning the
      grown bundle (no remote/dynamic code, no native leaks).
- [ ] Tests for the infrastructure itself: unit tests for the digest
      comparison and allowlist logic in
      `apps/browser-export-harness/scripts/check-parity.test.ts` (pure
      functions over real zip bytes from `@atlcli/docx/fixtures` — no mocks).

### Benchmarks

- [ ] Fixture generation strategy: `scripts/bench/generate-fixture.ts` —
      seeded deterministic generator producing a 500-page tree as
      `ExportBlock[]` chapters (per page: ~3 headings, prose paragraphs,
      one list; every 10th page a 200-row table; every 25th page a code
      block and a small deterministic in-memory PNG asset). Emits JSON to
      `scripts/bench/out/fixture-500.json` (gitignored); a 50-page variant
      doubles as the M1 acceptance corpus. No network, no tenant.
- [ ] Runner: `scripts/bench/run-bench.ts` — phases measured separately with
      wall-clock ms: blocks→compose (002), DOCX serialize+zip, PDF
      serialize+compile (real Typst WASM via the T3.1 Bun port). Memory
      budget measurement: in-process peak-RSS sampling
      (`process.memoryUsage.rss()` on an interval, max recorded per phase)
      plus whole-process max RSS from the CI wrapper (`/usr/bin/time -v`)
      as the source of truth. Output: one JSON record
      (`{commit, date, phase, ms, peakRssBytes, outputBytes, pages}`).
- [ ] CI thresholds as **non-blocking trend first**: new
      `.github/workflows/bench.yml`, nightly `schedule` + manual dispatch,
      `continue-on-error: true`; uploads the JSON as an artifact, restores
      the previous record via `actions/cache`, and emits `::warning::` when
      time regresses >20% or peak RSS >15% vs the rolling median. After ~2
      weeks of trend data, freeze absolute budgets in
      `scripts/bench/budgets.json` (placeholders to confirm: 500-page DOCX
      < 60 s / < 1.5 GB RSS; 500-page PDF compile < 180 s / < 2 GB RSS) and
      flip the workflow to failing. Never a per-PR gate.
- [ ] Regression tests for the generator (determinism: same seed → identical
      JSON; page/block counts exact) in `scripts/bench/generate-fixture.test.ts`.
- [ ] Document the envelope in `src/content/docs/reference/` once measured;
      this is the precondition for any chapter-streaming work (parked, T4.9).

### PDF/UA

- [ ] veraPDF in CI over exported fixtures: new
      `.github/workflows/verapdf.yml` (nightly + `workflow_dispatch` +
      release tags). Steps: build, compile the conformance corpus (the
      harness fixture set + the 50-page bench fixture) to real PDFs with a
      Bun script `scripts/verapdf/compile-corpus.ts` (T3.1 port, pinned
      fonts via `fonts:ensure`), then run the official veraPDF CLI
      (pinned version, e.g. the `verapdf/cli` container or pinned zip
      download) with `--flavour ua1 --format json`.
- [ ] Ratchet, not aspiration: store the currently-failing rule IDs in
      `scripts/verapdf/baseline.json`; the job fails only on rule failures
      not in the baseline, and warns when a baselined rule starts passing
      (so the baseline shrinks monotonically). Baseline changes are
      reviewed diffs.
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

### Security hardening

- [ ] Zip path traversal: entry-name validation shared by every zip reader —
      reject entry names containing `..` segments, absolute paths,
      backslashes, or drive prefixes. Apply in
      `packages/docx/src/scan.ts` (`unzipDocx`), the `.atlcli-template`
      container reader (`packages/core/src/template-library.ts`, T2.4), and
      any future font-bundle reader. Regression tests with hand-built
      malicious zips (real PizZip archives) in `packages/docx/src/scan.test.ts`
      and the template-library test file.
- [ ] sha256 pinning: keep the pinned-download pattern of
      `packages/pdf/scripts/ensure-fonts.ts` as the only way fonts enter the
      build; for user font imports (B5), record sha256 at import time in the
      template/font manifest and re-verify on every load; verify TTF/OTF/WOFF2
      magic bytes before acceptance.
- [ ] Size caps everywhere an untrusted file enters: template `.docx` already
      capped at 20 MB (`MAX_TEMPLATE_BYTES` in `packages/docx/src/scan.ts`);
      add caps for `.atlcli-template` containers (proposal: 30 MB container,
      64 MB uncompressed sum — zip-bomb guard via declared-size accounting
      during extraction) and user fonts (10 MB per file). Constants exported
      next to the readers, tested at the boundary values.
- [ ] SVG sanitizing shared between pipelines: extract the SVG branch of
      `validateResolvedAsset` from `packages/pdf/src/prepare.ts` into a pure
      browser-safe module `packages/core/src/sanitize-svg.ts` (reject
      `script`/`foreignObject`, `on*=` handlers, external/data `href`);
      consume it from `packages/pdf/src/prepare.ts` **and** the DOCX SVG
      embedding path (`packages/docx/src/image.ts`, G4/T1.15), which today
      has no sanitizer. Port the existing cases from
      `packages/pdf/src/prepare.test.ts` and add DOCX-side regression tests.
- [ ] Stationery/template Typst inputs (B6/B8): document and enforce that
      template-provided SVG backgrounds go through the same sanitizer before
      being handed to the compiler.
- [ ] `/security-review` before releases: add a "Security review completed
      for this release" line to the release runbook section in
      `src/content/docs/contributing.md`, and make
      `scripts/release.ts --dry-run` print a reminder checklist item; the
      review covers exactly the import surfaces above plus new network
      code since the last tag.

### E2E resource discipline

- [ ] Naming convention: every live test resource is named
      `atlcli-e2e-<feature>-<timestamp>` (epoch seconds; e.g.
      `atlcli-e2e-scope-tree-1789000000`) — Confluence pages in space
      `DOCSY`, Jira issues in project `ATLCLI` (summary prefix). Helper
      `makeE2eTitle(feature)` in a new shared test helper
      `apps/cli/src/e2e/resources.ts` used by all live E2E scripts
      (including `scripts/e2e-template-test.sh` successors).
- [ ] Cleanup helper task in the CLI test suite:
      `apps/cli/src/e2e/cleanup.ts` — using `ConfluenceClient`/`JiraClient`
      with profile `mayflower`, list `DOCSY` pages whose title starts with
      `atlcli-e2e-` (CQL) and `ATLCLI` issues with the summary prefix, and
      delete those older than 24 h (parsed from the timestamp suffix, so a
      running E2E is never deleted). Dry-run by default; `--force` deletes.
      Unit-test the pure parts (title parsing, age filter) in
      `apps/cli/src/e2e/cleanup.test.ts`; the deletion path is exercised
      only against the live tenant.
- [ ] CI wiring, nightly only: `.github/workflows/e2e-nightly.yml`
      (`schedule` + `workflow_dispatch`, main branch only) runs the new
      scope/macro E2E cases (T4.8 scope) and then `cleanup.ts --force`.
      Rate/cost considerations, documented in the workflow header: live
      Cloud REST calls count against the tenant's rate limits and pollute
      space history, credentials are repo secrets that must not be exposed
      to fork PRs — therefore **never** per-PR, never on forks; the sweeper
      also runs even when the E2E step fails (`if: always()`).
- [ ] Documentation: add an "E2E resources" section to
      `src/content/docs/contributing.md` (naming convention, 24 h TTL,
      sweeper usage `bun apps/cli/src/e2e/cleanup.ts`, nightly workflow);
      cross-reference the CLAUDE.md workflow rules so local agent runs
      follow the same convention.

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

- Every folder 001–008 has exactly one green harness case in
  `apps/browser-export-harness/` asserting its capability through the real
  browser pipeline (module Worker, Typst WASM, real fonts), and
  `check-parity.ts` proves digest-level equivalence between harness and
  CLI outputs for the same fixtures in `ci.yml`.
- `bench.yml` produces nightly trend records for the 500-page fixture with
  per-phase time and peak RSS; budgets are frozen in
  `scripts/bench/budgets.json` after the trend window and the workflow
  enforces them (still not a per-PR gate).
- `verapdf.yml` runs pinned veraPDF (`--flavour ua1`) over really compiled
  corpus PDFs; a checked-in shrinking baseline gates new failures; the
  docs page `src/content/docs/reference/pdf-accessibility.md` states the
  honest conformance status and matches the current baseline.
- Zip readers reject traversal entries; SVG sanitizing is one shared module
  used by both PDF and DOCX paths; imported fonts/templates are sha256-pinned
  and size-capped, with boundary regression tests; the release runbook and
  `release.ts --dry-run` reference the `/security-review` gate.
- Live E2E resources follow `atlcli-e2e-<feature>-<timestamp>`; the sweeper
  runs nightly with `if: always()` and leaves DOCSY/ATLCLI clean; the
  convention is documented in `src/content/docs/contributing.md`.
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
