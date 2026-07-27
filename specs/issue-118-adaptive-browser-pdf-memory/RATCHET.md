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
