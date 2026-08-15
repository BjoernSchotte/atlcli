# Headless-Chrome PRE-QUEUE export baseline

This is a **PRE-QUEUE** measurement even when the source commit already
contains queue contracts: the harness deliberately invokes the unchanged
direct TypeScript engine paths (`runExport` for DOCX and `runPdfExport` plus
`BrowserPdfCompiler` for Typst/WASM PDF), with no queue executor in between.

The MV3 test harness executes the same browser-safe DOCX engine and
Typst/WASM PDF compiler used by browser hosts. These direct calls hold input
and output in the extension page and do not create a durable job record, so
both persisted byte fields are honestly `null` with a reason. No synthetic
IndexedDB write is presented as behavior of the current path.

Heap checkpoints are explicitly scoped to the extension page. Dedicated-worker,
offscreen-worker, separately observable WASM-linear-memory, and RSS buckets are
`null` with reasons; the harness does not imply that a page CDP sample covers
those unavailable surfaces.

Every run records the artifact SHA-256 and a bounded, timing-free report
summary plus SHA-256. The generated DOCX/PDF files do not need to be committed
to compare direct-path output and report behavior over time.

The timing phases are shared with the Node runner: engine setup, corpus plus
compose, corpus fingerprinting, engine export, and artifact/report hashing are
separate. `exportMs` therefore excludes setup and hashing. Asset resolvers hand
the engines defensive byte copies, and the page holds the emitted artifact in
module state until the `artifactHeld` heap checkpoint and explicit cleanup.

Run from the repository root:

```bash
bun run bench:export-baseline-chrome --pages 50,500 --formats docx,pdf --repeat 3 --seed 2654435769
```

If Chromium or the host is interrupted after an incremental raw-result write,
rerun the same matrix with `--resume`. Before accepting any result, the harness
starts Chromium to learn the current browser/V8 version and compares a signed
provenance payload: commit, source-only dirty state and tree fingerprint,
explicit harness/fixture digest, browser, OS/release/architecture, and the full
pages/formats/repeat/seed configuration. Every retained result carries that
same fingerprint. Legacy or partially fingerprinted reports are rejected; a
fully resumed report still records the freshly detected browser version.

The result is written to
`specs/export-expansion/013-isomorphic-export-jobs/baselines/chrome-pre-queue.json`.
