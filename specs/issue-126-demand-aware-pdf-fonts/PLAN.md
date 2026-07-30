# Issue #126: Demand-aware PDF font staging

- Status: shared contract and atlcli host adapters implemented and validated;
  downstream Forge/custom-font acceptance remains
- Issue: [#126](https://github.com/BjoernSchotte/atlcli/issues/126)
- Baseline: `bdda236` (`main`, 2026-07-30)

## Decision

Resolve fonts at the last host-neutral semantic seam:
`serializePdfDocument`, after nested blocks, macro/include results, effective
settings, synthetic renderer text, and the template manifest are known.

`ResolvedPdfFontRequirementsV1` contains stable asset IDs, pinned hashes,
template identity, non-sensitive reasons, and a deterministic key. It contains
no bytes, URLs, or document text. `PDF_RUNTIME_ASSETS` remains the full
distributable 12-font set.

Hosts supply one lazy, hash-bound source for every statically packaged font.
`BrowserPdfCompiler` validates requirements before loading bytes, registers only
the selected sources, and keeps one active compiler. A requirement-key change
frees and rebuilds that compiler because typst.ts font access is process-global.

Legacy callers remain additive:

- `Uint8Array[]` still registers the supplied full byte set.
- A hand-built `PdfSourceBundle` without requirements uses the canonical full
  set.
- Licenses and all font assets remain present in browser output; licenses are
  packaging evidence and are not fetched during a compile.

## Work items

1. Generate Unicode coverage ranges from the exact SHA-256-pinned sfnt files.
2. Resolve document styles, nested content, template roles, localized and
   synthetic text, symbols, and emoji into the versioned contract.
3. Surface requirement and compiler-load evidence in compile/export reports.
4. Use lazy sources in the neutral browser harness, MV3 worker, CLI, and Node
   adapter; preserve evidence through the extension's durable job bridge.
5. Prove exact subset loading, key changes, fail-closed hashes, cancellation,
   legacy fallback, real compilation, and browser network requests.
6. Update public package and reference documentation.

## Acceptance boundary

This repository owns the shared engine, CLI, Node adapter, neutral browser
harness, and extension. The downstream Forge Custom UI adapter lives in
`kiteweave-forge-app`; it must adopt the same published contract and run its
own CSP/lifecycle proof before issue #126 can be closed.

The existing custom-font intake types are not yet connected to a template-pack
host adapter. Demand-aware custom IDs stay fail-closed until that approved
source and license-attestation path exists; legacy byte-array callers remain
compatible. The Draft PR references, but does not close, #126 while those two
external acceptance lanes remain.

## Unresolved questions

- Which downstream Forge branch/PR should consume this contract?
- Should the custom-font host intake land in atlcli or in a separate,
  host-owned follow-up before #126 closes?
