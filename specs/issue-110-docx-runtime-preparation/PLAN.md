# Issue 110: complete DOCX runtime preparation

## Goal

Add one public, isomorphic intent-time contract that prepares every
deterministic DOCX runtime asset before the first render: known Shiki grammars
and the committed JetBrains Mono code font. Page attachment bytes remain
generation-bound.

## Decisions

1. `prepareDocxExportRuntime(blocks, options)` is additive and available from
   the Node, browser, and browser-runtime entry points.
2. Highlighting is prepared from the supplied nested block tree. The code font
   is warmed and checksum-validated unconditionally after explicit DOCX intent.
   Actual OOXML embedding remains conditional on rendered code semantics.
3. Highlighting and font preparation start concurrently. The existing
   `loadBundledCodeFont()` promise remains the only font cache.
4. Caller cancellation stops only that caller's wait. Shared preparation keeps
   running and remains usable by later calls.
5. `prepareDocxExport()` retains its render-time font check as the correctness
   fallback for included or otherwise later-discovered content.
6. Durable jobs call the same public contract in their productive render realm.
   The extension also sends a bounded intent hint to its offscreen realm; it
   never sends page or attachment bytes through runtime messaging.

## Implementation order

1. Add the engine API, timings, cache-race fix, and focused regression tests.
2. Wire durable DOCX jobs, compiled CLI loading, and the MV3 offscreen intent
   path.
3. Extend browser/consumer/MV3 proofs for cold, warm, retry, output parity, and
   browser boundaries.
4. Regenerate API reports and update package/reference documentation.

## Verification

- Focused DOCX, export-wiring, CLI, extension protocol, and consumer tests.
- Browser build and boundary scans for Node builtins and remote assets.
- Browser export harness resource timing with one same-origin TTF request before
  render, no repeat request, retry after a failed request, and byte parity.
- Packed MV3 side-panel/offscreen and durable-job proof.
- Workspace typecheck and a real `mayflower` / `DOCSY` CLI export before commit.

## Unresolved questions

None.
