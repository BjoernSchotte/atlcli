# Issue #118 implementation ratchet

Per-step measurement log for the post-gate implementation
(`specs/issue-118-adaptive-browser-pdf-memory/PLAN.md`). Every step records
its lane, the BEFORE and AFTER numbers from that lane, and the proof commands
that ran green before the step was pushed. Numbers are machine-local
(Bun 1.3.14, macOS arm64, Chromium 140.0.7339.16 via Playwright) and comparable
only within one lane on this host.

Global baselines (measured before any Phase 0.5 change):

- Chrome mixed fixture (`ATLCLI_CHROME_MEMORY_RESULT`, schema v2): worker
  peak 137.93 MiB at `compiled-held`, 63.3% WASM / 36.7% host.
- Chrome image-heavy corpus (`ATLCLI_CHROME_MEMORY_IMAGE_HEAVY_RESULT`):
  worker peak 1558.32 MiB at `compiled-held`, 85.1% WASM / 14.9% host;
  panel `prepareFromBaseline` +100.29 MiB backing; worker `bundleRead`
  +100.37 MiB backing.

## Phase 0.5 — copy-elimination quick wins

### Step 1 — panel artifact delivery via chunk-granular Blob handle

Change: `pdf-run.ts`/`docx-run.ts`/`jobs/store.ts` deliver artifacts through
`collectArtifactHandleV1` (every chunk becomes a `Blob` part immediately;
`downloadBytes` reuses the same `Blob`) instead of concatenating one
panel-heap `Uint8Array` and letting the anchor build a second `Blob` copy.
The legacy panel download wraps its array in `pdfBytesFromUint8Array` so the
anchor stops copying it too.

Lane: Chrome memory harness, image-heavy corpus (97.36 MiB artifact),
`ATLCLI_CHROME_MEMORY_IMAGE_HEAVY_RESULT` `panel.delivery*` A/B measured in
one run while each variant is HELD (pending-anchor retention), with a
`deliveredState` self-check that defeats bundler dead-code elimination
(a write-only hold was silently eliminated by the bundler and measured a
fake 0 — the probe now proves retention at sample time).

| Delivery shape | used MiB | backing MiB |
|---|---|---|
| BEFORE (array + anchor Blob) | -0.04 | **+97.36** |
| AFTER (chunk-granular Blob handle) | -0.03 | **0.00** |

Result: the whole-artifact panel-heap retention during delivery is
eliminated (97.36 MiB → 0.00 MiB on the image-heavy corpus; the isolated
CDP experiment reproduced +97.00 → +0.00 with a seeded result). Both memory
harness tests pass with the new structural assertions
(`deliveryArrayShape.backingMiB > 0.8 × pdfMiB`,
`deliveryHandleShape.backingMiB < 8`).

### Step 2 — asset checkpoint and executor read-back copy shapes

Changes:

- `checkpointed-assets.ts`: `sha256Hex` digests the typed-array view (WebCrypto
  snapshots synchronously; the copy-then-digest-the-buffer dance doubled every
  asset), `bytesSource` streams publish-owned bytes without a producer copy
  (every spool sink owns what it stores), and known-length read-backs write
  into one preallocated buffer bound to the recorded byteLength. The single
  ownership snapshot in `publish()` stays and is documented as THE TOCTOU
  boundary; new tests pin mutation-isolation and host-boundary tamper
  rejection (appended byte and equal-length bit-flip).
- `collectExecutorBytes` (extension) and `collect` (export-node) gain the
  exact-length preallocated path; PDF and DOCX `materialize()` pass the
  store's own `stat().byteLength`, removing the per-blob chunk-list + concat
  double buffering and detecting truncation before hydrate.
- `pdf-job-executor.ts` `sha256Hex` digests non-buffer-exact views directly
  instead of `slice()`-copying them (fingerprint bytes unchanged).

Lane: `bench:copy-probe` (`atlcli.copy-probe/1`), isolated child processes,
`/usr/bin/time` peak RSS, median of 3.

