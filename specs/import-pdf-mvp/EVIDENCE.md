# PDF import MVP evidence ledger

## PDF-00 - feasibility, drift, and engine selection

**Recorded:** 2026-08-18
**Task starting HEAD:** `58f7cc3c075f2d342e2e91f7f07aa2e5f828349f`
**Environment:** macOS 26.4 arm64; Bun 1.3.14; Node 20.20.2, 22.18.0,
24.19.0; Poppler 26.03.0; Tesseract 5.5.2.

This ledger contains only synthetic fixtures and normalized technical facts. It
contains no customer PDF, customer text/image, tenant page ID, tenant URL,
parent ID, or raw live receipt.

### Decision

Use exact `@embedpdf/pdfium@2.15.0` behind an AtlCLI-owned, byte-oriented
`PdfFactsAdapter` for the importer. Load only verified local WASM bytes and keep
PDF.js viewer-only. PDFium supplies low-level text/geometry, structure,
annotation, page-object, image, outline, and bounded-render facts; AtlCLI must
still infer semantics conservatively. PDFium has no native table extraction API
and a PDF image object is not automatically a semantic figure.

PDF Oxide 0.3.77 is deferred: it was not needed to establish the selected
vertical slice and has not cleared the same public-API, WASM, host, lifecycle,
quality, packaging, and provenance matrix. There is no cross-engine fallback.

OCR is a NO-GO for the digital MVP. A research-only 200 dpi run with Tesseract
5.5.2 recovered the three visible lines from the neutral scan but collapsed a
word boundary (`OCRis...`), took 0.20 s, and peaked at 85,983,232 bytes RSS. A
native external runtime without frozen packaged language/model assets, browser
proof, and measured accuracy is not an acceptable hidden dependency.

### Frozen revisions

| Contract | Revision | PDF-00 disposition |
|---|---|---|
| facts adapter | `atlcli.pdfium-public-fpdf/1` | exact local WASM, public `FPDF_*` only, no `EPDF_*` |
| analysis policy | `atlcli.pdf-analysis-policy/1` | tagged-first, conservative digital untagged, scan/mixed/encrypted fail closed |
| hard budgets | `atlcli.pdf-analysis-budgets/1` | Section 12.2 ceilings retained for implementation; the probe validates 100 pages, render caps, cancellation, and RSS, not yet every production counter |
| fixture truth | `atlcli.import-pdf.fixture-truth/v1` | canonical manifest in `fixtures/truth.json` |

The initial ceilings remain 100 MiB input, 500 pages, 120 s total, 10 s per
page, two concurrent pages, 200 MP rendered pixels, and 750 MiB peak RSS for the
100-page digital benchmark. Production enforcement belongs to PDF-02/PDF-04;
PDF-00 does not claim those guards exist in AtlCLI yet.

### Neutral corpus

The generator uses exact probe-only pins `Pillow==12.3.0`, `pypdf==6.10.0`, and
`reportlab==4.4.9`. Every committed PDF is synthetic and Apache-2.0 licensed.
The encrypted fixture uses randomized encryption salt; its committed binary and
truth digest are authoritative and change together only on an intentional
regeneration.

| Fixture | Pages/class | SHA-256 |
|---|---|---|
| `simple-untagged.pdf` | 1 / digital untagged | `9a31a7f21dadb234e121e75f31212c8e24b2ea35665ee0d2dcfeff5904c6faf5` |
| `complex-untagged.pdf` | 1 / two-column digital | `288e17630dc2f7e1d38c481cd729e3a8cf17c9a793d882e36a42fb096937e58e` |
| `complex-tagged.pdf` | 1 / tagged | `59786ff65e6151820787290b43acd5ffa7123d94e17243341cbecc0f7da1322b` |
| `scan.pdf` | 1 / image-only | `1908adf6153db8872cfb17a5b7cd85965a4b240098864d392b6b654a093178c6` |
| `mixed.pdf` | 2 / digital plus image-only | `8a871788fc265b6942a72cc5af0f7af4dfed9bc3d6c84fcc7fb6bcc8f608bc80` |
| `table-positive.pdf` | 1 / grid evidence | `5120eeab5e10be4f83d67310f03b10c15ca840e393e0d4eb417ecf67e4b6fbd2` |
| `table-negative.pdf` | 1 / must not become native | `4067a1dc4ebf9366e1dbac93795fbaac13ed4f256d0c272d448653c0d3d986e3` |
| `figure.pdf` | 1 / raster plus vector | `cbc777c4c7d9285d64f8a2f0e2cc5388b52b4469f90313712712329571bae890` |
| `adversarial-actions.pdf` | 1 / JS plus embedded file | `71ccaa23ee2329cd75798ea698f0f89c71af5584831ae00100f292510f650082` |
| `encrypted.pdf` | rejected V1 | `8c8f1fb3b5f69c1f0a8800bfe17f582ac2e2c80b69596231a07618767965a43d` |
| `heading-rich-100.pdf` | 100 / heading-rich | `57c78033e00440312ca9298df246be8beb53737a0bd890991cb8a48005fb6bc7` |
| `heading-poor-100.pdf` | 100 / heading-poor | `a13d436289dc245131ac9351c171f5141c1477284144e942318e250c39f39954` |

The heading-rich truth has roots at pages 1, 26, 51, and 76; child ranges are
1-25, 26-50, 51-75, and 76-100; the atomic region is pages 39-41. The
heading-poor fallback ranges are 1-20, 21-40, 41-60, 61-80, and 81-100. Both
truth sets require zero duplicate and zero unassigned source pages.

Representative first/middle/last, tagged, scan, mixed, table, figure, and
atomic-region pages were rendered with Poppler and visually inspected. No
rendered screenshot or private source was committed.

### Semantic and lifecycle proof

```text
bun run test specs/import-pdf-mvp/probe/src/probe.test.ts
8 pass, 0 fail, 277 assertions
```

The tests prove:

- both simple truth tokens, character boxes, one safe link, and stable digest;
- tagged roles and MCIDs, 4/4 tagged cells with exact row/column spans, one
  Figure with exact alternative text, one physical image, one outline, and one
  URI;
