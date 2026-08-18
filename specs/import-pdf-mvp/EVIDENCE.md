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