| Scenario | BEFORE MiB | AFTER MiB | Delta |
|---|---|---|---|
| checkpoint-assets (3×20 MiB + repeated logo through `checkpointPdfAssetsV1` + real file spool) | 303.69 (302.47–303.72) | **243.64** (242.22–243.75) | **−60.05** |
| executor-collect (3×40 MiB through the real chunk store on fake-indexeddb) | 487.48 (477.92–491.59) | 530.75 (501.22–537.28) | inconclusive |

Honest reading (step 2): the checkpoint-assets win is exactly the predicted ~3×20 MiB
of per-asset transients. The executor-collect lane is **inconclusive on this
instrument** — fake-indexeddb structured-clone noise (run spread ±30 MiB)
exceeds the per-object signal, and production objects are ~2.6 MiB where the
bounded effect is ≈ one object. The shape change there is carried by unit
tests (exact-length fill, overflow, truncation, limit) and by the unchanged
packed-extension and node job baselines; its integrity benefit (length
binding detects truncation before hydrate) stands regardless.
Node job baseline re-run AFTER as no-regression: all 12 cells complete,
artifact hashes unchanged.

## Phase 1 — explicit image profiles (primary lever)

Built: `@atlcli/export-media` (published-classified) with the inspection code
EXTRACTED from `@atlcli/docx` (docx re-exports; one implementation), the
pinned encoders MOVED from `@atlcli/export-fixtures` (corpus recipe hash
`95b46f89…` unchanged — byte-identity proven by the pin), plus new pinned
pure-TS decoders (PNG: full RFC-1951 inflate incl. dynamic Huffman, all five
filters, palette/tRNS/gray/alpha; JPEG: baseline+extended sequential, 4:4:4/
4:2:2/4:2:0, restart markers, IDCT over the shared literal cosine matrix),
deterministic premultiplied box resampling, profile presets over a numeric
core (`standard`=180 PPI candidate, `print`=300, `imagePpi` 72–1200), and
`normalizeRasterAssetV1` (JPEG stays JPEG, alpha stays lossless PNG, SVG/GIF/
undecodable KEPT with a stated reason, never upscale, ±2% no-op hysteresis).

Codec proof (18/18 unit): byte-exact PNG roundtrip; inflate vs node:zlib on
dynamic/fixed/stored streams; all five PNG filters from an independent zlib
stream; REAL ImageIO-written PNG and 4:2:0 JPEG fixtures cross-validated
(committed binaries, 1.4 KiB); progressive/16-bit/interlaced rejected (kept,
never guessed). Engine proof: `preparePdfDocument({imageQuality})` normalizes
deterministically with ONE aggregate diagnostics note; the real Typst
compiler accepts every derivative (scale-0.75 corpus, 0 diagnostics, tagged
PDF, bundle < 75%). The template logo (fourth asset source) normalizes in
`serializePdfDocument`.

Lane: Chrome memory harness, full-scale image-heavy corpus, one run per
profile through the identical store → worker → VFS → compile path
(`ATLCLI_CHROME_MEMORY_IMAGE_PROFILE_RESULT`, Chromium 140.0.7339.16):

| | original | standard (180 PPI) | delta |
|---|---|---|---|
| source bundle | 100.36 MiB | **16.65 MiB** | −83.4% |
| compiled PDF | 97.36 MiB | **15.79 MiB** | −83.8% |
| WASM linear high-water | 1326.56 MiB | **325.63 MiB** | −75.5% |
| worker peak (compiled-held) | 1558.32 MiB | **392.10 MiB** | **−74.84%** |

**The plan's 40% product bar for recommending `standard` on large trees is
met with a 74.84% measured peak reduction**, now asserted in the harness
(`peakReduction ≥ 0.4` at scale 1). Prepare-side normalization of the 100 MiB
corpus runs in-page as part of the measured cycle.

### Phase 1 follow-up — browser raster path ratchet (2026-08-28)

Question: after the profile's 74.84% primary win, can a browser-native or
WASM resize path make normalization faster and/or lower its own peak without
moving memory into an unobserved native allocator?