- scan and mixed classification without invented OCR;
- JavaScript and embedded-file counts are inventoried but never executed or
  extracted;
- encrypted input rejects with PDFium load error 4;
- every source page and `PAGE-001` through `PAGE-100` token appears exactly once
  in both 100-page controls;
- failure after module init, input allocation, document load, page load, text
  page, structure tree, annotation, bitmap, and before finalization always
  permits an identical recovery run;
- WASM memory is stable at 18,612,224 bytes initial/peak/final for the one-page
  lifecycle fixture;
- the PDF.js comparator finds the same core tagged tokens, roles, image,
  annotation, and outline.

The facts-only probe emits no native Confluence table/figure decision, so its
false-native count is zero. PDF-05/PDF-06 must prove the later semantic decision
thresholds independently.

### Dependency and provenance

| Fact | Evidence |
|---|---|
| npm package | `@embedpdf/pdfium` 2.15.0, exact pin, no runtime dependencies or install script |
| npm integrity | `sha512-KgpRND2MYcdbhzb2EMb4WzWcJYrR0A6JXvhMv4WthEHKt6qmNo2v/MC68bpYvpveYT9GNnUnY/+TG5MpXY3pRw==` |
| npm shasum | `b073cf9cee2252507c4fc81fb47a156cb2a19662` |
| signed source release | `v2.15.0`, commit `2cf7df3b594dfe46de2d85e6973ff50ea447a1ed` |
| PDFium fork input | `cb29e78f2ba00c9298714d5f4a8bf7765f1e802f` |
| WASM | 4,633,788 bytes; SHA-256 `c0af5a6aca30d7e54a149c3a68e317116ca906d6edc28fd3318b12c7d9478ac8` |
| wrapper license | MIT; SHA-256 `f5031b66adba8ef5ef57666deff980a7f2ccff5c8a8c22a8117e854d2b8dfcd3` |
| PDFium license bundle | SHA-256 `b033ffb8fc19c23ca81f7e98019ab658cc6f4cf14587c7c6a2a67fb0f6ac0f5a` |
| probe lock | SHA-256 `b8bb9b2d38f2b289add55be16a7067cc8b35edd83fdeb52c70fb3ae022d640d7` |
| unpacked dependency | 7,404 KiB |
| final proof tarball | 4.36 MB packed / 9.74 MB unpacked; SHA-256 `03c94da4e978d57725c02ae3c60446f3ad8296b21ec74cffae694c711b1cc49b` |

The tarball contains MIT and PDFium license texts but no NOTICE,
THIRD_PARTY_NOTICES, SBOM, npm attestation, or complete build provenance. The
signed source build pins Emscripten 3.1.70 and disables V8/XFA, but several
container/tool inputs float. PDF-10 must resolve notices/SBOM/update lineage and
artifact policy before release; PDF-00 establishes feasibility, not final legal
approval or reproducible-from-source status.

`bun audit --cwd specs/import-pdf-mvp/probe --json` returned `{}` for PDFium
2.15.0, PDF.js 6.2.108, and Playwright 1.55.1. The earlier 6.1.200 comparator
was removed after GHSA-hq66-cqwq-w95j was identified. The existing Extension
dependency still needs its own remediation.

`WebAssembly.Module.imports` reports only `env` and
`wasi_snapshot_preview1` (37 imports) and no network import. The upstream glue
contains its unused default CDN literal, but the AtlCLI probe always injects
verified local `wasmBinary`. The emitted browser bundle contains no `eval(`,
`new Function`, or `cdn.jsdelivr.net` string.

### Runtime and host matrix

The final packed consumer was installed from its own frozen lock. Bun and Node
20.20.2, 22.18.0, and 24.19.0 all returned the same one-page PDFium semantic
digest:

```text
72f42287f94104cf6578573d532449944a3ebae262e85a64b0b1cfa0e3817a35
```

| Host | PDFium import status after PDF-00 | Evidence |
|---|---|---|
| Bun source | feasible | full probe tests pass |
| built/packed Bun | feasible | final tarball produces the frozen digest |
| packed Node 20/22/24 | feasible | identical frozen digest on all three runtimes |
| neutral Chromium module worker | feasible | one page/token, exact WASM hash, zero remote requests, 5.2 ms termination |
| shipped Extension import | unavailable | no PDFium production dependency/worker added; existing PDF.js output and worker/viewer regressions pass |
| Forge Custom UI import | unavailable | no Forge app workspace is present, so no deployment claim is made |

The existing Extension proof passed:

```text
bun run --cwd apps/extension build
bun run check:extension-output
bun run --cwd apps/extension test:worker-extension-browser:prebuilt  # 3 passed
bun run --cwd apps/extension test:viewer-browser                     # 1 passed
```

### Performance

Five runs per fixture were executed in one Bun process. “Warm” below means
subsequent fresh module instances in that process, not retained PDFium state.
All five semantic digests were equal.

| Engine / fixture | cold ms | warm p50 ms | warm p95 ms |
|---|---:|---:|---:|
| PDFium / simple | 28.907 | 21.001 | 23.414 |
| PDF.js / simple | 91.786 | 19.935 | 19.982 |
| PDFium / tagged | 27.942 | 26.153 | 30.687 |
| PDF.js / tagged | 19.898 | 13.986 | 14.539 |
| PDFium / scan | 41.590 | 39.798 | 40.117 |
| PDF.js / scan | 99.243 | 92.436 | 93.508 |
| PDFium / 100 pages | 147.761 | 146.138 | 150.295 |
| PDF.js / 100 pages | 993.157 | 940.780 | 944.926 |

Fresh Node 22 processes on the 100-page fixture measured with
`/usr/bin/time -lp`:

| Engine | wall time | maximum RSS | peak footprint |
|---|---:|---:|---:|
| PDFium 2.15.0 | 0.31 s | 173,162,496 bytes | 97,850,576 bytes |
| PDF.js 6.2.108 | 1.17 s | 233,979,904 bytes | 159,493,712 bytes |

