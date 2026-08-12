# AP-04 extension authority broker evidence

**Status:** COMPLETE

**Date:** 2026-08-11

**Implementation base:** `2d1ecd6f8ba6a0cdc36ff814b7098d92bf9c5d77`

## Delivered boundary

The extension now has a versioned, bounded palette protocol and an authoritative background broker. A top-frame content sender can ask for a catalog and later execute one action, but it cannot supply the site, URL, tenant, tab/window identity, host identity, provider credential, export request, template bytes, or research request.

For every catalog request, the broker derives the context from the exact Chrome sender tuple (`tabId`, `documentId`, `frameId: 0`, `origin`), re-reads that tab, projects the URL through the shared Atlassian entity extractor, and binds an opaque 120-second catalog revision to the resulting document and URL. Execution repeats the tab/context derivation and rejects an expired revision, a different document, navigation, tab substitution, locale change, origin change, missing capability, unavailable action, unknown intent, or effect mismatch before calling an executor.

Capabilities are the sorted projection of actually registered executor adapters. The production registry is exhaustive for the eight reserved MVP action IDs and advertises only PDF, DOCX, sidebar-surface, and Quick-AI capabilities backed by its surface-mailbox adapter. The compile-time synthetic module remains inert in production and becomes executable in the test host only when its exact capability and allowlisted contribution intent are registered through the same broker composition.

## Protocol and projection policy

Exact request guards cover toggle, catalog, execute, stream/control, surface acknowledgement, and bounded diagnostics. Unknown fields fail closed. Action input is checked at both boundaries: first for protocol size/shape and immediately before delegation against the selected server-owned action schema. Executor output is parsed again as `ActionResultV1`; a test executor's extra `rawTenant` field is rejected and never appears in the response.

Catalog responses contain only the immutable action modules, derived public context projection, opaque revision, and expiry. Execute responses contain only a redacted result and opaque execution ID. The palette variants extend the existing `ExtMessage` discriminated union; the existing generic extension router remains unchanged.

`ShortcutPort` reports the manifest command as assigned or unbound without exposing Chrome to portable Settings code. `SurfaceNavigationPort` uses a short-lived `storage.session` mailbox plus live runtime delivery, deduplicates the same navigation ID across cold/live races, acknowledges consumption, and lets an already-mounted `ExportApp` deep-link without overwriting the remembered workspace preference.

The AP-04 executor only queues a validated surface navigation request. It deliberately does not call `chrome.sidePanel.open()` after asynchronous tab validation. AP-05/AP-06 must preserve the AP-00 user-activation finding by opening the non-sensitive shell synchronously on the trusted gesture path and applying the validated mailbox navigation afterward.

## Required proof

```bash
bun run test apps/extension/tests/action-palette-context.test.ts
bun run test apps/extension/tests/action-palette-background-host.test.ts
bun run test apps/extension/tests/action-palette-protocol.test.ts
bun run typecheck
```

Results:

- context: **4 passing, 0 failing; 14 assertions**;
- background host: **7 passing, 0 failing; 28 assertions**;
- protocol and Chrome ports: **6 passing, 0 failing; 40 assertions**;
- repository TypeScript gate: passed for the root graph, WXT extension, PDF browser compiler, and browser export harness.

The focused `ExportApp` portability suite also passed **28 tests** with the new cold/live deep-link and preference-preservation case while `globalThis.chrome` remained deleted.

## Production and browser gates

```bash
bun run --cwd apps/extension build
bun run --cwd apps/extension check:output
bun run --cwd apps/extension test:jobs-extension-browser:prebuilt
```

Results:

- the production Chrome MV3 WXT build completed; the integrated service worker emitted a 95.59 KB `background.js`;
- the output scan reported the entire extension distribution CSP-safe and complete;
- the prebuilt production-extension Playwright lane passed **24 of 24** tests, including real service-worker/offscreen restarts, durable PDF/DOCX execution, tab/surface navigation, aborts, and a full persistent-browser restart.

The first Playwright launch inside the restricted sandbox was invalid because macOS denied Chromium Crashpad access before any test ran. The authorized rerun outside that sandbox used the same prebuilt output and passed all 24 cases.

## Screenshot boundary

AP-04 adds no visible palette mount and does not run against a live Atlassian tenant. Its browser E2E is an offline production-extension regression lane, so a screenshot would not evidence the authority decisions above. No screenshot was created or committed. AP-05 is the first live rendered extension surface and must capture and present its screenshots outside the repository.