Built: an optional async `RasterNormalizerPortV1` in the real PDF preparation
pipeline, a statically bundled MV3 normalizer worker, and four measured lanes:

1. current pinned pure-TS decode + box resize on the extension panel thread;
2. WebCodecs `ImageDecoder` in a disposable worker;
3. target-sized `createImageBitmap` in a disposable worker;
4. Pica 10.0.3 (`mks2013`, JS+inline-WASM, no nested/Blob worker) in a
   disposable worker.

All lanes consume the exact same header-only target plan and pinned PNG/JPEG
encoder. Only decode/resize and lifetime differ. The full scale-1 corpus
(100.29 MiB, 76 unique assets, 190 placements) is already resident before the
normalizer baseline. Whole-Chromium process-tree RSS is sampled every 25 ms so
native `ImageBitmap`/`VideoFrame` allocations cannot hide outside the V8 heap;
PNG and JPEG source/decoded/target/encoded holds are separately forced-GC
sampled. Candidate workers are terminated and their CDP targets proven gone
before the identical IndexedDB → Typst worker → tagged-PDF path starts.

Lane: `ATLCLI_RASTER_NORMALIZER_RATCHET_RESULT`, macOS arm64, repo-pinned
Chromium 140.0.7339.16. One full four-lane run; byte/digest stability was also
observed in an earlier full run and targeted Pica rerun.

| Raster path | execution | prepare | normalizer peak RSS delta | RSS after cleanup vs baseline | bundle | Typst peak | whole-Chrome peak |
|---|---|---:|---:|---:|---:|---:|---:|
| pure TS (current) | panel main | 39.09 s | +226.05 MiB | baseline (−14.64 MiB noise) | 16.65 MiB | 395.29 MiB | 1617.14 MiB |
| WebCodecs | disposable worker | **12.05 s** | **+672.37 MiB** | **+405.06 MiB** | **14.81 MiB** | **383.52 MiB** | **2024.92 MiB** |
| ImageBitmap | disposable worker | 13.52 s | **+191.83 MiB** | +5.72 MiB | 17.21 MiB | 398.08 MiB | 1633.67 MiB |
| Pica 10 | disposable worker | 18.89 s | +217.05 MiB | +11.93 MiB | 19.05 MiB | 409.20 MiB | 1643.28 MiB |

Every successful lane normalized 133 calls, kept the same 57 no-op/logo
placements, deduplicated to the same 76 output assets, compiled to a tagged
PDF, and produced a stable per-lane output-asset digest across repeated runs.
The different filters intentionally produce different bytes. Candidate worker
targets are gone before compile in all three lanes.

OS RSS is deliberately the native-allocation safety signal, but noisier than
the phase-pinned compiler attribution. Repeated normalizer peak deltas were:
pure TS **+187.48 to +251.08 MiB**, WebCodecs **+668.34 to +672.37 MiB**,
ImageBitmap **+191.83 to +196.14 MiB**, and Pica **+216.17 to +217.05 MiB**.
Therefore the small pure/ImageBitmap/Pica differences are inconclusive; only
WebCodecs' regression is far outside observed noise.

Important findings:

- **ImageBitmap is the only path that earns a continued product PoC.** It is
  2.9× faster than current pure TS, stays in the current path's noisy RSS band,
  returns process RSS to within 5.72 MiB of baseline, and decodes both sampled
  PNG and JPEG directly at the exact 1175px target. Its slightly larger output
  makes the subsequent Typst peak 2.79 MiB higher than current; therefore this
  is a responsiveness/lifetime win with memory non-regression, not another
  whole-export memory order of magnitude. Adoption still requires pixel-golden
  quality, color/alpha/EXIF, two-run determinism, cancellation, and
  supported-browser gates.
- **Keep pure TS as the deterministic fallback.** It remains the reference
  for unsupported browsers and exact cross-host behavior. Moving this same
  implementation to a disposable worker can be evaluated separately if panel
  responsiveness alone justifies it.