The 100-page fixture is 63,387 bytes, not the later 25 MiB release fixture.
Therefore this clears the 100-page functional/RSS feasibility gate but does not
close PDF-10's full-size release benchmark.

### Repository and live gates

```text
bun run test packages/import-docx apps/cli/src/commands/wiki-import.test.ts
92 pass, 0 fail

bun run typecheck
pass (non-fatal local Turbo cache IO warnings only)

bun run check:browser
34 browser entrypoints pass
```

The built CLI then previewed the neutral DOCX behavior-lock fixture and matched
the frozen counts/digest. In the authorized live Cloud test environment it
created one neutral page in `DOCSY`, read back version 1 and the expected
heading/paragraph/list body, deleted that exact page by owned ID, and a final
read returned 404. The raw receipt stayed in temporary local output and is not
committed.

### Remaining gates after PDF-00

- No production dependency, source-neutral core, CLI PDF route, or Confluence
  PDF publication exists yet.
- Extension and Forge imports are not claimed.
- Complete adversarial budget enforcement, full production corpus breadth,
  25 MiB performance, semantic table/figure decisions, publisher/readback, and
  live PDF page-tree evidence remain owned by PDF-01 through PDF-11.
- PDFium third-party notices/SBOM and the existing PDF.js viewer advisory remain
  explicit release/security follow-ups.

## PDF-01 - Source-neutral semantic core

### Result

`@atlcli/import-core` now owns the versioned, source-neutral
`atlcli.import-document/2` model and the pure canonical, ADF, Storage,
editability, and preview projections. The model carries stable node/asset IDs,
all five no-silent-loss outcomes, table spans, source-owned opaque references,
and split/fallback hints without admitting PDF geometry or DOCX parser details.

`@atlcli/import-docx` retains only Word-specific parsing, bookmarks, comments,
split behavior, recipes, governance, and baselines. Its barrel deliberately does
not re-export the moved core functions. The CLI imports both packages directly;
there is no compatibility layer or duplicate target encoder.

The new package is classified `public-0.x`, not released, so the repository's
existing API-report, closure, dependency, and tarball guards cover it. Its root
and browser entry expose the same 38-symbol experimental surface. The production
source has one browser-safe dependency on `@atlcli/core` and no Node/Bun,
filesystem, CLI, Confluence client, DOCX parser, or PDF parser edge.

### Behavior lock and focused proof

```text
bun run test packages/import-core packages/import-docx apps/cli/src/commands/wiki-import.test.ts
102 pass, 0 fail, 361 assertions

bun run test scripts/api-report.test.ts scripts/publishable-deps.test.ts
6 pass, 0 fail

bun run test apps/cli/src/commands/wiki-import-dc.contract.test.ts
3 pass, 0 fail, 22 assertions
```

The pre-extraction neutral DOCX preview remains exactly:

```text
heading=1, paragraph=2, list=1
ADF SHA-256 beecac58ae32f52ced9670c4f765136e4ebd2fce1642195cc63f518e9a571023
```

Tests also cover deterministic schema/IDs, table row/column spans, exact asset
filenames, source-reference resolution, evidence exclusion from ADF/Storage,
canonical key ordering, and the absence of source-neutral re-exports from the
DOCX barrel.

### Package and host proof

The opt-in real consumer suite built and packed the publishable dependency
closure, installed only the resulting tarballs into fresh projects, rejected
all leaked `workspace:` ranges, and exercised the core through its built output:

```text
ATLCLI_CONSUMER_SMOKE=1 bun run test scripts/consumer-smoke.test.ts
12 pass, 0 fail

tarball Bun: DOCX_SMOKE_OK; PDF_SMOKE_OK
filesystem-link Bun: DOCX_SMOKE_OK; PDF_SMOKE_OK
plain Node 22.18.0 / npm 10.9.3: DOCX_SMOKE_OK; PDF_SMOKE_OK
Vite 8.1.4 browser build: import-core projection, DOCX, and PDF smokes OK
```

The Vite fixture imports the packed browser condition and executes a real empty
ADF projection. The Node fixture imports the packed default entry and the
consumer TypeScript fixture names `ImportDocumentV2` with
`skipLibCheck: false`.

```text
bun run typecheck
pass

bun run build
32 tasks pass

bun run check:browser
35 browser entrypoints pass

bun install --frozen-lockfile
pass
```

Local Turbo cache warnings about restricted cache I/O were non-fatal; all named
commands exited zero.

### Live transaction proof

The freshly built CLI previewed the neutral DOCX and retained the frozen digest.
In the authorized `mayflower` / `DOCSY` environment it then created one neutral
version-1 page, read back the expected heading/paragraph/list Storage body,
deleted that exact import-owned page by ID, and verified that a final read
returned 404. No live ID, URL, raw receipt, credential, or tenant-derived body
was committed.

### Decision

PDF-01 is complete. PDF-specific geometry, confidence, classification, and
engine provenance remain outside the semantic core and belong to PDF-02 onward.

## PDF-02 - Safe PDFium facts and page classification

### Result

`@atlcli/import-pdf` now owns the exact-pinned PDFium boundary for CLI and
browser-worker consumers. The adapter accepts copied `Uint8Array` bytes and
caller-injected local WASM only. It exposes normalized, serializable PDF facts;
no PDFium pointer, handle, page object, URL loader, network primitive, or host
object crosses the package boundary.

The immutable production ceilings cover input bytes, page count, characters,
structure nodes, page objects, assets, decoded pixels/bytes, evidence entries,
canonical output size, and per-page/total deadlines. Callers may only tighten
them. Signature, encryption, malformed loads, budget breaches, cancellation,
concurrent adapter ownership, and provenance drift use stable error or reported
outcomes. Every accepted page index is accounted for exactly once.

