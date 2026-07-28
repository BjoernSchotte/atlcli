# Issue #123 implementation evidence

## Result

`@atlcli/docx/browser-entry` is the supported runtime-first browser intent
entry. It exposes runtime preparation, export, in-memory templates, template
inspection, and the optional canvas rasterizer without changing Node/CLI
entrypoints. The extension and neutral browser harness load it only after
explicit DOCX scan, warm, or export intent.

## Cold and warm topology

Measured in fresh Chromium contexts against the production Vite build. Each
JavaScript request was delayed by 25 ms so dependent request waves remain
observable. Heap values come from CDP `Performance.getMetrics` samples taken
during entry loading; they are measurements, not bundle-size estimates.

| Metric | Legacy runtime then engine | Combined entry |
| --- | ---: | ---: |
| Sequential request waves | 2 | 1 |
| Entry ready | 81.0 ms | 52.6 ms |
| Warm ready | 5.4 ms | 5.4 ms |
| Requests | 9 | 9 |
| Transfer bytes | 775,723 | 775,747 |
| Decoded bytes | 773,023 | 773,047 |
| Peak JS heap delta | 2,894,176 bytes | 2,858,244 bytes |
| Font-file requests at import | 0 | 0 |
| Warm repeat requests | 0 | 0 |

The combined entry removes one sequential request wave and reduces measured
cold readiness by 28.4 ms in this controlled trace. It adds 24 transfer and
decoded bytes, and its sampled peak heap delta is 35,932 bytes lower. The
benchmark asserts only the topology win, no import-time font fetch, and a
one-MiB non-regression envelope for measured peak heap.

## Verification

- `bun run test`: 5,814 passed, 14 environment/credential-gated skips, 0
  failures across 400 files. The first sandboxed run demonstrated that 49
  local-server tests could not bind ports; the complete out-of-sandbox rerun
  is the reported result.
- `bun run typecheck`: passed for the root, extension,
  `pdf-compiler-browser`, and browser export harness.
- `bun run build`: 20 build tasks passed, including the extension, harness,
  DOCX package, CLI, and browser compiler.
- `bun run check:browser`: all 26 browser entrypoints passed.
- Harness output and extension output checks passed.
- Browser harness unit suite: 85 passed.
- Playwright production harness: 5 passed, including all registered browser
  DOCX/PDF conformance cases, topology, highlighting, deterministic repeat,
  font retry, job parity, diagrams, attachments, templates, and Word-quality
  structure checks.
- Packed Vite consumer: produced
  `Combined Browser Entry.docx` (2,058 bytes) and a real tagged PDF (4 pages,
  41,779 bytes) from installed tarballs.
- Package/API guards: 16 passed; the tarball contains the combined JavaScript,
  declarations, source maps, licenses, font asset, and Node loader with no
  `src/` or `workspace:` leak.
- `bun run docs:check`: 0 errors, warnings, or hints.

## Dependency and external gates

- The parallel #122 worktree is clean at commit `6e7584d` and changes the
  existing `prepareDocxExportRuntime` option semantics without adding another
  public entry. This branch deliberately does not duplicate or cherry-pick
  that commit; #123 must be rebased onto #122 after it lands.
- The separate Forge Custom UI repository is outside this worktree. Its
  combined-entry migration and production cold/warm staging trace remain
  required before closing #123.
- The browser harness proves the existing Word-quality and LibreOffice/Word
  fixture contracts, but no interactive Microsoft Word session was performed
  in this worktree.
