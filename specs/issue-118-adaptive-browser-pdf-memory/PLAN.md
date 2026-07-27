# Issue #118: Adaptive browser PDF memory

- Status: Proposed for review
- Issue: [#118](https://github.com/BjoernSchotte/atlcli/issues/118)
- Related: [#119](https://github.com/BjoernSchotte/atlcli/issues/119), [#116](https://github.com/BjoernSchotte/atlcli/issues/116), [#117](https://github.com/BjoernSchotte/atlcli/pull/117)
- Planning baseline: `b0630fd185dba7f06b023f83bff277034d10ef50` (`main`, 2026-07-27)

## Decision summary

Implement #118 as a host-neutral, additive PDF pipeline with two independent
controls:

- `PdfResourceMode = "auto" | "fast" | "balanced"` controls ownership,
  spooling, copies, and compiler handoff.
- `PdfImageProfile = "original" | "standard" | "print"` controls optional,
  deterministic image normalization.

This separation is normative. Selecting a lower-memory transport must never
silently reduce image quality. Existing callers that pass neither option keep
the current `fast + original` behavior.

The first implementation target is a versioned descriptor/lease path that
avoids materializing all source assets in host memory at once. Typst still needs
each individual asset as complete bytes in its VFS, and still produces a
complete PDF. This plan therefore promises fewer redundant representations and
bounded host-side handoff, not streaming Typst compilation.

The work is shared by:

- durable CLI exports and direct Node consumers;
- extension preview and durable extension jobs;
- normal browser consumers and the browser export harness;
- the downstream Forge adapter in `kiteweave-forge-app`.

Forge APIs and lifecycle rules stay outside shared packages. Issue #119 may
reuse the image and spool contracts, but DOCX packaging is not implemented as
part of #118.

Typst is not upgraded merely to change a version number. The planning baseline
uses the current stable typst.ts wrapper `0.7.0`, which embeds Typst `0.14.2`.
Typst itself has since released
[`0.15.1`](https://typst.app/docs/changelog/0.15.1/); typst.ts
[`0.8.0-rc3`](https://github.com/Myriad-Dreamin/typst.ts/releases/tag/v0.8.0-rc3)
is a prerelease on Typst `0.15.0-rc.1`. The RC, a narrower `web,pdf` build, a
reproducible forward-port to Typst `0.15.1`, and an instrumented memory-mode
build are separate measured candidates. Only a candidate that passes the gates
in this plan may replace the pinned runtime.

## Why this is needed

Issue #116/#117 reduced Confluence acquisition work. Issue #118 starts after
that boundary: prepared media, host copies, Typst VFS population, layout,
Krilla PDF production, JS ownership, and artifact persistence.

The current code carries several complete representations:

1. `packages/pdf/src/prepare.ts` collects `PreparedPdfAsset.bytes`.
2. `PdfSourceBundle.assets` exposes complete `Uint8Array`s.
3. durable job stores persist the arrays but materialize every blob again before
   rendering.
4. browser worker clients copy source arrays before transfer.
5. `BrowserPdfCompiler` maps every asset eagerly into Typst's shadow VFS.
6. workers currently copy the complete compiled PDF before returning it.
7. the result is read again as a complete `Uint8Array` for hashing and artifact
   output.

The existing 500-page engine fixture is useful for throughput but not a
realistic image-memory proof: it places a small `64 x 48` PNG only every 25
pages. Its documented PDF phase nevertheless reaches roughly 3.0–3.4 GB RSS
outside the browser for a 16–17 MB result. A Chrome trace of the existing
8.33 MiB prepared bundle observed:

- 25.06 MiB backing after VFS population;
- 88.36 MiB while the complete compiled PDF was held;
- only 16.61 MiB released after result handoff.

These measurements locate the problem, but they are not the acceptance corpus.
Phase 0 replaces them with deterministic text, mixed, and realistic
image-heavy browser fixtures.

## Goals

1. Preserve the current fast path for small jobs.
2. Add a balanced path that does not hold every source asset in host memory
   simultaneously.
3. Make any image normalization explicit, deterministic, and shared across
   hosts.
4. Select `auto` from measured input and host capabilities, not page count
   alone.
5. Preserve PDF semantics, accessibility, diagnostics, determinism, and
   cancellation.
6. Give CLI, extension, ordinary browsers, and Forge the same engine contract
   while keeping their lifecycle and storage adapters separate.
7. Measure Typst/runtime candidates independently from pipeline changes.
8. Leave reusable spool and image-profile primitives for #119 without coupling
   the PDF and DOCX implementations.

## Non-goals

- splitting a logical export into chapter PDFs and merging them;
- calling Typst incremental preview a streaming PDF implementation;
- changing document layout, tags, outline, links, language, or alt text to save
  memory;
- silently applying `standard` or `print` under `auto`;
- committing customer documents or customer-derived media as fixtures;
- making OPFS mandatory;
- introducing Forge APIs into atlcli packages;
- raising the Forge spike's current attachment/session limits to make the
  benchmark pass;
- forking Krilla before pipeline and Typst measurements justify it;
- implementing #119's streaming OPC/ZIP writer.

## Required invariants

### Compatibility

- Missing options mean `fast + original`.
- `fast + original` remains byte-identical for the existing deterministic
  fixtures.
- The current `PdfSourceBundle` and `PdfCompilePort.compile()` remain supported.
- Existing V1 pending job checkpoints remain readable and resume through the
  eager path. They are not rewritten in place.
- External compile-port implementations do not need to implement leases.

### Quality

- `auto` chooses a resource mode only.
- `original` never resamples a raster image.
- `standard` and `print` never upscale.
- JPEG remains JPEG when possible; transparency remains lossless; SVG and other
  vector sources remain vector.
- One content hash maps to one normalized result for a given versioned profile.
- Normalization may change image streams, but not page geometry or semantics.

### Ownership

- Every opened lease is released exactly once on success, failure, abort, or
  worker termination.
- Once ownership is handed to a spool or worker, the previous owner does not
  retain an avoidable copy.
- Balanced mode may materialize one complete individual asset because Typst's
  current `World.file()`/VFS boundary requires it. It must not materialize the
  entire asset set in the host at once.
- Cleanup is idempotent and covers prepared input, normalized derivatives,
  compiler state, output handles, and host object URLs.

### Truthful claims

- Gzip/Brotli size is reported as transfer/archive size, not runtime memory.
- A smaller WASM binary is not accepted as a memory improvement without runtime
  measurements.
- An output handle is not described as streaming unless PDF bytes are actually
  produced incrementally.
- Numeric peak targets are proven in the neutral Chrome harness. Cross-origin
  Forge iframe observations are lifecycle evidence, not a stable heap metric.

## Target architecture

```mermaid
flowchart LR
  A["ADF / blocks / template"] --> P["PDF preparation"]
  P --> M["Asset manifest + render envelopes"]
  M --> S{"Resource selector"}
  S -->|"fast"| E["V1 eager bundle"]
  S -->|"balanced"| N["Normalize one asset at a time"]
  N --> H["Host spool"]
  H --> L["V2 descriptors + leases"]
  E --> C["BrowserPdfCompiler"]
  L --> C
  C --> O["Owned PDF result or measured output handle"]
  O --> W["Host artifact sink"]

  X["CLI file spool"] --> H
  Y["Extension IndexedDB"] --> H
  Z["Browser IndexedDB / optional OPFS"] --> H
  F["Forge session adapter / eager fallback"] --> H
```

Shared packages own document preparation, selection, profiles, descriptors,
lease semantics, compiler behavior, diagnostics, and reports. Hosts own storage
implementation, capability detection, worker lifecycle, UI, downloads, and
recovery.

## Public and internal contracts

Names below are the intended shape. Exact file placement may change during the
contract implementation, but the semantic split must not.

```ts
export type PdfResourceMode = "auto" | "fast" | "balanced";
export type ResolvedPdfResourceMode = "fast" | "balanced";
export type PdfImageProfile = "original" | "standard" | "print";

export interface PdfResourcePolicyV1 {
  mode: PdfResourceMode;
  imageProfile: PdfImageProfile;
}

export interface PdfAssetDescriptorV2 {
  id: string;
  ref: string;                 // opaque to shared PDF code
  logicalPath: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  sourcePixels?: { width: number; height: number };
  renderEnvelope?: { widthPt: number; heightPt: number };
  profile: PdfImageProfile;
}

export interface PdfAssetLease {
  readonly descriptor: PdfAssetDescriptorV2;
  read(): AsyncIterable<Uint8Array>;
  release(): Promise<void>;
}

export interface PdfAssetLeaseReader {
  open(descriptor: PdfAssetDescriptorV2): Promise<PdfAssetLease>;
}

export interface PdfPreparedAssetSinkV2 {
  put(
    metadata: Omit<PdfAssetDescriptorV2, "ref" | "byteLength" | "sha256">,
    bytes: AsyncIterable<Uint8Array>,
  ): Promise<PdfAssetDescriptorV2>;
}

export interface PdfLeasedSourceBundleV2 {
  version: 2;
  main: PdfAssetDescriptorV2;
  template: PdfAssetDescriptorV2;
  assets: readonly PdfAssetDescriptorV2[];
}
```

Add an optional leased capability instead of widening the current method into a
breaking union:

```ts
export interface PdfCompilePort {
  compile(bundle: PdfSourceBundle, context?: PdfCompileContext):
    Promise<PdfCompileResult>;
  compileLeased?(
    bundle: PdfLeasedSourceBundleV2,
    reader: PdfAssetLeaseReader,
    context?: PdfCompileContext,
  ): Promise<PdfCompileResult>;
}
```

The executor resolves the request as follows:

1. explicit `fast` always uses `compile()`;
2. explicit `balanced` requires a spool and `compileLeased()`, otherwise it
   fails before acquisition with an actionable capability error;
3. `auto` uses the versioned selector; if balanced capabilities are unavailable,
   it falls back to fast and reports the reason;
4. the resolved mode, selector version, input summary, image profile, and
   compiler identity are persisted in the checkpoint and final report so a
   retry cannot silently choose a different path.

Do not expose host filesystem paths, IndexedDB keys, Forge URLs, or raw
filenames through descriptors or diagnostics.

## Adaptive selection

The selector receives a privacy-safe `PdfResourceEstimateV1`:

- serialized main/template byte count;
- asset count, aggregate bytes, largest asset, and deduplicated bytes;
- media types;
- raster width/height, pixel count, transparency, and orientation;
- maximum render envelope across all uses;
- repeat count;
- expected output/page estimate when available;
- host capabilities and storage budget.

Page count alone is insufficient. The selector is a pure, versioned function
with table-driven tests. Thresholds are not hard-coded until Phase 0 produces
the three benchmark curves.

`auto` initially ships report-only: it records the mode it would choose while
executing `fast`. It becomes active for a first-party host only after:

- that host's balanced path passes lifecycle and parity tests;
- the selector has no regression on the small corpus;
- the image-heavy corpus reaches the required reduction;
- the selector thresholds and version are documented.

External consumers must opt into active `auto` until the public contract is
declared stable.

## Image profiles and normalization

Introduce a small format-neutral media package, provisionally
`@atlcli/export-media`, rather than placing shared raster policy in
`@atlcli/pdf`, `@atlcli/confluence`, or a host package. It owns:

- header-only image metadata inspection;
- render-envelope and scale planning;
- content-hash deduplication;
- profile/version definitions;
- a deterministic normalizer port and diagnostics;
- decompression-bomb and pixel-budget checks.

The package is deliberately independent of PDF and DOCX so #119 can consume the
same normalized derivatives.

### Render envelope

Serialization records the largest rendered size of every raster asset across
all uses, in points. For widths that depend on later layout, use a conservative
usable-page-width upper bound. Do not present that upper bound as exact
post-layout measurement.

The target raster size is:

```text
ceil(rendered inches * profile PPI), capped at source pixels
```

Candidate ranges for Phase 0 are:

- `standard`: benchmark 160–200 PPI;
- `print`: benchmark around 300 PPI.

The final value is a measured decision, not a planning assertion.

### Processing rules

- inspect and plan without decoding;
- decode at most one large raster at a time;
- normalize, hash, and spool immediately;
- drop decoder/source buffers before opening the next asset;
- deduplicate source and derivative by deterministic key;
- preserve EXIF orientation in visible output but strip unrelated metadata;
- retain JPEG encoding for photographic JPEG input where the selected codec
  permits it;
- preserve alpha without flattening;
- leave SVG, Mermaid-rendered SVG, and other vector content untouched;
- emit aggregate diagnostics only: counts, bytes, dimensions, selected profile,
  and reasons. Never emit media bytes or customer names.

Run a Phase 1 codec bakeoff before choosing the implementation. The normative
codec must be pinned, deterministic, browser-safe, available to compiled Bun
CLI, extension, normal browser, and Forge, and compatible with their CSPs.
Host-specific Canvas output is not the canonical path if it breaks byte parity.

## Leased compiler handoff

Balanced preparation writes through `PdfPreparedAssetSinkV2` while assets are
resolved and normalized. It does not first construct
`PreparedPdfExportV1.assets[]` and spool that complete array afterward. The sink
computes byte length and digest incrementally, commits the object, returns its
descriptor, and lets preparation release the source buffer. A byte semaphore
may allow bounded fetch overlap, but large decode/normalize work remains
single-slot.

`BrowserPdfCompiler.compileLeased()` performs:

1. reset the Typst shadow state;
2. open, verify, map, and release main source;
3. open, verify, map, and release template source;
4. for each asset in the manifest's canonical V1-equivalent order:
   - open its lease;
   - collect only that asset's chunks;
   - verify declared length and SHA-256;
   - call `map_shadow`;
   - release the lease and drop the host buffer;
5. compile the complete document;
6. collect diagnostics and the complete PDF result;
7. reset compiler shadow state and release all remaining leases in `finally`.

This removes simultaneous host materialization and avoidable pre-worker copies.
It does not remove Typst's internal copy of mapped assets. Measure VFS
high-water separately so reports do not conflate host and WASM memory.

The compiler checks abort state between lease reads and VFS mappings. Once the
current synchronous Typst compile has started, hard cancellation still requires
termination of its dedicated worker; passing an `AbortSignal` alone cannot
interrupt layout/PDF generation.

A secondary Phase 2 experiment may evaluate typst.ts
`set_access_model(...)` with worker-owned OPFS/synchronous handles. It is adopted
only if it reduces copies without changing diagnostics, determinism, or host
support. It must not become a required Forge capability and must not be called
PDF streaming.

## Checkpoint and artifact changes

Add `PdfReadyToRenderCheckpointV2` in `@atlcli/export-wiring`:

- V2 manifest with separate main, template, and asset descriptors;
- resolved policy and selector version;
- compiler/font/profile identities;
- input fingerprint computed incrementally while spooling;
- ownership state sufficient for idempotent cleanup and retry.

Change executor stores so V2 materialization loads the manifest, not every blob.
The lease reader opens one spool object on demand. V1 remains readable through
its current array hydration path.

The existing artifact interface already accepts `AsyncIterable<Uint8Array>`.
Use that capacity when the host has chunks; do not concatenate merely to satisfy
the sink. Hash output incrementally. Keep the existing one-artifact cardinality.

The current compiler returns `Uint8Array`. Phase 4 may add an owned output
handle or chunk reader only if Phase 0 shows the JS/worker result copy accounts
for at least 10% of peak. First remove unconditional worker-side `slice()`
copies and test transferable ownership. A WASM-resident reader remains
experimental; the underlying PDF is still complete.

## Shape-specific implementation

### CLI and direct Node consumers

There are two related execution shapes and both must be covered:

- Normal CLI export plus retry/rerun use the durable ordinary-job path. They use
  the existing `FileExportSpoolStore` and V2 descriptors without rehydrating
  every blob.
- Public `@atlcli/export-node` consumers may call `runPdfExport` directly. They
  keep the eager compatibility path and may supply a file spool for
  explicit/selected balanced mode.

Add options, names subject to CLI review:

```text
--pdf-memory auto|fast|balanced
--pdf-images original|standard|print
```

Persist them in job requests, idempotency input, checkpoints, JSON reports, and
human diagnostics. The compiled Bun artifact must contain or lazily load the
same pinned normalizer used by browsers. Temporary files are private,
collision-safe, cancellation-aware, and deleted after success/failure.

### Browser extension

Treat preview and durable export differently:

- Preview remains `fast + original` by default for latency and supersession.
  It may expose explicit profiles later, but #118 must not make preview queue
  behind a durable balanced export unexpectedly.
- Durable jobs store V2 descriptors in IndexedDB and read asset blobs inside
  the offscreen/compiler worker. Source bytes never travel in runtime messages.
- Productive common jobs must bypass the second legacy PDF job/IDB bridge; do
  not persist a V2 checkpoint, rehydrate it, and then persist the complete
  bundle again. Keep that bridge only as a temporary compatibility path for
  callers that still require V1. Its current 64 MiB per-job limit is not raised
  to make V2 benchmarks pass.
- Preserve the existing service-worker restart model, single-heavy-work slot,
  quota checks, cancellation, and job recovery.
- Avoid the current pattern of collecting all stored blobs before
  `rehydratePreparedPdfExportV1`.
- Termination, abort, or quota failure removes partial derivatives and releases
  object URLs/output handles.

Validate the packed MV3 extension, not just the Vite harness.

### Normal browser and public package consumers

The browser export harness is the normative quantitative proof host. Implement
a browser spool adapter with IndexedDB as the portable baseline and OPFS as an
optional measured capability. Provide an in-memory eager fallback for small jobs
and browsers lacking persistent storage.

The public browser entry points expose the additive policy/capability types
without extension imports. A plain Vite consumer must be able to:

- run fast and balanced modes;
- cancel during normalize, spool, VFS handoff, layout, and output;
- recover from a terminated worker;
- load WASM/fonts/codec from same-origin assets under a strict CSP;
- receive one artifact without a host-specific global.

### Atlassian Forge downstream

The Forge app remains a consumer repo, not an atlcli runtime branch.

Current facts that constrain the rollout:

- the implemented Forge export is page-only; tree/batch/queue are preview
  shapes;
- its attachment adapter currently caches full bytes and returns copies;
- its PDF worker copies source assets and the final PDF;
- PDF workers live only as long as the Custom UI iframe;
- OPFS and a stable cross-origin frame heap metric are not assumed;
- the current spike limits a single attachment to 16 MiB and a session to
  32 MiB.

The atlcli PR provides the contracts and neutral browser implementation. A
separate pinned consumer PR in `kiteweave-forge-app` then:

- chooses an ephemeral session spool when supported, otherwise fast fallback;
- removes redundant pre/post-worker copies;
- leaves attachment/session budgets unchanged unless a separate measured
  decision changes them;
- loads PDF runtime assets only after PDF intent;
- terminates on cancel/timeout/unmount and ignores late results;
- recreates a clean worker for the next export;
- verifies same-origin resources, CSP, no external requests, and gzip byte
  parity with the pinned atlcli artifact.

Do not claim the 100 MiB tree benchmark as Forge E2E until Forge has an actual
tree/job implementation. For the present spike, production gates are
responsiveness, cancellation, cleanup, fresh-worker recovery, PDF parity, and
resource/CSP integrity.

The downstream verification must reconcile its proof documents before citing a
deployment: `specs/SPIKE.md` and `proof/README.md` currently describe different
Forge/atlcli baselines.

## Typst/runtime evaluation

### Baseline

Record and reproduce:

- typst.ts wrapper version;
- embedded Typst core version;
- source commit and Cargo feature set;
- Rust, wasm-bindgen, and Binaryen versions;
- CSP patch identity;
- raw/gzip/Brotli sizes and section breakdown;
- WASM and JS glue SHA-256;
- fonts and licenses.

The current vendored WASM is roughly 27 MiB raw and contains no debug/name
sections. Historical `wasm-opt -Oz --converge` reduced it by only about 3%;
post-link optimization alone is not the expected solution.

Typst 0.15 is still worth measuring: its newer Krilla line contains upstream
memory work such as
[Krilla #363](https://github.com/LaurenzV/krilla/pull/363), and can reduce peaks
for some highly structured documents. That is not evidence for #118's
image-heavy workload. The current Typst PDF API and Krilla finish boundary
still return a complete byte vector, and decoded raster and alpha data can
remain fully resident.

### Candidate lanes

Evaluate the same corpus against separately attributable candidates:

1. published baseline: typst.ts `0.7.0` / Typst `0.14.2`;
2. published prerelease: typst.ts `0.8.0-rc3` / Typst `0.15.0-rc.1`, with its
   upstream feature set unchanged;
3. reproducible same-source `web,pdf` build with size-oriented Cargo settings;
4. a newer stable wrapper/core if one exists when implementation begins;
5. otherwise a pinned, reproducible Typst `0.15.1` forward-port only if the RC
   first proves material benefit;
6. an instrumented custom memory-mode build after Phases 0–2.

Do not combine a pipeline change and a runtime upgrade in the same benchmark
commit.

### Adoption gates

A published upgrade must preserve the public `./wasm` subpath, CSP patch,
licenses/notices, deterministic vendor hashes, browser/CLI parity, diagnostics,
and all PDF conformance tests. A 0.15 candidate also gets a pathological layout
convergence fixture because its diagnostics can retain additional document
history when layout does not converge.

Replace the extension's current 20 MB minimum-WASM scanner invariant if a
narrower build is selected. Provenance hash, required exports, and a maximum
regression budget are meaningful; rejecting a safely smaller compiler is not.

A custom memory mode is accepted only if it:

- lowers peak by at least 25% on text-heavy and mixed fixtures;
- is not Pareto-dominated on wall time and binary size;
- preserves page count, layout, tags, outline, language, links, fonts,
  diagnostics, and deterministic output;
- has a maintainable upstream-first patch boundary.

Only after that evidence should work investigate bounding/sequentializing
layout or page-run intermediates. Do not fork Krilla as the first move.

## Benchmark and measurement plan

Generate fixtures deterministically at test time; do not commit a 100 MiB blob.
Each recipe has a version, seed, expected hash, and media manifest.

The current product budget is 50 MiB aggregate and 25 MiB per asset. Phase 0
uses an explicit benchmark-only budget injection for the at-least-100-MiB
corpus. Product defaults and Forge's stricter limits remain unchanged; benchmark
configuration must never leak into release configuration.

| Corpus | Required content | Purpose |
|---|---|---|
| text-heavy | approximately 500 pages, headings, tables, code, links, outlines | layout/Typst high-water |
| mixed | representative chapters, repeated logos, diagrams/SVG, screenshots, captions, wrapped media, JPEG photos | normal export crossover |
| image-heavy | at least 100 MiB aggregate realistic compressed PNG/JPEG, transparency, repeats, inline and full-width media | asset copies, normalization, VFS pressure |

Record cold and warm runs separately. Pin browser, OS/architecture, fixture,
compiler, fonts, profile, selector, and runtime hashes.

Instrument phase boundaries:

1. acquisition complete;
2. metadata/render-envelope planning;
3. normalization;
4. fingerprint and spool;
5. checkpoint materialization;
6. VFS mapping;
7. Typst layout;
8. PDF/Krilla result;
9. worker-to-host handoff;
10. artifact hashing/write;
11. cleanup and warm-runtime remainder.

Collect:

- Chrome CDP used JS heap and backing store;
- WASM linear-memory high-water;
- host spool bytes and maximum simultaneously leased bytes;
- wall and CPU time by phase;
- source, normalized, PDF, raw WASM, gzip, and Brotli bytes;
- count of copies/transfers where instrumentable;
- result after explicit cleanup and after worker termination.

The harness must separate same-input warm reuse from changed-input runs.
Warm-runtime retention is reported, not mistaken for an active-job leak.

## Acceptance criteria

### Functional and parity

- `fast + original` is byte-identical to the baseline fixtures.
- `balanced + original` is byte-identical to fast for the same pinned runtime.
- `standard` and `print` are byte-deterministic across repeated runs and across
  first-party hosts using the same runtime/codec.
- All modes preserve page count, geometry, tags, reading order, outline,
  language, links/targets, embedded fonts, alt text, diagnostics, and
  cancellation.
- Validate PNG alpha, JPEG photos, SVG, Mermaid, code, tables, repeated images,
  captions, wrapped media, and missing/invalid media.
- Result PDFs open without repair and pass the existing structural,
  accessibility, and visual comparison suites.

### Memory and performance

- No balanced checkpoint materialization loads the full asset set.
- At most one unbounded individual source/derivative buffer is leased outside
  Typst at a time; declared asset/pixel budgets still apply.
- On the image-heavy corpus, the mode selected for first-party `auto` lowers
  browser peak by at least 40% relative to fast. If it does not, `auto` must not
  select it.
- Small fast-path exports do not regress beyond the benchmark tolerance agreed
  in Phase 0.
- A Typst custom memory mode needs at least 25% lower peak on text-heavy and
  mixed fixtures.
- An output-handle implementation is pursued only if whole-result handoff is at
  least 10% of measured peak.

### Lifecycle

- Abort at every phase releases leases and partial spool objects.
- Retry uses the persisted resolved policy and produces the same artifact.
- Extension service-worker restart resumes a durable V2 job.
- Worker crash produces a classified failure and a fresh next worker.
- Quota/capability failure occurs before expensive compilation where possible
  and has an actionable fallback.
- No complete asset or PDF byte arrays are posted through extension runtime
  messages.

### Security and privacy

- Verify magic bytes, declared media type, length, digest, dimensions, total
  pixels, and decode budget before compiler mapping.
- Reject decompression bombs and corrupted/truncated spool objects.
- Do not log source text, filenames, URLs, media bytes, tenant identifiers, or
  raw descriptors.
- Runtime, fonts, and codec load locally/same-origin; no new remote code path.
- Vendored runtime/codec changes include hashes, license/NOTICE, provenance, and
  CSP review.

## Test plan

### Unit

- pure selector thresholds, capabilities, fallback, and persisted decisions;
- image metadata, render envelopes, no-upscale math, alpha/orientation, and
  deduplication;
- normalization determinism and privacy-safe diagnostics;
- lease open/read/release exactly once;
- abort/failure/corruption/digest mismatch;
- V1 and V2 checkpoint compatibility;
- incremental fingerprint and output hash parity;
- spool quota and cleanup.

### Package integration

- `@atlcli/pdf` fast/balanced parity with real fixtures;
- real `BrowserPdfCompiler.compileLeased()` with pinned WASM/fonts;
- `@atlcli/export-wiring` V2 prepare, commit, resume, render, retry;
- Node file spool and browser IndexedDB spool contract suites;
- artifact chunk handling without concatenation;
- real PDF conformance and accessibility inspection.

### Shape integration

- CLI durable export/retry plus direct Node consumer, including compiled CLI
  `dist` binary;
- browser harness fast/balanced/profile/cancel/worker-restart cases;
- packed MV3 extension with IndexedDB, offscreen document, service-worker
  restart, quota, cancel, and preview non-regression;
- a plain public Vite consumer under strict CSP;
- downstream Forge production build/deploy without tunnel after pinning the
  candidate.

### Required commands and evidence

During implementation, use focused tests first, then:

```bash
bun run typecheck
bun run test
bun run build
```

Also run the browser memory harness, API/export validation, package-consumer
builds, extension pack/output scans, and the repository-required real E2E
against profile `mayflower`, space `DOCSY`, and project `ATLCLI`. Clean up every
created test page/issue. A green unit suite is not sufficient for a production
memory claim.

## Delivery phases

### Phase 0 — benchmark before behavior

1. Add deterministic fixture generators and manifests.
2. Add phase probes, CDP collection, WASM high-water, and report schema.
3. Reproduce the pinned baseline in cold/warm runs.
4. Record the selector candidate curves and tolerances.
5. Fix documentation that currently treats the full browser 500-page run as
   out of scope.

Exit: committed benchmark reports can distinguish preparation, host copies,
VFS, layout/PDF, result handoff, and retained warm runtime.

### Phase 1 — shared profiles and codec decision

1. Add `@atlcli/export-media` contracts and pure planning.
2. Propagate render envelopes from serialization.
3. Bake off deterministic codecs across Bun and browsers.
4. Implement one-at-a-time normalize/hash/spool.
5. Add `original`, candidate `standard`, and `print` tests.

Exit: explicit profiles are deterministic and parity-tested; exact PPI values
are chosen from evidence.

### Phase 2 — descriptor/lease pipeline

1. Add public additive policy, descriptor, lease, and compiler contracts.
2. Add `PdfReadyToRenderCheckpointV2`.
3. Change V2 stores to materialize manifests only.
4. Implement `compileLeased()` and incremental verification.
5. Hash/write artifact chunks without whole-result concatenation where the
   current sink permits it.
6. Measure optional `set_access_model`/OPFS separately.

Exit: balanced/original is byte-identical, lifecycle-complete, and no host
materializes all assets.

### Phase 3 — first-party host wiring

1. Wire CLI durable jobs and the direct Node compatibility path.
2. Wire normal browser harness and public consumer.
3. Wire extension durable jobs; keep preview fast by default.
4. Ship report-only auto selection.
5. Run real E2E and packed-host checks.

Exit: each first-party host passes its parity and lifecycle matrix.

### Phase 4 — activate measured auto selection

1. Freeze selector thresholds/version from Phase 0–3 results.
2. Enable active `auto` host by host behind a rollback switch.
3. Require the 40% image-heavy target before balanced auto-selection.
4. Publish diagnostics and updated performance guidance.

Exit: auto is predictable, persisted, observable, and safely reversible.

### Phase 5 — optional Typst and output experiments

1. Compare runtime candidate lanes without pipeline changes.
2. Evaluate a gated memory-mode build only after shared pipeline wins are
   measured.
3. Evaluate owned/chunked output only if the 10% gate is met.
4. Upstream viable runtime changes before adopting a long-lived fork.

Exit: adopt, reject, or defer each candidate with a standalone benchmark report.

### Phase 6 — downstream Forge proof

1. Pin the exact atlcli candidate.
2. Implement the Forge capability adapter/eager fallback.
3. Remove redundant worker copies and add cleanup.
4. Verify packaged resources, CSP, no external requests, and gzip parity.
5. Deploy to production without tunnel and refresh proof documentation.

Exit: the current page export passes honest Forge lifecycle and semantic gates;
tree-scale claims remain deferred until that shape exists.

## Proposed change/commit boundaries

Keep results attributable with logical conventional commits:

1. `test(pdf): add deterministic browser memory corpus`
2. `feat(export-media): add deterministic image profiles`
3. `feat(pdf): add leased source bundle contracts`
4. `feat(export-wiring): persist pdf v2 asset manifests`
5. `feat(pdf-browser): compile leased assets sequentially`
6. `feat(cli): add adaptive pdf resource options`
7. `feat(extension): spool balanced pdf jobs`
8. `perf(pdf): enable measured automatic resource selection`
9. optional `perf(pdf-browser): update measured typst runtime`
10. `docs: document adaptive browser pdf memory`

Do not mix the runtime upgrade, pipeline contract, and auto threshold in one
commit. Each should be independently revertible.

## Documentation updates

Update in the same implementation PRs:

- `src/content/docs/reference/pdf-engine.md`: contracts, runtime matrix,
  compiler/font identity (including the current twelve-font set), and capability
  fallback;
- `src/content/docs/reference/export-performance.md`: realistic browser corpus,
  modes/profiles, measured results, and removal of stale scope language;
- CLI reference: options, defaults, reports, and troubleshooting;
- Confluence export guides: quality profile examples and warnings;
- browser package/consumer docs: spool capability and CSP assets;
- extension docs/UI copy: fast preview versus durable balanced jobs;
- changelog and migration notes for additive V2 contracts.

The separate Forge consumer PR updates `specs/SPIKE.md`, proof metadata, runtime
pin, resource hashes, limitations, and production evidence.

## Relationship to issue #119

Share only the format-neutral contracts:

- image profile and render-envelope model;
- deterministic normalizer;
- spool references, leases, budgets, and cleanup;
- fixture media recipes and privacy rules;
- host capability reporting.

Keep PDF compiler/VFS logic out of the DOCX path. Issue #119 independently owns
OPC/ZIP streaming, STORE-versus-DEFLATE policy, relationship writing, customer
template preservation, and DOCX-specific two-pass composition. Neither issue
waits for the other's format engine after the shared primitives land.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Balanced mode only moves bytes and Typst VFS still dominates | measure host and WASM high-water separately; gate auto on total peak |
| Normalization changes layout or visible quality | separate explicit profile; render envelopes; visual and semantic parity |
| Browser codecs differ by platform | pin one deterministic cross-host codec; reject Canvas-only normative output |
| Spool quota fails late | estimate and reserve before normalization; actionable auto fallback |
| V2 recovery breaks existing jobs | additive checkpoint version; retain V1 eager reader |
| OPFS unavailable or lifecycle-sensitive | IndexedDB portable baseline; OPFS optional; Forge eager/session fallback |
| Worker termination leaks objects | lease registry plus idempotent `finally`; crash/restart tests |
| A runtime upgrade hides the real gain | isolated commits and candidate lanes |
| Custom Typst fork becomes permanent | upstream-first boundary and high adoption threshold |
| Benchmarks use synthetic noise unlike real pages | realistic PNG/JPEG recipes, repeated assets, mixed corpus, documented limits |
| Forge proof overstates current product shape | page-only gates now; tree-scale proof only after executable tree/jobs |

## Unresolved questions

No product decision blocks implementation. The conservative defaults are:
`fast + original`, no automatic quality reduction, and no mandatory OPFS.

The following questions are intentionally resolved by measured phase gates:

1. Which exact `standard` PPI in the 160–200 range gives the best visual/peak
   trade-off, and is approximately 300 PPI the correct `print` value?
2. Which deterministic codec satisfies Bun, extension, normal browser, Forge,
   CSP, license, size, and parity requirements?
3. At which input/capability thresholds should selector V1 choose balanced?
4. Does typst.ts access-model plus worker OPFS reduce total peak enough to
   justify the additional capability path?
5. Does a narrower or newer Typst runtime improve runtime peak, not only WASM
   size?
6. Can a maintainable Typst memory mode pass the 25% and parity gates?
7. Is complete-PDF handoff at least 10% of peak, justifying an output-handle
   experiment?