PDFium facts include normalized character geometry, page dimensions/boxes,
rotation and labels, structure roles/attributes/MCIDs, outline, inert
annotation/action facts, recursive page-object/image summaries, and explicit
capability gaps. Operator lists, native tables, OCR, and active-content
execution are deliberately unavailable. Scanned, mixed, tagged,
digital-untagged, encrypted, and rejected documents receive explicit
classifications rather than an empty-success fallback.

### Focused safety and lifecycle proof

```text
bun run test packages/import-pdf
12 pass, 0 fail, 218 assertions
```

The suite proves deterministic facts/progress and normalized geometry; tagged
structure/image/outline collection; scan, mixed, encrypted and active-content
classification; hard input/page/text/image budgets; preflight and mid-run
cancellation; exact 100-page completeness; busy-adapter rejection; browser and
Node digest equality; packaged Node WASM loading; and provenance-drift
rejection. Fault injection after every acquisition stage proves reverse-order
cleanup and identical subsequent recovery. The public callsite snapshot admits
only the reviewed `FPDF_*` plus `PDFiumExt_Init` allowlist and rejects fork-only
`EPDF_*` calls.

The vendoring step verifies before copying:

```text
@embedpdf/pdfium 2.15.0
WASM bytes 4,633,788
WASM SHA-256 c0af5a6aca30d7e54a149c3a68e317116ca906d6edc28fd3318b12c7d9478ac8
WebAssembly import modules: env, wasi_snapshot_preview1
```

The dry-run package contains the built JavaScript/declarations, the verified
WASM, wrapper/PDFium licenses, and a provenance record. It contains no PDF.js
dependency and has no install script or runtime dependency beyond the exact
PDFium wrapper and existing AtlCLI packages.

### Repository, package, and browser gates

```text
bun run build
33 tasks pass

bun run typecheck
pass

bun run check:browser
36 browser entrypoints pass

bun install --frozen-lockfile
pass

bun scripts/api-report.ts
bun scripts/api-closure.ts
all publishable reports unchanged

ATLCLI_CONSUMER_SMOKE=1 bun run test scripts/consumer-smoke.test.ts
12 pass, 0 fail
```

The real consumer suite packed the publishable closure and proved the new root,
Node, browser-worker, and raw-WASM subpaths from tarballs under Bun, plain Node
22/npm, and Vite 8.1.4. The Vite production bundle emits distinct local Typst
and PDFium WASM assets, verifies the PDFium SHA-256, contains no `eval`,
`new Function`, or PDFium CDN literal, and analyzes a neutral one-page PDF to
the expected complete `digital-untagged` facts.

### Built-CLI live guard

The freshly built CLI previewed a neutral DOCX with one heading, paragraph,
and list, then created a version-1 page in the authorized `mayflower` / `DOCSY`
test environment. Readback preserved the expected Storage body. The exact
owned page was deleted and a final GET returned 404. The temporary fixture and
raw live receipt were removed; no live ID, URL, credential, or tenant-derived
body is committed.

### Decision

PDF-02 is complete. PDF.js remains outside the import package. Semantic block
construction, reading-order decisions, tables, figures, and raster fallbacks
remain owned by PDF-03 through PDF-05; this task establishes only the bounded,
provenance-bound facts layer they consume.

## PDF-03 - Tagged semantic extraction

### Result

The PDF package now correlates public PDFium structure nodes and MCIDs with
owned character facts and emits a digest-bound `atlcli.pdf-tagged-semantics/1`
result. Every accepted target node has a stable source id, page/label,
structure path, normalized bounding box where available, MCID list, evidence
basis, confidence, decision code, and one of the shared loss outcomes.

The native tagged slice supports H1-H6, paragraphs, nested ordered/unordered
lists, NFC text normalization, logical RTL text, rotated character facts, and
allowlisted external link marks limited to overlapping character regions.
Explicit heading levels are retained; hierarchy gaps are reported rather than
silently repaired. Outline presence is not required for heading recognition.

Tables, figures, and unsupported roles are preserved as `reported` evidence
for their dedicated tasks. They are not called native. Duplicate MCID owners,
missing structures, empty correlations, invalid Unicode maps, and unclaimed
visible marked text make the page `geometry-required`. Repeated tagged text is
retained with distinct source evidence and an explicit repeated-region issue;
no implicit deduplication occurs.

The semantic normalizer recomputes the facts digest before use and rejects a
mismatch with `pdf/provenance-drift`. Its output digest covers the source facts
digest, tagged policy revision, semantic document, evidence, page outcomes,
and geometry-required page set.

### Tagged goldens and measured gates

```text
bun run test packages/import-pdf --test-name-pattern tagged
5 pass, 0 fail, 44 assertions

bun run test packages/import-pdf
16 pass, 0 fail, 252 assertions
```

The independent real tagged golden produced the same facts and semantic digest
across repeated PDFium runs. Its available-family metrics are:

| Metric | Result |
|---|---:|
| accounted pages | 1 / 1 (100%) |
| visible marked characters accounted by native or reported evidence | 127 / 127 (100%) |
| unreported loss | 0 |
| duplicate projected text | 0 |
| exact projected block-order pairs | 1 / 1 (100%) |
| heading precision / recall | 1.00 / 1.00 |
| heading-level accuracy | 1 / 1 (100%) |
| false native table/figure outcomes | 0 |
| unsafe links promoted | 0 |

The real result projects exactly `heading,paragraph` to both neutral IR and
ADF, while the tagged table and figure remain reported. Removing its outline
does not change the H1 result. Deterministic contract goldens additionally
prove exact H1-to-H3 preservation, logical Arabic text with rotated facts,
partial safe-link run segmentation, nested ordered/unordered list structure,
list item/nesting F1 1.00, repeated-region accounting, duplicate-MCID
demotion, and missing-tree demotion.

This task does not claim the eventual cross-producer release corpus (Word,
LibreOffice, browser print, and expanded Unicode/layout fixtures). That breadth
remains a PDF-10 release gate; PDF-03 proves the implemented semantics against
the current independent real golden and deterministic contract families.

### Repository and packaged-consumer proof

