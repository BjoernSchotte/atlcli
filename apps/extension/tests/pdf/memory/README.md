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
