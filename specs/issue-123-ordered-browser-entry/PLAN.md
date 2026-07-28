# Issue #123: ordered browser DOCX entry

## Goal

Ship one supported browser-intent import that installs the DOCX byte runtime
before PizZip/docxtemplater evaluate and exposes preparation, export, template,
and rasterizer capabilities without a host-owned runtime-to-engine waterfall.

## Boundaries

- Keep the Node/CLI entry and the existing `./browser` and `./browser-runtime`
  compatibility subpaths unchanged.
- Do not implement or duplicate #122's demand-aware font semantics here. The
  combined entry forwards the shared preparation contract, and final
  integration is checked against the parallel #122 worktree.
- Keep discovery/page entries free of the combined engine. Load it only from a
  DOCX scan, warm, export, or executor intent boundary.
- Treat the neutral Vite/Chromium measurements as package and ordinary-browser
  evidence. Forge staging remains a separate consumer-repository gate.

## Delivery

- [x] Add `@atlcli/docx/browser-entry` with a static runtime-first dependency.
- [x] Prove real engine evaluation fails without the runtime and succeeds
      through the combined entry.
- [x] Cover exports, declarations, maps, browser build, Vite, and packed
      consumer resolution.
- [x] Generate a real DOCX in the neutral browser and packed Vite consumers.
- [x] Move extension and browser-harness consumers to the combined entry at
      explicit DOCX intent.
- [x] Record cold request waves, transfer/decoded bytes, entry-to-ready time,
      warm time, and absence of import-time font fetch.
- [x] Re-run package, extension, harness, typecheck, and relevant E2E gates.

## External acceptance

- Merge/rebase the completed #122 demand-aware preparation contract before
  closing #123.
- Update the separate Forge Custom UI consumer and record its cold/warm staging
  trace, CSP/lifecycle behavior, cancellation, retry, and cleanup.
- Word remains a manual compatibility gate; LibreOffice automation is reported
  only when the tool is present and the browser-produced artifact is checked.

## Unresolved questions

None for the atlcli implementation. The Forge staging result and #122 merge
commit are external inputs to issue closure.