```text
bun run typecheck
pass

bun run build
33 tasks pass

bun run check:browser
36 browser entrypoints pass

bun install --frozen-lockfile
pass

bun run test scripts/api-report.test.ts scripts/publishable-deps.test.ts packages/import-pdf
22 pass, 0 fail, 267 assertions

ATLCLI_CONSUMER_SMOKE=1 bun run test scripts/consumer-smoke.test.ts
12 pass, 0 fail
```

API reports and closure classification were regenerated from fresh built
declarations with zero reachable-but-unexported gaps. The real tarball suite
proved Bun, plain Node 22/npm, and Vite 8.1.4 consumers. In the Vite production
chunk the packed browser-worker loads the verified local PDFium WASM, analyzes
the independent tagged golden, and produces title `Structured Garden Report`,
block types `heading,paragraph`, plus valid facts and semantic digests. The
existing no-CDN/no-eval and exact-WASM checks remain active.

### Built-CLI live guard

The freshly built CLI previewed a neutral DOCX with one heading, paragraph,
and list, created a version-1 page in the authorized `mayflower` / `DOCSY`
environment, and read back the expected Storage body. The exact owned page was
deleted and a final GET returned 404. The temporary fixture and raw receipt
were removed; no live ID, URL, credential, or tenant-derived body is committed.

### Decision

PDF-03 is complete for the tagged text/heading/list/link semantics assigned to
this task. PDF-04 owns conservative geometry order and repeated-region removal;
PDF-05 and PDF-06 replace the explicit tagged table/figure reports only after
their separate false-native and fallback gates pass.

## PDF-04 - Conservative untagged reading order

### Result

The PDF package now normalizes qualified digital-untagged pages under the
explicit `atlcli.pdf-geometry-policy/1` revision. The exported immutable policy
pins the column, line, fragment-gap, overlap, heading, and rotation thresholds,
and the semantic digest covers both that revision and the exact source-facts
digest.

The implementation deterministically fragments and orders characters into
lines and blocks, supports at most two proven columns, suppresses only exact
overlapping duplicates, removes repeated top/bottom furniture only after a
cross-page threshold is met, and derives headings and one-level nested lists
from measured evidence. Safe URI annotations are projected only over their
overlapping text. Logical RTL text is preserved. Conflicting overlap, more than
two columns, non-horizontal text, invalid Unicode mapping, scan/mixed pages,
and other ambiguous layouts emit explicit `fallback-required` page outcomes
with no native semantic blocks.

Every fragment is either projected or represented by approximated/reported
evidence. Repeated regions, page-number furniture, exact duplicates, unsafe
links, and every rejected geometry decision therefore remain visible in the
evidence ledger rather than disappearing silently.

### Goldens and measured gates

```text
bun run test packages/import-pdf --test-name-pattern untagged
4 pass, 0 fail, 44 assertions

bun run test packages/import-pdf
20 pass, 0 fail, 296 assertions
```

| Family | Measured result |
|---|---|
| simple untagged | 1/1 page qualified; exact `heading,paragraph,paragraph,paragraph,heading,list`; three native list items; safe link retained; zero fallback pages |
| two-column | exact title followed by all 12 left-column and all 12 right-column lines; 25 blocks total; zero duplicates or fallback pages |
| heading-rich 100-page | 100/100 page outcomes; four deterministic heading roots; zero unassigned pages |
| heading-poor 100-page | 100/100 page outcomes and body paragraphs; 100 distinct page tokens retained; repeated headers removed; zero invented headings |
| negative layouts | conflicting overlap, three-column geometry, and rotation produce zero native blocks; exact overlap is explicitly approximated; unsafe links are not promoted |
| RTL contract | logical RTL text remains qualified and unchanged |

The focused API/package suite completed with 26 passing tests and 311
assertions. The current corpus does not yet establish the broader
cross-producer release matrix; that remains a PDF-10 gate.

### Repository and packaged-consumer proof

```text
bun run typecheck
pass

bun run build
33 tasks pass

bun run check:browser
36 browser entrypoints pass

bun install --frozen-lockfile
pass

bun run test scripts/api-report.test.ts scripts/publishable-deps.test.ts packages/import-pdf
26 pass, 0 fail, 311 assertions

ATLCLI_CONSUMER_SMOKE=1 bun run test scripts/consumer-smoke.test.ts
12 pass, 0 fail
```

Fresh declarations produced matching API and closure reports with no hidden
public type. The packed Bun, filesystem-link, plain Node 22/npm, and Vite 8.1.4
consumers remain green. The Vite production case uses the exact local PDFium
WASM to analyze both neutral tagged and untagged PDFs. The untagged case yields
title `Quarterly Garden Notes`, the expected six-block sequence, no fallback
page, and a stable 64-character semantic digest; the existing no-CDN/no-eval
and exact-WASM checks remain active.

### Built-CLI live guard

The freshly built CLI previewed and published the existing neutral generated
DOCX in the authorized `mayflower` / `DOCSY` environment. Readback preserved
the four headings, table, image attachment, caption, and repeated body text.
The exact owned page was deleted and the final GET returned 404. No live ID,
URL, raw receipt, credential, or tenant-derived body is committed.

### Decision

PDF-04 is complete for conservative digital-untagged ordering, repeated-region
handling, overlap suppression, basic heading/list evidence, and explicit
fallback. Tables and figures remain non-native until PDF-05/PDF-06 clear their
separate evidence and false-native gates.

## PDF-05 - Tables and spans

### Result

The exact PDFium facts boundary now records bounded public path-object facts
(normalized bounds, segment count, fill mode, and stroke flag) and character
font weight. The reviewed public-call allowlist covers only
`FPDFPath_CountSegments`, `FPDFPath_GetDrawMode`, and
`FPDFText_GetFontWeight` in addition to the already admitted object APIs. No
operator list or private/fork API is used.

`atlcli.pdf-table-policy/1` accepts a tagged table only when every row/cell role,
MCID correlation, Unicode mapping, integer RowSpan/ColSpan, occupancy, and grid
boundary is complete and non-overlapping. It accepts an untagged table only
when stroked axis-aligned path objects form a complete bounded grid and every
cell contains uniquely assigned text. Header identity is native only from a
`TH` role or separately proven bold first-row evidence; the current untagged
producer exposes no usable weight and therefore does not invent headers.