- **Pica is a quality challenger, not a memory solution.** It is 2.1× faster
  than current but fully decodes the sampled JPEG (2400×1792), keeps an
  ~8.8 MiB WASM/backing high-water until termination, emits the largest bundle,
  and raises the downstream Typst peak. Pica 10 also fails to detect
  `OffscreenCanvas` when it already runs inside the outer worker; the spike
  uses its public `createCanvas` host seam to bind the proven platform canvas.
  Continue only if visual goldens show a material quality advantage over
  target-sized ImageBitmap.
- **Do not pursue WebCodecs for this path yet.** It is fastest and emits the
  smallest bundle, but its native process peak is ~3× the current normalizer
  delta and ~405 MiB remains after its worker target is gone. The sampled PNG
  ignored desired dimensions (2200×1400), while the JPEG decoded to 900×672
  and was then upscaled to the 1175×877 target, adding a quality concern. V8
  heap alone reported only ~4.45 MiB and would have falsely called this lane a
  win. Reconsider only after a current-browser matrix proves both native-RSS
  release and exact decode geometry.

The installed branded Chrome 151.0.7922.175 was checked as the current-browser
anchor. As expected for current branded Chrome, command-line unpacked-extension
loading did not create a service worker; the reproducible quantitative lane
therefore remains Chrome-for-Testing/Chromium. This is an explicit matrix gap,
not evidence that Chrome 151 fixes or retains the WebCodecs behavior.

Consequence for broader candidates: **do not add wasm-vips/jSquash to the PDF
runtime on memory grounds now.** The existing profile already owns the large
win, and ImageBitmap has a much smaller integration/trust surface. A vips lane
only becomes rational if pixel-quality or required-format gates defeat
ImageBitmap; it must then use this same disposable-worker/RSS ratchet. jSquash
can still be evaluated independently for build-time Astro publisher assets,
where its value proposition is compressed output rather than PDF runtime
memory.

## Phase 2 — Typst runtime candidate lanes

Built: `bench:runtime-lane` (`atlcli.runtime-lane/1`) — isolated Bun child
processes run the IDENTICAL pipeline (prepare original → serialize →
compile) over the materialized scale-1 image-heavy corpus, one candidate per
child: `baseline` (vendored, patched typst.ts 0.7.0 / Typst 0.14.2) and
`rc8` (published typst.ts 0.8.0-rc3 / Typst 0.15.0-rc.1 via a devDependency
alias — the production vendor pin and CSP patch are untouched). Metrics:
`/usr/bin/time` peak RSS, the WASM linear-memory high-water via the same
register hook the Chrome harness uses, and compile wall time. Bun/JSC host
disclaimer recorded in the report; relative candidate deltas and WASM
high-water are the comparable signals.

| Candidate | peak RSS MiB (median of 3) | WASM high-water MiB | compile ms | PDF bytes | raw WASM |
|---|---|---|---|---|---|
| baseline 0.7.0 / 0.14.2 | 1861.92 (1861.92–1862.45) | 1326.38 | 2679 | 102,083,213 | 27.0 MB |
| rc8 0.8.0-rc3 / 0.15.0-rc.1 | 1874.05 (1870.31–1879.28) | **1325.94** | 2656 | 102,043,785 | 28.8 MB |

