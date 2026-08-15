# AP-06 export and navigation evidence

**Status:** COMPLETE

**Date:** 2026-08-11

**Implementation base:** `02b72968eab3fc3b3c6cd194d906a841315d5958`

## Delivered boundary

The MV3 background host now advertises PDF, DOCX, surface-navigation, and AI
handoff capabilities only when a concrete executor adapter is registered. The
content script and React presenter receive only catalog projections, bounded
results, and redacted receipts; they import no export compiler, export engine,
job polling, template store, or Confluence client.

PDF and DOCX actions reuse the existing durable Publishing request builders and
submission functions. The palette request ID is the export job ID and
idempotency key, so a retry after response loss or a service-worker restart
returns the existing snapshot instead of creating another job. Source identity
and version are loaded through `loadConfluencePage()` in the background. The
background path intentionally injects a content-free Markdown projection:
Turndown requires a document host, while the unresolved durable request needs
only the authoritative page ID/version and the export worker re-reads source
content later.

DOCX resolves the active space-specific template with the existing global
fallback, then pins the selected record key, bytes, byte length, and SHA-256 in
the existing request/template spool path before catalog creation. A missing or
unreadable template produces a typed `open-surface` result with an explicit
**Open Publishing** affordance.

After catalog persistence, palette view abort/dismissal detaches from the job
instead of cancelling it. Abort before the final context guard or durable
submit still stops the operation. Both PDF and DOCX retain
persistence-before-wake semantics, and wake failure is a warning on an
authoritative queued snapshot rather than an orphaned job.

## Gesture and navigation proof

Chrome side-panel opening remains synchronous inside the original trusted
top-frame message listener for explicit surface actions only. No tab lookup,
storage operation, or awaited broker validation precedes `sidePanel.open()`.
The non-sensitive shell opens on the gesture; the authoritative broker then
validates the sender/catalog binding and writes the one-shot target-screen
mailbox. PDF, DOCX, AI, subframe, non-Atlassian, and malformed requests cannot
use this gesture seam.

The existing `SurfaceNavigationPort` supplies both already-open delivery and
cold-open delivery. Tests prove expiry, acknowledgement, live/cold duplicate
suppression, unsubscribe behavior, missing-capability behavior, and that a
deep-link never overwrites the remembered workspace preference.

## Automated proof

```bash
bun run test apps/extension/tests/action-palette-export.test.ts
bun run test apps/extension/tests/action-palette-navigation.test.ts
bun run test apps/extension/tests/action-palette-background-host.test.ts
bun run test apps/extension/tests/jobs/pdf-run.test.ts
bun run test apps/extension/tests/jobs/docx-run.test.ts
bun run test apps/extension/tests/app-portability.test.tsx
bun run --cwd apps/extension build
bun run --cwd apps/extension test:palette-extension-browser:prebuilt
bun run check:extension-output
bun run check:browser
bun run typecheck
git diff --check
```

Final results:

- palette export contract/parity/regression tests: **6 passing, 0 failing**;
- navigation and gesture tests: **4 passing, 0 failing**;
- authoritative background-host tests: **8 passing, 0 failing**;
- durable PDF/DOCX observer regressions: **6 passing, 0 failing**;
- portable application and screen-registry tests: **28 passing, 0 failing**;
- production WXT packed Chromium suite: **7 passing, 0 failing**;
- extension output scan: CSP-safe and complete;
- browser boundary: all 34 checked entrypoints browser-clean;
- root, WXT extension, PDF compiler, and browser-export-harness typechecks: passed;
- whitespace/error-marker check: passed.

The packed production case performs the real current-page PDF background path
against controlled Confluence REST fixtures, verifies the queued receipt, then
executes the no-template DOCX path and its **Open Publishing** action. The same
run retained all AP-05 context, SPA, focus, accessibility, missing-capability,
and performance coverage. Its final measured p95 was 123.109 ms cold and
13.083 ms warm, with zero long tasks and zero search-time network requests.

## Screenshot boundary

This AP-06 proof used controlled local Atlassian fixtures, not a live tenant.
No LIVE screenshot was therefore captured or committed. Any later live-tenant
acceptance run must capture screenshots outside the repository and present
downloadable images in the task.
