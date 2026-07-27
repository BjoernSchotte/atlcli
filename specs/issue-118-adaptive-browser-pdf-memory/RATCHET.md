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

Honest reading: the checkpoint-assets win is exactly the predicted ~3×20 MiB
of per-asset transients. The executor-collect lane is **inconclusive on this
instrument** — fake-indexeddb structured-clone noise (run spread ±30 MiB)
exceeds the per-object signal, and production objects are ~2.6 MiB where the
bounded effect is ≈ one object. The shape change there is carried by unit
tests (exact-length fill, overflow, truncation, limit) and by the unchanged
packed-extension and node job baselines; its integrity benefit (length
binding detects truncation before hydrate) stands regardless.
Node job baseline re-run AFTER as no-regression: all 12 cells complete,
artifact hashes unchanged.
