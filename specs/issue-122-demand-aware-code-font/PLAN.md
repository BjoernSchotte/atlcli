# Issue 122: demand-aware DOCX code-font staging

Status: implemented and verified
Baseline: `origin/main` at `b10fda9`
Issue: <https://github.com/BjoernSchotte/atlcli/issues/122>

## Goal

Remove the bundled JetBrains Mono request from empty and no-code DOCX runtime
preparation while preserving deterministic font embedding for every emitted
code path: block code, inline code, nested or macro-resolved content, included
pages, and Mermaid source fallback.

## Implementation plan

1. Keep the completed body-plus-include OOXML as the authoritative font-demand
   signal before a prepared checkpoint can be returned.
2. Make intent-time font preload explicit and additive through
   `preloadCodeFont: true`; default preparation warms only known highlighting
   grammars and reports zero font bytes/time.
3. Share one retryable load-plus-validation promise between explicit preload
   and renderer demand. Clear the owned raw and validated promises after either
   request or validation failure.
4. Update intentional host preloads, package/CLI smokes, public documentation,
   frozen API reports, and browser resource/memory benchmarks.
5. Prove default/explicit cold and warm preparation, cancellation, request and
   validation retry, single-flight reuse, output/report parity, browser
   boundaries, and Word/LibreOffice interoperability.

## Design decisions

- No initial `ExportBlock[]` scan is a correctness authority. It cannot see
  template-driven includes, asynchronous macro results, or the outcome-dependent
  Mermaid fallback.
- `prepareDocxExport()` already combines fully serialized body and included-page
  OOXML and stages the font before freezing `PreparedDocxExportV1`. That remains
  the one demand boundary shared by Node, ordinary browsers, the extension, and
  Forge consumers.
- Hosts that deliberately overlap the request with acquisition opt in through
  the same typed preparation option. No host receives a separate renderer or
  font-demand implementation.
- The per-archive sfnt guard remains in `ensureEmbeddedCodeFont()` so mutable
  internal bytes cannot corrupt a package. The expensive pinned SHA-256
  validation is single-flight.

## Verification

- Focused DOCX runtime, embedding, export, wiring, CLI, and extension tests:
  167 passed, 0 failed across the targeted runs.
- Fresh-context Chrome measurements:
  - default empty preparation: 0 font requests and 0 decoded font bytes;
  - explicit preload: 1 font request and 273,900 decoded bytes;
  - warm explicit preparation: 0 additional font requests;
  - the cold demand-loaded and preloaded code exports were byte-identical.
  Timing, transfer bytes, and sampled JavaScript-heap peaks are retained in the
  ignored harness result rather than treated as a cross-context memory delta.
- Full build, workspace typecheck, 25 browser-entrypoint checks, extension and
  browser-harness output inventory, API closure/report, and Astro docs checks
  passed.
- All four opt-in package-consumer smokes passed: Bun tarball, production
  filesystem link, Node/npm, and Vite.
- Full repository suite: 5,814 passed, 14 environment-gated skips, 0 failed.
- A read-only export of the retained DOCSY feature fixture succeeded with three
  code blocks, one embedded code-font part, a valid 142,614-byte archive, and
  zero export errors. The local test artifact was removed afterward.
- LibreOffice converted the generated code fixture to PDF with embedded
  JetBrains Mono and intact extracted code text. Current Microsoft Word opened
  it without a repair prompt and reported JetBrains Mono for inline and block
  code.

## Unresolved questions

None.