Malformed tagged grids are linearized row by row. Repeated aligned columns
without path/grid proof are also linearized and explicitly marked
`linearized-render-required`; they never produce a native table. Cell source
references, page/bounds, decision confidence, outcome, and policy revision
remain in evidence, and the visible cell text is neither duplicated nor lost.
PDF-06 owns the actual rendered-region asset.

### Table goldens and target projections

```text
bun run test packages/import-pdf packages/import-core packages/import-docx --test-name-pattern table
10 pass, 0 fail, 78 assertions

bun run test packages/import-pdf
24 pass, 0 fail, 333 assertions
```

| Family | Result |
|---|---|
| real tagged | exact 2x2 native table; 4/4 cells and 2/2 headers correct; cell text/order exact; figure remains separately reported |
| synthetic tagged spans | complete 3-row grid retains `colspan=2` and `rowspan=2` in both ADF and Storage |
| malformed tagged | grid hole and invalid typed span produce zero native tables; all three source tokens occur exactly once in the linearized result |
| real untagged positive | eight stroked path facts prove one complete 3x3 grid; 9/9 cells correct; page stays geometry-native |
| real untagged negative | alignment-only source produces zero native tables; all 9 cell tokens survive in three linear rows; page requires fallback |

The shared encoder regression suite ran the DOCX parser, DOCX ADF/Storage
encoders, and source-neutral span encoders directly:

```text
bun run test packages/import-docx/src/parse.test.ts packages/import-docx/src/adf.test.ts packages/import-docx/src/storage.test.ts packages/import-core/src/model.test.ts
28 pass, 0 fail, 102 assertions
```

Those checks independently verify `tableHeader`/`tableCell`, RowSpan/ColSpan,
Storage `th`/`td`, exact cell text/order, and DOCX nested-table reporting. Live
PDF publication/readback remains intentionally owned by PDF-08/PDF-11 because
the PDF CLI route does not exist before PDF-07.

### Repository and packaged-consumer proof

```text
bun run typecheck
pass

bun run build
33 tasks pass

bun run check:browser
36 browser entrypoints pass

bun install --frozen-lockfile
pass

bun run test scripts/api-report.test.ts scripts/publishable-deps.test.ts packages/import-pdf
30 pass, 0 fail, 348 assertions

ATLCLI_CONSUMER_SMOKE=1 bun run test scripts/consumer-smoke.test.ts
12 pass, 0 fail
```

Fresh API/closure reports have zero reachable-but-unexported gaps. The packed
Bun, filesystem-link, plain Node 22/npm, and Vite 8.1.4 consumers remain
green. The Vite production hook uses the exact local PDFium WASM and now proves
the real tagged 2-row/4-cell/2-header table in the semantic output, while the
no-CDN/no-eval and exact-WASM assertions remain active.

### Built-CLI live guard

The first neutral DOCX write encountered an immediate Confluence readback
sequence mismatch. The existing transaction failed closed, rolled back its one
owned page, and a title query returned zero pages. A controlled retry then
published successfully; independent readback preserved headings, the 2x2
table, image, caption, and body text. The exact page was deleted, final GET
returned 404, and a final title-prefix query returned zero pages. No live ID,
URL, raw receipt, credential, or tenant-derived body is committed.

### Decision

PDF-05 is complete. Native tables require structure or a proved physical grid;
alignment alone is never native. PDF-06 must materialize the rendered-region
fallback before the CLI can offer visual preservation for approximated tables.

## PDF-06 - Figures, extraction, and bounded rendered fallback

### Result

`atlcli.pdf-figure-policy/1` now correlates tagged `Figure` structure/MCIDs with
public PDFium image and path-object facts. A one-to-one placed raster whose
source and placement aspect ratios agree is extracted through
`FPDFImageObj_GetRenderedBitmap`. Composite, vector, clipped, and table-fallback
regions are instead rendered at 144 DPI through a reviewed public
`FPDF_RenderPageBitmap` boundary. They are explicitly recorded as `attached`,
never as native vector semantics.

The host-neutral materializer accepts only caller-owned PDF bytes and the
digest-pinned local PDFium WASM. It enforces per-asset and aggregate render
pixel/byte budgets, a maximum 300 DPI, unique request IDs, valid normalized
bounds, and exact public object paths. Each page and bitmap is closed in
`finally`; document, input allocation, and library ownership are then released
in reverse order. Cooperative cancellation is observed before and between
requests, while worker termination remains the hard-cancellation boundary.

Assets are deterministic PNGs with SHA-256 identities and filenames of the
form `pdf-pNNN-<digest>.png`. Identical bytes produce one asset with multiple
source references while each placement retains its own image block. Tagged
author alt and captions are retained. Missing author alt is reported and never
invented. Both shared target projections are proven: Cloud ADF receives the
resolved media ID/collection/alt, and Data Center Storage receives the exact
attachment filename/alt.

### Neutral figure and fallback goldens

```text
bun run test packages/import-pdf packages/import-core --test-name-pattern figure
7 pass, 0 fail, 55 assertions

bun run test packages/import-pdf
31 pass, 0 fail, 398 assertions
```

| Family | Result |
|---|---|
| real tagged | one native raster; author alt and caption retained; final block order is heading, paragraph, table, image, caption |
| real untagged | one native raster plus one rendered vector region; two placements share the proved caption; both missing-alt outcomes reported |
| alignment-only table | exact linearized text plus one bounded rendered table region; outcome is attached, not native |
| duplicate synthetic placement | two independent figure blocks reference one content-addressed PNG asset |
| lifecycle/adversarial | pixel and DPI budgets, invalid object paths, cancellation after request one, and faults after bitmap/render all fail with stable codes, clean up, and recover deterministically |

