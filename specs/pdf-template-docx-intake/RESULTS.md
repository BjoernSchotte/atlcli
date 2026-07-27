# PDF template DOCX intake proof record

This file records reproducible evidence for the implementation tasks in
`PLAN.md`. A task is complete only when every acceptance criterion has direct
evidence here or in a referenced committed artifact. Passing test counts alone
do not establish a product capability.

## Evidence conventions

- **Structural** means a committed schema, fixture, or deterministic byte-level
  assertion proves the stated contract.
- **Automated** means the named command completed successfully.
- **Browser** means the browser export harness executed in Chromium rather than
  only compiling.
- **Visual** means every rendered page image was opened and inspected.
- **Parity** means a committed conformance case produced its expected digest in
  both compared hosts.
- **Supplemental** evidence can expose unsupported real-world structure but
  cannot replace the neutral committed fixture suite.

## T0 — Contracts, characterization, fixtures, and proof scaffolding

**Status:** Proven on 2026-07-27.

### Environment and characterization boundary

| Item | Recorded value |
|---|---|
| Characterization commit before resolver changes | `704e71db8b64f59b287eeced693651d8e7f3f5c7` |
| Bun | `1.3.14` |
| typst.ts | `0.7.0` |
| Typst compiler | `0.14.2` |
| Word fixture producer | Microsoft Word for Mac `16.111.1` |
| LibreOffice fixture producer | LibreOffice `7.1.1.2` |

The characterization commit contains only the reviewed plan decision update.
No resolver or PDF-template runtime behavior had been changed when the
baseline commands and digests below were recorded.

### Commands and results

| Proof | Exact command | Result |
|---|---|---|
| Locked dependency install | `bun install --frozen-lockfile` | Passed; 1,562 packages installed and the vendored Typst runtime resolved |
| Reproducible PDF fonts | `bun run fonts:ensure` | Passed; 12 pinned files verified |
| Existing PDF unit characterization | `bun run test packages/pdf/src/template.test.ts packages/pdf/src/settings.test.ts packages/pdf-compiler-browser/src/compiler.test.ts` | Passed; 65 tests, 280 assertions, 0 failures |
| Browser harness build | `bun run build:browser-export-harness` | Passed |
| Conformance inventory | `bun run assert:conformance-cases` | Passed; 18 declared cases |
| Real browser harness | `bun run test:browser-export-harness` | Passed; 4 Playwright tests in Chromium |
| Node/browser PDF parity | `bun run check:parity` | Passed for `pdf-settings`, `blocks`, `scope`, `content-compat`, `macros`, and `manuscript` |
| T0 fixture and UX contracts | `bun run test packages/docx-template-intake/src/fixtures/fixtures.test.ts` | Passed; 10 tests, 1,512 assertions, 0 failures |
| Fixture privacy with a local deny-list marker | `ATLCLI_FIXTURE_PROHIBITED_TERMS=<private-marker> bun run test packages/docx-template-intake/src/fixtures/fixtures.test.ts` | Passed; 10 tests, 1,598 assertions, 0 failures; marker value not persisted |
| Repository type safety | `bun run typecheck` | Passed for the root, extension, browser compiler, and browser export harness |
| DOCX generation reproducibility | Run `create-neutral-source.py` twice with the documented runtime and compare SHA-256 | Passed; both outputs were `246e3c3e0a1d8db6ab6049dc750c64620fbc40dab7e740da6b92d3d303cdb8fa` |
| Fixture render | Run the document runtime's `render_docx.py` with `--emit_pdf` for each of the three fixtures | Passed; two pages rendered for every producer |
| Diff hygiene | `git diff --check` | Passed |

The final milestone rerun is the authoritative result for these commands. An
environment warning that the shared Turbo cache could not perform an optional
I/O operation did not fail a task and did not change any result.

### Baseline PDF digests

| Case | SHA-256 |
|---|---|
| `pdf-settings` variant A | `11105a2c8a0c234ed51c008246a971fbbef1cde451d4959844703f4e717fd0c7` |
| `pdf-settings` variant B | `0d1635cb30fcb8d74f7ff5a4facdb04ae76596db699a190af79efad6896cc25b` |
| `blocks` | `ef5c0506388bbea393aa85b2321709785d0507b12677b2a3c7257a3368179e23` |
| `scope` | `38f04ccea254209784d5abb94ac013765621f35678410911710593e5c8dc8375` |
| `content-compat` | `b4ce63e973e782bf4fd79d1b5442170fe90f6184d7483402db00784debba7541` |
| `macros` | `2acfbe84808ef083c7a36cf44c1214beed199206cd63203cfd747b5eb365f55f` |
| `manuscript` | `66f4bb7675343e6e6acdfb82552824dbe7adac02a62a07859e479bd120a166f4` |
| `manuscript-builtin` (Editorial Indigo projection) | `4f27b57e13080e39ba99d8c429cf534407a006303e3360ca7a8085578c35195a` |

