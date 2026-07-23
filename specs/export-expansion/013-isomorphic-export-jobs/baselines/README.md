# Export queue baselines

## PRE-QUEUE direct-engine baseline

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

## POST-QUEUE Node/CLI baseline

[`node-post-queue.json`](./node-post-queue.json) repeats the same
50-/500-page, DOCX/PDF, three-repetition matrix through the productive Node job
boundary. Every cell creates the unresolved file-journal request first, commits
each normalized page to the source spool, checkpoints every asset through the
shared byte-reservation layer, persists the ready-to-render payload, acquires
the shared heavy-render lock, runs the real TypeScript DOCX or Typst/WASM PDF
executor, journals the report/result, and finalizes the file-backed artifact.
The source and assets remain synthetic and deterministic; no tenant/network
latency is included.

Reproduce from the repository root:

```bash
bun run bench:export-jobs-node --pages 50,500 --formats docx,pdf --repeat 3 --seed 2654435769
```

Median measurements from 2026-07-23 on the same Apple M5 Max/Bun 1.3.14 host:

| Pages | Format | PRE direct `exportMs` | POST `jobExecutionMs` | Artifact | Source spool | Asset spool | Prepared spool | Physical state |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 50 | DOCX | 171.3 ms | 816.2 ms | 157,197 B | 128,791 B | 178,938 B | 310,374 B | 1,109,668 B |
| 50 | PDF | 916.4 ms | 1,748.9 ms | 562,835 B | 128,588 B | 179,667 B | 464,113 B | 1,634,740 B |
| 500 | DOCX | 284.8 ms | 19,509.8 ms | 1,535,763 B | 1,297,428 B | 1,790,375 B | 3,088,238 B | 8,258,830 B |
| 500 | PDF | 2,453.8 ms | 14,076.8 ms | 5,144,331 B | 1,295,425 B | 1,797,796 B | 4,577,350 B | 13,362,143 B |

Interpretation:

- POST time deliberately includes durable per-page/source checkpoints,
  content-addressed asset writes, ready-state serialization/materialization,
  journal/event writes, report persistence, artifact finalization, and the
  engine. PRE time includes only the in-memory engine call, so the columns
  quantify queue durability cost rather than an engine regression.
- The 500-page Node result exposes a real latency cost from hundreds of atomic
  file checkpoints (especially DOCX). This is accepted as measured v1 behavior,
  not hidden as noise; a later batching optimization must preserve the current
  crash boundary and publish a new before/after artifact.
- Spool payload growth is approximately linear: the complete 500-page durable
  spool is 6,176,041 B for DOCX and 7,670,571 B for PDF, well below configured
  per-job limits. `physicalStateBytes` additionally includes markers, journal,
  request, report, and the finalized artifact.
- Node heap/RSS values remain checkpoint observations, not synchronous peaks.
  The synthetic corpus stays strongly reachable in both PRE and POST runners,
  so these figures compare orchestration overhead but do not claim that all
  production source bodies remain live. The bounded 4-fetch/8-ready source test
  separately proves the productive issue window.

## POST-QUEUE Chrome/extension baseline

[`chrome-post-queue.json`](./chrome-post-queue.json) runs the same deterministic
matrix in real headless Chromium from a production MV3 build. Each isolated
extension profile creates and claims a real IndexedDB job, commits normalized
source pages and content-addressed assets, persists the ready-to-render payload,
acquires the shared browser render reservation, executes the productive
TypeScript DOCX or Typst/WASM PDF executor, persists the result/report, and
retains the artifact in the common byte store. The source corpus and assets are
synthetic and deterministic; the benchmark issues no tenant request and includes
no authentication or network latency.

Reproduce from the repository root:

```bash
bun run bench:export-jobs-chrome --pages 50,500 --formats docx,pdf --repeat 3 --seed 2654435769
```

Median measurements from 2026-07-23 on the same Apple M5 Max/Bun 1.3.14 host:

| Pages | Format | PRE direct `exportMs` | POST `jobExecutionMs` | Artifact | Source spool | Asset spool | Prepared spool | IndexedDB payload |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 50 | DOCX | 88.5 ms | 244.1 ms | 157,198 B | 128,893 B | 178,968 B | 310,422 B | 777,281 B |
| 50 | PDF | 466.1 ms | 585.6 ms | 562,555 B | 128,690 B | 179,697 B | 464,692 B | 1,336,235 B |
| 500 | DOCX | 298.7 ms | 2,391.0 ms | 1,535,763 B | 1,298,430 B | 1,790,675 B | 3,088,287 B | 7,723,422 B |
| 500 | PDF | 2,995.4 ms | 4,275.2 ms | 5,141,748 B | 1,296,427 B | 1,798,096 B | 4,583,659 B | 12,820,537 B |

Interpretation:

- All 12 matrix cells succeeded. Every run has non-empty source, asset, and
  prepared spools, and its persisted artifact byte count exactly matches the
  catalog artifact record.
- POST time includes the durable IndexedDB pipeline and engine call, but not
  deterministic corpus generation, compiler/font/WASM setup, page load, or
  hashing. Those phases remain separate raw fields.
- Complete spool payload grows approximately linearly: at 500 pages it is
  6,187,659 B for DOCX and 7,678,789 B for PDF. `indexedDbPayloadBytes` also
  includes the finalized artifact.
- `navigator.storage.estimate()` is recorded before and after every isolated
  run. Its origin-level usage is allocator/accounting evidence, not an exact
  sum of logical records; exact byte-store payload totals come from the
  productive IndexedDB rows.
- CDP heap checkpoints observe the extension page that hosts this deterministic
  benchmark. The productive executor/catalog/byte-store code is used, but this
  measurement deliberately rehosts execution in that page so a single stable
  target can be sampled. Offscreen/service-worker lifecycle and recovery are
  proven separately by the packed persistent-profile suite; no offscreen or
  worker heap is inferred here.

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
