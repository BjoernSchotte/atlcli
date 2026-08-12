# AP-08 Forge Confluence palette evidence

**Status:** COMPLETE

**Date:** 2026-08-12

**Forge implementation commit:** `f0d06d0`

**Shared AP-03A receipt:** `bdb4e0a6cf8cf1bb1eeb4d4e0b2b723b0bb3713e`

**Pinned export receipt:** `27d2e95bd90ea0695f5f7442efec807ec1dca155`

## Delivered boundary

The Forge app now exposes a third, Confluence-only content action named
**Kiteweave Actions**. It mounts the shared `ActionPaletteV1` presenter in a
medium Custom UI viewport and registers the AP-00-approved, statically distinct
`mod+k` accelerator. The extension remains on its separate fallback chord, so
the hosts do not need runtime install detection or a hybrid broker.

The Forge catalog contains exactly two serializable actions: export the current
Confluence page as PDF or DOCX. Its executor accepts only those two action IDs
and matching export intents, revalidates a numeric Confluence page context, and
delegates to the existing named export modals with `source: "palette"`. It adds
no Jira module, AI/provider path, function, remote, storage, background script,
external origin, or new permission scope.

English and German action dictionaries have exact key parity. Missing or
corrupt page context, unknown/mismatched intent, modal failure, cancellation,
and double activation fail closed. A Forge-specific focus adapter handles the
outer-dialog-to-Custom-UI iframe focus transfer; it does not alter the shared
presenter or the existing PDF/DOCX views.

## Reproducible package handoff

The implementation branch preserved the original checkout and its pre-existing
untracked `design/` directory. It consumes two clean, detached receipt
checkouts rather than extension source or a dirty working tree. The verifier
asserts both exact commits, package versions, selected SHA-256 artifact hashes,
clean tracked state, built `dist/` directories, and resolved package entries
under the recorded receipt roots.

```text
ATLCLI_BASELINE_OK 27d2e95bd90ea0695f5f7442efec807ec1dca155 AP03A_OK bdb4e0a6cf8cf1bb1eeb4d4e0b2b723b0bb3713e
```

The linked shared package is built with React 19 for its development tests,
while the established Forge host owns React 18. The production Vite build now
deduplicates `react` and `react-dom` at the host boundary. This regression was
found during the first development launch, fixed, covered by a boundary test,
and re-proved live with a single React 18 runtime.

## Automated proof

```bash
bun run test
bun run check
forge lint
git diff --check
```

Final results:

- Forge tests: **80 passing, 0 failing**, 473 assertions;
- TypeScript: passed;
- production Vite build: 948 modules transformed;
- receipt verification: both exact commits and all recorded artifacts passed;
- output scan: 366 files, 26,080,213 bytes total, 0 separate worker JS bytes;
- palette graph: **282,920 raw bytes** against the operator-approved
  **320 KiB** ratchet;
- palette graph transitive scan: no export engines/views, worker, AI, extension,
  `@forge/api`, remote, function, storage, external-origin, or external-runtime
  imports;
- cost invariants: exactly three content actions and six named browser entries,
  browser-only Custom UI, passed;
- Forge CLI lint: no issues found;
- whitespace/error-marker check: passed.

The 320 KiB ceiling was approved from the initial measured production graph of
291,149 raw bytes (approximately 91 KiB gzip). React-runtime deduplication and
the final focus adapter reduced the completed graph to 282,920 bytes, leaving
44,760 bytes of headroom without weakening the transitive safety scan.

## Development-installation LIVE proof

Environment:

- Google Chrome `151.0.7922.137`;
- macOS `26.4` on arm64;
- Forge CLI `13.3.0` on Node `24.14.0`;
- Bun `1.3.14`;
- Forge development deployment `3.5.0`;
- development Confluence installation reported `Up-to-date`, app version 3;
- the separate production installation remained unchanged.

On the retained synthetic Confluence export fixture, the following were proved
without generating an export, attachment, or page:

1. The real **More actions → Apps** menu lists **Kiteweave Actions
   (Development)** beside the existing development PDF/DOCX actions.
2. A trusted pointer click opens the localized shared palette with exactly the
   two expected actions.
3. A real macOS `Cmd+K` application key event opens the same development
   action. After Forge transfers focus into the iframe, the search combobox is
   the DOM active element and the first result is the active descendant.
4. `ArrowDown` selects DOCX and `Enter` opens the unchanged existing DOCX modal
   with the fixture page loaded and the Word engine ready.
5. Returning to the palette, `ArrowUp` plus `Enter` opens the unchanged existing
   PDF modal with the fixture page loaded and the PDF engine ready.
6. Escape closes the root palette and returns focus to a valid item in the
   originating Confluence actions menu; focus is not lost to the document body.
7. The final Forge iframe produced **0 warning/error console entries**. The
   fixture's pre-existing host/macro errors were distinguishable by their
   Confluence host URLs and were not attributed to the app.
8. Opening and searching cannot call an executor or provider: shared presenter
   tests keep search local, the Forge entry contains no fetch/provider path, and
   the final transitive production graph scan rejects all external-runtime and
   provider-capable imports.

The first launch exposed a React 19 element/React 18 renderer mismatch
(`React error #31`). The final evidence intentionally records that failed probe
as the regression trigger rather than hiding it; versions 3.3.0 through 3.5.0
successively proved the runtime and focus fixes. Production was never deployed.

## Screenshot boundary

The LIVE screenshots were written outside both repositories and were shown as
viewable/downloadable task artifacts. They were not staged or committed:

- `ap08-forge-actions-menu.png`;
- `ap08-forge-palette-live.png`;
- `ap08-forge-palette-docx-modal.png`;
- `ap08-forge-palette-pdf-modal.png`;
- `ap08-forge-palette-shortcut-live.png`.
