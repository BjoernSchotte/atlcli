# Issue #128: usage-gated Shiki runtime

## Goal

Keep Shiki core, the selected regex engine, theme, grammars, and the generated
runtime-loader registry unevaluated until a fully resolved export document
contains at least one known canonical code language. Preserve one neutral token
contract for DOCX and PDF across Node/Bun, ordinary browsers, MV3, and Forge.

## Decisions

1. `@atlcli/code-highlight/contract` owns token/timing types, the injectable
   lazy runtime loader, canonical plain fallback, and retryable
   condition-selected loader. It has no static edge to the runtime root.
2. The package root remains the backward-compatible concrete runtime. Its
   browser condition installs the JavaScript engine; its default condition
   installs Oniguruma. Both engine implementations retain dynamic imports.
3. DOCX and PDF scan after macro resolution. Known languages are deduplicated
   canonically in first-occurrence order and prepared concurrently through one
   runtime capability.
4. Missing/unknown languages, plain unknown-macro bodies, and Mermaid source
   fallback stay runtime-free. A successful Mermaid diagram never loads a
   grammar.
5. DOCX includes scan independently after acquisition but share the export
   timing collector, selected theme, and package-level runtime caches.
6. The complete language/theme catalogue remains supported. Bundlers may still
   emit all fine-grained dynamic chunks; acceptance is based on evaluation and
   request traces, not output file count.
7. Forge measurements keep the Atlassian-controlled iframe/resource cold floor
   separate from atlcli runtime-ready, first-export, request, byte, and heap
   proxies.

## Implementation order

- [x] Add the Shiki-free contract and retryable lazy runtime loader.
- [x] Remove concrete engine installation from DOCX entry evaluation.
- [x] Gate DOCX serialization/preparation and preserve prefetch overlap.
- [x] Gate PDF preparation while leaving Typst serialization runtime-free.
- [x] Cover unknown containers and propagate non-default themes into includes.
- [x] Remove the browser benchmark's eager runtime-root import.
- [x] Regenerate public API reports and package-closure classifications.
- [x] Run core, CLI artifact, browser, MV3, package, and documentation gates.
- [x] Record local before/after request, byte, timing, and heap-proxy evidence.
- [ ] Re-run the separate pinned Forge consumer trace.

## Acceptance matrix

| Shape | No-code proof | Code proof |
| --- | --- | --- |
| Node/Bun/CLI | Fresh process keeps engine id `null`; no network/browser globals | Oniguruma artifact, selected theme/grammar, warm reuse |
| Ordinary browser | Fresh DOCX and PDF preparation requests no runtime chunks | JavaScript engine, one/many canonical grammars, warm request reuse |
| MV3 | Packed scan excludes Oniguruma, WASM, remote/eval code; no-code recreation stays lazy | Deterministic resumed output after offscreen recreation |
| Forge | Same browser exports and same-origin chunks; platform cold floor reported separately | Runtime-ready/first-export/request/byte/heap-proxy trace |

## Unresolved questions

- The external Forge consumer is not part of this repository. Its pinned
  staging/production trace remains required before the GitHub issue can be
  closed completely.
- Exact iframe heap is reported only if Forge exposes a reliable measurement
  surface; otherwise the evidence uses explicitly labelled proxies.