The real untagged fixture produced a 240 x 160 native PNG (153,838 bytes) and
a 384 x 351 rendered vector PNG (539,595 bytes). Repeated runs produced the
same semantic and asset digests. Manual rendered-image inspection confirmed
that the raster shapes and the complete vector frame/diagonals are visible and
bounded; no customer artifact was used or retained.

### Repository and packaged-consumer proof

```text
bun run typecheck
pass

bun run build
33 tasks pass

bun run check:browser
36 browser entrypoints pass

bun install --frozen-lockfile
pass

bun run test scripts/api-report.test.ts scripts/publishable-deps.test.ts packages/import-pdf
37 pass, 0 fail, 413 assertions

ATLCLI_CONSUMER_SMOKE=1 bun run test scripts/consumer-smoke.test.ts
12 pass, 0 fail
```

Fresh API and closure reports have zero reachable-but-unexported gaps. Packed
Bun, filesystem-link, plain Node 22/npm, and Vite 8.1.4 consumers remain green.
The production Vite hook loads the emitted local PDFium WASM, analyzes the real
tagged neutral fixture, materializes its figure, and proves one native raster,
one deterministic asset, retained author alt, and the expected final block
sequence. The browser gate inventory now explicitly locks both `import-core`
and `import-pdf` browser entrypoints.

A full repository run outside the sandbox completed 8,304 tests with 16
documented skips and one failure in the pre-existing viewer-only PDF.js
baseline under full-suite concurrency. The exact PDF.js test passed immediately
in isolation (1 pass, 0 fail); all PDFium importer and Figure tests passed in
the full run. This task therefore does not claim a fully green monorepo run,
and the unrelated concurrency-sensitive viewer probe remains visible.

### Built-CLI live guard

The freshly built CLI previewed and published the existing neutral generated
DOCX in the authorized `mayflower` / `DOCSY` environment. Readback preserved
the heading, paragraphs, and list at version 1. The exact owned page was
deleted, final GET returned 404, and an exact title query returned zero pages.
No live ID, URL, raw receipt, credential, or tenant-derived body is committed.

### Decision

PDF-06 is complete. Native raster extraction is limited to proved one-to-one
objects; vector/composite and weak table semantics retain visible fidelity only
through bounded, explicitly attached rendered regions. PDF-07 may now expose
these decisions in the review-first CLI vertical slice.

## PDF-07 - Review, overrides, and CLI PDF vertical slice

### Result

`wiki import` now routes one local file, stdin with explicit `--format`, or an
exact Confluence attachment by suffix plus byte signature. Explicit
`--format docx|pdf` must agree with the bytes. The PDF path is dynamically
loaded, so existing DOCX invocations do not initialize PDFium or read its WASM.
DOCX keeps its shipped syntax, preview, batch, recipe, update, and publication
behavior; PDF-only and DOCX-only options fail on the wrong source instead of
being ignored.

The PDF vertical slice loads the exact local PDFium WASM from the built asset,
analyzes and normalizes the source, materializes proved figures/fallbacks, and
returns either a terminal review or `atlcli.pdf-import-review/1` standard JSON.
The standard report contains page classification/outcomes/confidence, target
capability evidence, block counts and heading outline, table/figure/asset
summaries, sanitized review locators, issues, requested/resolved split policy,
per-target-page estimates, rollback scope, and facts/semantic/issues/split/plan
digests. It intentionally omits raw facts, block bodies, and asset bytes.

`atlcli.pdf-import-overrides/1` is source-SHA-bound and limited to four reviewed
semantic operations: heading level, author alt text, title from selected
extracted text, and deterministic top-level reordering. The 256 KiB / 200
operation parser uses YAML core schema, duplicate-key and zero-alias parsing,
exact field allowlists, control-character and length checks, prototype-key
rejection, conflict checks, and stale/unknown source-ID rejection. It cannot
inject ADF, Storage, HTML, scripts, URLs, OCR text, paths, or remote assets.

### Split-policy proof

`atlcli.pdf-split-policy/1` implements `auto` (default), `off`,
`heading:<1..6>` plus numeric alias, and `pages:<5..40>`. The default one-page
threshold is 20 source pages below editability caution; explicit one-page mode
has an absolute 40-source-page ceiling. The default/absolute wiki-page caps are
50/200. Every plan assigns each physical source page exactly once, keeps
multi-page atomic blocks together, reports shifted boundaries, and includes the
requested policy in the canonical plan digest.

| Neutral golden | Resolved result |
|---|---|
| simple untagged, 1 page | one wiki page; one exact source assignment |
| complex tagged, 1 page | one wiki page; one native table and one native raster figure |
| heading-rich, 100 pages | root index plus 8 content pages; four 20-page heading pages with four 5-page range children; max content range 20 |
| heading-poor, 100 pages | root index plus five flat 20-page range children |
| synthetic 12-page atomic table | nominal 5-page boundary shifts to 7/5; table is not split |
| scan | default `fail` blocker; explicit `page-image` creates one bounded PNG and accessible-text warning |

Both 100-page goldens have 100 sorted assignments, no duplicate/unassigned
page, no blocker, and no one-source-page-per-wiki-page expansion. `--split off`
rejects 100 pages. A resolved count over `--max-wiki-pages` remains previewable
but blocks confirmation; the 200-page absolute transaction limit rejects.

### Tests and packaged runtime

```text
bun run test packages/import-pdf apps/cli/src/commands/wiki-import.test.ts apps/cli/src/commands/wiki-import-pdf.test.ts
57 pass, 0 fail, 525 assertions

bun run test scripts/api-report.test.ts scripts/publishable-deps.test.ts packages/import-pdf
44 pass, 0 fail, 452 assertions

ATLCLI_CONSUMER_SMOKE=1 bun run test scripts/consumer-smoke.test.ts
12 pass, 0 fail

bun run typecheck
pass

bun run build
33 tasks pass

bun run check:browser
36 browser entrypoints pass
```

