# Chrome/V8 PDF memory benchmark

This harness measures the extension PDF byte path in a real Manifest V3
Chromium context. It uses the production serializer, IndexedDB job store,
browser compiler, Typst WASM, PDF validator, byte handle, and PDF.js viewer.
The extension page represents the side-panel renderer; a dedicated worker
represents the offscreen compiler context.

Run it from the repository root:

```bash
bun run bench:memory-chrome
```

The benchmark builds a test-only unpacked extension, launches the repository's
pinned Playwright Chromium, forces garbage collection before retained-heap
samples, and prints one `ATLCLI_CHROME_MEMORY_RESULT` JSON object. The result
contains the exact Chrome and V8 versions so numbers are not quoted without
their runtime.

## Fixture

The fixture is deterministic and contains six chapters plus two 1200 x 1200
high-entropy PNG assets. It is DOCSY-shaped but contains no customer content.
It goes through the real document preparation and compilation pipeline; only
the Confluence network fetch is replaced by the local deterministic source.

## What is measured

- extension-page preparation, metadata-only quota inventory, result read,
  validation, download `Blob`, and PDF.js open;
- compiler-worker bundle read, Typst VFS handoff, compiled-PDF peak, and
  post-completion retention;
- a 16 MiB IndexedDB `Uint8Array` read versus a 16 MiB IndexedDB `Blob` read;
- a real 64 KiB HTTP Range request against the PDF's `blob:` URL;
- the resident PDF.js worker heap after opening that URL.

`Runtime.getHeapUsage` reports V8 heap, embedder heap, and external backing
storage separately. Typed-array bytes generally appear as backing storage, not
as `usedSize`; interpreting `usedSize` alone would therefore be incorrect.

## Host-versus-WASM attribution

The report's `workerAttribution` section is the Phase 0 gate input of
`specs/issue-118-adaptive-browser-pdf-memory/PLAN.md`: it splits the compiler
worker's footprint per phase into Typst WASM linear memory versus host bytes.

The Typst `WebAssembly.Memory` is handed to the worker through a
benchmark-only `Symbol.for` hook
(`atlcli.pdf-compiler-browser.memory-probe.register-wasm-memory`) that
`BrowserPdfCompiler` invokes during initialization; production hosts never
install it. Because WASM linear memory can only grow, the byte length read
after compilation is its high-water mark, and the harness asserts monotonic
growth as a measurement-integrity check.

Whether `backingStorageSize` includes the WASM memory is *detected* from the
samples and reported as `basis` (`backing-includes-wasm`,
`backing-excludes-wasm`, or `wasm-unavailable`) rather than assumed, so a
runtime change alters the report instead of silently mis-attributing. The
attribution math lives in `attribution.ts` (pure, unit-tested in
`attribution.test.ts`); the shares reported at the peak phase are what the
lease-pipeline go/no-go decision consumes.

Chrome does not expose internal `blob:` reads as `Network.*` events on this
worker target. The report keeps those event arrays for transparency and uses
the direct Range response plus the PDF.js worker's resident backing storage to
decide whether the viewer actually avoids whole-document retention.

This is a benchmark and an architecture gate, not a stable performance budget:
absolute figures can move with Chrome, V8, Typst, PDF.js, fonts, and the host
platform. The structural assertions intentionally check only the conclusions
the design relies on.

## Raster normalizer paths 1–4

The `ratchets raster-normalizer paths 1-4` test compares the current panel-main
pure-TS normalizer with disposable-worker WebCodecs, target-sized ImageBitmap,
and Pica 10 lanes. Every lane uses the same full image-heavy corpus, target
planner, pinned encoder, job store, compiler, and PDF validator. Candidate
workers pause on one PNG and one JPEG at source/decoded/target/encoded holds,
then must disappear before Typst starts.

The test samples the whole Chromium process-tree RSS every 25 ms in addition
to CDP heap data. That is essential: browser-native decode surfaces do not
appear in V8 backing storage and WebCodecs can otherwise look artificially
cheap. Results print as `ATLCLI_RASTER_NORMALIZER_RATCHET_RESULT`; the reviewed
host-local interpretation is recorded in
`specs/issue-118-adaptive-browser-pdf-memory/RATCHET.md`.

Run just this ratchet after building the harness:

```bash
bun run --cwd apps/extension prebench:memory-chrome
node node_modules/@playwright/test/cli.js test \
  --config apps/extension/tests/pdf/memory/playwright.config.ts \
  --grep "ratchets raster-normalizer paths 1-4"
```

For diagnosis, select one lane with `ATLCLI_RASTER_VARIANT=pure-ts`,
`webcodecs`, `image-bitmap`, or `pica`. The default remains the repo-pinned
Playwright Chromium because current branded Chrome ignores command-line
unpacked-extension loading. `ATLCLI_MEMORY_BROWSER_CHANNEL=chrome` is an
explicit compatibility probe, not the reproducible performance lane.

## Productive pure-worker ratchet

The required productization gate uses the real production host adapter and
worker rather than the dated four-lane benchmark worker. It runs panel-main
and productive pure-worker paths twice, compares output-asset and tagged-PDF
digests, samples process-tree RSS at 25 ms, checks the body-free heartbeat
receipt, and proves the worker target is gone before Typst starts:

```bash
bun run --cwd apps/extension prebench:memory-chrome
node node_modules/@playwright/test/cli.js test \
  --config apps/extension/tests/pdf/memory/playwright.config.ts \
  --grep "productive pure raster worker"
```

The accepted machine-local evidence and exact runtime are recorded in
`specs/browser-raster-normalizer-productization/RATCHET.md`. Pica and
WebCodecs remain historical evidence lanes and are not part of this required
product gate.

## Productive ImageBitmap default ratchet and browser matrix

The productive extension default is compared directly with its pure-worker
fallback, twice per runtime. It preserves the complete tagged-PDF pipeline while
asserting output stability, worker termination before Typst, paired
process-tree RSS, cleanup, Typst peak, whole-Chrome peak, asset bytes, and the
body-free productive receipt:

```bash
bun run --cwd apps/extension prebench:memory-chrome
node --conditions=development node_modules/@playwright/test/cli.js test \
  --config apps/extension/tests/pdf/memory/playwright.config.ts \
  --grep "productive ImageBitmap"
```

The default remains pinned Chromium. To repeat the same gate with an official
Chrome for Testing binary, pass its executable explicitly:

```bash
ATLCLI_MEMORY_EXECUTABLE_PATH=/path/to/chrome \
  node --conditions=development node_modules/@playwright/test/cli.js test \
  --config apps/extension/tests/pdf/memory/playwright.config.ts \
  --grep "productive ImageBitmap"
```

Required Linux CI runs pinned Chromium and current official Chrome for Testing
Stable. It preserves the paired memory, cleanup, determinism, and lifecycle
assertions but sets `ATLCLI_PRODUCTIVE_RASTER_ASSERT_TIMING=0`: shared runners
record prepare and heartbeat timing without treating noisy host latency as a
product regression. Local and homelab runs retain the timing gates by default.
Set `ATLCLI_MEMORY_OUTPUT_DIR` when a caller needs the attached JSON report in
a durable artifact directory.
