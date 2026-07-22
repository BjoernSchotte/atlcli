# PRE-QUEUE export baseline

These files measure the unchanged direct TypeScript engine paths before a
queue executor is inserted:

- DOCX: `runExport`
- PDF: `runPdfExport` with `BrowserPdfCompiler` (Typst/WASM)

The source commit may already contain queue contracts, but no queue, scheduler,
or executor participates in these measurements. The deterministic corpus uses
seed `2654435769`, includes real PNG images and resolved SVG diagram previews,
and is generated at 50 and 500 pages. Each matrix cell has three isolated
repetitions.

## Reproduce

From the repository root, after `bun install`:

```bash
bun run fonts:ensure
bun run bench:export-baseline-node --pages 50,500 --formats docx,pdf --repeat 3 --seed 2654435769
bun run bench:export-baseline-chrome --pages 50,500 --formats docx,pdf --repeat 3 --seed 2654435769
```

The Chrome runner performs a real MV3 build and starts Playwright Chromium in
headless mode. If the host interrupts a matrix after an incremental result was
written, repeat the identical Chrome command with `--resume`. Current runs
probe Chromium before the resume decision and require an exact provenance
fingerprint over commit, source tree, harness/fixture, browser, OS/architecture,
and the complete matrix configuration. Legacy raw reports without that
fingerprint are rejected rather than relabelled as current-environment data.

## Environment

Captured on 2026-07-22 from the PR-A working tree based on commit
`5bc398ffa7cb44d19d14d0607efa322140133302`. The raw environment marks
`workingTreeDirty: true` because the corpus and baseline harness being measured
were the uncommitted PR-A implementation at capture time:

- Apple M5 Max, 18 logical CPUs, 128 GiB RAM, macOS/Darwin 25.4.0 arm64
- Bun 1.3.14
- Playwright 1.55.0, Headless Chrome 140.0.7339.16, V8 14.0.365.1

The complete environment, host checkpoints, timings, report summaries, and
hashes are in [node-pre-queue.json](./node-pre-queue.json) and
[chrome-pre-queue.json](./chrome-pre-queue.json).

## Median direct-engine time

`exportMs` excludes engine setup, corpus generation/composition, corpus
fingerprinting, and artifact/report hashing. All those phases have separate
raw timing fields.

| Shape | Pages | Format | Median `exportMs` | Artifact bytes | Logical input bytes |
|---|---:|---|---:|---:|---:|
| Node/CLI | 50 | DOCX | 171.3 ms | 157,189 | 274,388 |
| Node/CLI | 50 | PDF | 916.4 ms | 561,419 | 274,388 |
| Node/CLI | 500 | DOCX | 284.8 ms | 1,535,755 | 2,749,527 |
| Node/CLI | 500 | PDF | 2,453.8 ms | 5,134,486 | 2,749,527 |
| Extension page | 50 | DOCX | 88.5 ms | 157,189 | 274,388 |
| Extension page | 50 | PDF | 466.1 ms | 561,887 | 274,388 |
| Extension page | 500 | DOCX | 298.7 ms | 1,535,755 | 2,749,527 |
| Extension page | 500 | PDF | 2,995.4 ms | 5,139,189 | 2,749,527 |

## Reading the raw results

- `artifactSha256` hashes the actual emitted bytes. The DOCX ZIP container hash
  can vary across otherwise equivalent repetitions because container metadata
  is not a semantic determinism contract; the raw hashes intentionally expose
  that behavior. PDF bytes were stable in this run.
- `reportSummary` is bounded and timing-free. Its `reportSha256` was stable for
  every page/format/shape cell; note message text and wall-clock timing notes
  are deliberately excluded.
- Asset resolvers return defensive byte copies. Corpus digest and logical input
  size are calculated before engine execution, so an engine cannot mutate the
  recorded baseline identity.
- Both direct paths keep input and output in memory. `persistedInputBytes` and
  `persistedArtifactBytes` are therefore `null`, with reasons, rather than
  synthetic IndexedDB values presented as current behavior.
- Node heap fields are `process.memoryUsage()` checkpoints. Synchronous in-stage
  peaks are not observable and `rssPeakBytes` is `null`.
- Chrome heap fields are explicitly extension-page CDP checkpoints. Dedicated
  worker, offscreen worker, separately observable WASM linear memory, and RSS
  are `null` with reasons. The emitted artifact remains strongly referenced
  until the `artifactHeld` checkpoint and explicit cleanup.