The digests prove preservation of the named characterized outputs. They do not
prove visual equivalence to arbitrary Word documents.

### Committed fixtures and artifacts

| Artifact | SHA-256 or role |
|---|---|
| `packages/docx-template-intake/src/fixtures/neutral-generated-python-docx-1.2.0.docx` | `246e3c3e0a1d8db6ab6049dc750c64620fbc40dab7e740da6b92d3d303cdb8fa` |
| `packages/docx-template-intake/src/fixtures/neutral-word-16.111.1.docx` | `938e7a9d105a41ffa14baedf37f21f4388cc1b2131be7e16ad73f5b5a4a8cf4a` |
| `packages/docx-template-intake/src/fixtures/neutral-libreoffice-7.1.1.2.docx` | `688e49f1cb7d0acb31a3c5c4398fbcba14675c6785a0d1e9a75114fabdcdd466` |
| `packages/docx-template-intake/src/fixtures/goldens/*.analysis.json` | Text-free, canonical structural analyses |
| `packages/docx-template-intake/src/fixtures/goldens/analysis-result.schema.json` | Fixture-analysis JSON schema |
| `packages/docx-template-intake/src/fixtures/goldens/resource-caps.v1.json` | Parser choice, measurements, selected caps, and boundary plans |
| `packages/docx-template-intake/src/fixtures/ux/` | Versioned journey, API names, transcripts, and usability script |
| `apps/browser-export-harness/test-results/digests.json` | Generated and ignored parity evidence |
| `.tmp/pdf-template-docx-intake/t0-render/{generated,word,libreoffice}/` | Generated and ignored PDF/page-image render evidence |

The Word-produced fixture was privacy-scrubbed after its producer save.
Automated privacy checks scan extracted OOXML, metadata, committed text
artifacts, URLs, and optional local deny-list terms. Only the synthetic markers
listed in the fixture README are permitted. A private supplemental DOCX also
completed a local structural parse; no name, path, digest, metadata, or content
from it is persisted in the repository.

### Fixture measurements and selected hard caps

The selected parser is `saxes@6.0.0` in namespace-aware streaming mode. Intake
fails closed on a doctype, entity, parser warning, or malformed XML. The
existing aggregate ZIP budgets remain unchanged at 2,048 entries, 128 MiB
total uncompressed bytes, and 64 MiB for one uncompressed entry.

| Resource | Largest neutral fixture | Selected limit |
|---|---:|---:|
| XML part bytes | 438,131 | 2,097,152 |
| XML part characters | 438,131 | 2,097,152 |
| XML elements per part | 9,200 | 40,000 |
| XML depth | 13 | 64 |
| XML attributes per part | 14,031 | 60,000 |
| XML attribute characters | 92 | 512 |
| Raster pixels | 460,800 | 16,777,216 |
| Raster dimension | 1,280 | 8,192 |
| SVG bytes | 232 | 1,048,576 |
| SVG elements | 4 | 10,000 |
| SVG depth | 2 | 128 |
| SVG attributes | 11 | 50,000 |
| SVG path-data bytes | 38 | 524,288 |
| SVG filters | 0 | 64 |

Every non-zero measured maximum has at least four times headroom. For every
listed resource, the committed cap contract defines three future boundary
fixtures at `limit - 1`, `limit`, and `limit + 1`. T0 proves the measurements
and freezes those plans; T3/T5 must prove enforcement before consuming
untrusted documents or visual assets.

### Visual inspection

All six page images were inspected at original resolution. Each producer
render preserves the two-section portrait/landscape structure, page border,
header, heading hierarchy, body/direct formatting, table, visual, and caption.
No clipping, overlap, missing glyph, or unintended overflow was observed.
Expected producer normalization changes table width slightly; LibreOffice also
omits the SVG extension while retaining the raster fallback.

### UX contract evidence

- The state fixture defines exactly seven stages and only stage-valid next
  actions.
- Ten normative transcripts cover first import, resume, ready and uncertain
  review, asset review, changed-source recovery, build blocking, preview,
  build, and undo.
- Primary-path text never exposes candidate IDs, capability paths, JSON
  editing, a built-in baseline identifier, OOXML, or Typst.
- Failure transcripts state that the active draft is retained.
- Every transcript message code is registered with bounded parameters. Removing
  its default copy still emits the stable code plus safe diagnostic parameters.
- The synthetic usability script requires a rendered design review in no more
  than four primary commands and correct explanations of applied, retained,
  open, and unsupported choices.

This evidence proves the frozen contract and proof scaffolding. It does not
claim that the intake engine, renderer extensions, CLI journey, or pack loader
from T1–T10 already exist.
