# Productive raster normalizer ratchet

Machine-local implementation evidence for
[`PLAN.md`](./PLAN.md). Measurements are comparable only within the same lane
and runtime: macOS arm64, repo-pinned Playwright Chromium 140.0.7339.16,
V8 14.0.365.1.

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