Fresh API and closure reports contain no reachable-but-unexported gaps. Packed
Bun, production filesystem-link Bun, plain Node 22/npm, and Vite 8.1.4 all run
their real DOCX and PDF smokes. The freshly built CLI emits a local
`pdfium-*.wasm`; its neutral tagged PDF preview reports one heading, one native
table, one native raster figure, one source assignment, no blocker, and stable
facts/semantic/issues/split/plan digests. The plan's illustrative
`feature-zoo.pdf` filename does not exist in the committed PDF-00 corpus, so the
actual built-CLI gate uses the richer committed `complex-tagged.pdf` golden.

### Built-CLI live guards

The freshly built CLI published an existing neutral generated DOCX in the
authorized `mayflower` / `DOCSY` environment. Readback preserved its heading,
paragraph, and list at version 1. The exact returned owned page was deleted;
final GET returned 404 and an exact title CQL query returned zero results.

The built PDF command then analyzed a neutral one-page PDF under `--confirm`
with the same authorized target. PDF-07 deliberately has no publication seam:
it returned the stable validation message that publication waits for the shared
transaction/readback task, included the plan digest, and made no write. An exact
title CQL query returned zero results. No live ID, URL, raw receipt, credential,
tenant-derived body, or private PDF is committed.

The full repository suite outside the sandbox completed 8,316 tests with 16
documented skips and one failure in the pre-existing viewer-only PDF.js
baseline under full-suite concurrency. The complete importer probe, including
that exact PDF.js assertion, then passed immediately in isolation (8 pass,
0 fail, 277 assertions). All PDF-07 importer and CLI tests passed in the full
run. This task therefore does not claim a fully green monorepo run, and keeps
the unrelated concurrency-sensitive viewer probe visible.

### Decision

PDF-07 is complete. Review and split planning are real and digest-bound, while
confirmed PDF publication remains fail-closed until PDF-08 factors the shared
transaction and strengthens semantic readback. This prevents a preview-only
vertical slice from claiming mutation safety it has not yet implemented.

## PDF-08 - Shared verified Confluence publication

### Result

`@atlcli/import-confluence` is the smallest source-neutral seam proved by both
`ImportDocumentV2.sourceKind` values. It accepts a prepared page plus injected
Cloud/DC client ports and owns target projection, attachment/media correlation,
semantic readback, immediate owned-ID registration, and reverse-order rollback.
It has no concrete Confluence client, authentication, filesystem, CLI, DOCX or
PDF policy branch. DOCX comments, baseline-guarded in-place updates, recipes,
batch orchestration, and source-specific split policy remain in their existing
owners.

Cloud direct-create, attachment shell/finalize, and DOCX split finalization now
use that seam. Data Center single-page publication uses the same prepared page
contract and retains REST v1 Storage plus filename media. The CLI's three
rollback paths use one exact-ID helper which deduplicates ownership and deletes
children before parents; it never discovers or deletes pages outside the
transaction ledger.

### Semantic readback

`atlcli.confluence-semantic-readback/1` fingerprints bounded semantic tokens,
not just the top-level block sequence. ADF proof includes recursive node order,
text and marks/links, heading levels, list structure, table headers and spans,
and media file ID/collection/alt. Storage proof parses the supported XHTML
subset and includes corresponding text, lists, tables/spans, links, code, and
attachment filenames. Receipts contain only counts and digests, never source
body text.

Tests reject changed text, lost table spans, and changed media identity on both
target representations. Cloud's explicit semantic default table spans of one
are normalized to the encoder's omitted form; spans greater than one remain
strict. Invalid/malformed or over-budget readback fails the transaction.

### Transaction and DOCX compatibility proof

The Cloud failure matrix injects faults at shell creation, the post-shell
restriction hook, attachment upload, media correlation, body update, readback,
and semantic verification. Every post-create case registers exactly one owned
ID before failing and rolls it back exactly once. A separate proof records
child-first deduplicated rollback and exact failed IDs. Data Center semantic
drift fails after ownership registration.

DOCX regression tests lock direct create, image shell/upload/finalize ordering,
parent-first split shell creation, deterministic root/child finalization,
inline replies/resolved comments outside the shared package, baseline-guarded
in-place update with successor baseline sealing, semantic-drift failure, and
the existing REST v1 Data Center contract.

```text
bun run test packages/import-confluence packages/import-docx packages/import-pdf packages/confluence apps/cli/src/commands/wiki-import.test.ts apps/cli/src/commands/wiki-import-publication.test.ts apps/cli/src/commands/wiki-import-dc.contract.test.ts
1786 pass, 0 fail, 2 snapshots, 5114 assertions

bun run test packages/import-confluence apps/cli/src/commands/wiki-import-publication.test.ts
13 pass, 0 fail, 77 assertions

bun run test scripts/api-report.test.ts scripts/publishable-deps.test.ts packages/import-confluence scripts/check-browser-build.test.ts
41 pass, 0 fail, 154 assertions

ATLCLI_CONSUMER_SMOKE=1 bun run test scripts/consumer-smoke.test.ts
12 pass, 0 fail

bun run build
34 tasks pass

bun run check:browser
37 browser entrypoints pass

bunx tsc --noEmit
pass
```

Fresh API and closure reports classify the package as experimental `0.x` and
have zero reachable-but-unexported gaps. Packed Bun, production file-link Bun,
plain Node 22/npm, and Vite 8.1.4 consumers all remain green.

### Built-CLI live proof and cleanup

The first built-CLI DOCX publication in the authorized `mayflower` / `DOCSY`
environment exposed Cloud's explicit default table-span normalization. The
strict verifier rejected it and the transaction rolled its exact owned page
back; the same title was immediately available again. After adding the
default-span regression, the rebuilt CLI published the neutral generated DOCX
at version 2. Independent readback preserved headings, paragraphs, a table and
its cell text, one image attachment reference, and the second section. The
exact owned page was deleted; final GET returned 404 and exact title search
returned zero pages. No live ID, URL, receipt, credential, tenant-derived body,
or private PDF is committed.

### Decision

PDF-08 is complete. Both import sources now have a common prepared-page and
verified target transaction without moving source-specific behavior into a
generic abstraction. PDF-09 may enable PDF publication and bounded page trees
on top of this proven seam.
