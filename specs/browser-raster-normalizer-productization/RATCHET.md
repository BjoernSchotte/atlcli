# Productive raster normalizer ratchet

Machine-local implementation evidence for
[`PLAN.md`](./PLAN.md). Measurements are comparable only within the same lane
and runtime. The accepted macOS arm64 cells are repo-pinned Playwright
Chromium 140.0.7339.16 / V8 14.0.365.1 and official Chrome for Testing Stable
152.0.7977.64 / V8 15.2.124.18. Required Linux x64 repeated both browser
cells in [CI run 33208063547](https://github.com/BjoernSchotte/atlcli/actions/runs/33208063547).

The neutral scale-1 corpus contains 100.29 MiB of source assets, 76 unique
assets, and 190 placements. Each sample runs the real MV3 harness through PDF
prepare, serialization, IndexedDB, Typst, validation, and a tagged PDF. The
normalizer lane samples the whole Chromium process-tree RSS every 25 ms.

## Pure worker gate

The first productive-worker run was byte-correct and responsive, but failed
the time gate: its two-run median was 48.75 s versus 38.79 s on panel main
(1.257x). The receipt exposed 190 calls for only 76 output assets. The adapter
now has an explicit opt-in for immutable resolver source views and reuses a
result only for the exact same view and target geometry. It still copies every
source sent to the worker, so the caller's bytes remain attached and valid.

The accepted two-run result after that change:

| Metric | Panel-main pure TS | Productive pure worker | Ratio / result |
|---|---:|---:|---:|
| prepare median | 38.66 s | **35.71 s** | **0.924x** |
| normalizer peak RSS delta median | +189.79 MiB | **+160.94 MiB** | **0.848x** |
| whole-Chromium peak median | 1620.19 MiB | **1602.95 MiB** | 0.989x |
| cleanup RSS versus pre-normalizer baseline | n/a | -23.21 MiB | within 32 MiB gate; negative is sampling noise |
| productive host heartbeat p95 | n/a | **2 ms** | below 50 ms gate |
| memoized repeated placements | n/a | **58 per run** | body-free receipt |

Individual normalizer peak deltas were 195.33 and 184.25 MiB on panel main,
versus 144.53 and 177.34 MiB in the productive worker. The ratchet therefore
requires the worker median to remain at most 0.95x the panel median, not merely
to avoid a regression.

Both runs produced the exact same assets and PDF across both execution paths:

- output-asset digest:
  `22686c235cead0a59af89705f970ee8a4b4b326903f801b89179415b728c1044`
- tagged-PDF digest:
  `ad434a3f958d9842ca83752020711fa7d2d5b55d673db1b9c0cbb6e63b830d5b`
- bundle bytes: 17,457,095
- PDF bytes: 16,512,893
- normalized / kept calls: 133 / 57
- worker target: proven gone before Typst starts

Result: the productive pure worker passes its determinism, responsiveness,
lifecycle, time, and RSS gates. ImageBitmap remains a separate candidate and
must pass its own quality and browser matrix before it can replace this
reference path.

Run the gate from the repository root:

```bash
bun run --cwd apps/extension prebench:memory-chrome
node node_modules/@playwright/test/cli.js test \
  --config apps/extension/tests/pdf/memory/playwright.config.ts \
  --grep "productive pure raster worker"
```

## ImageBitmap worker gate

The candidate uses target-sized `createImageBitmap` with explicit orientation,
premultiplication, color-conversion, and `medium` resize quality. `high` was
rejected before rollout because its 1.368x aggregate output-byte ratio failed
the 1.10x gate. The host classifies eligible PNG/JPEG shapes before worker
startup; a typed native failure discards the complete prepare and retries once
through a fresh pure worker.

Both macOS cells passed the same two-run productive ratchet:

| Metric | Chromium 140 | CfT Stable 152 | Gate |
|---|---:|---:|---:|
| ImageBitmap / pure prepare | **0.201x** | **0.260x** | <= 0.60x |
| ImageBitmap / pure normalizer RSS peak | **1.088x** | **0.868x** | <= 1.15x |
| ImageBitmap cleanup residual | **-24.38 MiB** | **11.02 MiB** | <= 32 MiB |
| ImageBitmap / pure Typst peak | **0.987x** | **0.987x** | <= 1.10x |
| ImageBitmap / pure whole-Chrome peak | **1.001x** | **1.007x** | <= 1.10x |
| ImageBitmap / pure normalized asset bytes | **0.946x** | **0.946x** | <= 1.10x |
| ImageBitmap heartbeat p95 | **2.1 ms** | **2.6 ms** | < 50 ms |

The current-Stable absolute medians were 32.151 s versus 8.365 s prepare,
226.78 versus 196.86 MiB normalizer RSS delta, 395.23 versus 389.96 MiB Typst
peak, and 1853.97 versus 1866.39 MiB whole-Chrome peak. Each candidate worker
target disappeared before Typst started, every PDF remained tagged, and the
complete inventory and report semantics remained unchanged.

The required Linux x64 cells also passed:

| Metric | Chromium 140 | CfT Stable 152 | Gate |
|---|---:|---:|---:|
| ImageBitmap / pure prepare, recorded only | 0.208x | 0.262x | local timing gate only |
| ImageBitmap / pure normalizer RSS peak | **1.025x** | **0.552x** | <= 1.15x |
| ImageBitmap cleanup residual | **-67.28 MiB** | **-68.44 MiB** | <= 32 MiB |
| ImageBitmap / pure Typst peak | **0.987x** | **0.987x** | <= 1.10x |
| ImageBitmap / pure whole-Chrome peak | **1.003x** | **1.008x** | <= 1.10x |
| ImageBitmap / pure normalized asset bytes | **0.946x** | **0.946x** | <= 1.10x |

Pinned Linux measured 143.66 versus 147.31 MiB normalizer RSS delta and
1470.41 versus 1474.29 MiB whole-Chrome peak. Current-Stable Linux measured
207.09 versus 114.40 MiB normalizer RSS delta and 1802.58 versus 1817.41 MiB
whole-Chrome peak. Negative cleanup residuals mean the post-termination sample
fell below the pre-normalizer process-tree baseline; they are sampling noise,
not claimed memory savings. Shared-runner prepare and heartbeat timings are
recorded but deliberately not acceptance assertions.

Across both runtimes and both iterations, output stayed deterministic:

- pure output-asset digest:
  `22686c235cead0a59af89705f970ee8a4b4b326903f801b89179415b728c1044`
- ImageBitmap output-asset digest:
  `b53af68b2bc926db97c0857c8a4a504cc801b8ab66d37e86b214dbd0e340f265`
- pure tagged-PDF digest:
  `ad434a3f958d9842ca83752020711fa7d2d5b55d673db1b9c0cbb6e63b830d5b`
- ImageBitmap tagged-PDF digest:
  `d229ced73207533c7cff0191a9884fd9a0c204b10d32d0141ef71f558dc419ef`

## Quality and eligibility gate

The committed neutral corpus has 13 productive inputs covering all admitted
8-bit PNG shapes and sequential JPEG grayscale/subsampling shapes, plus 12
controls for orientation, progressive/CMYK/profiled JPEG, 16-bit/interlaced/
animated PNG, GIF, SVG, and malformed bytes. Unsupported-only work starts no
worker and remains unchanged.

Chromium 140 and CfT Stable 152 produced the same two-run aggregate digests:

- pure: `e7d22397bfab95d172b53918ca92b512c550924108200504569505d4a5612818`
- ImageBitmap:
  `a5429970a39d2a1cd1a44034549a3a9c9fb8e04d4a691239287dc4e554a73b5b`
- candidate bytes: 30,853 versus 29,867 pure bytes, or **1.033x**

Observed maxima were RGB MAE 3.2833, RMSE 18.665, p95 13, alpha MAE 0.055,
alpha max 1, exact alpha-coverage parity, zero transparent-color bleed, and
corner MAE 1.3906. The only greater-than-1.10x per-fixture byte outliers are
named and bounded: `png-rgba-transparent-edge` at 1.379x and
`png-grayscale-alpha` at 1.158x. Reviewed 100% and 400% contact sheets showed
no crop, rotation, blank output, transparency loss, or visible halo.

Run a current CfT binary explicitly without changing the reproducible pinned
default:

```bash
ATLCLI_RASTER_QUALITY_EXECUTABLE_PATH=/path/to/chrome \
  bun run --cwd apps/extension test:raster-quality-chrome
ATLCLI_MEMORY_EXECUTABLE_PATH=/path/to/chrome \
  node --conditions=development node_modules/@playwright/test/cli.js test \
  --config apps/extension/tests/pdf/memory/playwright.config.ts \
  --grep "productive ImageBitmap"
```

Linux x64 repeats quality, determinism, paired RSS, cleanup, and lifecycle in
required CI for pinned Chromium 140 and official current CfT Stable. Both
cells passed on the recorded implementation SHA. Shared runners record but do
not assert prepare/heartbeat latency; the paired memory and output gates remain
fail-closed. The separate current branded-Chrome UI load is a release gate and
is not substituted by command-line extension flags.

## Branded Chrome unpacked-extension gate

On 2026-08-29, the built neutral MV3 quality harness was loaded through the
normal **Extensions -> Load unpacked** UI in the installed branded Google
Chrome 150 on macOS arm64. This proves the user-visible unpacked-extension
installation path; it is not used as a substitute for the current-engine
matrix, which separately passed official Chrome for Testing Stable 152.

The UI-loaded extension completed all 13 supported fixtures and kept all 12
unsupported controls without starting a worker for the unsupported-only run.
Two consecutive runs reproduced the matrix digests above and the 1.033x
candidate/pure aggregate-byte ratio. Both leases reported `released`; the two
supported runs used and disposed their workers, while the unsupported run
reported `workerStarted: false`.

The in-browser numerical gate reproduced RGB MAE 3.2833, RMSE 18.665, p95 13,
alpha MAE 0.055, alpha max 1, and the two already named byte outliers. Manual
review of every source/pure/ImageBitmap triplet at both 100% and 400% showed no
crop, rotation, blank output, transparency loss, visible halo, or other
regression. Only the committed synthetic corpus was displayed; no tenant or
customer data was loaded.

## Packed rollout gate

Implementation SHA `8130ac60` selects `image-bitmap` in the extension's single
compile-time host mode while retaining both the `pure-worker` rollback branch
and the omitted-lease panel-main emergency path. `original` still bypasses the
normalizer entirely.

The final WXT production build passed the output audit with its normative CSP,
static module worker, and complete export runtime intact. The 25-test packed
durable-job suite then passed against that artifact. Its neutral `standard`
PDF case recorded backend `image-bitmap`, one request, one normalized asset,
zero kept assets, a responsive heartbeat, outcome `released`, and no remaining
raster-worker CDP target. The separate built-worker browser suite passed 3/3,
the focused host/protocol/executor set passed 47/47, and the repository
typecheck passed.

The final two-run local repeat after selecting that default used pinned
Chromium 140 and the same 100.29 MiB corpus. Median prepare time fell from
38.317 s to 8.490 s (**0.222x**), normalized asset bytes to **0.946x**, Typst
peak from 395.23 to 389.96 MiB (**0.987x**), and whole-Chrome peak from 1602.10
to 1596.41 MiB (**0.996x**). Normalizer RSS was deliberately treated as a
non-regression result, not a claimed material saving: 153.60 versus 153.09 MiB
(**0.997x**). Cleanup finished 28.87 MiB below the pre-normalizer baseline,
heartbeat p95 was 2.1 ms, the worker target disappeared before Typst, and both
PDFs remained tagged. The final repository gate passed 8,486 tests with 25
declared skips and zero failures, followed by typecheck, complete build, and
the extension output/CSP audit.

Decision: **GO for ImageBitmap as the internal extension default for the
proven eligibility set.** This is a prepare-speed and host-responsiveness win
with paired RSS non-regression; the explicit image profile remains the much
larger whole-export memory lever. Pure TS remains the deterministic whole-
attempt fallback and one-line rollback.