Verdict against the plan's adoption gates: **no material image-heavy memory
benefit** — the WASM high-water is identical within 0.5 MiB because decoded
rasters dominate this workload, exactly as the plan predicted ("Krilla
memory work … is not evidence for #118's image-heavy workload"). Peak RSS
and compile time are within noise; the RC's raw WASM is 1.8 MB larger. Per
the gate ("a pinned forward-port only if the RC first proves material
benefit"): **no forward-port and no adoption for memory reasons.** The lane
stays as infrastructure; re-run it on the text-heavy corpus once that recipe
lands (Phase 0 remainder), where Typst 0.15's layout-side work could show a
different profile.

## Phase 0 remainder — corpus recipes, text-heavy lane, tolerances

- **Text-heavy recipe**: the deterministic 500-page `large-export-corpus`
  (headings, tables, code, macros, occasional tiny images) is the plan's
  text-heavy row; `bench:runtime-lane --corpus text-heavy` composes and runs
  it through the identical pipeline.
- **Mixed recipe**: `generateMixedExportCorpus` composes the two proven
  extremes deterministically (50-page text tree interwoven with the
  scale-0.35 image-heavy chapters — repeated logos, screenshots, diagrams,
  wrapped inline media, JPEG photos), with a routing resolver and identity
  string; unit-tested for determinism and full asset resolvability.
- **Documentation scope fix**: `export-performance.md` no longer calls the
  Chromium-hosted 500-page measurement out of scope — it points at the
  attribution harness and runtime lanes that now cover it.

### Runtime lane, text-heavy corpus (the 0.15 question, second half)

| Candidate | peak RSS MiB (median of 3) | WASM high-water MiB | compile ms | PDF bytes |
|---|---|---|---|---|
| baseline 0.7.0 / 0.14.2 | 948.03 | 391.75 | 1358 | 5,176,657 |
| rc8 0.8.0-rc3 / 0.15.0-rc.1 | 874.22 (872.36–884.63) | **336.69** | 1214 | 4,670,358 |

**On the text-heavy corpus the RC shows a real, material benefit: −55.06 MiB
WASM high-water (−14.1%), −73.81 MiB peak RSS (−7.8%), −10.6% compile time,
and a ~10% smaller PDF** — the layout/Krilla-side improvement the plan
predicted for structured documents, absent on image-heavy where decoded
rasters dominate. Consequence per the plan's candidate ladder: the RC now
QUALIFIES for the next evaluation stage (pinned reproducible forward-port to
Typst 0.15.1 plus the adoption gates: CSP patch, vendor hashes, parity and
conformance suites, pathological-layout fixture). Adoption itself remains a
separate, gated decision — this lane only establishes that the evaluation is
worth its cost.

### Reproducibility tolerances observed across this ratchet's repeated runs

- Chrome worker attribution (identical corpus + runtime): byte-identical
  phase values across consecutive runs (0.00 MiB spread observed twice).
- `/usr/bin/time` peak RSS lanes: spread ≤ 0.6% (runtime lane image-heavy
  1861.92–1862.45), ≤ 1.4% (text-heavy 872.36–884.63), ≤ 0.7%
  (copy-probe checkpoint-assets); fake-indexeddb lanes up to ±6% and are
  marked inconclusive where the signal is smaller.
- Compile wall time under concurrent load: up to ±10% — never used as a
  ratchet gate on its own.

## Phase 3 — host wiring (CLI flags, extension UI), live-proven

Wiring: `--pdf-images original|standard|print` + `--pdf-images-ppi <72..1200>`
→ `buildCliPdfJobRequest` → `PdfExportJobRequestV1.options.imageProfile/imagePpi`
(validated, replay-pinned) → executor `imageQuality` → `preparePdfDocument`
normalization. Extension: ExportScreen **Image quality** select + conditional
PPI input → draft context → `ExportScopeRequest` → `createExtensionPdfJobRequest`
options (stray `imagePpi` on `original` is dropped defensively; regression
test in `apps/extension/tests/jobs/pdf-submit.test.ts`).

### Live CLI proof (DOCSY page 1146748946, deleted after the run)

Temporary page under the DOCX fixture tree carrying one deterministic corpus
photo attachment (`photo-20.jpg`, 2400×1792 baseline JPEG, 1,654,348 bytes),
created with `wiki docs push`, exported four ways with a fresh
`ATLCLI_EXPORT_JOBS_DIR`, then deleted (`wiki page delete --confirm`):

| Run | PDF bytes | vs original | `image-profile-applied` |
|---|---|---|---|
| (no flag) original | 1,704,492 | — | absent (correct) |
| `--pdf-images print` (300 PPI → 1958px) | 773,045 | −54.6% | 1 |
| `--pdf-images standard` (180 PPI → 1176px) | 287,059 | −83.2% | 1 |
| `--pdf-images standard --pdf-images-ppi 96` (627px) | 118,845 | −93.0% | 1 |

`pdftotext` finds the page's prose in all four PDFs; `exitCode: 0`,
`complete: true`, `assets: {fetched: 1, embedded: 1}` in every run. Error
paths proven live: `--pdf-images original --pdf-images-ppi 200` → usage error
("original never re-encodes"), `--pdf-images-ppi 5000` → range error,
`--pdf-images-ppi 240` without a profile → usage error.

Second live anchor: real page 1118437396 (existing small attachment) emits
`image-profile-applied: 1` under all three re-encode variants and its
`--pdf-images-ppi 96` output came out ~0.3 KiB *larger* than original —
the expected small-image trade-off (decoded pixel area is the target, not
file bytes), now pinned by a behavior test in
`packages/export-media/src/codec.test.ts`.

### Environment findings hit while proving (pre-existing, not this branch)

- **Journal poisoning**: `~/.atlcli/export-jobs/v1/journal/` records from
  before #106 carry `template.kind`; `FileJobStore.#load()` strict-parses
  every historical request, so one stale record fails *every* new export with
  `request.template.kind: is not part of this contract shape` (exit 4).
  Reproduced identically with all Phase-3 changes stashed; flagged as
  separate work. Live runs here used a fresh `ATLCLI_EXPORT_JOBS_DIR`.
- `wiki docs push` only uploads images referenced as
  `![alt](./<page>.attachments/<file>)`; other relative paths are left as-is
  and the PDF export then 401s trying `<base>/wiki` + `<relative-path>`.

## Typst 0.15.1 production forward-port

The production candidate is now the reproducible fork release
`web-compiler-v0.8.0-rc3.typst0151.1`, built from typst.ts commit
`2ff4a660…` and the patch-equivalent Typst core forward-port `301531fc…`.
The consumed glue and WASM hashes are `54292657…` and `39d2ce3c…`; the old
0.14.2 runtime and RC alias are not shipped as parallel candidates.

| Corpus | 0.14.2 peak RSS / WASM / compile | 0.15.1 peak RSS / WASM / compile | Verdict |
|---|---|---|---|
| image-heavy | 1922.58 / 1326.38 MiB / 2982 ms | 1929.56 / 1326.00 MiB / 3236 ms | pass: +0.36% / -0.03% / +8.52% |
| text-heavy, same-session 7-run pair | 961.25 / 391.75 MiB / 2824 ms | 923.30 / 336.88 MiB / 1729 ms | pass: -3.95% / -14.01% / -38.77% |
| mixed, same-session 7-run pair | 905.39 / 224.81 MiB / 1103 ms | 917.98 / 220.56 MiB / 1089 ms | pass: +1.39% / -1.89% / -1.27% |

The local host's text/mixed `/usr/bin/time` RSS and compile spreads exceeded
the 1.5% controlled-runner target for both baseline and candidate. Those
absolute values are therefore retained as noisy. The paired comparisons still
exclude a regression: the candidate remains inside the 5% RSS/WASM and 10%
compile ratchets in every corpus, and text-heavy WASM high-water is exactly
stable across runs and materially lower.

Source, strict-CSP, browser, packed-consumer, MV3, semantic parity, migration,
and LIVE DOCSY gates passed. Full redacted provenance and per-gate results are
recorded in `specs/typst-0151-runtime-forward-port/`.

typst.ts itself depends on Myriad-specific Typst APIs; compiling directly
against official `typst/typst` 0.15.1 fails at the first missing API,
`Frame::content_hint`. The temporary core pin therefore targets
`BjoernSchotte/typst@301531fc…`. Its exit sequence is: contribute the eight
core patches to `Myriad-Dreamin/typst`, repoint the prepared two-commit
typst.ts integration branch to that merged commit/tag, and only then submit a
typst.ts PR when explicitly authorized. No upstream PR was created here.
